"use strict";

const { buildPrompt, looksLikeQuestion, ollamaUrl } = require("../config");
const { sendPush } = require("../services/push");

function streamOllama(session, prompt, res, emit) {
  let url;
  try { url = new URL("/api/chat", ollamaUrl()); } catch (_) { emit({ type: "error", error: "Invalid OLLAMA_URL" }); return res.end(); }
  const lib = url.protocol === "https:" ? require("https") : require("http");
  const history = session.history || [];
  const messages = history.concat([{ role: "user", content: buildPrompt(session.voice, prompt) }]);
  const payload = JSON.stringify({
    model: session.model || process.env.OLLAMA_MODEL || "llama3.2",
    messages, stream: true,
  });
  let buf = "", reply = "", errored = false;
  const upReq = lib.request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, (r) => {
    r.setEncoding("utf8");
    r.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let obj; try { obj = JSON.parse(line); } catch (_) { continue; }
        if (obj.error) { errored = true; emit({ type: "error", error: String(obj.error) }); continue; }
        const c = obj.message && obj.message.content;
        if (c) { reply += c; emit({ type: "delta", text: c }); }
      }
    });
    r.on("end", () => {
      if (!errored) {
        session.history = messages.concat([{ role: "assistant", content: reply }]);
        session.started = true;
        emit({ type: "done" });
        if (looksLikeQuestion(reply)) sendPush({ title: "voicebridge — " + session.name + " asked a question", body: reply.trim().slice(-160), sessionId: session.id });
      }
      res.end();
    });
  });
  upReq.on("error", (e) => { emit({ type: "error", error: "ollama: " + e.message }); res.end(); });
  upReq.write(payload); upReq.end();
  res.on("close", () => { try { upReq.destroy(); } catch (_) {} });
}

module.exports = { streamOllama };
