"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const {
  PKG_VERSION,
  STT_MODE,
  ACCESS_TOKEN,
  DEFAULT_PROJECT_DIR,
  FAVORITES,
  maxInflight,
  cloudRunnerUrl,
  ollamaUrl,
} = require("../config");
const { AGENTS, agentAvailable } = require("../adapters");
const sessionsService = require("../services/sessions");
const {
  sessions,
  createSession,
  resolveSession,
  publicSession,
  saveSessions,
  browseDir,
  listClaudeSessions,
  resolveJsonlPath,
  readTranscriptTurns,
  findJsonlByContent,
  turnFromTranscriptLine,
} = sessionsService;
const { commandGroupsForAgent } = require("../services/commands");
const { pushEnabled, pushSubs } = require("../services/push");
const { transcribe } = require("../services/stt");
const { streamAsk, proxyCloudBrowse } = require("../runners");
const { killTmux, ensureTmuxAgent, tmuxName, tmuxHas, tmuxCapture, tmuxRun, sleepMs } = require("../runners/tmux");
const { killLive } = require("../runners/live");
const { send, sendJson, authorized, readBody } = require("./http-helpers");
const { serveStatic } = require("./static");

let inflight = 0;

function handleRequest(req, res) {
  const urlPath = req.url.split("?")[0];

  if (req.method === "GET" && urlPath === "/api/push/key") {
    return sendJson(res, 200, { enabled: pushEnabled(), key: process.env.VAPID_PUBLIC_KEY || "" });
  }

  if (req.method === "GET" && urlPath === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      version: PKG_VERSION,
      uptime: Math.round(process.uptime()),
      sessions: sessions.size,
    });
  }

  if (req.method === "GET" && urlPath === "/api/config") {
    return sendJson(res, 200, {
      sttMode: STT_MODE,
      authRequired: !!ACCESS_TOKEN,
      agents: Object.keys(AGENTS).map((id) => ({
        id, label: AGENTS[id].label, supportsContinue: AGENTS[id].supportsContinue,
        defaultMode: AGENTS[id].defaultMode, available: agentAvailable(id),
        modes: Object.keys(AGENTS[id].modes).map((m) => ({ id: m, label: AGENTS[id].modes[m].label })),
      })),
      defaultProjectDir: DEFAULT_PROJECT_DIR,
      defaultSessionId: sessionsService.defaultSessionId,
      favorites: FAVORITES,
      runners: ["local"].concat((process.env.CLOUD_RUNNER_URL || "") ? ["cloud"] : []),
    });
  }

  if (urlPath.startsWith("/api/")) {
    if (!authorized(req)) return sendJson(res, 401, { error: "Unauthorized" });

    if (req.method === "GET" && urlPath === "/api/commands") {
      const q = new URL(req.url, "http://x").searchParams;
      const session = resolveSession(q.get("sessionId"));
      if (!session) return sendJson(res, 404, { error: "unknown session" });
      if (session.runner === "cloud") return sendJson(res, 200, { groups: [] });
      const agentId = q.get("agent") || session.agent;
      return sendJson(res, 200, { groups: commandGroupsForAgent(agentId, session.projectDir) });
    }

    if (req.method === "GET" && urlPath === "/api/claude-sessions") {
      const q = new URL(req.url, "http://x").searchParams;
      let projectDir = q.get("projectDir");
      if (!projectDir) {
        const s = resolveSession(q.get("sessionId"));
        if (s) projectDir = s.projectDir;
      }
      if (!projectDir) return sendJson(res, 400, { error: "projectDir required" });
      return sendJson(res, 200, { sessions: listClaudeSessions(projectDir) });
    }

    if (req.method === "GET" && urlPath === "/api/browse") {
      const q = new URL(req.url, "http://x").searchParams;
      if (q.get("runner") === "cloud" && cloudRunnerUrl()) return proxyCloudBrowse(q.get("path"), res);
      return sendJson(res, 200, browseDir(q.get("path")));
    }

    if (req.method === "GET" && urlPath === "/api/sessions") {
      return sendJson(res, 200, {
        sessions: Array.from(sessions.values()).map(publicSession),
        defaultSessionId: sessionsService.defaultSessionId,
      });
    }

    if (req.method === "POST" && urlPath === "/api/sessions") {
      return readBody(req, 64 * 1024, (e, body) => {
        if (e) return sendJson(res, 400, { error: "Bad request" });
        let data; try { data = JSON.parse(body.toString("utf8") || "{}"); }
        catch (_) { return sendJson(res, 400, { error: "Bad JSON" }); }
        let s;
        try { s = createSession(data); }
        catch (err) { return sendJson(res, 400, { error: err.message }); }
        saveSessions();
        return sendJson(res, 200, { session: publicSession(s) });
      });
    }

    if (req.method === "DELETE" && urlPath.startsWith("/api/sessions/")) {
      const id = urlPath.slice("/api/sessions/".length);
      if (id === sessionsService.defaultSessionId) return sendJson(res, 400, { error: "Cannot delete the default session" });
      const existed = sessions.delete(id);
      if (existed) { killTmux(id); killLive(id); saveSessions(); }
      return sendJson(res, existed ? 200 : 404, existed ? { ok: true } : { error: "Not found" });
    }

    if (req.method === "POST" && urlPath.startsWith("/api/sessions/")) {
      const id = urlPath.slice("/api/sessions/".length);
      const s = sessions.get(id);
      if (!s) return sendJson(res, 404, { error: "Not found" });
      return readBody(req, 64 * 1024, (e, body) => {
        let data = {}; try { data = JSON.parse((body || "").toString("utf8") || "{}"); } catch (_) {}
        if (typeof data.name === "string" && data.name.trim()) s.name = data.name.trim();
        if (data.mode && AGENTS[s.agent].modes[data.mode]) s.mode = data.mode;
        if (typeof data.voice === "boolean") s.voice = data.voice;
        if (typeof data.claudeSessionId === "string") {
          s.claudeSessionId = sanitizeSessionId(data.claudeSessionId);
          s.started = false;
        }
        saveSessions();
        return sendJson(res, 200, { session: publicSession(s) });
      });
    }

    if (req.method === "POST" && urlPath === "/api/ask") {
      return readBody(req, 64 * 1024, (e, body) => {
        if (e) return sendJson(res, 400, { error: "Bad request" });
        let data; try { data = JSON.parse(body.toString("utf8") || "{}"); }
        catch (_) { return sendJson(res, 400, { error: "Bad JSON" }); }
        const text = typeof data.text === "string" ? data.text.trim() : "";
        if (!text) return sendJson(res, 400, { error: "Empty prompt" });
        const session = resolveSession(data.sessionId);
        if (!session) return sendJson(res, 404, { error: "Unknown session" });
        if (inflight >= maxInflight()) return sendJson(res, 429, { error: "Too many concurrent turns; try again." });
        if (data.reset) session.started = false;
        if (data.mode && AGENTS[session.agent].modes[data.mode]) session.mode = data.mode;
        if (typeof data.voice === "boolean") session.voice = data.voice;
        if (typeof data.model === "string" && data.model.trim()) session.model = data.model.trim();
        inflight++;
        res.on("close", () => { inflight = Math.max(0, inflight - 1); });
        streamAsk(session, text, res);
      });
    }

    if (req.method === "POST" && urlPath === "/api/tts") {
      return readBody(req, 64 * 1024, (e, body) => {
        if (e) return sendJson(res, 400, { error: "Bad request" });
        let data = {}; try { data = JSON.parse((body || "").toString("utf8") || "{}"); } catch (_) {}
        const text = (typeof data.text === "string" ? data.text : "").trim();
        if (!text) return sendJson(res, 400, { error: "Empty text" });
        const bin = process.env.PIPER_BIN || path.join(os.homedir(), ".local/bin/piper");
        const model = process.env.PIPER_VOICE || "tr_TR-dfki-medium";
        const dataDir = process.env.PIPER_DATA_DIR || path.join(os.homedir(), ".local/share/piper-voices");
        const tmp = path.join(os.tmpdir(), "vb-tts-" + crypto.randomBytes(6).toString("hex") + ".wav");
        let child;
        try { child = spawn(bin, ["-m", model, "--data-dir", dataDir, "-f", tmp], { env: process.env }); }
        catch (ee) { return sendJson(res, 500, { error: "piper spawn: " + ee.message }); }
        let err = "";
        let responded = false;
        const replyErr = (status, msg) => {
          if (responded) return;
          responded = true;
          try { fs.unlinkSync(tmp); } catch (_) {}
          sendJson(res, status, { error: msg });
        };
        child.stderr.on("data", (d) => (err += d.toString()));
        child.on("error", (ee) => replyErr(500, "piper: " + ee.message));
        child.on("close", (code) => {
          if (responded) return;
          if (code !== 0) return replyErr(500, err.trim().slice(0, 300) || ("piper exit " + code));
          fs.readFile(tmp, (re, buf) => {
            fs.unlink(tmp, () => {});
            if (responded) return;
            if (re || !buf || !buf.length) return replyErr(500, "tts produced no audio");
            responded = true;
            res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": buf.length });
            res.end(buf);
          });
        });
        try { child.stdin.write(text); child.stdin.end(); } catch (_) {}
      });
    }

    if (req.method === "POST" && urlPath === "/api/stt") {
      return readBody(req, 12 * 1024 * 1024, (e, body) => {
        if (e || !body || !body.length) return sendJson(res, 400, { error: "No audio" });
        transcribe(body, req.headers["content-type"] || "", (terr, text) => {
          if (terr) return sendJson(res, 500, { error: terr.message });
          sendJson(res, 200, { text });
        });
      });
    }

    if (req.method === "POST" && urlPath === "/api/push/subscribe") {
      return readBody(req, 64 * 1024, (e, body) => {
        let data = {}; try { data = JSON.parse((body || "").toString("utf8") || "{}"); } catch (_) {}
        const ep = data.subscription && data.subscription.endpoint;
        if (typeof ep !== "string" || !/^https:\/\//i.test(ep)) return sendJson(res, 400, { error: "Bad subscription" });
        const idx = pushSubs.findIndex((s) => s.sub.endpoint === ep);
        const entry = { sub: data.subscription, sessionId: data.sessionId || null };
        if (idx >= 0) pushSubs[idx] = entry; else pushSubs.push(entry);
        while (pushSubs.length > 500) pushSubs.shift();
        return sendJson(res, 200, { ok: true });
      });
    }

    if (req.method === "POST" && urlPath === "/api/reset") {
      return readBody(req, 64 * 1024, (e, body) => {
        let data = {}; try { data = JSON.parse((body || "").toString("utf8") || "{}"); } catch (_) {}
        const session = resolveSession(data.sessionId);
        if (session) { session.started = false; session.history = []; }
        return sendJson(res, 200, { ok: true });
      });
    }

    if (req.method === "POST" && urlPath === "/api/handoff") {
      return readBody(req, 16 * 1024, (e, body) => {
        let data = {}; try { data = JSON.parse((body || "").toString("utf8") || "{}"); } catch (_) {}
        const session = resolveSession(data.sessionId);
        if (!session) return sendJson(res, 404, { error: "Unknown session" });
        if (data.direction === "phone") {
          session.handoff = null;
          saveSessions();
          return sendJson(res, 200, { ok: true, direction: "phone" });
        }
        const id = session.claudeSessionId || null;
        killLive(session.id);
        session.handoff = "pc";
        saveSessions();
        return sendJson(res, 200, {
          ok: true, direction: "pc", claudeSessionId: id, projectDir: session.projectDir,
          resumeCmd: id ? ("claude --resume " + id) : null,
          note: id ? null : "This session hasn't run a turn yet; there's no Claude session to hand off.",
        });
      });
    }

    if (req.method === "GET" && urlPath === "/api/tmux-attach") {
      const q = new URL(req.url, "http://x").searchParams;
      const session = resolveSession(q.get("sessionId"));
      if (!session) return sendJson(res, 404, { error: "Unknown session" });
      if (session.runner !== "tmux") return sendJson(res, 400, { error: "This session isn't in full (tmux) session mode." });
      const name = tmuxName(session.id);
      return tmuxHas(name).then(async (running) => {
        let rcActive = false;
        if (running) { try { rcActive = /\/rc active/.test(await tmuxCapture(name)); } catch (_) {} }
        sendJson(res, 200, {
          name, running, rcActive,
          attachCmd: "tmux attach -t " + name,
          remoteControlSteps: [
            "In Mac terminal: tmux attach -t " + name,
            "In the opened claude session: /remote-control",
            "Connect to this session in the Claude mobile app",
          ],
        });
      });
    }

    if (req.method === "POST" && urlPath === "/api/tmux-rc") {
      return readBody(req, 4 * 1024, async (e, body) => {
        let data = {}; try { data = JSON.parse((body || "").toString("utf8") || "{}"); } catch (_) {}
        const session = resolveSession(data.sessionId);
        if (!session) return sendJson(res, 404, { error: "Unknown session" });
        if (session.runner !== "tmux") return sendJson(res, 400, { error: "This session isn't a full (tmux) session." });
        const name = tmuxName(session.id);
        if (!(await tmuxHas(name))) return sendJson(res, 400, { error: "The tmux session isn't running." });
        const stop = data.action === "stop";
        await tmuxRun(["send-keys", "-t", name, "-l", "/remote-control"]);
        await sleepMs(150);
        await tmuxRun(["send-keys", "-t", name, "Enter"]);
        if (!stop) return sendJson(res, 200, { ok: true, action: "start" });
        await sleepMs(2600);
        const lines = (await tmuxCapture(name)).split("\n");
        const disc = lines.findIndex((l) => /Disconnect this session/i.test(l));
        let sel = -1;
        for (let i = lines.length - 1; i >= 0; i--) { if (/^\s*❯\s+\S/.test(lines[i])) { sel = i; break; } }
        if (disc >= 0 && sel > disc) {
          for (let i = 0; i < sel - disc; i++) { await tmuxRun(["send-keys", "-t", name, "Up"]); await sleepMs(120); }
          await tmuxRun(["send-keys", "-t", name, "Enter"]);
          return sendJson(res, 200, { ok: true, action: "stop" });
        }
        await tmuxRun(["send-keys", "-t", name, "Escape"]);
        return sendJson(res, 200, { ok: false, action: "stop", note: "Disconnect menu not found; you can close it with /remote-control on your Mac." });
      });
    }

    if (req.method === "POST" && urlPath === "/api/tmux-send") {
      return readBody(req, 64 * 1024, (e, body) => {
        if (e) return sendJson(res, 400, { error: "Bad request" });
        let data = {}; try { data = JSON.parse((body || "").toString("utf8") || "{}"); } catch (_) {}
        const session = resolveSession(data.sessionId);
        if (!session) return sendJson(res, 404, { error: "Unknown session" });
        if (session.runner !== "tmux") return sendJson(res, 400, { error: "This session isn't a full (tmux) session." });
        const text = (typeof data.text === "string" ? data.text : "").replace(/\s*\n\s*/g, " ");
        (async () => {
          let name;
          try { name = await ensureTmuxAgent(session); }
          catch (err) { return sendJson(res, 500, { error: "tmux: " + err.message }); }
          if (text.length) { await tmuxRun(["send-keys", "-t", name, "-l", text]); await sleepMs(150); }
          await tmuxRun(["send-keys", "-t", name, "Enter"]);
          sendJson(res, 200, { ok: true });
          if (!session.claudeSessionId && text.trim().length >= 6) {
            setTimeout(() => {
              const jp = findJsonlByContent(session.projectDir, text.slice(0, 80));
              if (jp) { session.tmuxJsonl = jp; session.claudeSessionId = path.basename(jp).replace(/\.jsonl$/, ""); saveSessions(); }
            }, 2500);
          }
        })();
      });
    }

    if (req.method === "GET" && urlPath === "/api/session-history") {
      const q = new URL(req.url, "http://x").searchParams;
      const session = resolveSession(q.get("sessionId"));
      if (!session) return sendJson(res, 404, { error: "Unknown session" });
      const jsonl = resolveJsonlPath(session);
      if (!jsonl) return sendJson(res, 200, { turns: [], size: 0 });
      return sendJson(res, 200, readTranscriptTurns(jsonl));
    }

    if (req.method === "GET" && urlPath === "/api/session-watch") {
      const q = new URL(req.url, "http://x").searchParams;
      const session = resolveSession(q.get("sessionId"));
      if (!session) return sendJson(res, 404, { error: "Unknown session" });
      const jsonl = resolveJsonlPath(session);
      if (!jsonl) return sendJson(res, 404, { error: "No transcript for this session." });
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no",
      });
      try { res.socket && res.socket.setNoDelay(true); } catch (_) {}
      let offset = Number(q.get("since"));
      if (!Number.isFinite(offset) || offset < 0) { try { offset = fs.statSync(jsonl).size; } catch (_) { offset = 0; } }
      let carry = "", closed = false;
      const write = (obj) => { try { res.write(JSON.stringify(obj) + "\n"); } catch (_) {} };
      write({ type: "ready", offset });
      const tick = () => {
        if (closed) return;
        let size; try { size = fs.statSync(jsonl).size; } catch (_) { return; }
        if (size < offset) { offset = 0; carry = ""; }
        if (size <= offset) return;
        let chunk = "";
        let fd;
        try {
          fd = fs.openSync(jsonl, "r");
          const buf = Buffer.alloc(size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          chunk = buf.toString("utf8");
        } catch (_) {
          return;
        } finally {
          if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
        }
        offset = size; carry += chunk;
        let nl;
        while ((nl = carry.indexOf("\n")) >= 0) {
          const line = carry.slice(0, nl); carry = carry.slice(nl + 1);
          const t = turnFromTranscriptLine(line);
          if (t) write({ type: "turn", role: t.role, text: t.text, offset });
        }
      };
      const timer = setInterval(tick, 1000);
      const beat = setInterval(() => write({ type: "ping", offset }), 20000);
      const stop = () => { if (closed) return; closed = true; clearInterval(timer); clearInterval(beat); try { res.end(); } catch (_) {} };
      req.on("close", stop); res.on("close", stop); res.on("error", stop);
      return;
    }

    if (req.method === "GET" && urlPath === "/api/ollama/models") {
      let url;
      try { url = new URL("/api/tags", ollamaUrl()); } catch (_) { return sendJson(res, 200, { models: [] }); }
      const lib = url.protocol === "https:" ? require("https") : require("http");
      const r2 = lib.get(url, (up) => {
        let data = "";
        up.on("data", (d) => (data += d));
        up.on("end", () => {
          let models = [];
          try { models = (JSON.parse(data).models || []).map((m) => m.name).filter(Boolean); } catch (_) {}
          sendJson(res, 200, { models });
        });
      });
      r2.on("error", () => sendJson(res, 200, { models: [] }));
      return;
    }

    return sendJson(res, 404, { error: "Not found" });
  }

  if (req.method === "GET") return serveStatic(req, res);
  send(res, 405, "Method not allowed");
}

module.exports = { handleRequest };
