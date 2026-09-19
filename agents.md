# AimiliVPN Gate (Bun) - 架构、开发与测试规范指南 (agents.md)

本文档面向后续接手本项目的人类工程师与 AI Agent，全面总结了本项目从 Python 架构重构为 Bun + TypeScript 架构的核心设计决策、关键业务逻辑、自动化测试体系、视觉验证流程、真实 Docker 验证规范以及运维排障经验。

---

## 目录
1. [项目背景与技术选型](#1-项目背景与技术选型)
2. [核心架构与关键业务实现](#2-核心架构与关键业务实现)
   - [2.1 为什么采用 SoftEther SSL-VPN](#21-为什么采用-softether-ssl-vpn)
   - [2.2 SOCKS5 & HTTP 双协议单端口自适应代理与 407 避坑](#22-socks5--http-双协议单端口自适应代理与-407-避坑)
   - [2.3 家庭宽带 (Residential) 与机房节点 (Datacenter) 智能分类](#23-家庭宽带-residential-与机房节点-datacenter-智能分类)
   - [2.4 物理网卡防绕路测速 (SO_BINDTODEVICE)](#24-物理网卡防绕路测速-so_bindtodevice)
   - [2.5 首选国家 (PREFERRED_COUNTRY) 全量匹配与智能连接](#25-首选国家-preferred_country-全量匹配与智能连接)
   - [2.6 动态节点同步机制](#26-动态节点同步机制)
3. [现代化 Web 框架与 Vue 3 前端重构](#3-现代化-web-框架与-vue-3-前端重构)
   - [3.1 Hono.js 后端与 Basic Auth 鉴权放行机制](#31-honojs-后端与-basic-auth-鉴权放行机制)
   - [3.2 离线优先 Vue 3 SPA 前端](#32-离线优先-vue-3-spa-前端)
   - [3.3 吸顶控制区与侧边悬浮日志抽屉](#33-吸顶控制区与侧边悬浮日志抽屉)
4. [测试规范与完整验证流程](#4-测试规范与完整验证流程)
   - [4.1 本地单元测试 (bun test)](#41-本地单元测试-bun-test)
   - [4.2 视觉回归验证 (Headless Chromium 截图验收)](#42-视觉回归验证-headless-chromium-截图验收)
   - [4.3 远程 ARM64 真机 Docker 验收规范](#43-远程-arm64-真机-docker-验收规范)
5. [CI/CD 流水线与版本发布规范](#5-cicd-流水线与版本发布规范)
6. [Coolify 生产部署与常见避坑清单](#6-coolify-生产部署与常见避坑清单)

---

## 1. 项目背景与技术选型

- **原版痛点**：原版 Python 单文件（`vpngate_manager.py` 达 7000+ 行），依赖脆弱的子进程、正则解析与生硬的 socket 转发，经常因路由污染导致容器失联或出现 407/401 混淆。
- **全新选型**：
  - **运行时**：[Bun](https://bun.sh/)（原生支持 TypeScript、启动耗时 <50ms、内存占用 <30MB、集成原生 SQLite WAL 模式）。
  - **Web 框架**：[Hono.js](https://hono.dev/)（轻量、标准化中间件、与 Bun 原生 `fetch` 完美兼容）。
  - **前端框架**：[Vue 3](https://vuejs.org/)（声明式数据绑定，彻底替代易产生错位/漏标签的 innerHTML 拼接）。
  - **VPN 底层**：OpenVPN 客户端连接 SoftEther VPN 服务端。
  - **第一优先部署环境**：[Coolify](https://coolify.io/)（Docker Compose 编排，支持 x64 与 arm64 双架构）。

---

## 2. 核心架构与关键业务实现

### 2.1 为什么采用 SoftEther SSL-VPN
VPNGate 是日本筑波大学开发的学术开源项目，所有节点本质上都是 SoftEther VPN Server。
- **协议特性**：SoftEther 原生 SSL-VPN 协议将 VPN 流量完全封装在标准的 **TLS/HTTPS（TCP 443 / 995 端口）** 握手中。
- **穿透优势**：普通的 UDP OpenVPN、L2TP/IPsec 在公共网络、云服务商或高防 VPS 上极易受到 QoS 限制或被防火墙精准丢包；而通过 TCP 443 跑的 SSL-VPN 拥有与访问普通 HTTPS 网站完全一致的网络特征，抗封锁和穿透 NAT 的能力最强。
- **数据提取**：抓取程序同时从 `https://www.vpngate.net/cn/`（提取 SSL-VPN 专有 TCP 端口）与官方 API（提取内嵌客户端证书）合并，默认只提供 SSL-VPN 节点。

### 2.2 SOCKS5 & HTTP 双协议单端口自适应代理与 407 避坑
- **单端口复用**：系统默认只监听 `1080` 端口。接收到连接时，分析初始数据包首字节：
  - `0x05`：进入标准 RFC 1928 SOCKS5 握手流程，支持客户端通过 `socks5h://` 请求由服务端远程解析域名，避免客户端本地 DNS 污染与泄漏。
  - 非 `0x05` 且以 ASCII 字符开头（`CONNECT`, `GET`, `POST` 等）：进入 HTTP 代理与反向分流通道。
- **407 问题的根因与解决**：
  - **踩坑点**：当 Coolify 用户绑定域名并反向代理到容器的 1080 端口时，浏览器访问 `https://domain.com/` 发送的是普通的 `GET / HTTP/1.1`。若代理服务器死板地将所有请求视作前向代理并返回 `407 Proxy Authentication Required`，主流浏览器（Chrome、Safari 等）**绝不会弹出登录窗**（浏览器只有在系统配置了代理客户端时才处理 407，普通网页浏览遇到 407 会直接白屏报错）。
  - **解决方案**：若 HTTP 请求的目标路径是相对路径（`target.startsWith("/")` 且非 `CONNECT`），说明这是人类用户或反向代理在访问 Web 管理面板，程序会**直接在内部透传给 Web UI 引擎**，返回标准的 `401 Unauthorized`（携带 `WWW-Authenticate: Basic realm="AimiliVPN Gate"`），此时浏览器会立即弹出原生的账号密码输入框！
- **免密模式**：当环境变量 `PROXY_USER` 为空或未指定时，代理服务强制设置 `authEnabled = false`，完全免除认证与 407 校验。

### 2.3 家庭宽带 (Residential) 与机房节点 (Datacenter) 智能分类
- **威胁情报归属**：将抓取到的 IP 批量（每批次最多 100 个）提交给情报接口 `http://ip-api.com/batch?lang=zh-CN`。
- **启发式分类规则**：
  - **机房 IP (`datacenter`)**：接口返回 `hosting === true`，或运营商名称/组织名称命中机房关键字正则：
    `/(?:\b(?:cloud|colo|colocation|data[ -]?center|hosting|servers?|vps)\b|softether)/i`
  - **移动蜂窝 (`mobile`)**：接口返回 `mobile === true`。
  - **家庭宽带 (`residential`)**：排除上述特征后，属于普通志愿者家庭光纤网络（如日本 SoftBank / NTT、美国 Metronet / Comcast 等）。
- **默认组策略**：API 与前端界面均**默认以家庭宽带（`ip_type=residential`）作为首屏展示组**，因为家宽节点纯净度极高，极少触发 Cloudflare 验证码或被流媒体识别。
- **持久化缓存**：存入 SQLite 的 `ip_cache` 表，避免频繁查询导致被 API 限频。

### 2.4 物理网卡防绕路测速 (SO_BINDTODEVICE)
- **痛点分析**：当 VPN 连上节点 1（如日本）后，系统默认路由已全部变更为 `tun0`。此时若在面板点击节点 2（如美国）的测速按钮，常规 TCP Socket 连接会先走 `VPS -> 节点1(日本) -> 节点2(美国)`，测出的延迟是绕路叠加后的延迟，完全失真。
- **物理网卡直接绑定**：
  - 自动读取内核路由，剔除 `tun*`, `tap*`, `wg*`, `ppp*`，锁定容器与宿主机的真实物理网卡（如 `eth0`）。
  - 通过 Bun FFI 调用 Linux 底层 `setsockopt(fd, SOL_SOCKET, SO_BINDTODEVICE, "eth0")`。
  - 内核收到该套接字时，强行走 `eth0` 的默认物理网关直接向节点 2 发起 TCP SYN 握手，**完全绕开已激活的 VPN 隧道**，实测出 VPS 直连各节点的真实物理网络延迟。

### 2.5 首选国家 (PREFERRED_COUNTRY) 全量匹配与智能连接
- **标准化输入**：支持 `KR`, `kr`, `韩国`, `South Korea` 等各种输入形式，统一归一化为 ISO 国家代码。
- **全池检索**：移除原版仅检索前 15 个节点的缺陷，遍历全部可用节点池：
  - 第一优先级：首选国家内的 **家庭宽带 SSL-VPN 节点**。
  - 第二优先级：首选国家内的任何 SSL-VPN 节点。
  - 第三优先级：全局最优的家庭宽带 SSL-VPN 节点。
- **UI 联动**：若配置了首选国家，前端下拉框自动默认选中该国家，一键连接按钮自动变成 `⚡ 智能连接最佳韩国家宽节点`。

### 2.6 动态节点同步机制
- 严禁将静态数据写死在镜像中。
- 启动时自动触发后台抓取；后台通过定时器（默认每 30 分钟）自动增量拉取最新节点池。

### 2.7 容器重启自动恢复连接与运行期断线重连 (Auto-Reconnect & Session Recovery)
- **容器重启自动恢复**：
  - 成功连接节点时，在持久化 SQLite `settings` 表记录 `last_connected_node_id` 与 `last_connected_country`，并标记 `auto_reconnect_enabled = true`；
  - 容器或服务重启时，自动检测上一次会话：
    - 若先前节点仍可用：自动静默重新连接该节点；
    - 若先前节点已下线（VPNGate 志愿者节点关机）：自动无缝降级切换到该国家（或 `PREFERRED_COUNTRY`）的最优可用家庭宽带备用节点；
  - **尊重主动断开**：若用户是在面板中主动点击了“断开连接”，系统会自动设置 `auto_reconnect_enabled = false`，重启后绝不强行自动连接违背用户意愿。
- **运行期断线自动看门狗 (Watchdog)**：
  - 若正在连接的 VPN 隧道因网络波动意外中断（非主动断开），后台看门狗在 5 秒内自动重试原节点，若节点失效则自动触发同地区热备节点故障转移。
---

## 3. 现代化 Web 框架与 Vue 3 前端重构

### 3.1 Hono.js 后端与 Basic Auth 鉴权放行机制
- 核心路由由 `src/routes.ts` 中的 Hono 驱动。
- 中间件配置：
  - `cors()` 全局跨域放行。
  - `basicAuth()` 拦截所有页面及数据接口。
  - **重要放行**：对 `/api/health` 显式豁免认证，确保 Coolify 与 Docker 的健康检查指令（Healthcheck）在任何时候均可返回 `HTTP 200`，避免容器被编排引擎误杀。

### 3.2 离线优先 Vue 3 SPA 前端
- 前端源码完全集成在 `public/index.html`，使用 Vue 3 组合式 API (`createApp`, `reactive`, `ref`, `computed`) 编写。
- **离线依赖**：将 Vue 3 生产运行时存放在本地 `public/vue.global.prod.js`，完全不依赖外部 cdnjs / unpkg，在断网、弱网、完全隔离的网络环境中秒级加载。
- **API 凭据安全请求 (`apiFetch`)**：
  - 针对浏览器标准中“带有 URL 用户名密码（`http://user:pass@host/`）时调用 relative fetch 会抛出 `TypeError: Request cannot be constructed from a URL that includes credentials`”的限制；
  - 封装全局 `apiFetch`，自动通过 `window.location.protocol + host` 构建剥离凭据的安全绝对路径，认证由浏览器底层的 Authorization 请求头自发承载。

### 3.3 吸顶控制区与侧边悬浮日志抽屉
- **吸顶控制区 (`.sticky-top-zone`)**：
  - 包含 4 个核心状态卡片、SOCKS5 代理地址与复制栏、家宽/机房 Tab、国家与排序下拉框、搜索栏。
  - 设为 `position: sticky; top: 60px; z-index: 90;`，浏览长达百个节点的表格时，控制台始终保持在视窗顶部，省去反复滚动的繁琐。
- **侧边悬浮抽屉 (`aside.side-log-drawer`)**：
  - 彻底移除了原版占据页面底部大片高度的静态日志块。
  - 右下角常驻悬浮胶囊按钮（带连接状态呼吸灯与日志实时计数）。
  - 点击后从右侧滑出半透明黑色终端窗口，带自动滚屏、一键清空与 ESC 极速关闭能力。

---

## 4. 测试规范与完整验证流程

任何对本项目的改动，**必须**严格遵循以下“三层验证法则”，严禁未经测试盲目交付：

```
┌────────────────────────────────────────────────────────┐
│  第 1 层：本地单元与集成测试 (bun test)                │
└─────────────────────────┬──────────────────────────────┘
                          │ (通过后)
┌─────────────────────────▼──────────────────────────────┐
│  第 2 层：无头浏览器真实渲染与截图验收 (Headless Chrome) │
└─────────────────────────┬──────────────────────────────┘
                          │ (通过后)
┌─────────────────────────▼──────────────────────────────┐
│  第 3 层：远程真机 Docker 环境端到端闭环验证          │
└────────────────────────────────────────────────────────┘
```

### 4.1 本地单元测试 (bun test)
在项目根目录下执行：
```bash
bun test
```
**必须全部通过（12/12 pass）**，涵盖：
- SOCKS5 握手认证与无认证协商。
- SOCKS5 TCP 转发与 Echo 测试。
- HTTP CONNECT 隧道代理建立。
- PROXY_USER 为空时的认证静默关闭。
- 代理端口接收直接 Web 浏览请求的自适应转发。
- Hono 路由健康检查与 Basic Auth 鉴权。
- 节点抓取、合并与家宽默认过滤。
- 首选国家优先级匹配。

### 4.2 视觉回归验证 (Headless Chromium 截图验收)
由于前端涉及吸顶布局与 CSS 样式，**每次修改前端模板后必须通过真实浏览器截屏验证**：
1. 本地启动服务：
   ```bash
   bun run src/index.ts
   ```
2. 使用 Chromium 截取全屏视图（需配置 `--virtual-time-budget` 确保 Vue 数据挂载完成）：
   ```bash
   chromium --headless --no-sandbox --disable-gpu --window-size=1440,900 \
     --virtual-time-budget=4000 \
     --screenshot=screenshot_verify.png \
     "http://admin:admin123@127.0.0.1:8787/"
   ```
3. 使用 Agent 自带的 `read screenshot_verify.png` 指令，视觉核查：
   - 顶部状态卡片是否对齐无溢出。
   - 默认激活的 Tab 是否为 `🏠 ⭐ 精选家宽 (默认)`。
   - 表格 6 列是否严丝合缝（特别检查速度与延时列是否有错位）。
   - 右下角运行日志悬浮胶囊按钮是否可见。

### 4.3 远程 ARM64 真机 Docker 验收规范
用户提供了专用真机测试环境：`seiry@arm2.qun.seiry.eu.org`（Debian 13 aarch64, Docker 29.6）。
每次发布前执行端到端实机验证：

```bash
# 1. 增量打包并同步代码至远程测试机
tar -czf - --exclude=node_modules --exclude=data . | ssh seiry@arm2.qun.seiry.eu.org "tar -xzf -"

# 2. 远程构建与启动
ssh seiry@arm2.qun.seiry.eu.org "
sudo docker build -t aimili-vpngate-bun:test .
sudo docker rm -f aimili-test 2>/dev/null || true
sudo docker run -d --name aimili-test \
  -p 18787:8787 -p 11080:1080 \
  -e UI_USER=admin \
  -e UI_PASS=mysecretpass \
  -e PREFERRED_COUNTRY=KR \
  --dns 1.1.1.1 --dns 8.8.8.8 \
  --cap-add NET_ADMIN --device /dev/net/tun:/dev/net/tun \
  aimili-vpngate-bun:test
"

# 3. 验收清单
# A. 健康检查
curl -s http://127.0.0.1:18787/api/health # 必须返回 {"status":"ok"}

# B. 鉴权验证
curl -s -i http://127.0.0.1:18787/        # 必须返回 401 Unauthorized
curl -s -i http://127.0.0.1:11080/        # 必须返回 401 Unauthorized (绝不能是 407!)

# C. 节点默认分类验证
curl -s -u admin:mysecretpass http://127.0.0.1:18787/api/nodes | jq '.sampleIpTypes[0].type'
# 必须为 "家庭宽带"

# D. 智能连接与出口验证
curl -s -u admin:mysecretpass -X POST http://127.0.0.1:18787/api/smart-connect
# 必须返回连接到韩国（KR）节点

# E. 代理真实出口穿透验证
curl -s --max-time 15 --proxy socks5h://127.0.0.1:11080 https://api.ipify.org
# 返回的 IP 必须与上述韩国节点 IP 完全一致！
```

---

## 5. CI/CD 流水线与版本发布规范

- **流水线定义**：`.github/workflows/docker-publish.yml`
- **代码仓库**：`seiry/aimili-vpngate-bun`
- **镜像仓库**：`ghcr.io/seiry/aimili-vpngate-bun`
- **版本号规范**：
  每次提交或触发时，流水线会自动提取北京时间时间戳，格式严格为：
  `YYYY-M-D-HHmm`（例如 `2026-9-19-2238`，后四位为时分），并同时推送 `:latest`、`:main`、`:sha-xxxxxxx`。
- **缓存策略**：
  - 构建阶段使用 `cache-from: type=gha,scope=aimili-multiarch`，并利用 Dockerfile 中的 `--mount=type=cache` 挂载 APT 与 Bun 依赖，将多架构交叉编译耗时从 3 分钟压进 45 秒内。

---

## 6. Coolify 生产部署与常见避坑清单

### Coolify 推荐配置（一键 Docker Compose）
在 Coolify 新建项目 -> 选择 Docker Compose，直接粘贴：

```yaml
services:
  aimili-vpngate:
    image: ghcr.io/seiry/aimili-vpngate-bun:latest
    container_name: aimili-vpngate-bun
    restart: unless-stopped
    cap_add:
      - NET_ADMIN
    dns:
      - 1.1.1.1
      - 8.8.8.8
    devices:
      - /dev/net/tun:/dev/net/tun
    ports:
      - "${PROXY_TARGET:-127.0.0.1:1080}:1080"
    environment:
      - SERVICE_FQDN_AIMILI_VPNGATE_8787
      - UI_HOST=0.0.0.0
      - UI_PORT=8787
      - UI_USER=${UI_USER:-admin}
      - UI_PASS=${UI_PASS:-}
      - PROXY_HOST=0.0.0.0
      - PROXY_PORT=1080
      - PROXY_USER=${PROXY_USER:-}
      - PROXY_PASS=${PROXY_PASS:-}
      - SSL_VPN_ONLY=${SSL_VPN_ONLY:-true}
      - AUTO_CONNECT=${AUTO_CONNECT:-false}
      - PREFERRED_COUNTRY=${PREFERRED_COUNTRY:-JP}
      - PROXY_TARGET=${PROXY_TARGET:-127.0.0.1:1080}
    volumes:
      - vpngate-data:/data

volumes:
  vpngate-data:
```

### 避坑重点
1. **不要手动向 `ports:` 添加 `8787:8787`**：
   - Coolify 会根据 `SERVICE_FQDN_AIMILI_VPNGATE_8787` 自动为内部的 8787 端口建立 Traefik HTTPS 域名代理。宿主机只需把 `1080` 端口映射出来给其他代理客户端使用。
2. **容器必须授予 `NET_ADMIN` 与 `/dev/net/tun`**：
   - 否则 OpenVPN 无法创建 `tun0` 网卡。
3. **公共 DNS 必须设置**：
   - 云厂商（如 Oracle Cloud 等）默认会把 `/etc/resolv.conf` 指向内部的链路本地地址（如 `169.254.169.254`）。当 VPN 建立且默认路由接管后，该内网 DNS 立即失联。Compose 文件中配置 `dns: [1.1.1.1, 8.8.8.8]` 能彻底规避该断网现象。
4. **路由保护机制**：
   - `vpn.ts` 在连接前会自动为 `172.16.0.0/12` 和 `192.168.0.0/16` 添加经由 `eth0` 网关的路由。**严禁**盲目添加 `10.0.0.0/8` 到 `eth0`，因为大部分 VPNGate 节点分配给 `tun0` 的内网 IP 正好处于 `10.x.x.x` 网段，会引起路由冲突导致连接假死。
