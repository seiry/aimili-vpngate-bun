import fs from "node:fs";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { handleRequest } from "../src/routes.ts";
import { config } from "../src/config.ts";
import { getAllNodes, saveNodes, saveLastConnected, clearLastConnected, getLastConnectedInfo } from "../src/db.ts";
import { vpnManager } from "../src/vpn.ts";

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

const authHeader = `Basic ${Buffer.from(`${config.uiUser}:${config.uiPass}`).toString("base64")}`;

test("GET / without auth returns 401 Unauthorized", async () => {
  const req = new Request("http://localhost:8787/");
  const res = await handleRequest(req);
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toContain("Basic");
});

test("GET /api/status with auth returns vpn and proxy stats", async () => {
  const req = new Request("http://localhost:8787/api/status", {
    headers: { Authorization: authHeader },
  });
  const res = await handleRequest(req);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { vpn: { state: string }; proxy: { port: number } };
  expect(body.vpn).toBeDefined();
  expect(body.proxy).toBeDefined();
});

test("GET /api/nodes with auth returns seeded SSL-VPN nodes", async () => {
  const req = new Request("http://localhost:8787/api/nodes?ssl_only=true&ip_type=ALL", {
    headers: { Authorization: authHeader },
  });
  const res = await handleRequest(req);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { total: number; nodes: Array<{ ip: string; hasSslVpn: boolean }> };
  expect(body.total).toBeGreaterThan(0);
  expect(body.nodes.some((n) => n.ip === "219.100.37.178")).toBe(true);
  expect(body.nodes[0].hasSslVpn).toBe(true);
});

test("GET /api/export with auth returns valid SOCKS5 export URLs", async () => {
  const req = new Request("http://localhost:8787/api/export", {
    headers: { Authorization: authHeader },
  });
  const res = await handleRequest(req);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { socks5Url: string; curlSocks: string };
  expect(body.socks5Url).toContain("socks5://");
  expect(body.curlSocks).toContain("curl --proxy");
});

test("GET / with auth serves the SPA index.html", async () => {
  const req = new Request("http://localhost:8787/", {
    headers: { Authorization: authHeader },
  });
  const res = await handleRequest(req);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const text = await res.text();
  expect(text).toContain("AimiliVPN Gate (Bun)");
  expect(text).toContain("SSL-VPN");
});
test("POST /api/smart-connect prioritizes preferredCountry (KR)", async () => {
  // Seed a Korean node alongside the Japanese node
  saveNodes([
    {
      id: "KR_220.120.133.103_443_tcp",
      hostName: "vpn-korea.opengw.net",
      ip: "220.120.133.103",
      score: 100000,
      ping: 45,
      speed: 100000000,
      speedFormatted: "100 Mbps",
      countryLong: "Korea Republic of",
      countryShort: "KR",
      countryZh: "韩国",
      numVpnSessions: 50,
      uptime: 80000,
      totalUsers: 10000,
      totalTraffic: 500000,
      operator: "Korea Telecom",
      message: "Test",
      hasSslVpn: true,
      sslVpnPort: 443,
      sslVpnProto: "tcp",
      openVpnProto: "tcp",
      openVpnPort: 443,
      latencyMs: null,
      lastUpdated: Date.now(),
      ipType: "residential",
      ipTypeZh: "家庭宽带",
    },
  ]);

  config.preferredCountry = "KR";
  const req = new Request("http://localhost:8787/api/smart-connect", {
    method: "POST",
    headers: { Authorization: authHeader },
  });
  const res = await handleRequest(req);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { success: boolean; node: { countryShort: string; ip: string } };
  expect(body.success).toBe(true);
  expect(body.node.countryShort).toBe("KR");
});
test("Session persistence saves and clears last connected node", () => {
  const sampleNode = {
    id: "KR_test_reconnect_node",
    hostName: "vpn-test.opengw.net",
    ip: "220.120.133.103",
    score: 1000,
    ping: 30,
    speed: 50000000,
    speedFormatted: "50 Mbps",
    countryLong: "Korea",
    countryShort: "KR",
    countryZh: "韩国",
    numVpnSessions: 10,
    uptime: 1000,
    totalUsers: 100,
    totalTraffic: 1000,
    operator: "Test",
    message: "",
    hasSslVpn: true,
    sslVpnPort: 443,
    sslVpnProto: "tcp" as const,
    openVpnProto: "tcp" as const,
    openVpnPort: 443,
    latencyMs: null,
    lastUpdated: Date.now(),
  };

  saveLastConnected(sampleNode);
  const info = getLastConnectedInfo();
  expect(info.enabled).toBe(true);
  expect(info.nodeId).toBe("KR_test_reconnect_node");
  expect(info.country).toBe("KR");

  clearLastConnected();
  const cleared = getLastConnectedInfo();
  expect(cleared.enabled).toBe(false);
  expect(cleared.nodeId).toBe("");
});

test("reconnectFailover excludes dead node IP and selects alternate candidate", async () => {
  saveNodes([
    {
      id: "TEST_node_1",
      hostName: "vpn-test1.opengw.net",
      ip: "198.51.100.1",
      score: 99999999,
      ping: 20,
      speed: 100000000,
      speedFormatted: "100 Mbps",
      countryLong: "Testland",
      countryShort: "TL",
      countryZh: "测试国",
      numVpnSessions: 50,
      uptime: 80000,
      totalUsers: 10000,
      totalTraffic: 500000,
      operator: "TestISP",
      message: "Test",
      hasSslVpn: true,
      sslVpnPort: 443,
      sslVpnProto: "tcp",
      openVpnProto: "tcp",
      openVpnPort: 443,
      latencyMs: null,
      lastUpdated: Date.now(),
      ipType: "residential",
      ipTypeZh: "家庭宽带",
    },
    {
      id: "TEST_node_2",
      hostName: "vpn-test2.opengw.net",
      ip: "198.51.100.2",
      score: 99999998,
      ping: 25,
      speed: 80000000,
      speedFormatted: "80 Mbps",
      countryLong: "Testland",
      countryShort: "TL",
      countryZh: "测试国",
      numVpnSessions: 30,
      uptime: 60000,
      totalUsers: 5000,
      totalTraffic: 200000,
      operator: "TestISP2",
      message: "Test 2",
      hasSslVpn: true,
      sslVpnPort: 443,
      sslVpnProto: "tcp",
      openVpnProto: "tcp",
      openVpnPort: 443,
      latencyMs: null,
      lastUpdated: Date.now(),
      ipType: "residential",
      ipTypeZh: "家庭宽带",
    },
  ]);

  // When failover is triggered for TL while excluding the dead node 198.51.100.1
  await vpnManager.reconnectFailover("TL", "198.51.100.1");
  const status = vpnManager.getStatus();
  // The manager must target the alternate node TEST_node_2 (198.51.100.2), NOT the dead TEST_node_1
  expect(status.activeNode).toBeDefined();
  expect(status.activeNode?.ip).toBe("198.51.100.2");
});

test("prepareConfigFile injects reneg-sec 0, keepalive, and strips conflicting options", async () => {
  const sampleNode = {
    id: "TEST_config_node",
    hostName: "vpn-test.opengw.net",
    ip: "198.51.100.99",
    score: 1000,
    ping: 30,
    speed: 50000000,
    speedFormatted: "50 Mbps",
    countryLong: "Testland",
    countryShort: "TL",
    countryZh: "测试国",
    numVpnSessions: 10,
    uptime: 1000,
    totalUsers: 100,
    totalTraffic: 1000,
    operator: "Test",
    message: "",
    hasSslVpn: true,
    sslVpnPort: 443,
    sslVpnProto: "tcp" as const,
    openVpnProto: "tcp" as const,
    openVpnPort: 443,
    latencyMs: null,
    lastUpdated: Date.now(),
    // Sample base64 config that includes conflicting options
    openVpnConfigBase64: Buffer.from(
      "client\ndev tun\nproto tcp\nremote 198.51.100.99 443\nreneg-sec 3600\nauth-nocache\nredirect-gateway\n"
    ).toString("base64"),
  };

  const helper = vpnManager as unknown as { prepareConfigFile(node: typeof sampleNode): Promise<string> };
  const cfgPath = await helper.prepareConfigFile(sampleNode);
  const content = fs.readFileSync(cfgPath, "utf-8");

  // Verifies conflicting options are removed
  expect(content).not.toContain("reneg-sec 3600");
  expect(content).not.toContain("auth-nocache");
  // Verifies robust resilience options are injected
  expect(content).toContain("reneg-sec 0");
  expect(content).toContain("keepalive 10 60");
  expect(content).toContain("ping-timer-rem");
  expect(content).toContain("persist-tun");
  expect(content).toContain("persist-key");
  expect(content).toContain("connect-retry-max 3");
  expect(content).toContain("redirect-gateway def1");
});
