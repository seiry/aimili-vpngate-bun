import fs from "node:fs";
import path from "node:path";
import { spawn, type Subprocess } from "bun";
import { config } from "./config.ts";
import { saveLastConnected, clearLastConnected, getAllNodes, getLastConnectedInfo } from "./db.ts";
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
  private failedNodeIps = new Map<string, number>();
  private recoveryRetryTimer: Timer | null = null;

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
      // Generate OpenVPN template for VPNGate
      const port = node.openVpnPort || node.sslVpnPort || 443;
      const proto = node.openVpnProto || node.sslVpnProto || "tcp";
      content = [
        "client",
        "dev tun",
        `proto ${proto}`,
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
      const res = Bun.spawnSync(["ip", "route", "show", "default"]);
      const out = res.stdout.toString().trim();
      const gwMatch = out.match(/via\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
      const devMatch = out.match(/dev\s+([a-zA-Z0-9_\-]+)/);
      const gw = gwMatch ? gwMatch[1] : null;
      const iface = devMatch ? devMatch[1] : "eth0";

      if (gw) {
        this.addLog(`[Route] Preserving Docker LAN routes via gateway ${gw} dev ${iface}`);
        // Protect Docker bridge and private networks, avoiding 10.0.0.0/8 which conflicts with VPN IPs
        Bun.spawnSync(["ip", "route", "add", "172.16.0.0/12", "via", gw, "dev", iface]);
        Bun.spawnSync(["ip", "route", "add", "192.168.0.0/16", "via", gw, "dev", iface]);
      }
    } catch (e) {
      console.warn("[VPN] Route protection warning:", e);
    }
  }
  async connect(node: VpnNode): Promise<{ success: boolean; error?: string }> {
    if (this.state === "connecting" || this.state === "connected") {
      await this.disconnect(false);
    }

    this.state = "connecting";
    this.isIntentionalDisconnect = false;
    this.hasEverConnected = false;
    this.activeNode = node;
    this.lastError = null;
    this.egressIp = null;
    const targetPort = node.openVpnPort || node.sslVpnPort || 443;
    const targetProto = (node.openVpnProto || node.sslVpnProto || "tcp").toUpperCase();
    this.addLog(`Initiating connection to ${node.countryZh} (${node.ip}:${targetPort} ${targetProto})...`);

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
          this.disconnect(false);
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
        if (!this.process || !this.process.stdout || typeof this.process.stdout === "number") return;
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
              if (this.recoveryRetryTimer) {
                clearTimeout(this.recoveryRetryTimer);
                this.recoveryRetryTimer = null;
              }
              this.failedNodeIps.delete(node.ip);
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
        if (!this.process || !this.process.stderr || typeof this.process.stderr === "number") return;
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
          this.markNodeFailed(previousNode.ip);
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
                    this.addLog(`[Watchdog] Initial failover attempts exhausted. Scheduling periodic auto-recovery...`);
                    this.scheduleRecoveryRetry(config.preferredCountry || previousNode.countryShort);
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
    if (this.recoveryRetryTimer) {
      clearTimeout(this.recoveryRetryTimer);
      this.recoveryRetryTimer = null;
    }
    this.hasEverConnected = false;
    if (intentional) {
      clearLastConnected();
      this.failedNodeIps.clear();
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
  markNodeFailed(ip: string, cooldownMs = 15 * 60 * 1000): void {
    this.failedNodeIps.set(ip, Date.now() + cooldownMs);
  }

  public scheduleRecoveryRetry(country?: string): void {
    if (this.isIntentionalDisconnect) return;
    const lastSession = getLastConnectedInfo();
    if (!config.autoReconnect && !config.autoConnect && !lastSession.enabled) return;

    if (this.recoveryRetryTimer) {
      clearTimeout(this.recoveryRetryTimer);
    }

    const retryCountry = country || lastSession.country || config.preferredCountry;
    this.addLog(`[AutoRecovery] Scheduling automatic recovery attempt in 30s (${retryCountry || "ANY"})...`);
    this.recoveryRetryTimer = setTimeout(async () => {
      this.recoveryRetryTimer = null;
      if (this.state !== "connected" && this.state !== "connecting" && !this.isIntentionalDisconnect) {
        this.addLog(`[AutoRecovery] Executing scheduled recovery attempt...`);
        const success = await this.reconnectFailover(retryCountry);
        if (!success && !this.isIntentionalDisconnect) {
          this.scheduleRecoveryRetry(retryCountry);
        }
      }
    }, 30000);
  }

  /**
   * Automatic failover: finds and iterates through the next best residential SSL-VPN nodes
   * Requirements:
   * 1. Only residential broadband nodes ("自动失效替换只会在家宽里")
   * 2. Respect preferred country first ("首先要遵守当前的优先国家")
   * 3. Exclude failed/dead node IPs (including cooldown)
   * 4. Speed must not be too slow: threshold >= 50M
   * 5. Rank by 60% active sessions + 40% speed
   * 6. Multi-attempt failover loop across up to maxAttempts candidates
   */
  async reconnectFailover(country?: string, excludeIp?: string, maxAttempts = 3): Promise<boolean> {
    const prefCountry = country || config.preferredCountry;

    const excludeSet = new Set<string>();
    if (excludeIp) excludeSet.add(excludeIp);

    const now = Date.now();
    for (const [ip, expiresAt] of this.failedNodeIps.entries()) {
      if (now < expiresAt) {
        excludeSet.add(ip);
      } else {
        this.failedNodeIps.delete(ip);
      }
    }

    let candidates = findCandidateResidentialNodes({
      preferredCountry: prefCountry,
      excludeIps: excludeSet,
      maxCount: maxAttempts,
    });

    // If cooldown excluded all available nodes, clear cooldown and retry without cooldown
    if (candidates.length === 0 && excludeSet.size > (excludeIp ? 1 : 0)) {
      this.failedNodeIps.clear();
      candidates = findCandidateResidentialNodes({
        preferredCountry: prefCountry,
        excludeIp,
        maxCount: maxAttempts,
      });
    }

    if (candidates.length === 0) {
      this.addLog(`[Failover] No qualifying residential backup node found for country: ${prefCountry || "ANY"}`);
      return false;
    }

    const primaryCandidate = candidates[0];
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      this.addLog(
        `[Failover] [${i + 1}/${candidates.length}] Attempting residential backup: ${candidate.countryZh} (${candidate.ip}, ${candidate.speedFormatted}, ${candidate.numVpnSessions} sessions)...`
      );
      const res = await this.connect(candidate);
      if (res.success) {
        this.addLog(
          `[Failover] Successfully established connection to residential backup: ${candidate.countryZh} (${candidate.ip})`
        );
        return true;
      }
      this.markNodeFailed(candidate.ip);
      this.addLog(`[Failover] Candidate ${candidate.ip} failed (${res.error || "connection error"}).`);
    }
    // All candidate attempts failed: preserve the primary chosen candidate as activeNode for status display
    this.activeNode = primaryCandidate;
    this.addLog(`[Failover] All ${candidates.length} residential candidate attempts failed.`);
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
              this.markNodeFailed(failedNode.ip);
              if (failedNode.ipType !== "residential") {
                this.addLog(
                  `[Watchdog] Current node (${failedNode.ip}) is not residential broadband (${failedNode.ipType || "unknown"}). Automatic failover only applies to residential broadband.`
                );
              } else {
                this.addLog(
                  `[Watchdog] Initiating automatic failover to next best residential node (excluding ${failedNode.ip})...`
                );
                const success = await this.reconnectFailover(
                  config.preferredCountry || failedNode.countryShort,
                  failedNode.ip
                );
                if (!success) {
                  this.addLog(`[Watchdog] Initial failover attempts exhausted. Scheduling periodic auto-recovery...`);
                  this.scheduleRecoveryRetry(config.preferredCountry || failedNode.countryShort);
                }
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
 * Finds candidate residential SSL-VPN nodes for automatic failover.
 * Requirements:
 * 1. Only residential nodes (ipType === "residential")
 * 2. Exclude failed/current node IPs (excludeIp / excludeIps)
 * 3. Freshness filter: If nodes updated within maxAgeMs (default 3 hours) exist, prioritize them
 * 4. Respect current preferred country first
 * 5. Filter out nodes below 50M (speed >= 50 Mbps)
 * 6. Rank by 60% active sessions (fewer is better) and 40% speed
 */
export function findCandidateResidentialNodes(options: {
  preferredCountry?: string;
  excludeIp?: string;
  excludeIps?: string[] | Set<string>;
  allNodes?: VpnNode[];
  maxCount?: number;
  maxAgeMs?: number;
}): VpnNode[] {
  const allNodes = options.allNodes || getAllNodes(false);
  const excludeSet = new Set<string>();
  if (options.excludeIp) excludeSet.add(options.excludeIp);
  if (options.excludeIps) {
    for (const ip of options.excludeIps) {
      excludeSet.add(ip);
    }
  }

  // 1. Filter residential nodes and exclude requested IPs
  let residentialNodes = allNodes.filter(
    (n) => n.ipType === "residential" && !excludeSet.has(n.ip)
  );

  if (residentialNodes.length === 0) {
    return [];
  }

  // 2. Freshness filter: If we have nodes updated recently (default 3h), prioritize them
  const maxAge = options.maxAgeMs ?? 3 * 3600 * 1000;
  const now = Date.now();
  const freshNodes = residentialNodes.filter(
    (n) => typeof n.lastUpdated === "number" && n.lastUpdated > now - maxAge
  );
  if (freshNodes.length > 0) {
    residentialNodes = freshNodes;
  }

  const pref = (options.preferredCountry || config.preferredCountry || "").toUpperCase();
  const maxCount = options.maxCount ?? 5;

  const result: VpnNode[] = [];
  const addedIps = new Set<string>();

  const appendCandidates = (nodes: VpnNode[]) => {
    const ranked = rankResidentialNodes(nodes);
    for (const n of ranked) {
      if (!addedIps.has(n.ip)) {
        addedIps.add(n.ip);
        result.push(n);
        if (result.length >= maxCount) return true;
      }
    }
    return false;
  };

  // Tier 1: Preferred country residential nodes with speed >= 50 Mbps
  if (pref) {
    const prefHighSpeed = residentialNodes.filter(
      (n) =>
        (n.countryShort.toUpperCase() === pref || n.countryZh.toUpperCase() === pref) &&
        n.speed >= MIN_RESIDENTIAL_SPEED_BPS
    );
    if (prefHighSpeed.length > 0) {
      appendCandidates(prefHighSpeed);
      return result;
    }
  }

  // Tier 2: Other countries residential nodes with speed >= 50 Mbps
  const anyHighSpeed = residentialNodes.filter((n) => n.speed >= MIN_RESIDENTIAL_SPEED_BPS);
  if (anyHighSpeed.length > 0) {
    appendCandidates(anyHighSpeed);
    return result;
  }

  // Tier 3: Preferred country residential nodes (if no node >= 50M exists anywhere)
  if (pref) {
    const prefAnySpeed = residentialNodes.filter(
      (n) => n.countryShort.toUpperCase() === pref || n.countryZh.toUpperCase() === pref
    );
    if (prefAnySpeed.length > 0) {
      appendCandidates(prefAnySpeed);
      return result;
    }
  }

  // Tier 4: Fallback to best available residential node
  appendCandidates(residentialNodes);
  return result;
}

export function findNextBestResidentialNode(options: {
  preferredCountry?: string;
  excludeIp?: string;
  excludeIps?: string[] | Set<string>;
  allNodes?: VpnNode[];
}): VpnNode | null {
  const candidates = findCandidateResidentialNodes(options);
  return candidates[0] || null;
}

export const vpnManager = new VpnManager();
