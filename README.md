# AimiliVPN Gate (Bun) 🚀

> **VPNGate SSL-VPN 节点管理与 SOCKS5 / HTTP 代理网关**  
> 基于 **Node.js / Bun** 高性能运行时重写，专为 **Docker** 和 **Coolify** 一键部署优化。

---

## 🌟 核心特性与技术架构

- ⚡ **高性能运行时 (Bun)**：冷启动 <100ms，内存占用极低，原生集成 SQLite WAL 高并发存储与原生 WebSocket / HTTP 性能。
- 🔒 **精选 SSL-VPN (SoftEther / TCP 443)**：
  - 自动从 `https://www.vpngate.net/cn/` 筛选支持 **SSL-VPN** (TCP 443 / 995 等端口) 的优质节点。
  - SSL-VPN 协议将 VPN 流量完全伪装为标准 HTTPS / SSL 握手，有效穿透 NAT 和封锁。
- 🔀 **SOCKS5 & HTTP 双协议出口**：
  - 标准 RFC 1928 SOCKS5 代理（支持远程 DNS 解析 `socks5h://`，杜绝 DNS 泄漏）。
  - 同一端口自适应支持 HTTP / HTTPS `CONNECT` 隧道代理。
  - 支持可选账号密码认证 (`PROXY_USER` / `PROXY_PASS`)。
- 🛡️ **容器隔离路由保护**：
  - 接入 VPN 隧道后，通过 Linux 路由表自动保留 Docker 内部网段 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)。
  - 宿主机反向代理、Coolify 管理后台、局域网访问永不失联。
- 📊 **现代化暗色仪表盘 (Web UI)**：
  - 极速响应原生 SPA，无臃肿框架依赖。
  - 实时显示当前出口 IP、真实地理位置与 ISP、活跃连接数与吞吐流量。
  - 节点按延时、速率、国家一键筛选，支持实时 TCP 握手延时测速与智能优选连接。
  - 一键复制 SOCKS5 代理地址与常用客户端配置（cURL、Shell、Python）。

---

## 🚀 Coolify 一键部署指南

本项目作为 Coolify 第一优先支持的部署目标，配置极其简单：

1. **在 Coolify 中新建应用**：
   - 选择 **Source** -> **Git Repository**。
   - 输入您的代码仓库地址，或选择 **Docker Compose** 部署。
2. **构建与配置**：
   - 如果使用 Git 仓库源码部署：将 **Base Directory** 设为 `aimili-vpngate-bun`。
   - 打开 **Advanced** 页面：
     - 添加 Capability：`NET_ADMIN`
     - 添加 Device 映射：`/dev/net/tun:/dev/net/tun`
3. **端口暴露**：
   - **Web UI 管理后台**：暴露 `8787` 端口（绑定域名即可直接通过 HTTPS 访问 Web 面板）。
   - **SOCKS5 / HTTP 代理端口**：暴露 `1080` 端口（供外部客户端连接）。
4. **环境变量（可选）**：
   - `PREFERRED_COUNTRY=JP`：首选连接国家代码（例如 `JP`, `KR`, `US`）。
   - `AUTO_CONNECT=true`：容器启动后是否自动选择最佳节点建立连接。
   - `PROXY_USER` / `PROXY_PASS`：代理账号密码（留空则免密）。
5. 点击 **Deploy**，等待部署完成即可通过域名访问现代化面板！

---

## 🐳 Docker Compose 本地或 VPS 部署

```bash
cd aimili-vpngate-bun

# 启动服务
docker compose up -d

# 查看运行日志
docker compose logs -f
```

容器启动后：
- 打开浏览器访问 Web 管理后台：`http://YOUR_SERVER_IP:8787`
- SOCKS5 / HTTP 代理地址：`socks5://YOUR_SERVER_IP:1080`

---

## 🛠️ 客户端连接与调用示例

当在 Web 面板中选中节点并建立连接后，代理端口即可对外提供全局出口：

### 1. cURL 命令行
```bash
# 通过 SOCKS5 代理（远程 DNS 解析）查询当前出口 IP
curl --proxy socks5h://127.0.0.1:1080 https://api.ipify.org

# 通过 HTTP 代理方式访问
curl -x http://127.0.0.1:1080 https://api.ipify.org
```

### 2. Linux Shell 环境变量
```bash
export all_proxy="socks5://127.0.0.1:1080"
export http_proxy="http://127.0.0.1:1080"
export https_proxy="http://127.0.0.1:1080"
```

### 3. Python requests
```python
import requests

proxies = {
    'http': 'socks5h://127.0.0.1:1080',
    'https': 'socks5h://127.0.0.1:1080',
}
response = requests.get('https://api.ipify.org', proxies=proxies, timeout=10)
print('当前出口 IP:', response.text)
```

---

## ⚙️ 环境变量速查表

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `UI_HOST` | `0.0.0.0` | Web 后台监听地址 |
| `UI_PORT` | `8787` | Web 后台端口 |
| `PROXY_HOST` | `0.0.0.0` | SOCKS5 / HTTP 代理监听地址 |
| `PROXY_PORT` | `1080` | SOCKS5 / HTTP 代理端口 |
| `PROXY_USER` | `""` | 代理认证账号（留空为免密） |
| `PROXY_PASS` | `""` | 代理认证密码（留空为免密） |
| `AUTO_CONNECT` | `false` | 是否在启动后自动连接优选节点 |
| `PREFERRED_COUNTRY` | `JP` | 智能优选连接的首选国家 (`JP`, `KR`, `US` 等) |
| `SSL_VPN_ONLY` | `true` | 是否仅筛选 SSL-VPN 协议节点 |
| `VPNGATE_DATA_DIR` | `/data` | 持久化数据目录 (SQLite 数据库等) |
| `REFRESH_INTERVAL_MINUTES` | `60` | 节点列表自动更新间隔（分钟） |

---

## 📡 REST API 接口规范

- `GET /api/status`：获取当前 VPN 状态、出口真实 IP、地区及代理流量统计。
- `GET /api/nodes?ssl_only=true&country=JP`：查询可用节点列表（支持按协议、国家筛选与排序）。
- `POST /api/nodes/:id/connect`：连接指定 ID 的 VPNGate 节点。
- `POST /api/nodes/:id/test`：测试从当前服务端到该节点的 TCP 握手延时。
- `POST /api/nodes/refresh`：从 VPNGate 官方源或镜像源抓取最新节点池。
- `POST /api/disconnect`：断开当前 VPN 连接。
- `POST /api/smart-connect`：自动匹配评分最高、延时最低的节点并建立连接。
- `GET /api/export`：获取当前代理配置链接与多种编程语言调用代码。
- `GET /api/health`：健康检查接口（HTTP 200 OK）。
