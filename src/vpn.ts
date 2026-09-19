import fs from "node:fs";
import path from "node:path";
import { spawn, type Subprocess } from "bun";
import { config } from "./config.ts";
import { saveLastConnected, clearLastConnected, getAllNodes } from "./db.ts";
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
  private isIntentionalDisconnect = false;
  private isRecovering = false;
  private hasEverConnected = false;
  private healthCheckTimer: Timer | null = null;
  private consecutiveHealthFailures = 0;
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

    // Ensure safe, resilient and container-friendly settings
    const modifiedLines = content.split(/\r?\n/).filter((line) => {
      const trimmed = line.trim();
      return (
        !trimmed.startsWith("redirect-gateway") &&
        !trimmed.startsWith("route-gateway") &&
        !trimmed.startsWith("dhcp-option") &&
        !trimmed.startsWith("reneg-sec") &&
        !trimmed.startsWith("keepalive") &&
        !trimmed.startsWith("ping") &&
        !trimmed.startsWith("ping-restart") &&
        !trimmed.startsWith("ping-exit") &&
        !trimmed.startsWith("inactive") &&
        !trimmed.startsWith("connect-retry-max") &&
        !trimmed.startsWith("connect-retry") &&
        !trimmed.startsWith("auth-nocache")
      );
    });

    // In Docker with TUN capability, use standard redirect-gateway def1
    modifiedLines.push("redirect-gateway def1");
    modifiedLines.push("verb 3");
    // Crucial: Disable 1-hour TLS key renegotiation (fixes SoftEther/OpenVPN 1h disconnect)
    modifiedLines.push("reneg-sec 0");
    // Send keepalive ping every 10s; trigger restart after 60s silence (maintains NAT table & detects dead peer)
    modifiedLines.push("keepalive 10 60");
    modifiedLines.push("ping-timer-rem");
    modifiedLines.push("persist-tun");
    modifiedLines.push("persist-key");
    // Limit connect retries before exit so Bun supervisor can failover to a healthy node
    modifiedLines.push("connect-retry-max 3");
    modifiedLines.push("connect-retry 2 5");

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
    this.isIntentionalDisconnect = false;
    this.hasEverConnected = false;
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
              this.hasEverConnected = true;
              this.state = "connected";
              this.connectedAt = Date.now();
              saveLastConnected(node);
              this.addLog("VPN connection successfully established!");
              this.startHealthCheck();
              this.refreshEgressInfo();
              finish({ success: true });
            }

            if (!this.hasEverConnected && (line.includes("SIGTERM") || line.includes("AUTH_FAILED") || line.includes("fatal error"))) {
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
        this.stopHealthCheck();
        const wasConnected = this.hasEverConnected;
        const previousNode = this.activeNode;
        this.process = null;

        if (this.state === "connecting" || this.state === "connected") {
          this.state = this.isIntentionalDisconnect ? "disconnected" : (code === 0 ? "disconnected" : "error");
          this.lastError = this.isIntentionalDisconnect ? null : `Process exited with code ${code}`;
          finish({ success: false, error: this.lastError ?? undefined });
        }

        if (wasConnected && !this.isIntentionalDisconnect && previousNode && !this.isRecovering) {
          this.isRecovering = true;
          this.addLog("[Watchdog] Connection dropped unexpectedly. Current link has failed.");
          setTimeout(async () => {
            try {
              if (this.state === "disconnected" || this.state === "error") {
                if (previousNode.ipType !== "residential") {
                  this.addLog(
                    `[Watchdog] Previous node (${previousNode.ip}) is not residential broadband (${previousNode.ipType || "unknown"}). Automatic failover only applies to residential broadband.`
                  );
                } else {
                  this.addLog(
                    `[Watchdog] Initiating automatic failover to next best residential node (excluding ${previousNode.ip})...`
                  );
                  const success = await this.reconnectFailover(
                    config.preferredCountry || previousNode.countryShort,
                    previousNode.ip
                  );
                  if (!success) {
                    this.addLog(`[Watchdog] Failed to find or connect to next best residential node.`);
                  }
                }
              }
            } finally {
              this.isRecovering = false;
            }
          }, 2000);
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
  async disconnect(intentional = true): Promise<void> {
    this.isIntentionalDisconnect = intentional;
    this.stopHealthCheck();
    this.hasEverConnected = false;
    if (intentional) {
      clearLastConnected();
    }
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
   * Automatic failover: finds the next best residential SSL-VPN node
   * Requirements:
   * 1. Only residential broadband nodes ("自动失效替换只会在家宽里")
   * 2. Respect preferred country first ("首先要遵守当前的优先国家")
   * 3. Exclude failed/dead node IP
   * 4. Speed must not be too slow: threshold >= 50M ("主要是速度不能太低，低于50M的就太慢了")
   * 5. Rank by 60% active sessions (fewer is better) + 40% speed ("活跃会话越少越好。活跃会话的因素占60% 网速占40%的因数")
   */
  async reconnectFailover(country?: string, excludeIp?: string): Promise<boolean> {
    const prefCountry = country || config.preferredCountry;
    const target = findNextBestResidentialNode({
      preferredCountry: prefCountry,
      excludeIp,
    });

    if (target) {
      this.addLog(
        `[Failover] Found next best residential node: ${target.countryZh} (${target.ip}, ${target.speedFormatted}, ${target.numVpnSessions} sessions). Reconnecting...`
      );
      const res = await this.connect(target);
      return res.success;
    }

    this.addLog(`[Failover] No qualifying residential backup node found for country: ${prefCountry || "ANY"}`);
    return false;
  }

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.consecutiveHealthFailures = 0;

    this.healthCheckTimer = setInterval(async () => {
      if (this.state !== "connected" || !this.process) {
        this.stopHealthCheck();
        return;
      }

      const isAlive = await this.checkTunnelConnectivity();
      if (isAlive) {
        this.consecutiveHealthFailures = 0;
      } else {
        this.consecutiveHealthFailures++;
        this.addLog(`[Watchdog] Tunnel traffic check failed (${this.consecutiveHealthFailures}/2).`);

        if (this.consecutiveHealthFailures >= 2 && !this.isRecovering) {
          this.isRecovering = true;
          const failedNode = this.activeNode;
          this.addLog("[Watchdog] VPN tunnel traffic stalled (unable to reach Internet). Current link has failed.");
          this.stopHealthCheck();
          try {
            await this.disconnect(false);
            if (failedNode) {
              if (failedNode.ipType !== "residential") {
                this.addLog(
                  `[Watchdog] Current node (${failedNode.ip}) is not residential broadband (${failedNode.ipType || "unknown"}). Automatic failover only applies to residential broadband.`
                );
              } else {
                this.addLog(
                  `[Watchdog] Initiating automatic failover to next best residential node (excluding ${failedNode.ip})...`
                );
                await this.reconnectFailover(
                  config.preferredCountry || failedNode.countryShort,
                  failedNode.ip
                );
              }
            }
          } finally {
            this.isRecovering = false;
          }
        }
      }
    }, 45000);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    this.consecutiveHealthFailures = 0;
  }

  private async checkTunnelConnectivity(): Promise<boolean> {
    try {
      const res = await fetch("http://cp.cloudflare.com/generate_204", {
        signal: AbortSignal.timeout(6000),
      });
      return res.status === 204 || res.ok;
    } catch {
      try {
        const res2 = await fetch("https://api.ipify.org?format=json", {
          signal: AbortSignal.timeout(6000),
        });
        return res2.ok;
      } catch {
        return false;
      }
    }
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

export const MIN_RESIDENTIAL_SPEED_BPS = 50 * 1_000_000; // 50 Mbps (50M)

/**
 * Scores and ranks candidate residential nodes based on:
 * - Active sessions (numVpnSessions): 60% weight (fewer is better)
 * - Bandwidth (speed in bps): 40% weight (higher is better)
 */
export function rankResidentialNodes(candidates: VpnNode[]): VpnNode[] {
  if (candidates.length <= 1) return [...candidates];

  const maxSpeed = Math.max(...candidates.map((n) => Math.max(0, n.speed)));
  const maxSessions = Math.max(...candidates.map((n) => Math.max(0, n.numVpnSessions)));

  return [...candidates]
    .map((node) => {
      const speed = Math.max(0, node.speed);
      const sessions = Math.max(0, node.numVpnSessions);
      const speedScore = maxSpeed > 0 ? speed / maxSpeed : 1.0;
      const sessionScore = maxSessions > 0 ? 1.0 - sessions / maxSessions : 1.0;
      const compositeScore = 0.4 * speedScore + 0.6 * sessionScore;
      return { node, compositeScore };
    })
    .sort((a, b) => {
      if (b.compositeScore !== a.compositeScore) {
        return b.compositeScore - a.compositeScore;
      }
      if (a.node.numVpnSessions !== b.node.numVpnSessions) {
        return a.node.numVpnSessions - b.node.numVpnSessions;
      }
      return b.node.speed - a.node.speed;
    })
    .map((item) => item.node);
}

/**
 * Selects the next best residential SSL-VPN node for automatic failover.
 * Requirements:
 * 1. Only residential nodes (ipType === "residential")
 * 2. Exclude the failed/current node IP
 * 3. Respect current preferred country first
 * 4. Filter out nodes below 50M (speed >= 50 Mbps)
 * 5. Rank by 60% active sessions (fewer is better) and 40% speed
 */
export function findNextBestResidentialNode(options: {
  preferredCountry?: string;
  excludeIp?: string;
  allNodes?: VpnNode[];
}): VpnNode | null {
  const allNodes = options.allNodes || getAllNodes(true);
  // Automatic failover is strictly limited to residential broadband
  const residentialNodes = allNodes.filter(
    (n) => n.ipType === "residential" && (!options.excludeIp || n.ip !== options.excludeIp)
  );

  if (residentialNodes.length === 0) {
    return null;
  }

  const pref = (options.preferredCountry || config.preferredCountry || "").toUpperCase();

  // Tier 1: Preferred country residential nodes with speed >= 50 Mbps
  if (pref) {
    const prefHighSpeed = residentialNodes.filter(
      (n) =>
        (n.countryShort.toUpperCase() === pref || n.countryZh.toUpperCase() === pref) &&
        n.speed >= MIN_RESIDENTIAL_SPEED_BPS
    );
    if (prefHighSpeed.length > 0) {
      return rankResidentialNodes(prefHighSpeed)[0];
    }
  }

  // Tier 2: Other countries residential nodes with speed >= 50 Mbps
  const anyHighSpeed = residentialNodes.filter((n) => n.speed >= MIN_RESIDENTIAL_SPEED_BPS);
  if (anyHighSpeed.length > 0) {
    return rankResidentialNodes(anyHighSpeed)[0];
  }

  // Tier 3: Preferred country residential nodes (if no node >= 50M exists anywhere)
  if (pref) {
    const prefAnySpeed = residentialNodes.filter(
      (n) => n.countryShort.toUpperCase() === pref || n.countryZh.toUpperCase() === pref
    );
    if (prefAnySpeed.length > 0) {
      return rankResidentialNodes(prefAnySpeed)[0];
    }
  }

  // Tier 4: Fallback to best available residential node
  return rankResidentialNodes(residentialNodes)[0];
}

export const vpnManager = new VpnManager();
