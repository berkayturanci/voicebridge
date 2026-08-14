"use strict";

const { streamCloud, proxyCloudBrowse } = require("./cloud");
const { streamTmux } = require("./tmux");
const { streamOllama } = require("./ollama");
const { streamLocal } = require("./local");

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'",
};

function streamAsk(session, prompt, res) {
  res.writeHead(200, Object.assign({
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  }, SECURITY_HEADERS));
  const emit = (obj) => { try { res.write(JSON.stringify(obj) + "\n"); } catch (_) {} };
  if (session.runner === "cloud") return streamCloud(session, prompt, res, emit);
  if (session.runner === "tmux") return streamTmux(session, prompt, res, emit);
  if (session.agent === "ollama") return streamOllama(session, prompt, res, emit);
  return streamLocal(session, prompt, res, emit);
}

module.exports = {
  streamAsk,
  streamLocal,
  streamCloud,
  streamTmux,
  streamOllama,
  proxyCloudBrowse,
  SECURITY_HEADERS,
};
