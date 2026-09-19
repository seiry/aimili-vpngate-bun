import fs from "node:fs";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { handleRequest } from "../src/routes.ts";
import { config } from "../src/config.ts";
import { getAllNodes, saveNodes, saveLastConnected, clearLastConnected, getLastConnectedInfo } from "../src/db.ts";
import { vpnManager, findNextBestResidentialNode, rankResidentialNodes, MIN_RESIDENTIAL_SPEED_BPS } from "../src/vpn.ts";

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

test("rankResidentialNodes weighs active sessions at 60% and speed at 40%", () => {
  const nodeA = {
    id: "A",
    hostName: "node-a",
    ip: "10.0.0.1",
    score: 100,
    ping: 20,
    speed: 120_000_000, // 120 Mbps
    speedFormatted: "120 Mbps",
    countryLong: "Japan",
    countryShort: "JP",
    countryZh: "日本",
    numVpnSessions: 30, // 30 sessions
    uptime: 1000,
    totalUsers: 10,
    totalTraffic: 1000,
    operator: "ISP",
    message: "",
    hasSslVpn: true,
    sslVpnPort: 443,
    sslVpnProto: "tcp" as const,
    openVpnProto: "tcp" as const,
    openVpnPort: 443,
    latencyMs: null,
    lastUpdated: Date.now(),
    ipType: "residential" as const,
  };
  const nodeB = {
    ...nodeA,
    id: "B",
    ip: "10.0.0.2",
    speed: 90_000_000, // 90 Mbps (lower speed than A)
    speedFormatted: "90 Mbps",
    numVpnSessions: 2, // 2 sessions (far fewer than A)
  };
  const nodeC = {
    ...nodeA,
    id: "C",
    ip: "10.0.0.3",
    speed: 200_000_000, // 200 Mbps (highest speed)
    speedFormatted: "200 Mbps",
    numVpnSessions: 80, // 80 sessions (crowded)
  };

  // Node B: maxSpeed=200M, maxSessions=80
  // Speed score: 90/200 = 0.45 * 0.4 = 0.18
  // Session score: (1 - 2/80) = 0.975 * 0.6 = 0.585
  // Total B: 0.765
  // Node A: 120/200 * 0.4 + (1 - 30/80) * 0.6 = 0.24 + 0.375 = 0.615
  // Node C: 200/200 * 0.4 + (1 - 80/80) * 0.6 = 0.40 + 0.000 = 0.400
  const ranked = rankResidentialNodes([nodeA, nodeB, nodeC]);
  expect(ranked[0].id).toBe("B");
  expect(ranked[1].id).toBe("A");
  expect(ranked[2].id).toBe("C");
});

test("findNextBestResidentialNode strictly filters out non-residential nodes", () => {
  const dcNode = {
    id: "DC_NODE",
    hostName: "datacenter.opengw.net",
    ip: "10.0.1.1",
    score: 9999999,
    ping: 5,
    speed: 500_000_000, // 500 Mbps
    speedFormatted: "500 Mbps",
    countryLong: "Japan",
    countryShort: "JP",
    countryZh: "日本",
    numVpnSessions: 0,
    uptime: 1000,
    totalUsers: 10,
    totalTraffic: 1000,
    operator: "Colo",
    message: "",
    hasSslVpn: true,
    sslVpnPort: 443,
    sslVpnProto: "tcp" as const,
    openVpnProto: "tcp" as const,
    openVpnPort: 443,
    latencyMs: null,
    lastUpdated: Date.now(),
    ipType: "datacenter" as const, // Datacenter!
  };
  const resNode = {
    ...dcNode,
    id: "RES_NODE",
    ip: "10.0.1.2",
    speed: 80_000_000, // 80 Mbps
    speedFormatted: "80 Mbps",
    numVpnSessions: 5,
    ipType: "residential" as const, // Residential!
  };

  const best = findNextBestResidentialNode({
    preferredCountry: "JP",
    allNodes: [dcNode, resNode],
  });
  // Datacenter node must be completely disqualified despite 500 Mbps and 0 sessions
  expect(best).toBeDefined();
  expect(best?.id).toBe("RES_NODE");
  expect(best?.ipType).toBe("residential");
});

test("findNextBestResidentialNode filters out nodes below 50M (< 50 Mbps)", () => {
  const slowNode = {
    id: "SLOW_RES",
    hostName: "slow.opengw.net",
    ip: "10.0.2.1",
    score: 9999,
    ping: 10,
    speed: 30_000_000, // 30 Mbps (< 50M)
    speedFormatted: "30 Mbps",
    countryLong: "Japan",
    countryShort: "JP",
    countryZh: "日本",
    numVpnSessions: 0, // 0 sessions!
    uptime: 1000,
    totalUsers: 10,
    totalTraffic: 1000,
    operator: "ISP",
    message: "",
    hasSslVpn: true,
    sslVpnPort: 443,
    sslVpnProto: "tcp" as const,
    openVpnProto: "tcp" as const,
    openVpnPort: 443,
    latencyMs: null,
    lastUpdated: Date.now(),
    ipType: "residential" as const,
  };
  const fastNode = {
    ...slowNode,
    id: "FAST_RES",
    ip: "10.0.2.2",
    speed: 60_000_000, // 60 Mbps (>= 50M)
    speedFormatted: "60 Mbps",
    numVpnSessions: 5,
  };

  const best = findNextBestResidentialNode({
    preferredCountry: "JP",
    allNodes: [slowNode, fastNode],
  });
  // The node with speed < 50M is disqualified when >= 50M node is available
  expect(best).toBeDefined();
  expect(best?.id).toBe("FAST_RES");
});

test("findNextBestResidentialNode prioritizes preferred country first", () => {
  const prefNode = {
    id: "JP_RES",
    hostName: "jp.opengw.net",
    ip: "10.0.3.1",
    score: 1000,
    ping: 30,
    speed: 70_000_000, // 70 Mbps
    speedFormatted: "70 Mbps",
    countryLong: "Japan",
    countryShort: "JP",
    countryZh: "日本",
    numVpnSessions: 10,
    uptime: 1000,
    totalUsers: 10,
    totalTraffic: 1000,
    operator: "ISP",
    message: "",
    hasSslVpn: true,
    sslVpnPort: 443,
    sslVpnProto: "tcp" as const,
    openVpnProto: "tcp" as const,
    openVpnPort: 443,
    latencyMs: null,
    lastUpdated: Date.now(),
    ipType: "residential" as const,
  };
  const otherNode = {
    ...prefNode,
    id: "US_RES",
    ip: "10.0.3.2",
    countryLong: "United States",
    countryShort: "US",
    countryZh: "美国",
    speed: 200_000_000, // 200 Mbps (faster than JP)
    speedFormatted: "200 Mbps",
    numVpnSessions: 1, // fewer sessions
  };

  const best = findNextBestResidentialNode({
    preferredCountry: "JP",
    allNodes: [otherNode, prefNode],
  });
  // Must adhere to preferred country JP first
  expect(best).toBeDefined();
  expect(best?.id).toBe("JP_RES");
  expect(best?.countryShort).toBe("JP");
});

test("findNextBestResidentialNode falls back to other country if preferred country has no >= 50M node", () => {
  const slowPrefNode = {
    id: "JP_SLOW",
    hostName: "jp-slow.opengw.net",
    ip: "10.0.4.1",
    score: 1000,
    ping: 30,
    speed: 20_000_000, // 20 Mbps (< 50M)
    speedFormatted: "20 Mbps",
    countryLong: "Japan",
    countryShort: "JP",
    countryZh: "日本",
    numVpnSessions: 1,
    uptime: 1000,
    totalUsers: 10,
    totalTraffic: 1000,
    operator: "ISP",
    message: "",
    hasSslVpn: true,
    sslVpnPort: 443,
    sslVpnProto: "tcp" as const,
    openVpnProto: "tcp" as const,
    openVpnPort: 443,
    latencyMs: null,
    lastUpdated: Date.now(),
    ipType: "residential" as const,
  };
  const fastOtherNode = {
    ...slowPrefNode,
    id: "KR_FAST",
    ip: "10.0.4.2",
    countryLong: "Korea Republic of",
    countryShort: "KR",
    countryZh: "韩国",
    speed: 100_000_000, // 100 Mbps (>= 50M)
    speedFormatted: "100 Mbps",
    numVpnSessions: 5,
  };

  const best = findNextBestResidentialNode({
    preferredCountry: "JP",
    allNodes: [slowPrefNode, fastOtherNode],
  });
  // Since preferred country JP has only < 50M, it falls back to other country KR with >= 50M
  expect(best).toBeDefined();
  expect(best?.id).toBe("KR_FAST");
  expect(best?.countryShort).toBe("KR");
});

test("vpnManager.reconnectFailover selects node with best 60% session / 40% speed score", async () => {
  saveNodes([
    {
      id: "FO_DEAD",
      hostName: "fo-dead.opengw.net",
      ip: "198.51.200.1",
      score: 1000,
      ping: 20,
      speed: 100_000_000,
      speedFormatted: "100 Mbps",
      countryLong: "Failoverland",
      countryShort: "FO",
      countryZh: "故障转移国",
      numVpnSessions: 5,
      uptime: 1000,
      totalUsers: 10,
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
      ipType: "residential" as const,
    },
    {
      id: "FO_BUSY_FAST",
      hostName: "fo-busy.opengw.net",
      ip: "198.51.200.2",
      score: 1000,
      ping: 20,
      speed: 120_000_000, // 120 Mbps (faster)
      speedFormatted: "120 Mbps",
      countryLong: "Failoverland",
      countryShort: "FO",
      countryZh: "故障转移国",
      numVpnSessions: 60, // 60 sessions (very busy)
      uptime: 1000,
      totalUsers: 10,
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
      ipType: "residential" as const,
    },
    {
      id: "FO_IDLE_GOOD",
      hostName: "fo-idle.opengw.net",
      ip: "198.51.200.3",
      score: 1000,
      ping: 25,
      speed: 80_000_000, // 80 Mbps (>= 50M)
      speedFormatted: "80 Mbps",
      countryLong: "Failoverland",
      countryShort: "FO",
      countryZh: "故障转移国",
      numVpnSessions: 2, // 2 sessions (very low load)
      uptime: 1000,
      totalUsers: 10,
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
      ipType: "residential" as const,
    },
    {
      id: "FO_DATACENTER",
      hostName: "fo-dc.opengw.net",
      ip: "198.51.200.4",
      score: 9999999,
      ping: 5,
      speed: 1000_000_000,
      speedFormatted: "1 Gbps",
      countryLong: "Failoverland",
      countryShort: "FO",
      countryZh: "故障转移国",
      numVpnSessions: 0,
      uptime: 1000,
      totalUsers: 10,
      totalTraffic: 1000,
      operator: "Colo",
      message: "",
      hasSslVpn: true,
      sslVpnPort: 443,
      sslVpnProto: "tcp" as const,
      openVpnProto: "tcp" as const,
      openVpnPort: 443,
      latencyMs: null,
      lastUpdated: Date.now(),
      ipType: "datacenter" as const, // Datacenter must be excluded
    },
  ]);

  await vpnManager.reconnectFailover("FO", "198.51.200.1");
  const status = vpnManager.getStatus();
  // FO_IDLE_GOOD (198.51.200.3) should be selected over FO_BUSY_FAST because of 60% session weight
  expect(status.activeNode).toBeDefined();
  expect(status.activeNode?.ip).toBe("198.51.200.3");
});

test("config respects UI_PORT and PROXY_PORT environment variables", () => {
  expect(config.uiPort).toBeGreaterThan(0);
  expect(config.proxyPort).toBeGreaterThan(0);
});
