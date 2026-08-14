"use strict";

const fs = require("fs");
const path = require("path");
const { claudeAdapter, parseClaudeLine, parseClaudeEvents } = require("./claude");
const { codexAdapter } = require("./codex");
const { antigravityAdapter } = require("./antigravity");
const { ollamaAdapter } = require("./ollama");

const AGENTS = {
  claude: claudeAdapter,
  codex: codexAdapter,
  antigravity: antigravityAdapter,
  ollama: ollamaAdapter,
};

function resolveMode(agentId, mode) {
  const agent = AGENTS[agentId];
  if (!agent) return mode;
  if (mode && agent.modes[mode]) return mode;
  return agent.defaultMode;
}

function resolveRunner(runner) {
  runner = runner || "local";
  if (runner !== "local" && runner !== "cloud" && runner !== "tmux") throw new Error("unknown runner: " + runner);
  if (runner === "cloud" && !(process.env.CLOUD_RUNNER_URL || "")) throw new Error("cloud runner not configured");
  return runner;
}

function binExists(bin) {
  if (!bin) return false;
  if (bin.includes("/")) { try { fs.accessSync(bin, fs.constants.X_OK); return true; } catch (_) { return false; } }
  for (const d of (process.env.PATH || "").split(path.delimiter)) {
    if (!d) continue;
    try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return true; } catch (_) {}
  }
  return false;
}

function agentAvailable(id) {
  return id === "ollama" ? true : (AGENTS[id] ? binExists(AGENTS[id].bin()) : false);
}

module.exports = {
  AGENTS,
  resolveMode,
  resolveRunner,
  binExists,
  agentAvailable,
  parseClaudeLine,
  parseClaudeEvents,
};
