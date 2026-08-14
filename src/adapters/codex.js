"use strict";

const { splitArgs } = require("../config");

const codexAdapter = {
  label: "Codex",
  bin: () => process.env.CODEX_BIN || "codex",
  supportsContinue: true,
  stream: "text",
  defaultMode: "auto",
  modes: {
    safe: { label: "Read-only", args: ["-s", "read-only"] },
    auto: { label: "Automatic (write)", args: ["-s", "workspace-write", "-c", "approval_policy=\"never\""] },
    full: { label: "Fully autonomous", args: ["--dangerously-bypass-approvals-and-sandbox"] },
  },
  command(prompt, { cont, resume, modeArgs } = {}) {
    const legacy = cont && splitArgs(process.env.CODEX_CONTINUE_ARGS);
    if (legacy && legacy.length) return { argv: ["exec", ...legacy, ...(modeArgs || [])], stdin: prompt };
    if (resume) return { argv: ["exec", "resume", ...(modeArgs || []), resume, "-"], stdin: prompt };
    if (cont) return { argv: ["exec", "resume", ...(modeArgs || []), "--last", "-"], stdin: prompt };
    return { argv: ["exec", ...(modeArgs || [])], stdin: prompt };
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
