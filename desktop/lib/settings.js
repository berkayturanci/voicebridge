"use strict";

const fs = require("fs");
const path = require("path");

const defaults = {
  port: 8787,
  host: "127.0.0.1",
  token: "",
  projectDir: "",
  agent: "claude",
  publicUrl: "",
  setupComplete: false,
};

const AGENT_OPTIONS = [
  { id: "claude", label: "Claude Code", bin: "claude" },
  { id: "codex", label: "Codex", bin: "codex" },
  { id: "antigravity", label: "Antigravity", bin: "agy" },
  { id: "ollama", label: "Ollama/local", bin: "ollama" },
];

function normalizeSettings(raw, opts = {}) {
  const s = { ...defaults, ...(raw && typeof raw === "object" ? raw : {}) };
  s.port = Number.parseInt(s.port, 10) || defaults.port;
  s.host = String(s.host || defaults.host);
  s.token = String(s.token || opts.secureToken || opts.generateToken?.() || "");
  s.projectDir = String(s.projectDir || "");
  s.agent = AGENT_OPTIONS.some((a) => a.id === s.agent) ? s.agent : defaults.agent;
  s.publicUrl = String(s.publicUrl || "");
  s.setupComplete = Boolean(s.setupComplete);
  return s;
}

function loadSettings(file, opts = {}) {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(file, "utf8")), opts);
  } catch (_) {
    return normalizeSettings(null, opts);
  }
}

function saveSettings(file, settings, opts = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stored = { ...normalizeSettings(settings) };
  if (opts.saveSecureToken?.(stored.token)) delete stored.token;
  fs.writeFileSync(file, JSON.stringify(stored, null, 2));
}

function webUrl(settings) {
  const host = settings.host === "0.0.0.0" ? "127.0.0.1" : settings.host || defaults.host;
  const port = settings.port || defaults.port;
  return `http://${host}:${port}/${settings.token ? "?token=" + encodeURIComponent(settings.token) : ""}`;
}

module.exports = { AGENT_OPTIONS, defaults, loadSettings, normalizeSettings, saveSettings, webUrl };
