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
  const chunks = [];
  req.on("data", (c) => {
    size += c.length;
    if (size > limitBytes) { req.destroy(); }
    else chunks.push(c);
  });
  req.on("end", () => cb(null, Buffer.concat(chunks)));
  req.on("error", cb);
}

module.exports = {
  SECURITY_HEADERS,
  send,
  sendJson,
  authorized,
  readBody,
};
