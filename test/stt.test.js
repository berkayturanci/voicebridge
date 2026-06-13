"use strict";
// Runs in its own process (node --test isolates files), so configuring whisper
// STT before requiring the server is safe and doesn't affect the other suites.
process.env.STT_MODE = "whisper";
process.env.STT_CMD = "printf transcribed-%s hello"; // ignores {file}, prints to stdout

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

test("config reports whisper STT mode", async () => {
  const cfg = JSON.parse((await request(server, "GET", "/api/config")).data);
  assert.strictEqual(cfg.sttMode, "whisper");
});

test("POST /api/stt runs STT_CMD and returns the transcript", async () => {
  const r = await request(server, "POST", "/api/stt", "fake-audio-bytes", { "Content-Type": "audio/webm" });
  assert.strictEqual(r.status, 200);
  assert.match(JSON.parse(r.data).text, /transcribed-/);
});

test("POST /api/stt with no audio is rejected", async () => {
  const r = await request(server, "POST", "/api/stt", "", { "Content-Type": "audio/webm" });
  assert.strictEqual(r.status, 400);
});
