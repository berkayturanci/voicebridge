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

// Minimal .env support (no dependency): load KEY=VALUE lines from ./.env without
// overriding variables already present in the environment.
function parseDotEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue; // skips blanks and # comments
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
function loadDotEnv(file) {
  try {
    const env = parseDotEnv(fs.readFileSync(file || path.join(process.cwd(), ".env"), "utf8"));
    for (const k in env) if (!(k in process.env)) process.env[k] = env[k];
  } catch (_) {}
}
loadDotEnv();

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

// Optional server-provided favorite projects, from FAVORITES (a JSON array of
// { name?, projectDir, agent?, mode? }). Used to prefill the new-session dialog.
function parseFavorites(str) {
  if (!str) return [];
  try {
    const a = JSON.parse(str);
    if (!Array.isArray(a)) return [];
    return a
      .filter((f) => f && typeof f.projectDir === "string" && f.projectDir)
      .map((f) => ({ name: f.name || f.projectDir, projectDir: f.projectDir, agent: f.agent, mode: f.mode }));
  } catch (_) {
    return [];
  }
}
const FAVORITES = parseFavorites(process.env.FAVORITES);

// ---------------------------------------------------------------------------
// Agent backends
//
// Each adapter turns a prompt into a subprocess invocation and tells the server
// how to read its streamed output. Commands mirror the real CLIs (see ai-jury):
//   - Claude Code : claude -p --output-format stream-json (NDJSON events)
//   - Codex CLI   : codex exec            (prompt on stdin, plain-text stdout)
//   - Antigravity : agy --print           (prompt on stdin, plain-text stdout)
// ---------------------------------------------------------------------------

// Split a space-separated argument string from the environment into argv parts.
function splitArgs(str) {
  return (str || "").trim().split(/\s+/).filter(Boolean);
}

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

// A short, human label for a tool_use block, e.g. "Edit server.js" / "Bash npm test".
function toolLabel(b) {
  const v = b.input && (b.input.file_path || b.input.path || b.input.pattern || b.input.command || b.input.url);
  const detail = v ? " " + String(v).split("/").slice(-1)[0].slice(0, 40) : "";
  return (b.name || "tool") + detail;
}

// Parse one Claude `stream-json` line into events: assistant text -> delta,
// tool_use -> activity (what the agent is doing). Returns [] for other lines.
function parseClaudeEvents(line) {
  let obj;
  try { obj = JSON.parse(line); } catch (_) { return []; }
  const out = [];
  if (obj.type === "assistant" && obj.message && Array.isArray(obj.message.content)) {
    for (const b of obj.message.content) {
      if (b && b.type === "text" && b.text) out.push({ type: "delta", text: b.text });
      else if (b && b.type === "tool_use") out.push({ type: "activity", text: toolLabel(b) });
    }
  }
  return out;
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
    parseEvents: parseClaudeEvents,
  },
  codex: {
    label: "Codex",
    bin: () => process.env.CODEX_BIN || "codex",
    // Resume is opt-in: set CODEX_CONTINUE_ARGS (e.g. "resume --last") once you
    // know your codex build's resume flag. Default off — each turn is fresh.
    get supportsContinue() { return splitArgs(process.env.CODEX_CONTINUE_ARGS).length > 0; },
    stream: "text",
    defaultMode: "auto",
    modes: {
      safe: { label: "Salt-okunur", args: ["-s", "read-only"] },
      auto: { label: "Otomatik (yazma)", args: ["--full-auto"] },
      full: { label: "Tam otonom", args: ["--dangerously-bypass-approvals-and-sandbox"] },
    },
    // `codex exec` reads the prompt from stdin in non-interactive runs.
    command(prompt, { cont, modeArgs } = {}) {
      const resume = cont ? splitArgs(process.env.CODEX_CONTINUE_ARGS) : [];
      return { argv: ["exec", ...resume, ...(modeArgs || [])], stdin: prompt };
    },
  },
  antigravity: {
    label: "Antigravity",
    bin: () => process.env.AGY_BIN || "agy",
    // Resume is opt-in via AGY_CONTINUE_ARGS. Default off.
    get supportsContinue() { return splitArgs(process.env.AGY_CONTINUE_ARGS).length > 0; },
    stream: "text",
    defaultMode: "safe",
    modes: {
      safe: { label: "Sandbox", args: ["--sandbox"] },
      full: { label: "Tam otonom", args: ["--yolo"] },
    },
    // `agy --print` reads the prompt from stdin by default. CLIs vary, so the
    // base args (AGY_ARGS, default "--print") and prompt delivery (AGY_PROMPT_ARG=1
    // passes the prompt as a positional argument instead of stdin) are overridable.
    command(prompt, { cont, modeArgs } = {}) {
      const base = process.env.AGY_ARGS ? splitArgs(process.env.AGY_ARGS) : ["--print"];
      const resume = cont ? splitArgs(process.env.AGY_CONTINUE_ARGS) : [];
      const argv = [...base, ...resume, ...(modeArgs || [])];
      if (process.env.AGY_PROMPT_ARG) { argv.push(prompt); return { argv, stdin: null }; }
      return { argv, stdin: prompt };
    },
  },
  ollama: {
    label: "Ollama (yerel)",
    bin: () => process.env.OLLAMA_BIN || "ollama",
    supportsContinue: true, // HTTP path keeps per-session message history
    stream: "text",
    defaultMode: "default",
    modes: {
      default: { label: "Yerel model", args: [] },
    },
    // `ollama run <model>` reads the prompt from stdin and streams the reply.
    // The model itself runs locally — nothing leaves the machine.
    command(prompt, { modeArgs } = {}) {
      const model = process.env.OLLAMA_MODEL || "llama3.2";
      return { argv: ["run", model, ...(modeArgs || [])], stdin: prompt };
    },
  },
};

// The valid mode for a session, falling back to the agent default.
function resolveMode(agentId, mode) {
  const agent = AGENTS[agentId];
  if (mode && agent.modes[mode]) return mode;
  return agent.defaultMode;
}

// "local" runs the agent CLI here; "cloud" proxies to CLOUD_RUNNER_URL.
function resolveRunner(runner) {
  runner = runner || "local";
  if (runner !== "local" && runner !== "cloud") throw new Error("unknown runner: " + runner);
  if (runner === "cloud" && !(process.env.CLOUD_RUNNER_URL || "")) throw new Error("cloud runner not configured");
  return runner;
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

const sessions = new Map();
let sessionSeq = 0;
let defaultSessionId = null;

// Concurrent in-flight agent turns, capped to bound host resources.
let inflight = 0;
function maxInflight() { return parseInt(process.env.MAX_INFLIGHT || "8", 10); }

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

// Is an executable resolvable (absolute path, or found on PATH)?
function binExists(bin) {
  if (!bin) return false;
  if (bin.includes("/")) { try { fs.accessSync(bin, fs.constants.X_OK); return true; } catch (_) { return false; } }
  for (const d of (process.env.PATH || "").split(path.delimiter)) {
    if (!d) continue;
    try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return true; } catch (_) {}
  }
  return false;
}

// Whether an agent looks usable. Ollama is HTTP (reachability checked at use).
function agentAvailable(id) {
  return id === "ollama" ? true : binExists(AGENTS[id].bin());
}

// List subdirectories of a path (dotfiles hidden) for the folder picker.
// Used by the bridge (local) and the reference cloud runner (remote host).
function browseDir(p) {
  let dir;
  try { dir = path.resolve(p || DEFAULT_PROJECT_DIR || os.homedir()); } catch (_) { dir = os.homedir(); }
  let dirs = [];
  try {
    dirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => {
        if (e.name.startsWith(".")) return false;
        try { return e.isDirectory() || (e.isSymbolicLink() && fs.statSync(path.join(dir, e.name)).isDirectory()); }
        catch (_) { return false; }
      })
      .map((e) => e.name).sort((a, b) => a.localeCompare(b));
  } catch (e) {
    return { path: dir, parent: path.dirname(dir), dirs: [], error: e.message };
  }
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, dirs };
}

// Project slash commands under .claude/commands/**.md → "/name" (nested dirs
// namespace with ":", e.g. .claude/commands/keel/ship.md → /keel:ship).
function listSlashCommands(baseDir) {
  const out = [];
  const walk = (d, prefix) => {
    if (out.length > 200) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (out.length > 200) break;
      if (e.isDirectory()) walk(path.join(d, e.name), prefix.concat(e.name));
      else if (e.isFile() && e.name.endsWith(".md")) {
        const name = prefix.concat(e.name.slice(0, -3)).join(":");
        out.push({ label: "/" + name, value: "/" + name + " " });
      }
    }
  };
  walk(path.join(baseDir, ".claude", "commands"), []);
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

// package.json scripts → "npm run <name>".
function listNpmScripts(baseDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(baseDir, "package.json"), "utf8"));
    return Object.keys(pkg.scripts || {}).map((k) => ({ label: "npm run " + k, value: "npm run " + k }));
  } catch (_) { return []; }
}

function maxSessions() { return parseInt(process.env.MAX_SESSIONS || "200", 10); }

function createSession({ name, agent, projectDir, mode, voice, runner, model } = {}) {
  if (sessions.size >= maxSessions()) throw new Error("too many sessions");
  agent = agent || DEFAULT_AGENT;
  if (!AGENTS[agent]) throw new Error("unknown agent: " + agent);
  if (mode && !AGENTS[agent].modes[mode]) throw new Error("unknown mode: " + mode);
  const run = resolveRunner(runner);
  // A cloud session may target a directory that only exists on the remote host.
  const dir = projectDir || DEFAULT_PROJECT_DIR;
  if (run === "local" && !isDir(dir)) throw new Error("project directory not found: " + dir);
  const id = "s" + (++sessionSeq);
  const s = {
    id,
    name: (name && String(name).trim()) || AGENTS[agent].label,
    agent,
    projectDir: dir,
    mode: resolveMode(agent, mode),
    voice: !!voice,
    runner: run,
    model: (model && String(model).trim()) || undefined, // ollama model override
    started: false,
  };
  sessions.set(id, s);
  return s;
}

function publicSession(s) {
  return {
    id: s.id, name: s.name, agent: s.agent, agentLabel: AGENTS[s.agent].label,
    projectDir: s.projectDir, mode: s.mode, voice: s.voice, runner: s.runner, model: s.model || null, started: s.started,
  };
}

function resolveSession(id) {
  // A provided-but-unknown id is an error; only fall back to the default when
  // the caller omitted the id entirely (backward compatibility).
  if (id) return sessions.get(id) || null;
  if (defaultSessionId) return sessions.get(defaultSessionId) || null;
  return null;
}

// Optional disk persistence so sessions survive a bridge restart. Off unless
// SESSIONS_FILE is set (or a file is passed explicitly, e.g. in tests).
function sessionsFile() { return process.env.SESSIONS_FILE || ""; }
function saveSessions(file) {
  file = file || sessionsFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const data = {
      seq: sessionSeq,
      defaultId: defaultSessionId,
      sessions: Array.from(sessions.values()).map((s) => ({
        id: s.id, name: s.name, agent: s.agent, projectDir: s.projectDir, mode: s.mode, voice: s.voice, runner: s.runner, model: s.model,
      })),
    };
    fs.writeFileSync(file, JSON.stringify(data));
  } catch (_) {}
}
function loadSessions(file) {
  file = file || sessionsFile();
  if (!file) return;
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return; }
  if (!data || !Array.isArray(data.sessions)) return;
  for (const s of data.sessions) {
    if (!s || !AGENTS[s.agent]) continue;
    sessions.set(s.id, {
      id: s.id, name: s.name, agent: s.agent, projectDir: s.projectDir,
      mode: AGENTS[s.agent].modes[s.mode] ? s.mode : AGENTS[s.agent].defaultMode,
      voice: !!s.voice, runner: s.runner === "cloud" ? "cloud" : "local",
      model: (s.model && String(s.model).trim()) || undefined, started: false,
    });
  }
  if (typeof data.seq === "number") sessionSeq = Math.max(sessionSeq, data.seq);
  if (data.defaultId && sessions.has(data.defaultId)) defaultSessionId = data.defaultId;
}

// ---------------------------------------------------------------------------
// Web Push (optional): real OS notifications even when the app is closed.
// Enabled when VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY are set and the optional
// `web-push` dependency is installed.
// ---------------------------------------------------------------------------
let webpush; // undefined = not tried, null = unavailable
const pushSubs = []; // [{ sub, sessionId }]

function pushEnabled() {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return false;
  if (webpush === undefined) { try { webpush = require("web-push"); } catch (_) { webpush = null; } }
  if (!webpush) return false;
  try {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || "mailto:voicebridge@localhost",
      process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY
    );
  } catch (_) { return false; }
  return true;
}

function looksLikeQuestion(text) { return /\?["')\]]*\s*$/.test((text || "").trim()); }

function sendPush(payload) {
  if (!pushEnabled() || !pushSubs.length) return;
  const data = JSON.stringify(payload);
  for (let i = pushSubs.length - 1; i >= 0; i--) {
    webpush.sendNotification(pushSubs[i].sub, data).catch((e) => {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) pushSubs.splice(i, 1); // gone
    });
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

// Security headers applied to every response. The single-file UI uses inline
// script/style, so script-src/style-src allow 'unsafe-inline'; everything else
// is same-origin only.
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'",
};

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ "Cache-Control": "no-store" }, SECURITY_HEADERS, headers || {}));
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
  let rel;
  try { rel = decodeURIComponent(req.url.split("?")[0]); }
  catch (_) { return send(res, 400, "Bad request"); } // malformed %-encoding
  if (rel === "/") rel = "/index.html";
  const filePath = path.join(PUBLIC_DIR, rel);
  // Must stay inside PUBLIC_DIR. Compare with a trailing separator so a sibling
  // dir whose name merely starts with PUBLIC_DIR (e.g. "public-x") can't slip by.
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, "Forbidden");
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, "Not found");
    const ext = path.extname(filePath).toLowerCase();
    const type =
      ext === ".html" ? "text/html; charset=utf-8" :
      ext === ".js" ? "text/javascript; charset=utf-8" :
      ext === ".css" ? "text/css; charset=utf-8" :
      ext === ".svg" ? "image/svg+xml" :
      ext === ".json" ? "application/json; charset=utf-8" :
      ext === ".webmanifest" ? "application/manifest+json; charset=utf-8" :
      ext === ".png" ? "image/png" :
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

function cloudRunnerUrl() { return process.env.CLOUD_RUNNER_URL || ""; }

// Proxy a folder listing to the cloud runner's GET /browse (remote host dirs).
function proxyCloudBrowse(p, res) {
  const fail = (error) => sendJson(res, 200, { path: p || "", parent: null, dirs: [], error });
  let url;
  try { url = new URL("/browse", cloudRunnerUrl()); } catch (_) { return fail("Invalid CLOUD_RUNNER_URL"); }
  if (p) url.searchParams.set("path", p);
  const lib = url.protocol === "https:" ? require("https") : require("http");
  const headers = {};
  if (process.env.CLOUD_RUNNER_TOKEN) headers["Authorization"] = "Bearer " + process.env.CLOUD_RUNNER_TOKEN;
  const r = lib.get(url, { headers }, (up) => {
    let data = "";
    up.on("data", (d) => (data += d));
    up.on("end", () => { try { sendJson(res, 200, JSON.parse(data)); } catch (_) { fail("cloud browse failed"); } });
  });
  r.on("error", (e) => fail("cloud: " + e.message));
}

function streamAsk(session, prompt, res) {
  res.writeHead(200, Object.assign({
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  }, SECURITY_HEADERS));
  const emit = (obj) => { try { res.write(JSON.stringify(obj) + "\n"); } catch (_) {} };
  if (session.runner === "cloud") return streamCloud(session, prompt, res, emit);
  if (session.agent === "ollama") return streamOllama(session, prompt, res, emit);
  return streamLocal(session, prompt, res, emit);
}

function ollamaUrl() { return process.env.OLLAMA_URL || "http://127.0.0.1:11434"; }

// Ollama via its local HTTP API (/api/chat). Keeps per-session message history
// for conversation continuity; the model runs locally.
function streamOllama(session, prompt, res, emit) {
  let url;
  try { url = new URL("/api/chat", ollamaUrl()); } catch (_) { emit({ type: "error", error: "Invalid OLLAMA_URL" }); return res.end(); }
  const lib = url.protocol === "https:" ? require("https") : require("http");
  const history = session.history || [];
  const messages = history.concat([{ role: "user", content: buildPrompt(session.voice, prompt) }]);
  const payload = JSON.stringify({
    model: session.model || process.env.OLLAMA_MODEL || "llama3.2",
    messages, stream: true,
  });
  let buf = "", reply = "", errored = false;
  const upReq = lib.request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, (r) => {
    r.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let obj; try { obj = JSON.parse(line); } catch (_) { continue; }
        if (obj.error) { errored = true; emit({ type: "error", error: String(obj.error) }); continue; }
        const c = obj.message && obj.message.content;
        if (c) { reply += c; emit({ type: "delta", text: c }); }
      }
    });
    r.on("end", () => {
      if (!errored) {
        session.history = messages.concat([{ role: "assistant", content: reply }]);
        session.started = true;
        emit({ type: "done" });
        if (looksLikeQuestion(reply)) sendPush({ title: "voicebridge — " + session.name + " soru sordu", body: reply.trim().slice(-160), sessionId: session.id });
      }
      res.end();
    });
  });
  upReq.on("error", (e) => { emit({ type: "error", error: "ollama: " + e.message }); res.end(); });
  upReq.write(payload); upReq.end();
  res.on("close", () => { try { upReq.destroy(); } catch (_) {} });
}

// Cloud runner: proxy the turn to a remote endpoint that speaks the same NDJSON
// protocol ({type:"delta"|"done"|"error"}). The model/tooling run remotely.
function streamCloud(session, prompt, res, emit) {
  const base = cloudRunnerUrl();
  let url;
  try { url = new URL(base); } catch (_) { emit({ type: "error", error: "Cloud runner not configured (CLOUD_RUNNER_URL)." }); return res.end(); }
  const lib = url.protocol === "https:" ? require("https") : require("http");
  const payload = JSON.stringify({
    text: buildPrompt(session.voice, prompt),
    agent: session.agent, mode: session.mode, projectDir: session.projectDir,
    sessionId: session.id, continue: session.started,
  });
  const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) };
  if (process.env.CLOUD_RUNNER_TOKEN) headers["Authorization"] = "Bearer " + process.env.CLOUD_RUNNER_TOKEN;
  // Forward the remote stream unchanged, but also parse a copy so cloud turns
  // reach parity with local ones (activity passes through; reply text drives
  // push-on-question).
  let pbuf = "", reply = "";
  const scan = (line) => { try { const ev = JSON.parse(line); if (ev.type === "delta" && ev.text) reply += ev.text; } catch (_) {} };
  const up = lib.request(url, { method: "POST", headers }, (r) => {
    r.on("data", (d) => {
      try { res.write(d); } catch (_) {}
      pbuf += d.toString();
      let i; while ((i = pbuf.indexOf("\n")) >= 0) { const line = pbuf.slice(0, i).trim(); pbuf = pbuf.slice(i + 1); if (line) scan(line); }
    });
    r.on("end", () => {
      if (pbuf.trim()) scan(pbuf.trim());
      session.started = true;
      if (looksLikeQuestion(reply)) sendPush({ title: "voicebridge — " + session.name + " soru sordu", body: reply.trim().slice(-160), sessionId: session.id });
      res.end();
    });
  });
  up.on("error", (e) => { emit({ type: "error", error: "cloud runner: " + e.message }); res.end(); });
  up.write(payload); up.end();
  res.on("close", () => { try { up.destroy(); } catch (_) {} });
}

// Local runner: spawn the agent CLI on this machine.
function streamLocal(session, prompt, res, emit) {
  const agent = AGENTS[session.agent];
  const cont = session.started && agent.supportsContinue;
  const modeArgs = (agent.modes[session.mode] || agent.modes[agent.defaultMode]).args;
  const { argv, stdin } = agent.command(buildPrompt(session.voice, prompt), { cont, modeArgs });

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
  let replyText = ""; // accumulated for the optional push-on-question

  const onText = (text) => { if (text) { gotText = true; replyText += text; emit({ type: "delta", text }); } };
  // NDJSON agents may report activity (tool_use) alongside text.
  const onLine = (line) => {
    if (agent.parseEvents) {
      for (const ev of agent.parseEvents(line)) { if (ev.type === "delta") { gotText = true; replyText += ev.text; } emit(ev); }
    } else {
      onText(agent.parseLine(line));
    }
  };

  child.stdout.on("data", (d) => {
    const s = d.toString();
    if (agent.stream === "ndjson") {
      buf += s;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) onLine(line);
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
    if (agent.stream === "ndjson" && buf.trim()) onLine(buf);
    if (code !== 0 && !gotText) {
      emit({ type: "error", error: stderr.trim() || `${agent.label} exited with code ${code}.` });
    } else {
      session.started = true;
      emit({ type: "done" });
      if (looksLikeQuestion(replyText)) {
        sendPush({ title: "voicebridge — " + session.name + " soru sordu", body: replyText.trim().slice(-160), sessionId: session.id });
      }
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

  // Public: Web Push availability + the VAPID public key for the client.
  if (req.method === "GET" && urlPath === "/api/push/key") {
    return sendJson(res, 200, { enabled: pushEnabled(), key: process.env.VAPID_PUBLIC_KEY || "" });
  }

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
        defaultMode: AGENTS[id].defaultMode, available: agentAvailable(id),
        modes: Object.keys(AGENTS[id].modes).map((m) => ({ id: m, label: AGENTS[id].modes[m].label })),
      })),
      defaultProjectDir: DEFAULT_PROJECT_DIR,
      defaultSessionId,
      favorites: FAVORITES,
      runners: ["local"].concat((process.env.CLOUD_RUNNER_URL || "") ? ["cloud"] : []),
    });
  }

  if (urlPath.startsWith("/api/")) {
    if (!authorized(req)) return sendJson(res, 401, { error: "Unauthorized" });

    // Browse local directories (for the project-folder picker).
    // Commands available in a session's project (slash commands + npm scripts).
    if (req.method === "GET" && urlPath === "/api/commands") {
      const sid = new URL(req.url, "http://x").searchParams.get("sessionId");
      const session = resolveSession(sid);
      if (!session) return sendJson(res, 404, { error: "unknown session" });
      if (session.runner === "cloud") return sendJson(res, 200, { groups: [] }); // remote dir; see #89
      const groups = [];
      const cmds = listSlashCommands(session.projectDir);
      if (cmds.length) groups.push({ label: "Komutlar (.claude/commands)", items: cmds });
      const npm = listNpmScripts(session.projectDir);
      if (npm.length) groups.push({ label: "npm scripts", items: npm });
      return sendJson(res, 200, { groups });
    }

    if (req.method === "GET" && urlPath === "/api/browse") {
      const q = new URL(req.url, "http://x").searchParams;
      // A cloud session's directories live on the remote host: proxy to the runner.
      if (q.get("runner") === "cloud" && cloudRunnerUrl()) return proxyCloudBrowse(q.get("path"), res);
      return sendJson(res, 200, browseDir(q.get("path")));
    }

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
        saveSessions();
        return sendJson(res, 200, { session: publicSession(s) });
      });
    }

    if (req.method === "DELETE" && urlPath.startsWith("/api/sessions/")) {
      const id = urlPath.slice("/api/sessions/".length);
      if (id === defaultSessionId) return sendJson(res, 400, { error: "Cannot delete the default session" });
      const existed = sessions.delete(id);
      if (existed) saveSessions();
      return sendJson(res, existed ? 200 : 404, existed ? { ok: true } : { error: "Not found" });
    }

    // Update a session's name / mode / voice.
    if (req.method === "POST" && urlPath.startsWith("/api/sessions/")) {
      const id = urlPath.slice("/api/sessions/".length);
      const s = sessions.get(id);
      if (!s) return sendJson(res, 404, { error: "Not found" });
      return readBody(req, 64 * 1024, (e, body) => {
        let data = {}; try { data = JSON.parse((body || "").toString("utf8") || "{}"); } catch (_) {}
        if (typeof data.name === "string" && data.name.trim()) s.name = data.name.trim();
        if (data.mode && AGENTS[s.agent].modes[data.mode]) s.mode = data.mode;
        if (typeof data.voice === "boolean") s.voice = data.voice;
        saveSessions();
        return sendJson(res, 200, { session: publicSession(s) });
      });
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
        // Bound concurrent agent processes so a client can't exhaust the host.
        if (inflight >= maxInflight()) return sendJson(res, 429, { error: "Too many concurrent turns; try again." });
        if (data.reset) session.started = false;
        if (data.mode && AGENTS[session.agent].modes[data.mode]) session.mode = data.mode;
        if (typeof data.voice === "boolean") session.voice = data.voice;
        if (typeof data.model === "string" && data.model.trim()) session.model = data.model.trim();
        inflight++;
        res.on("close", () => { inflight = Math.max(0, inflight - 1); });
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

    if (req.method === "POST" && urlPath === "/api/push/subscribe") {
      return readBody(req, 64 * 1024, (e, body) => {
        let data = {}; try { data = JSON.parse((body || "").toString("utf8") || "{}"); } catch (_) {}
        const ep = data.subscription && data.subscription.endpoint;
        if (typeof ep !== "string" || !/^https:\/\//i.test(ep)) return sendJson(res, 400, { error: "Bad subscription" });
        const idx = pushSubs.findIndex((s) => s.sub.endpoint === ep);
        const entry = { sub: data.subscription, sessionId: data.sessionId || null };
        if (idx >= 0) pushSubs[idx] = entry; else pushSubs.push(entry);
        while (pushSubs.length > 500) pushSubs.shift(); // bound memory; evict oldest
        return sendJson(res, 200, { ok: true });
      });
    }

    if (req.method === "POST" && urlPath === "/api/reset") {
      return readBody(req, 64 * 1024, (e, body) => {
        let data = {}; try { data = JSON.parse((body || "").toString("utf8") || "{}"); } catch (_) {}
        const session = resolveSession(data.sessionId);
        if (session) { session.started = false; session.history = []; } // also clears Ollama context
        return sendJson(res, 200, { ok: true });
      });
    }

    // List locally-available Ollama models (proxies /api/tags).
    if (req.method === "GET" && urlPath === "/api/ollama/models") {
      let url;
      try { url = new URL("/api/tags", ollamaUrl()); } catch (_) { return sendJson(res, 200, { models: [] }); }
      const lib = url.protocol === "https:" ? require("https") : require("http");
      const r2 = lib.get(url, (up) => {
        let data = "";
        up.on("data", (d) => (data += d));
        up.on("end", () => {
          let models = [];
          try { models = (JSON.parse(data).models || []).map((m) => m.name).filter(Boolean); } catch (_) {}
          sendJson(res, 200, { models });
        });
      });
      r2.on("error", () => sendJson(res, 200, { models: [] }));
      return;
    }

    return sendJson(res, 404, { error: "Not found" });
  }

  if (req.method === "GET") return serveStatic(req, res);
  send(res, 405, "Method not allowed");
}

function buildServer() {
  // Defense in depth: never let a synchronous throw in a handler crash the process.
  return http.createServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch (e) {
      try { sendJson(res, 500, { error: "Internal error" }); } catch (_) {}
    }
  });
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
  loadSessions(); // restore persisted sessions when SESSIONS_FILE is set
  if (!defaultSessionId || !sessions.has(defaultSessionId)) {
    const boot = createSession({ name: "default", agent: DEFAULT_AGENT, projectDir: DEFAULT_PROJECT_DIR });
    defaultSessionId = boot.id;
    saveSessions();
  }
  const boot = sessions.get(defaultSessionId);
  const server = buildServer();
  server.listen(PORT, HOST, () => {
    console.log(`voicebridge listening on http://${HOST}:${PORT}`);
    console.log(`default session: ${boot.name} · ${AGENTS[boot.agent].label} · ${boot.projectDir}`);
    console.log(`sessions: ${sessions.size}${sessionsFile() ? "  (persisted)" : ""}`);
    console.log(`agents: ${Object.keys(AGENTS).join(", ")}`);
    console.log(`STT mode: ${STT_MODE}${ACCESS_TOKEN ? "  (access token required)" : ""}`);
    const loopback = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";
    if (!loopback && !ACCESS_TOKEN) {
      console.warn("\n⚠️  WARNING: bound to a non-loopback address WITHOUT ACCESS_TOKEN.");
      console.warn("    Anyone who can reach this host can drive an agent on your machine.");
      console.warn("    Set ACCESS_TOKEN, or bind to 127.0.0.1 and expose via `tailscale serve`.\n");
    }
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
  parseDotEnv,
  parseClaudeLine,
  parseClaudeEvents,
  resolveMode,
  resolveRunner,
  binExists,
  agentAvailable,
  browseDir,
  listSlashCommands,
  listNpmScripts,
  buildPrompt,
  looksLikeQuestion,
  parseFavorites,
  phoneUrl,
  sessions,
  createSession,
  resolveSession,
  publicSession,
  saveSessions,
  loadSessions,
  buildServer,
  handleRequest,
  start,
  get defaultSessionId() { return defaultSessionId; },
  set defaultSessionId(v) { defaultSessionId = v; },
};
