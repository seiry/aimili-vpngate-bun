import { config } from "./config.ts";
import { proxyServer } from "./proxy.ts";
import { vpnManager } from "./vpn.ts";
import { app } from "./routes.ts";
import { refreshNodes } from "./fetcher.ts";
import { getAllNodes, getNodeById, getLastConnectedInfo } from "./db.ts";

console.log("=================================================");
console.log("   AimiliVPN Gate (Bun) - SSL-VPN to SOCKS5 Gateway");
console.log("=================================================");
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

// 3. Initial node loading
const cachedNodes = getAllNodes(true);
if (cachedNodes.length === 0) {
  console.log("[Init] No nodes in cache. Fetching initial VPNGate node list...");
  refreshNodes().catch((err) => console.error("[Init] Error in initial fetch:", err));
} else {
  console.log(`[Init] Loaded ${cachedNodes.length} SSL-VPN nodes from cache.`);
  // Fetch fresh list in background
  refreshNodes().catch((err) => console.error("[Init] Background update error:", err));
}

// 4. Automatic Session Recovery on Restart or Auto-Connect
const lastSession = getLastConnectedInfo();
if (config.autoReconnect && lastSession.enabled && lastSession.nodeId) {
  setTimeout(async () => {
    console.log(`[AutoReconnect] Detected saved VPN session from previous run (Node: ${lastSession.nodeId})`);
    const savedNode = getNodeById(lastSession.nodeId);
    if (savedNode) {
      console.log(`[AutoReconnect] Restoring connection to previously used node: ${savedNode.countryZh} (${savedNode.ip})...`);
      const res = await vpnManager.connect(savedNode);
      if (!res.success) {
        console.warn(`[AutoReconnect] Previous node ${savedNode.ip} failed to reconnect. Attempting failover in ${lastSession.country || config.preferredCountry}...`);
        await vpnManager.reconnectFailover(lastSession.country || config.preferredCountry, savedNode.ip);
      }
    } else {
      console.warn(`[AutoReconnect] Previous node ${lastSession.nodeId} is no longer reachable. Failing over to best node in ${lastSession.country || config.preferredCountry}...`);
      await vpnManager.reconnectFailover(lastSession.country || config.preferredCountry);
    }
  }, 2500);
} else if (config.autoConnect) {
  setTimeout(async () => {
    const nodes = getAllNodes(true);
    if (nodes.length === 0) return;

    const pref = config.preferredCountry ? config.preferredCountry.toUpperCase() : "";
    let target: VpnNode = nodes[0];

    if (pref) {
      const prefResidential = nodes.filter(
        (n) => n.ipType === "residential" && (n.countryShort.toUpperCase() === pref || n.countryZh === pref)
      );
      if (prefResidential.length > 0) {
        target = prefResidential[0];
      } else {
        const prefAny = nodes.filter(
          (n) => n.countryShort.toUpperCase() === pref || n.countryZh === pref
        );
        if (prefAny.length > 0) {
          target = prefAny[0];
        }
      }
    }

    console.log(`[AutoConnect] Connecting to preferred node: ${target.countryZh} (${target.ip})`);
    await vpnManager.connect(target);
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
