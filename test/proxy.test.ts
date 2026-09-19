import { test, expect, beforeAll, afterAll } from "bun:test";
import net from "node:net";
import http from "node:http";
import { ProxyServer } from "../src/proxy.ts";

let echoServer: net.Server;
let echoPort = 0;
let proxy: ProxyServer;
let proxyPort = 19080;

beforeAll(async () => {
  // 1. Start echo server
  const { promise, resolve } = Promise.withResolvers<void>();
  echoServer = net.createServer((socket) => {
    socket.pipe(socket); // echo back
  });
  echoServer.listen(0, "127.0.0.1", () => {
    echoPort = (echoServer.address() as net.AddressInfo).port;
    resolve();
  });
  proxy = new ProxyServer();
  await proxy.start(proxyPort, "127.0.0.1");
});

afterAll(async () => {
  await proxy.stop();
  echoServer.close();
});

test("SOCKS5 CONNECT and echo", async () => {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const client = net.connect({ host: "127.0.0.1", port: proxyPort });

  client.once("connect", () => {
    // SOCKS5 greeting: VER=5, NMETHODS=1, METHOD=0 (No auth)
    client.write(Buffer.from([0x05, 0x01, 0x00]));
  });

  let step = 0;
  client.on("data", (data) => {
    if (step === 0) {
      // Expect greeting response: 0x05, 0x00
      expect(data[0]).toBe(0x05);
      expect(data[1]).toBe(0x00);
      step = 1;

      // SOCKS5 request: VER=5, CMD=1 (CONNECT), RSV=0, ATYP=1 (IPv4), DST.ADDR=127.0.0.1, DST.PORT=echoPort
      const req = Buffer.alloc(10);
      req[0] = 0x05;
      req[1] = 0x01;
      req[2] = 0x00;
      req[3] = 0x01;
      req[4] = 127;
      req[5] = 0;
      req[6] = 0;
      req[7] = 1;
      req.writeUInt16BE(echoPort, 8);
      client.write(req);
    } else if (step === 1) {
      // Expect connect response: 0x05, 0x00 (success)
      expect(data[0]).toBe(0x05);
      expect(data[1]).toBe(0x00);
      step = 2;

      // Send payload to echo server through tunnel
      client.write("HELLO_AIMILI_SOCKS5\n");
    } else if (step === 2) {
      const text = data.toString();
      expect(text).toContain("HELLO_AIMILI_SOCKS5");
      client.end();
      resolve();
    }
  });

  client.on("error", reject);
  await promise;
});

test("HTTP CONNECT tunneling", async () => {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const client = net.connect({ host: "127.0.0.1", port: proxyPort });

  client.once("connect", () => {
    client.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`);
  });

  let established = false;
  client.on("data", (data) => {
    const str = data.toString();
    if (!established) {
      expect(str).toContain("200 Connection Established");
      established = true;
      client.write("HELLO_HTTP_CONNECT\n");
    } else {
      expect(str).toContain("HELLO_HTTP_CONNECT");
      client.end();
      resolve();
    }
  });
  await promise;
});
test("SOCKS5 Username/Password authentication", async () => {
  const authPort = 19081;
  const authProxy = new ProxyServer({ user: "aimili", pass: "secret123" });
  await authProxy.start(authPort, "127.0.0.1");

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const client = net.connect({ host: "127.0.0.1", port: authPort });

  client.once("connect", () => {
    // Offer methods: 0x00 (No auth) and 0x02 (User/Pass)
    client.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
  });

  let step = 0;
  client.on("data", (data) => {
    if (step === 0) {
      // Server selects 0x02 (User/Pass)
      expect(data[0]).toBe(0x05);
      expect(data[1]).toBe(0x02);
      step = 1;

      // Send credentials: ver 1, ulen 6 "aimili", plen 9 "secret123"
      const u = Buffer.from("aimili");
      const p = Buffer.from("secret123");
      const authPacket = Buffer.concat([
        Buffer.from([0x01, u.length]),
        u,
        Buffer.from([p.length]),
        p,
      ]);
      client.write(authPacket);
    } else if (step === 1) {
      // Auth success: 0x01, 0x00
      expect(data[0]).toBe(0x01);
      expect(data[1]).toBe(0x00);
      client.end();
      authProxy.stop().then(() => resolve());
    }
  });

  client.on("error", reject);
  await promise;
});
