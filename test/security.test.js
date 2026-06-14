"use strict";
// Security regression tests for the static file handler and headers.
const test = require("node:test");
const assert = require("node:assert");
const { installStubAgents, request } = require("./helpers");

installStubAgents();
const srv = require("../server.js");

const boot = srv.createSession({ name: "default", agent: "claude", projectDir: process.cwd() });
srv.defaultSessionId = boot.id;
const server = srv.buildServer();

test.before(() => new Promise((r) => server.listen(0, "127.0.0.1", r)));
test.after(() => new Promise((r) => server.close(r)));

test("path traversal attempts cannot escape public/ (no server.js leak)", async () => {
  for (const p of ["/%2e%2e/server.js", "/..%2fserver.js", "/%2e%2e%2f%2e%2e%2fserver.js"]) {
    const res = await request(server, "GET", p);
    assert.notStrictEqual(res.status, 200, `${p} must not be served`);
    assert.ok(!/module\.exports/.test(res.data), `${p} must not leak source`);
  }
});

test("a legitimate static file is still served", async () => {
  const res = await request(server, "GET", "/manifest.webmanifest");
  // Either served (200) or simply absent (404) — never 403 for an in-tree path.
  assert.notStrictEqual(res.status, 403);
  const idx = await request(server, "GET", "/");
  assert.strictEqual(idx.status, 200);
  assert.ok(/<!doctype html>/i.test(idx.data));
});

test("security headers are present on responses", async () => {
  const res = await request(server, "GET", "/api/health");
  assert.strictEqual(res.headers["x-content-type-options"], "nosniff");
  assert.strictEqual(res.headers["x-frame-options"], "DENY");
  assert.ok(/default-src 'self'/.test(res.headers["content-security-policy"] || ""));
  assert.ok(!("access-control-allow-origin" in res.headers), "no open CORS");
});

test("malformed percent-encoding is a 400, not a crash", async () => {
  const res = await request(server, "GET", "/%E0%A4%A");
  assert.strictEqual(res.status, 400);
});
