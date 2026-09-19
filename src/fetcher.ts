import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { config, COUNTRY_NAMES } from "./config.ts";
import { saveNodes, getAllNodes, updateNodeLatency } from "./db.ts";
import type { VpnNode } from "./types.ts";

function formatSpeed(bps: number): string {
  if (bps >= 1_000_000_000) {
    return `${(bps / 1_000_000_000).toFixed(2)} Gbps`;
  }
  if (bps >= 1_000_000) {
    return `${(bps / 1_000_000).toFixed(2)} Mbps`;
  }
  if (bps >= 1_000) {
    return `${(bps / 1_000).toFixed(2)} Kbps`;
  }
  return `${bps} bps`;
}

function parseSpeedToBps(speedStr: string): number {
  const match = speedStr.match(/([\d.]+)\s*(Mbps|Gbps|Kbps|bps)?/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = (match[2] || "Mbps").toLowerCase();
  if (unit === "gbps") return Math.round(num * 1_000_000_000);
  if (unit === "mbps") return Math.round(num * 1_000_000);
  if (unit === "kbps") return Math.round(num * 1_000);
  return Math.round(num);
}

function parseCleanText(htmlSnippet: string): string {
  return htmlSnippet
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parses the HTML table from https://www.vpngate.net/cn/
 */
export function parseVpngateHtml(html: string): VpnNode[] {
  const nodes: VpnNode[] = [];
  const idx = html.indexOf("物理位置");
  if (idx === -1) return nodes;

  const tableStart = html.lastIndexOf("<table", idx);
  const tableEnd = html.indexOf("</table>", idx);
  if (tableStart === -1 || tableEnd === -1) return nodes;

  const tableHtml = html.substring(tableStart, tableEnd + 8);
  const rows = tableHtml.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];

  for (const row of rows) {
    if (!row.includes("vg_table_row_")) continue;
    const tds = row.match(/<td[^>]*>[\s\S]*?<\/td>/gi);
    if (!tds || tds.length < 10) continue;

    // TD 0: Country & Flag
    const countryRaw = parseCleanText(tds[0]);
    const countryShortMatch = tds[0].match(/flags\/([A-Z]{2})\.png/i);
    const countryShort = countryShortMatch ? countryShortMatch[1].toUpperCase() : "XX";
    const countryZh = COUNTRY_NAMES[countryShort] || countryRaw;

    // TD 1: Hostname & IP
    const hostMatch = tds[1].match(/<b><span[^>]*>([^<]+)<\/span><\/b>/i);
    const ipMatch = tds[1].match(/<span[^>]*>(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})<\/span>/i);
    const hostName = hostMatch ? hostMatch[1].trim() : "";
    const ip = ipMatch ? ipMatch[1].trim() : "";
    if (!ip) continue;

    // TD 2: Sessions / Uptime / Users
    const sessionsText = parseCleanText(tds[2]);
    const sessionsMatch = sessionsText.match(/(\d+)\s*会话/);
    const uptimeMatch = sessionsText.match(/(\d+)\s*天/);
    const usersMatch = sessionsText.match(/累计\s*([\d,]+)\s*用户/);

    const numVpnSessions = sessionsMatch ? parseInt(sessionsMatch[1], 10) : 0;
    const uptimeDays = uptimeMatch ? parseInt(uptimeMatch[1], 10) : 0;
    const totalUsers = usersMatch ? parseInt(usersMatch[1].replace(/,/g, ""), 10) : 0;

    // TD 3: Throughput & Ping
    const qualityText = parseCleanText(tds[3]);
    const pingMatch = qualityText.match(/Ping:\s*(\d+)\s*ms/i);
    const ping = pingMatch ? parseInt(pingMatch[1], 10) : 999;
    const speed = parseSpeedToBps(qualityText);

    // TD 4: SSL-VPN info (e.g. "SSL-VPN 连接指南 TCP: 443 UDP: 支持")
    const sslText = parseCleanText(tds[4]);
    const hasSslVpn = sslText.includes("SSL-VPN");
    const sslPortMatch = sslText.match(/TCP:\s*(\d+)/i);
    const sslVpnPort = sslPortMatch ? parseInt(sslPortMatch[1], 10) : 443;

    // TD 6: OpenVPN info
    const openVpnLinkMatch = tds[6].match(/href=['"]([^'"]*do_openvpn\.aspx[^'"]*)['"]/i);
    const openVpnLink = openVpnLinkMatch ? openVpnLinkMatch[1].replace(/&amp;/g, "&") : undefined;
    const openVpnTcpMatch = tds[6].match(/TCP:\s*(\d+)/i);
    const openVpnUdpMatch = tds[6].match(/UDP:\s*(\d+)/i);
    const openVpnPort = openVpnTcpMatch ? parseInt(openVpnTcpMatch[1], 10) : (openVpnUdpMatch ? parseInt(openVpnUdpMatch[1], 10) : 443);
    const openVpnProto = openVpnTcpMatch ? "tcp" : "udp";

    // TD 8: Operator
    const operator = parseCleanText(tds[8]);

    // TD 9: Score
    const scoreText = parseCleanText(tds[9]).replace(/,/g, "");
    const score = parseInt(scoreText, 10) || 0;

    const id = `${countryShort}_${ip}_${sslVpnPort}_tcp`;

    nodes.push({
      id,
      hostName: hostName || ip,
      ip,
      score,
      ping,
      speed,
      speedFormatted: formatSpeed(speed),
      countryLong: countryRaw,
      countryShort,
      countryZh,
      numVpnSessions,
      uptime: uptimeDays * 86400,
      totalUsers,
      totalTraffic: 0,
      operator,
      message: "",
      hasSslVpn,
      sslVpnPort,
      sslVpnProto: "tcp",
      openVpnProto,
      openVpnPort,
      openVpnLink,
      latencyMs: null,
      lastUpdated: Date.now(),
    });
  }

  return nodes;
}

/**
 * Parses the CSV output from https://www.vpngate.net/api/iphone/
 */
export function parseVpngateCsv(csvContent: string): VpnNode[] {
  const lines = csvContent.split(/\r?\n/);
  const nodes: VpnNode[] = [];

  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#HostName") || lines[i].startsWith("*vpn_servers")) {
      headerIndex = lines[i].startsWith("#") ? i : i + 1;
      break;
    }
  }
  if (headerIndex === -1 || headerIndex >= lines.length) return nodes;

  const headerLine = lines[headerIndex].replace(/^#/, "");
  const headers = headerLine.split(",").map((h) => h.trim());

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("*")) continue;

    const cols = line.split(",");
    if (cols.length < headers.length) continue;

    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = cols[j];
    }

    const ip = row.IP || "";
    if (!ip) continue;

    const hostName = row.HostName || ip;
    const countryLong = row.CountryLong || "";
    const countryShort = (row.CountryShort || "XX").toUpperCase();
    const countryZh = COUNTRY_NAMES[countryShort] || countryLong;
    const speed = parseInt(row.Speed || "0", 10);
    const ping = parseInt(row.Ping || "999", 10);
    const score = parseInt(row.Score || "0", 10);
    const sessions = parseInt(row.NumVpnSessions || "0", 10);
    const uptime = parseInt(row.Uptime || "0", 10);
    const totalUsers = parseInt(row.TotalUsers || "0", 10);
    const totalTraffic = parseInt(row.TotalTraffic || "0", 10);
    const operator = row.Operator || "";
    const message = row.Message || "";
    const configBase64 = row.OpenVPN_ConfigData_Base64 || "";

    let openVpnProto: "tcp" | "udp" = "tcp";
    let openVpnPort = 443;
    let hasSslVpn = false;

    if (configBase64) {
      try {
        const decoded = Buffer.from(configBase64, "base64").toString("utf-8");
        const protoMatch = decoded.match(/^\s*proto\s+(tcp|udp)/im);
        if (protoMatch) {
          openVpnProto = protoMatch[1].toLowerCase() as "tcp" | "udp";
        }
        const remoteMatch = decoded.match(/^\s*remote\s+[\S]+\s+(\d+)/im);
        if (remoteMatch) {
          openVpnPort = parseInt(remoteMatch[1], 10);
        }
        // If proto is tcp, or port is 443/995, it is SSL-VPN!
        if (openVpnProto === "tcp" || openVpnPort === 443 || openVpnPort === 995) {
          hasSslVpn = true;
        }
      } catch {
        // Fallback defaults
      }
    }

    const id = `${countryShort}_${ip}_${openVpnPort}_${openVpnProto}`;

    nodes.push({
      id,
      hostName,
      ip,
      score,
      ping,
      speed,
      speedFormatted: formatSpeed(speed),
      countryLong,
      countryShort,
      countryZh,
      numVpnSessions: sessions,
      uptime,
      totalUsers,
      totalTraffic,
      operator,
      message,
      hasSslVpn,
      sslVpnPort: openVpnPort,
      sslVpnProto: openVpnProto,
      openVpnConfigBase64: configBase64 || undefined,
      openVpnProto,
      openVpnPort,
      latencyMs: null,
      lastUpdated: Date.now(),
    });
  }

  return nodes;
}

/**
 * Merges HTML nodes and CSV nodes by IP address
 */
export function mergeNodes(htmlNodes: VpnNode[], csvNodes: VpnNode[]): VpnNode[] {
  const csvByIp = new Map<string, VpnNode>();
  for (const n of csvNodes) {
    csvByIp.set(n.ip, n);
  }

  const merged: VpnNode[] = [];
  const processedIps = new Set<string>();

  // Prioritize HTML nodes with SSL-VPN flags, augmented with CSV OpenVPN configs
  for (const h of htmlNodes) {
    processedIps.add(h.ip);
    const csvMatch = csvByIp.get(h.ip);
    if (csvMatch) {
      merged.push({
        ...h,
        openVpnConfigBase64: csvMatch.openVpnConfigBase64 || h.openVpnConfigBase64,
        score: Math.max(h.score, csvMatch.score),
        totalTraffic: csvMatch.totalTraffic || h.totalTraffic,
        operator: h.operator || csvMatch.operator,
        message: csvMatch.message || h.message,
      });
    } else {
      merged.push(h);
    }
  }

  // Add remaining CSV nodes not found in HTML
  for (const c of csvNodes) {
    if (!processedIps.has(c.ip)) {
      merged.push(c);
    }
  }

  return merged;
}

let lastSyncTime: number | null = null;
let isSyncing = false;
let syncError: string | null = null;

export function getSyncStatus() {
  return {
    lastSyncTime,
    isSyncing,
    syncError,
    intervalMinutes: config.refreshIntervalMinutes,
  };
}

/**
 * Fetches nodes from VPNGate and saves to SQLite
 */
export async function refreshNodes(): Promise<{ count: number; sslCount: number; error?: string }> {
  isSyncing = true;
  syncError = null;
  let htmlContent = "";
  let csvContent = "";
  // 1. Fetch HTML from https://www.vpngate.net/cn/
  try {
    const res = await fetch(config.vpngateHtmlUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AimiliVPN/3.0)" },
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) {
      htmlContent = await res.text();
    }
  } catch (err) {
    console.warn(`[Fetcher] Failed to fetch HTML from ${config.vpngateHtmlUrl}:`, err);
  }

  // 2. Fetch CSV from API
  try {
    const res = await fetch(config.vpngateApiUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AimiliVPN/3.0)" },
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) {
      csvContent = await res.text();
    }
  } catch (err) {
    console.warn(`[Fetcher] Failed to fetch CSV from ${config.vpngateApiUrl}:`, err);
    // Try mirror
    if (config.mirrorUrl) {
      try {
        const mirrorRes = await fetch(config.mirrorUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; AimiliVPN/3.0)" },
          signal: AbortSignal.timeout(12000),
        });
        if (mirrorRes.ok) {
          csvContent = await mirrorRes.text();
        }
      } catch (mirrorErr) {
        console.warn(`[Fetcher] Failed to fetch from mirror ${config.mirrorUrl}:`, mirrorErr);
      }
    }
  }

  // 3. Parse and merge
  const htmlNodes = htmlContent ? parseVpngateHtml(htmlContent) : [];
  const csvNodes = csvContent ? parseVpngateCsv(csvContent) : [];

  let finalNodes = mergeNodes(htmlNodes, csvNodes);

  // Fallback to local mirror file if network completely failed and DB is empty
  if (finalNodes.length === 0) {
    const localDbNodes = getAllNodes();
    if (localDbNodes.length > 0) {
      console.log(`[Fetcher] Using ${localDbNodes.length} nodes from local database cache.`);
      const sslCount = localDbNodes.filter((n) => n.hasSslVpn).length;
      return { count: localDbNodes.length, sslCount };
    }

    const localMirrorPath = path.resolve("./mirror/vpngate.csv");
    if (fs.existsSync(localMirrorPath)) {
      try {
        const fileContent = fs.readFileSync(localMirrorPath, "utf-8");
        finalNodes = parseVpngateCsv(fileContent);
        console.log(`[Fetcher] Loaded ${finalNodes.length} nodes from bundled mirror CSV.`);
      } catch (fErr) {
        console.error("[Fetcher] Error reading bundled mirror CSV:", fErr);
      }
    }
  }

  if (finalNodes.length > 0) {
    saveNodes(finalNodes);
    const sslCount = finalNodes.filter((n) => n.hasSslVpn).length;
    lastSyncTime = Date.now();
    isSyncing = false;
    console.log(`[Fetcher] Successfully updated ${finalNodes.length} nodes (${sslCount} SSL-VPN).`);
    return { count: finalNodes.length, sslCount };
  }

  isSyncing = false;
  syncError = "Failed to fetch nodes from all sources.";
  return { count: 0, sslCount: 0, error: syncError };
}

let cachedPhysicalIface: string | null = null;

export function detectPhysicalInterface(): string {
  if (cachedPhysicalIface) return cachedPhysicalIface;
  if (process.platform !== "linux") {
    cachedPhysicalIface = "eth0";
    return cachedPhysicalIface;
  }
  try {
    const res = Bun.spawnSync(["ip", "route", "show"]);
    const lines = res.stdout.toString().split("\n");
    for (const line of lines) {
      if (line.startsWith("default")) {
        const match = line.match(/dev\s+([^\s]+)/);
        if (match) {
          const dev = match[1];
          if (!dev.startsWith("tun") && !dev.startsWith("tap") && !dev.startsWith("wg") && !dev.startsWith("ppp")) {
            cachedPhysicalIface = dev;
            return dev;
          }
        }
      }
    }
  } catch {}
  cachedPhysicalIface = "eth0";
  return cachedPhysicalIface;
}

interface LibcBinding {
  symbols: {
    socket: (domain: number, type: number, protocol: number) => number;
    setsockopt: (fd: number, level: number, optname: number, optval: unknown, optlen: number) => number;
    connect: (fd: number, addr: unknown, addrlen: number) => number;
    fcntl: (fd: number, cmd: number, arg: number) => number;
    close: (fd: number) => number;
    poll: (fds: unknown, nfds: number, timeout: number) => number;
    getsockopt: (fd: number, level: number, optname: number, optval: unknown, optlen: unknown) => number;
  };
}

let libcInstance: LibcBinding | false | null = null;
function getLibc(): LibcBinding | false {
  if (libcInstance !== null) return libcInstance;
  if (process.platform !== "linux") {
    libcInstance = false;
    return false;
  }
  try {
    const { dlopen, FFIType } = require("bun:ffi");
    libcInstance = dlopen("libc.so.6", {
      socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      setsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      connect: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
      poll: { args: [FFIType.ptr, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
      getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    }) as LibcBinding;
  } catch {
    libcInstance = false;
  }
  return libcInstance;
}

/**
 * Tests direct TCP connection latency to a node's SSL-VPN port.
 * Binds to physical interface (e.g. eth0) to bypass active VPN tunnel (preventing node1 -> node2 detour).
 */
export async function testNodeLatency(ip: string, port: number, timeoutMs = 2500): Promise<number | null> {
  const iface = detectPhysicalInterface();
  const libc = getLibc();

  // On Linux with FFI available, use SO_BINDTODEVICE for zero-detour direct latency test
  if (libc) {
    try {
      const { ptr } = require("bun:ffi");
      const started = performance.now();
      const fd = libc.symbols.socket(2, 1, 0); // AF_INET, SOCK_STREAM
      if (fd >= 0) {
        try {
          if (iface) {
            const devBuf = Buffer.from(iface + "\0");
            libc.symbols.setsockopt(fd, 1, 25, ptr(devBuf), devBuf.length); // SO_BINDTODEVICE
          }
          libc.symbols.fcntl(fd, 4, 2048); // O_NONBLOCK

          const sockaddr = Buffer.alloc(16);
          sockaddr.writeUInt16LE(2, 0); // AF_INET
          sockaddr.writeUInt16BE(port, 2);
          const ipParts = ip.split(".").map(Number);
          sockaddr.writeUInt8(ipParts[0], 4);
          sockaddr.writeUInt8(ipParts[1], 5);
          sockaddr.writeUInt8(ipParts[2], 6);
          sockaddr.writeUInt8(ipParts[3], 7);

          libc.symbols.connect(fd, ptr(sockaddr), 16);

          const pollfd = Buffer.alloc(8);
          pollfd.writeInt32LE(fd, 0);
          pollfd.writeInt16LE(4, 4); // POLLOUT

          const pollRet = libc.symbols.poll(ptr(pollfd), 1, timeoutMs);
          if (pollRet > 0) {
            const errVal = Buffer.alloc(4);
            const errLen = Buffer.alloc(4);
            errLen.writeUInt32LE(4, 0);
            libc.symbols.getsockopt(fd, 1, 4, ptr(errVal), ptr(errLen));
            if (errVal.readInt32LE(0) === 0) {
              return Math.max(1, Math.round(performance.now() - started));
            }
          }
        } finally {
          libc.symbols.close(fd);
        }
      }
    } catch {
      // Fallback below
    }
  }

  // Fallback to standard net.Socket if FFI unavailable
  const { promise, resolve } = Promise.withResolvers<number | null>();
  const started = Date.now();
  const socket = new net.Socket();
  let settled = false;

  const cleanup = (res: number | null) => {
    if (!settled) {
      settled = true;
      socket.destroy();
      resolve(res);
    }
  };

  socket.setTimeout(timeoutMs);
  socket.once("connect", () => cleanup(Math.max(1, Date.now() - started)));
  socket.once("timeout", () => cleanup(null));
  socket.once("error", () => cleanup(null));

  try {
    socket.connect(port, ip);
  } catch {
    cleanup(null);
  }

  return promise;
}
