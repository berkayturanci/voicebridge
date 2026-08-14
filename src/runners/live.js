"use strict";

const { spawn } = require("child_process");
const { buildPrompt, looksLikeQuestion } = require("../config");
const { AGENTS, parseClaudeEvents } = require("../adapters");
const { saveSessions } = require("../services/sessions");
const { sendPush } = require("../services/push");

function isLiveEnabled() {
  return process.env.PERSISTENT_SESSIONS === "1" || process.env.PERSISTENT_SESSIONS === "true";
}

function agentTimeoutMs() {
  const v = parseInt(process.env.AGENT_TIMEOUT_MS || "1200000", 10);
  return isNaN(v) ? 1200000 : v;
}

function agentTimeoutMessage(label, ms) {
  return `${label} didn't finish within ${Math.round(ms / 60000)} min (timed out).`;
}

function liveIdleMs() {
  const v = parseInt(process.env.LIVE_IDLE_MS || "300000", 10);
  return isNaN(v) ? 300000 : v;
}

const liveProcs = new Map(); // sessionId -> { child, buf, busy, idleTimer }

function killLive(sessionId) {
  const p = liveProcs.get(sessionId);
  if (!p) return;
  liveProcs.delete(sessionId);
  if (p.idleTimer) { clearTimeout(p.idleTimer); p.idleTimer = null; }
  try { p.child.stdin.end(); } catch (_) {}
  try { p.child.kill("SIGTERM"); } catch (_) {}
}

function killAllLive() {
  for (const id of Array.from(liveProcs.keys())) killLive(id);
}

function getOrSpawnLive(session) {
  const existing = liveProcs.get(session.id);
  if (existing && !existing.child.killed) return existing;
  const modeArgs = (AGENTS.claude.modes[session.mode] || AGENTS.claude.modes[AGENTS.claude.defaultMode]).args;
  const argv = [...modeArgs, "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
  if (session.claudeSessionId) argv.push("--resume", session.claudeSessionId);
  const child = spawn(AGENTS.claude.bin(), argv, { cwd: session.projectDir, env: process.env });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const p = { child, buf: "", busy: false, idleTimer: null };
  liveProcs.set(session.id, p);
  const drop = () => { if (liveProcs.get(session.id) === p) liveProcs.delete(session.id); };
  child.on("exit", drop);
  child.on("error", drop);
  return p;
}

function streamLive(session, prompt, res, emit) {
  if (session.handoff === "pc") { session.handoff = null; saveSessions(); }
  const p = getOrSpawnLive(session);
  if (p.busy) {
    emit({ type: "error", error: "This session is busy right now (the previous turn is still running)." });
    return res.end();
  }
  p.busy = true;
  if (p.idleTimer) { clearTimeout(p.idleTimer); p.idleTimer = null; }

  const agent = AGENTS[session.agent] || { label: "Live agent" };
  let replyText = "";
  let finished = false;
  let stderr = "";
  let timeoutTimer = null;
  let released = false;

  const release = (rearmIdle = true) => {
    if (released) return;
    released = true;
    if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
    p.child.stdout.removeListener("data", onData);
    p.child.stderr.removeListener("data", onErr);
    p.child.removeListener("exit", onExit);
    p.busy = false;
    if (rearmIdle && liveIdleMs() > 0) p.idleTimer = setTimeout(() => killLive(session.id), liveIdleMs());
  };

  const failAndRespawnNextTurn = (errMsg) => {
    endHttp(errMsg);
    if (liveProcs.get(session.id) === p) liveProcs.delete(session.id);
    if (p.idleTimer) { clearTimeout(p.idleTimer); p.idleTimer = null; }
    try { p.child.kill("SIGTERM"); } catch (_) {}
    release(false);
  };

  const endHttp = (errMsg) => {
    if (finished) return;
    finished = true;
    if (errMsg) {
      emit({ type: "error", error: errMsg });
    } else {
      session.started = true;
      emit({ type: "done" });
      if (looksLikeQuestion(replyText)) {
        sendPush({ title: "voicebridge — " + session.name + " asked a question", body: replyText.trim().slice(-160), sessionId: session.id });
      }
    }
    try { res.end(); } catch (_) {}
  };

  const onLine = (line) => {
    let obj; try { obj = JSON.parse(line); } catch (_) { return; }
    if (obj.session_id && session.claudeSessionId !== obj.session_id) { session.claudeSessionId = obj.session_id; saveSessions(); }
    if (!finished) {
      for (const ev of parseClaudeEvents(line)) { if (ev.type === "delta") replyText += ev.text; emit(ev); }
    }
    if (obj.type === "result") {
      endHttp(obj.is_error ? (obj.result || "Live turn failed.") : null);
      release();
    }
  };

  const onData = (d) => {
    p.buf += d;
    let i;
    while ((i = p.buf.indexOf("\n")) >= 0) {
      const line = p.buf.slice(0, i).trim();
      p.buf = p.buf.slice(i + 1);
      if (line) onLine(line);
    }
  };

  const onErr = (d) => { stderr += d; };
  const onExit = (code) => {
    if (p.buf && p.buf.length) {
      let i;
      while ((i = p.buf.indexOf("\n")) >= 0) {
        const line = p.buf.slice(0, i).trim();
        p.buf = p.buf.slice(i + 1);
        if (line) onLine(line);
      }
    }
    endHttp(stderr.trim() || ("Live session exited (code " + code + ")."));
    release();
  };

  p.child.stdout.on("data", onData);
  p.child.stderr.on("data", onErr);
  p.child.on("exit", onExit);

  const TIMEOUT_MS = agentTimeoutMs();
  if (TIMEOUT_MS > 0) {
    timeoutTimer = setTimeout(() => {
      failAndRespawnNextTurn(agentTimeoutMessage(agent.label, TIMEOUT_MS));
    }, TIMEOUT_MS);
  }

  res.on("close", () => { finished = true; });

  const userLine = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: buildPrompt(session.voice, prompt) }] } }) + "\n";
  try { p.child.stdin.write(userLine); } catch (e) { failAndRespawnNextTurn(e.message); }
}

module.exports = {
  isLiveEnabled,
  liveProcs,
  killLive,
  killAllLive,
  getOrSpawnLive,
  streamLive,
};
