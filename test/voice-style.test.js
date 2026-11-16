"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { installStubAgents, request, ndjson } = require("./helpers");

installStubAgents();
const srv = require("../server.js");
const voiceStyle = require("../src/services/voice-style");
const { toSpeakable, createSpeechStream } = require("../src/services/speech-filter");
const { claudeAdapter } = require("../src/adapters/claude");
const { ollamaAdapter } = require("../src/adapters/ollama");
const { codexAdapter } = require("../src/adapters/codex");

const boot = srv.createSession({ name: "default", agent: "claude", projectDir: process.cwd() });
srv.defaultSessionId = boot.id;
const server = srv.buildServer();
test.before(() => new Promise((r) => server.listen(0, "127.0.0.1", r)));
test.after(() => new Promise((r) => server.close(r)));

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k];
  }
  const restore = () => { for (const k of Object.keys(saved)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } };
  try {
    const r = fn();
    if (r && typeof r.then === "function") return r.finally(restore);
    restore();
    return r;
  } catch (e) { restore(); throw e; }
}

// ---------- voice-style service ----------

test("voiceModeActive: follows the voice flag by default, explicit values win", () => {
  withEnv({ VOICE_MODE_DEFAULT: null }, () => {
    assert.strictEqual(voiceStyle.voiceModeActive({ voice: true }), true);
    assert.strictEqual(voiceStyle.voiceModeActive({ voice: false }), false);
    assert.strictEqual(voiceStyle.voiceModeActive({ voice: true, voiceMode: false }), false);
    assert.strictEqual(voiceStyle.voiceModeActive({ voice: false, voiceMode: true }), true);
    assert.strictEqual(voiceStyle.voiceModeActive(null), false);
  });
  withEnv({ VOICE_MODE_DEFAULT: "off" }, () => {
    assert.strictEqual(voiceStyle.voiceModeActive({ voice: true }), false);
    assert.strictEqual(voiceStyle.voiceModeActive({ voice: true, voiceMode: true }), true);
  });
});

test("normalizeVoiceMode keeps booleans and maps everything else to auto", () => {
  assert.strictEqual(voiceStyle.normalizeVoiceMode(true), true);
  assert.strictEqual(voiceStyle.normalizeVoiceMode(false), false);
  assert.strictEqual(voiceStyle.normalizeVoiceMode(null), undefined);
  assert.strictEqual(voiceStyle.normalizeVoiceMode("auto"), undefined);
  assert.strictEqual(voiceStyle.normalizeVoiceMode("yes"), undefined);
});

test("voiceStylePrompt: default, inline env (with \\n), and file override", () => {
  withEnv({ VOICE_STYLE_PROMPT: null, VOICE_STYLE_PROMPT_FILE: null }, () => {
    assert.strictEqual(voiceStyle.voiceStylePrompt(), voiceStyle.DEFAULT_VOICE_STYLE_PROMPT);
  });
  withEnv({ VOICE_STYLE_PROMPT: "Kısa konuş.\\nTürkçe cevap ver.", VOICE_STYLE_PROMPT_FILE: null }, () => {
    assert.strictEqual(voiceStyle.voiceStylePrompt(), "Kısa konuş.\nTürkçe cevap ver.");
  });
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vb-style-")), "style.txt");
  fs.writeFileSync(f, "  From a file.  \n");
  withEnv({ VOICE_STYLE_PROMPT: "inline", VOICE_STYLE_PROMPT_FILE: f }, () => {
    assert.strictEqual(voiceStyle.voiceStylePrompt(), "From a file.");
  });
  withEnv({ VOICE_STYLE_PROMPT: "inline", VOICE_STYLE_PROMPT_FILE: f + ".missing" }, () => {
    assert.strictEqual(voiceStyle.voiceStylePrompt(), "inline"); // unreadable file → falls back
  });
});

test("applyVoiceStyle routes the instruction per agent capability", () => {
  withEnv({ VOICE_STYLE_PROMPT: "STYLE", VOICE_STYLE_PROMPT_FILE: null, VOICE_MODE_DEFAULT: null }, () => {
    const on = { voice: true };
    assert.deepStrictEqual(voiceStyle.applyVoiceStyle(on, claudeAdapter, "hi"), { prompt: "hi", systemPrompt: "STYLE" });
    assert.deepStrictEqual(voiceStyle.applyVoiceStyle(on, ollamaAdapter, "hi"), { prompt: "hi", systemPrompt: "STYLE" });
    assert.deepStrictEqual(voiceStyle.applyVoiceStyle(on, codexAdapter, "hi"), { prompt: "STYLE\n\nhi", systemPrompt: "" });
    assert.deepStrictEqual(voiceStyle.applyVoiceStyle(on, null, "hi"), { prompt: "STYLE\n\nhi", systemPrompt: "" });
    // off → untouched
    assert.deepStrictEqual(voiceStyle.applyVoiceStyle({ voice: false }, claudeAdapter, "hi"), { prompt: "hi", systemPrompt: "" });
    // slash commands are never prefixed (they must stay the first token)
    assert.deepStrictEqual(voiceStyle.applyVoiceStyle(on, codexAdapter, " /help "), { prompt: "/help", systemPrompt: "" });
    assert.deepStrictEqual(voiceStyle.applyVoiceStyle(on, claudeAdapter, "/compact"), { prompt: "/compact", systemPrompt: "STYLE" });
  });
});

test("claude adapter passes --append-system-prompt only when given one", () => {
  const withSys = claudeAdapter.command("p", { systemPrompt: "STYLE" }).argv;
  const i = withSys.indexOf("--append-system-prompt");
  assert.ok(i >= 0);
  assert.strictEqual(withSys[i + 1], "STYLE");
  assert.strictEqual(withSys[withSys.length - 1], "p");
  assert.ok(!claudeAdapter.command("p", {}).argv.includes("--append-system-prompt"));
});

// ---------- speech filter ----------

test("toSpeakable drops code fences, markdown, links and long paths", () => {
  const md = [
    "## Done",
    "I fixed the bug in `src/services/hub.js` — see [the PR](https://github.com/x/y/pull/1).",
    "",
    "```js",
    "const a = 1;",
    "console.log(a);",
    "```",
    "",
    "- **Tests** pass",
    "- Updated /home/me/project/docs/configuration.md",
    "",
    "| File | Change |",
    "|------|--------|",
    "| a.js | edit |",
    "",
    "Details: https://example.com/very/long?x=1 > more",
  ].join("\n");
  const out = toSpeakable(md);
  assert.doesNotMatch(out, /const a|console\.log/);
  assert.doesNotMatch(out, /https?:|github\.com|example\.com/);
  assert.doesNotMatch(out, /[`*#|]/);
  assert.doesNotMatch(out, /\/home\/me/);
  assert.match(out, /^Done\./);
  assert.match(out, /I fixed the bug in hub\.js/);
  assert.match(out, /see the PR\./);
  assert.match(out, /Tests pass\./);
  assert.match(out, /configuration\.md/);
  assert.match(out, /File, Change\. a\.js, edit\./);
});

test("toSpeakable keeps plain sentences and snake_case intact", () => {
  assert.strictEqual(toSpeakable("All good. The user_id field is set!"), "All good. The user_id field is set!");
  assert.strictEqual(toSpeakable(""), "");
  assert.strictEqual(toSpeakable("```\nonly code\n```"), "");
});

test("createSpeechStream: sentence-by-sentence, never speaks a fence split across deltas", () => {
  const s = createSpeechStream();
  const spoken = [];
  const feed = (d) => { const t = s.push(d); if (t) spoken.push(t); };
  feed("Hello there. I am wor");
  assert.deepStrictEqual(spoken, ["Hello there."]);
  feed("king on it.\nHere is the code:\n``");
  feed("`python\nprint('secret')\n");
  feed("x = 1\n``");
  feed("`\nAll done. See [docs](http://x.y/z");
  feed(") for more.");
  const tail = s.flush(); if (tail) spoken.push(tail);
  const all = spoken.join(" ");
  assert.doesNotMatch(all, /print|secret|x = 1|python|http/);
  assert.match(all, /I am working on it\./);
  assert.match(all, /Here is the code:/);
  assert.match(all, /All done\./);
  assert.match(all, /See docs for more\./);
});

test("createSpeechStream: unterminated fence at end is dropped", () => {
  const s = createSpeechStream();
  assert.strictEqual(s.push("```\nrm -rf x\n"), "");
  assert.strictEqual(s.flush(), "");
  assert.strictEqual(s.push("Back to normal.\n"), "Back to normal.");
});

// ---------- end-to-end through the bridge ----------

function writeStub(dir, name, body) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, "#!/usr/bin/env node\n" + body);
  fs.chmodSync(f, 0o755);
  return f;
}

test("voice session: claude gets --append-system-prompt and the stream carries speech events", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-claude-argv-"));
  const stub = writeStub(dir, "claude", `
const argv = process.argv.slice(2);
const i = argv.indexOf("--append-system-prompt");
const sys = i >= 0 ? argv[i + 1] : "";
const prompt = argv[argv.length - 1];
const out = (t) => process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:t}]}})+"\\n");
out("SYS=" + JSON.stringify(sys) + " PROMPT=" + JSON.stringify(prompt) + "\\n");
out("Done. Here:\\n\`\`\`sh\\nnpm test\\n\`\`\`\\nAll green.");
process.stdout.write(JSON.stringify({type:"result",subtype:"success"})+"\\n");
`);
  await withEnv({ CLAUDE_BIN: stub, VOICE_STYLE_PROMPT: "BE BRIEF", VOICE_STYLE_PROMPT_FILE: null, VOICE_MODE_DEFAULT: null, PERSISTENT_SESSIONS: null }, async () => {
    const create = await request(server, "POST", "/api/sessions", { agent: "claude", projectDir: process.cwd(), voice: true });
    const { session } = JSON.parse(create.data);
    assert.strictEqual(session.voiceMode, null);
    assert.strictEqual(session.voiceModeActive, true);

    const r = await request(server, "POST", "/api/ask", { text: "run tests", sessionId: session.id });
    assert.strictEqual(r.headers["x-vb-speech"], "1");
    assert.strictEqual(r.headers["x-vb-voice-mode"], "1");
    const evs = ndjson(r.data);
    const text = evs.filter((e) => e.type === "delta").map((e) => e.text).join("");
    assert.match(text, /SYS="BE BRIEF"/);
    assert.match(text, /PROMPT="run tests"/); // not prefixed: the style went in as a system prompt
    assert.match(text, /npm test/); // the chat keeps the full text
    const speech = evs.filter((e) => e.type === "speech").map((e) => e.text).join(" ");
    assert.match(speech, /Done\./);
    assert.match(speech, /All green\./);
    assert.doesNotMatch(speech, /npm test/);
    // the spoken tail comes before done, and done is last
    assert.strictEqual(evs[evs.length - 1].type, "done");

    // Turning voice mode off per session: no system prompt any more.
    const upd = await request(server, "POST", "/api/sessions/" + session.id, { voiceMode: false });
    assert.strictEqual(JSON.parse(upd.data).session.voiceMode, false);
    assert.strictEqual(JSON.parse(upd.data).session.voiceModeActive, false);
    const r2 = await request(server, "POST", "/api/ask", { text: "again", sessionId: session.id });
    assert.strictEqual(r2.headers["x-vb-voice-mode"], "0");
    assert.match(ndjson(r2.data).filter((e) => e.type === "delta").map((e) => e.text).join(""), /SYS=""/);

    // Back to auto (null) follows the voice flag again.
    const upd2 = await request(server, "POST", "/api/sessions/" + session.id, { voiceMode: null });
    assert.strictEqual(JSON.parse(upd2.data).session.voiceModeActive, true);
  });
});

test("voiceMode can be enabled on a typed (non-voice) session at creation", async () => {
  const create = await request(server, "POST", "/api/sessions", { agent: "codex", projectDir: process.cwd(), voiceMode: true });
  const { session } = JSON.parse(create.data);
  assert.strictEqual(session.voice, false);
  assert.strictEqual(session.voiceModeActive, true);
  await withEnv({ VOICE_STYLE_PROMPT: "STYLE-X", VOICE_STYLE_PROMPT_FILE: null }, async () => {
    const { data } = await request(server, "POST", "/api/ask", { text: "do y", sessionId: session.id });
    const text = ndjson(data).filter((e) => e.type === "delta").map((e) => e.text).join("");
    assert.match(text, /STYLE-X\s+do y/); // codex has no system-prompt flag → inline prefix
  });
});

test("voiceMode survives save/load", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vb-sess-")), "s.json");
  const a = srv.createSession({ agent: "claude", projectDir: process.cwd(), voice: true, voiceMode: false });
  const b = srv.createSession({ agent: "claude", projectDir: process.cwd(), voice: true });
  srv.saveSessions(file);
  srv.sessions.delete(a.id); srv.sessions.delete(b.id);
  srv.loadSessions(file);
  assert.strictEqual(srv.sessions.get(a.id).voiceMode, false);
  assert.strictEqual(srv.sessions.get(b.id).voiceMode, undefined);
});

test("POST /api/sessions/:id accepts claudeSessionId (sanitized)", async () => {
  const create = await request(server, "POST", "/api/sessions", { agent: "claude", projectDir: process.cwd() });
  const { session } = JSON.parse(create.data);
  const ok = await request(server, "POST", "/api/sessions/" + session.id, { claudeSessionId: "abc-123" });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(JSON.parse(ok.data).session.claudeSessionId, "abc-123");
  const bad = await request(server, "POST", "/api/sessions/" + session.id, { claudeSessionId: "../etc" });
  assert.strictEqual(JSON.parse(bad.data).session.claudeSessionId, null);
});
