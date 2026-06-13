"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { installStubAgents, request, ndjson } = require("./helpers");

installStubAgents();
const srv = require("../server.js");

// Boot a default session and start a server on an ephemeral port.
const boot = srv.createSession({ name: "default", agent: "claude", projectDir: process.cwd() });
srv.defaultSessionId = boot.id;
const server = srv.buildServer();

test.before(() => new Promise((r) => server.listen(0, "127.0.0.1", r)));
test.after(() => new Promise((r) => server.close(r)));

test("GET /api/config advertises agents, their modes, and the default session", async () => {
  const { status, data } = await request(server, "GET", "/api/config");
  assert.strictEqual(status, 200);
  const cfg = JSON.parse(data);
  assert.deepStrictEqual(cfg.agents.map((a) => a.id).sort(), ["antigravity", "claude", "codex"]);
  const claude = cfg.agents.find((a) => a.id === "claude");
  assert.strictEqual(claude.defaultMode, "ask");
  assert.ok(claude.modes.some((m) => m.id === "full"));
  assert.strictEqual(cfg.defaultSessionId, boot.id);
});

test("a session can be created with a mode, surfaced in its public shape", async () => {
  const create = await request(server, "POST", "/api/sessions", { agent: "claude", projectDir: process.cwd(), mode: "full" });
  assert.strictEqual(create.status, 200);
  assert.strictEqual(JSON.parse(create.data).session.mode, "full");

  const bad = await request(server, "POST", "/api/sessions", { agent: "claude", projectDir: process.cwd(), mode: "ghost" });
  assert.strictEqual(bad.status, 400);
});

test("POST /api/ask streams claude stream-json as delta + done", async () => {
  const { status, data } = await request(server, "POST", "/api/ask", { text: "hi", sessionId: boot.id });
  assert.strictEqual(status, 200);
  const evs = ndjson(data);
  const text = evs.filter((e) => e.type === "delta").map((e) => e.text).join("");
  assert.strictEqual(text, "Hello world.");
  assert.strictEqual(evs[evs.length - 1].type, "done");
});

test("ask marks the session started (enables --continue next turn)", () => {
  assert.strictEqual(srv.sessions.get(boot.id).started, true);
});

test("POST /api/ask routes to a codex session (plain-text stream)", async () => {
  const create = await request(server, "POST", "/api/sessions", { name: "cx", agent: "codex", projectDir: process.cwd() });
  const { session } = JSON.parse(create.data);
  assert.strictEqual(session.agent, "codex");

  const { data } = await request(server, "POST", "/api/ask", { text: "build it", sessionId: session.id });
  const evs = ndjson(data);
  const text = evs.filter((e) => e.type === "delta").map((e) => e.text).join("");
  assert.strictEqual(text, "echo:build it");
  assert.strictEqual(evs[evs.length - 1].type, "done");
});

test("sessions can be listed and deleted; default is protected", async () => {
  const create = await request(server, "POST", "/api/sessions", { agent: "antigravity", projectDir: process.cwd() });
  const { session } = JSON.parse(create.data);

  const list = JSON.parse((await request(server, "GET", "/api/sessions")).data);
  assert.ok(list.sessions.some((s) => s.id === session.id));

  const del = await request(server, "DELETE", "/api/sessions/" + session.id);
  assert.strictEqual(del.status, 200);

  const delDefault = await request(server, "DELETE", "/api/sessions/" + boot.id);
  assert.strictEqual(delDefault.status, 400);
});

test("creating a session with an unknown agent is rejected", async () => {
  const { status, data } = await request(server, "POST", "/api/sessions", { agent: "ghost", projectDir: process.cwd() });
  assert.strictEqual(status, 400);
  assert.match(JSON.parse(data).error, /unknown agent/);
});

test("empty prompt and unknown session are rejected", async () => {
  assert.strictEqual((await request(server, "POST", "/api/ask", { text: "  ", sessionId: boot.id })).status, 400);
  assert.strictEqual((await request(server, "POST", "/api/ask", { text: "hi", sessionId: "nope" })).status, 404);
});
