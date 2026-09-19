import fs from "node:fs";
import path from "node:path";
import { spawn, type Subprocess } from "bun";
import { config } from "./config.ts";
import type { VpnNode, VpnStatus, ConnectionState } from "./types.ts";

export class VpnManager {
  private state: ConnectionState = "disconnected";
  private activeNode: VpnNode | null = null;
  private process: Subprocess | null = null;
  private connectedAt: number | null = null;
  private egressIp: string | null = null;
  private egressCountry: string | null = null;
  private egressCountryCode: string | null = null;
  private egressIsp: string | null = null;
  private lastError: string | null = null;
  private logBuffer: string[] = [];
  private maxLogEntries = 200;

  getStatus(): VpnStatus & { logs: string[] } {
    const uptimeSeconds = this.connectedAt ? Math.floor((Date.now() - this.connectedAt) / 1000) : 0;
    return {
      state: this.state,
      activeNode: this.activeNode,
      connectedAt: this.connectedAt,
      uptimeSeconds,
      egressIp: this.egressIp,
      egressCountry: this.egressCountry,
      egressCountryCode: this.egressCountryCode,
      egressIsp: this.egressIsp,
      bytesIn: 0,
      bytesOut: 0,
      activeClients: 0,
      lastError: this.lastError,
      logs: [...this.logBuffer],
    };
  }

  private addLog(line: string): void {
    const timestamp = new Date().toISOString().substring(11, 19);
    const entry = `[${timestamp}] ${line.trim()}`;
    this.logBuffer.push(entry);
    if (this.logBuffer.length > this.maxLogEntries) {
      this.logBuffer.shift();
    }
  }

  /**
   * Prepares the OpenVPN config file from node metadata or base64
   */
  private async prepareConfigFile(node: VpnNode): Promise<string> {
    const configPath = path.join(config.dataDir, "active_vpn.ovpn");
    let content = "";

    if (node.openVpnConfigBase64) {
      try {
        content = Buffer.from(node.openVpnConfigBase64, "base64").toString("utf-8");
      } catch (err) {
        console.warn("[VPN] Failed to decode base64 config, generating template:", err);
      }
    }

    if (!content && node.openVpnLink) {
      try {
        const fullUrl = node.openVpnLink.startsWith("http")
          ? node.openVpnLink
          : `https://www.vpngate.net/${node.openVpnLink.replace(/^\//, "")}`;
        const res = await fetch(fullUrl, { signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const html = await res.text();
          const ovpnMatch = html.match(/href=['"]([^'"]*\.ovpn[^'"]*)['"]/i);
          if (ovpnMatch) {
            const ovpnUrl = ovpnMatch[1].startsWith("http")
              ? ovpnMatch[1]
              : `https://www.vpngate.net/${ovpnMatch[1].replace(/^\//, "")}`;
            const fileRes = await fetch(ovpnUrl, { signal: AbortSignal.timeout(10000) });
            if (fileRes.ok) {
              content = await fileRes.text();
            }
          }
        }
      } catch (fErr) {
        console.warn("[VPN] Failed to download ovpn file:", fErr);
      }
    }

    if (!content) {
      // Generate SSL-VPN template for VPNGate
      const port = node.sslVpnPort || 443;
      content = [
        "client",
        "dev tun",
        "proto tcp",
        `remote ${node.ip} ${port}`,
        "resolv-retry infinite",
        "nobind",
        "persist-key",
        "persist-tun",
        "verb 3",
        "cipher AES-128-CBC",
        "data-ciphers AES-128-CBC:AES-256-CBC:AES-128-GCM:AES-256-GCM",
        "data-ciphers-fallback AES-128-CBC",
        "auth SHA1",
      ].join("\n");
    }

    // Ensure auth file exists with default VPNGate credentials (vpn / vpn)
    const authPath = path.join(config.dataDir, "vpn_auth.txt");
    fs.writeFileSync(authPath, "vpn\nvpn\n", { mode: 0o600 });

    // Ensure safe and container-friendly settings
    const modifiedLines = content.split(/\r?\n/).filter((line) => {
      const trimmed = line.trim();
      return (
        !trimmed.startsWith("redirect-gateway") &&
        !trimmed.startsWith("route-gateway") &&
        !trimmed.startsWith("dhcp-option")
      );
    });

    // In Docker with TUN capability, use standard redirect-gateway def1
    modifiedLines.push("redirect-gateway def1");
    modifiedLines.push("verb 3");

    fs.writeFileSync(configPath, modifiedLines.join("\n"), { mode: 0o600 });
    return configPath;
  }

  /**
   * Preserves private IP subnets via eth0 gateway to prevent Docker network lockout
   */
  private setupRouteProtection(): void {
    if (process.platform !== "linux") return;

    // Set resilient public DNS in container so cloud internal link-local resolvers do not fail over VPN
    try {
      fs.writeFileSync("/etc/resolv.conf", "nameserver 1.1.1.1\nnameserver 8.8.8.8\n");
    } catch {
      // Might be read-only in some environments
    }

    try {
      const res = Bun.spawnSync(["ip", "route", "show", "default", "dev", "eth0"]);
      const out = res.stdout.toString().trim();
      const match = out.match(/via\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
      const gw = match ? match[1] : null;

      if (gw) {
        this.addLog(`[Route] Preserving Docker LAN routes via gateway ${gw}`);
        // Protect Docker bridge and private networks, avoiding 10.0.0.0/8 which conflicts with VPN IPs
        Bun.spawnSync(["ip", "route", "add", "172.16.0.0/12", "via", gw, "dev", "eth0"]);
        Bun.spawnSync(["ip", "route", "add", "192.168.0.0/16", "via", gw, "dev", "eth0"]);
      }
    } catch (e) {
      console.warn("[VPN] Route protection warning:", e);
    }
  }
  async connect(node: VpnNode): Promise<{ success: boolean; error?: string }> {
    if (this.state === "connecting" || this.state === "connected") {
      await this.disconnect();
    }

    this.state = "connecting";
    this.activeNode = node;
    this.lastError = null;
    this.egressIp = null;
    this.addLog(`Initiating connection to ${node.countryZh} (${node.ip}:${node.sslVpnPort || 443} SSL-VPN)...`);

    try {
      const configPath = await this.prepareConfigFile(node);
      this.setupRouteProtection();

      const { promise, resolve } = Promise.withResolvers<{ success: boolean; error?: string }>();
      let isResolved = false;

      const finish = (result: { success: boolean; error?: string }) => {
        if (!isResolved) {
          isResolved = true;
          resolve(result);
        }
      };

      // Set timeout for connection attempt (25 seconds)
      const timeoutTimer = setTimeout(() => {
        if (!isResolved) {
          this.lastError = "Connection attempt timed out after 25s.";
          this.addLog(this.lastError);
          this.disconnect();
          finish({ success: false, error: this.lastError });
        }
      }, 25000);

      const authPath = path.join(config.dataDir, "vpn_auth.txt");
      this.process = spawn({
        cmd: [
          "openvpn",
          "--config", configPath,
          "--auth-user-pass", authPath,
          "--auth-nocache",
          "--data-ciphers-fallback", "AES-128-CBC",
        ],
        stdout: "pipe",
        stderr: "pipe",
      });

      // Stream stdout
      (async () => {
        if (!this.process || !this.process.stdout) return;
        const reader = this.process.stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            this.addLog(line);

            if (line.includes("Initialization Sequence Completed")) {
              clearTimeout(timeoutTimer);
              this.state = "connected";
              this.connectedAt = Date.now();
              this.addLog("VPN connection successfully established!");
              this.refreshEgressInfo();
              finish({ success: true });
            }

            if (line.includes("SIGTERM") || line.includes("AUTH_FAILED") || line.includes("fatal error")) {
              clearTimeout(timeoutTimer);
              this.lastError = line;
              this.state = "error";
              finish({ success: false, error: line });
            }
          }
        }
      })();

      // Stream stderr
      (async () => {
        if (!this.process || !this.process.stderr) return;
        const reader = this.process.stderr.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          this.addLog(`[ERR] ${text.trim()}`);
        }
      })();

      this.process.exited.then((code) => {
        this.addLog(`OpenVPN process exited with code ${code}`);
        if (this.state === "connecting" || this.state === "connected") {
          this.state = code === 0 ? "disconnected" : "error";
          this.lastError = `Process exited with code ${code}`;
          finish({ success: false, error: this.lastError });
        }
      });

      return await promise;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.state = "error";
      this.lastError = msg;
      this.addLog(`Failed to start VPN: ${msg}`);
      return { success: false, error: msg };
    }
  }

  /**
   * Disconnects current VPN session
   */
  async disconnect(): Promise<void> {
    if (!this.process && this.state === "disconnected") return;

    this.state = "disconnecting";
    this.addLog("Disconnecting VPN...");

    if (this.process) {
      try {
        this.process.kill(15); // SIGTERM
        const exitPromise = this.process.exited;
        const { promise: timeoutPromise, resolve: resolveTimeout } = Promise.withResolvers<void>();
        setTimeout(resolveTimeout, 3000);
        await Promise.race([exitPromise, timeoutPromise]);

        if (this.process) {
          try {
            this.process.kill(9); // SIGKILL if still running
          } catch {
            // Already dead
          }
        }
      } catch {
        // Ignore kill errors
      }
      this.process = null;
    }

    this.state = "disconnected";
    this.activeNode = null;
    this.connectedAt = null;
    this.egressIp = null;
    this.egressCountry = null;
    this.egressCountryCode = null;
    this.egressIsp = null;
    this.addLog("VPN disconnected.");
  }

  /**
   * Queries public IP API to verify tunnel egress
   */
  async refreshEgressInfo(): Promise<void> {
    const { promise: delayPromise, resolve: resolveDelay } = Promise.withResolvers<void>();
    setTimeout(resolveDelay, 1500);
    await delayPromise;
    try {
      const res = await fetch("http://ip-api.com/json/", {
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          query?: string;
          country?: string;
          countryCode?: string;
          isp?: string;
        };
        this.egressIp = data.query || null;
        this.egressCountry = data.country || null;
        this.egressCountryCode = data.countryCode || null;
        this.egressIsp = data.isp || null;
        this.addLog(`Verified public egress IP: ${this.egressIp} (${this.egressCountry || "Unknown"}) - ${this.egressIsp || ""}`);
        return;
      }
    } catch {
      // Try secondary service
    }

    try {
      const res = await fetch("https://api.ipify.org?format=json", {
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const data = (await res.json()) as { ip?: string };
        this.egressIp = data.ip || null;
        this.addLog(`Verified public egress IP: ${this.egressIp}`);
      }
    } catch (e) {
      this.addLog(`Failed to query egress IP: ${e}`);
    }
  }
}

export const vpnManager = new VpnManager();
