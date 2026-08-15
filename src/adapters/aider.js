"use strict";

const { splitArgs } = require("../config");

const aiderAdapter = {
  label: "Aider",
  bin: () => process.env.AIDER_BIN || "aider",
  supportsContinue: true,
  stream: "text",
  defaultMode: "code",
  modes: {
    code: { label: "Code", args: ["--chat-mode", "code"] },
    architect: { label: "Architect (plan & code)", args: ["--chat-mode", "architect"] },
    ask: { label: "Ask (read-only)", args: ["--chat-mode", "ask"] },
    auto: { label: "Auto (auto-commits)", args: ["--auto-commits", "--chat-mode", "code"] },
  },
  command(prompt, { cont, resume, modeArgs } = {}) {
    const custom = process.env.AIDER_ARGS ? splitArgs(process.env.AIDER_ARGS) : [];
    const base = custom.length ? custom : ["--no-git", "--yes-always", "--no-auto-commits"];
    const effectiveMode = modeArgs && modeArgs.length ? modeArgs : (this.modes[this.defaultMode] ? this.modes[this.defaultMode].args : []);
    const continuity = cont || resume ? ["--restore-chat-history"] : [];
    const argv = [...base, ...effectiveMode, ...continuity, "--message", prompt];
    return { argv, stdin: null };
  },
  tmux: {
    generatingRe: /Thinking|Working|Generating/i,
    readyRe: />\s*$|aider>\s*$/,
    launchArgs(session, name) {
      return aiderAdapter.bin();
    },
    extractReply(pane, promptEcho) {
      const lines = String(pane || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").split("\n");
      const out = [];
      let capture = false;
      for (const line of lines) {
        const t = line.trim();
        if ((t === ">" || t.startsWith("aider>") || /^>\s+/.test(t)) && capture) break;
        if (capture) out.push(line);
        if ((t.startsWith(">") || t.startsWith("aider>")) && t.includes((promptEcho || "").trim().slice(0, 20))) capture = true;
      }
      return out.join("\n").trim();
    }
  }
};

module.exports = { aiderAdapter };
