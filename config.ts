import path from "node:path";
import fs from "node:fs";
import type { AppConfig } from "./types.ts";

function getEnv(key: string, defaultValue: string): string {
  const val = process.env[key];
  return val !== undefined && val.trim() !== "" ? val.trim() : defaultValue;
}

function getEnvInt(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (val !== undefined && val.trim() !== "") {
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return defaultValue;
}

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const val = process.env[key];
  if (val !== undefined && val.trim() !== "") {
    return ["true", "1", "yes", "on"].includes(val.toLowerCase());
  }
  return defaultValue;
}

const dataDir = path.resolve(getEnv("VPNGATE_DATA_DIR", "./data"));
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const config: AppConfig = {
  uiHost: getEnv("UI_HOST", "0.0.0.0"),
  uiPort: getEnvInt("UI_PORT", 8787),
  proxyHost: getEnv("LOCAL_PROXY_HOST", getEnv("PROXY_HOST", "0.0.0.0")),
  proxyPort: getEnvInt("LOCAL_PROXY_PORT", getEnvInt("PROXY_PORT", 1080)),
  proxyUser: process.env.LOCAL_PROXY_USER || process.env.PROXY_USER,
  proxyPass: process.env.LOCAL_PROXY_PASS || process.env.PROXY_PASS,
  dataDir,
  vpngateHtmlUrl: getEnv("VPNGATE_HTML_URL", "https://www.vpngate.net/cn/"),
  vpngateApiUrl: getEnv("VPNGATE_API_URL", "https://www.vpngate.net/api/iphone/"),
  mirrorUrl: getEnv("VPNGATE_MIRROR_URL", "https://baoweise-bot.github.io/aimili-vpngate/vpngate.csv"),
  refreshIntervalMinutes: getEnvInt("REFRESH_INTERVAL_MINUTES", 60),
  autoConnect: getEnvBool("AUTO_CONNECT", false),
  preferredCountry: getEnv("PREFERRED_COUNTRY", "JP"),
  sslVpnOnly: getEnvBool("SSL_VPN_ONLY", false), // Can filter in UI, defaults to showing all with SSL highlighted
};

export const COUNTRY_NAMES: Record<string, string> = {
  JP: "日本",
  KR: "韩国",
  US: "美国",
  GB: "英国",
  RU: "俄罗斯",
  VN: "越南",
  CN: "中国",
  TW: "台湾",
  HK: "香港",
  SG: "新加坡",
  MY: "马来西亚",
  ID: "印度尼西亚",
  IN: "印度",
  TH: "泰国",
  PH: "菲律宾",
  AU: "澳大利亚",
  CA: "加拿大",
  DE: "德国",
  FR: "法国",
  NL: "荷兰",
  SE: "瑞典",
  NO: "挪威",
  ES: "西班牙",
  TR: "土耳其",
  BR: "巴西",
  UA: "乌克兰",
  PL: "波兰",
  RO: "罗马尼亚",
  IT: "意大利",
  CH: "瑞士",
};
