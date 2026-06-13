"use strict";
const test = require("node:test");
const assert = require("node:assert");
const srv = require("../server.js");

test("claude adapter: fresh turn has no --continue, prompt after -p", () => {
  const { argv, stdin } = srv.AGENTS.claude.command("hello", { cont: false });
  assert.strictEqual(stdin, null);
  assert.ok(!argv.includes("--continue"));
  assert.ok(argv.includes("--output-format"));
  assert.ok(argv.includes("stream-json"));
  const i = argv.indexOf("-p");
  assert.ok(i >= 0 && argv[i + 1] === "hello");
});

test("claude adapter: continued turn adds --continue", () => {
  const { argv } = srv.AGENTS.claude.command("hi", { cont: true });
  assert.ok(argv.includes("--continue"));
});

test("codex/antigravity adapters still pipe the prompt on stdin", () => {
  assert.strictEqual(srv.AGENTS.codex.command("do it").stdin, "do it");
  assert.strictEqual(srv.AGENTS.antigravity.command("go").stdin, "go");
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

test("mode flags are threaded into each agent's argv", () => {
  const cl = srv.AGENTS.claude.command("p", { modeArgs: srv.AGENTS.claude.modes.full.args });
  assert.ok(cl.argv.includes("--dangerously-skip-permissions"));
  const cx = srv.AGENTS.codex.command("p", { modeArgs: srv.AGENTS.codex.modes.full.args });
  assert.deepStrictEqual(cx.argv, ["exec", "--dangerously-bypass-approvals-and-sandbox"]);
  const ag = srv.AGENTS.antigravity.command("p", { modeArgs: srv.AGENTS.antigravity.modes.safe.args });
  assert.deepStrictEqual(ag.argv, ["--print", "--sandbox"]);
});

test("resolveMode falls back to the agent default for unknown/empty modes", () => {
  assert.strictEqual(srv.resolveMode("claude", "nope"), "ask");
  assert.strictEqual(srv.resolveMode("codex", undefined), "auto");
  assert.strictEqual(srv.resolveMode("claude", "full"), "full");
});

test("createSession validates mode and stores it", () => {
  assert.throws(() => srv.createSession({ agent: "claude", projectDir: process.cwd(), mode: "ghost" }), /unknown mode/);
  const s = srv.createSession({ agent: "claude", projectDir: process.cwd(), mode: "full" });
  assert.strictEqual(s.mode, "full");
  const d = srv.createSession({ agent: "codex", projectDir: process.cwd() });
  assert.strictEqual(d.mode, "auto"); // agent default
});

test("phoneUrl prefers PUBLIC_URL and falls back to host:port", () => {
  assert.strictEqual(srv.phoneUrl({ host: "127.0.0.1", port: 8787 }), "http://127.0.0.1:8787");
  assert.strictEqual(srv.phoneUrl({ publicUrl: "https://box.ts.net/" }), "https://box.ts.net");
});

test("phoneUrl embeds an access token when present", () => {
  assert.strictEqual(
    srv.phoneUrl({ publicUrl: "https://box.ts.net", token: "a b/c" }),
    "https://box.ts.net?token=a%20b%2Fc"
  );
});
