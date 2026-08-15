"use strict";

const { splitArgs } = require("../config");

const geminiAdapter = {
  label: "Gemini",
  bin: () => process.env.GEMINI_BIN || "gemini",
  supportsContinue: true,
  stream: "text",
  defaultMode: "default",
  modes: {
    default: { label: "Default", args: [] },
    yolo: { label: "Auto-approve (yolo)", args: ["--yolo"] },
    sandbox: { label: "Sandbox mode", args: ["--sandbox"] },
  },
  command(prompt, { cont, resume, modeArgs } = {}) {
    const base = process.env.GEMINI_ARGS ? splitArgs(process.env.GEMINI_ARGS) : ["--print"];
    const legacy = cont ? splitArgs(process.env.GEMINI_CONTINUE_ARGS) : [];
    const continuity = legacy.length ? legacy : resume ? ["--conversation", resume] : cont ? ["--continue"] : [];
    const argv = [...base, ...continuity, ...(modeArgs || [])];
    if (process.env.GEMINI_PROMPT_ARG) { argv.push(prompt); return { argv, stdin: null }; }
    return { argv, stdin: prompt };
  },
  tmux: {
    generatingRe: /Thinking|Working|Generating/i,
    readyRe: />\s*$|gemini>\s*$/,
    launchArgs(session, name) {
      return geminiAdapter.bin();
    },
    extractReply(pane, promptEcho) {
      const lines = String(pane || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").split("\n");
      const out = [];
      let capture = false;
      for (const line of lines) {
        const t = line.trim();
        if ((t === ">" || t.startsWith("gemini>") || /^>\s+/.test(t)) && capture) break;
        if (capture) out.push(line);
        if ((t.startsWith(">") || t.startsWith("gemini>")) && t.includes((promptEcho || "").trim().slice(0, 20))) capture = true;
      }
      return out.join("\n").trim();
    }
  }
};

module.exports = { geminiAdapter };
