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
const va = require("../src/services/voice-agent");
const turns = require("../src/services/turns");
const summarizer = require("../src/services/summarizer");

const quiet = { log() {} };

// ---------- pure helpers ----------

test("isRisky flags commit/push/delete/deploy in English and Turkish", () => {
  for (const s of ["commit the changes", "git push origin main", "delete the build folder", "rm -rf dist", "reset --hard HEAD~1",
    "force push it", "deploy to prod", "değişiklikleri commitle", "bunu pushla", "eski dosyaları sil", "logları kaldır", "siteyi yayınla"]) {
    assert.strictEqual(va.isRisky(s), true, s);
  }
  for (const s of ["run the tests", "testleri çalıştır", "add a README section", "silence the warning", "explain the diff"]) {
    assert.strictEqual(va.isRisky(s), false, s);
  }
});

test("classifyConfirmation", () => {
  assert.strictEqual(va.classifyConfirmation("Evet, onaylıyorum."), "yes");
  assert.strictEqual(va.classifyConfirmation("yes go ahead"), "yes");
  assert.strictEqual(va.classifyConfirmation("Hayır"), "no");
  assert.strictEqual(va.classifyConfirmation("iptal et"), "no");
  assert.strictEqual(va.classifyConfirmation("cancel that"), "no");
  assert.strictEqual(va.classifyConfirmation("api'de testleri çalıştır"), null);
});

test("resolveTarget: active by default, by name or project, ambiguity reported", () => {
  const list = [
    { id: "s1", name: "api", projectDir: "/w/backend-api" },
    { id: "s2", name: "web", projectDir: "/w/frontend" },
    { id: "s3", name: "web docs", projectDir: "/w/docs" },
  ];
  assert.strictEqual(va.resolveTarget(undefined, list, list[0]).session.id, "s1");
  assert.strictEqual(va.resolveTarget("active", list, list[1]).session.id, "s2");
  assert.strictEqual(va.resolveTarget("API", list, list[1]).session.id, "s1");
  assert.strictEqual(va.resolveTarget("frontend", list, list[0]).session.id, "s2");
  assert.strictEqual(va.resolveTarget("s3", list, list[0]).session.id, "s3");
  assert.strictEqual(va.resolveTarget("docs", list, list[0]).session.id, "s3");
  assert.deepStrictEqual(va.resolveTarget("we", list, list[0]).ambiguous.map((s) => s.id), ["s2", "s3"]);
  assert.strictEqual(va.resolveTarget("mobile", list, list[0]).none, true);
});

test("parsePlan accepts fenced JSON, drops unknown tools, rejects junk", () => {
  const p = va.parsePlan('```json\n{"actions":[{"tool":"stop_session","session":"api"},{"tool":"rm","session":"x"},{"tool":"send_to_session","session":"api","text":"add X"}],"say":"Ok.","risky":false}\n```');
  assert.deepStrictEqual(p.actions.map((a) => a.tool), ["stop_session", "send_to_session"]);
  assert.strictEqual(p.say, "Ok.");
  assert.strictEqual(va.parsePlan("I think you should run tests"), null);
  assert.strictEqual(va.parsePlan('{"actions":[{"tool":"send_to_session","session":"api","text":""}]}'), null);
  assert.strictEqual(va.parsePlan('{"actions":[]}'), null);
  assert.strictEqual(va.parsePlan('{"actions":[],"ask":"Which session?"}').ask, "Which session?");
});

test("statusText: busy with last step, idle with last answer summary (tr)", () => {
  const env = { NARRATOR_LANG: "tr" };
  assert.strictEqual(va.statusText({ name: "api" }, { runningMs: 150000, lastActivity: "Bash npm test" }, env), "api çalışıyor, 2 dakika oldu. Son adım: Bash npm test.");
  assert.strictEqual(va.statusText({ name: "api", lastReply: { text: "Testler geçti. Detaylar uzun.", summary: null } }, null, env), "api boşta. Son cevap: Testler geçti.");
  assert.strictEqual(va.statusText({ name: "api" }, null, {}), "api is idle.");
});

test("enabledFor: off by default; env or per-request flag; only in voice mode", () => {
  const voiceS = { voice: true };
  assert.strictEqual(va.enabledFor(voiceS, undefined, {}), false);
  assert.strictEqual(va.enabledFor(voiceS, undefined, { VOICE_AGENT: "1" }), true);
  assert.strictEqual(va.enabledFor(voiceS, false, { VOICE_AGENT: "1" }), false);
  assert.strictEqual(va.enabledFor(voiceS, true, {}), true);
  assert.strictEqual(va.enabledFor({ voice: false }, true, {}), false);
});

// ---------- handle() with fake deps ----------

function fakeRes() {
  const EventEmitter = require("events");
  const r = new EventEmitter();
  r.headersSent = false; r.lines = []; r.ended = false;
  r.writeHead = () => { r.headersSent = true; };
  r.write = (s) => { r.lines.push(JSON.parse(s)); return true; };
  r.end = () => { r.ended = true; r.emit("close"); };
  return r;
}
function fakeDeps(plan, extra = {}) {
  const sessions = extra.sessions || [
    { id: "s1", name: "api", projectDir: "/w/api", agent: "claude", voice: true },
    { id: "s2", name: "web", projectDir: "/w/web", agent: "claude", voice: true },
  ];
  const calls = { stop: [], send: [], model: [], broadcast: [] };
  const deps = {
    listSessions: () => sessions,
    getSession: (id) => sessions.find((s) => s.id === id) || null,
    complete: async (a) => { calls.model.push(a); return plan == null ? null : { text: typeof plan === "string" ? plan : JSON.stringify(plan), ms: 3 }; },
    streamAsk: (s, text, res) => {
      calls.send.push({ id: s.id, text, proxied: !!res.lines });
      if (res.lines) { res.write(JSON.stringify({ type: "delta", text: "agent:" + text })); res.write(JSON.stringify({ type: "done" })); return res.end(); }
      for (const ev of (extra.backgroundEvents || [])) res.write(JSON.stringify(ev) + "\n");
      res.end();
    },
    broadcast: (id, ev) => calls.broadcast.push({ id, ev }),
    stopTurn: async (id) => { calls.stop.push(id); return true; },
    isBusy: (id) => (extra.busy || []).includes(id),
    turnInfo: () => null,
    createSink: (onEvent) => turns.createSink(onEvent),
    streamHeaders: () => ({}),
    rawEmitter: (s, res) => (o) => res.write(JSON.stringify(o)),
    emitFullAnswer: (s, emit) => emit({ type: "speech", text: "FULL:" + s.lastReply.text }),
    logger: quiet,
  };
  return { deps, calls, sessions };
}
const speechOf = (res) => res.lines.filter((e) => e.type === "speech").map((e) => e.text).join(" ");

test("handle: 'stop, add X, then continue' stops and re-sends in one step", async () => {
  va.clearPending();
  const { deps, calls, sessions } = fakeDeps({
    actions: [{ tool: "stop_session", session: "api" }, { tool: "send_to_session", session: "api", text: "Also add input validation, then continue the previous task." }],
    say: "Stopping api and adding that.",
  });
  const res = fakeRes();
  assert.strictEqual(await va.handle({ text: "dur, validasyon da ekle, sonra devam et", active: sessions[0], res, deps, env: {} }), true);
  assert.deepStrictEqual(calls.stop, ["s1"]);
  assert.deepStrictEqual(calls.send, [{ id: "s1", text: "Also add input validation, then continue the previous task.", proxied: true }]);
  assert.match(calls.model[0].user, /\[ACTIVE\]/);
  assert.strictEqual(calls.model[0].raw, true);
  assert.strictEqual(res.lines[0].type, "router");
  assert.match(speechOf(res), /Stopping api/);
  assert.strictEqual(res.lines[res.lines.length - 1].type, "done");
});

test("handle: risky instruction is read back, then sent only after a spoken yes", async () => {
  va.clearPending();
  const { deps, calls, sessions } = fakeDeps({ actions: [{ tool: "send_to_session", session: "api", text: "Commit and push the fix" }], say: "" });
  const r1 = fakeRes();
  await va.handle({ text: "commitle ve pushla", active: sessions[0], res: r1, deps, env: { NARRATOR_LANG: "tr" } });
  assert.strictEqual(calls.send.length, 0);
  assert.strictEqual(speechOf(r1), "api oturumuna şunu göndereceğim: Commit and push the fix. Onaylıyor musun?");
  assert.ok(va.getPending());
  const r2 = fakeRes();
  await va.handle({ text: "evet", active: sessions[0], res: r2, deps, env: {} });
  assert.strictEqual(calls.model.length, 1); // confirmation needs no model call
  assert.deepStrictEqual(calls.send.map((c) => c.text), ["Commit and push the fix"]);
  assert.strictEqual(r2.lines[0].confirmed, true);
  assert.strictEqual(va.getPending(), null);
});

test("handle: model-flagged risk also asks; 'no' cancels", async () => {
  va.clearPending();
  const { deps, calls, sessions } = fakeDeps({ actions: [{ tool: "send_to_session", session: "api", text: "clean up the old migrations" }], risky: true });
  await va.handle({ text: "eski migrationları temizle", active: sessions[0], res: fakeRes(), deps, env: {} });
  assert.ok(va.getPending());
  const r = fakeRes();
  await va.handle({ text: "hayır", active: sessions[0], res: r, deps, env: { NARRATOR_LANG: "tr" } });
  assert.strictEqual(speechOf(r), "Tamam, iptal ettim.");
  assert.strictEqual(calls.send.length, 0);
});

test("handle: busy target without a stop → offers stop-and-send, yes executes both", async () => {
  va.clearPending();
  const { deps, calls, sessions } = fakeDeps({ actions: [{ tool: "send_to_session", session: "api", text: "use port 9000" }] }, { busy: ["s1"] });
  const r1 = fakeRes();
  await va.handle({ text: "port 9000 kullan", active: sessions[0], res: r1, deps, env: {} });
  assert.match(speechOf(r1), /api is still working\. Should I stop it and send: use port 9000\?/);
  await va.handle({ text: "yes", active: sessions[0], res: fakeRes(), deps, env: {} });
  assert.deepStrictEqual(calls.stop, ["s1"]);
  assert.deepStrictEqual(calls.send.map((c) => c.id), ["s1"]);
});

test("handle: other sessions run in the background; ambiguous names get a question", async () => {
  va.clearPending();
  const { deps, calls, sessions } = fakeDeps({ actions: [{ tool: "send_to_session", session: "web", text: "run the e2e tests" }] });
  const r = fakeRes();
  await va.handle({ text: "web'de e2e testlerini çalıştır", active: sessions[0], res: r, deps, env: {} });
  assert.deepStrictEqual(calls.send, [{ id: "s2", text: "run the e2e tests", proxied: false }]);
  assert.strictEqual(speechOf(r), "Sent to web.");
  assert.strictEqual(r.lines[r.lines.length - 1].type, "done");

  const amb = fakeDeps({ actions: [{ tool: "get_status", session: "mobile" }] });
  const r2 = fakeRes();
  await va.handle({ text: "mobile ne durumda", active: amb.sessions[0], res: r2, deps: amb.deps, env: {} });
  assert.strictEqual(speechOf(r2), "Which session? api, web.");

  const ask = fakeDeps({ actions: [], ask: "Hangi oturumda?" });
  const r3 = fakeRes();
  await va.handle({ text: "testleri çalıştır", active: ask.sessions[0], res: r3, deps: ask.deps, env: {} });
  assert.strictEqual(speechOf(r3), "Hangi oturumda?");
});

test("handle: background turns relay their approval and result to the session you are on", async () => {
  va.clearPending();
  const { deps, calls, sessions } = fakeDeps({ actions: [{ tool: "send_to_session", session: "web", text: "build it" }] }, {
    backgroundEvents: [
      { type: "narration", kind: "approval", text: "web is waiting for your approval: npm publish." },
      { type: "speech", text: "Build finished without errors." },
      { type: "speech", text: "Bundle is 120 kB. Extra detail." },
      { type: "done" },
    ],
  });
  await va.handle({ text: "web'de build al", active: sessions[0], res: fakeRes(), deps, env: { NARRATOR_LANG: "tr" } });
  assert.deepStrictEqual(calls.broadcast.map((b) => [b.id, b.ev.kind, b.ev.fromSessionId, b.ev.text]), [
    ["s1", "background", "s2", "web is waiting for your approval: npm publish."],
    ["s1", "background", "s2", "web bitti: Build finished without errors. Bundle is 120 kB."],
  ]);

  const sum = fakeDeps({ actions: [{ tool: "send_to_session", session: "web", text: "x" }] }, {
    backgroundEvents: [{ type: "narration", kind: "final", text: "All good." }, { type: "done" }],
  });
  await va.handle({ text: "x", active: sum.sessions[0], res: fakeRes(), deps: sum.deps, env: {} });
  assert.strictEqual(sum.calls.broadcast[0].ev.text, "web finished: All good.");

  const stopped = fakeDeps({ actions: [{ tool: "send_to_session", session: "web", text: "x" }] }, { backgroundEvents: [{ type: "done", stopped: true }] });
  await va.handle({ text: "x", active: stopped.sessions[0], res: fakeRes(), deps: stopped.deps, env: {} });
  assert.strictEqual(stopped.calls.broadcast.length, 0); // a stop the user asked for isn't announced again
});

test("handle: status, list and read_full_answer", async () => {
  va.clearPending();
  const { deps, sessions } = fakeDeps({ actions: [{ tool: "list_sessions" }, { tool: "get_status", session: "web" }, { tool: "read_full_answer", session: "api" }] });
  sessions[0].lastReply = { text: "Everything passed." };
  const r = fakeRes();
  await va.handle({ text: "durum?", active: sessions[0], res: r, deps, env: {} });
  assert.strictEqual(speechOf(r), "2 sessions: api, web. web is idle. FULL:Everything passed.");
});

test("handle: no model / unusable plan → returns false (caller falls back to the session)", async () => {
  va.clearPending();
  const none = fakeDeps(null);
  assert.strictEqual(await va.handle({ text: "hi", active: none.sessions[0], res: fakeRes(), deps: none.deps, env: {} }), false);
  const junk = fakeDeps("sure, I'll do that");
  const res = fakeRes();
  assert.strictEqual(await va.handle({ text: "hi", active: junk.sessions[0], res, deps: junk.deps, env: {} }), false);
  assert.strictEqual(res.headersSent, false);
});

// ---------- end-to-end ----------

const boot = srv.createSession({ name: "default", agent: "claude", projectDir: process.cwd() });
srv.defaultSessionId = boot.id;
const server = srv.buildServer();
test.before(() => new Promise((r) => server.listen(0, "127.0.0.1", r)));
test.after(() => new Promise((r) => server.close(r)));

function streamRequest(p, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method: "POST", path: p, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
      res.on("error", () => resolve(data));
      res.on("aborted", () => resolve(data));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

test("e2e: voice agent stops a running turn and re-sends with the added instruction", async () => {
  va.clearPending();
  summarizer._reset();
  const plans = [];
  const model = http.createServer((rq, rs) => {
    let b = ""; rq.on("data", (c) => (b += c)); rq.on("end", () => {
      const body = JSON.parse(b);
      plans.push(body);
      const isRouter = /voice router/.test(body.messages[0].content);
      const content = isRouter
        ? JSON.stringify({ actions: [{ tool: "stop_session", session: "api" }, { tool: "send_to_session", session: "api", text: "QUICK: also add validation, then continue" }], say: "" })
        : "summary";
      rs.writeHead(200, { "Content-Type": "application/json" });
      rs.end(JSON.stringify({ message: { content } }));
    });
  });
  await new Promise((r) => model.listen(0, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-va-"));
  const stub = path.join(dir, "claude");
  fs.writeFileSync(stub, `#!/usr/bin/env node
const prompt = process.argv[process.argv.length - 1];
const out = (t) => process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:t}]}})+"\\n");
if (/SLOW/.test(prompt)) { out("working on it. "); setInterval(() => {}, 1000); }
else { out("done: " + prompt); process.stdout.write(JSON.stringify({type:"result",subtype:"success"})+"\\n"); }
`);
  fs.chmodSync(stub, 0o755);
  const saved = { CLAUDE_BIN: process.env.CLAUDE_BIN, SUMMARY_PROVIDER: process.env.SUMMARY_PROVIDER, SUMMARY_OLLAMA_URL: process.env.SUMMARY_OLLAMA_URL, NARRATOR_LOG: process.env.NARRATOR_LOG, NARRATOR_INTERVAL_MS: process.env.NARRATOR_INTERVAL_MS };
  Object.assign(process.env, { CLAUDE_BIN: stub, SUMMARY_PROVIDER: "ollama", SUMMARY_OLLAMA_URL: "http://127.0.0.1:" + model.address().port, NARRATOR_LOG: "0", NARRATOR_INTERVAL_MS: "0" });
  try {
    const { session } = JSON.parse((await request(server, "POST", "/api/sessions", { name: "api", agent: "claude", projectDir: process.cwd(), voice: true })).data);
    const first = streamRequest("/api/ask", { text: "SLOW refactor", sessionId: session.id, voiceAgent: false });
    for (let i = 0; i < 100 && !turns.isBusy(session.id); i++) await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(turns.isBusy(session.id), true);

    const second = ndjson(await streamRequest("/api/ask", { text: "dur, validasyon da ekle sonra devam et", sessionId: session.id, voiceAgent: true }));
    const firstEvs = ndjson(await first);
    assert.ok(firstEvs.some((e) => e.type === "done" && e.stopped === true), JSON.stringify(firstEvs));

    assert.strictEqual(second[0].type, "router");
    assert.deepStrictEqual(second[0].actions.map((a) => a.tool), ["stop_session", "send_to_session"]);
    const text = second.filter((e) => e.type === "delta").map((e) => e.text).join("");
    assert.match(text, /done: QUICK: also add validation, then continue/);
    assert.strictEqual(second[second.length - 1].type, "done");
    assert.strictEqual(turns.isBusy(session.id), false);
  } finally {
    for (const k of Object.keys(saved)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; }
    await new Promise((r) => model.close(r));
    summarizer._reset();
  }
});

test("e2e: voice agent off or summarizer down → plain Stage 1–2 turn", async () => {
  va.clearPending();
  summarizer._reset();
  const saved = process.env.SUMMARY_PROVIDER;
  process.env.SUMMARY_PROVIDER = "off";
  try {
    const { session } = JSON.parse((await request(server, "POST", "/api/sessions", { agent: "codex", projectDir: process.cwd(), voice: true })).data);
    const evs = ndjson((await request(server, "POST", "/api/ask", { text: "hello there", sessionId: session.id, voiceAgent: true })).data);
    assert.ok(!evs.some((e) => e.type === "router"));
    assert.match(evs.filter((e) => e.type === "delta").map((e) => e.text).join(""), /echo:[\s\S]*hello there/);
  } finally {
    if (saved == null) delete process.env.SUMMARY_PROVIDER; else process.env.SUMMARY_PROVIDER = saved;
  }
});

test("turns.createSink behaves like a response for background turns", async () => {
  const seen = [];
  const sink = turns.createSink((ev) => seen.push(ev.type));
  sink.write(JSON.stringify({ type: "delta" }) + "\n" + JSON.stringify({ type: "done" }) + "\nnot json\n");
  assert.deepStrictEqual(seen, ["delta", "done"]);
  let closed = false;
  sink.on("close", () => { closed = true; });
  sink.writeHead(200, {});
  assert.strictEqual(sink.headersSent, true);
  assert.strictEqual(sink.write("x"), true);
  sink.end(); sink.end();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(closed, true);
});
