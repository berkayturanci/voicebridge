"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const net = require("net");
const tls = require("tls");
const { spawn } = require("child_process");
const { STT_MODE, STT_CMD, STT_STREAM_URL, ACCESS_TOKEN } = require("../config");
const { wsAcceptKey, wsEncode } = require("../routes/http-helpers");

function transcribe(audioBuf, contentType, cb) {
  if (STT_MODE !== "whisper" || !STT_CMD) {
    return cb(new Error("Server is not configured for whisper STT."));
  }
  const ext = /wav/.test(contentType) ? ".wav" : /mp4|m4a/.test(contentType) ? ".m4a" : ".webm";
  const tmp = path.join(os.tmpdir(), "vb-" + crypto.randomBytes(6).toString("hex") + ext);
  fs.writeFile(tmp, audioBuf, (werr) => {
    if (werr) return cb(werr);
    const cmd = STT_CMD.replace(/\{file\}/g, tmp);
    const child = spawn("/bin/sh", ["-c", cmd], { env: process.env });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => { fs.unlink(tmp, () => {}); cb(e); });
    child.on("close", (code) => {
      fs.unlink(tmp, () => {});
      if (code !== 0 && !out.trim()) return cb(new Error(err.trim() || "whisper failed"));
      cb(null, out.trim());
    });
  });
}

function attachWs(socket, { incomingMasked, onMessage, onClose, onError }) {
  let buf = Buffer.alloc(0);
  const fail = (e) => {
    try { onError && onError(e); } catch (_) {}
    try { socket.destroy(); } catch (_) {}
  };
  const parse = () => {
    while (buf.length >= 2) {
      const b0 = buf[0], b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = !!(b1 & 0x80);
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (buf.length < off + 2) return;
        len = buf.readUInt16BE(off); off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) return;
        const high = buf.readUInt32BE(off), low = buf.readUInt32BE(off + 4); off += 8;
        if (high !== 0) return fail(new Error("WebSocket frame too large"));
        len = low;
      }
      if (masked !== !!incomingMasked) return fail(new Error("Bad WebSocket mask"));
      let key = null;
      if (masked) {
        if (buf.length < off + 4) return;
        key = buf.subarray(off, off + 4); off += 4;
      }
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      if (masked) {
        const unmasked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ key[i % 4];
        payload = unmasked;
      }
      if (opcode === 0x8) { try { onClose && onClose(); } catch (_) {} return; }
      if (opcode === 0x9) { try { socket.write(wsEncode(payload, { opcode: 0x0a, mask: !incomingMasked })); } catch (_) {} continue; }
      if (opcode === 0x1 || opcode === 0x2) onMessage(payload, opcode);
    }
  };
  socket.on("data", (d) => { buf = Buffer.concat([buf, d]); parse(); });
  socket.on("close", () => { try { onClose && onClose(); } catch (_) {} });
  socket.on("error", fail);
  return { push: (d) => { buf = Buffer.concat([buf, d]); parse(); } };
}

function wsConnect(rawUrl, cb) {
  let u;
  try { u = new URL(rawUrl); } catch (e) { return cb(e); }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") return cb(new Error("STT_STREAM_URL must be ws:// or wss://"));
  const secure = u.protocol === "wss:";
  const port = Number(u.port || (secure ? 443 : 80));
  const key = crypto.randomBytes(16).toString("base64");
  const socket = secure ? tls.connect({ host: u.hostname, port, servername: u.hostname }) : net.connect({ host: u.hostname, port });
  let head = Buffer.alloc(0), settled = false, ws = null;
  const done = (err, client) => {
    if (settled) return;
    settled = true;
    socket.removeAllListeners("connect");
    if (err) { try { socket.destroy(); } catch (_) {} return cb(err); }
    cb(null, client);
  };
  socket.on("connect", () => {
    const target = (u.pathname || "/") + (u.search || "");
    socket.write([
      `GET ${target} HTTP/1.1`,
      `Host: ${u.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "\r\n",
    ].join("\r\n"));
  });
  socket.on("data", function onHead(d) {
    if (settled) return;
    head = Buffer.concat([head, d]);
    const idx = head.indexOf("\r\n\r\n");
    if (idx < 0) return;
    socket.removeListener("data", onHead);
    const text = head.subarray(0, idx).toString("utf8");
    if (!/^HTTP\/1\.[01] 101\b/.test(text)) return done(new Error("STT stream upstream rejected WebSocket"));
    const rest = head.subarray(idx + 4);
    const api = {
      send: (data, opcode = 1) => socket.write(wsEncode(data, { opcode, mask: true })),
      close: () => { try { socket.end(wsEncode(Buffer.alloc(0), { opcode: 0x8, mask: true })); } catch (_) {} },
      onMessage: null,
      onClose: null,
    };
    ws = attachWs(socket, {
      incomingMasked: false,
      onMessage: (payload, opcode) => { if (api.onMessage) api.onMessage(payload, opcode); },
      onClose: () => { if (api.onClose) api.onClose(); },
      onError: (e) => { if (api.onClose) api.onClose(e); },
    });
    if (rest.length) ws.push(rest);
    done(null, api);
  });
  socket.on("error", (e) => done(e));
}

function authorizedWs(req, parsed) {
  const token = process.env.ACCESS_TOKEN || ACCESS_TOKEN;
  if (!token) return true;
  const h = req.headers.authorization || "";
  if (h === "Bearer " + token) return true;
  return parsed.searchParams.get("token") === token;
}

function handleSttStreamUpgrade(req, socket, head) {
  const parsed = new URL(req.url || "/", "http://x");
  if (parsed.pathname !== "/api/stt-stream") return false;
  const reject = (code, msg) => {
    try { socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`); } catch (_) {}
    try { socket.destroy(); } catch (_) {}
  };
  if (!authorizedWs(req, parsed)) { reject(401, "Unauthorized"); return true; }
  const mode = process.env.STT_MODE || STT_MODE;
  const streamUrl = process.env.STT_STREAM_URL || STT_STREAM_URL;
  if (mode !== "whisper-stream" || !streamUrl) { reject(503, "STT Stream Not Configured"); return true; }
  const key = req.headers["sec-websocket-key"];
  if (!key) { reject(400, "Bad Request"); return true; }
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${wsAcceptKey(key)}`,
    "\r\n",
  ].join("\r\n"));

  let upstream = null, closed = false, bytes = 0;
  const pending = [];
  const closeAll = () => {
    if (closed) return;
    closed = true;
    try { upstream && upstream.close(); } catch (_) {}
    try { socket.end(wsEncode(Buffer.alloc(0), { opcode: 0x8 })); } catch (_) {}
  };
  const sendClient = (obj) => {
    try { socket.write(wsEncode(JSON.stringify(obj), { opcode: 1 })); } catch (_) {}
  };
  const clientWs = attachWs(socket, {
    incomingMasked: true,
    onMessage: (payload, opcode) => {
      bytes += payload.length;
      if (bytes > 32 * 1024 * 1024) { sendClient({ type: "error", error: "STT stream too large" }); return closeAll(); }
      if (upstream) upstream.send(payload, opcode);
      else pending.push({ payload, opcode });
    },
    onClose: closeAll,
    onError: closeAll,
  });
  if (head && head.length) clientWs.push(head);
  wsConnect(streamUrl, (err, up) => {
    if (closed) return;
    if (err) { sendClient({ type: "error", error: err.message }); return closeAll(); }
    upstream = up;
    upstream.onMessage = (payload, opcode) => {
      try { socket.write(wsEncode(payload, { opcode })); } catch (_) { closeAll(); }
    };
    upstream.onClose = closeAll;
    for (const frame of pending.splice(0)) upstream.send(frame.payload, frame.opcode);
    sendClient({ type: "ready" });
  });
  return true;
}

module.exports = {
  transcribe,
  attachWs,
  wsConnect,
  authorizedWs,
  handleSttStreamUpgrade,
};
