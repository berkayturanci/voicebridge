"use strict";

const { buildPrompt, looksLikeQuestion, cloudRunnerUrl } = require("../config");
const { sendJson, SECURITY_HEADERS } = require("../routes/http-helpers");
const { sendPush } = require("../services/push");

function proxyCloudBrowse(p, res) {
  const fail = (error) => sendJson(res, 200, { path: p || "", parent: null, dirs: [], error });
  let url;
  try { url = new URL("/browse", cloudRunnerUrl()); } catch (_) { return fail("Invalid CLOUD_RUNNER_URL"); }
  if (p) url.searchParams.set("path", p);
  const lib = url.protocol === "https:" ? require("https") : require("http");
  const headers = {};
  if (process.env.CLOUD_RUNNER_TOKEN) headers["Authorization"] = "Bearer " + process.env.CLOUD_RUNNER_TOKEN;
  const r = lib.get(url, { headers }, (up) => {
    let data = "";
    up.setEncoding("utf8");
    up.on("data", (d) => (data += d));
    up.on("end", () => { try { sendJson(res, 200, JSON.parse(data)); } catch (_) { fail("cloud browse failed"); } });
  });
  r.on("error", (e) => fail("cloud: " + e.message));
}

function streamCloud(session, prompt, res, emit) {
  const base = cloudRunnerUrl();
  let url;
  try { url = new URL(base); } catch (_) { emit({ type: "error", error: "Cloud runner not configured (CLOUD_RUNNER_URL)." }); return res.end(); }
  const lib = url.protocol === "https:" ? require("https") : require("http");
  const payload = JSON.stringify({
    text: buildPrompt(session.voice, prompt),
    agent: session.agent, mode: session.mode, projectDir: session.projectDir,
    sessionId: session.id, continue: session.started,
  });
  const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) };
  if (process.env.CLOUD_RUNNER_TOKEN) headers["Authorization"] = "Bearer " + process.env.CLOUD_RUNNER_TOKEN;

  let pbuf = "", reply = "";
  const scan = (line) => { try { const ev = JSON.parse(line); if (ev.type === "delta" && ev.text) reply += ev.text; } catch (_) {} };
  const up = lib.request(url, { method: "POST", headers }, (r) => {
    r.setEncoding("utf8");
    r.on("data", (d) => {
      try { res.write(d); } catch (_) {}
      pbuf += d.toString();
      let i; while ((i = pbuf.indexOf("\n")) >= 0) { const line = pbuf.slice(0, i).trim(); pbuf = pbuf.slice(i + 1); if (line) scan(line); }
    });
    r.on("end", () => {
      if (pbuf.trim()) scan(pbuf.trim());
      session.started = true;
      if (looksLikeQuestion(reply)) sendPush({ title: "voicebridge — " + session.name + " asked a question", body: reply.trim().slice(-160), sessionId: session.id });
      res.end();
    });
  });
  up.on("error", (e) => { emit({ type: "error", error: "cloud runner: " + e.message }); res.end(); });
  up.write(payload); up.end();
  res.on("close", () => { try { up.destroy(); } catch (_) {} });
}

module.exports = {
  proxyCloudBrowse,
  streamCloud,
};
