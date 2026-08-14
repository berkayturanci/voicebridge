"use strict";
process.env.STT_MODE = "whisper-stream";
const upstreamPort = 19000 + (process.pid % 10000);
process.env.STT_STREAM_URL = "ws://127.0.0.1:" + upstreamPort + "/listen";

const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const crypto = require("node:crypto");
const { installStubAgents, request } = require("./helpers");

installStubAgents();
const srv = require("../server.js");

function decodeOne(buf, masked) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  let len = buf[1] & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  if (masked) { if (buf.length < off + 4) return null; }
  const key = masked ? buf.subarray(off, off + 4) : null;
  if (masked) off += 4;
  if (buf.length < off + len) return null;
  let payload = buf.subarray(off, off + len);
  if (masked) {
    const out = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ key[i % 4];
    payload = out;
  }
  return { opcode, payload, rest: buf.subarray(off + len) };
}

function makeWsServer(onFrame) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let head = Buffer.alloc(0), framed = false, frameBuf = Buffer.alloc(0);
    socket.on("data", (d) => {
      if (!framed) {
        head = Buffer.concat([head, d]);
        const idx = head.indexOf("\r\n\r\n");
        if (idx < 0) return;
        const text = head.subarray(0, idx).toString("utf8");
        const key = /sec-websocket-key:\s*(.+)\r?$/im.exec(text)[1].trim();
        socket.write([
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Accept: " + srv._internals.wsAcceptKey(key),
          "\r\n",
        ].join("\r\n"));
        framed = true;
        frameBuf = head.subarray(idx + 4);
      } else {
        frameBuf = Buffer.concat([frameBuf, d]);
      }
      let frame;
      while ((frame = decodeOne(frameBuf, true))) {
        frameBuf = frame.rest;
        if (frame.opcode === 8) { socket.end(); continue; }
        onFrame(socket, frame);
      }
    });
  });
  server.destroySockets = () => { for (const s of sockets) s.destroy(); };
  return server;
}

const clientSockets = new Set();
function wsClient(port, pathName) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    clientSockets.add(socket);
    socket.on("close", () => clientSockets.delete(socket));
    const key = crypto.randomBytes(16).toString("base64");
    let head = Buffer.alloc(0), frameBuf = Buffer.alloc(0), ready = false;
    const api = {
      messages: [],
      sendText: (s) => socket.write(srv._internals.wsEncode(s, { opcode: 1, mask: true })),
      sendBinary: (b) => socket.write(srv._internals.wsEncode(Buffer.from(b), { opcode: 2, mask: true })),
      close: () => socket.destroy(),
    };
    socket.on("connect", () => socket.write([
      `GET ${pathName} HTTP/1.1`,
      "Host: 127.0.0.1:" + port,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: " + key,
      "Sec-WebSocket-Version: 13",
      "\r\n",
    ].join("\r\n")));
    socket.on("data", (d) => {
      if (!ready) {
        head = Buffer.concat([head, d]);
        const idx = head.indexOf("\r\n\r\n");
        if (idx < 0) return;
        assert.match(head.subarray(0, idx).toString("utf8"), /^HTTP\/1\.1 101/m);
        ready = true;
        frameBuf = head.subarray(idx + 4);
        resolve(api);
      } else {
        frameBuf = Buffer.concat([frameBuf, d]);
      }
      let frame;
      while ((frame = decodeOne(frameBuf, false))) {
        frameBuf = frame.rest;
        if (frame.opcode === 1) api.messages.push(frame.payload.toString("utf8"));
      }
    });
    socket.on("error", reject);
  });
}

function waitForMessage(client, re) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (client.messages.some((m) => re.test(m))) return resolve();
      if (Date.now() - start > 1000) return reject(new Error("timed out waiting for " + re));
      setTimeout(tick, 20);
    };
    tick();
  });
}

const upstream = makeWsServer((socket, frame) => {
  if (frame.opcode === 2) {
    socket.write(srv._internals.wsEncode(JSON.stringify({ type: "partial", text: "hello" }), { opcode: 1 }));
    socket.write(srv._internals.wsEncode(JSON.stringify({ type: "final", text: "hello world" }), { opcode: 1 }));
  }
});
const boot = srv.createSession({ name: "default", agent: "claude", projectDir: process.cwd() });
srv.defaultSessionId = boot.id;
const server = srv.buildServer();

test.before(async () => {
  await new Promise((r) => upstream.listen(upstreamPort, "127.0.0.1", r));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
});
test.after(async () => {
  for (const s of clientSockets) s.destroy();
  upstream.destroySockets();
  await new Promise((r) => server.close(r));
  await new Promise((r) => upstream.close(r));
});

test("config reports whisper streaming STT", async () => {
  const cfg = JSON.parse((await request(server, "GET", "/api/config")).data);
  assert.strictEqual(cfg.sttMode, "whisper-stream");
  assert.deepStrictEqual(cfg.sttStream, { enabled: true });
});

test("STT stream WebSocket proxies audio chunks to the configured upstream", async () => {
  const port = server.address().port;
  const client = await wsClient(port, "/api/stt-stream");
  client.sendText(JSON.stringify({ type: "start", mimeType: "audio/webm", lang: "en-US" }));
  client.sendBinary("fake-audio");
  await waitForMessage(client, /"type":"ready"/);
  await waitForMessage(client, /hello world/);
  client.close();
});
