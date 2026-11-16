"use strict";

// Voice style: how a session's agent is told to answer when the user is
// listening instead of reading (phone on the treadmill, earbuds in).
//
// Per session `voiceMode`:
//   true / false  explicit on/off
//   undefined     follows the session's `voice` flag, gated by VOICE_MODE_DEFAULT
//                 (on by default — voice sessions get the spoken style).
//
// The instruction text is configurable:
//   VOICE_STYLE_PROMPT       inline text (".env" works; use \n for newlines)
//   VOICE_STYLE_PROMPT_FILE  path to a text file (wins over the inline value)
//
// Delivery depends on what the agent supports (adapter.systemPrompt):
//   "flag"     Claude Code: --append-system-prompt <text>
//   "message"  Ollama: a system message in /api/chat
//   otherwise  prepended to the user prompt (Codex, Gemini, Aider, Antigravity,
//              tmux and cloud runners), as the old voice preamble was.

const fs = require("fs");

const DEFAULT_VOICE_STYLE_PROMPT =
  "You are talking with the user over the phone: they are listening, not reading. " +
  "Answer like a spoken conversation, in 1 to 4 short sentences. " +
  "Do not read out code, file paths, links, or markdown. " +
  "If the answer needs long detail, write it to a file and only say which file you wrote it to. " +
  "Answer in the user's language.";

function truthy(v, dflt) {
  if (v == null || v === "") return dflt;
  return !/^(0|false|off|no)$/i.test(String(v).trim());
}

function voiceModeDefault() {
  return truthy(process.env.VOICE_MODE_DEFAULT, true);
}

let fileCache = { path: "", mtimeMs: 0, text: "" };

function readPromptFile(p) {
  try {
    const st = fs.statSync(p);
    if (fileCache.path === p && fileCache.mtimeMs === st.mtimeMs) return fileCache.text;
    const text = fs.readFileSync(p, "utf8").trim();
    fileCache = { path: p, mtimeMs: st.mtimeMs, text };
    return text;
  } catch (_) {
    return "";
  }
}

// Read on every call so edits to .env-provided values or the prompt file are
// picked up without restarting (the file is cached by mtime).
function voiceStylePrompt() {
  const file = process.env.VOICE_STYLE_PROMPT_FILE;
  if (file) {
    const t = readPromptFile(file);
    if (t) return t;
  }
  const inline = process.env.VOICE_STYLE_PROMPT;
  if (inline && inline.trim()) return inline.replace(/\\n/g, "\n").trim();
  return DEFAULT_VOICE_STYLE_PROMPT;
}

function voiceModeActive(session) {
  if (!session) return false;
  if (session.voiceMode === true || session.voiceMode === false) return session.voiceMode;
  return !!session.voice && voiceModeDefault();
}

function normalizeVoiceMode(v) {
  if (v === true || v === false) return v;
  if (v === null || v === "auto") return undefined;
  return undefined;
}

function isSlashCommand(text) {
  return /^\s*\/[a-zA-Z]/.test(text);
}

// Decide how this turn's text and system prompt look for `agent`.
// Returns { prompt, systemPrompt } — systemPrompt is "" when the agent gets the
// style inline (or voice mode is off).
function applyVoiceStyle(session, agent, text) {
  const raw = String(text == null ? "" : text);
  if (isSlashCommand(raw)) {
    const sys = voiceModeActive(session) && agent && agent.systemPrompt ? voiceStylePrompt() : "";
    return { prompt: raw.trim(), systemPrompt: sys };
  }
  if (!voiceModeActive(session)) return { prompt: raw, systemPrompt: "" };
  const style = voiceStylePrompt();
  if (agent && (agent.systemPrompt === "flag" || agent.systemPrompt === "message")) {
    return { prompt: raw, systemPrompt: style };
  }
  return { prompt: style + "\n\n" + raw, systemPrompt: "" };
}

module.exports = {
  DEFAULT_VOICE_STYLE_PROMPT,
  voiceModeDefault,
  voiceStylePrompt,
  voiceModeActive,
  normalizeVoiceMode,
  applyVoiceStyle,
};
