FROM oven/bun:1-debian

LABEL maintainer="AimiliVPN" \
      description="VPNGate SSL-VPN to SOCKS5 Gateway powered by Bun"

# Install OpenVPN, routing utilities and ca-certificates
RUN apt-get update \
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

# Copy dependency files and install production dependencies
COPY package.json tsconfig.json ./
RUN bun install --production

# Copy source code, frontend assets and bundled mirror
COPY src ./src
COPY public ./public
COPY mirror ./mirror

# Default environment configuration
ENV NODE_ENV=production \
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

EXPOSE 8787/tcp 1080/tcp

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fs http://127.0.0.1:8787/api/health || exit 1

CMD ["bun", "run", "src/index.ts"]
