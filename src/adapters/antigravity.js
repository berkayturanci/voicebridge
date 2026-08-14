"use strict";

const { splitArgs } = require("../config");

const antigravityAdapter = {
  label: "Antigravity",
  bin: () => process.env.AGY_BIN || "agy",
  supportsContinue: true,
  stream: "text",
  defaultMode: "safe",
  modes: {
    safe: { label: "Sandbox", args: ["--sandbox"] },
    full: { label: "Fully autonomous", args: ["--dangerously-skip-permissions"] },
  },
  command(prompt, { cont, resume, modeArgs } = {}) {
    const base = process.env.AGY_ARGS ? splitArgs(process.env.AGY_ARGS) : ["--print"];
    const legacy = cont ? splitArgs(process.env.AGY_CONTINUE_ARGS) : [];
    const continuity = legacy.length ? legacy : resume ? ["--conversation", resume] : cont ? ["--continue"] : [];
    const argv = [...base, ...continuity, ...(modeArgs || [])];
    if (process.env.AGY_PROMPT_ARG) { argv.push(prompt); return { argv, stdin: null }; }
    return { argv, stdin: prompt };
  },
  tmux: {
    generatingRe: /Thinking|Working/i,
    readyRe: /agy|>/,
    launchArgs(session, name) {
      return "agy";
    },
    extractReply(pane, promptEcho) {
      const lines = pane.split("\n");
      const out = [];
      let capture = false;
      for (const line of lines) {
        const t = line.trim();
        if (t.startsWith("agy>") && capture) break;
        if (capture) out.push(line);
        if (t.startsWith("agy>") && t.includes((promptEcho || "").trim().slice(0, 20))) capture = true;
      }
      return out.join("\n").trim();
    }
  }
};

module.exports = { antigravityAdapter };
