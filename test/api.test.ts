import { test, expect, beforeAll, afterAll } from "bun:test";
import { handleRequest } from "../src/routes.ts";
import { getAllNodes, saveNodes } from "../src/db.ts";

beforeAll(() => {
  // Seed a sample SSL-VPN node into database for tests
  saveNodes([
    {
      id: "JP_219.100.37.178_443_tcp",
      hostName: "public-vpn-198.opengw.net",
      ip: "219.100.37.178",
      score: 2951670,
      ping: 21,
      speed: 1245374641,
      speedFormatted: "1.25 Gbps",
      countryLong: "Japan",
      countryShort: "JP",
      countryZh: "日本",
      numVpnSessions: 149,
      uptime: 8021098,
      totalUsers: 15533565,
      totalTraffic: 734849250816018,
      operator: "Daiyuu Nobori",
      message: "Academic Use Only",
      hasSslVpn: true,
      sslVpnPort: 443,
      sslVpnProto: "tcp",
      openVpnProto: "tcp",
      openVpnPort: 443,
      latencyMs: null,
      lastUpdated: Date.now(),
    },
  ]);
});

test("GET /api/health returns 200 and status ok", async () => {
  const req = new Request("http://localhost:8787/api/health");
  const res = await handleRequest(req);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string };
  expect(body.status).toBe("ok");
});

test("GET /api/status returns vpn and proxy stats", async () => {
  const req = new Request("http://localhost:8787/api/status");
  const res = await handleRequest(req);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { vpn: { state: string }; proxy: { port: number } };
  expect(body.vpn).toBeDefined();
  expect(body.proxy).toBeDefined();
});

test("GET /api/nodes returns seeded SSL-VPN nodes", async () => {
  const req = new Request("http://localhost:8787/api/nodes?ssl_only=true");
  const res = await handleRequest(req);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { total: number; nodes: Array<{ ip: string; hasSslVpn: boolean }> };
  expect(body.total).toBeGreaterThan(0);
  expect(body.nodes.some((n) => n.ip === "219.100.37.178")).toBe(true);
  expect(body.nodes[0].hasSslVpn).toBe(true);
});

test("GET /api/export returns valid SOCKS5 export URLs", async () => {
  const req = new Request("http://localhost:8787/api/export");
  const res = await handleRequest(req);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { socks5Url: string; curlSocks: string };
  expect(body.socks5Url).toContain("socks5://");
  expect(body.curlSocks).toContain("curl --proxy");
});

test("GET / serves the SPA index.html", async () => {
  const req = new Request("http://localhost:8787/");
  const res = await handleRequest(req);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const text = await res.text();
  expect(text).toContain("AimiliVPN Gate (Bun)");
  expect(text).toContain("SSL-VPN");
});
