"use strict";
const test = require("node:test");
const assert = require("node:assert");
const srv = require("../server.js");

test("claude adapter: fresh turn has no --continue, prompt after -p", () => {
  const { argv, stdin } = srv.AGENTS.claude.command("hello", false);
  assert.strictEqual(stdin, null);
  assert.ok(!argv.includes("--continue"));
  assert.ok(argv.includes("--output-format"));
  assert.ok(argv.includes("stream-json"));
  const i = argv.indexOf("-p");
  assert.ok(i >= 0 && argv[i + 1] === "hello");
});

test("claude adapter: continued turn adds --continue", () => {
  const { argv } = srv.AGENTS.claude.command("hi", true);
  assert.strictEqual(argv[0], "--continue");
});

test("codex adapter: `exec` with prompt on stdin", () => {
  const { argv, stdin } = srv.AGENTS.codex.command("do it");
  assert.deepStrictEqual(argv, ["exec"]);
  assert.strictEqual(stdin, "do it");
  assert.strictEqual(srv.AGENTS.codex.supportsContinue, false);
});

test("antigravity adapter: `--print` with prompt on stdin", () => {
  const { argv, stdin } = srv.AGENTS.antigravity.command("go");
  assert.deepStrictEqual(argv, ["--print"]);
  assert.strictEqual(stdin, "go");
});

test("parseClaudeLine extracts assistant text", () => {
  const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hi" }, { type: "tool_use" }] } });
  assert.strictEqual(srv.parseClaudeLine(line), "Hi");
});

test("parseClaudeLine ignores non-assistant and invalid lines", () => {
  assert.strictEqual(srv.parseClaudeLine(JSON.stringify({ type: "system" })), null);
  assert.strictEqual(srv.parseClaudeLine("not json"), null);
  assert.strictEqual(srv.parseClaudeLine(JSON.stringify({ type: "assistant", message: { content: [] } })), null);
});

test("createSession validates agent and directory", () => {
  assert.throws(() => srv.createSession({ agent: "nope", projectDir: process.cwd() }), /unknown agent/);
  assert.throws(() => srv.createSession({ agent: "claude", projectDir: "/no/such/dir/xyz" }), /not found/);
  const s = srv.createSession({ agent: "codex", projectDir: process.cwd() });
  assert.strictEqual(s.agent, "codex");
  assert.strictEqual(s.started, false);
  assert.ok(srv.sessions.has(s.id));
});

test("createSession defaults name to the agent label", () => {
  const s = srv.createSession({ agent: "claude", projectDir: process.cwd() });
  assert.strictEqual(s.name, "Claude Code");
});
