#!/usr/bin/env node
"use strict";
/*
 * Reference cloud runner for voicebridge.
 *
 * Runs the agent CLI on THIS host and streams the same NDJSON protocol the
 * bridge expects ({type:"delta"|"done"|"error"}). Point the bridge at it with:
 *
 *   CLOUD_RUNNER_URL=http://this-host:8910/  (and matching CLOUD_RUNNER_TOKEN)
 *
 * It reuses voicebridge's agent adapters so the commands/parsing stay in sync.
 *
 * Env: PORT (8910), HOST (0.0.0.0), CLOUD_RUNNER_TOKEN (optional Bearer).
 */
const http = require("http");
const fs = require("fs");
const { spawn } = require("child_process");
const { AGENTS, buildPrompt, browseDir } = require("../../server.js");

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }

const PORT = parseInt(process.env.PORT || "8910", 10);
const HOST = process.env.HOST || "0.0.0.0";
const TOKEN = process.env.CLOUD_RUNNER_TOKEN || "";

function authorized(req) {
  if (!TOKEN) return true;
  return (req.headers["authorization"] || "") === "Bearer " + TOKEN;
}

const server = http.createServer((req, res) => {
  // GET /browse: list this (remote) host's directories for the folder picker.
  if (req.method === "GET" && req.url.split("?")[0] === "/browse") {
    if (!authorized(req)) { res.writeHead(401); return res.end(JSON.stringify({ error: "unauthorized" })); }
    const p = new URL(req.url, "http://x").searchParams.get("path");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify(browseDir(p)));
  }
  if (req.method !== "POST") { res.writeHead(405); return res.end(); }
  if (!authorized(req)) { res.writeHead(401); return res.end(JSON.stringify({ type: "error", error: "unauthorized" }) + "\n"); }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let d = {}; try { d = JSON.parse(body || "{}"); } catch (_) {}
    const agent = AGENTS[d.agent] || AGENTS.claude;
    const mode = agent.modes[d.mode] ? d.mode : agent.defaultMode;
    const cont = !!d.continue && agent.supportsContinue;
    const { argv, stdin } = agent.command(buildPrompt(!!d.voice, d.text || ""), { cont, modeArgs: agent.modes[mode].args });

    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
    const emit = (o) => { try { res.write(JSON.stringify(o) + "\n"); } catch (_) {} };

    const cwd = d.projectDir && isDir(d.projectDir) ? d.projectDir : process.cwd();
    let child;
    try { child = spawn(agent.bin(), argv, { cwd, env: process.env }); }
    catch (e) { emit({ type: "error", error: e.message }); return res.end(); }
    if (stdin != null) { try { child.stdin.write(stdin); child.stdin.end(); } catch (_) {} }

    let buf = "", err = "", got = false;
    const onText = (t) => { if (t) { got = true; emit({ type: "delta", text: t }); } };
    child.stdout.on("data", (x) => {
      const s = x.toString();
      if (agent.stream === "ndjson") {
        buf += s; let i;
        while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onText(agent.parseLine(line)); }
      } else onText(s);
    });
    child.stderr.on("data", (x) => (err += x.toString()));
    child.on("error", (e) => { emit({ type: "error", error: e.message }); res.end(); });
    child.on("close", (code) => {
      if (agent.stream === "ndjson" && buf.trim()) onText(agent.parseLine(buf));
      if (code !== 0 && !got) emit({ type: "error", error: err.trim() || ("exit " + code) });
      else emit({ type: "done" });
      res.end();
    });
    res.on("close", () => child.kill("SIGKILL"));
  });
});

server.listen(PORT, HOST, () => console.log(`voicebridge cloud-runner on http://${HOST}:${PORT}`));
