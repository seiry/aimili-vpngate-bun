import { config } from "./config.ts";
import { proxyServer } from "./proxy.ts";
import { vpnManager } from "./vpn.ts";
import { app } from "./routes.ts";
import { refreshNodes } from "./fetcher.ts";
import { getAllNodes, getNodeById, getLastConnectedInfo, cleanStaleNodes } from "./db.ts";
import type { VpnNode } from "./types.ts";

console.log("=================================================");
console.log(`   AimiliVPN Gate (Bun) - SSL-VPN to SOCKS5 Gateway`);
console.log(`   Image Version : ${config.appVersion}`);
console.log("=================================================");
console.log(`[System] Running Image Version: ${config.appVersion}`);
console.log(`[Config] Web Dashboard: http://${config.uiHost}:${config.uiPort}`);
console.log(`[Config] SOCKS5 Proxy : socks5://${config.proxyHost}:${config.proxyPort}`);
console.log(`[Config] Data Dir     : ${config.dataDir}`);
if (config.uiAuthEnabled) {
  console.log(`[Config] Web UI Auth  : Enabled (User: "${config.uiUser}", Pass: "${config.uiPass}")`);
}
if (config.proxyUser && config.proxyPass) {
  console.log(`[Config] Proxy Auth   : Enabled (${config.proxyUser}:***)`);
}

// 1. Start SOCKS5 & HTTP proxy server
await proxyServer.start();

// 2. Start Web UI HTTP server using Bun.serve
const server = Bun.serve({
  port: config.uiPort,
  hostname: config.uiHost,
  fetch: app.fetch,
});
console.log(`[Web] Dashboard running at http://${server.hostname}:${server.port}`);

// Clean stale nodes from database on boot
const prunedOnBoot = cleanStaleNodes(3 * 3600 * 1000);
if (prunedOnBoot > 0) {
  console.log(`[Init] Cleaned up ${prunedOnBoot} stale nodes (>3 hours old) from cache.`);
}

// 3. Initial node loading
const cachedNodes = getAllNodes(false);
if (cachedNodes.length === 0) {
  console.log("[Init] No nodes in cache. Fetching initial VPNGate node list...");
  refreshNodes().catch((err) => console.error("[Init] Error in initial fetch:", err));
} else {
  console.log(`[Init] Loaded ${cachedNodes.length} VPN nodes from cache.`);
  // Fetch fresh list in background
  refreshNodes().catch((err) => console.error("[Init] Background update error:", err));
}

// 4. Automatic Session Recovery on Restart or Auto-Connect
const lastSession = getLastConnectedInfo();
if (config.autoReconnect && lastSession.enabled && lastSession.nodeId) {
  setTimeout(async () => {
    console.log(`[AutoReconnect] Detected saved VPN session from previous run (Node: ${lastSession.nodeId})`);
    const savedNode = getNodeById(lastSession.nodeId);
    let connected = false;
    if (savedNode) {
      console.log(`[AutoReconnect] Restoring connection to previously used node: ${savedNode.countryZh} (${savedNode.ip})...`);
      const res = await vpnManager.connect(savedNode);
      connected = res.success;
      if (!connected) {
        vpnManager.markNodeFailed(savedNode.ip);
        console.warn(`[AutoReconnect] Previous node ${savedNode.ip} failed to reconnect. Attempting failover in ${lastSession.country || config.preferredCountry}...`);
      }
    } else {
      console.warn(`[AutoReconnect] Previous node ${lastSession.nodeId} is no longer reachable. Failing over to best node in ${lastSession.country || config.preferredCountry}...`);
    }

    if (!connected) {
      const targetCountry = lastSession.country || config.preferredCountry;
      const failoverRes = await vpnManager.reconnectFailover(targetCountry, savedNode?.ip);
      if (!failoverRes) {
        vpnManager.scheduleRecoveryRetry(targetCountry);
      }
    }
  }, 2500);
} else if (config.autoConnect) {
  setTimeout(async () => {
    const nodes = getAllNodes(false);
    if (nodes.length === 0) return;

    const pref = config.preferredCountry ? config.preferredCountry.toUpperCase() : "";
    let target: VpnNode | null = null;
    if (pref) {
      const prefResidential = nodes.filter(
        (n) => n.ipType === "residential" && (n.countryShort.toUpperCase() === pref || n.countryZh === pref)
      );
      target = prefResidential.length > 0 ? prefResidential[0] : null;
      if (!target) {
        const prefAny = nodes.filter(
          (n) => n.countryShort.toUpperCase() === pref || n.countryZh === pref
        );
        target = prefAny.length > 0 ? prefAny[0] : null;
      }
    }
    if (!target) target = nodes[0];

    console.log(`[AutoConnect] Connecting to preferred node: ${target.countryZh} (${target.ip})`);
    const res = await vpnManager.connect(target);
    if (!res.success) {
      vpnManager.scheduleRecoveryRetry(pref);
    }
  }, 3000);
}

// 5. Periodic node pool refresh (default every 30 minutes)
const refreshIntervalMs = Math.max(15, config.refreshIntervalMinutes) * 60 * 1000;
const refreshTimer = setInterval(() => {
  console.log("[Scheduler] Running periodic VPNGate node list refresh...");
  refreshNodes().catch((err) => console.error("[Scheduler] Refresh error:", err));
}, refreshIntervalMs);

const shutdown = async (signal: string) => {
  console.log(`\n[Shutdown] Received ${signal}, closing gracefully...`);
  clearInterval(refreshTimer);
  // Preserve saved session for container restart auto-recovery
  await vpnManager.disconnect(false);
  await proxyServer.stop();
  server.stop();
  console.log("[Shutdown] Complete. Bye!");
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
