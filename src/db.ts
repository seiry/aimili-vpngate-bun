import { Database } from "bun:sqlite";
import path from "node:path";
import { config } from "./config.ts";
import type { VpnNode } from "./types.ts";

const dbPath = path.join(config.dataDir, "vpngate.db");
export const db = new Database(dbPath);

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    host_name TEXT,
    ip TEXT,
    score INTEGER,
    ping INTEGER,
    speed INTEGER,
    speed_formatted TEXT,
    country_long TEXT,
    country_short TEXT,
    country_zh TEXT,
    num_vpn_sessions INTEGER,
    uptime INTEGER,
    total_users INTEGER,
    total_traffic INTEGER,
    operator TEXT,
    message TEXT,
    has_ssl_vpn INTEGER,
    ssl_vpn_port INTEGER,
    ssl_vpn_proto TEXT,
    openvpn_config_base64 TEXT,
    openvpn_proto TEXT,
    openvpn_port INTEGER,
    openvpn_link TEXT,
    latency_ms INTEGER,
    last_tested_at INTEGER,
    last_updated INTEGER,
    ip_type TEXT,
    ip_type_zh TEXT,
    isp TEXT,
    city TEXT
  );

  CREATE TABLE IF NOT EXISTS ip_cache (
    ip TEXT PRIMARY KEY,
    ip_type TEXT,
    ip_type_zh TEXT,
    isp TEXT,
    city TEXT,
    cached_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS connection_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT,
    node_ip TEXT,
    country TEXT,
    connected_at INTEGER,
    disconnected_at INTEGER,
    egress_ip TEXT,
    duration_seconds INTEGER,
    bytes_in INTEGER,
    bytes_out INTEGER,
    status TEXT
  );
`);

// Auto-migrate columns if table already existed without them
try { db.exec("ALTER TABLE nodes ADD COLUMN ip_type TEXT;"); } catch {}
try { db.exec("ALTER TABLE nodes ADD COLUMN ip_type_zh TEXT;"); } catch {}
try { db.exec("ALTER TABLE nodes ADD COLUMN isp TEXT;"); } catch {}
try { db.exec("ALTER TABLE nodes ADD COLUMN city TEXT;"); } catch {}

export interface IpClassification {
  ip: string;
  ipType: "residential" | "datacenter" | "mobile" | "unknown";
  ipTypeZh: string;
  isp: string;
  city: string;
}

interface NodeDbRow {
  id: string;
  host_name: string;
  ip: string;
  score: number;
  ping: number;
  speed: number;
  speed_formatted: string;
  country_long: string;
  country_short: string;
  country_zh: string;
  num_vpn_sessions: number;
  uptime: number;
  total_users: number;
  total_traffic: number;
  operator: string;
  message: string;
  has_ssl_vpn: number;
  ssl_vpn_port: number;
  ssl_vpn_proto: "tcp" | "udp";
  openvpn_config_base64: string | null;
  openvpn_proto: "tcp" | "udp";
  openvpn_port: number;
  openvpn_link: string | null;
  latency_ms: number | null;
  last_tested_at: number | null;
  last_updated: number;
  ip_type: "residential" | "datacenter" | "mobile" | "unknown" | null;
  ip_type_zh: string | null;
  isp: string | null;
  city: string | null;
}

const insertNodeStmt = db.prepare(`
  INSERT OR REPLACE INTO nodes (
    id, host_name, ip, score, ping, speed, speed_formatted,
    country_long, country_short, country_zh, num_vpn_sessions, uptime,
    total_users, total_traffic, operator, message,
    has_ssl_vpn, ssl_vpn_port, ssl_vpn_proto,
    openvpn_config_base64, openvpn_proto, openvpn_port, openvpn_link,
    latency_ms, last_tested_at, last_updated,
    ip_type, ip_type_zh, isp, city
  ) VALUES (
    $id, $host_name, $ip, $score, $ping, $speed, $speed_formatted,
    $country_long, $country_short, $country_zh, $num_vpn_sessions, $uptime,
    $total_users, $total_traffic, $operator, $message,
    $has_ssl_vpn, $ssl_vpn_port, $ssl_vpn_proto,
    $openvpn_config_base64, $openvpn_proto, $openvpn_port, $openvpn_link,
    $latency_ms, $last_tested_at, $last_updated,
    $ip_type, $ip_type_zh, $isp, $city
  )
`);

export function saveNodes(nodes: VpnNode[]): void {
  const transaction = db.transaction((items: VpnNode[]) => {
    for (const node of items) {
      insertNodeStmt.run({
        $id: node.id,
        $host_name: node.hostName,
        $ip: node.ip,
        $score: node.score,
        $ping: node.ping,
        $speed: node.speed,
        $speed_formatted: node.speedFormatted,
        $country_long: node.countryLong,
        $country_short: node.countryShort,
        $country_zh: node.countryZh,
        $num_vpn_sessions: node.numVpnSessions,
        $uptime: node.uptime,
        $total_users: node.totalUsers,
        $total_traffic: node.totalTraffic,
        $operator: node.operator,
        $message: node.message,
        $has_ssl_vpn: node.hasSslVpn ? 1 : 0,
        $ssl_vpn_port: node.sslVpnPort,
        $ssl_vpn_proto: node.sslVpnProto,
        $openvpn_config_base64: node.openVpnConfigBase64 || null,
        $openvpn_proto: node.openVpnProto,
        $openvpn_port: node.openVpnPort,
        $openvpn_link: node.openVpnLink || null,
        $latency_ms: node.latencyMs,
        $last_tested_at: node.lastTestedAt || null,
        $last_updated: node.lastUpdated,
        $ip_type: node.ipType || null,
        $ip_type_zh: node.ipTypeZh || null,
        $isp: node.isp || null,
        $city: node.city || null,
      });
    }
  });
  transaction(nodes);
}

function rowToNode(r: NodeDbRow): VpnNode {
  return {
    id: r.id,
    hostName: r.host_name,
    ip: r.ip,
    score: r.score,
    ping: r.ping,
    speed: r.speed,
    speedFormatted: r.speed_formatted,
    countryLong: r.country_long,
    countryShort: r.country_short,
    countryZh: r.country_zh,
    numVpnSessions: r.num_vpn_sessions,
    uptime: r.uptime,
    totalUsers: r.total_users,
    totalTraffic: r.total_traffic,
    operator: r.operator,
    message: r.message,
    hasSslVpn: r.has_ssl_vpn === 1,
    sslVpnPort: r.ssl_vpn_port,
    sslVpnProto: r.ssl_vpn_proto,
    openVpnConfigBase64: r.openvpn_config_base64 || undefined,
    openVpnProto: r.openvpn_proto,
    openVpnPort: r.openvpn_port,
    openVpnLink: r.openvpn_link || undefined,
    latencyMs: r.latency_ms,
    lastTestedAt: r.last_tested_at || undefined,
    lastUpdated: r.last_updated,
    ipType: r.ip_type || undefined,
    ipTypeZh: r.ip_type_zh || undefined,
    isp: r.isp || undefined,
    city: r.city || undefined,
  };
}

export function getAllNodes(filterSslOnly = false): VpnNode[] {
  const sql = filterSslOnly
    ? "SELECT * FROM nodes WHERE has_ssl_vpn = 1 ORDER BY score DESC"
    : "SELECT * FROM nodes ORDER BY score DESC";
  const rows = db.query(sql).all() as NodeDbRow[];
  return rows.map(rowToNode);
}

export function getNodeById(id: string): VpnNode | null {
  const r = db.query("SELECT * FROM nodes WHERE id = ?").get(id) as NodeDbRow | null;
  if (!r) return null;
  return rowToNode(r);
}

export function updateNodeLatency(id: string, latencyMs: number | null): void {
  db.run("UPDATE nodes SET latency_ms = ?, last_tested_at = ? WHERE id = ?", [
    latencyMs,
    Date.now(),
    id,
  ]);
}

export function getCachedIpMap(): Map<string, IpClassification> {
  const rows = db.query("SELECT * FROM ip_cache").all() as Array<{
    ip: string;
    ip_type: "residential" | "datacenter" | "mobile" | "unknown";
    ip_type_zh: string;
    isp: string;
    city: string;
  }>;
  const map = new Map<string, IpClassification>();
  for (const r of rows) {
    map.set(r.ip, {
      ip: r.ip,
      ipType: r.ip_type,
      ipTypeZh: r.ip_type_zh,
      isp: r.isp,
      city: r.city,
    });
  }
  return map;
}

export function saveIpClassifications(entries: IpClassification[]): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO ip_cache (ip, ip_type, ip_type_zh, isp, city, cached_at)
    VALUES ($ip, $ip_type, $ip_type_zh, $isp, $city, $cached_at)
  `);
  const now = Date.now();
  const tx = db.transaction((items: IpClassification[]) => {
    for (const item of items) {
      stmt.run({
        $ip: item.ip,
        $ip_type: item.ipType,
        $ip_type_zh: item.ipTypeZh,
        $isp: item.isp,
        $city: item.city,
        $cached_at: now,
      });
    }
  });
  tx(entries);
}

export function getSetting(key: string, defaultVal = ""): string {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  return row ? row.value : defaultVal;
}

export function setSetting(key: string, value: string): void {
  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, value]);
}
export function saveLastConnected(node: VpnNode): void {
  setSetting("last_connected_node_id", node.id);
  setSetting("last_connected_country", node.countryShort);
  setSetting("last_connected_time", String(Date.now()));
  setSetting("auto_reconnect_enabled", "true");
}

export function clearLastConnected(): void {
  setSetting("auto_reconnect_enabled", "false");
  setSetting("last_connected_node_id", "");
}

export function getLastConnectedInfo(): { nodeId: string; country: string; enabled: boolean } {
  const nodeId = getSetting("last_connected_node_id", "");
  const country = getSetting("last_connected_country", "");
  const enabled = getSetting("auto_reconnect_enabled", "true") === "true";
  return { nodeId, country, enabled: Boolean(enabled && nodeId) };
}
