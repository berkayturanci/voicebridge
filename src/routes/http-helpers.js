"use strict";

const crypto = require("crypto");
const { ACCESS_TOKEN } = require("../config");

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'",
};

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ "Cache-Control": "no-store" }, SECURITY_HEADERS, headers || {}));
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json" });
}

function authorized(req) {
  if (!ACCESS_TOKEN) return true;
  const h = req.headers["authorization"] || "";
  const got = h.startsWith("Bearer ") ? h.slice(7) : "";
  try {
    const gotHash = crypto.createHash("sha256").update(got).digest();
    const expHash = crypto.createHash("sha256").update(ACCESS_TOKEN).digest();
    return crypto.timingSafeEqual(gotHash, expHash);
  } catch (_) {
    return false;
  }
}

function readBody(req, limitBytes, cb) {
  let size = 0;
  let tooLarge = false;
  const chunks = [];
  req.on("data", (c) => {
    size += c.length;
    if (size > limitBytes) {
      tooLarge = true;
    } else {
      chunks.push(c);
    }
  });
  req.on("end", () => {
    if (tooLarge) {
      const err = new Error("Payload too large");
      err.code = "PAYLOAD_TOO_LARGE";
      return cb(err);
    }
    cb(null, Buffer.concat(chunks));
  });
  req.on("error", cb);
}

function wsAcceptKey(key) {
  return crypto.createHash("sha1")
    .update(String(key || "") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
}

function wsEncode(data, { opcode = 1, mask = false } = {}) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  const len = payload.length;
  const header = [];
  header.push(0x80 | (opcode & 0x0f));
  if (len < 126) header.push((mask ? 0x80 : 0) | len);
  else if (len <= 0xffff) header.push((mask ? 0x80 : 0) | 126, (len >> 8) & 0xff, len & 0xff);
  else {
    header.push((mask ? 0x80 : 0) | 127, 0, 0, 0, 0, (len / 0x1000000) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff);
  }
  let h = Buffer.from(header);
  if (!mask) return Buffer.concat([h, payload]);
  const key = crypto.randomBytes(4);
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ key[i % 4];
  return Buffer.concat([h, key, out]);
}

module.exports = {
  SECURITY_HEADERS,
  send,
  sendJson,
  authorized,
  readBody,
  wsAcceptKey,
  wsEncode,
};
