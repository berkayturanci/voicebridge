#!/usr/bin/env node
/*
 * voicebridge — talk to a coding agent from a phone browser and hear it talk back.
 *
 * Speech recognition + synthesis run in the browser (Web Speech API) by default;
 * this server relays text to a coding-agent CLI and STREAMS the reply back so the
 * phone can speak it sentence-by-sentence as it is generated.
 *
 * Multiple agents and multiple concurrent sessions are supported. Each session is
 * bound to an agent backend (Claude Code / Codex / Antigravity) and a project
 * directory, and keeps its own conversation; you switch between them in the UI.
 *
 * Optional: fully-local speech-to-text via your own Whisper command (STT_MODE),
 * and a shared access token (ACCESS_TOKEN) so only you can drive it.
 *
 * Zero runtime dependencies — Node standard library only.
 *
 * Environment variables:
 *   PORT         TCP port to bind (default 8787)
 *   HOST         bind address (default 127.0.0.1 — expose with `tailscale serve`)
 *   PROJECT_DIR  default working directory for new sessions (default: process.cwd())
 *   AGENT        default agent for the boot session (default "claude")
 *   CLAUDE_BIN   path to the claude executable      (default "claude")
 *   CODEX_BIN    path to the codex executable       (default "codex")
 *   AGY_BIN      path to the antigravity executable (default "agy")
 *   ACCESS_TOKEN if set, /api/* requires Authorization: Bearer <token>
 *   STT_MODE     "browser" (default) or "whisper"
 *   STT_CMD      shell command for whisper mode; "{file}" -> recorded audio path
 */

"use strict";

const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = parseInt(process.env.PORT || "8787", 10);
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const DEFAULT_AGENT = process.env.AGENT || "claude";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";
const STT_MODE = (process.env.STT_MODE || "browser").toLowerCase();
const STT_CMD = process.env.STT_CMD || "";
const PUBLIC_DIR = path.join(__dirname, "public");
let PKG_VERSION = "0.0.0";
try { PKG_VERSION = require("./package.json").version || PKG_VERSION; } catch (_) {}

// ---------------------------------------------------------------------------
// Agent backends
//
// Each adapter turns a prompt into a subprocess invocation and tells the server
// how to read its streamed output. Commands mirror the real CLIs (see ai-jury):
//   - Claude Code : claude -p --output-format stream-json (NDJSON events)
//   - Codex CLI   : codex exec            (prompt on stdin, plain-text stdout)
//   - Antigravity : agy --print           (prompt on stdin, plain-text stdout)
// ---------------------------------------------------------------------------

// Pull text out of one Claude `stream-json` NDJSON line, or null if it has none.
function parseClaudeLine(line) {
  let obj;
  try { obj = JSON.parse(line); } catch (_) { return null; }
  if (obj.type === "assistant" && obj.message && Array.isArray(obj.message.content)) {
    const text = obj.message.content
      .filter((b) => b && b.type === "text" && b.text)
      .map((b) => b.text)
      .join("");
    return text || null;
  }
  return null;
}

// Per-agent "mode" = how much autonomy the agent has. The flags mirror
// ai-jury's privilege handling. Full-auto modes skip approval prompts — handy
// hands-free, risky otherwise.
const AGENTS = {
  claude: {
    label: "Claude Code",
    bin: () => process.env.CLAUDE_BIN || "claude",
    supportsContinue: true,
    stream: "ndjson",
    defaultMode: "ask",
    modes: {
      ask: { label: "Onay iste", args: [] },
      autoEdit: { label: "Düzenlemeleri onayla", args: ["--permission-mode", "acceptEdits"] },
      full: { label: "Tam otonom", args: ["--dangerously-skip-permissions"] },
    },
    // Prompt is passed positionally after -p (claude also accepts it on stdin).
    command(prompt, { cont, modeArgs } = {}) {
      const argv = [...(modeArgs || [])];
      if (cont) argv.push("--continue");
      argv.push("--output-format", "stream-json", "--verbose", "-p", prompt);
      return { argv, stdin: null };
    },
    parseLine: parseClaudeLine,
  },
  codex: {
    label: "Codex",
    bin: () => process.env.CODEX_BIN || "codex",
    supportsContinue: false,
    stream: "text",
    defaultMode: "auto",
    modes: {
      safe: { label: "Salt-okunur", args: ["-s", "read-only"] },
      auto: { label: "Otomatik (yazma)", args: ["--full-auto"] },
      full: { label: "Tam otonom", args: ["--dangerously-bypass-approvals-and-sandbox"] },
    },
    // `codex exec` reads the prompt from stdin in non-interactive runs.
    command(prompt, { modeArgs } = {}) {
      return { argv: ["exec", ...(modeArgs || [])], stdin: prompt };
    },
  },
  antigravity: {
    label: "Antigravity",
    bin: () => process.env.AGY_BIN || "agy",
    supportsContinue: false,
    stream: "text",
    defaultMode: "safe",
    modes: {
      safe: { label: "Sandbox", args: ["--sandbox"] },
      full: { label: "Tam otonom", args: ["--yolo"] },
    },
    // `agy --print` reads the prompt from stdin when none is given positionally.
    command(prompt, { modeArgs } = {}) {
      return { argv: ["--print", ...(modeArgs || [])], stdin: prompt };
    },
  },
};

// The valid mode for a session, falling back to the agent default.
function resolveMode(agentId, mode) {
  const agent = AGENTS[agentId];
  if (mode && agent.modes[mode]) return mode;
  return agent.defaultMode;
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

const sessions = new Map();
let sessionSeq = 0;
let defaultSessionId = null;

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function createSession({ name, agent, projectDir, mode, voice } = {}) {
  agent = agent || DEFAULT_AGENT;
  if (!AGENTS[agent]) throw new Error("unknown agent: " + agent);
  if (mode && !AGENTS[agent].modes[mode]) throw new Error("unknown mode: " + mode);
  const dir = projectDir || DEFAULT_PROJECT_DIR;
  if (!isDir(dir)) throw new Error("project directory not found: " + dir);
  const id = "s" + (++sessionSeq);
  const s = {
    id,
    name: (name && String(name).trim()) || AGENTS[agent].label,
    agent,
    projectDir: dir,
    mode: resolveMode(agent, mode),
    voice: !!voice,
    started: false,
  };
  sessions.set(id, s);
  return s;
}

function publicSession(s) {
  return {
    id: s.id, name: s.name, agent: s.agent,
    agentLabel: AGENTS[s.agent].label, projectDir: s.projectDir, mode: s.mode, voice: s.voice, started: s.started,
  };
}

function resolveSession(id) {
  // A provided-but-unknown id is an error; only fall back to the default when
  // the caller omitted the id entirely (backward compatibility).
  if (id) return sessions.get(id) || null;
  if (defaultSessionId) return sessions.get(defaultSessionId) || null;
  return null;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ "Cache-Control": "no-store" }, headers || {}));
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json" });
}

function authorized(req) {
  if (!ACCESS_TOKEN) return true;
  const h = req.headers["authorization"] || "";
  const got = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (got.length !== ACCESS_TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(ACCESS_TOKEN));
  } catch (_) {
    return false;
  }
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel === "/") rel = "/index.html";
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden");
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, "Not found");
    const ext = path.extname(filePath).toLowerCase();
    const type =
      ext === ".html" ? "text/html; charset=utf-8" :
      ext === ".js" ? "text/javascript; charset=utf-8" :
      ext === ".css" ? "text/css; charset=utf-8" :
      "application/octet-stream";
    send(res, 200, data, { "Content-Type": type });
  });
}

function readBody(req, limitBytes, cb) {
  let size = 0;
  const chunks = [];
  req.on("data", (c) => {
    size += c.length;
    if (size > limitBytes) { req.destroy(); }
    else chunks.push(c);
  });
  req.on("end", () => cb(null, Buffer.concat(chunks)));
  req.on("error", cb);
}

// ---------------------------------------------------------------------------
// Streaming a turn (NDJSON out: {type:"delta"|"done"|"error"})
// ---------------------------------------------------------------------------

// In voice-friendly mode, prepend a short instruction so the agent answers in a
// way that reads well aloud. The user's visible message is unchanged.
const VOICE_PREAMBLE =
  "Answer concisely, optimized for being read aloud by text-to-speech: avoid long " +
  "code blocks unless explicitly asked, and finish with a one-sentence spoken summary.";
function buildPrompt(voice, text) {
  return voice ? VOICE_PREAMBLE + "\n\n" + text : text;
}

function streamAsk(session, prompt, res) {
  const agent = AGENTS[session.agent];
  const cont = session.started && agent.supportsContinue;
  const modeArgs = (agent.modes[session.mode] || agent.modes[agent.defaultMode]).args;
  const { argv, stdin } = agent.command(buildPrompt(session.voice, prompt), { cont, modeArgs });

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });

  const emit = (obj) => { try { res.write(JSON.stringify(obj) + "\n"); } catch (_) {} };

  let child;
  try {
    child = spawn(agent.bin(), argv, { cwd: session.projectDir, env: process.env });
  } catch (e) {
    emit({ type: "error", error: e.message });
    return res.end();
  }

  if (stdin != null) {
    try { child.stdin.write(stdin); child.stdin.end(); } catch (_) {}
  }

  const timer = setTimeout(() => child.kill("SIGKILL"), 5 * 60 * 1000);
  let buf = "";
  let stderr = "";
  let gotText = false;

  const onText = (text) => { if (text) { gotText = true; emit({ type: "delta", text }); } };

  child.stdout.on("data", (d) => {
    const s = d.toString();
    if (agent.stream === "ndjson") {
      buf += s;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) onText(agent.parseLine(line));
      }
    } else {
      onText(s); // plain-text agents: stream stdout straight through
    }
  });
  child.stderr.on("data", (d) => (stderr += d.toString()));

  child.on("error", (e) => {
    clearTimeout(timer);
    emit({
      type: "error",
      error: e.code === "ENOENT"
        ? `Could not find '${agent.bin()}'. Install ${agent.label} and authenticate it.`
        : e.message,
    });
    res.end();
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (agent.stream === "ndjson" && buf.trim()) onText(agent.parseLine(buf));
    if (code !== 0 && !gotText) {
      emit({ type: "error", error: stderr.trim() || `${agent.label} exited with code ${code}.` });
    } else {
      session.started = true;
      emit({ type: "done" });
    }
    res.end();
  });

  res.on("close", () => { clearTimeout(timer); child.kill("SIGKILL"); });
}

// ---------------------------------------------------------------------------
// Local Whisper transcription
// ---------------------------------------------------------------------------

function transcribe(audioBuf, contentType, cb) {
  if (STT_MODE !== "whisper" || !STT_CMD) {
    return cb(new Error("Server is not configured for whisper STT."));
  }
  const ext = /wav/.test(contentType) ? ".wav" : /mp4|m4a/.test(contentType) ? ".m4a" : ".webm";
  const tmp = path.join(os.tmpdir(), "vb-" + crypto.randomBytes(6).toString("hex") + ext);
  fs.writeFile(tmp, audioBuf, (werr) => {
    if (werr) return cb(werr);
    const cmd = STT_CMD.replace(/\{file\}/g, tmp);
    const child = spawn("/bin/sh", ["-c", cmd], { env: process.env });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => { fs.unlink(tmp, () => {}); cb(e); });
    child.on("close", (code) => {
      fs.unlink(tmp, () => {});
      if (code !== 0 && !out.trim()) return cb(new Error(err.trim() || "whisper failed"));
      cb(null, out.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Request routing
// ---------------------------------------------------------------------------

function handleRequest(req, res) {
  const urlPath = req.url.split("?")[0];

  // Public: liveness/readiness probe.
  if (req.method === "GET" && urlPath === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      version: PKG_VERSION,
      uptime: Math.round(process.uptime()),
      sessions: sessions.size,
    });
  }

  // Public: client configuration (no secrets).
  if (req.method === "GET" && urlPath === "/api/config") {
    return sendJson(res, 200, {
      sttMode: STT_MODE,
      authRequired: !!ACCESS_TOKEN,
      agents: Object.keys(AGENTS).map((id) => ({
        id, label: AGENTS[id].label, supportsContinue: AGENTS[id].supportsContinue,
        defaultMode: AGENTS[id].defaultMode,
        modes: Object.keys(AGENTS[id].modes).map((m) => ({ id: m, label: AGENTS[id].modes[m].label })),
      })),
      defaultProjectDir: DEFAULT_PROJECT_DIR,
      defaultSessionId,
    });
  }

  if (urlPath.startsWith("/api/")) {
    if (!authorized(req)) return sendJson(res, 401, { error: "Unauthorized" });

    if (req.method === "GET" && urlPath === "/api/sessions") {
      return sendJson(res, 200, {
        sessions: Array.from(sessions.values()).map(publicSession),
        defaultSessionId,
      });
    }

    if (req.method === "POST" && urlPath === "/api/sessions") {
      return readBody(req, 64 * 1024, (e, body) => {
        if (e) return sendJson(res, 400, { error: "Bad request" });
        let data; try { data = JSON.parse(body.toString("utf8") || "{}"); }
        catch (_) { return sendJson(res, 400, { error: "Bad JSON" }); }
        let s;
        try { s = createSession(data); }
        catch (err) { return sendJson(res, 400, { error: err.message }); }
        return sendJson(res, 200, { session: publicSession(s) });
      });
    }

    if (req.method === "DELETE" && urlPath.startsWith("/api/sessions/")) {
      const id = urlPath.slice("/api/sessions/".length);
      if (id === defaultSessionId) return sendJson(res, 400, { error: "Cannot delete the default session" });
      const existed = sessions.delete(id);
      return sendJson(res, existed ? 200 : 404, existed ? { ok: true } : { error: "Not found" });
    }

    if (req.method === "POST" && urlPath === "/api/ask") {
      return readBody(req, 64 * 1024, (e, body) => {
        if (e) return sendJson(res, 400, { error: "Bad request" });
        let data; try { data = JSON.parse(body.toString("utf8") || "{}"); }
        catch (_) { return sendJson(res, 400, { error: "Bad JSON" }); }
        const text = typeof data.text === "string" ? data.text.trim() : "";
        if (!text) return sendJson(res, 400, { error: "Empty prompt" });
        const session = resolveSession(data.sessionId);
        if (!session) return sendJson(res, 404, { error: "Unknown session" });
        if (data.reset) session.started = false;
        if (data.mode && AGENTS[session.agent].modes[data.mode]) session.mode = data.mode;
        if (typeof data.voice === "boolean") session.voice = data.voice;
        streamAsk(session, text, res);
      });
    }

    if (req.method === "POST" && urlPath === "/api/stt") {
      return readBody(req, 12 * 1024 * 1024, (e, body) => {
        if (e || !body || !body.length) return sendJson(res, 400, { error: "No audio" });
        transcribe(body, req.headers["content-type"] || "", (terr, text) => {
          if (terr) return sendJson(res, 500, { error: terr.message });
          sendJson(res, 200, { text });
        });
      });
    }

    if (req.method === "POST" && urlPath === "/api/reset") {
      return readBody(req, 64 * 1024, (e, body) => {
        let data = {}; try { data = JSON.parse((body || "").toString("utf8") || "{}"); } catch (_) {}
        const session = resolveSession(data.sessionId);
        if (session) session.started = false;
        return sendJson(res, 200, { ok: true });
      });
    }

    return sendJson(res, 404, { error: "Not found" });
  }

  if (req.method === "GET") return serveStatic(req, res);
  send(res, 405, "Method not allowed");
}

function buildServer() {
  return http.createServer(handleRequest);
}

// The URL to open on the phone. Prefer the real public URL (e.g. the Tailscale
// hostname) via PUBLIC_URL; otherwise fall back to host:port. When a token is
// configured, embed it so scanning authorizes the phone on open.
function phoneUrl({ publicUrl, host, port, token } = {}) {
  const base = publicUrl && publicUrl.trim()
    ? publicUrl.trim().replace(/\/+$/, "")
    : `http://${host || "127.0.0.1"}:${port || "8787"}`;
  return base + (token ? `?token=${encodeURIComponent(token)}` : "");
}

// Print a scannable QR for the phone URL. Fail-soft: if qrcode-terminal is not
// installed the bridge still runs and just prints the URL.
function printPhoneQr(url) {
  console.log(`\nOpen on your phone:  ${url}`);
  try {
    require("qrcode-terminal").generate(url, { small: true }, (qr) => console.log(qr));
  } catch (_) {
    console.log("(run `npm install` to show a scannable QR code here)\n");
  }
}

function start() {
  const boot = createSession({ name: "default", agent: DEFAULT_AGENT, projectDir: DEFAULT_PROJECT_DIR });
  defaultSessionId = boot.id;
  const server = buildServer();
  server.listen(PORT, HOST, () => {
    console.log(`voicebridge listening on http://${HOST}:${PORT}`);
    console.log(`default session: ${boot.name} · ${AGENTS[boot.agent].label} · ${boot.projectDir}`);
    console.log(`agents: ${Object.keys(AGENTS).join(", ")}`);
    console.log(`STT mode: ${STT_MODE}${ACCESS_TOKEN ? "  (access token required)" : ""}`);
    console.log(`Expose it to your phone with:  tailscale serve --bg ${PORT}`);
    printPhoneQr(phoneUrl({ publicUrl: process.env.PUBLIC_URL, host: HOST, port: PORT, token: ACCESS_TOKEN }));
  });
  return server;
}

if (require.main === module) {
  start();
}

module.exports = {
  AGENTS,
  parseClaudeLine,
  resolveMode,
  buildPrompt,
  phoneUrl,
  sessions,
  createSession,
  resolveSession,
  publicSession,
  buildServer,
  handleRequest,
  start,
  get defaultSessionId() { return defaultSessionId; },
  set defaultSessionId(v) { defaultSessionId = v; },
};
