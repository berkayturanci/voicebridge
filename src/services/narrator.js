"use strict";

// Narrator: shapes what a listening user hears during and after a turn.
//
// Per turn (createVoicePipeline), on top of Stage 1's speech filter:
//   • progress  — every NARRATOR_INTERVAL_MS (default 30 s) while the agent
//                 works, the new tool activity is summarized into one short
//                 sentence by the summarizer model ("running the tests, edited
//                 two files"). Skipped when nothing new happened or while the
//                 user is speaking.
//   • final     — when the turn ends, a long spoken reply is boiled down to
//                 1–2 sentences. Short replies (≤ NARRATOR_FINAL_MIN_CHARS of
//                 speakable text) are read as they are.
//   • approval  — a pending tool approval is announced immediately
//                 ("<session> is waiting for your approval: …").
// The chat always receives every `delta` untouched; the full reply is kept on
// the session so "read the full answer" can speak it later.
//
// Falls back silently to Stage 1 behaviour (raw speech as it streams) when the
// session isn't in voice mode, the narrator is off, the runner is cloud, or the
// summarizer is unconfigured or failing.

const summarizer = require("./summarizer");
const { createSpeechStream, toSpeakable, foldText } = require("./speech-filter");
const { voiceModeActive } = require("./voice-style");

function flag(v, dflt) {
  if (v == null || v === "") return dflt;
  return !/^(0|false|off|no)$/i.test(String(v).trim());
}
function num(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function narratorConfig(env = process.env) {
  return {
    enabled: flag(env.NARRATOR, true),
    intervalMs: num(env.NARRATOR_INTERVAL_MS, 30000),
    finalSummary: flag(env.NARRATOR_FINAL_SUMMARY, true),
    finalMinChars: num(env.NARRATOR_FINAL_MIN_CHARS, 280),
    lang: String(env.NARRATOR_LANG || "en").toLowerCase().slice(0, 2),
  };
}

// ---------- "the user is speaking" ----------
// Set by clients (WebSocket {type:"listening"} or POST /api/listening) while the
// mic is open. Expires on its own so a vanished client can't mute the narrator.
const LISTENING_TTL_MS = 60000;
let listeningUntil = 0;
function setListening(active, ttlMs = LISTENING_TTL_MS) { listeningUntil = active ? Date.now() + ttlMs : 0; }
function isListening() { return Date.now() < listeningUntil; }

// ---------- templates ----------
const TEMPLATES = {
  en: {
    approval: "{session} is waiting for your approval: {action}.",
    approvalNoAction: "{session} is waiting for your approval.",
    noFull: "There is no previous answer to read yet.",
    readingFull: "Reading the full answer.",
  },
  tr: {
    approval: "{session} onayını bekliyor: {action}.",
    approvalNoAction: "{session} onayını bekliyor.",
    noFull: "Okunacak önceki bir cevap yok.",
    readingFull: "Tam cevabı okuyorum.",
  },
};
function template(key, vars, env = process.env) {
  const override = key === "approval" ? env.NARRATOR_APPROVAL_TEXT : "";
  const lang = narratorConfig(env).lang;
  const t = override || (TEMPLATES[lang] || TEMPLATES.en)[key] || TEMPLATES.en[key];
  return t.replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null ? String(vars[k]) : ""));
}

function approvalText(session, ev, env = process.env) {
  const raw = (ev && (ev.description || ev.command || ev.tool)) || "";
  let action = toSpeakable(raw).replace(/[.!?]+$/, "");
  if (action.length > 80) action = action.slice(0, 80).replace(/\s+\S*$/, "");
  const name = (session && session.name) || "The agent";
  return action ? template("approval", { session: name, action }, env) : template("approvalNoAction", { session: name }, env);
}

// ---------- "read the full answer" ----------
const DEFAULT_READ_FULL = [
  "read the full answer", "read full answer", "read the whole answer", "full answer",
  "tam cevabı oku", "tam cevabi oku", "cevabın tamamını oku", "cevabin tamamini oku", "tamamını oku",
];
function normalizeCommand(s) {
  return foldText(s).replace(/[.!?,;:"'’]+/g, "").replace(/\s+/g, " ").trim();
}
function isReadFullCommand(text, env = process.env) {
  const custom = String(env.NARRATOR_READ_FULL_PHRASES || "").split("|").map(normalizeCommand).filter(Boolean);
  const phrases = custom.length ? custom : DEFAULT_READ_FULL.map(normalizeCommand);
  return phrases.includes(normalizeCommand(text));
}

// ---------- prompts for the summarizer ----------
const PROGRESS_SYSTEM =
  "You narrate a coding agent's progress to a user who is listening on headphones, not looking at a screen. " +
  "Given the user's request and the agent's recent actions, say in ONE short spoken sentence (at most 15 words) " +
  "what the agent is doing now, e.g. 'Running the tests; two files edited so far.' " +
  "No code, file paths, links or markdown. Answer in the language of the user's request. Output only the sentence.";
const FINAL_SYSTEM =
  "You turn a coding agent's reply into what a listening user should hear. " +
  "Summarize it in 1 or 2 short spoken sentences: the outcome first, then anything the user must decide. " +
  "Keep any question the agent asks the user. No code, file paths, links or markdown. " +
  "Answer in the same language as the reply. Output only the sentences.";

function describeEvent(ev) {
  if (!ev) return "";
  if (ev.type === "activity") return "- " + String(ev.text || ev.tool || "tool").slice(0, 120);
  if (ev.type === "tool_result") return ev.error ? "- (that step failed)" : "";
  if (ev.type === "approval_request") return "- waiting for approval: " + String(ev.description || ev.tool || "").slice(0, 100);
  return "";
}

// ---------- per-turn pipeline ----------
function createVoicePipeline({ session, prompt, rawEmit, env = process.env, summarize = summarizer.complete, isAvailable = summarizer.available, logger = console }) {
  const cfg = narratorConfig(env);
  const narrate = !!(cfg.enabled && voiceModeActive(session) && session.runner !== "cloud");
  // Hold spoken text back for a possible final summary only when a summarizer
  // can be tried right now; otherwise speak as the reply streams (Stage 1).
  const buffering = narrate && cfg.finalSummary && isAvailable(env);

  const speech = createSpeechStream();
  const held = [];
  let fullText = "";
  const recent = [];
  let lastNarratedIdx = 0;
  let narrating = false;
  let ended = false;
  let settled = false;
  let settleWaiters = [];
  let timer = null;
  let pendingEnd = false;

  const emitSpeech = (text) => {
    if (!text) return;
    if (buffering) held.push(text); else rawEmit({ type: "speech", text });
  };

  async function progressTick() {
    if (ended || narrating) return;
    if (recent.length <= lastNarratedIdx) return; // nothing new
    if (isListening()) return; // never talk over the user; try next tick
    if (!isAvailable(env)) return;
    const slice = recent.slice(lastNarratedIdx).slice(-20);
    const upto = recent.length;
    narrating = true;
    try {
      const lines = slice.map(describeEvent).filter(Boolean).join("\n");
      if (!lines) { lastNarratedIdx = upto; return; }
      const r = await summarize({
        system: PROGRESS_SYSTEM,
        user: `User's request: ${String(prompt || "").slice(0, 400)}\n\nRecent agent actions (oldest first):\n${lines}`,
        maxTokens: 60, env, logger, label: "progress",
      });
      lastNarratedIdx = upto;
      if (r && r.text && !ended && !isListening()) {
        rawEmit({ type: "narration", kind: "progress", text: r.text, ms: r.ms });
      }
    } finally {
      narrating = false;
    }
  }

  if (narrate && cfg.intervalMs > 0) {
    timer = setInterval(() => { progressTick().catch(() => {}); }, cfg.intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

  function remember(spoken, summary) {
    session.lastReply = { text: fullText, spoken: spoken || "", summary: summary || null, at: Date.now() };
  }

  function settle() {
    settled = true;
    const w = settleWaiters; settleWaiters = [];
    for (const fn of w) { try { fn(); } catch (_) {} }
  }

  async function finish(doneEv) {
    const tail = speech.flush();
    if (tail) emitSpeech(tail);
    if (!buffering) {
      remember(null, null);
      rawEmit(doneEv);
      return settle();
    }
    const spoken = held.join(" ").trim();
    let summary = null;
    if (spoken.length > cfg.finalMinChars && fullText.trim()) {
      const r = await summarize({
        system: FINAL_SYSTEM,
        user: fullText.slice(0, 12000),
        maxTokens: 160, env, logger, label: "final",
      });
      if (r && r.text) summary = r;
    }
    if (summary) {
      rawEmit({ type: "narration", kind: "final", text: summary.text, ms: summary.ms, full: true });
    } else if (spoken) {
      rawEmit({ type: "speech", text: spoken });
    }
    remember(spoken, summary && summary.text);
    rawEmit(doneEv);
    settle();
  }

  function emit(obj) {
    if (!obj || typeof obj !== "object") return rawEmit(obj);
    if (ended) return rawEmit(obj);
    switch (obj.type) {
      case "delta":
        rawEmit(obj);
        if (obj.text) { fullText += obj.text; emitSpeech(speech.push(obj.text)); }
        return;
      case "activity":
      case "tool_result":
        rawEmit(obj);
        recent.push(obj);
        return;
      case "approval_request":
        rawEmit(obj);
        recent.push(obj);
        if (narrate) rawEmit({ type: "narration", kind: "approval", text: approvalText(session, obj, env) });
        return;
      case "done":
        ended = true;
        stopTimer();
        finish(obj).catch(() => { try { rawEmit(obj); } catch (_) {} settle(); });
        return;
      case "error": {
        ended = true;
        stopTimer();
        const tail = speech.flush();
        const spoken = (held.join(" ") + " " + (tail || "")).trim();
        if (spoken) rawEmit({ type: "speech", text: spoken });
        if (fullText) remember(spoken, null);
        rawEmit(obj);
        return settle();
      }
      default:
        return rawEmit(obj);
    }
  }

  // Runners forwarding upstream NDJSON verbatim (cloud) only tap deltas.
  emit.tapDelta = (text) => { if (text) { fullText += text; emitSpeech(speech.push(text)); } };
  emit.flushSpeech = () => { const t = speech.flush(); if (t) rawEmit({ type: "speech", text: t }); };

  // Delay res.end() until the final summary (if any) has been written.
  function deferEnd(res) {
    const realEnd = res.end.bind(res);
    res.end = (...args) => {
      if (pendingEnd) return res;
      if (settled || !ended) { stopTimer(); return realEnd(...args); }
      pendingEnd = true;
      settleWaiters.push(() => realEnd(...args));
      return res;
    };
    res.on("close", () => { ended = true; stopTimer(); });
  }

  return { emit, deferEnd, narrate, buffering, progressTick, _state: () => ({ held: held.slice(), recent: recent.length, fullText }) };
}

module.exports = {
  narratorConfig,
  createVoicePipeline,
  isReadFullCommand,
  approvalText,
  template,
  setListening,
  isListening,
  PROGRESS_SYSTEM,
  FINAL_SYSTEM,
};
