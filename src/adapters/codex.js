"use strict";

const { splitArgs } = require("../config");

const codexAdapter = {
  label: "Codex",
  bin: () => process.env.CODEX_BIN || "codex",
  get supportsContinue() { return splitArgs(process.env.CODEX_CONTINUE_ARGS).length > 0; },
  stream: "text",
  defaultMode: "auto",
  modes: {
    safe: { label: "Read-only", args: ["-s", "read-only"] },
    auto: { label: "Automatic (write)", args: ["--full-auto"] },
    full: { label: "Fully autonomous", args: ["--dangerously-bypass-approvals-and-sandbox"] },
  },
  command(prompt, { cont, modeArgs } = {}) {
    const resume = cont ? splitArgs(process.env.CODEX_CONTINUE_ARGS) : [];
    return { argv: ["exec", ...resume, ...(modeArgs || [])], stdin: prompt };
  },
  tmux: {
    generatingRe: /Thinking|Working|Generating/i,
    readyRe: /Codex v|>$/,
    launchArgs(session, name) {
      return "codex interactive";
    },
    extractReply(pane, promptEcho) {
      const lines = pane.split("\n");
      const out = [];
      let capture = false;
      for (const line of lines) {
        const t = line.trim();
        if (t.startsWith(">") && capture) break;
        if (capture) out.push(line);
        if (t.startsWith(">") && t.includes((promptEcho || "").trim().slice(0, 20))) capture = true;
      }
      return out.join("\n").trim();
    }
  }
};

module.exports = { codexAdapter };
