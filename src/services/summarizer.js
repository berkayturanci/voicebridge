"use strict";

// Provider-neutral "make this short enough to say out loud" client.
//
// SUMMARY_PROVIDER   auto (default) | anthropic | openai | ollama | off
//   auto: anthropic when ANTHROPIC_API_KEY is set, else openai when
//   SUMMARY_BASE_URL is set, else ollama when SUMMARY_OLLAMA_URL is set,
//   else off.
// SUMMARY_MODEL      model id (defaults: claude-haiku-5-5 / gpt-4o-mini / llama3.2)
// SUMMARY_TIMEOUT_MS per call (default 6000)
//
// Every call resolves to { text, ms, provider, model } or null. null means
// "use the raw reply": provider off, unreachable, slow, refused or empty.
// After a failure the provider is skipped for SUMMARY_COOLDOWN_MS (default
// 60000) so an unreachable model doesn't add a timeout to every turn.
//
// Uses the global fetch (Node >= 18) so the bridge stays dependency-free.

const DEFAULT_MODELS = {
  anthropic: "claude-haiku-5-5",
  openai: "gpt-4o-mini",
  ollama: "llama3.2",
};

let cooldownUntil = 0;
let lastError = "";

function num(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function resolveProvider(env = process.env) {
  const p = String(env.SUMMARY_PROVIDER || "auto").toLowerCase().trim();
  if (p === "off" || p === "none" || p === "0" || p === "false") return "off";
  if (p === "anthropic" || p === "openai" || p === "ollama") return p;
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  if (env.SUMMARY_BASE_URL) return "openai";
  if (env.SUMMARY_OLLAMA_URL) return "ollama";
  return "off";
}

function config(env = process.env) {
  const provider = resolveProvider(env);
  return {
    provider,
    model: (env.SUMMARY_MODEL && env.SUMMARY_MODEL.trim()) || DEFAULT_MODELS[provider] || "",
    timeoutMs: num(env.SUMMARY_TIMEOUT_MS, 6000),
    cooldownMs: num(env.SUMMARY_COOLDOWN_MS, 60000),
  };
}

function available(env = process.env) {
  return config(env).provider !== "off" && Date.now() >= cooldownUntil;
}

function stripUrl(u) { return String(u || "").replace(/\/+$/, ""); }

async function postJson(url, headers, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 6000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, headers),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic(cfg, system, user, maxTokens, env) {
  const base = stripUrl(env.SUMMARY_ANTHROPIC_URL || "https://api.anthropic.com");
  const data = await postJson(base + "/v1/messages", {
    "x-api-key": env.ANTHROPIC_API_KEY || "",
    "anthropic-version": "2023-06-01",
  }, {
    model: cfg.model,
    max_tokens: maxTokens,
    // A one-sentence summary needs no reasoning; keep latency minimal.
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    system,
    messages: [{ role: "user", content: user }],
  }, cfg.timeoutMs);
  if (data && data.stop_reason === "refusal") throw new Error("refused");
  const blocks = (data && Array.isArray(data.content)) ? data.content : [];
  return blocks.filter((b) => b && b.type === "text").map((b) => b.text).join("").trim();
}

async function callOpenAI(cfg, system, user, maxTokens, env) {
  const base = stripUrl(env.SUMMARY_BASE_URL || "https://api.openai.com/v1");
  const headers = {};
  if (env.SUMMARY_API_KEY) headers.Authorization = "Bearer " + env.SUMMARY_API_KEY;
  const data = await postJson(base + "/chat/completions", headers, {
    model: cfg.model,
    max_tokens: maxTokens,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  }, cfg.timeoutMs);
  const c = data && data.choices && data.choices[0];
  return String((c && c.message && c.message.content) || "").trim();
}

async function callOllama(cfg, system, user, maxTokens, env) {
  const base = stripUrl(env.SUMMARY_OLLAMA_URL || env.OLLAMA_URL || "http://127.0.0.1:11434");
  const data = await postJson(base + "/api/chat", {}, {
    model: cfg.model,
    stream: false,
    options: { num_predict: maxTokens },
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  }, cfg.timeoutMs);
  return String((data && data.message && data.message.content) || "").trim();
}

const CALLERS = { anthropic: callAnthropic, openai: callOpenAI, ollama: callOllama };

// Strip a model's habit of wrapping the sentence in quotes or markdown.
function tidy(text) {
  return String(text || "")
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "")
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// raw: return the model text untouched (for JSON output); otherwise tidy() it.
async function complete({ system, user, maxTokens = 160, env = process.env, logger = console, label = "summary", raw: keepRaw = false } = {}) {
  const cfg = config(env);
  if (cfg.provider === "off") return null;
  if (Date.now() < cooldownUntil) return null;
  const t0 = Date.now();
  try {
    const raw = await CALLERS[cfg.provider](cfg, system, user, maxTokens, env);
    const text = keepRaw ? String(raw || "").trim() : tidy(raw);
    const ms = Date.now() - t0;
    if (!text) throw new Error("empty response");
    logLine(env, logger, `[narrator] ${label} ok provider=${cfg.provider} model=${cfg.model} +${ms}ms`);
    return { text, ms, provider: cfg.provider, model: cfg.model };
  } catch (e) {
    const ms = Date.now() - t0;
    lastError = (e && e.name === "AbortError") ? "timeout" : String((e && e.message) || e);
    cooldownUntil = Date.now() + cfg.cooldownMs;
    logLine(env, logger, `[narrator] ${label} failed provider=${cfg.provider} +${ms}ms (${lastError}); reading raw replies for ${Math.round(cfg.cooldownMs / 1000)}s`);
    return null;
  }
}

function logLine(env, logger, line) {
  if (/^(0|false|off)$/i.test(String(env.NARRATOR_LOG || ""))) return;
  try { logger.log(line); } catch (_) {}
}

function status(env = process.env) {
  const cfg = config(env);
  return {
    provider: cfg.provider,
    model: cfg.model || null,
    available: cfg.provider !== "off" && Date.now() >= cooldownUntil,
    cooldownMs: Math.max(0, cooldownUntil - Date.now()),
    lastError: lastError || null,
  };
}

function _reset() { cooldownUntil = 0; lastError = ""; }

module.exports = { complete, available, config, resolveProvider, status, tidy, DEFAULT_MODELS, _reset };
