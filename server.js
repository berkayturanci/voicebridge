#!/usr/bin/env node
/*
 * voicebridge — talk to Claude Code from a phone browser and hear it talk back.
 *
 * Speech recognition + synthesis run in the browser (Web Speech API) by default;
 * this server relays text to the Claude Code CLI and STREAMS the reply back so
 * the phone can speak it sentence-by-sentence as Claude generates it.
 *
 * Optional: fully-local speech-to-text via your own Whisper command (STT_MODE),
 * and a shared access token (ACCESS_TOKEN) so only you can drive it.
 *
 * Zero runtime dependencies — Node standard library only.
 *
 * Environment variables:
 *   PORT         TCP port to bind (default 8787)
 *   HOST         bind address (default 127.0.0.1 — expose with `tailscale serve`)
 *   PROJECT_DIR  working directory Claude Code runs in (default: process.cwd())
 *   CLAUDE_BIN   path to the claude executable (default: "claude")
 *   ACCESS_TOKEN if set, /api/* requires Authorization: Bearer <token>
 *   STT_MODE     "browser" (default) or "whisper"
 *   STT_CMD      shell command for whisper mode; "{file}" is replaced with the
 *                recorded audio path; it must print the transcript to stdout.
 *                e.g. 'ffmpeg -nostdin -i {file} -ar 16000 -ac 1 -f wav - 2>/dev/null
 *                      | whisper-cli -m ~/models/ggml-base.bin -nt -f - 2>/dev/null'
 */

"use strict";

const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = parseInt(process.env.PORT || "8787", 10);
const HOST = process.env.HOST || "127.0.0.1";
const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";
const STT_MODE = (process.env.STT_MODE || "browser").toLowerCase();
const STT_CMD = process.env.STT_CMD || "";
const PUBLIC_DIR = path.join(__dirname, "public");

// One rolling Claude Code conversation; first turn is fresh, later turns use
// --continue. `reset` starts over.
let conversationStarted = false;

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ "Cache-Control": "no-store" }, headers || {}));
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json" });
}

// Constant-time token check.
function authorized(req) {
  if (!ACCESS_TOKEN) return true;
  const h = req.headers["authorization"] || "";
  const got = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (got.length !== ACCESS_TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(ACCESS_TOKEN));
  } catch (_) {
    return false;
  }
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel === "/") rel = "/index.html";
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden");
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, "Not found");
    const ext = path.extname(filePath).toLowerCase();
    const type =
      ext === ".html" ? "text/html; charset=utf-8" :
      ext === ".js" ? "text/javascript; charset=utf-8" :
      ext === ".css" ? "text/css; charset=utf-8" :
      "application/octet-stream";
    send(res, 200, data, { "Content-Type": type });
  });
}

function readBody(req, limitBytes, cb) {
  let size = 0;
  const chunks = [];
  req.on("data", (c) => {
    size += c.length;
    if (size > limitBytes) { req.destroy(); }
    else chunks.push(c);
  });
  req.on("end", () => cb(null, Buffer.concat(chunks)));
  req.on("error", cb);
}

// ---- Streaming Claude Code turn (NDJSON out: {type:"delta"|"done"|"error"}) ----
function streamAsk(prompt, fresh, res) {
  const args = ["--output-format", "stream-json", "--verbose", "-p"];
  if (conversationStarted && !fresh) args.unshift("--continue");
  args.push(prompt);

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });

  const child = spawn(CLAUDE_BIN, args, { cwd: PROJECT_DIR, env: process.env });
  const emit = (obj) => { try { res.write(JSON.stringify(obj) + "\n"); } catch (_) {} };

  const timer = setTimeout(() => child.kill("SIGKILL"), 5 * 60 * 1000);
  let buf = "";
  let stderr = "";
  let gotText = false;

  const handleLine = (line) => {
    line = line.trim();
    if (!line) return;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { return; }
    // Each assistant message carries content blocks; speak the text ones.
    if (obj.type === "assistant" && obj.message && Array.isArray(obj.message.content)) {
      const text = obj.message.content
        .filter((b) => b && b.type === "text" && b.text)
        .map((b) => b.text).join("");
      if (text) { gotText = true; emit({ type: "delta", text }); }
    }
  };

  child.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      handleLine(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  });
  child.stderr.on("data", (d) => (stderr += d.toString()));

  child.on("error", (e) => {
    clearTimeout(timer);
    emit({ type: "error", error: e.code === "ENOENT"
      ? `Could not find '${CLAUDE_BIN}'. Install Claude Code and run /login.`
      : e.message });
    res.end();
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (buf.trim()) handleLine(buf);
    if (code !== 0 && !gotText) {
      emit({ type: "error", error: stderr.trim() || `Claude Code exited with code ${code}.` });
    } else {
      conversationStarted = true;
      emit({ type: "done" });
    }
    res.end();
  });

  res.on("close", () => { clearTimeout(timer); child.kill("SIGKILL"); });
}

// ---- Local Whisper transcription ----
function transcribe(audioBuf, contentType, cb) {
  if (STT_MODE !== "whisper" || !STT_CMD) {
    return cb(new Error("Server is not configured for whisper STT."));
  }
  const ext = /wav/.test(contentType) ? ".wav" : /mp4|m4a/.test(contentType) ? ".m4a" : ".webm";
  const tmp = path.join(os.tmpdir(), "vb-" + crypto.randomBytes(6).toString("hex") + ext);
  fs.writeFile(tmp, audioBuf, (werr) => {
    if (werr) return cb(werr);
    // STT_CMD is operator-provided and {file} is a server-generated safe path.
    const cmd = STT_CMD.replace(/\{file\}/g, tmp);
    const child = spawn("/bin/sh", ["-c", cmd], { env: process.env });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => { fs.unlink(tmp, () => {}); cb(e); });
    child.on("close", (code) => {
      fs.unlink(tmp, () => {});
      if (code !== 0 && !out.trim()) return cb(new Error(err.trim() || "whisper failed"));
      cb(null, out.trim());
    });
  });
}

const server = http.createServer((req, res) => {
  // Public: client configuration (no secrets).
  if (req.method === "GET" && req.url.split("?")[0] === "/api/config") {
    return sendJson(res, 200, { sttMode: STT_MODE, authRequired: !!ACCESS_TOKEN });
  }

  if (req.url.startsWith("/api/")) {
    if (!authorized(req)) return sendJson(res, 401, { error: "Unauthorized" });

    if (req.method === "POST" && req.url === "/api/ask") {
      return readBody(req, 64 * 1024, (e, body) => {
        if (e) return sendJson(res, 400, { error: "Bad request" });
        let data; try { data = JSON.parse(body.toString("utf8") || "{}"); }
        catch (_) { return sendJson(res, 400, { error: "Bad JSON" }); }
        const text = typeof data.text === "string" ? data.text.trim() : "";
        const fresh = !!data.reset;
        if (fresh) conversationStarted = false;
        if (!text) return sendJson(res, 400, { error: "Empty prompt" });
        streamAsk(text, fresh, res);
      });
    }

    if (req.method === "POST" && req.url === "/api/stt") {
      return readBody(req, 12 * 1024 * 1024, (e, body) => {
        if (e || !body || !body.length) return sendJson(res, 400, { error: "No audio" });
        transcribe(body, req.headers["content-type"] || "", (terr, text) => {
          if (terr) return sendJson(res, 500, { error: terr.message });
          sendJson(res, 200, { text });
        });
      });
    }

    if (req.method === "POST" && req.url === "/api/reset") {
      conversationStarted = false;
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: "Not found" });
  }

  if (req.method === "GET") return serveStatic(req, res);
  send(res, 405, "Method not allowed");
});

server.listen(PORT, HOST, () => {
  console.log(`voicebridge listening on http://${HOST}:${PORT}`);
  console.log(`Claude Code working directory: ${PROJECT_DIR}`);
  console.log(`STT mode: ${STT_MODE}${ACCESS_TOKEN ? "  (access token required)" : ""}`);
  console.log(`Expose it to your phone with:  tailscale serve --bg ${PORT}`);
});
