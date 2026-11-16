"use strict";

// Running-turn registry: which sessions are busy, since when, doing what, and
// how to stop them. Used by the voice agent (get_status / stop_session) and
// exposed read-only via publicSession-style helpers.

const EventEmitter = require("events");

const active = new Map(); // sessionId -> turn

function register(session, prompt, res, { stop } = {}) {
  const turn = {
    sessionId: session.id,
    prompt: String(prompt || "").slice(0, 300),
    startedAt: Date.now(),
    activity: [], // last few activity labels
    lastEventAt: Date.now(),
    res,
    stop: stop || null,
    stopped: false,
    closed: new Promise((resolve) => { res.once("close", resolve); }),
  };
  active.set(session.id, turn);
  res.once("close", () => { if (active.get(session.id) === turn) active.delete(session.id); });
  return turn;
}

function note(sessionId, ev) {
  const t = active.get(sessionId);
  if (!t || !ev) return;
  t.lastEventAt = Date.now();
  if (ev.type === "activity" && ev.text) {
    t.activity.push(String(ev.text).slice(0, 120));
    if (t.activity.length > 8) t.activity.shift();
  }
}

function isBusy(sessionId) { return active.has(sessionId); }

function info(sessionId, now = Date.now()) {
  const t = active.get(sessionId);
  if (!t) return null;
  return {
    prompt: t.prompt,
    runningMs: now - t.startedAt,
    activity: t.activity.slice(),
    lastActivity: t.activity[t.activity.length - 1] || null,
  };
}

// Stop a running turn and wait (up to timeoutMs) for it to release the session.
async function stop(sessionId, { timeoutMs = 5000 } = {}) {
  const t = active.get(sessionId);
  if (!t) return false;
  t.stopped = true;
  try { if (t.stop) t.stop(); } catch (_) {}
  // Tell the listening client the turn ended on purpose, then close the
  // stream: every runner kills its child when the response closes.
  try { if (!t.res.writableEnded) t.res.write(JSON.stringify({ type: "done", stopped: true }) + "\n"); } catch (_) {}
  try { t.res.end(); } catch (_) {}
  try { if (typeof t.res.destroy === "function") t.res.destroy(); } catch (_) {}
  let timer;
  await Promise.race([t.closed, new Promise((r) => { timer = setTimeout(r, timeoutMs); })]);
  clearTimeout(timer);
  if (active.get(sessionId) === t) active.delete(sessionId);
  return true;
}

// A response-shaped sink for turns started in the background (sent to a
// session other than the one the user is looking at). Events still reach
// /ws subscribers through the hub. `onEvent` receives each NDJSON event written.
function createSink(onEvent) {
  const sink = new EventEmitter();
  sink.headersSent = false;
  sink.writableEnded = false;
  sink.writeHead = () => { sink.headersSent = true; return sink; };
  sink.write = (chunk) => {
    if (typeof onEvent === "function") {
      for (const line of String(chunk || "").split("\n")) {
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
        try { onEvent(ev); } catch (_) {}
      }
    }
    return true;
  };
  sink.end = () => {
    if (sink.writableEnded) return sink;
    sink.writableEnded = true;
    setImmediate(() => sink.emit("close"));
    return sink;
  };
  sink.destroy = () => sink.end();
  return sink;
}

module.exports = { register, note, isBusy, info, stop, createSink, _active: active };
