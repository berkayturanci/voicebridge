"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { installStubAgents, request, ndjson } = require("./helpers");

installStubAgents();
const srv = require("../server.js");
const summarizer = require("../src/services/summarizer");
const narrator = require("../src/services/narrator");

const quiet = { log() {} };

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k];
  }
  const restore = () => { for (const k of Object.keys(saved)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } };
  let r;
  try { r = fn(); } catch (e) { restore(); throw e; }
  if (r && typeof r.then === "function") return r.finally(restore);
  restore();
  return r;
}

// A fake model endpoint that records requests and answers per path.
async function fakeModelServer(handler) {
  const seen = [];
  const server = http.createServer((rq, rs) => {
    let body = "";
    rq.on("data", (c) => (body += c));
    rq.on("end", () => {
      const req = { path: rq.url, headers: rq.headers, body: body ? JSON.parse(body) : null };
      seen.push(req);
      Promise.resolve(handler(req)).then((out) => {
        if (out && out.delayMs) return setTimeout(() => { rs.writeHead(200); rs.end("{}"); }, out.delayMs);
        rs.writeHead((out && out.status) || 200, { "Content-Type": "application/json" });
        rs.end(JSON.stringify((out && out.json) || {}));
      });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: "http://127.0.0.1:" + server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}

// ---------- summarizer ----------

test("summarizer: provider resolution", () => {
  assert.strictEqual(summarizer.resolveProvider({}), "off");
  assert.strictEqual(summarizer.resolveProvider({ ANTHROPIC_API_KEY: "k" }), "anthropic");
  assert.strictEqual(summarizer.resolveProvider({ SUMMARY_BASE_URL: "http://x" }), "openai");
  assert.strictEqual(summarizer.resolveProvider({ SUMMARY_OLLAMA_URL: "http://x" }), "ollama");
  assert.strictEqual(summarizer.resolveProvider({ ANTHROPIC_API_KEY: "k", SUMMARY_PROVIDER: "off" }), "off");
  assert.strictEqual(summarizer.resolveProvider({ SUMMARY_PROVIDER: "ollama" }), "ollama");
  assert.strictEqual(summarizer.config({ ANTHROPIC_API_KEY: "k" }).model, "claude-haiku-5-5");
  assert.strictEqual(summarizer.config({ SUMMARY_PROVIDER: "ollama", SUMMARY_MODEL: "qwen3" }).model, "qwen3");
});

test("summarizer: anthropic request shape and text extraction", async () => {
  summarizer._reset();
  const fake = await fakeModelServer(() => ({ json: { stop_reason: "end_turn", content: [{ type: "text", text: "\"Running the tests.\"" }] } }));
  try {
    const env = { SUMMARY_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test", SUMMARY_ANTHROPIC_URL: fake.url };
    const r = await summarizer.complete({ system: "S", user: "U", maxTokens: 50, env, logger: quiet });
    assert.strictEqual(r.text, "Running the tests.");
    assert.strictEqual(r.provider, "anthropic");
    assert.ok(r.ms >= 0);
    const req = fake.seen[0];
    assert.strictEqual(req.path, "/v1/messages");
    assert.strictEqual(req.headers["x-api-key"], "sk-test");
    assert.strictEqual(req.headers["anthropic-version"], "2023-06-01");
    assert.strictEqual(req.body.model, "claude-haiku-5-5");
    assert.strictEqual(req.body.system, "S");
    assert.deepStrictEqual(req.body.messages, [{ role: "user", content: "U" }]);
    assert.strictEqual(req.body.max_tokens, 50);
  } finally { await fake.close(); }
});

test("summarizer: openai-compatible and ollama shapes", async () => {
  summarizer._reset();
  const fake = await fakeModelServer((req) => req.path === "/v1/chat/completions"
    ? { json: { choices: [{ message: { content: "OpenAI says hi." } }] } }
    : { json: { message: { content: "Ollama says hi." } } });
  try {
    const o = await summarizer.complete({ system: "S", user: "U", env: { SUMMARY_PROVIDER: "openai", SUMMARY_BASE_URL: fake.url + "/v1", SUMMARY_API_KEY: "k", SUMMARY_MODEL: "m" }, logger: quiet });
    assert.strictEqual(o.text, "OpenAI says hi.");
    assert.strictEqual(fake.seen[0].headers.authorization, "Bearer k");
    assert.deepStrictEqual(fake.seen[0].body.messages, [{ role: "system", content: "S" }, { role: "user", content: "U" }]);
    const l = await summarizer.complete({ system: "S", user: "U", env: { SUMMARY_PROVIDER: "ollama", SUMMARY_OLLAMA_URL: fake.url }, logger: quiet });
    assert.strictEqual(l.text, "Ollama says hi.");
    assert.strictEqual(fake.seen[1].path, "/api/chat");
    assert.strictEqual(fake.seen[1].body.stream, false);
    assert.strictEqual(fake.seen[1].body.model, "llama3.2");
  } finally { await fake.close(); }
});

test("summarizer: failures return null, are logged with latency, and trigger a cooldown", async () => {
  summarizer._reset();
  const fake = await fakeModelServer(() => ({ status: 500, json: { error: "boom" } }));
  const lines = [];
  try {
    const env = { SUMMARY_PROVIDER: "ollama", SUMMARY_OLLAMA_URL: fake.url, SUMMARY_COOLDOWN_MS: "60000" };
    assert.strictEqual(await summarizer.complete({ system: "S", user: "U", env, logger: { log: (l) => lines.push(l) } }), null);
    assert.match(lines[0], /failed provider=ollama \+\d+ms/);
    assert.strictEqual(summarizer.available(env), false);
    assert.strictEqual(await summarizer.complete({ system: "S", user: "U", env, logger: quiet }), null);
    assert.strictEqual(fake.seen.length, 1); // cooled down: no second request
    assert.strictEqual(summarizer.status(env).lastError.startsWith("HTTP 500"), true);
  } finally { await fake.close(); summarizer._reset(); }
});

test("summarizer: timeout and refusal fall back to null; off provider never calls out", async () => {
  summarizer._reset();
  const slow = await fakeModelServer(() => ({ delayMs: 500 }));
  try {
    assert.strictEqual(await summarizer.complete({ system: "S", user: "U", env: { SUMMARY_PROVIDER: "ollama", SUMMARY_OLLAMA_URL: slow.url, SUMMARY_TIMEOUT_MS: "50" }, logger: quiet }), null);
    assert.strictEqual(summarizer.status({}).lastError, "timeout");
  } finally { await slow.close(); summarizer._reset(); }
  const refuse = await fakeModelServer(() => ({ json: { stop_reason: "refusal", content: [] } }));
  try {
    assert.strictEqual(await summarizer.complete({ system: "S", user: "U", env: { SUMMARY_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", SUMMARY_ANTHROPIC_URL: refuse.url }, logger: quiet }), null);
  } finally { await refuse.close(); summarizer._reset(); }
  assert.strictEqual(await summarizer.complete({ system: "S", user: "U", env: {} }), null);
  assert.strictEqual(summarizer.available({}), false);
});

test("summarizer: claude-cli uses the logged-in CLI (no API key), from a temp dir", async () => {
  summarizer._reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-cli-"));
  const log = path.join(dir, "argv.json");
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, `#!/usr/bin/env node
require("fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
process.stdout.write("  Testleri çalıştırıyor.\\n");
`);
  fs.chmodSync(bin, 0o755);
  try {
    const env = { SUMMARY_PROVIDER: "claude-cli", CLAUDE_BIN: bin };
    assert.strictEqual(summarizer.resolveProvider({ SUMMARY_PROVIDER: "claude" }), "claude-cli");
    assert.strictEqual(summarizer.config(env).timeoutMs, 20000);
    const r = await summarizer.complete({ system: "SYS", user: "USER", env, logger: quiet });
    assert.strictEqual(r.text, "Testleri çalıştırıyor.");
    assert.strictEqual(r.provider, "claude-cli");
    const seen = JSON.parse(fs.readFileSync(log, "utf8"));
    assert.deepStrictEqual(seen.argv, ["-p", "--model", "haiku", "--system-prompt", "SYS", "--output-format", "text", "USER"]);
    assert.strictEqual(fs.realpathSync(seen.cwd), fs.realpathSync(os.tmpdir()));

    fs.writeFileSync(bin, "#!/usr/bin/env node\nprocess.stderr.write('not logged in'); process.exit(1);\n");
    summarizer._reset();
    assert.strictEqual(await summarizer.complete({ system: "S", user: "U", env, logger: quiet }), null);
    assert.match(summarizer.status(env).lastError, /claude exited 1: not logged in/);

    fs.writeFileSync(bin, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n");
    summarizer._reset();
    assert.strictEqual(await summarizer.complete({ system: "S", user: "U", env: Object.assign({ SUMMARY_TIMEOUT_MS: "200" }, env), logger: quiet }), null);
    assert.strictEqual(summarizer.status(env).lastError, "timeout");
  } finally { summarizer._reset(); }
});

// ---------- narrator helpers ----------

test("isReadFullCommand matches English and Turkish phrases, configurable", () => {
  assert.strictEqual(narrator.isReadFullCommand("Read the full answer.", {}), true);
  assert.strictEqual(narrator.isReadFullCommand("TAM CEVABI OKU", {}), true);
  assert.strictEqual(narrator.isReadFullCommand("tam cevabı oku!", {}), true);
  assert.strictEqual(narrator.isReadFullCommand("read the full answer to the file", {}), false);
  assert.strictEqual(narrator.isReadFullCommand("hepsini oku", { NARRATOR_READ_FULL_PHRASES: "hepsini oku|baştan oku" }), true);
  assert.strictEqual(narrator.isReadFullCommand("tam cevabı oku", { NARRATOR_READ_FULL_PHRASES: "hepsini oku" }), false);
});

test("approvalText: per-language templates, override, speakable action", () => {
  const s = { name: "api" };
  assert.strictEqual(narrator.approvalText(s, { description: "Run `npm test`" }, {}), "api is waiting for your approval: Run npm test.");
  assert.strictEqual(narrator.approvalText(s, { description: "git push origin main" }, { NARRATOR_LANG: "tr" }), "api onayını bekliyor: git push origin main.");
  assert.strictEqual(narrator.approvalText(s, {}, { NARRATOR_LANG: "tr" }), "api onayını bekliyor.");
  assert.strictEqual(narrator.approvalText(s, { tool: "Bash" }, { NARRATOR_APPROVAL_TEXT: "Onay: {action} ({session})" }), "Onay: Bash (api)");
});

test("listening flag expires on its own", async () => {
  narrator.setListening(true, 30);
  assert.strictEqual(narrator.isListening(), true);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(narrator.isListening(), false);
  narrator.setListening(true); narrator.setListening(false);
  assert.strictEqual(narrator.isListening(), false);
});

// ---------- per-turn pipeline ----------

function pipe({ env = {}, session, summarize, available = () => true }) {
  const out = [];
  const p = narrator.createVoicePipeline({
    session: session || { id: "s", name: "api", voice: true, runner: "local" },
    prompt: "run the tests",
    rawEmit: (e) => out.push(e),
    env: Object.assign({ NARRATOR_INTERVAL_MS: "0" }, env),
    summarize: summarize || (async () => null),
    isAvailable: available,
    logger: quiet,
  });
  return { p, out };
}
const tick = () => new Promise((r) => setImmediate(r));
const LONG = "First I looked at the failing suite and found the cause. ".repeat(8);

test("pipeline: long reply is replaced by a final summary; deltas still reach the chat", async () => {
  const calls = [];
  const session = { id: "s", name: "api", voice: true, runner: "local" };
  const { p, out } = pipe({ session, summarize: async (a) => { calls.push(a); return { text: "Fixed it; all tests pass.", ms: 42 }; } });
  assert.strictEqual(p.narrate, true);
  assert.strictEqual(p.buffering, true);
  p.emit({ type: "delta", text: LONG });
  p.emit({ type: "delta", text: "\n```js\nconsole.log(1)\n```\nDone." });
  assert.ok(!out.some((e) => e.type === "speech")); // held back
  p.emit({ type: "done" });
  await tick();
  const types = out.map((e) => e.type);
  assert.deepStrictEqual(types, ["delta", "delta", "narration", "done"]);
  assert.deepStrictEqual(out[2], { type: "narration", kind: "final", text: "Fixed it; all tests pass.", ms: 42, full: true });
  assert.strictEqual(calls[0].label, "final");
  assert.match(calls[0].user, /console\.log/); // the model sees the full reply
  assert.strictEqual(session.lastReply.summary, "Fixed it; all tests pass.");
  assert.match(session.lastReply.text, /console\.log\(1\)/);
});

test("pipeline: short replies are read as-is without calling the model", async () => {
  let called = 0;
  const { p, out } = pipe({ summarize: async () => { called++; return { text: "x", ms: 1 }; } });
  p.emit({ type: "delta", text: "All green. Want me to push?" });
  p.emit({ type: "done" });
  await tick();
  assert.strictEqual(called, 0);
  assert.deepStrictEqual(out.filter((e) => e.type === "speech").map((e) => e.text).join(" "), "All green. Want me to push?");
  assert.strictEqual(out[out.length - 1].type, "done");
});

test("pipeline: summarizer failure falls back to the raw spoken reply", async () => {
  const { p, out } = pipe({ summarize: async () => null });
  p.emit({ type: "delta", text: LONG });
  p.emit({ type: "done" });
  await tick();
  const speech = out.filter((e) => e.type === "speech");
  assert.strictEqual(speech.length, 1);
  assert.match(speech[0].text, /First I looked/);
  assert.ok(!out.some((e) => e.type === "narration"));
  assert.strictEqual(out[out.length - 1].type, "done");
});

test("pipeline: no summarizer → streams speech like Stage 1 (no buffering)", async () => {
  const { p, out } = pipe({ available: () => false });
  assert.strictEqual(p.buffering, false);
  p.emit({ type: "delta", text: "One. Two" });
  assert.deepStrictEqual(out.map((e) => e.type), ["delta", "speech"]);
  p.emit({ type: "done" });
  assert.deepStrictEqual(out.map((e) => e.type), ["delta", "speech", "speech", "done"]); // synchronous
});

test("pipeline: off for non-voice sessions, cloud runner, or NARRATOR=0", () => {
  assert.strictEqual(pipe({ session: { id: "s", voice: false, runner: "local" } }).p.narrate, false);
  assert.strictEqual(pipe({ session: { id: "s", voice: true, runner: "cloud" } }).p.narrate, false);
  assert.strictEqual(pipe({ env: { NARRATOR: "0" } }).p.narrate, false);
  assert.strictEqual(pipe({ env: { NARRATOR_FINAL_SUMMARY: "0" } }).p.buffering, false);
  const off = pipe({ session: { id: "s", voice: false, runner: "local" } });
  off.p.emit({ type: "approval_request", tool: "Bash", description: "rm -rf build" });
  assert.ok(!off.out.some((e) => e.type === "narration"));
});

test("pipeline: approval requests are announced immediately", () => {
  const { p, out } = pipe({ env: { NARRATOR_LANG: "tr" } });
  p.emit({ type: "approval_request", id: "a1", tool: "Bash", description: "git push" });
  assert.deepStrictEqual(out[1], { type: "narration", kind: "approval", text: "api onayını bekliyor: git push." });
});

test("pipeline: progress narration summarizes new activity only, skips while the user speaks", async () => {
  const calls = [];
  const { p, out } = pipe({ summarize: async (a) => { calls.push(a); return { text: "Running the tests.", ms: 7 }; } });
  await p.progressTick(); // nothing yet
  assert.strictEqual(calls.length, 0);
  p.emit({ type: "activity", text: "Edit app.js", tool: "Edit" });
  p.emit({ type: "activity", text: "Bash npm test", tool: "Bash" });
  p.emit({ type: "tool_result", error: true });
  narrator.setListening(true);
  await p.progressTick();
  assert.strictEqual(calls.length, 0); // user is talking
  narrator.setListening(false);
  await p.progressTick();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].label, "progress");
  assert.match(calls[0].user, /run the tests/);
  assert.match(calls[0].user, /Edit app\.js[\s\S]*Bash npm test[\s\S]*failed/);
  assert.deepStrictEqual(out.filter((e) => e.type === "narration"), [{ type: "narration", kind: "progress", text: "Running the tests.", ms: 7 }]);
  await p.progressTick(); // nothing new since
  assert.strictEqual(calls.length, 1);
});

test("pipeline: error flushes held speech before the error", () => {
  const { p, out } = pipe({});
  p.emit({ type: "delta", text: "Partial answer. More" });
  p.emit({ type: "error", error: "boom" });
  assert.deepStrictEqual(out.slice(1).map((e) => e.type), ["speech", "error"]);
  assert.strictEqual(out[1].text, "Partial answer. More.");
});

test("pipeline: deferEnd holds res.end until the final summary is written", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { p, out } = pipe({ summarize: async () => { await gate; return { text: "Short summary.", ms: 5 }; } });
  const ended = [];
  const res = { end: () => ended.push(out.length), on() {} };
  p.deferEnd(res);
  p.emit({ type: "delta", text: LONG });
  p.emit({ type: "done" });
  res.end();
  await tick();
  assert.strictEqual(ended.length, 0);
  release();
  await tick(); await tick();
  assert.strictEqual(ended.length, 1);
  assert.strictEqual(out[out.length - 1].type, "done");
  assert.strictEqual(ended[0], out.length); // ended after done was written
});

// ---------- end-to-end through the bridge ----------

const boot = srv.createSession({ name: "default", agent: "claude", projectDir: process.cwd() });
srv.defaultSessionId = boot.id;
const server = srv.buildServer();
test.before(() => new Promise((r) => server.listen(0, "127.0.0.1", r)));
test.after(() => new Promise((r) => server.close(r)));

function writeStub(dir, name, body) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, "#!/usr/bin/env node\n" + body);
  fs.chmodSync(f, 0o755);
  return f;
}

test("e2e: voice turn → final summary from the model, then 'tam cevabı oku' reads the full reply", async () => {
  summarizer._reset();
  const fake = await fakeModelServer(() => ({ json: { message: { content: "Testler geçti, iki dosya düzenlendi." } } }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-narr-"));
  const long = "Ran the whole suite and fixed the flaky test in the sync module. ".repeat(6);
  const stub = writeStub(dir, "claude", `
const out = (c) => process.stdout.write(JSON.stringify({type:"assistant",message:{content:c}})+"\\n");
out([{type:"tool_use",id:"t1",name:"Bash",input:{command:"npm test"}}]);
process.stdout.write(JSON.stringify({type:"user",message:{content:[{type:"tool_result",tool_use_id:"t1",is_error:false}]}})+"\\n");
out([{type:"text",text:${JSON.stringify(long)}}]);
process.stdout.write(JSON.stringify({type:"result",subtype:"success"})+"\\n");
`);
  const lines = [];
  const origLog = console.log;
  console.log = (l) => { lines.push(String(l)); };
  try {
    await withEnv({ CLAUDE_BIN: stub, SUMMARY_PROVIDER: "ollama", SUMMARY_OLLAMA_URL: fake.url, PERSISTENT_SESSIONS: null, NARRATOR: null, NARRATOR_LOG: null }, async () => {
      const { session } = JSON.parse((await request(server, "POST", "/api/sessions", { name: "api", agent: "claude", projectDir: process.cwd(), voice: true })).data);
      const r = await request(server, "POST", "/api/ask", { text: "testleri çalıştır", sessionId: session.id });
      assert.strictEqual(r.headers["x-vb-narrator"], "1");
      const evs = ndjson(r.data);
      assert.ok(evs.some((e) => e.type === "activity" && e.tool === "Bash"));
      assert.ok(evs.some((e) => e.type === "tool_result" && e.error === false));
      const fin = evs.find((e) => e.type === "narration" && e.kind === "final");
      assert.strictEqual(fin.text, "Testler geçti, iki dosya düzenlendi.");
      assert.ok(!evs.some((e) => e.type === "speech")); // summary replaced the raw readout
      assert.strictEqual(evs[evs.length - 1].type, "done");
      assert.strictEqual(evs.filter((e) => e.type === "delta").map((e) => e.text).join(""), long); // chat keeps everything
      assert.ok(lines.some((l) => /\[narrator\] final ok provider=ollama model=llama3\.2 \+\d+ms/.test(l)), lines.join("\n"));

      const last = JSON.parse((await request(server, "GET", `/api/sessions/${session.id}/last-reply`)).data).lastReply;
      assert.strictEqual(last.text, long);
      assert.strictEqual(last.summary, "Testler geçti, iki dosya düzenlendi.");

      const before = fake.seen.length;
      const rf = ndjson((await request(server, "POST", "/api/ask", { text: "Tam cevabı oku", sessionId: session.id })).data);
      assert.strictEqual(fake.seen.length, before); // no model, no agent
      const spoken = rf.filter((e) => e.type === "speech").map((e) => e.text).join(" ");
      assert.match(spoken, /fixed the flaky test in the sync module/);
      assert.ok(rf.filter((e) => e.type === "speech").length >= 6); // sentence-sized chunks
      assert.strictEqual(rf[rf.length - 1].type, "done");
    });
  } finally {
    console.log = origLog;
    await fake.close();
    summarizer._reset();
  }
});

test("e2e: unreachable summarizer → raw speech, silently", async () => {
  summarizer._reset();
  await withEnv({ SUMMARY_PROVIDER: "ollama", SUMMARY_OLLAMA_URL: "http://127.0.0.1:9", SUMMARY_TIMEOUT_MS: "500", NARRATOR_LOG: "0", PERSISTENT_SESSIONS: null }, async () => {
    const { session } = JSON.parse((await request(server, "POST", "/api/sessions", { agent: "codex", projectDir: process.cwd(), voice: true })).data);
    const long = "x ".repeat(10) + "This is a sentence that is long enough. ".repeat(10);
    const evs = ndjson((await request(server, "POST", "/api/ask", { text: long, sessionId: session.id })).data);
    assert.ok(evs.some((e) => e.type === "speech"));
    assert.ok(!evs.some((e) => e.type === "narration"));
    assert.strictEqual(evs[evs.length - 1].type, "done");
  });
  summarizer._reset();
});

test("read-full with no previous answer, listening + narrator status endpoints", async () => {
  const { session } = JSON.parse((await request(server, "POST", "/api/sessions", { agent: "codex", projectDir: process.cwd() })).data);
  const evs = ndjson((await request(server, "POST", "/api/ask", { text: "read the full answer", sessionId: session.id })).data);
  assert.match(evs.find((e) => e.type === "speech").text, /no previous answer/i);
  const l = JSON.parse((await request(server, "POST", "/api/listening", { active: true })).data);
  assert.strictEqual(l.listening, true);
  const st = JSON.parse((await request(server, "GET", "/api/narrator")).data);
  assert.strictEqual(st.listening, true);
  assert.ok(st.narrator && st.summarizer);
  await request(server, "POST", "/api/listening", { active: false });
  assert.strictEqual(narrator.isListening(), false);
  assert.strictEqual((await request(server, "GET", "/api/sessions/nope/last-reply")).status, 404);
});
