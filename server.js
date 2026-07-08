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
const { spawn, execFile } = require("child_process");

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
  const inp = b.input || {};
  // File-ish args read better as a basename (Edit/Read show the filename). A
  // shell command must NOT be basenamed — "cat /dev/null" would show as "null".
  const file = inp.file_path || inp.path || inp.url;
  if (typeof file === "string" && file) {
    return (b.name || "tool") + " " + file.split("/").slice(-1)[0].slice(0, 40);
  }
  const text = inp.command || inp.pattern || inp.description;
  if (typeof text === "string" && text.trim()) {
    return (b.name || "tool") + " " + text.replace(/\s+/g, " ").trim().slice(0, 40);
  }
  return b.name || "tool";
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

function extractAgentConversationId(text) {
  const s = String(text || "");
  const patterns = [
    /"session[_-]?id"\s*:\s*"([^"]+)"/i,
    /"conversation[_-]?id"\s*:\s*"([^"]+)"/i,
    /\b(?:session|conversation|thread)\s*(?:id)?\s*[:=]\s*([A-Za-z0-9._:-]{6,})/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m && m[1]) return m[1];
  }
  return "";
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
    live: true, // supports the persistent --input-format stream-json live path (Tat X)
    defaultMode: "ask",
    modes: {
      ask: { label: "Ask for approval", args: [] },
      autoEdit: { label: "Approve edits", args: ["--permission-mode", "acceptEdits"] },
      full: { label: "Fully autonomous", args: ["--dangerously-skip-permissions"] },
    },
    // Prompt is passed positionally after -p (claude also accepts it on stdin).
    command(prompt, { cont, resume, modeArgs } = {}) {
      const argv = [...(modeArgs || [])];
      if (resume) argv.push("--resume", resume); // attach to an existing Claude session
      else if (cont) argv.push("--continue");
      argv.push("--output-format", "stream-json", "--verbose", "-p", prompt);
      return { argv, stdin: null };
    },
    parseLine: parseClaudeLine,
    parseEvents: parseClaudeEvents,
  },
  codex: {
    label: "Codex",
    bin: () => process.env.CODEX_BIN || "codex",
    supportsContinue: true,
    stream: "text",
    defaultMode: "auto",
    modes: {
      safe: { label: "Salt-okunur", args: ["-s", "read-only"] },
      auto: { label: "Otomatik (yazma)", args: ["-s", "workspace-write", "-c", "approval_policy=\"never\""] },
      full: { label: "Tam otonom", args: ["--dangerously-bypass-approvals-and-sandbox"] },
    },
    // `codex exec` reads fresh prompts from stdin; continued turns use the
    // official `codex exec resume ... -` form so the resumed prompt still comes
    // from stdin. CODEX_CONTINUE_ARGS remains as a compatibility override.
    command(prompt, { cont, resume, modeArgs } = {}) {
      const legacy = cont && splitArgs(process.env.CODEX_CONTINUE_ARGS);
      if (legacy && legacy.length) return { argv: ["exec", ...legacy, ...(modeArgs || [])], stdin: prompt };
      if (resume) return { argv: ["exec", "resume", ...(modeArgs || []), resume, "-"], stdin: prompt };
      if (cont) return { argv: ["exec", "resume", ...(modeArgs || []), "--last", "-"], stdin: prompt };
      return { argv: ["exec", ...(modeArgs || [])], stdin: prompt };
    },
    extractConversationId: extractAgentConversationId,
  },
  antigravity: {
    label: "Antigravity",
    bin: () => process.env.AGY_BIN || "agy",
    supportsContinue: true,
    stream: "text",
    defaultMode: "safe",
    modes: {
      safe: { label: "Sandbox", args: ["--sandbox"] },
      full: { label: "Tam otonom", args: ["--dangerously-skip-permissions"] },
    },
    // `agy --print` reads the prompt from stdin by default. CLIs vary, so the
    // base args (AGY_ARGS, default "--print") and prompt delivery (AGY_PROMPT_ARG=1
    // passes the prompt as a positional argument instead of stdin) are overridable.
    command(prompt, { cont, resume, modeArgs } = {}) {
      const base = process.env.AGY_ARGS ? splitArgs(process.env.AGY_ARGS) : ["--print"];
      const legacy = cont ? splitArgs(process.env.AGY_CONTINUE_ARGS) : [];
      const continuity = legacy.length ? legacy : resume ? ["--conversation", resume] : cont ? ["--continue"] : [];
      const argv = [...base, ...continuity, ...(modeArgs || [])];
      if (process.env.AGY_PROMPT_ARG) { argv.push(prompt); return { argv, stdin: null }; }
      return { argv, stdin: prompt };
    },
    extractConversationId: extractAgentConversationId,
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

// "local" runs the agent CLI here; "cloud" proxies to CLOUD_RUNNER_URL; "tmux"
// runs a full interactive claude in a tmux session you can also attach to (Tat Y).
function resolveRunner(runner) {
  runner = runner || "local";
  if (runner !== "local" && runner !== "cloud" && runner !== "tmux") throw new Error("unknown runner: " + runner);
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
function scanCommandsDir(commandsDir) {
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
  walk(commandsDir, []);
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

function listSlashCommands(baseDir) {
  return scanCommandsDir(path.join(baseDir, ".claude", "commands"));
}

// The user's global commands (~/.claude/commands) — available in every session,
// like in the Claude Code CLI.
function listGlobalCommands() {
  return scanCommandsDir(path.join(os.homedir(), ".claude", "commands"));
}

// Commands shipped by installed plugins. Each plugin's commands live in
// <installPath>/commands and are invoked as /name, same as project commands.
// Returns one group per plugin that actually ships commands (deduped by path).
// Note: built-in Claude Code app commands (e.g. /clear, /remote-control) are not
// file-based and run only in the interactive CLI, so they can't be surfaced here.
function listPluginCommandGroups() {
  const groups = [];
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(
      path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json"), "utf8"));
  } catch (_) { return groups; }
  const seen = new Set();
  for (const [key, records] of Object.entries(cfg.plugins || {})) {
    const name = String(key).split("@")[0];
    for (const rec of (records || [])) {
      const ip = rec && rec.installPath;
      if (!ip || seen.has(ip)) continue;
      seen.add(ip);
      const items = scanCommandsDir(path.join(ip, "commands"));
      if (items.length) groups.push({ label: "Plugin: " + name, items });
    }
  }
  return groups;
}

// package.json scripts → "npm run <name>".
function listNpmScripts(baseDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(baseDir, "package.json"), "utf8"));
    return Object.keys(pkg.scripts || {}).map((k) => ({ label: "npm run " + k, value: "npm run " + k }));
  } catch (_) { return []; }
}

// Per-agent command palette (#121). Slash commands are agent-specific: Claude's
// live in .claude/commands (+ global + plugins); Codex's are prompts in
// ~/.codex/prompts; Antigravity has no file-based commands. npm scripts are
// shell-level, so they're offered for every agent. This stops e.g. an
// Antigravity session from listing Claude-only commands it can't run.
function commandGroupsForAgent(agentId, projectDir) {
  const groups = [];
  if (agentId === "claude") {
    const proj = listSlashCommands(projectDir);
    if (proj.length) groups.push({ label: "Komutlar (proje)", items: proj });
    const glob = listGlobalCommands();
    if (glob.length) groups.push({ label: "Komutlar (global)", items: glob });
    for (const g of listPluginCommandGroups()) groups.push(g);
  } else if (agentId === "codex") {
    const cx = scanCommandsDir(path.join(os.homedir(), ".codex", "prompts"));
    if (cx.length) groups.push({ label: "Codex prompts", items: cx });
  }
  const npm = listNpmScripts(projectDir);
  if (npm.length) groups.push({ label: "npm scripts", items: npm });
  return groups;
}

// --- Resume an existing Claude Code session --------------------------------
// Claude Code stores each session as ~/.claude/projects/<encoded-path>/<id>.jsonl
// (project path with non-alphanumerics turned into "-"). We list those so a
// voicebridge session can attach to one and continue it by voice (claude
// -p --resume <id>). Lets you pick up a session you started in the CLI/desktop.
function encodeProjectPath(p) { return String(p || "").replace(/[^a-zA-Z0-9]/g, "-"); }

function firstUserText(file) {
  let fd;
  try { fd = fs.openSync(file, "r"); } catch (_) { return ""; }
  try {
    const buf = Buffer.alloc(65536); // first user line is near the top; don't read whole file
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.slice(0, n).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch (_) { continue; }
      if (o.type !== "user" || !o.message) continue;
      const c = o.message.content;
      let text = "";
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) {
        text = c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join(" ");
      }
      text = text.trim();
      if (text && !text.startsWith("<") && !text.startsWith("Caveat:")) return text.slice(0, 140);
    }
  } catch (_) {} finally { try { fs.closeSync(fd); } catch (_) {} }
  return "";
}

function listClaudeSessions(projectDir, limit = 40) {
  const dir = path.join(os.homedir(), ".claude", "projects", encodeProjectPath(projectDir));
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch (_) { return []; }
  const out = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let st; try { st = fs.statSync(full); } catch (_) { continue; }
    if (!st.size) continue;
    out.push({ id: f.slice(0, -6), mtime: st.mtimeMs, title: firstUserText(full) });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

// --- Live transcript sync (#141) ------------------------------------------
// Tail a session's .jsonl so every new turn — typed from the app, the local
// CLI, Remote Control, or another client — reaches all connected clients.
function safeListJsonl(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch (_) { return []; }
}

// One transcript line -> {role:'user'|'assistant', text} or null (skip meta,
// tool-only, and system-injected lines).
function turnFromTranscriptLine(line) {
  let o; try { o = JSON.parse(line); } catch (_) { return null; }
  if (o.isMeta || o.isSidechain) return null;
  if (o.type !== "user" && o.type !== "assistant") return null;
  const m = o.message; if (!m) return null;
  const c = m.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    text = c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
  }
  // Strip the metadata Remote Control appends to messages (e.g.
  // "<system-reminder>Message sent at …</system-reminder>") so it doesn't show
  // as noise in voicebridge. The CLI shows the raw message (Anthropic's).
  text = (text || "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (!text || text.startsWith("<") || text.startsWith("Caveat:")) return null;
  return { role: o.type, text };
}

// The .jsonl path backing a session: the tmux transcript captured at spawn, else
// the bound claudeSessionId, else the most-recently-written file in the dir.
function resolveJsonlPath(session) {
  if (session.tmuxJsonl && fs.existsSync(session.tmuxJsonl)) return session.tmuxJsonl;
  if (session.claudeSessionId) {
    const dir = path.join(os.homedir(), ".claude", "projects", encodeProjectPath(session.projectDir));
    const p = path.join(dir, session.claudeSessionId + ".jsonl");
    if (fs.existsSync(p)) return p;
  }
  // Not bound yet (e.g. a brand-new session before its first turn). Do NOT fall
  // back to the newest file in the dir — that's a DIFFERENT session's transcript
  // and would show the previous conversation. Empty until the first turn binds it.
  return null;
}

function readTranscriptTurns(jsonlPath, limit = 200) {
  let raw; try { raw = fs.readFileSync(jsonlPath, "utf8"); } catch (_) { return { turns: [], size: 0 }; }
  const turns = [];
  for (const line of raw.split("\n")) { if (!line.trim()) continue; const t = turnFromTranscriptLine(line); if (t) turns.push(t); }
  return { turns: turns.slice(-limit), size: Buffer.byteLength(raw, "utf8") };
}

function readFileTail(p, bytes) {
  try {
    const st = fs.statSync(p);
    const start = Math.max(0, st.size - bytes);
    const fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString("utf8");
  } catch (_) { return ""; }
}

// Identify a tmux session's transcript .jsonl by content: the file whose recent
// tail contains the just-sent user input. Robust even when many .jsonl share the
// project dir (worktrees, other sessions) — unlike "newest file". (#141 fix)
function findJsonlByContent(projectDir, needle) {
  needle = (needle || "").trim();
  if (needle.length < 6) return null;
  const dir = path.join(os.homedir(), ".claude", "projects", encodeProjectPath(projectDir));
  const files = safeListJsonl(dir)
    .map((f) => ({ f, m: (() => { try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch (_) { return 0; } })() }))
    .sort((a, b) => b.m - a.m)
    .slice(0, 12);
  for (const { f } of files) {
    if (readFileTail(path.join(dir, f), 131072).includes(needle)) return path.join(dir, f);
  }
  return null;
}

function maxSessions() { return parseInt(process.env.MAX_SESSIONS || "200", 10); }

function createSession({ name, agent, projectDir, mode, voice, runner, model, claudeSessionId, agentSessionId } = {}) {
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
    // When set, the FIRST turn resumes this existing Claude Code session
    // (claude -p --resume <id>) instead of starting fresh.
    claudeSessionId: (claudeSessionId && String(claudeSessionId).trim()) || undefined,
    // Generic per-agent conversation id/thread id for CLIs that expose one.
    agentSessionId: (agentSessionId && String(agentSessionId).trim()) || undefined,
    started: false,
  };
  sessions.set(id, s);
  return s;
}

function publicSession(s) {
  return {
    id: s.id, name: s.name, agent: s.agent, agentLabel: AGENTS[s.agent].label,
    projectDir: s.projectDir, mode: s.mode, voice: s.voice, runner: s.runner, model: s.model || null, started: s.started,
    claudeSessionId: s.claudeSessionId || null,
    agentSessionId: s.agentSessionId || null,
    handoff: s.handoff || null, // "pc" while handed off to the terminal (#123)
  };
}

function resolveSession(id) {
  // A provided-but-unknown id is an error; only fall back to the default when
  // the caller omitted the id entirely (backward compatibility).
  if (id) return sessions.get(id) || null;
  if (defaultSessionId) return sessions.get(defaultSessionId) || null;
  return null;
}

// Disk persistence so sessions survive a bridge restart — otherwise a restart
// mints brand-new session IDs and the phone's saved per-session history no
// longer matches, so conversations look "reset". The real server defaults this
// to ~/.voicebridge/sessions.json in start(); tests leave it unset (no-op).
// Set SESSIONS_FILE to "off" to disable persistence.
function sessionsFile() {
  const v = process.env.SESSIONS_FILE;
  if (v === "off" || v === "0" || v === "false") return "";
  return v || "";
}
function saveSessions(file) {
  file = file || sessionsFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const data = {
      seq: sessionSeq,
      defaultId: defaultSessionId,
      sessions: Array.from(sessions.values()).map((s) => ({
        id: s.id, name: s.name, agent: s.agent, projectDir: s.projectDir, mode: s.mode, voice: s.voice, runner: s.runner, model: s.model, claudeSessionId: s.claudeSessionId,
        agentSessionId: s.agentSessionId, started: s.started,
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
      voice: !!s.voice, runner: (s.runner === "cloud" || s.runner === "tmux") ? s.runner : "local",
      model: (s.model && String(s.model).trim()) || undefined,
      claudeSessionId: (s.claudeSessionId && String(s.claudeSessionId).trim()) || undefined,
      agentSessionId: (s.agentSessionId && String(s.agentSessionId).trim()) || undefined,
      // Claude attached sessions need one explicit --resume turn after restart;
      // non-Claude agents can continue immediately via their adapter.
      started: !!s.started && !(s.agent === "claude" && s.claudeSessionId),
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
  let done = false;
  const chunks = [];
  const finish = (err, body) => {
    if (done) return;
    done = true;
    cb(err, body);
  };
  req.on("data", (c) => {
    if (done) return;
    size += c.length;
    if (size > limitBytes) {
      const err = new Error("Request body too large");
      err.statusCode = 413;
      finish(err);
    }
    else chunks.push(c);
  });
  req.on("end", () => finish(null, Buffer.concat(chunks)));
  req.on("error", (err) => finish(err));
}

function sendBodyError(res, err, fallback = "Bad request") {
  if (err && err.statusCode === 413) return sendJson(res, 413, { error: "Payload too large" });
  return sendJson(res, 400, { error: fallback });
}

// ---------------------------------------------------------------------------
// Streaming a turn (NDJSON out: {type:"delta"|"done"|"error"})
// ---------------------------------------------------------------------------

// In voice-friendly mode, prepend a short instruction so the agent answers in a
// way that reads well aloud. The user's visible message is unchanged.
const VOICE_PREAMBLE =
  "Answer concisely, optimized for being read aloud by text-to-speech: avoid long " +
  "code blocks unless explicitly asked, and finish with a one-sentence spoken summary.";
// A slash command must be the very first thing in the message for Claude Code to
// recognize it, so we never prepend the voice preamble to one (#122) — otherwise
// a hands-free command like "/keel:ship" would be sent as plain prose and ignored.
function isSlashCommand(text) {
  return /^\s*\/[a-zA-Z]/.test(text);
}
function buildPrompt(voice, text) {
  if (isSlashCommand(text)) return text.trim();
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
    up.setEncoding("utf8");
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
  if (session.runner === "tmux") return streamTmux(session, prompt, res, emit);
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
    r.setEncoding("utf8"); // carry UTF-8 across chunk boundaries (no split → no ��)
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
    r.setEncoding("utf8");
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

// ---------------------------------------------------------------------------
// Tat Y — full interactive sessions via tmux (runner: "tmux")
// A real interactive `claude` runs in a detached tmux session (vb_<id>) so the
// SAME session can be driven from the phone (send-keys) and attached on the Mac
// (`tmux attach -t vb_<id>`), where built-ins like /remote-control work. Replies
// are scraped from the pane. Spike-proven; see #128-132.
// ---------------------------------------------------------------------------
const TMUX_IDLE_MS = Number(process.env.TMUX_IDLE_MS ?? 60 * 60 * 1000) || 0;
const TMUX_CAPTURE_LINES = Number(process.env.TMUX_CAPTURE_LINES ?? 1000) || 1000;
const tmuxIdleTimers = new Map(); // sessionId -> idle kill timer

function tmuxName(id) { return "vb_" + String(id).replace(/[^a-zA-Z0-9_]/g, "_"); }
function tmuxRun(args) {
  return new Promise((resolve) => {
    execFile("tmux", args, { env: process.env, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve({ err, out: (stdout || "").toString() }));
  });
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function tmuxHas(name) { return !(await tmuxRun(["has-session", "-t", name])).err; }
async function tmuxCapture(name, scroll) {
  const args = ["capture-pane", "-p", "-t", name];
  if (scroll) args.splice(1, 0, "-S", String(scroll));
  return (await tmuxRun(args)).out;
}
function killTmux(sessionId) {
  const t = tmuxIdleTimers.get(sessionId); if (t) { clearTimeout(t); tmuxIdleTimers.delete(sessionId); }
  tmuxRun(["kill-session", "-t", tmuxName(sessionId)]);
}

async function ensureTmuxClaude(session) {
  const name = tmuxName(session.id);
  if (await tmuxHas(name)) return name;
  // Deterministic transcript: give claude an explicit --session-id so we KNOW its
  // .jsonl path (no content-match guessing). Resume that same id after a
  // kill/idle/restart so context survives. DEFAULT mode (claude is in auto mode);
  // no --dangerously-skip-permissions.
  if (!session.claudeSessionId) session.claudeSessionId = crypto.randomUUID();
  const dir = path.join(os.homedir(), ".claude", "projects", encodeProjectPath(session.projectDir));
  session.tmuxJsonl = path.join(dir, session.claudeSessionId + ".jsonl");
  saveSessions();
  const launch = fs.existsSync(session.tmuxJsonl)
    ? ("claude --resume " + session.claudeSessionId)
    : ("claude --session-id " + session.claudeSessionId);
  await tmuxRun(["new-session", "-d", "-s", name, "-x", "220", "-y", "50", "-c", session.projectDir, launch]);
  for (let i = 0; i < 40; i++) { // wait for the welcome box / input prompt to render
    await sleepMs(500);
    if (/Claude Code v|❯/.test(await tmuxCapture(name))) { await sleepMs(900); break; }
  }
  return name;
}

function stripAnsi(text) {
  return String(text || "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[PX^_].*?\x1B\\/gs, "")
    .replace(/\x1B[@-_]/g, "")
    .replace(/\r/g, "");
}

// Turn a captured claude TUI pane into the clean assistant reply: drop the welcome
// box, ─── input borders, the ❯ echo, ✻ Cogitated and ⎿ chrome; keep the ⏺ body.
function extractTuiReply(pane, promptEcho) {
  const lines = stripAnsi(pane).split("\n");
  const key = (promptEcho || "").trim().slice(0, 24);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.startsWith("❯") && key && t.includes(key)) { start = i; break; }
  }
  if (start < 0) for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].trim().startsWith("⏺")) { start = i - 1; break; } }
  const out = [];
  let sawAssistant = false;
  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i];
    const t = lines[i].trim();
    if (!t) { out.push(""); continue; }
    if (/^[╭╰│]/.test(t)) continue;          // welcome box
    if (/^─{5,}$/.test(t)) break;             // bottom input border → reply ended
    if (t.startsWith("❯")) break;             // empty input prompt → ended
    if (/^✻/.test(t)) continue;               // "Cogitated for Xs"
    if (/^⎿/.test(t)) continue;               // hook/tool-result chrome
    if (!sawAssistant && tmuxStillGenerating(t)) continue;
    if (/^\s*⏺/.test(raw)) sawAssistant = true;
    out.push(raw.replace(/^\s*⏺\s?/, "").replace(/^\s{0,3}/, ""));
  }
  if (!sawAssistant) return "";
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const TMUX_GENERATING_RE = /esc to interrupt|Cogitating|Thinking|Working…|Pondering|Forging/i;
function tmuxStillGenerating(pane) {
  return TMUX_GENERATING_RE.test(stripAnsi(pane));
}

function tmuxCaptureErrorMessage(reason) {
  return "couldn't capture tmux reply: " + reason + ". Attach with `tmux attach` on your Mac to inspect the live session.";
}

// Drive one turn through the tmux-hosted interactive claude.
async function streamTmux(session, prompt, res, emit) {
  const old = tmuxIdleTimers.get(session.id); if (old) { clearTimeout(old); tmuxIdleTimers.delete(session.id); }
  let name;
  try { name = await ensureTmuxClaude(session); }
  catch (e) { emit({ type: "error", error: "couldn't start tmux: " + e.message }); return res.end(); }

  // The TUI input is single-line and submits on Enter; flatten newlines.
  const text = buildPrompt(session.voice, prompt).replace(/\s*\n\s*/g, " ").trim();
  await tmuxRun(["send-keys", "-t", name, "-l", text]);
  await sleepMs(180);
  await tmuxRun(["send-keys", "-t", name, "Enter"]);
  emit({ type: "activity", text: "tmux: claude is thinking…" });

  const MAXMS = (Number(process.env.AGENT_TIMEOUT_MS ?? 20 * 60 * 1000) || 0) || 20 * 60 * 1000;
  const t0 = Date.now();
  let prev = "", stable = 0, sawGen = false, closed = false;
  res.on("close", () => { closed = true; }); // barge-in: leave the tmux session alive
  while (!closed && Date.now() - t0 < MAXMS) {
    await sleepMs(1400);
    const cur = await tmuxCapture(name);
    if (tmuxStillGenerating(cur)) sawGen = true;
    if (cur === prev) stable++; else stable = 0;
    prev = cur;
    if (stable >= 2 && !tmuxStillGenerating(cur) && (sawGen || stable >= 4)) break;
  }
  if (closed) return; // barge-in — process keeps running for the next turn / attach
  if (Date.now() - t0 >= MAXMS && tmuxStillGenerating(prev)) {
    emit({ type: "error", error: agentTimeoutMessage("Claude tmux", MAXMS) });
    return res.end();
  }
  const reply = extractTuiReply(await tmuxCapture(name, -Math.abs(TMUX_CAPTURE_LINES)), text);
  if (!reply) {
    emit({ type: "error", error: tmuxCaptureErrorMessage("pane did not contain a completed assistant reply") });
    return res.end();
  }
  emit({ type: "delta", text: reply });
  session.started = true;
  // Bind the transcript .jsonl by content — the file containing this turn's input
  // (reliable even with many .jsonl in the dir). Needed for sync/resume/handoff.
  if (!session.claudeSessionId) {
    const jp = findJsonlByContent(session.projectDir, String(prompt || "").slice(0, 80));
    if (jp) {
      session.tmuxJsonl = jp;
      session.claudeSessionId = path.basename(jp).replace(/\.jsonl$/, "");
      saveSessions();
    }
  }
  if (TMUX_IDLE_MS > 0) tmuxIdleTimers.set(session.id, setTimeout(() => killTmux(session.id), TMUX_IDLE_MS));
  emit({ type: "done" });
  res.end();
}

// ---------------------------------------------------------------------------
// Tat X — persistent live sessions (behind PERSISTENT_SESSIONS=1)
// One long-lived `claude --print --input-format stream-json` process per session
// keeps conversation history IN-MEMORY across turns (no per-turn --resume reload)
// and lets slash commands run. Proven by probe. The
// per-turn streamLocal path below stays as the fallback when the flag is off.
// ---------------------------------------------------------------------------
const LIVE_ENABLED = process.env.PERSISTENT_SESSIONS === "1";
const LIVE_IDLE_MS = Number(process.env.LIVE_IDLE_MS ?? 30 * 60 * 1000) || 0;
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 5000) || 5000;
function agentTimeoutMs() {
  return Number(process.env.AGENT_TIMEOUT_MS ?? 20 * 60 * 1000) || 0;
}
function agentTimeoutMessage(agentLabel, timeoutMs) {
  return `${agentLabel} didn't finish within ${Math.round(timeoutMs / 60000)} min (timed out, stopped). Side effects (file changes, issues, etc.) may have occurred. For longer tasks, raise AGENT_TIMEOUT_MS on the server (0 = unlimited).`;
}
const liveProcs = new Map(); // sessionId -> { child, buf, busy, idleTimer }

function killLive(sessionId) {
  const p = liveProcs.get(sessionId);
  if (!p) return;
  liveProcs.delete(sessionId);
  if (p.idleTimer) { clearTimeout(p.idleTimer); p.idleTimer = null; }
  try { p.child.stdin.end(); } catch (_) {}
  try { p.child.kill("SIGTERM"); } catch (_) {}
}

function killAllLive() {
  for (const id of Array.from(liveProcs.keys())) {
    try { killLive(id); } catch (_) {}
  }
}

function getOrSpawnLive(session) {
  const existing = liveProcs.get(session.id);
  if (existing && !existing.child.killed) return existing;
  const modeArgs = (AGENTS.claude.modes[session.mode] || AGENTS.claude.modes[AGENTS.claude.defaultMode]).args;
  const argv = [...modeArgs, "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
  // Resume the bound Claude session if we have one — on the first run after an
  // idle-kill or when reclaiming from a PC handoff, this restores history that
  // would otherwise be lost when the process was killed (#123).
  if (session.claudeSessionId) argv.push("--resume", session.claudeSessionId);
  const child = spawn(AGENTS.claude.bin(), argv, { cwd: session.projectDir, env: process.env });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const p = { child, buf: "", busy: false, idleTimer: null };
  liveProcs.set(session.id, p);
  const drop = () => { if (liveProcs.get(session.id) === p) liveProcs.delete(session.id); };
  child.on("exit", drop);
  child.on("error", drop);
  return p;
}

// Drive one turn through the persistent process: write the user message as an
// Anthropic Messages NDJSON line, stream assistant/tool events back until this
// turn's `result` line, then resolve. The process survives for the next turn.
function streamLive(session, prompt, res, emit) {
  // Handoff: while handed off to the PC the live process was killed. A new phone
  // turn means the user is taking it back, so auto-reclaim and respawn (which
  // --resume's the possibly PC-advanced history). Single-writer holds because the
  // phone process was gone during the handoff. (#123)
  if (session.handoff === "pc") { session.handoff = null; saveSessions(); }
  const p = getOrSpawnLive(session);
  if (p.busy) { emit({ type: "error", error: "This session is busy right now (the previous turn is still running)." }); return res.end(); }
  p.busy = true;
  if (p.idleTimer) { clearTimeout(p.idleTimer); p.idleTimer = null; }

  const agent = AGENTS[session.agent] || { label: "Live agent" };
  let replyText = "";
  let finished = false;
  let stderr = "";
  let timeoutTimer = null;

  let released = false;   // process turn fully drained to its `result` (busy freed)

  // Free the process for the next turn. Only safe once this turn's `result` has
  // been consumed — otherwise leftover stdout corrupts the next turn's framing.
  const release = (rearmIdle = true) => {
    if (released) return;
    released = true;
    if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
    p.child.stdout.removeListener("data", onData);
    p.child.stderr.removeListener("data", onErr);
    p.child.removeListener("exit", onExit);
    p.busy = false;
    if (rearmIdle && LIVE_IDLE_MS > 0) p.idleTimer = setTimeout(() => killLive(session.id), LIVE_IDLE_MS);
  };
  const failAndRespawnNextTurn = (errMsg) => {
    endHttp(errMsg);
    if (liveProcs.get(session.id) === p) liveProcs.delete(session.id);
    if (p.idleTimer) { clearTimeout(p.idleTimer); p.idleTimer = null; }
    try { p.child.kill("SIGTERM"); } catch (_) {}
    release(false);
  };
  // Settle the HTTP response (emit done/error once). Independent of release: on
  // barge-in the response settles immediately while the process keeps draining.
  const endHttp = (errMsg) => {
    if (finished) return;
    finished = true;
    if (errMsg) emit({ type: "error", error: errMsg });
    else {
      session.started = true;
      emit({ type: "done" });
      if (looksLikeQuestion(replyText)) {
        sendPush({ title: "voicebridge — " + session.name + " soru sordu", body: replyText.trim().slice(-160), sessionId: session.id });
      }
    }
    try { res.end(); } catch (_) {}
  };
  const onLine = (line) => {
    let obj; try { obj = JSON.parse(line); } catch (_) { return; }
    // Bind/refresh the Claude session id so handoff can surface `claude --resume`
    // and a respawn can restore history (#123).
    if (obj.session_id && session.claudeSessionId !== obj.session_id) { session.claudeSessionId = obj.session_id; saveSessions(); }
    if (!finished) { // after barge-in we keep draining but stop emitting
      for (const ev of parseClaudeEvents(line)) { if (ev.type === "delta") replyText += ev.text; emit(ev); }
    }
    if (obj.type === "result") { // this turn is fully consumed → safe to free
      endHttp(obj.is_error ? (obj.result || "Live turn failed.") : null);
      release();
    }
  };
  const onData = (d) => {
    p.buf += d;
    let i;
    while ((i = p.buf.indexOf("\n")) >= 0) {
      const line = p.buf.slice(0, i).trim();
      p.buf = p.buf.slice(i + 1);
      if (line) onLine(line);
    }
  };
  const onErr = (d) => { stderr += d; };
  const onExit = (code) => { endHttp(stderr.trim() || ("Live session exited (code " + code + ").")); release(); };

  p.child.stdout.on("data", onData);
  p.child.stderr.on("data", onErr);
  p.child.on("exit", onExit);
  const TIMEOUT_MS = agentTimeoutMs();
  if (TIMEOUT_MS > 0) {
    timeoutTimer = setTimeout(() => {
      failAndRespawnNextTurn(agentTimeoutMessage(agent.label, TIMEOUT_MS));
    }, TIMEOUT_MS);
  }
  // Barge-in: HTTP response closed mid-turn. We must NOT kill the persistent
  // process (in-memory history must survive) and must NOT free it until this
  // turn's `result` arrives — so we stop emitting now and keep draining (onLine
  // → release on result). The model finishes server-side in a few seconds; the
  // phone already silenced its TTS. Snappy mid-turn interrupt is a follow-up.
  res.on("close", () => { finished = true; });

  const userLine = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: buildPrompt(session.voice, prompt) }] } }) + "\n";
  try { p.child.stdin.write(userLine); } catch (e) { failAndRespawnNextTurn(e.message); }
}

// Local runner: spawn the agent CLI on this machine.
function streamLocal(session, prompt, res, emit) {
  // Tat X: when enabled, agents that declare `live` run through the persistent
  // process; the rest (codex, antigravity — no streaming-input mode) fall back
  // to the per-turn path below.
  if (LIVE_ENABLED && AGENTS[session.agent] && AGENTS[session.agent].live) return streamLive(session, prompt, res, emit);
  const agent = AGENTS[session.agent];
  const cont = session.started && agent.supportsContinue;
  // Claude attached sessions resume by Claude's id on the first turn. Other
  // agents use their own persisted conversation/thread id when one is known.
  const resume = session.agent === "claude"
    ? ((!session.started && session.claudeSessionId) ? session.claudeSessionId : null)
    : (session.agentSessionId || null);
  const modeArgs = (agent.modes[session.mode] || agent.modes[agent.defaultMode]).args;
  const { argv, stdin } = agent.command(buildPrompt(session.voice, prompt), { cont, resume, modeArgs });

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

  // Per-turn cap so a runaway agent can't hold the host forever. Generous by
  // default for real coding tasks; set AGENT_TIMEOUT_MS (ms) to tune, 0 = no cap.
  let timedOut = false;
  const TIMEOUT_MS = agentTimeoutMs();
  const timer = TIMEOUT_MS > 0
    ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, TIMEOUT_MS)
    : null;
  let buf = "";
  let stderr = "";
  let stdoutSeen = "";
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

  // Decode stdout/stderr as UTF-8 with carry-over across chunk boundaries, so a
  // multi-byte char (é, ñ, 中, …) split between two chunks isn't mangled into ��.
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    const s = d.toString();
    stdoutSeen += s;
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
    if (timedOut && !gotText) {
      emit({ type: "error", error: agentTimeoutMessage(agent.label, TIMEOUT_MS) });
    } else if (code !== 0 && !gotText) {
      emit({ type: "error", error: stderr.trim() || `${agent.label} exited with code ${code}.` });
    } else {
      const id = agent.extractConversationId ? agent.extractConversationId(stdoutSeen + "\n" + stderr) : "";
      if (id && session.agentSessionId !== id) session.agentSessionId = id;
      session.started = true;
      saveSessions();
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
    const includePrivateConfig = !ACCESS_TOKEN || authorized(req);
    return sendJson(res, 200, {
      sttMode: STT_MODE,
      authRequired: !!ACCESS_TOKEN,
      agents: Object.keys(AGENTS).map((id) => ({
        id, label: AGENTS[id].label, supportsContinue: AGENTS[id].supportsContinue,
        defaultMode: AGENTS[id].defaultMode, available: agentAvailable(id),
        modes: Object.keys(AGENTS[id].modes).map((m) => ({ id: m, label: AGENTS[id].modes[m].label })),
      })),
      ...(includePrivateConfig ? {
        defaultProjectDir: DEFAULT_PROJECT_DIR,
        defaultSessionId,
        favorites: FAVORITES,
      } : {}),
      runners: ["local"].concat((process.env.CLOUD_RUNNER_URL || "") ? ["cloud"] : []),
    });
  }

  if (urlPath.startsWith("/api/")) {
    if (!authorized(req)) return sendJson(res, 401, { error: "Unauthorized" });

    // Browse local directories (for the project-folder picker).
    // Commands available in a session's project (slash commands + npm scripts).
    if (req.method === "GET" && urlPath === "/api/commands") {
      const q = new URL(req.url, "http://x").searchParams;
      const session = resolveSession(q.get("sessionId"));
      if (!session) return sendJson(res, 404, { error: "unknown session" });
      if (session.runner === "cloud") return sendJson(res, 200, { groups: [] }); // remote dir; see #89
      // Per-agent palette: explicit ?agent= wins (lets the app preview another
      // agent's commands), else the session's own agent.
      const agentId = q.get("agent") || session.agent;
      return sendJson(res, 200, { groups: commandGroupsForAgent(agentId, session.projectDir) });
    }

    // Existing Claude Code sessions for a project dir (to attach & resume by voice).
    if (req.method === "GET" && urlPath === "/api/claude-sessions") {
      const q = new URL(req.url, "http://x").searchParams;
      let projectDir = q.get("projectDir");
      if (!projectDir) {
        const s = resolveSession(q.get("sessionId"));
        if (s) projectDir = s.projectDir;
      }
      if (!projectDir) return sendJson(res, 400, { error: "projectDir required" });
      return sendJson(res, 200, { sessions: listClaudeSessions(projectDir) });
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
        if (e) return sendBodyError(res, e);
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
      if (existed) { killTmux(id); killLive(id); saveSessions(); } // tear down any live/tmux backing process
      return sendJson(res, existed ? 200 : 404, existed ? { ok: true } : { error: "Not found" });
    }

    // Update a session's name / mode / voice.
    if (req.method === "POST" && urlPath.startsWith("/api/sessions/")) {
      const id = urlPath.slice("/api/sessions/".length);
      const s = sessions.get(id);
      if (!s) return sendJson(res, 404, { error: "Not found" });
      return readBody(req, 64 * 1024, (e, body) => {
        if (e) return sendBodyError(res, e);
        let data = {}; try { data = JSON.parse((body || "").toString("utf8") || "{}"); } catch (_) {}
        if (typeof data.name === "string" && data.name.trim()) s.name = data.name.trim();
        if (data.mode && AGENTS[s.agent].modes[data.mode]) s.mode = data.mode;
        if (typeof data.voice === "boolean") s.voice = data.voice;
        // Attach to (or detach from) an existing Claude Code session. Reset
        // `started` so the next turn resumes it via --resume.
        if (typeof data.claudeSessionId === "string") {
          s.claudeSessionId = data.claudeSessionId.trim() || undefined;
          s.started = false;
        }
        saveSessions();
        return sendJson(res, 200, { session: publicSession(s) });
      });
    }

    if (req.method === "POST" && urlPath === "/api/ask") {
      return readBody(req, 64 * 1024, (e, body) => {
        if (e) return sendBodyError(res, e);
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

    // Neural TTS via Piper. POST {text} -> audio/wav. Opt-in from the app so the
    // phone can use a Mac-side neural voice instead of on-device flutter_tts.
    // Configurable via PIPER_BIN / PIPER_VOICE / PIPER_DATA_DIR.
    if (req.method === "POST" && urlPath === "/api/tts") {
      return readBody(req, 64 * 1024, (e, body) => {
        if (e) return sendBodyError(res, e);
        let data = {}; try { data = JSON.parse((body || "").toString("utf8") || "{}"); } catch (_) {}
        const text = (typeof data.text === "string" ? data.text : "").trim();
        if (!text) return sendJson(res, 400, { error: "Empty text" });
        const bin = process.env.PIPER_BIN || path.join(os.homedir(), ".local/bin/piper");
        const model = process.env.PIPER_VOICE || "tr_TR-dfki-medium";
        const dataDir = process.env.PIPER_DATA_DIR || path.join(os.homedir(), ".local/share/piper-voices");
        const tmp = path.join(os.tmpdir(), "vb-tts-" + crypto.randomBytes(6).toString("hex") + ".wav");
        let child;
        try { child = spawn(bin, ["-m", model, "--data-dir", dataDir, "-f", tmp], { env: process.env }); }
        catch (ee) { return sendJson(res, 500, { error: "piper spawn: " + ee.message }); }
        let err = "";
        child.stderr.on("data", (d) => (err += d.toString()));
        child.on("error", (ee) => { try { fs.unlinkSync(tmp); } catch (_) {} sendJson(res, 500, { error: "piper: " + ee.message }); });
        child.on("close", (code) => {
          if (code !== 0) { try { fs.unlinkSync(tmp); } catch (_) {} return sendJson(res, 500, { error: err.trim().slice(0, 300) || ("piper exit " + code) }); }
          fs.readFile(tmp, (re, buf) => {
            fs.unlink(tmp, () => {});
            if (re || !buf || !buf.length) return sendJson(res, 500, { error: "tts produced no audio" });
            res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": buf.length });
            res.end(buf);
          });
        });
        try { child.stdin.write(text); child.stdin.end(); } catch (_) {}
      });
    }

    if (req.method === "POST" && urlPath === "/api/stt") {
      return readBody(req, 12 * 1024 * 1024, (e, body) => {
        if (e) return sendBodyError(res, e, "No audio");
        if (!body || !body.length) return sendJson(res, 400, { error: "No audio" });
        transcribe(body, req.headers["content-type"] || "", (terr, text) => {
          if (terr) return sendJson(res, 500, { error: terr.message });
          sendJson(res, 200, { text });
        });
      });
    }

    if (req.method === "POST" && urlPath === "/api/push/subscribe") {
      return readBody(req, 64 * 1024, (e, body) => {
        if (e) return sendBodyError(res, e);
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
        if (e) return sendBodyError(res, e);
        let data = {}; try { data = JSON.parse((body || "").toString("utf8") || "{}"); } catch (_) {}
        const session = resolveSession(data.sessionId);
        if (session) { session.started = false; session.history = []; } // also clears Ollama context
        return sendJson(res, 200, { ok: true });
      });
    }

    // PC handoff (#123). direction:"pc" pauses the phone's live session and
    // returns a `claude --resume <id>` for the terminal — the live process is
    // killed first so the phone and the PC never write the same .jsonl at once
    // (single-writer). direction:"phone" reclaims it; the next phone turn
    // respawns and --resume's the (possibly PC-advanced) history.
    if (req.method === "POST" && urlPath === "/api/handoff") {
      return readBody(req, 16 * 1024, (e, body) => {
        if (e) return sendBodyError(res, e);
        let data = {}; try { data = JSON.parse((body || "").toString("utf8") || "{}"); } catch (_) {}
        const session = resolveSession(data.sessionId);
        if (!session) return sendJson(res, 404, { error: "Unknown session" });
        if (data.direction === "phone") {
          session.handoff = null;
          saveSessions();
          return sendJson(res, 200, { ok: true, direction: "phone" });
        }
        const id = session.claudeSessionId || null;
        killLive(session.id); // release the writer before the PC resumes it
        session.handoff = "pc";
        saveSessions();
        return sendJson(res, 200, {
          ok: true, direction: "pc", claudeSessionId: id, projectDir: session.projectDir,
          resumeCmd: id ? ("claude --resume " + id) : null,
          note: id ? null : "This session hasn't run a turn yet; there's no Claude session to hand off.",
        });
      });
    }

    // Tat Y: how to reach a full (tmux) session live on the Mac, and from there
    // the Claude app via /remote-control. (#131)
    if (req.method === "GET" && urlPath === "/api/tmux-attach") {
      const q = new URL(req.url, "http://x").searchParams;
      const session = resolveSession(q.get("sessionId"));
      if (!session) return sendJson(res, 404, { error: "Unknown session" });
      if (session.runner !== "tmux") return sendJson(res, 400, { error: "This session isn't in full (tmux) session mode." });
      const name = tmuxName(session.id);
      return tmuxHas(name).then(async (running) => {
        let rcActive = false;
        if (running) { try { rcActive = /\/rc active/.test(await tmuxCapture(name)); } catch (_) {} }
        sendJson(res, 200, {
          name, running, rcActive,
          attachCmd: "tmux attach -t " + name,
          remoteControlSteps: [
            "Mac terminalinde: tmux attach -t " + name,
            "In the opened claude session: /remote-control",
            "Connect to this session in the Claude mobile app",
          ],
        });
      });
    }

    // Toggle Remote Control on a full (tmux) session from the app (#rc). start
    // sends /remote-control; stop opens the menu and navigates to "Disconnect
    // this session" (no dedicated stop command exists yet).
    if (req.method === "POST" && urlPath === "/api/tmux-rc") {
      return readBody(req, 4 * 1024, async (e, body) => {
        if (e) return sendBodyError(res, e);
        let data = {}; try { data = JSON.parse((body || "").toString("utf8") || "{}"); } catch (_) {}
        const session = resolveSession(data.sessionId);
        if (!session) return sendJson(res, 404, { error: "Unknown session" });
        if (session.runner !== "tmux") return sendJson(res, 400, { error: "This session isn't a full (tmux) session." });
        const name = tmuxName(session.id);
        if (!(await tmuxHas(name))) return sendJson(res, 400, { error: "The tmux session isn't running." });
        const stop = data.action === "stop";
        await tmuxRun(["send-keys", "-t", name, "-l", "/remote-control"]);
        await sleepMs(150);
        await tmuxRun(["send-keys", "-t", name, "Enter"]);
        if (!stop) return sendJson(res, 200, { ok: true, action: "start" });
        // stop: navigate the disconnect menu (selection starts on "Continue").
        await sleepMs(2600);
        const lines = (await tmuxCapture(name)).split("\n");
        const disc = lines.findIndex((l) => /Disconnect this session/i.test(l));
        let sel = -1;
        for (let i = lines.length - 1; i >= 0; i--) { if (/^\s*❯\s+\S/.test(lines[i])) { sel = i; break; } }
        if (disc >= 0 && sel > disc) {
          for (let i = 0; i < sel - disc; i++) { await tmuxRun(["send-keys", "-t", name, "Up"]); await sleepMs(120); }
          await tmuxRun(["send-keys", "-t", name, "Enter"]);
          return sendJson(res, 200, { ok: true, action: "stop" });
        }
        await tmuxRun(["send-keys", "-t", name, "Escape"]); // bail out cleanly
        return sendJson(res, 200, { ok: false, action: "stop", note: "Disconnect menu not found; you can close it with /remote-control on your Mac." });
      });
    }

    // Fire-and-forget input to a full (tmux) session (#sync). Just send-keys the
    // text + Enter and return — the watch renders the turn. This decouples send
    // from receive, so a prompt/question waiting in the TUI never blocks the app
    // (and you answer it by sending "y"/"1"/etc. as the next message).
    if (req.method === "POST" && urlPath === "/api/tmux-send") {
      return readBody(req, 64 * 1024, (e, body) => {
        if (e) return sendBodyError(res, e);
        let data = {}; try { data = JSON.parse((body || "").toString("utf8") || "{}"); } catch (_) {}
        const session = resolveSession(data.sessionId);
        if (!session) return sendJson(res, 404, { error: "Unknown session" });
        if (session.runner !== "tmux") return sendJson(res, 400, { error: "This session isn't a full (tmux) session." });
        const text = (typeof data.text === "string" ? data.text : "").replace(/\s*\n\s*/g, " ");
        (async () => {
          let name;
          try { name = await ensureTmuxClaude(session); }
          catch (err) { return sendJson(res, 500, { error: "tmux: " + err.message }); }
          if (text.length) { await tmuxRun(["send-keys", "-t", name, "-l", text]); await sleepMs(150); }
          await tmuxRun(["send-keys", "-t", name, "Enter"]);
          sendJson(res, 200, { ok: true });
          // Bind the transcript .jsonl by content shortly after (the user message
          // is written quickly) so sync/resume have the id.
          if (!session.claudeSessionId && text.trim().length >= 6) {
            setTimeout(() => {
              const jp = findJsonlByContent(session.projectDir, text.slice(0, 80));
              if (jp) { session.tmuxJsonl = jp; session.claudeSessionId = path.basename(jp).replace(/\.jsonl$/, ""); saveSessions(); }
            }, 2500);
          }
        })();
      });
    }

    // Live transcript (#141). Full history of a session's .jsonl as {role,text}
    // turns + the byte offset to resume a watch from.
    if (req.method === "GET" && urlPath === "/api/session-history") {
      const q = new URL(req.url, "http://x").searchParams;
      const session = resolveSession(q.get("sessionId"));
      if (!session) return sendJson(res, 404, { error: "Unknown session" });
      const jsonl = resolveJsonlPath(session);
      if (!jsonl) return sendJson(res, 200, { turns: [], size: 0 });
      return sendJson(res, 200, readTranscriptTurns(jsonl));
    }

    // Live watch (#141): tail the session's .jsonl and stream every new turn
    // (from any client/CLI/Remote Control) as NDJSON {type:"turn",role,text}.
    if (req.method === "GET" && urlPath === "/api/session-watch") {
      const q = new URL(req.url, "http://x").searchParams;
      const session = resolveSession(q.get("sessionId"));
      if (!session) return sendJson(res, 404, { error: "Unknown session" });
      const jsonl = resolveJsonlPath(session);
      if (!jsonl) return sendJson(res, 404, { error: "No transcript for this session." });
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no",
      });
      // Send each turn immediately (no Nagle buffering) — without this some
      // clients (notably the macOS app) get turns late or not at all.
      try { res.socket && res.socket.setNoDelay(true); } catch (_) {}
      let offset = Number(q.get("since"));
      if (!Number.isFinite(offset) || offset < 0) { try { offset = fs.statSync(jsonl).size; } catch (_) { offset = 0; } }
      let carry = "", closed = false;
      const write = (obj) => { try { res.write(JSON.stringify(obj) + "\n"); } catch (_) {} };
      write({ type: "ready", offset });
      const tick = () => {
        if (closed) return;
        let size; try { size = fs.statSync(jsonl).size; } catch (_) { return; }
        if (size < offset) { offset = 0; carry = ""; } // rotated/truncated
        if (size <= offset) return;
        let chunk = "";
        try {
          const fd = fs.openSync(jsonl, "r");
          const buf = Buffer.alloc(size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          fs.closeSync(fd);
          chunk = buf.toString("utf8");
        } catch (_) { return; }
        offset = size; carry += chunk;
        let nl;
        while ((nl = carry.indexOf("\n")) >= 0) {
          const line = carry.slice(0, nl); carry = carry.slice(nl + 1);
          const t = turnFromTranscriptLine(line);
          if (t) write({ type: "turn", role: t.role, text: t.text, offset });
        }
      };
      const timer = setInterval(tick, 1000);
      // offset on the ping lets a reconnecting client resume without gaps/dups.
      const beat = setInterval(() => write({ type: "ping", offset }), 20000);
      const stop = () => { if (closed) return; closed = true; clearInterval(timer); clearInterval(beat); try { res.end(); } catch (_) {} };
      req.on("close", stop); res.on("close", stop); res.on("error", stop);
      return;
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
    } catch (_) {
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

function closeServerForShutdown(server) {
  return new Promise((resolve) => {
    if (!server || typeof server.close !== "function") return resolve();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      server.close(done);
      if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    } catch (_) {
      done();
    }
  });
}

function createShutdownHandler(server, opts = {}) {
  const exit = opts.exit || process.exit.bind(process);
  const logger = opts.logger || console;
  const graceMs = Number(opts.graceMs ?? SHUTDOWN_GRACE_MS) || SHUTDOWN_GRACE_MS;
  let shuttingDown = false;
  return function shutdown(signal = "shutdown") {
    if (shuttingDown) return;
    shuttingDown = true;
    try { logger.log(`voicebridge shutting down (${signal})...`); } catch (_) {}
    killAllLive();
    const forceTimer = setTimeout(() => {
      try { logger.error(`voicebridge shutdown timed out after ${graceMs}ms; exiting.`); } catch (_) {}
      exit(1);
    }, graceMs);
    if (typeof forceTimer.unref === "function") forceTimer.unref();
    closeServerForShutdown(server).then(() => {
      clearTimeout(forceTimer);
      exit(0);
    });
  };
}

function start() {
  // Persist sessions by default (real server only — tests never call start()),
  // so a restart keeps the same session IDs and the phone's history still matches.
  if (process.env.SESSIONS_FILE == null) {
    process.env.SESSIONS_FILE = path.join(os.homedir(), ".voicebridge", "sessions.json");
  }
  loadSessions(); // restore persisted sessions
  if (!defaultSessionId || !sessions.has(defaultSessionId)) {
    const boot = createSession({ name: "default", agent: DEFAULT_AGENT, projectDir: DEFAULT_PROJECT_DIR });
    defaultSessionId = boot.id;
    saveSessions();
  }
  const boot = sessions.get(defaultSessionId);
  const server = buildServer();
  const shutdown = createShutdownHandler(server);
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
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
  _internals: {
    createShutdownHandler,
    extractAgentConversationId,
    extractTuiReply,
    killAllLive,
    killLive,
    liveProcs,
    stripAnsi,
    tmuxCaptureErrorMessage,
    tmuxStillGenerating,
    TMUX_GENERATING_RE,
  },
  get defaultSessionId() { return defaultSessionId; },
  set defaultSessionId(v) { defaultSessionId = v; },
};
