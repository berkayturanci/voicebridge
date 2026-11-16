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
const { createSpeechStream } = require("../services/speech-filter");
const { voiceModeActive } = require("../services/voice-style");

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

function streamAsk(session, prompt, res) {
  res.writeHead(200, Object.assign({
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
    // Tells the client this stream carries `speech` events to speak instead of raw deltas.
    "X-VB-Speech": "1",
    "X-VB-Voice-Mode": voiceModeActive(session) ? "1" : "0",
  }, SECURITY_HEADERS));
  const emit = withSpeech((obj) => {
    try { res.write(JSON.stringify(obj) + "\n"); } catch (_) {}
    try { hub.broadcast(session.id, Object.assign({ sessionId: session.id }, obj)); } catch (_) {}
  });
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
