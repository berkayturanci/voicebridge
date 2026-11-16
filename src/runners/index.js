"use strict";

const { AGENTS } = require("../adapters");
const { streamCloud, proxyCloudBrowse } = require("./cloud");
const { streamTmux } = require("./tmux");
const { streamOllama } = require("./ollama");
const { streamLocal } = require("./local");
const { isLiveEnabled, streamLive } = require("./live");

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'",
};

const hub = require("../services/hub");
const { createSpeechStream, toSpeakable } = require("../services/speech-filter");
const { voiceModeActive } = require("../services/voice-style");
const narrator = require("../services/narrator");

// Wrap a raw emitter so every streamed reply also yields `speech` events: the
// same text with code fences, markdown, links and long paths removed, cut at
// sentence boundaries. Clients speak `speech` and render `delta` — the chat
// always shows the full text. The final `speech` (the tail) precedes `done`.
function withSpeech(rawEmit) {
  const speech = createSpeechStream();
  const emitSpeech = (text) => { if (text) rawEmit({ type: "speech", text }); };
  const emit = (obj) => {
    if (obj && obj.type === "done") emitSpeech(speech.flush());
    rawEmit(obj);
    if (obj && obj.type === "delta" && obj.text) emitSpeech(speech.push(obj.text));
  };
  // For runners that forward upstream NDJSON verbatim (cloud): feed deltas
  // seen on the wire and flush at the end without re-emitting the delta.
  emit.tapDelta = (text) => emitSpeech(speech.push(text));
  emit.flushSpeech = () => emitSpeech(speech.flush());
  return emit;
}

function streamHeaders(session, extra) {
  return Object.assign({
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
    // Tells the client this stream carries `speech`/`narration` events to speak instead of raw deltas.
    "X-VB-Speech": "1",
    "X-VB-Voice-Mode": voiceModeActive(session) ? "1" : "0",
  }, extra || {}, SECURITY_HEADERS);
}

function rawEmitter(session, res) {
  return (obj) => {
    try { res.write(JSON.stringify(obj) + "\n"); } catch (_) {}
    try { hub.broadcast(session.id, Object.assign({ sessionId: session.id }, obj)); } catch (_) {}
  };
}

// "read the full answer": speak the session's last full reply without
// involving the agent. The chat already shows it, so only speech is sent.
function streamReadFull(session, prompt, res) {
  res.writeHead(200, streamHeaders(session, { "X-VB-Narrator": "1" }));
  const emit = rawEmitter(session, res);
  try { hub.broadcast(session.id, { type: "turn_start", sessionId: session.id, prompt, local: true }); } catch (_) {}
  const last = session.lastReply && session.lastReply.text;
  if (!last) {
    const msg = narrator.template("noFull", {});
    emit({ type: "delta", text: msg });
    emit({ type: "speech", text: msg });
  } else {
    emit({ type: "delta", text: "🔊 " + narrator.template("readingFull", {}) });
    const spoken = toSpeakable(last);
    // Sentence-sized chunks so clients can stop/barge-in between them.
    for (const part of spoken.match(/[^.!?…]+[.!?…]+|\S[^.!?…]*$/g) || []) {
      const t = part.trim();
      if (t) emit({ type: "speech", text: t });
    }
  }
  emit({ type: "done", local: true });
  res.end();
}

function streamAsk(session, prompt, res) {
  if (narrator.isReadFullCommand(prompt)) return streamReadFull(session, prompt, res);
  const pipeline = narrator.createVoicePipeline({ session, prompt, rawEmit: rawEmitter(session, res) });
  res.writeHead(200, streamHeaders(session, { "X-VB-Narrator": pipeline.narrate ? "1" : "0" }));
  pipeline.deferEnd(res);
  const emit = pipeline.emit;
  try { hub.broadcast(session.id, { type: "turn_start", sessionId: session.id, prompt }); } catch (_) {}
  if (session.runner === "cloud") return streamCloud(session, prompt, res, emit);
  if (session.runner === "tmux") return streamTmux(session, prompt, res, emit);
  if (session.agent === "ollama") return streamOllama(session, prompt, res, emit);
  if (isLiveEnabled() && AGENTS[session.agent] && AGENTS[session.agent].live) {
    return streamLive(session, prompt, res, emit);
  }
  return streamLocal(session, prompt, res, emit);
}

module.exports = {
  streamAsk,
  withSpeech,
  streamLocal,
  streamCloud,
  streamTmux,
  streamOllama,
  proxyCloudBrowse,
  SECURITY_HEADERS,
};
