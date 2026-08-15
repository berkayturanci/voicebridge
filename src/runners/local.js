"use strict";

const fs = require("fs");
const { spawn } = require("child_process");
const { buildPrompt, looksLikeQuestion } = require("../config");
const { AGENTS } = require("../adapters");
const { sendPush } = require("../services/push");
const { LIVE_ENABLED, streamLive } = require("./live");

function streamLocal(session, prompt, res, emit) {
  if (LIVE_ENABLED && AGENTS[session.agent] && AGENTS[session.agent].live) return streamLive(session, prompt, res, emit);
  const agent = AGENTS[session.agent];
  const cont = session.started && agent.supportsContinue;
  const resume = (!session.started && (session.agentSessionId || session.claudeSessionId)) ? (session.agentSessionId || session.claudeSessionId) : null;
  const modeArgs = (agent.modes[session.mode] || agent.modes[agent.defaultMode]).args;
  const { argv, stdin } = agent.command(buildPrompt(session.voice, prompt), { cont, resume, modeArgs });

  let child;
  try {
    const cwd = (session.projectDir && fs.existsSync(session.projectDir)) ? session.projectDir : process.cwd();
    child = spawn(agent.bin(), argv, { cwd, env: process.env });
  } catch (e) {
    emit({ type: "error", error: e.message });
    return res.end();
  }

  if (stdin != null) {
    try { child.stdin.write(stdin); child.stdin.end(); } catch (_) {}
  } else {
    try { if (child.stdin) child.stdin.end(); } catch (_) {}
  }

  let timedOut = false;
  const TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS ?? 20 * 60 * 1000) || 0;
  const timer = TIMEOUT_MS > 0
    ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, TIMEOUT_MS)
    : null;
  let buf = "";
  let stderr = "";
  let gotText = false;
  let replyText = "";

  const onText = (text) => { if (text) { gotText = true; replyText += text; emit({ type: "delta", text }); } };
  const onLine = (line) => {
    if (agent.parseEvents) {
      for (const ev of agent.parseEvents(line)) { if (ev.type === "delta") { gotText = true; replyText += ev.text; } emit(ev); }
    } else {
      onText(agent.parseLine(line));
    }
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    const s = d.toString();
    if (agent.stream === "ndjson") {
      buf += s;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) onLine(line);
      }
    } else {
      onText(s);
    }
  });
  child.stderr.on("data", (d) => (stderr += d.toString()));

  child.on("error", (e) => {
    clearTimeout(timer);
    emit({
      type: "error",
      error: e.code === "ENOENT"
        ? `Could not find '${agent.bin()}'. Install ${agent.label} and authenticate it.`
        : e.message,
    });
    res.end();
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (agent.stream === "ndjson" && buf.trim()) onLine(buf);
    if (timedOut && !gotText) {
      emit({ type: "error", error: `${agent.label} didn't finish within ${Math.round(TIMEOUT_MS / 60000)} min (timed out, stopped). Side effects (file changes, issues, etc.) may have occurred. For longer tasks, raise AGENT_TIMEOUT_MS on the server (0 = unlimited).` });
    } else if (code !== 0 && !gotText) {
      emit({ type: "error", error: stderr.trim() || `${agent.label} exited with code ${code}.` });
    } else {
      session.started = true;
      emit({ type: "done" });
      if (looksLikeQuestion(replyText)) {
        sendPush({ title: "voicebridge — " + session.name + " asked a question", body: replyText.trim().slice(-160), sessionId: session.id });
      }
    }
    res.end();
  });

  res.on("close", () => { clearTimeout(timer); child.kill("SIGKILL"); });
}

module.exports = { streamLocal };
