FROM oven/bun:1-debian

LABEL maintainer="Seiry" \
      description="VPNGate SSL-VPN to SOCKS5 Gateway powered by Bun"

# Install OpenVPN, routing utilities and ca-certificates with BuildKit cache
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        iproute2 \
        iptables \
        iputils-ping \
        openvpn \
        procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency files and install production dependencies with Bun cache
COPY package.json tsconfig.json bun.lock* ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --production

# Copy source code and frontend assets
COPY src ./src
COPY public ./public

# Build argument for image version
ARG IMAGE_VERSION=dev

# Default environment configuration
ENV NODE_ENV=production \
    APP_VERSION=${IMAGE_VERSION} \
    VPNGATE_DATA_DIR=/data \
    UI_HOST=0.0.0.0 \
    UI_PORT=8787 \
    PROXY_HOST=0.0.0.0 \
    PROXY_PORT=1080 \
    SSL_VPN_ONLY=true \
    AUTO_CONNECT=false \
    PREFERRED_COUNTRY=JP

RUN mkdir -p /data

VOLUME ["/data"]

EXPOSE ${UI_PORT}/tcp ${PROXY_PORT}/tcp

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fs http://127.0.0.1:${UI_PORT:-8787}/api/health || exit 1

CMD ["bun", "run", "src/index.ts"]
