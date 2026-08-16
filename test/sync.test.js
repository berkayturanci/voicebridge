"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const crypto = require("crypto");
const net = require("net");
const hub = require("../src/services/hub");
const { wsAcceptKey, wsEncode } = require("../src/routes/http-helpers");
const { attachWs } = require("../src/services/stt");
const srv = require("../server");
const { installStubAgents, request } = require("./helpers");

installStubAgents();

const clientSockets = [];
function wsClient(port, path = "/ws", token = "") {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    clientSockets.push(socket);
    const key = crypto.randomBytes(16).toString("base64");
    const fullPath = token ? `${path}?token=${encodeURIComponent(token)}` : path;
    socket.on("connect", () => {
      socket.write([
        `GET ${fullPath} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "\r\n",
      ].join("\r\n"));
    });
    let head = Buffer.alloc(0), upgraded = false;
    socket.on("data", function onData(d) {
      if (upgraded) return;
      head = Buffer.concat([head, d]);
      const idx = head.indexOf("\r\n\r\n");
      if (idx < 0) return;
      upgraded = true;
      socket.removeListener("data", onData);
      const text = head.subarray(0, idx).toString("utf8");
      if (!/^HTTP\/1\.[01] 101\b/.test(text)) {
        return reject(new Error("Handshake failed: " + text.split("\r\n")[0]));
      }
      const rest = head.subarray(idx + 4);
      const messages = [];
      const listeners = [];
      const ws = attachWs(socket, {
        incomingMasked: false,
        onMessage: (payload) => {
          const str = payload.toString("utf8");
          messages.push(str);
          for (let i = listeners.length - 1; i >= 0; i--) {
            if (listeners[i](str)) listeners.splice(i, 1);
          }
        },
      });
      if (rest.length) ws.push(rest);
      resolve({
        socket,
        messages,
        send: (obj) => socket.write(wsEncode(JSON.stringify(obj), { opcode: 1, mask: true })),
        waitFor: (pattern, timeoutMs = 3000) => {
          return new Promise((res, rej) => {
            const found = messages.find((m) => pattern.test(m));
            if (found) return res(found);
            const timer = setTimeout(() => rej(new Error(`Timeout waiting for ${pattern}`)), timeoutMs);
            listeners.push((m) => {
              if (pattern.test(m)) {
                clearTimeout(timer);
                res(m);
                return true;
              }
              return false;
            });
          });
        },
        close: () => {
          try { socket.end(wsEncode(Buffer.alloc(0), { opcode: 0x8, mask: true })); } catch (_) {}
        }
      });
    });
    socket.on("error", (e) => { if (!upgraded) reject(e); });
  });
}

const boot = srv.createSession({ name: "default", agent: "claude", projectDir: process.cwd() });
srv.defaultSessionId = boot.id;
const server = srv.buildServer();

test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
});

test.after(async () => {
  for (const s of clientSockets) {
    try { s.destroy(); } catch (_) {}
  }
  await new Promise((r) => server.close(r));
});

test("hub service unit: subscribe, unsubscribe, and broadcast", () => {
  const fakeWs1 = {
    messages: [],
    subscribedSessions: new Set(),
    send(str) { this.messages.push(JSON.parse(str)); },
  };
  const fakeWs2 = {
    messages: [],
    subscribedSessions: new Set(),
    send(str) { this.messages.push(JSON.parse(str)); },
  };

  hub.subscribe("test-s1", fakeWs1);
  hub.subscribe("test-s1", fakeWs2);
  hub.subscribe("test-s2", fakeWs2);

  hub.broadcast("test-s1", { type: "delta", text: "hi s1" });
  assert.strictEqual(fakeWs1.messages.length, 1);
  assert.strictEqual(fakeWs1.messages[0].text, "hi s1");
  assert.strictEqual(fakeWs2.messages.length, 1);

  hub.broadcast("test-s2", { type: "delta", text: "hi s2" });
  assert.strictEqual(fakeWs1.messages.length, 1);
  assert.strictEqual(fakeWs2.messages.length, 2);
  assert.strictEqual(fakeWs2.messages[1].text, "hi s2");

  hub.unsubscribe("test-s1", fakeWs1);
  hub.broadcast("test-s1", { type: "delta", text: "after unsub" });
  assert.strictEqual(fakeWs1.messages.length, 1);
  assert.strictEqual(fakeWs2.messages.length, 3);

  hub.unsubscribeAll(fakeWs2);
});

test("WebSocket /ws: connect, ping-pong, and subscribe to session", async () => {
  const port = server.address().port;
  const client = await wsClient(port, "/ws");

  client.send({ type: "ping" });
  const pongMsg = await client.waitFor(/"type":"pong"/);
  assert.ok(pongMsg.includes('"pong"'));

  client.send({ type: "subscribe", sessionId: boot.id });
  const subMsg = await client.waitFor(/"type":"subscribed"/);
  assert.ok(subMsg.includes(boot.id));

  client.close();
});

test("WebSocket /ws: multi-client live session broadcast during HTTP turns", async () => {
  const port = server.address().port;
  const clientA = await wsClient(port, "/ws");
  const clientB = await wsClient(port, "/ws");

  // Create a new session
  const sRes = await request(server, "POST", "/api/sessions", { name: "sync-session", agent: "codex", projectDir: process.cwd() });
  const session = JSON.parse(sRes.data).session;

  clientA.send({ type: "subscribe", sessionId: session.id });
  clientB.send({ type: "subscribe", sessionId: session.id });
  await clientA.waitFor(/"type":"subscribed"/);
  await clientB.waitFor(/"type":"subscribed"/);

  // Trigger turn via HTTP POST /api/ask
  await request(server, "POST", "/api/ask", { text: "live duplex prompt", sessionId: session.id });

  // Both clients should receive turn_start and deltas
  const aTurn = await clientA.waitFor(/"type":"turn_start"/);
  assert.ok(aTurn.includes("live duplex prompt"));
  const bTurn = await clientB.waitFor(/"type":"turn_start"/);
  assert.ok(bTurn.includes("live duplex prompt"));

  const aDone = await clientA.waitFor(/"type":"done"/);
  const bDone = await clientB.waitFor(/"type":"done"/);
  assert.ok(aDone && bDone);

  clientA.close();
  clientB.close();
});

test("WebSocket /ws: approval resolution broadcasts to all connected clients", async () => {
  const approvalsService = require("../src/services/approvals");
  const port = server.address().port;
  const clientA = await wsClient(port, "/ws");
  const clientB = await wsClient(port, "/ws");

  const appr = approvalsService.createApproval({
    sessionId: boot.id,
    tool: "Bash",
    command: "npm test",
    description: "Run tests",
  });

  // Client A resolves approval via WS message
  clientA.send({ type: "approval", id: appr.id, approved: true });

  const aMsg = await clientA.waitFor(/"type":"approval_resolved"/);
  const bMsg = await clientB.waitFor(/"type":"approval_resolved"/);
  assert.ok(aMsg.includes(appr.id) && aMsg.includes('"approved":true'));
  assert.ok(bMsg.includes(appr.id) && bMsg.includes('"approved":true'));

  clientA.close();
  clientB.close();
});

test("WebSocket /ws: session lifecycle broadcasts (create, update, delete)", async () => {
  const port = server.address().port;
  const client = await wsClient(port, "/ws");

  // Create
  const sRes = await request(server, "POST", "/api/sessions", { name: "life-sess", agent: "claude", projectDir: process.cwd() });
  const session = JSON.parse(sRes.data).session;
  const cMsg = await client.waitFor(/"type":"session_created"/);
  assert.ok(cMsg.includes("life-sess"));

  // Update
  await request(server, "POST", `/api/sessions/${session.id}`, { name: "renamed-sess" });
  const uMsg = await client.waitFor(/"type":"session_updated"/);
  assert.ok(uMsg.includes("renamed-sess"));

  // Delete
  await request(server, "DELETE", `/api/sessions/${session.id}`);
  const dMsg = await client.waitFor(/"type":"session_deleted"/);
  assert.ok(dMsg.includes(session.id));

  client.close();
});
