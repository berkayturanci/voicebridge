"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { DEFAULT_PROJECT_DIR, DEFAULT_AGENT, maxSessions, sessionsFile } = require("../config");
const { AGENTS, resolveMode, resolveRunner } = require("../adapters");
const { encodeProjectPath } = require("../adapters/claude");

const sessions = new Map();
let sessionSeq = 0;
let defaultSessionId = null;

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

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

function firstUserText(file) {
  let fd;
  try { fd = fs.openSync(file, "r"); } catch (_) { return ""; }
  try {
    const buf = Buffer.alloc(65536);
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

function safeListJsonl(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch (_) { return []; }
}

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
  text = (text || "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (!text || text.startsWith("<") || text.startsWith("Caveat:")) return null;
  return { role: o.type, text };
}

function sanitizeSessionId(id) {
  if (typeof id !== "string") return undefined;
  const clean = id.trim();
  return /^[a-zA-Z0-9_-]{1,64}$/.test(clean) ? clean : undefined;
}

function resolveJsonlPath(session) {
  if (session.tmuxJsonl && fs.existsSync(session.tmuxJsonl)) return session.tmuxJsonl;
  const sid = sanitizeSessionId(session.claudeSessionId);
  if (sid) {
    const dir = path.join(os.homedir(), ".claude", "projects", encodeProjectPath(session.projectDir));
    const p = path.join(dir, sid + ".jsonl");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readTranscriptTurns(jsonlPath, limit = 200) {
  let raw; try { raw = fs.readFileSync(jsonlPath, "utf8"); } catch (_) { return { turns: [], size: 0 }; }
  const turns = [];
  for (const line of raw.split("\n")) { if (!line.trim()) continue; const t = turnFromTranscriptLine(line); if (t) turns.push(t); }
  return { turns: turns.slice(-limit), size: Buffer.byteLength(raw, "utf8") };
}

function readFileTail(p, bytes) {
  let fd;
  try {
    const st = fs.statSync(p);
    const start = Math.max(0, st.size - bytes);
    fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } catch (_) {
    return "";
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

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

function createSession({ name, agent, projectDir, mode, voice, runner, model, claudeSessionId, agentSessionId } = {}) {
  if (sessions.size >= maxSessions()) throw new Error("too many sessions");
  agent = agent || DEFAULT_AGENT;
  if (!AGENTS[agent]) throw new Error("unknown agent: " + agent);
  if (mode && !AGENTS[agent].modes[mode]) throw new Error("unknown mode: " + mode);
  const run = resolveRunner(runner);
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
    model: (model && String(model).trim()) || undefined,
    claudeSessionId: sanitizeSessionId(claudeSessionId),
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
    handoff: s.handoff || null,
  };
}

function resolveSession(id) {
  if (id) return sessions.get(id) || null;
  if (defaultSessionId) return sessions.get(defaultSessionId) || null;
  return null;
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
        id: s.id, name: s.name, agent: s.agent, projectDir: s.projectDir, mode: s.mode, voice: s.voice, runner: s.runner, model: s.model, claudeSessionId: s.claudeSessionId, agentSessionId: s.agentSessionId, started: s.started,
      })),
    };
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
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
    const projectDir = (s.runner === "local" && !isDir(s.projectDir)) ? DEFAULT_PROJECT_DIR : s.projectDir;
    sessions.set(s.id, {
      id: s.id, name: s.name, agent: s.agent, projectDir,
      mode: AGENTS[s.agent].modes[s.mode] ? s.mode : AGENTS[s.agent].defaultMode,
      voice: !!s.voice, runner: (s.runner === "cloud" || s.runner === "tmux") ? s.runner : "local",
      model: (s.model && String(s.model).trim()) || undefined,
      claudeSessionId: sanitizeSessionId(s.claudeSessionId),
      agentSessionId: (s.agentSessionId && String(s.agentSessionId).trim()) || undefined,
      started: !!s.started,
    });
  }
  if (typeof data.seq === "number") sessionSeq = Math.max(sessionSeq, data.seq);
  if (data.defaultId && sessions.has(data.defaultId)) defaultSessionId = data.defaultId;
}

module.exports = {
  sessions,
  get defaultSessionId() { return defaultSessionId; },
  set defaultSessionId(v) { defaultSessionId = v; },
  get sessionSeq() { return sessionSeq; },
  set sessionSeq(v) { sessionSeq = v; },
  sanitizeSessionId,
  extractAgentConversationId,
  isDir,
  browseDir,
  firstUserText,
  listClaudeSessions,
  turnFromTranscriptLine,
  resolveJsonlPath,
  readTranscriptTurns,
  findJsonlByContent,
  createSession,
  publicSession,
  resolveSession,
  saveSessions,
  loadSessions,
};
