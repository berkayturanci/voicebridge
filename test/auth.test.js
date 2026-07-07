"use strict";
// Runs in its own process (node --test isolates files), so setting ACCESS_TOKEN
// before requiring the server is safe and doesn't affect the other suites.
process.env.ACCESS_TOKEN = "secret-token";

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

test("/api/config stays public and reports authRequired", async () => {
  const { status, data } = await request(server, "GET", "/api/config");
  assert.strictEqual(status, 200);
  const cfg = JSON.parse(data);
  assert.strictEqual(cfg.authRequired, true);
  assert.ok(!("defaultProjectDir" in cfg));
  assert.ok(!("defaultSessionId" in cfg));
  assert.ok(!("favorites" in cfg));
  assert.ok(Array.isArray(cfg.agents));
});

test("/api/config returns private convenience fields only when authorized", async () => {
  const { status, data } = await request(server, "GET", "/api/config", null, { Authorization: "Bearer secret-token" });
  assert.strictEqual(status, 200);
  const cfg = JSON.parse(data);
  assert.strictEqual(cfg.defaultSessionId, boot.id);
  assert.strictEqual(typeof cfg.defaultProjectDir, "string");
  assert.ok(Array.isArray(cfg.favorites));
});

test("protected endpoints reject missing/wrong token", async () => {
  assert.strictEqual((await request(server, "GET", "/api/sessions")).status, 401);
  assert.strictEqual(
    (await request(server, "GET", "/api/sessions", null, { Authorization: "Bearer wrong" })).status,
    401
  );
});

test("correct Bearer token is accepted", async () => {
  const { status } = await request(server, "GET", "/api/sessions", null, { Authorization: "Bearer secret-token" });
  assert.strictEqual(status, 200);
});
