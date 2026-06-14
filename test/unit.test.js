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

test("antigravity invocation is configurable via AGY_ARGS / AGY_PROMPT_ARG", () => {
  const a = process.env.AGY_ARGS, p = process.env.AGY_PROMPT_ARG;
  try {
    delete process.env.AGY_ARGS; delete process.env.AGY_PROMPT_ARG;
    assert.deepStrictEqual(srv.AGENTS.antigravity.command("hi").argv, ["--print"]);
    process.env.AGY_PROMPT_ARG = "1"; // prompt as a positional arg, not stdin
    const c1 = srv.AGENTS.antigravity.command("hi");
    assert.deepStrictEqual(c1.argv, ["--print", "hi"]);
    assert.strictEqual(c1.stdin, null);
    process.env.AGY_ARGS = "chat -q"; // override the base args
    assert.deepStrictEqual(srv.AGENTS.antigravity.command("hi").argv, ["chat", "-q", "hi"]);
  } finally {
    if (a === undefined) delete process.env.AGY_ARGS; else process.env.AGY_ARGS = a;
    if (p === undefined) delete process.env.AGY_PROMPT_ARG; else process.env.AGY_PROMPT_ARG = p;
  }
});

test("ollama adapter runs a local model with the prompt on stdin", () => {
  const prev = process.env.OLLAMA_MODEL;
  delete process.env.OLLAMA_MODEL;
  let c = srv.AGENTS.ollama.command("hi");
  assert.deepStrictEqual(c.argv, ["run", "llama3.2"]);
  assert.strictEqual(c.stdin, "hi");
  assert.strictEqual(srv.AGENTS.ollama.supportsContinue, true); // HTTP path keeps history
  process.env.OLLAMA_MODEL = "qwen2.5-coder";
  assert.deepStrictEqual(srv.AGENTS.ollama.command("hi").argv, ["run", "qwen2.5-coder"]);
  if (prev === undefined) delete process.env.OLLAMA_MODEL; else process.env.OLLAMA_MODEL = prev;
});

test("codex resume is opt-in via CODEX_CONTINUE_ARGS", () => {
  const prev = process.env.CODEX_CONTINUE_ARGS;
  delete process.env.CODEX_CONTINUE_ARGS;
  assert.strictEqual(srv.AGENTS.codex.supportsContinue, false);
  assert.deepStrictEqual(srv.AGENTS.codex.command("p", { cont: true }).argv, ["exec"]);
  process.env.CODEX_CONTINUE_ARGS = "resume --last";
  assert.strictEqual(srv.AGENTS.codex.supportsContinue, true);
  assert.deepStrictEqual(
    srv.AGENTS.codex.command("p", { cont: true, modeArgs: ["--full-auto"] }).argv,
    ["exec", "resume", "--last", "--full-auto"]
  );
  if (prev === undefined) delete process.env.CODEX_CONTINUE_ARGS; else process.env.CODEX_CONTINUE_ARGS = prev;
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

test("parseDotEnv parses KEY=VALUE, skips comments, strips quotes", () => {
  const env = srv.parseDotEnv('# comment\nPORT=9000\nNAME="voice bridge"\nEMPTY=\n  SPACED = x \nBAD LINE');
  assert.strictEqual(env.PORT, "9000");
  assert.strictEqual(env.NAME, "voice bridge");
  assert.strictEqual(env.EMPTY, "");
  assert.strictEqual(env.SPACED, "x");
  assert.ok(!("BAD" in env));
});

test("binExists resolves real executables and rejects fakes", () => {
  assert.strictEqual(srv.binExists("/bin/sh"), true);
  assert.strictEqual(srv.binExists("sh"), true); // on PATH
  assert.strictEqual(srv.binExists("/no/such/bin-xyz"), false);
  assert.strictEqual(srv.binExists("definitely-not-a-real-bin-xyz"), false);
  assert.strictEqual(srv.agentAvailable("ollama"), true); // HTTP, always "available"
});

test("browseDir lists subdirectories, hides dotfiles, sets parent", () => {
  const b = srv.browseDir(process.cwd());
  assert.strictEqual(b.path, process.cwd());
  assert.ok(b.dirs.includes("public") && b.dirs.includes("test"));
  assert.ok(!b.dirs.some((d) => d.startsWith(".")));
  assert.strictEqual(typeof b.parent, "string");
});

test("listNpmScripts / listSlashCommands read a project's commands", () => {
  const scripts = srv.listNpmScripts(process.cwd());
  assert.ok(scripts.some((s) => s.label === "npm run test" && s.value === "npm run test"));
  // namespaced slash command from a nested .claude/commands dir
  const fs = require("fs"), os = require("os"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-cmds-"));
  fs.mkdirSync(path.join(dir, ".claude", "commands", "keel"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "commands", "deploy.md"), "x");
  fs.writeFileSync(path.join(dir, ".claude", "commands", "keel", "ship.md"), "x");
  const cmds = srv.listSlashCommands(dir).map((c) => c.label);
  assert.deepStrictEqual(cmds, ["/deploy", "/keel:ship"]);
  fs.rmSync(dir, { recursive: true, force: true });
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

test("parseClaudeEvents emits delta for text and activity for tool_use", () => {
  const line = JSON.stringify({ type: "assistant", message: { content: [
    { type: "text", text: "ok" },
    { type: "tool_use", name: "Edit", input: { file_path: "/repo/server.js" } },
    { type: "tool_use", name: "Bash", input: { command: "npm test" } },
  ] } });
  const evs = srv.parseClaudeEvents(line);
  assert.deepStrictEqual(evs[0], { type: "delta", text: "ok" });
  assert.deepStrictEqual(evs[1], { type: "activity", text: "Edit server.js" });
  assert.deepStrictEqual(evs[2], { type: "activity", text: "Bash npm test" });
  assert.deepStrictEqual(srv.parseClaudeEvents("nope"), []);
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

test("looksLikeQuestion detects trailing questions", () => {
  assert.strictEqual(srv.looksLikeQuestion("Should I proceed?"), true);
  assert.strictEqual(srv.looksLikeQuestion("Done.\nReady?"), true);
  assert.strictEqual(srv.looksLikeQuestion('Is that ok?"'), true);
  assert.strictEqual(srv.looksLikeQuestion("All set."), false);
  assert.strictEqual(srv.looksLikeQuestion(""), false);
});

test("buildPrompt prepends the voice preamble only in voice mode", () => {
  assert.strictEqual(srv.buildPrompt(false, "hello"), "hello");
  const v = srv.buildPrompt(true, "hello");
  assert.ok(v.endsWith("hello") && v.length > "hello".length);
  assert.match(v, /text-to-speech/i);
});

test("createSession stores the voice flag", () => {
  assert.strictEqual(srv.createSession({ agent: "claude", projectDir: process.cwd() }).voice, false);
  assert.strictEqual(srv.createSession({ agent: "claude", projectDir: process.cwd(), voice: true }).voice, true);
});

test("parseFavorites reads valid entries and ignores junk", () => {
  assert.deepStrictEqual(srv.parseFavorites(undefined), []);
  assert.deepStrictEqual(srv.parseFavorites("not json"), []);
  const favs = srv.parseFavorites(JSON.stringify([
    { name: "App", projectDir: "/a", agent: "claude", mode: "full" },
    { projectDir: "/b" },
    { name: "no dir" },
  ]));
  assert.strictEqual(favs.length, 2);
  assert.strictEqual(favs[0].name, "App");
  assert.strictEqual(favs[1].name, "/b"); // falls back to the dir
});

test("resolveRunner: local always ok, cloud needs CLOUD_RUNNER_URL", () => {
  const prev = process.env.CLOUD_RUNNER_URL;
  delete process.env.CLOUD_RUNNER_URL;
  assert.strictEqual(srv.resolveRunner(undefined), "local");
  assert.throws(() => srv.resolveRunner("cloud"), /not configured/);
  assert.throws(() => srv.resolveRunner("weird"), /unknown runner/);
  process.env.CLOUD_RUNNER_URL = "http://127.0.0.1:9/";
  assert.strictEqual(srv.resolveRunner("cloud"), "cloud");
  if (prev === undefined) delete process.env.CLOUD_RUNNER_URL; else process.env.CLOUD_RUNNER_URL = prev;
});

test("createSession defaults runner to local and stores it", () => {
  const s = srv.createSession({ agent: "claude", projectDir: process.cwd() });
  assert.strictEqual(s.runner, "local");
});

test("createSession enforces a session cap", () => {
  const saved = new Map(srv.sessions);
  const prev = process.env.MAX_SESSIONS;
  srv.sessions.clear();
  process.env.MAX_SESSIONS = "3";
  try {
    for (let i = 0; i < 3; i++) srv.createSession({ agent: "claude", projectDir: process.cwd() });
    assert.throws(() => srv.createSession({ agent: "claude", projectDir: process.cwd() }), /too many sessions/);
  } finally {
    srv.sessions.clear();
    for (const [k, v] of saved) srv.sessions.set(k, v);
    if (prev === undefined) delete process.env.MAX_SESSIONS; else process.env.MAX_SESSIONS = prev;
  }
});

test("sessions persist to a file and reload", () => {
  const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path");
  const f = path.join(os.tmpdir(), "vb-sess-" + Date.now() + ".json");
  const s = srv.createSession({ agent: "codex", projectDir: process.cwd(), name: "persisted", mode: "full", voice: true });
  srv.saveSessions(f);
  srv.sessions.delete(s.id);
  assert.ok(!srv.sessions.has(s.id));
  srv.loadSessions(f);
  const r = srv.sessions.get(s.id);
  assert.ok(r && r.name === "persisted" && r.agent === "codex" && r.mode === "full" && r.voice === true && r.started === false);
  fs.unlinkSync(f);
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
