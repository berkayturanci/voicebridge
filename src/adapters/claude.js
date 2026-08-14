"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

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

function toolLabel(b) {
  const inp = b.input || {};
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

function encodeProjectPath(p) { return String(p || "").replace(/[^a-zA-Z0-9]/g, "-"); }

const claudeAdapter = {
  label: "Claude Code",
  bin: () => process.env.CLAUDE_BIN || "claude",
  supportsContinue: true,
  stream: "ndjson",
  live: true,
  defaultMode: "ask",
  modes: {
    ask: { label: "Ask for approval", args: [] },
    autoEdit: { label: "Approve edits", args: ["--permission-mode", "acceptEdits"] },
    full: { label: "Fully autonomous", args: ["--dangerously-skip-permissions"] },
  },
  command(prompt, { cont, resume, modeArgs } = {}) {
    const argv = [...(modeArgs || [])];
    if (resume) argv.push("--resume", resume);
    else if (cont) argv.push("--continue");
    argv.push("--output-format", "stream-json", "--verbose", "-p", prompt);
    return { argv, stdin: null };
  },
  parseLine: parseClaudeLine,
  parseEvents: parseClaudeEvents,
  tmux: {
    generatingRe: /esc to interrupt|Cogitating|Thinking|Working…|Pondering|Forging/i,
    readyRe: /Claude Code v|❯/,
    launchArgs(session, name) {
      if (!session.claudeSessionId || !/^[a-zA-Z0-9_-]{1,64}$/.test(session.claudeSessionId)) {
        session.claudeSessionId = crypto.randomUUID();
      }
      const dir = path.join(os.homedir(), ".claude", "projects", encodeProjectPath(session.projectDir));
      session.tmuxJsonl = path.join(dir, session.claudeSessionId + ".jsonl");
      return fs.existsSync(session.tmuxJsonl)
        ? "claude --resume " + session.claudeSessionId
        : "claude --session-id " + session.claudeSessionId;
    },
    extractReply(pane, promptEcho) {
      const lines = pane.split("\n");
      const key = (promptEcho || "").trim().slice(0, 24);
      let start = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        const t = lines[i].trim();
        if (t.startsWith("❯") && key && t.includes(key)) { start = i; break; }
      }
      if (start < 0) for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].trim().startsWith("⏺")) { start = i - 1; break; } }
      const out = [];
      for (let i = start + 1; i < lines.length; i++) {
        const t = lines[i].trim();
        if (!t) { out.push(""); continue; }
        if (/^[╭╰│]/.test(t)) continue;
        if (/^─{5,}$/.test(t)) break;
        if (t.startsWith("❯")) break;
        if (/^✻/.test(t)) continue;
        if (/^⎿/.test(t)) continue;
        out.push(lines[i].replace(/^\s*⏺\s?/, "").replace(/^\s{0,3}/, ""));
      }
      return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    }
  }
};

module.exports = {
  claudeAdapter,
  parseClaudeLine,
  parseClaudeEvents,
  toolLabel,
  encodeProjectPath,
};
