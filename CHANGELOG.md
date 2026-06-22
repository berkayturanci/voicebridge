# Changelog

All notable changes to voicebridge are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.5.0] - 2026-06-22

### Added
- **Talking mode — mute** 🎙️: a mic toggle (top-left of the talking screen)
  pauses listening without leaving the conversation; tap the orb or 🎙️ to resume.
- **Voice-reactive orb**: while listening, the orb grows and glows as your speech
  is picked up, with a gentle idle breathing when you're quiet.
- **Community health files** — Code of Conduct, Security policy, issue & pull
  request templates, CODEOWNERS, Dependabot, `.editorconfig`, and `CITATION.cff`.

### Changed
- **License: now [PolyForm Noncommercial 1.0.0](LICENSE)** (previously MIT) —
  free for personal, research, education, and nonprofit use; commercial use
  requires a separate license, and the copyright notice must be kept on copies.
- **CI now runs on GitHub-hosted `ubuntu-latest`** instead of a self-hosted runner.
- **Now fully in English** — the web UI, native app, and desktop control panel,
  plus the README hero and demo images, are all English (default language is
  English; Turkish stays selectable as a speech/voice option).

### Fixed
- **Replies now speak on iOS.** `speechSynthesis` is primed inside the first user
  gesture, so streamed replies are no longer silently blocked by Safari.
- **The mic no longer lingers "in use."** Speech recognizers are released
  (`abort()` + dropped) when idle, on mute/exit, when hands-free is turned off,
  and when the tab is backgrounded — so iOS stops showing the mic as active when
  nothing is listening.
- **Long text fits on mobile.** The new-session project-path field now wraps (it
  was cut off at the right edge), and the talking-mode transcript, activity/system
  lines, and folder-browser names break long URLs/paths instead of overflowing.

## [0.4.0] - 2026-06-14

The "native apps + desktop + richer chat" release.

### Added
- **Native mobile/desktop app (Flutter)** in [`app/`](app/) — iOS, Android, and
  macOS/Windows/Linux from one codebase. Native mic (`speech_to_text`) + TTS
  (`flutter_tts`) so voice works as an installed app (no iOS Safari-tab caveat).
  Session list, streaming chat, talking mode, **persisted history**, **command
  palette** (`/api/commands`), and a **folder browser** (`/api/browse`).
- **Desktop app (Electron)** in [`desktop/`](desktop/) — a Mac `.dmg` / Windows /
  Linux app that runs the bridge with a control panel (start/stop, port/host/
  token, open web UI, **live log + phone QR**) and a **live dashboard** of agents
  and active sessions, plus a tray icon. `electron-builder` bundles the bridge so
  the install is self-contained.
- **Login screen** (web + native) with real token validation against an authed
  endpoint, replacing the `prompt()` flow; re-prompts on a 401.
- **Richer replies** — full markdown (headings, bullet/numbered lists,
  blockquotes, http(s)-only links) and **diff coloring** for ` ```diff ` blocks.
- **Talking mode** — a tunable auto-send silence (0.6–2.5s) and **tap-to-interrupt**
  (barge-in) on the orb while it's speaking.
- Remote **folder browser** for cloud sessions (bridge proxies the runner's
  `GET /browse`).

## [0.3.0] - 2026-06-13

The "talk to it like a person, on your phone" release.

### Added
- **Talking mode** (📞) — a continuous, hands-free voice conversation: speak, it
  auto-sends on a pause, reads the reply aloud, then listens again, with a minimal
  *listening / thinking / speaking* voice screen.
- **Session list home** — the app opens to a list of conversations (mobile
  Claude-Code style) with agent/mode/runner badges and a last-message preview; tap
  to open, **←** to return.
- **Conversation history persists** across reloads (per session, client-side).
- **Command palette** (⌘) — the project's own `.claude/commands` slash commands
  (e.g. `/keel:ship`) and `package.json` npm scripts, searchable; selecting one
  prefills the composer (`GET /api/commands`).
- **Folder browser** — a 📁 tree picker for the project directory
  (`GET /api/browse`), including **remote** dirs for cloud sessions (the bridge
  proxies the runner's `GET /browse`).
- **Settings sheet** (⚙) gathers theme, **chat font size**, language, mode,
  hands-free, cues, voice-friendly, notifications, TTS voice/rate, and session
  actions — decluttering the header/footer so the chat area is bigger.
- **Collapsible output** — long code/output blocks (npm logs, etc.) collapse by
  default with a show-more toggle.
- **Ollama via HTTP API** — streams `/api/chat` with per-session **conversation
  continuity** and a model list (`OLLAMA_URL`, `GET /api/ollama/models`).
- **Cloud-runner parity** — proxied streams are parsed for the activity trail and
  push-on-question, matching local sessions.
- Per-agent **availability** is shown in the picker; empty replies give a
  contextual hint; the mic explains *why* when voice is unavailable (HTTPS / PWA).
- `Escape` closes any open overlay (or exits talking mode).

### Changed
- Antigravity invocation is configurable (`AGY_ARGS`, `AGY_PROMPT_ARG`) for
  builds whose `agy` differs.

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
