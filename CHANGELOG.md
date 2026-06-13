# Changelog

All notable changes to voicebridge are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [0.2.1] - 2026-06-13

### Fixed (security)
- A malformed percent-encoded request path (e.g. `GET /%E0%A4%A`) crashed the
  server (an unauthenticated denial of service). The static handler now returns
  `400`, and every request handler is wrapped so no synchronous error can take
  the process down.

### Hardened
- `POST /api/push/subscribe` rejects non-`https` endpoints (SSRF hardening).
- Security response headers on every response (`Content-Security-Policy`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`).
- A prominent startup warning when bound to a non-loopback address without
  `ACCESS_TOKEN`.
- Caps on sessions (`MAX_SESSIONS`, default 200) and stored push subscriptions
  to bound memory.
- A concurrency cap (`MAX_INFLIGHT`, default 8) on in-flight agent turns;
  `/api/ask` returns `429` past it, so a client can't exhaust the host.

## [0.2.0] - 2026-06-13

The "type or speak, any agent, anywhere" release.

### Added
- **Multiple agents** — Claude Code, Codex, and Antigravity backends via a
  pluggable adapter layer.
- **Multiple sessions** — run conversations in parallel, switch, rename, and
  delete them; each keeps its own agent, project directory, mode, and transcript.
- **Type or speak** — a Claude-Code-like chat with a text composer alongside the
  mic; replies render with code blocks and a copy button.
- **Autonomy modes** — per-session approval/sandbox levels (`ask` → full-auto)
  mapped to each agent's CLI flags.
- **Local or cloud runner** — sessions run the agent locally or proxy to a
  `CLOUD_RUNNER_URL`; a reference runner ships in `examples/cloud-runner/`.
- **Eyes-free extras** — audio cues (earcons), quick-command chips, voice-friendly
  concise replies, configurable TTS voice/rate, and an agent activity trail.
- **Notifications** — Web Notifications when a backgrounded turn finishes or the
  agent asks a question.
- **Installable PWA** — manifest, icon, and a service worker (app-shell cache +
  notification handling).
- **Startup QR code** — scan to open the phone URL, with optional `?token=` auth.
- **Stop control** — cancel an in-progress request and speech.
- **Themes & preferences** — light/dark/system theme and persisted preferences.
- **Favorites** — one-tap session start for frequent projects.
- **Optional session persistence** — restore sessions across restarts with
  `SESSIONS_FILE`.
- **Health endpoint** — `GET /api/health`.
- **Tests & CI** — a zero-dependency `node:test` suite and a CI workflow
  (self-hosted runner).
- **Docs** — architecture, configuration, and security guides.

### Notes
- The Claude backend is fully implemented and tested; Codex and Antigravity are
  best-effort (verify on a machine with those CLIs). Their resume is opt-in via
  `CODEX_CONTINUE_ARGS` / `AGY_CONTINUE_ARGS`.
- True OS push when the app is fully closed (Web Push + VAPID) is not yet
  implemented.

## [0.1.0]

- Initial voicebridge: browser Web Speech (STT/TTS) + a zero-dependency Node
  bridge that streams the Claude Code CLI's replies back to the phone.
