import { config } from "./config.ts";
import { proxyServer } from "./proxy.ts";
import { vpnManager } from "./vpn.ts";
import { handleRequest } from "./routes.ts";
import { refreshNodes } from "./fetcher.ts";
import { getAllNodes } from "./db.ts";

console.log("=================================================");
console.log("   AimiliVPN Gate (Bun) - SSL-VPN to SOCKS5 Gateway");
console.log("=================================================");
console.log(`[Config] Web Dashboard: http://${config.uiHost}:${config.uiPort}`);
console.log(`[Config] SOCKS5 Proxy : socks5://${config.proxyHost}:${config.proxyPort}`);
console.log(`[Config] Data Dir     : ${config.dataDir}`);
if (config.proxyUser && config.proxyPass) {
  console.log(`[Config] Proxy Auth   : Enabled (${config.proxyUser}:***)`);
}

// 1. Start SOCKS5 & HTTP proxy server
await proxyServer.start();

// 2. Start Web UI HTTP server using Bun.serve
const server = Bun.serve({
  port: config.uiPort,
  hostname: config.uiHost,
  fetch: handleRequest,
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

// 4. Auto-connect if enabled
if (config.autoConnect) {
  setTimeout(async () => {
    const nodes = getAllNodes(true);
    if (nodes.length > 0) {
      console.log(`[AutoConnect] Connecting to top node: ${nodes[0].countryZh} (${nodes[0].ip})`);
      await vpnManager.connect(nodes[0]);
    }
  }, 3000);
}

// 5. Periodic background refresh
const refreshIntervalMs = Math.max(10, config.refreshIntervalMinutes) * 60 * 1000;
setInterval(() => {
  console.log("[Scheduler] Running periodic node list refresh...");
  refreshNodes().catch((err) => console.error("[Scheduler] Refresh error:", err));
}, refreshIntervalMs);

// 6. Graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`\n[Shutdown] Received ${signal}, closing gracefully...`);
  await vpnManager.disconnect();
  await proxyServer.stop();
  server.stop();
  console.log("[Shutdown] Complete. Bye!");
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
