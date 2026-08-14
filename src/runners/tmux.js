"use strict";

const path = require("path");
const { execFile } = require("child_process");
const { buildPrompt } = require("../config");
const { AGENTS } = require("../adapters");
const { saveSessions, findJsonlByContent } = require("../services/sessions");

const TMUX_IDLE_MS = Number(process.env.TMUX_IDLE_MS ?? 60 * 60 * 1000) || 0;
const tmuxIdleTimers = new Map();

function tmuxName(id) { return "vb_" + String(id).replace(/[^a-zA-Z0-9_]/g, "_"); }

function tmuxRun(args) {
  return new Promise((resolve) => {
    execFile("tmux", args, { env: process.env, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve({ err, out: (stdout || "").toString() }));
  });
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function tmuxHas(name) { return !(await tmuxRun(["has-session", "-t", name])).err; }

async function tmuxCapture(name, scroll) {
  const args = ["capture-pane", "-p", "-t", name];
  if (scroll) args.splice(1, 0, "-S", String(scroll));
  return (await tmuxRun(args)).out;
}

function killTmux(sessionId) {
  const t = tmuxIdleTimers.get(sessionId); if (t) { clearTimeout(t); tmuxIdleTimers.delete(sessionId); }
  tmuxRun(["kill-session", "-t", tmuxName(sessionId)]);
}

async function ensureTmuxAgent(session) {
  const name = tmuxName(session.id);
  if (await tmuxHas(name)) return name;
  const agent = AGENTS[session.agent] || AGENTS.claude;
  if (!agent.tmux) throw new Error("Tmux runner not supported for agent: " + session.agent);
  
  const launch = agent.tmux.launchArgs(session, name);
  await tmuxRun(["new-session", "-d", "-s", name, "-x", "220", "-y", "50", "-c", session.projectDir, launch]);
  for (let i = 0; i < 40; i++) {
    await sleepMs(500);
    if (agent.tmux.readyRe.test(await tmuxCapture(name))) { await sleepMs(900); break; }
  }
  return name;
}

async function streamTmux(session, prompt, res, emit) {
  const old = tmuxIdleTimers.get(session.id); if (old) { clearTimeout(old); tmuxIdleTimers.delete(session.id); }
  let name;
  try { name = await ensureTmuxAgent(session); }
  catch (e) { emit({ type: "error", error: "couldn't start tmux: " + e.message }); return res.end(); }

  const text = buildPrompt(session.voice, prompt).replace(/\s*\n\s*/g, " ").trim();
  await tmuxRun(["send-keys", "-t", name, "-l", text]);
  await sleepMs(180);
  await tmuxRun(["send-keys", "-t", name, "Enter"]);
  emit({ type: "activity", text: "tmux: " + session.agent + " is thinking…" });

  const MAXMS = (Number(process.env.AGENT_TIMEOUT_MS ?? 20 * 60 * 1000) || 0) || 20 * 60 * 1000;
  const t0 = Date.now();
  let prev = "", stable = 0, sawGen = false, closed = false;
  res.on("close", () => { closed = true; });
  const agent = AGENTS[session.agent] || AGENTS.claude;
  const genRe = agent.tmux.generatingRe;
  while (!closed && Date.now() - t0 < MAXMS) {
    await sleepMs(1400);
    const cur = await tmuxCapture(name);
    if (genRe.test(cur)) sawGen = true;
    if (cur === prev) stable++; else stable = 0;
    prev = cur;
    if (stable >= 2 && !genRe.test(cur) && (sawGen || stable >= 4)) break;
  }
  if (closed) return;
  const reply = agent.tmux.extractReply(await tmuxCapture(name, -250), text);
  emit({ type: "delta", text: reply || "(couldn't capture the reply — check with `tmux attach` on your Mac)" });
  session.started = true;
  if (!session.claudeSessionId) {
    const jp = findJsonlByContent(session.projectDir, String(prompt || "").slice(0, 80));
    if (jp) {
      session.tmuxJsonl = jp;
      session.claudeSessionId = path.basename(jp).replace(/\.jsonl$/, "");
      saveSessions();
    }
  }
  if (TMUX_IDLE_MS > 0) tmuxIdleTimers.set(session.id, setTimeout(() => killTmux(session.id), TMUX_IDLE_MS));
  emit({ type: "done" });
  res.end();
}

module.exports = {
  TMUX_IDLE_MS,
  tmuxIdleTimers,
  tmuxName,
  tmuxRun,
  tmuxHas,
  tmuxCapture,
  killTmux,
  ensureTmuxAgent,
  streamTmux,
  sleepMs,
};
