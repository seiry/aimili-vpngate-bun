import net from "node:net";
import { config } from "./config.ts";
import type { ProxyStats } from "./types.ts";

export class ProxyServer {
  private server: net.Server | null = null;
  private auth: { user?: string; pass?: string } | null = null;

  constructor(auth?: { user?: string; pass?: string }) {
    if (auth) {
      this.auth = auth;
    }
  }

  private getAuth(): { user?: string; pass?: string } {
    const rawUser = this.auth?.user ?? config.proxyUser ?? process.env.LOCAL_PROXY_USER ?? process.env.PROXY_USER ?? "";
    const rawPass = this.auth?.pass ?? config.proxyPass ?? process.env.LOCAL_PROXY_PASS ?? process.env.PROXY_PASS ?? "";
    const user = rawUser.trim().length > 0 ? rawUser.trim() : undefined;
    const pass = rawPass.trim().length > 0 ? rawPass.trim() : undefined;
    return { user, pass };
  }
  getStats(): ProxyStats {
    return {
      host: config.proxyHost,
      port: config.proxyPort,
      httpPort: config.proxyPort,
      activeConnections: this.activeConnections,
      totalConnections: this.totalConnections,
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      authEnabled: Boolean(this.getAuth().user && this.getAuth().pass),
    };
  }
  start(port = config.proxyPort, host = config.proxyHost): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();

    this.server = net.createServer((clientSocket) => {
      this.handleIncoming(clientSocket);
    });

    this.server.on("error", (err) => {
      console.error("[Proxy] Server error:", err);
      reject(err);
    });

    this.server.listen(port, host, () => {
      console.log(`[Proxy] SOCKS5 & HTTP Proxy listening on ${host}:${port}`);
      resolve();
    });

    return promise;
  }

  stop(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    if (this.server) {
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    } else {
      resolve();
    }
    return promise;
  }

  private handleIncoming(clientSocket: net.Socket): void {
    this.activeConnections++;
    this.totalConnections++;

    let isClosed = false;
    const cleanup = () => {
      if (!isClosed) {
        isClosed = true;
        this.activeConnections = Math.max(0, this.activeConnections - 1);
      }
    };

    clientSocket.once("close", cleanup);
    clientSocket.once("error", () => {
      cleanup();
      clientSocket.destroy();
    });

    // Peak at first byte to distinguish SOCKS5 (0x05) vs HTTP (CONNECT / GET / etc.)
    clientSocket.once("data", (initialChunk: Buffer) => {
      if (initialChunk.length === 0) {
        clientSocket.end();
        return;
      }

      const firstByte = initialChunk[0];
      if (firstByte === 0x05) {
        // SOCKS5 handshake
        this.handleSocks5(clientSocket, initialChunk);
      } else {
        // HTTP / HTTPS CONNECT proxy
        this.handleHttp(clientSocket, initialChunk);
      }
    });
  }

  /**
   * Handles SOCKS5 protocol (RFC 1928)
   */
  private handleSocks5(clientSocket: net.Socket, initialChunk: Buffer): void {
    const nmethods = initialChunk[1] || 0;
    const methods = initialChunk.subarray(2, 2 + nmethods);
    const { user: authUser, pass: authPass } = this.getAuth();
    const requireAuth = Boolean(authUser && authPass);

    if (requireAuth) {
      if (!methods.includes(0x02)) {
        // Method 0x02 (Username/Password) not offered by client
        clientSocket.write(Buffer.from([0x05, 0xff]));
        clientSocket.end();
        return;
      }
      // Require Username/Password authentication
      clientSocket.write(Buffer.from([0x05, 0x02]));

      clientSocket.once("data", (authChunk: Buffer) => {
        if (authChunk.length < 5 || authChunk[0] !== 0x01) {
          clientSocket.write(Buffer.from([0x01, 0x01])); // Auth failed
          clientSocket.end();
          return;
        }

        const ulen = authChunk[1];
        const user = authChunk.subarray(2, 2 + ulen).toString("utf-8");
        const plen = authChunk[2 + ulen];
        const pass = authChunk.subarray(3 + ulen, 3 + ulen + plen).toString("utf-8");

        if (user !== authUser || pass !== authPass) {
          clientSocket.write(Buffer.from([0x01, 0x01])); // Auth failed
          clientSocket.end();
          return;
        }

        // Auth success
        clientSocket.write(Buffer.from([0x01, 0x00]));
        clientSocket.once("data", (reqChunk: Buffer) => {
          this.handleSocks5Request(clientSocket, reqChunk);
        });
      });
    } else {
      // No auth required
      clientSocket.write(Buffer.from([0x05, 0x00]));
      clientSocket.once("data", (reqChunk: Buffer) => {
        this.handleSocks5Request(clientSocket, reqChunk);
      });
    }
  }

  private handleSocks5Request(clientSocket: net.Socket, reqChunk: Buffer): void {
    if (reqChunk.length < 6 || reqChunk[0] !== 0x05) {
      clientSocket.end();
      return;
    }

    const cmd = reqChunk[1];
    if (cmd !== 0x01) {
      // Only CONNECT supported (BIND 0x02, UDP 0x03 not supported)
      clientSocket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      clientSocket.end();
      return;
    }

    const atyp = reqChunk[3];
    let destHost = "";
    let destPort = 0;
    let offset = 4;

    if (atyp === 0x01) {
      // IPv4
      if (reqChunk.length < 10) return clientSocket.end();
      destHost = `${reqChunk[4]}.${reqChunk[5]}.${reqChunk[6]}.${reqChunk[7]}`;
      destPort = reqChunk.readUInt16BE(8);
    } else if (atyp === 0x03) {
      // Domain name (SOCKS5h)
      const dlen = reqChunk[4];
      if (reqChunk.length < 5 + dlen + 2) return clientSocket.end();
      destHost = reqChunk.subarray(5, 5 + dlen).toString("utf-8");
      destPort = reqChunk.readUInt16BE(5 + dlen);
    } else if (atyp === 0x04) {
      // IPv6
      if (reqChunk.length < 22) return clientSocket.end();
      const parts: string[] = [];
      for (let i = 0; i < 16; i += 2) {
        parts.push(reqChunk.readUInt16BE(4 + i).toString(16));
      }
      destHost = parts.join(":");
      destPort = reqChunk.readUInt16BE(20);
    } else {
      clientSocket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      clientSocket.end();
      return;
    }

    this.pipeOutbound(clientSocket, destHost, destPort, () => {
      // SOCKS5 success reply
      const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
      clientSocket.write(reply);
    });
  }

  /**
   * Handles HTTP / HTTPS CONNECT requests
   */
  private handleHttp(clientSocket: net.Socket, initialChunk: Buffer): void {
    const rawHeader = initialChunk.toString("utf-8");
    const firstLineEnd = rawHeader.indexOf("\r\n");
    if (firstLineEnd === -1) {
      clientSocket.end();
      return;
    }

    const firstLine = rawHeader.substring(0, firstLineEnd);
    const [method, target, httpVersion] = firstLine.split(" ");

    // If client is accessing the Web UI directly on this port (e.g. via Coolify reverse proxy or browser)
    if (method && method.toUpperCase() !== "CONNECT" && target && target.startsWith("/") && !target.startsWith("//")) {
      this.pipeOutbound(clientSocket, "127.0.0.1", config.uiPort, undefined, initialChunk);
      return;
    }

    // Check proxy auth if required (for forward proxy clients)
    const { user: authUser, pass: authPass } = this.getAuth();
    if (authUser && authPass) {
      const authMatch = rawHeader.match(/proxy-authorization:\s*basic\s+([A-Za-z0-9+/=]+)/i);
      if (!authMatch) {
        clientSocket.write(
          "HTTP/1.1 407 Proxy Authentication Required\r\n" +
            'Proxy-Authenticate: Basic realm="AimiliVPN Proxy"\r\n' +
            "Content-Length: 0\r\n\r\n"
        );
        clientSocket.end();
        return;
      }
      const credentials = Buffer.from(authMatch[1], "base64").toString("utf-8");
      const [u, p] = credentials.split(":");
      if (u !== authUser || p !== authPass) {
        clientSocket.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        clientSocket.end();
        return;
      }
    }

    if (method.toUpperCase() === "CONNECT") {
      // HTTPS CONNECT tunnel
      const [destHost, destPortStr] = target.split(":");
      const destPort = parseInt(destPortStr || "443", 10);

      this.pipeOutbound(clientSocket, destHost, destPort, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      });
    } else {
      // Standard HTTP proxy (GET/POST http://host:port/path)
      let destHost = "";
      let destPort = 80;

      try {
        const parsed = new URL(target);
        destHost = parsed.hostname;
        destPort = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === "https:" ? 443 : 80);
      } catch {
        const hostHeader = rawHeader.match(/host:\s*([^\r\n]+)/i);
        if (hostHeader) {
          const [h, p] = hostHeader[1].trim().split(":");
          destHost = h;
          destPort = p ? parseInt(p, 10) : 80;
        }
      }

      if (!destHost) {
        clientSocket.end();
        return;
      }

      this.pipeOutbound(
        clientSocket,
        destHost,
        destPort,
        () => {
          // Connected, now write original initial HTTP request
        },
        initialChunk
      );
    }
  }

  /**
   * Connects to destination host:port and pipes data bidirectionally
   */
  private pipeOutbound(
    clientSocket: net.Socket,
    destHost: string,
    destPort: number,
    onConnected?: () => void,
    initialData?: Buffer
  ): void {
    const targetSocket = net.connect({
      host: destHost,
      port: destPort,
    });

    targetSocket.setTimeout(30000);

    targetSocket.once("connect", () => {
      targetSocket.setTimeout(0);
      if (onConnected) onConnected();
      if (initialData) targetSocket.write(initialData);

      // Bidirectional piping with traffic tracking
      clientSocket.on("data", (chunk) => {
        this.bytesOut += chunk.length;
        if (!targetSocket.destroyed) {
          targetSocket.write(chunk);
        }
      });

      targetSocket.on("data", (chunk) => {
        this.bytesIn += chunk.length;
        if (!clientSocket.destroyed) {
          clientSocket.write(chunk);
        }
      });
    });

    targetSocket.once("timeout", () => {
      targetSocket.destroy();
      clientSocket.destroy();
    });

    targetSocket.once("error", (err) => {
      if (!clientSocket.destroyed) {
        clientSocket.destroy();
      }
    });

    targetSocket.once("close", () => {
      if (!clientSocket.destroyed) {
        clientSocket.end();
      }
    });

    clientSocket.once("close", () => {
      if (!targetSocket.destroyed) {
        targetSocket.end();
      }
    });
  }
}

export const proxyServer = new ProxyServer();
