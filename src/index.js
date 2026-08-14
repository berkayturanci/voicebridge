"use strict";

const http = require("http");
const path = require("path");
const os = require("os");
const config = require("./config");
const { AGENTS, resolveMode, resolveRunner, binExists, agentAvailable, parseClaudeLine, parseClaudeEvents } = require("./adapters");
const {
  sessions,
  createSession,
  resolveSession,
  publicSession,
  saveSessions,
  loadSessions,
  browseDir,
} = require("./services/sessions");
const { listSlashCommands, listNpmScripts } = require("./services/commands");
const { sendJson, wsAcceptKey, wsEncode } = require("./routes/http-helpers");
const { handleRequest } = require("./routes/api");
const { handleSttStreamUpgrade } = require("./services/stt");
const { killAllLive, killLive, liveProcs } = require("./runners/live");
const tmuxRunner = require("./runners/tmux");
const sessionsService = require("./services/sessions");

function buildServer() {
  const server = http.createServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch (e) {
      try { sendJson(res, 500, { error: "Internal error" }); } catch (_) {}
    }
  });
  server.on("upgrade", (req, socket, head) => {
    try {
      if (!handleSttStreamUpgrade(req, socket, head)) {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
    } catch (_) {
      try { socket.destroy(); } catch (_) {}
    }
  });
  return server;
}

function printPhoneQr(url) {
  console.log(`\nOpen on your phone:  ${url}`);
  try {
    require("qrcode-terminal").generate(url, { small: true }, (qr) => console.log(qr));
  } catch (_) {
    console.log("(run `npm install` to show a scannable QR code here)\n");
  }
}

function closeServerForShutdown(server) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      server.close(done);
      if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    } catch (_) {
      done();
    }
  });
}

function createShutdownHandler(server, opts = {}) {
  const exit = opts.exit || process.exit.bind(process);
  const logger = opts.logger || console;
  const graceMs = Number(opts.graceMs ?? 5000) || 5000;
  let shuttingDown = false;
  return function shutdown(signal = "shutdown") {
    if (shuttingDown) return;
    shuttingDown = true;
    try { logger.log(`voicebridge shutting down (${signal})...`); } catch (_) {}
    killAllLive();
    const forceTimer = setTimeout(() => {
      try { logger.error(`voicebridge shutdown timed out after ${graceMs}ms; exiting.`); } catch (_) {}
      exit(1);
    }, graceMs);
    if (typeof forceTimer.unref === "function") forceTimer.unref();
    closeServerForShutdown(server).then(() => {
      clearTimeout(forceTimer);
      exit(0);
    });
  };
}

function start() {
  if (process.env.SESSIONS_FILE == null) {
    process.env.SESSIONS_FILE = path.join(os.homedir(), ".voicebridge", "sessions.json");
  }
  loadSessions();
  const sessionsService = require("./services/sessions");
  if (!sessionsService.defaultSessionId || !sessions.has(sessionsService.defaultSessionId)) {
    const boot = createSession({ name: "default", agent: config.DEFAULT_AGENT, projectDir: config.DEFAULT_PROJECT_DIR });
    sessionsService.defaultSessionId = boot.id;
    saveSessions();
  }
  const boot = sessions.get(sessionsService.defaultSessionId);
  const server = buildServer();
  const shutdown = createShutdownHandler(server);
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  server.listen(config.PORT, config.HOST, () => {
    console.log(`voicebridge listening on http://${config.HOST}:${config.PORT}`);
    console.log(`default session: ${boot.name} · ${AGENTS[boot.agent].label} · ${boot.projectDir}`);
    console.log(`sessions: ${sessions.size}${config.sessionsFile() ? "  (persisted)" : ""}`);
    console.log(`agents: ${Object.keys(AGENTS).join(", ")}`);
    console.log(`STT mode: ${config.STT_MODE}${config.ACCESS_TOKEN ? "  (access token required)" : ""}`);
    const loopback = config.HOST === "127.0.0.1" || config.HOST === "::1" || config.HOST === "localhost";
    if (!loopback && !config.ACCESS_TOKEN) {
      console.warn("\n⚠️  WARNING: bound to a non-loopback address WITHOUT ACCESS_TOKEN.");
      console.warn("    Anyone who can reach this host can drive an agent on your machine.");
      console.warn("    Set ACCESS_TOKEN, or bind to 127.0.0.1 and expose via `tailscale serve`.\n");
    }
    console.log(`Expose it to your phone with:  tailscale serve --bg ${config.PORT}`);
    printPhoneQr(config.phoneUrl({ publicUrl: process.env.PUBLIC_URL, host: config.HOST, port: config.PORT, token: config.ACCESS_TOKEN }));
  });
  return server;
}

module.exports = {
  AGENTS,
  parseDotEnv: config.parseDotEnv,
  parseClaudeLine,
  parseClaudeEvents,
  resolveMode,
  resolveRunner,
  binExists,
  agentAvailable,
  browseDir,
  listSlashCommands,
  listNpmScripts,
  buildPrompt: config.buildPrompt,
  looksLikeQuestion: config.looksLikeQuestion,
  parseFavorites: config.parseFavorites,
  phoneUrl: config.phoneUrl,
  sessions,
  createSession,
  resolveSession,
  publicSession,
  saveSessions,
  loadSessions,
  buildServer,
  handleRequest,
  start,
  _internals: {
    createShutdownHandler,
    extractAgentConversationId: sessionsService.extractAgentConversationId,
    extractTuiReply: tmuxRunner.extractTuiReply,
    killAllLive,
    killLive,
    liveProcs,
    stripAnsi: tmuxRunner.stripAnsi,
    tmuxCaptureErrorMessage: tmuxRunner.tmuxCaptureErrorMessage,
    tmuxStillGenerating: tmuxRunner.tmuxStillGenerating,
    TMUX_GENERATING_RE: tmuxRunner.TMUX_GENERATING_RE,
    wsAcceptKey,
    wsEncode,
  },
  get defaultSessionId() { return sessionsService.defaultSessionId; },
  set defaultSessionId(v) { sessionsService.defaultSessionId = v; },
};
