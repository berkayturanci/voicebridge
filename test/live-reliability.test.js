"use strict";

process.env.PERSISTENT_SESSIONS = "1";
process.env.LIVE_IDLE_MS = "0";
process.env.AGENT_TIMEOUT_MS = "1500";
process.env.SESSIONS_FILE = "off";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { request, ndjson } = require("./helpers");

function writeExecutable(file, source) {
  fs.writeFileSync(file, source);
  fs.chmodSync(file, 0o755);
}

function installSequentialLiveStub({ first }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-live-"));
  const state = path.join(dir, "count");
  const bin = path.join(dir, "claude");
  writeExecutable(bin, `#!/usr/bin/env node
const fs = require("fs");
const state = ${JSON.stringify(state)};
let count = 0;
try { count = Number(fs.readFileSync(state, "utf8")) || 0; } catch (_) {}
count += 1;
fs.writeFileSync(state, String(count));

function writeResult(text) {
  process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text}]}})+"\\n");
  process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:"ok"})+"\\n", () => process.exit(0));
}

if (count === 1 && ${JSON.stringify(first)} === "hang") {
  process.stdin.resume();
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
} else if (count === 1 && ${JSON.stringify(first)} === "exit") {
  process.exit(0);
} else {
  process.stdin.setEncoding("utf8");
  let buf = "";
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\\n")) >= 0) {
      buf = buf.slice(idx + 1);
      writeResult("live ok");
    }
  });
  process.stdin.resume();
}
`);
  process.env.CLAUDE_BIN = bin;
  return dir;
}

async function startServer() {
  delete require.cache[require.resolve("../server.js")];
  const srv = require("../server.js");
  const boot = srv.createSession({ name: "live", agent: "claude", projectDir: process.cwd() });
  const server = srv.buildServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { srv, boot, server };
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("persistent live failures emit errors and release busy for the next turn", async () => {
  installSequentialLiveStub({ first: "hang" });
  let { boot, server } = await startServer();

  const timedOut = ndjson((await request(server, "POST", "/api/ask", { text: "hang", sessionId: boot.id })).data);
  assert.ok(timedOut.some((e) => e.type === "error" && /timed out/.test(e.error)), JSON.stringify(timedOut));
  await sleep(300);
  installSequentialLiveStub({ first: "respond" });

  let recovered = ndjson((await request(server, "POST", "/api/ask", { text: "again", sessionId: boot.id })).data);
  assert.strictEqual(recovered.filter((e) => e.type === "delta").map((e) => e.text).join(""), "live ok", JSON.stringify(recovered));
  assert.strictEqual(recovered.at(-1).type, "done");
  await request(server, "DELETE", "/api/sessions/" + boot.id);
  await sleep(50);
  await closeServer(server);

  installSequentialLiveStub({ first: "exit" });
  ({ boot, server } = await startServer());

  const failed = ndjson((await request(server, "POST", "/api/ask", { text: "first", sessionId: boot.id })).data);
  assert.ok(failed.some((e) => e.type === "error"), JSON.stringify(failed));

  recovered = ndjson((await request(server, "POST", "/api/ask", { text: "again", sessionId: boot.id })).data);
  assert.strictEqual(recovered.filter((e) => e.type === "delta").map((e) => e.text).join(""), "live ok", JSON.stringify(recovered));
  assert.strictEqual(recovered.at(-1).type, "done");
  await request(server, "DELETE", "/api/sessions/" + boot.id);
  await sleep(50);
  await closeServer(server);
});

test("persistent live: voice style rides --append-system-prompt and toggling voice mode respawns idle child", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-live-sys-"));
  const bin = path.join(dir, "claude");
  writeExecutable(bin, `#!/usr/bin/env node
const argv = process.argv.slice(2);
const i = argv.indexOf("--append-system-prompt");
const sys = i >= 0 ? argv[i + 1] : "";
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
    let text = ""; try { text = JSON.parse(line).message.content[0].text; } catch (_) {}
    process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"pid=" + process.pid + " sys=" + JSON.stringify(sys) + " prompt=" + JSON.stringify(text)}]}})+"\\n");
    process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:"ok"})+"\\n");
  }
});
process.stdin.resume();
process.on("SIGTERM", () => process.exit(0));
`);
  process.env.CLAUDE_BIN = bin;
  process.env.AGENT_TIMEOUT_MS = "5000";
  process.env.VOICE_STYLE_PROMPT = "SPOKEN";
  const { srv, server } = await startServer();
  const s = srv.createSession({ name: "voice", agent: "claude", projectDir: process.cwd(), voice: true });
  try {
    const say = async (text) => ndjson((await request(server, "POST", "/api/ask", { text, sessionId: s.id })).data)
      .filter((e) => e.type === "delta").map((e) => e.text).join("");
    const a = await say("one");
    assert.match(a, /sys="SPOKEN" prompt="one"/);
    const b = await say("two");
    assert.strictEqual(b.match(/pid=(\d+)/)[1], a.match(/pid=(\d+)/)[1]); // same child reused
    s.voiceMode = false;
    const c = await say("three");
    assert.match(c, /sys="" prompt="three"/);
    assert.notStrictEqual(c.match(/pid=(\d+)/)[1], a.match(/pid=(\d+)/)[1]); // respawned
  } finally {
    srv._internals.killAllLive();
    delete process.env.VOICE_STYLE_PROMPT;
    process.env.AGENT_TIMEOUT_MS = "1500";
    await closeServer(server);
  }
});
