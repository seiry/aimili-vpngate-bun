import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { cors } from "hono/cors";
import path from "node:path";
import fs from "node:fs";
import { config, COUNTRY_NAMES } from "./config.ts";
import { getAllNodes, getNodeById, updateNodeLatency } from "./db.ts";
import { refreshNodes, testNodeLatency, getSyncStatus } from "./fetcher.ts";
import { vpnManager } from "./vpn.ts";
import { proxyServer } from "./proxy.ts";
import type { VpnNode } from "./types.ts";

export const app = new Hono();

// 1. Enable CORS for all routes
app.use("*", cors());

// 2. Health check route (Exempt from auth for Coolify & Docker healthchecks)
app.get("/api/health", (c) => {
  return c.json({ status: "ok", timestamp: Date.now() });
});

// 3. Enforce HTTP Basic Auth if enabled for all other routes
app.use("*", async (c, next) => {
  if (config.uiAuthEnabled) {
    const auth = basicAuth({
      username: config.uiUser || "admin",
      password: config.uiPass || "",
      realm: "AimiliVPN Gate",
    });
    return auth(c, next);
  }
  return next();
});

// 4. Serve SPA index.html
app.get("/", (c) => {
  const indexPath = path.resolve("./public/index.html");
  if (fs.existsSync(indexPath)) {
    const html = fs.readFileSync(indexPath, "utf-8");
    return c.html(html);
  }
  return c.text("AimiliVPN Gate UI not found", 404);
});

app.get("/index.html", (c) => {
  const indexPath = path.resolve("./public/index.html");
  if (fs.existsSync(indexPath)) {
    const html = fs.readFileSync(indexPath, "utf-8");
    return c.html(html);
  }
  return c.text("AimiliVPN Gate UI not found", 404);
});

app.get("/vue.global.prod.js", (c) => {
  const filePath = path.resolve("./public/vue.global.prod.js");
  if (fs.existsSync(filePath)) {
    return new Response(fs.readFileSync(filePath), {
      headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400" },
    });
  }
  return c.text("Not found", 404);
});
// 5. REST APIs

// Current VPN & Proxy status
app.get("/api/status", (c) => {
  const vpnStatus = vpnManager.getStatus();
  const proxyStats = proxyServer.getStats();
  const syncStatus = getSyncStatus();
  return c.json({
    vpn: vpnStatus,
    proxy: proxyStats,
    sync: syncStatus,
    config: {
      version: config.appVersion,
      uiPort: config.uiPort,
      proxyPort: config.proxyPort,
      proxyHost: config.proxyHost,
      authEnabled: Boolean(config.proxyUser && config.proxyPass),
      preferredCountry: config.preferredCountry,
      preferredCountryZh: COUNTRY_NAMES[config.preferredCountry] || config.preferredCountry,
      autoConnect: config.autoConnect,
    },
  });
});

// List nodes with filtering & sorting
app.get("/api/nodes", (c) => {
  const sslOnly = c.req.query("ssl_only") === "true";
  const country = c.req.query("country");
  const search = c.req.query("search")?.toLowerCase().trim();
  const rawIpType = c.req.query("ip_type");
  const ipType = rawIpType !== undefined ? rawIpType : "residential";
  const sortBy = c.req.query("sort") || "score";

  let nodes = getAllNodes(sslOnly);

  if (ipType && ipType.toUpperCase() !== "ALL") {
    const filtered = nodes.filter((n) => n.ipType === ipType);
    // If filtered nodes exist, use them; if database is newly initialized and enrichment is still running, gracefully fallback
    if (filtered.length > 0) {
      nodes = filtered;
    }
  }

  if (country && country !== "ALL") {
    nodes = nodes.filter((n) => n.countryShort === country || n.countryZh === country);
  }

  if (search) {
    nodes = nodes.filter(
      (n) =>
        n.ip.includes(search) ||
        n.hostName.toLowerCase().includes(search) ||
        n.countryZh.toLowerCase().includes(search) ||
        n.countryLong.toLowerCase().includes(search) ||
        n.operator.toLowerCase().includes(search)
    );
  }

  if (sortBy === "ping") {
    nodes.sort((a, b) => (a.latencyMs || a.ping) - (b.latencyMs || b.ping));
  } else if (sortBy === "speed") {
    nodes.sort((a, b) => b.speed - a.speed);
  } else if (sortBy === "sessions") {
    nodes.sort((a, b) => b.numVpnSessions - a.numVpnSessions);
  } else {
    nodes.sort((a, b) => b.score - a.score);
  }

  return c.json({
    total: nodes.length,
    sslCount: nodes.filter((n) => n.hasSslVpn).length,
    residentialCount: nodes.filter((n) => n.ipType === "residential").length,
    datacenterCount: nodes.filter((n) => n.ipType === "datacenter").length,
    nodes,
  });
});

// Trigger manual node refresh
app.post("/api/nodes/refresh", async (c) => {
  const result = await refreshNodes();
  return c.json(result);
});

// Connect to node
app.post("/api/nodes/:id/connect", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  const node = getNodeById(id);
  if (!node) {
    return c.json({ success: false, error: "Node not found." }, 404);
  }

  // Initiate connection in background
  const connPromise = vpnManager.connect(node);
  const { promise: timeoutPromise, resolve: resolveTimeout } = Promise.withResolvers<{ success: boolean }>();
  setTimeout(() => resolveTimeout({ success: true }), 4000);

  await Promise.race([connPromise, timeoutPromise]);
  return c.json({
    success: true,
    message: "Connection initiated",
    initialState: vpnManager.getStatus().state,
    node,
  });
});

// Test node direct latency
app.post("/api/nodes/:id/test", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  const node = getNodeById(id);
  if (!node) {
    return c.json({ success: false, error: "Node not found." }, 404);
  }

  const testPort = node.sslVpnPort || node.openVpnPort || 443;
  const latency = await testNodeLatency(node.ip, testPort, 3000);
  updateNodeLatency(id, latency);

  return c.json({
    id,
    ip: node.ip,
    port: testPort,
    latencyMs: latency,
  });
});

// Disconnect (intentional user action -> clears auto-reconnect session)
app.post("/api/disconnect", async (c) => {
  await vpnManager.disconnect(true);
  return c.json({ success: true, state: "disconnected" });
});

// Smart auto-connect to best node (prioritizing residential nodes across all protocols & ports)
app.post("/api/smart-connect", async (c) => {
  const nodes = getAllNodes(false);
  if (nodes.length === 0) {
    return c.json({ success: false, error: "No VPN nodes available." }, 400);
  }
  const pref = config.preferredCountry ? config.preferredCountry.toUpperCase() : "";
  let best: VpnNode | null = null;

  if (pref) {
    // 1. First priority: residential SSL-VPN node in preferred country across ALL nodes
    const prefResidential = nodes.filter(
      (n) => n.ipType === "residential" && (n.countryShort.toUpperCase() === pref || n.countryZh === pref)
    );
    if (prefResidential.length > 0) {
      best = prefResidential[0];
    } else {
      // 2. Second priority: any SSL-VPN node in preferred country across ALL nodes
      const prefAny = nodes.filter(
        (n) => n.countryShort.toUpperCase() === pref || n.countryZh === pref
      );
      if (prefAny.length > 0) {
        best = prefAny[0];
      }
    }
  }

  // 3. Fallback: best residential node overall, then best overall
  if (!best) {
    const anyResidential = nodes.filter((n) => n.ipType === "residential");
    best = anyResidential.length > 0 ? anyResidential[0] : nodes[0];
  }
  vpnManager.connect(best);
  return c.json({
    success: true,
    message: `Connecting to best node: ${best.countryZh} (${best.ip})`,
    node: best,
  });
});

// Export Proxy config snippets
app.get("/api/export", (c) => {
  const hostHeader = c.req.header("host") || "127.0.0.1";
  const serverIp = hostHeader.split(":")[0];
  const proxyPort = config.proxyPort;
  const auth = config.proxyUser && config.proxyPass ? `${config.proxyUser}:${config.proxyPass}@` : "";

  return c.json({
    socks5Url: `socks5://${auth}${serverIp}:${proxyPort}`,
    socks5hUrl: `socks5h://${auth}${serverIp}:${proxyPort}`,
    httpUrl: `http://${auth}${serverIp}:${proxyPort}`,
    curlSocks: `curl --proxy socks5h://${auth}${serverIp}:${proxyPort} https://api.ipify.org`,
    curlHttp: `curl -x http://${auth}${serverIp}:${proxyPort} https://api.ipify.org`,
    shellEnv: `export all_proxy="socks5://${auth}${serverIp}:${proxyPort}"\nexport http_proxy="http://${auth}${serverIp}:${proxyPort}"\nexport https_proxy="http://${auth}${serverIp}:${proxyPort}"`,
    pythonSnippet: `import requests\nproxies = {\n    'http': 'socks5h://${auth}${serverIp}:${proxyPort}',\n    'https': 'socks5h://${auth}${serverIp}:${proxyPort}',\n}\nres = requests.get('https://api.ipify.org', proxies=proxies)\nprint(res.text)`,
  });
});

// Backward compatibility helper
export const handleRequest = (req: Request): Promise<Response> | Response => app.fetch(req);
