"use strict";

// Voice agent (router): a small model between the user's voice and the coding
// sessions. It turns one utterance into a plan of tool calls:
//
//   send_to_session(session, text)  run a turn (the session you're on streams
//                                   back here; others run in the background)
//   stop_session(session)           interrupt the running turn
//   get_status(session)             busy/idle, for how long, last step / answer
//   read_full_answer(session)       speak the last full reply
//   list_sessions()                 name the sessions
//
// "Stop, add X, then continue" becomes stop_session + send_to_session in one
// step. Sessions are addressed by name; when the target is unclear the agent
// asks instead of guessing. Instructions that would commit, push, merge,
// delete, force, deploy or publish are read back for a spoken yes/no first.
//
// The model only plans; the bridge executes. Any provider the summarizer
// supports works, because the plan is plain JSON text (no tool-calling API
// needed). Off by default (VOICE_AGENT=1 or {voiceAgent:true} per request);
// when off, or when the model is unavailable or returns nothing usable, the
// utterance goes straight to the current session as in Stages 1–2.

const summarizer = require("./summarizer");
const { toSpeakable, foldText } = require("./speech-filter");
const { voiceModeActive } = require("./voice-style");
const { narratorConfig } = require("./narrator");

const TOOLS = ["send_to_session", "stop_session", "get_status", "read_full_answer", "list_sessions"];
const PENDING_TTL_MS = 2 * 60 * 1000;

function flag(v, dflt) {
  if (v == null || v === "") return dflt;
  return !/^(0|false|off|no)$/i.test(String(v).trim());
}

function enabledFor(session, override, env = process.env) {
  if (!session) return false;
  const on = (override === true || override === false) ? override : flag(env.VOICE_AGENT, false);
  return on && voiceModeActive(session);
}

// ---------- risk & confirmation ----------
const RISKY_RE = new RegExp([
  "\\bcommit", "\\bpush", "\\bmerge\\b", "\\brebase\\b", "\\bdelete\\b", "\\bremove\\b", "\\brm\\s+-",
  "\\bdrop\\s+(?:table|database|schema)", "reset\\s+--hard", "--force", "\\bforce[- ]push",
  "\\bdeploy", "\\bpublish", "\\brelease\\b",
  "\\bsil(?:in|iniz|me|eyim|ebilirsin)?\\b", "(?:^|\\s)kaldır", "yayınla", "\\bpushla", "commitle", "\\bdağıt",
].join("|"), "i");

function isRisky(text) { return RISKY_RE.test(String(text || "")); }

// Matched against foldText() output: lowercase, no accents, ı → i.
const YES_RE = /^(evet|onayliyorum|onayla|onayli|tamam|olur|yap|gonder|devam|yes|yeah|yep|sure|confirm(ed)?|go ahead|do it|ok(ay)?)\b/;
const NO_RE = /^(hayir|iptal|vazgec|yapma|gonderme|no|nope|cancel|abort|don'?t)\b/;
function classifyConfirmation(text) {
  const t = foldText(text).replace(/[.!?,]+/g, " ").trim();
  if (NO_RE.test(t)) return "no";
  if (YES_RE.test(t)) return "yes";
  return null;
}

let pending = null; // { actions, at }
function getPending(now = Date.now()) {
  if (pending && now - pending.at > PENDING_TTL_MS) pending = null;
  return pending;
}
function clearPending() { pending = null; }

// ---------- spoken templates ----------
const T = {
  en: {
    confirm: "I'll send this to {session}: {text}. Do you confirm?",
    cancelled: "Okay, cancelled.",
    busyAsk: "{session} is still working. Should I stop it and send: {text}?",
    sentBackground: "Sent to {session}.",
    stopped: "Stopped {session}.",
    notRunning: "{session} wasn't running anything.",
    statusBusy: "{session} is working, for {mins}. Last step: {last}.",
    statusBusyNoStep: "{session} is working, for {mins}.",
    statusIdle: "{session} is idle.",
    statusIdleLast: "{session} is idle. Last answer: {last}",
    list: "{count} sessions: {names}.",
    listOne: "One session: {names}.",
    which: "Which session? {names}.",
    noFull: "{session} has no answer to read yet.",
    min: "{n} minutes", min1: "a minute", lessMin: "less than a minute",
  },
  tr: {
    confirm: "{session} oturumuna şunu göndereceğim: {text}. Onaylıyor musun?",
    cancelled: "Tamam, iptal ettim.",
    busyAsk: "{session} hâlâ çalışıyor. Durdurup şunu göndereyim mi: {text}?",
    sentBackground: "{session} oturumuna gönderdim.",
    stopped: "{session} durduruldu.",
    notRunning: "{session} zaten bir şey çalıştırmıyordu.",
    statusBusy: "{session} çalışıyor, {mins} oldu. Son adım: {last}.",
    statusBusyNoStep: "{session} çalışıyor, {mins} oldu.",
    statusIdle: "{session} boşta.",
    statusIdleLast: "{session} boşta. Son cevap: {last}",
    list: "{count} oturum var: {names}.",
    listOne: "Bir oturum var: {names}.",
    which: "Hangi oturum? {names}.",
    noFull: "{session} için okunacak bir cevap yok.",
    min: "{n} dakika", min1: "bir dakika", lessMin: "bir dakikadan az",
  },
};
function t(key, vars, env = process.env) {
  const lang = narratorConfig(env).lang;
  const s = (T[lang] || T.en)[key] || T.en[key];
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null ? String(vars[k]) : ""));
}
function minutes(ms, env) {
  const n = Math.floor(ms / 60000);
  return n < 1 ? t("lessMin", {}, env) : n === 1 ? t("min1", {}, env) : t("min", { n }, env);
}
function firstSentence(text) {
  const s = toSpeakable(text || "");
  const m = s.match(/^.*?[.!?…](\s|$)/);
  return (m ? m[0] : s).trim().slice(0, 240);
}

// ---------- session resolution ----------
function baseName(p) { return String(p || "").replace(/\/+$/, "").split("/").pop() || ""; }
function norm(s) { return foldText(s).replace(/[^\p{L}\p{N}]+/gu, ""); }

// Returns { session } or { ambiguous: [...] } or { none: true }.
function resolveTarget(ref, list, active) {
  if (ref == null || ref === "" || /^(active|current|this|bu|şu|aktif)$/i.test(String(ref).trim())) {
    return active ? { session: active } : { none: true };
  }
  const key = norm(ref);
  if (!key) return active ? { session: active } : { none: true };
  const byId = list.find((s) => s.id === ref);
  if (byId) return { session: byId };
  const exact = list.filter((s) => norm(s.name) === key || norm(baseName(s.projectDir)) === key);
  if (exact.length === 1) return { session: exact[0] };
  if (exact.length > 1) return { ambiguous: exact };
  const partial = list.filter((s) => norm(s.name).includes(key) || key.includes(norm(s.name)) || norm(baseName(s.projectDir)).includes(key));
  if (partial.length === 1) return { session: partial[0] };
  if (partial.length > 1) return { ambiguous: partial };
  return { none: true };
}

// ---------- planning ----------
const ROUTER_SYSTEM = [
  "You are the voice router of VoiceBridge. The user talks to you hands-free (earbuds, not looking at a screen)",
  "while coding agents work in named sessions. Decide what to do and reply with ONLY one JSON object:",
  '{"actions":[...],"say":"","ask":null,"risky":false}',
  "Actions (executed in order):",
  '  {"tool":"send_to_session","session":"<name>","text":"<instruction for the coding agent>"}',
  '  {"tool":"stop_session","session":"<name>"}',
  '  {"tool":"get_status","session":"<name>"}',
  '  {"tool":"read_full_answer","session":"<name>"}',
  '  {"tool":"list_sessions"}',
  "Rules:",
  "- The target is the ACTIVE session unless the user names another one (by its name or project).",
  "- If the user refers to a session you cannot identify, or several could match, return no actions and a short question in \"ask\".",
  "- \"Stop, add X, then continue\" (or similar) = stop_session, then ONE send_to_session telling the agent to also do X and then continue the previous task.",
  "- Forward the user's request to the agent faithfully in the user's language. Never answer coding questions yourself.",
  "- \"say\": at most one short spoken sentence in the user's language, or \"\" when simply forwarding.",
  "- \"risky\": true if any instruction would commit, push, merge, delete files or data, force anything, deploy or publish.",
].join("\n");

function describeSessions(list, active, turnInfo) {
  return list.map((s) => {
    const info = turnInfo(s.id);
    const status = info ? `busy ${Math.round(info.runningMs / 1000)}s${info.lastActivity ? ` (last: ${info.lastActivity})` : ""}` : "idle";
    return `- name="${s.name}" project="${baseName(s.projectDir)}" agent=${s.agent} status=${status}${active && s.id === active.id ? " [ACTIVE]" : ""}`;
  }).join("\n");
}

function parsePlan(text) {
  if (!text) return null;
  const s = String(text).replace(/```(?:json)?/gi, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj;
  try { obj = JSON.parse(s.slice(start, end + 1)); } catch (_) { return null; }
  if (!obj || typeof obj !== "object") return null;
  const actions = Array.isArray(obj.actions) ? obj.actions.filter((a) => a && TOOLS.includes(a.tool)) : [];
  for (const a of actions) {
    if (a.tool === "send_to_session" && !(typeof a.text === "string" && a.text.trim())) return null;
  }
  const ask = typeof obj.ask === "string" && obj.ask.trim() ? obj.ask.trim() : null;
  const say = typeof obj.say === "string" ? obj.say.trim() : "";
  if (!actions.length && !ask && !say) return null;
  return { actions, say, ask, risky: obj.risky === true };
}

// ---------- execution ----------
async function handle({ text, active, res, deps, env = process.env }) {
  const t0 = Date.now();
  const log = (line) => { if (!/^(0|false|off)$/i.test(String(env.NARRATOR_LOG || ""))) { try { (deps.logger || console).log(line); } catch (_) {} } };
  const list = deps.listSessions();
  let actions = null;
  let say = "";
  let confirmed = false;

  // 1) A pending confirmation is answered with yes/no; anything else drops it.
  const p = getPending();
  if (p) {
    const c = classifyConfirmation(text);
    clearPending();
    if (c === "yes") { actions = p.actions; confirmed = true; }
    else if (c === "no") { return speakOnly(t("cancelled", {}, env)); }
  }

  // 2) Ask the model for a plan.
  if (!actions) {
    const r = await deps.complete({
      system: ROUTER_SYSTEM,
      user: `Sessions:\n${describeSessions(list, active, deps.turnInfo)}\n\nUser said: ${String(text).slice(0, 2000)}`,
      maxTokens: 500, env, label: "router", raw: true, logger: deps.logger,
    });
    const plan = r && parsePlan(r.text);
    if (!plan) return false; // fall back: send the utterance to the active session as-is
    if (plan.ask) return speakOnly(plan.ask);
    actions = plan.actions;
    say = plan.say;

    // 3) Resolve targets; ask when unclear.
    for (const a of actions) {
      if (a.tool === "list_sessions") continue;
      const r2 = resolveTarget(a.session, list, active);
      if (!r2.session) {
        const names = (r2.ambiguous || list).map((s) => s.name).join(", ");
        return speakOnly(t("which", { names }, env));
      }
      a.sessionId = r2.session.id;
    }

    // 4) Busy target without an explicit stop → offer stop-and-send.
    const stops = new Set(actions.filter((a) => a.tool === "stop_session").map((a) => a.sessionId));
    const busySend = actions.find((a) => a.tool === "send_to_session" && deps.isBusy(a.sessionId) && !stops.has(a.sessionId));
    if (busySend) {
      const idx = actions.indexOf(busySend);
      actions.splice(idx, 0, { tool: "stop_session", sessionId: busySend.sessionId });
      pending = { actions, at: Date.now() };
      return speakOnly(t("busyAsk", { session: nameOf(busySend.sessionId), text: spoken(busySend.text) }, env));
    }

    // 5) Risky instructions are read back first.
    const sends = actions.filter((a) => a.tool === "send_to_session");
    if (sends.length && (plan.risky || sends.some((a) => isRisky(a.text)))) {
      pending = { actions, at: Date.now() };
      const s = sends[0];
      return speakOnly(t("confirm", { session: nameOf(s.sessionId), text: spoken(s.text) }, env));
    }
  }

  // 6) Execute. At most one send to the active session streams back here
  //    and must run last; other sends run in the background.
  if (!res.headersSent) res.writeHead(200, deps.streamHeaders(active, { "X-VB-Voice-Agent": "1" }));
  const emit = deps.rawEmitter(active, res);
  const sayLine = (s) => { if (s) { emit({ type: "delta", text: s + "\n" }); emit({ type: "speech", text: s }); } };
  emit({ type: "router", actions: actions.map(publicAction), confirmed });
  sayLine(say);

  let proxy = null;
  for (const a of actions) {
    const target = a.sessionId ? deps.getSession(a.sessionId) : null;
    if (a.tool === "list_sessions") {
      const names = list.map((s) => s.name).join(", ");
      sayLine(list.length === 1 ? t("listOne", { names }, env) : t("list", { count: list.length, names }, env));
    } else if (!target) {
      continue;
    } else if (a.tool === "stop_session") {
      const was = await deps.stopTurn(target.id);
      if (!say) sayLine(t(was ? "stopped" : "notRunning", { session: target.name }, env));
    } else if (a.tool === "get_status") {
      sayLine(statusText(target, deps.turnInfo(target.id), env));
    } else if (a.tool === "read_full_answer") {
      if (target.lastReply && target.lastReply.text) deps.emitFullAnswer(target, emit);
      else sayLine(t("noFull", { session: target.name }, env));
    } else if (a.tool === "send_to_session") {
      if (target.id === active.id && !proxy) { proxy = { target, text: a.text }; continue; }
      deps.streamAsk(target, a.text, deps.createSink());
      if (!say) sayLine(t("sentBackground", { session: target.name }, env));
    }
  }
  log(`[voice-agent] plan=${actions.map((a) => a.tool).join(",") || "none"} +${Date.now() - t0}ms`);
  if (proxy) { deps.streamAsk(proxy.target, proxy.text, res); return true; }
  emit({ type: "done" });
  res.end();
  return true;

  function nameOf(id) { const s = list.find((x) => x.id === id); return s ? s.name : id; }
  function spoken(s) { const v = toSpeakable(s).replace(/[.!?…]+$/, ""); return v.length > 160 ? v.slice(0, 160).replace(/\s+\S*$/, "") + "…" : v; }
  function speakOnly(line) {
    if (!res.headersSent) res.writeHead(200, deps.streamHeaders(active, { "X-VB-Voice-Agent": "1" }));
    const e = deps.rawEmitter(active, res);
    e({ type: "router", actions: [], pending: !!getPending() });
    e({ type: "delta", text: line });
    e({ type: "speech", text: line });
    e({ type: "done" });
    res.end();
    log(`[voice-agent] ${getPending() ? "awaiting confirmation" : "reply"} +${Date.now() - t0}ms`);
    return true;
  }
}

function publicAction(a) {
  const o = { tool: a.tool };
  if (a.sessionId) o.sessionId = a.sessionId;
  if (a.text) o.text = a.text;
  return o;
}

function statusText(session, info, env) {
  if (info) {
    return info.lastActivity
      ? t("statusBusy", { session: session.name, mins: minutes(info.runningMs, env), last: toSpeakable(info.lastActivity).replace(/[.]+$/, "") }, env)
      : t("statusBusyNoStep", { session: session.name, mins: minutes(info.runningMs, env) }, env);
  }
  const last = session.lastReply && (session.lastReply.summary || firstSentence(session.lastReply.text));
  return last ? t("statusIdleLast", { session: session.name, last }, env) : t("statusIdle", { session: session.name }, env);
}

module.exports = {
  enabledFor,
  handle,
  isRisky,
  classifyConfirmation,
  resolveTarget,
  parsePlan,
  statusText,
  getPending,
  clearPending,
  ROUTER_SYSTEM,
  complete: summarizer.complete,
};
