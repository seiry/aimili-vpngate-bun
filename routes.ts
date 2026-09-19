import path from "node:path";
import fs from "node:fs";
import { config } from "./config.ts";
import { getAllNodes, getNodeById, updateNodeLatency } from "./db.ts";
import { refreshNodes, testNodeLatency } from "./fetcher.ts";
import { vpnManager } from "./vpn.ts";
import { proxyServer } from "./proxy.ts";
import type { VpnNode } from "./types.ts";

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;

  // JSON helper
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
    });

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  // Health check for Coolify & Docker
  if (pathname === "/api/health") {
    return json({ status: "ok", timestamp: Date.now() });
  }

  // Current VPN & Proxy status
  if (pathname === "/api/status" && req.method === "GET") {
    const vpnStatus = vpnManager.getStatus();
    const proxyStats = proxyServer.getStats();
    return json({
      vpn: vpnStatus,
      proxy: proxyStats,
      config: {
        uiPort: config.uiPort,
        proxyPort: config.proxyPort,
        proxyHost: config.proxyHost,
        authEnabled: Boolean(config.proxyUser && config.proxyPass),
      },
    });
  }

  // List nodes with filtering & sorting
  if (pathname === "/api/nodes" && req.method === "GET") {
    const sslOnly = url.searchParams.get("ssl_only") === "true";
    const country = url.searchParams.get("country");
    const search = url.searchParams.get("search")?.toLowerCase().trim();
    const sortBy = url.searchParams.get("sort") || "score";

    let nodes = getAllNodes(sslOnly);

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

    return json({
      total: nodes.length,
      sslCount: nodes.filter((n) => n.hasSslVpn).length,
      nodes,
    });
  }

  // Trigger manual node refresh
  if (pathname === "/api/nodes/refresh" && req.method === "POST") {
    const result = await refreshNodes();
    return json(result);
  }

  // Connect to node
  if (pathname.startsWith("/api/nodes/") && pathname.endsWith("/connect") && req.method === "POST") {
    const parts = pathname.split("/");
    const id = decodeURIComponent(parts[3]);
    const node = getNodeById(id);
    if (!node) {
      return json({ success: false, error: "Node not found." }, 404);
    }

    // Run connection attempt in background / async
    const connPromise = vpnManager.connect(node);
    const timeoutPromise = new Promise<{ success: boolean; error?: string }>((r) =>
      setTimeout(() => r({ success: true }), 4000)
    );
    // Return early if taking time, or return actual result
    const fastResult = await Promise.race([connPromise, timeoutPromise]);
    return json({
      success: true,
      message: "Connection initiated",
      initialState: vpnManager.getStatus().state,
      node,
    });
  }

  // Test node latency
  if (pathname.startsWith("/api/nodes/") && pathname.endsWith("/test") && req.method === "POST") {
    const parts = pathname.split("/");
    const id = decodeURIComponent(parts[3]);
    const node = getNodeById(id);
    if (!node) {
      return json({ success: false, error: "Node not found." }, 404);
    }

    const testPort = node.sslVpnPort || node.openVpnPort || 443;
    const latency = await testNodeLatency(node.ip, testPort, 3000);
    updateNodeLatency(id, latency);

    return json({
      id,
      ip: node.ip,
      port: testPort,
      latencyMs: latency,
    });
  }

  // Disconnect
  if (pathname === "/api/disconnect" && req.method === "POST") {
    await vpnManager.disconnect();
    return json({ success: true, state: "disconnected" });
  }

  // Smart auto-connect to best SSL-VPN node
  if (pathname === "/api/smart-connect" && req.method === "POST") {
    const nodes = getAllNodes(true);
    if (nodes.length === 0) {
      return json({ success: false, error: "No SSL-VPN nodes available." }, 400);
    }

    // Find top candidate
    let best = nodes[0];
    for (const n of nodes.slice(0, 10)) {
      if (config.preferredCountry && n.countryShort === config.preferredCountry) {
        best = n;
        break;
      }
    }

    vpnManager.connect(best);
    return json({
      success: true,
      message: `Connecting to best node: ${best.countryZh} (${best.ip})`,
      node: best,
    });
  }

  // Export Proxy config snippets
  if (pathname === "/api/export" && req.method === "GET") {
    const hostHeader = req.headers.get("host") || "127.0.0.1";
    const serverIp = hostHeader.split(":")[0];
    const proxyPort = config.proxyPort;
    const auth = config.proxyUser && config.proxyPass ? `${config.proxyUser}:${config.proxyPass}@` : "";

    return json({
      socks5Url: `socks5://${auth}${serverIp}:${proxyPort}`,
      socks5hUrl: `socks5h://${auth}${serverIp}:${proxyPort}`,
      httpUrl: `http://${auth}${serverIp}:${proxyPort}`,
      curlSocks: `curl --proxy socks5h://${auth}${serverIp}:${proxyPort} https://api.ipify.org`,
      curlHttp: `curl -x http://${auth}${serverIp}:${proxyPort} https://api.ipify.org`,
      shellEnv: `export all_proxy="socks5://${auth}${serverIp}:${proxyPort}"\nexport http_proxy="http://${auth}${serverIp}:${proxyPort}"\nexport https_proxy="http://${auth}${serverIp}:${proxyPort}"`,
      pythonSnippet: `import requests\nproxies = {\n    'http': 'socks5h://${auth}${serverIp}:${proxyPort}',\n    'https': 'socks5h://${auth}${serverIp}:${proxyPort}',\n}\nres = requests.get('https://api.ipify.org', proxies=proxies)\nprint(res.text)`,
    });
  }

  // Serve static UI: public/index.html
  if (pathname === "/" || pathname === "/index.html") {
    const indexPath = path.resolve("./public/index.html");
    if (fs.existsSync(indexPath)) {
      const html = fs.readFileSync(indexPath, "utf-8");
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
  }

  return new Response("Not Found", { status: 404 });
}
