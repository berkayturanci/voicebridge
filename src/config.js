"use strict";

const path = require("path");
const fs = require("fs");

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
const STT_STREAM_URL = process.env.STT_STREAM_URL || "";
const STT_STREAM_CMD = process.env.STT_STREAM_CMD || "";
const PUBLIC_DIR = path.join(__dirname, "..", "public");
let PKG_VERSION = "0.0.0";
try { PKG_VERSION = require("../package.json").version || PKG_VERSION; } catch (_) {}

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

function splitArgs(str) {
  return (str || "").trim().split(/\s+/).filter(Boolean);
}

function maxInflight() { return parseInt(process.env.MAX_INFLIGHT || "8", 10); }
function maxSessions() { return parseInt(process.env.MAX_SESSIONS || "200", 10); }

function sessionsFile() {
  const v = process.env.SESSIONS_FILE;
  if (v === "off" || v === "0" || v === "false") return "";
  return v || "";
}

function cloudRunnerUrl() { return process.env.CLOUD_RUNNER_URL || ""; }
function ollamaUrl() { return process.env.OLLAMA_URL || "http://127.0.0.1:11434"; }

const VOICE_PREAMBLE =
  "Answer concisely, optimized for being read aloud by text-to-speech: avoid long " +
  "code blocks unless explicitly asked, and finish with a one-sentence spoken summary.";

function isSlashCommand(text) {
  return /^\s*\/[a-zA-Z]/.test(text);
}

function buildPrompt(voice, text) {
  if (isSlashCommand(text)) return text.trim();
  return voice ? VOICE_PREAMBLE + "\n\n" + text : text;
}

function looksLikeQuestion(text) {
  return /\?["')\]]*\s*$/.test((text || "").trim());
}

function phoneUrl({ publicUrl, host, port, token } = {}) {
  const base = publicUrl && publicUrl.trim()
    ? publicUrl.trim().replace(/\/+$/, "")
    : `http://${host || "127.0.0.1"}:${port || "8787"}`;
  return base + (token ? `?token=${encodeURIComponent(token)}` : "");
}

module.exports = {
  PORT,
  HOST,
  DEFAULT_PROJECT_DIR,
  DEFAULT_AGENT,
  ACCESS_TOKEN,
  STT_MODE,
  STT_CMD,
  STT_STREAM_URL,
  STT_STREAM_CMD,
  PUBLIC_DIR,
  PKG_VERSION,
  FAVORITES,
  VOICE_PREAMBLE,
  parseDotEnv,
  loadDotEnv,
  parseFavorites,
  splitArgs,
  maxInflight,
  maxSessions,
  sessionsFile,
  cloudRunnerUrl,
  ollamaUrl,
  isSlashCommand,
  buildPrompt,
  looksLikeQuestion,
  phoneUrl,
};
