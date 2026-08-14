"use strict";

const ollamaAdapter = {
  label: "Ollama (local)",
  bin: () => process.env.OLLAMA_BIN || "ollama",
  supportsContinue: true,
  stream: "text",
  defaultMode: "default",
  modes: {
    default: { label: "Local model", args: [] },
  },
  command(prompt, { modeArgs } = {}) {
    const model = process.env.OLLAMA_MODEL || "llama3.2";
    return { argv: ["run", model, ...(modeArgs || [])], stdin: prompt };
  },
};

module.exports = { ollamaAdapter };
