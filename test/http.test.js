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

// Boot a default session and start a server on an ephemeral port.
const boot = srv.createSession({ name: "default", agent: "claude", projectDir: process.cwd() });
srv.defaultSessionId = boot.id;
const server = srv.buildServer();

test.before(() => new Promise((r) => server.listen(0, "127.0.0.1", r)));
test.after(() => new Promise((r) => server.close(r)));

test("push endpoints: key disabled by default, subscribe validates", async () => {
  const key = JSON.parse((await request(server, "GET", "/api/push/key")).data);
  assert.strictEqual(key.enabled, false); // no VAPID env in tests
  assert.strictEqual((await request(server, "POST", "/api/push/subscribe", { subscription: {} })).status, 400);
  // non-https endpoints are rejected (SSRF hardening)
  assert.strictEqual((await request(server, "POST", "/api/push/subscribe", { subscription: { endpoint: "http://internal/x" } })).status, 400);
  const ok = await request(server, "POST", "/api/push/subscribe", { subscription: { endpoint: "https://example.com/x", keys: { p256dh: "a", auth: "b" } }, sessionId: boot.id });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(JSON.parse(ok.data).ok, true);
});

test("a malformed percent-encoded path returns 400, not a crash", async () => {
  assert.strictEqual((await request(server, "GET", "/%E0%A4%A")).status, 400);
  // server is still responsive afterwards
  assert.strictEqual((await request(server, "GET", "/api/health")).status, 200);
});

test("responses carry security headers", async () => {
  const r = await request(server, "GET", "/api/health");
  assert.strictEqual(r.headers["x-content-type-options"], "nosniff");
  assert.strictEqual(r.headers["x-frame-options"], "DENY");
  assert.match(r.headers["content-security-policy"], /default-src 'self'/);
});

test("GET /api/health reports ok, version, and session count", async () => {
  const { status, data } = await request(server, "GET", "/api/health");
  assert.strictEqual(status, 200);
  const h = JSON.parse(data);
  assert.strictEqual(h.ok, true);
  assert.match(h.version, /^\d+\.\d+\.\d+/);
  assert.ok(typeof h.sessions === "number" && h.sessions >= 1);
});

test("GET /api/config advertises agents, their modes, and the default session", async () => {
  const { status, data } = await request(server, "GET", "/api/config");
  assert.strictEqual(status, 200);
  const cfg = JSON.parse(data);
  assert.deepStrictEqual(cfg.agents.map((a) => a.id).sort(), ["antigravity", "claude", "codex", "ollama"]);
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

test("voice mode prepends the TTS preamble to the prompt sent to the agent", async () => {
  // codex stub echoes its stdin, so we can see the effective prompt.
  const create = await request(server, "POST", "/api/sessions", { agent: "codex", projectDir: process.cwd(), voice: true });
  const { session } = JSON.parse(create.data);
  assert.strictEqual(session.voice, true);
  const { data } = await request(server, "POST", "/api/ask", { text: "do x", sessionId: session.id });
  const text = ndjson(data).filter((e) => e.type === "delta").map((e) => e.text).join("");
  assert.match(text, /text-to-speech/i);
  assert.match(text, /do x/);
});

test("a session can be renamed via POST /api/sessions/:id", async () => {
  const create = await request(server, "POST", "/api/sessions", { name: "old", agent: "claude", projectDir: process.cwd() });
  const { session } = JSON.parse(create.data);
  const upd = await request(server, "POST", "/api/sessions/" + session.id, { name: "new name" });
  assert.strictEqual(upd.status, 200);
  assert.strictEqual(JSON.parse(upd.data).session.name, "new name");
  const miss = await request(server, "POST", "/api/sessions/nope", { name: "x" });
  assert.strictEqual(miss.status, 404);
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

test("/api/reset clears the rolling-conversation flag", async () => {
  await request(server, "POST", "/api/ask", { text: "hi", sessionId: boot.id });
  assert.strictEqual(srv.sessions.get(boot.id).started, true);
  assert.strictEqual((await request(server, "POST", "/api/reset", { sessionId: boot.id })).status, 200);
  assert.strictEqual(srv.sessions.get(boot.id).started, false);
});

test("ask surfaces a friendly error when the agent binary is missing", async () => {
  const prev = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = "/no/such/bin-xyz";
  try {
    const { session } = JSON.parse((await request(server, "POST", "/api/sessions", { agent: "claude", projectDir: process.cwd() })).data);
    const evs = ndjson((await request(server, "POST", "/api/ask", { text: "hi", sessionId: session.id })).data);
    assert.ok(evs.some((e) => e.type === "error" && /Could not find/.test(e.error)));
  } finally { process.env.CLAUDE_BIN = prev; }
});

test("ask surfaces stderr when the agent exits non-zero", async () => {
  const stub = path.join(os.tmpdir(), "vb-fail-" + Date.now() + ".js");
  fs.writeFileSync(stub, '#!/usr/bin/env node\nprocess.stderr.write("boom");process.exit(2);\n');
  fs.chmodSync(stub, 0o755);
  const prev = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = stub;
  try {
    const { session } = JSON.parse((await request(server, "POST", "/api/sessions", { agent: "claude", projectDir: process.cwd() })).data);
    const evs = ndjson((await request(server, "POST", "/api/ask", { text: "hi", sessionId: session.id })).data);
    assert.ok(evs.some((e) => e.type === "error" && /boom/.test(e.error)));
  } finally { process.env.CLAUDE_BIN = prev; fs.unlinkSync(stub); }
});

test("cloud runner connection failure surfaces an error", async () => {
  process.env.CLOUD_RUNNER_URL = "http://127.0.0.1:1/";
  try {
    const { session } = JSON.parse((await request(server, "POST", "/api/sessions", { agent: "claude", runner: "cloud", projectDir: "/x" })).data);
    const evs = ndjson((await request(server, "POST", "/api/ask", { text: "hi", sessionId: session.id })).data);
    assert.ok(evs.some((e) => e.type === "error" && /cloud runner/.test(e.error)));
  } finally { delete process.env.CLOUD_RUNNER_URL; }
});

test("/api/stt is rejected when whisper is not configured", async () => {
  const r = await request(server, "POST", "/api/stt", "x", { "Content-Type": "audio/webm" });
  assert.strictEqual(r.status, 500);
});

test("/api/browse lists subdirectories with a parent link", async () => {
  const data = JSON.parse((await request(server, "GET", "/api/browse?path=" + encodeURIComponent(process.cwd()))).data);
  assert.strictEqual(data.path, process.cwd());
  assert.ok(Array.isArray(data.dirs) && data.dirs.includes("public") && data.dirs.includes("test"));
  assert.ok(!data.dirs.includes(".git")); // dotfiles hidden
  assert.strictEqual(typeof data.parent, "string");
});

test("/api/commands lists the project's npm scripts for a session", async () => {
  const { defaultSessionId } = JSON.parse((await request(server, "GET", "/api/sessions")).data);
  const data = JSON.parse((await request(server, "GET", "/api/commands?sessionId=" + defaultSessionId)).data);
  const npm = (data.groups || []).find((g) => /npm/.test(g.label));
  assert.ok(npm && npm.items.some((it) => it.value === "npm run test"));
});

test("unknown method and endpoint", async () => {
  assert.strictEqual((await request(server, "POST", "/")).status, 405);
  assert.strictEqual((await request(server, "GET", "/api/nope")).status, 404);
});

test("the concurrency cap rejects with 429", async () => {
  const prev = process.env.MAX_INFLIGHT;
  process.env.MAX_INFLIGHT = "0"; // every turn exceeds the cap
  try {
    assert.strictEqual((await request(server, "POST", "/api/ask", { text: "hi", sessionId: boot.id })).status, 429);
  } finally {
    if (prev === undefined) delete process.env.MAX_INFLIGHT; else process.env.MAX_INFLIGHT = prev;
  }
});

test("activity events are streamed for claude tool_use", async () => {
  const stub = path.join(os.tmpdir(), "vb-claude-act-" + Date.now() + ".js");
  fs.writeFileSync(stub, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"tool_use",name:"Edit",input:{file_path:"/r/app.js"}}]}})+"\\n");
process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"done."}]}})+"\\n");
process.stdout.write(JSON.stringify({type:"result",subtype:"success"})+"\\n");
`);
  fs.chmodSync(stub, 0o755);
  const prev = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = stub;
  try {
    const { session } = JSON.parse((await request(server, "POST", "/api/sessions", { agent: "claude", projectDir: process.cwd() })).data);
    const evs = ndjson((await request(server, "POST", "/api/ask", { text: "hi", sessionId: session.id })).data);
    assert.ok(evs.some((e) => e.type === "activity" && /Edit app\.js/.test(e.text)));
    assert.ok(evs.some((e) => e.type === "delta" && /done/.test(e.text)));
  } finally {
    process.env.CLAUDE_BIN = prev; fs.unlinkSync(stub);
  }
});

test("ollama HTTP backend streams and keeps conversation history", async () => {
  const ollama = http.createServer((rq, rs) => {
    if (rq.url === "/api/tags") { rs.writeHead(200); return rs.end(JSON.stringify({ models: [{ name: "llama3.2" }, { name: "qwen" }] })); }
    if (rq.url === "/api/chat") {
      let b = ""; rq.on("data", (c) => (b += c)); rq.on("end", () => {
        const msgs = (JSON.parse(b || "{}").messages) || [];
        rs.writeHead(200, { "Content-Type": "application/x-ndjson" });
        rs.write(JSON.stringify({ message: { role: "assistant", content: "msgs=" + msgs.length } }) + "\n");
        rs.end(JSON.stringify({ done: true }) + "\n");
      });
      return;
    }
    rs.writeHead(404); rs.end();
  });
  await new Promise((r) => ollama.listen(0, "127.0.0.1", r));
  process.env.OLLAMA_URL = "http://127.0.0.1:" + ollama.address().port;
  try {
    const { session } = JSON.parse((await request(server, "POST", "/api/sessions", { agent: "ollama", projectDir: process.cwd() })).data);
    assert.strictEqual(session.agent, "ollama");
    let evs = ndjson((await request(server, "POST", "/api/ask", { text: "hi", sessionId: session.id })).data);
    assert.strictEqual(evs.filter((e) => e.type === "delta").map((e) => e.text).join(""), "msgs=1");
    assert.strictEqual(evs[evs.length - 1].type, "done");
    evs = ndjson((await request(server, "POST", "/api/ask", { text: "again", sessionId: session.id })).data);
    assert.strictEqual(evs.filter((e) => e.type === "delta").map((e) => e.text).join(""), "msgs=3"); // user+assistant+user
    const m = JSON.parse((await request(server, "GET", "/api/ollama/models")).data);
    assert.deepStrictEqual(m.models, ["llama3.2", "qwen"]);
  } finally {
    delete process.env.OLLAMA_URL;
    await new Promise((r) => ollama.close(r));
  }
});

test("cloud runner: /api/ask proxies to CLOUD_RUNNER_URL", async () => {
  // A stub remote runner that speaks our NDJSON protocol.
  const remote = http.createServer((rq, rs) => {
    let body = ""; rq.on("data", (c) => (body += c)); rq.on("end", () => {
      const payload = JSON.parse(body || "{}");
      rs.writeHead(200, { "Content-Type": "application/x-ndjson" });
      rs.write(JSON.stringify({ type: "activity", text: "Edit x.js" }) + "\n");
      rs.write(JSON.stringify({ type: "delta", text: "cloud:" + payload.text }) + "\n");
      rs.end(JSON.stringify({ type: "done" }) + "\n");
    });
  });
  await new Promise((r) => remote.listen(0, "127.0.0.1", r));
  process.env.CLOUD_RUNNER_URL = "http://127.0.0.1:" + remote.address().port + "/";
  try {
    const create = await request(server, "POST", "/api/sessions", { agent: "claude", runner: "cloud", projectDir: "/remote/only" });
    assert.strictEqual(create.status, 200);
    const { session } = JSON.parse(create.data);
    assert.strictEqual(session.runner, "cloud");
    const evs = ndjson((await request(server, "POST", "/api/ask", { text: "hi", sessionId: session.id })).data);
    assert.ok(evs.some((e) => e.type === "activity" && /Edit x\.js/.test(e.text))); // forwarded unchanged
    assert.ok(evs.some((e) => e.type === "delta" && /cloud:hi/.test(e.text)));
    assert.strictEqual(evs[evs.length - 1].type, "done");
  } finally {
    delete process.env.CLOUD_RUNNER_URL;
    await new Promise((r) => remote.close(r));
  }
});
