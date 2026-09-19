export interface VpnNode {
  id: string;
  hostName: string;
  ip: string;
  score: number;
  ping: number; // Reported ping ms
  speed: number; // Bandwidth in bps
  speedFormatted: string; // e.g. "497.5 Mbps"
  countryLong: string;
  countryShort: string;
  countryZh: string;
  numVpnSessions: number;
  uptime: number; // Seconds
  totalUsers: number;
  totalTraffic: number; // Bytes
  operator: string;
  message: string;
  // SSL-VPN specifics
  hasSslVpn: boolean;
  sslVpnPort: number; // Default 443 if supported
  sslVpnProto: "tcp" | "udp";
  // OpenVPN specifics
  openVpnConfigBase64?: string;
  openVpnProto: "tcp" | "udp";
  openVpnPort: number;
  openVpnLink?: string;
  // Realtime test data
  latencyMs: number | null;
  lastTestedAt?: number;
  lastUpdated: number;
  // IP Classification (Residential vs Datacenter)
  ipType?: "residential" | "datacenter" | "mobile" | "unknown";
  ipTypeZh?: string;
  isp?: string;
  city?: string;
}

export type ConnectionState = "disconnected" | "connecting" | "connected" | "disconnecting" | "error";

export interface VpnStatus {
  state: ConnectionState;
  activeNode: VpnNode | null;
  connectedAt: number | null;
  uptimeSeconds: number;
  egressIp: string | null;
  egressCountry: string | null;
  egressCountryCode: string | null;
  egressIsp: string | null;
  bytesIn: number;
  bytesOut: number;
  activeClients: number;
  lastError: string | null;
}

export interface ProxyStats {
  host: string;
  port: number;
  httpPort: number;
  activeConnections: number;
  totalConnections: number;
  bytesIn: number;
  bytesOut: number;
  authEnabled: boolean;
}

export interface AppConfig {
  uiHost: string;
  uiPort: number;
  uiUser?: string;
  uiPass?: string;
  uiAuthEnabled?: boolean;
  proxyPort: number;
  proxyUser?: string;
  proxyPass?: string;
  dataDir: string;
  vpngateHtmlUrl: string;
  vpngateApiUrl: string;
  mirrorUrl?: string;
  refreshIntervalMinutes: number;
  autoConnect: boolean;
  preferredCountry: string;
  sslVpnOnly: boolean;
}
