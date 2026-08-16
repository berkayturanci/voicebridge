# Architecture

voicebridge is a zero-dependency Node bridge plus a single-page web UI. The agent
model runs in its vendor's cloud (or locally via Ollama); voicebridge carries
**voice, text, tool approvals, and live state** between your devices and those CLIs,
removing the paid voice middleman.

## Components & Codebase Structure

The server is decomposed into clean, modular components under `src/`:

```
src/
├── config.js               # Environment variables, constants, dot-env parser, security tokens
├── index.js                # Server factory (buildServer) and clean module exports
├── adapters/               # Agent CLI adapters & argument builders
│   ├── index.js            # AGENTS registry (Claude, Codex, Antigravity, Ollama, Aider, Gemini)
│   ├── claude.js           # Claude Code stream-json adapter & parser
│   ├── codex.js            # OpenAI Codex CLI adapter & continuity
│   ├── antigravity.js      # Google Antigravity CLI adapter & continuity
│   ├── ollama.js           # Ollama local HTTP inference adapter
│   ├── aider.js            # Aider CLI adapter (code, architect, ask, auto)
│   └── gemini.js           # Google Gemini CLI adapter (default, yolo, sandbox)
├── runners/                # Agent execution runners
│   ├── index.js            # Runner dispatcher and streamAsk coordinator
│   ├── local.js            # Direct subprocess spawn runner
│   ├── cloud.js            # Remote cloud runner proxy
│   ├── tmux.js             # Detached tmux session runner with ANSI stripping
│   ├── live.js             # Interactive persistent live subprocess runner
│   └── ollama.js           # Local HTTP streaming runner
├── services/               # Core business logic services
│   ├── sessions.js         # In-memory session registry and persistence
│   ├── approvals.js        # Interactive tool approval lifecycle (create, resolve, clear)
│   ├── hub.js              # Full-duplex WebSocket live sync pub/sub hub (/ws)
│   ├── git.js              # Git status & unified diff generator with path sanitization
│   ├── stt.js              # Whisper batch STT and real-time streaming proxy (/api/stt-stream)
│   ├── commands.js         # Project npm scripts & slash command discovery
│   └── push.js             # Web Push notifications
└── routes/                 # HTTP & WebSocket route handlers
    ├── api.js              # REST API endpoint dispatcher
    ├── static.js           # Safe static asset server (public/)
    └── http-helpers.js     # Body parsers, security headers, timing-safe auth checks
```

## Request Flow & Real-Time Sync

```
[ Phone / Tablet / Browser ]                           [ Your Computer ]
  mic ─Web Speech or Whisper STT─▶ text ─┐
  composer ───── typed text ─────────────┤
                                         ▼  POST /api/ask  (HTTPS via Tailscale)
                                   [ Bridge (src/) ] ── spawn ──▶ claude / aider / gemini / codex / agy
                                         │       │  stream-json / stdout
    speaker ◀─ speechSynthesis ◀─────────┤       ▼
    chat UI ◀─ WebSocket /ws (live sync) ┴─▶ {type:"delta"|"activity"|"approval_request"|"done"}
```

1. **Prompt Entry**: The phone turns speech into text (via Web Speech API or streaming whisper.cpp) and `POST`s it to `/api/ask` or streams it over WebSocket `/ws`.
2. **Execution**: The bridge builds the agent's argv from its **adapter** and invokes the runner (local subprocess, tmux, or persistent live).
3. **Real-Time Streaming**: Streamed deltas, tool activities, and approval requests are broadcast simultaneously over the HTTP SSE/NDJSON stream and all connected `/ws` clients.
4. **Speech & UI Updates**: The browser renders the markdown bubbles, while sentence-by-sentence text is spoken aloud via `speechSynthesis`.
5. **Tool Approvals**: In interactive modes, approval cards appear with Approve / Reject buttons. Resolving an approval updates all connected devices via `hub.broadcastAll()`.

## Real-Time WebSocket Hub (`/ws`)

The WebSocket Session Hub (`src/services/hub.js`) provides full-duplex live state synchronization:

- **Authentication**: Verified via `Authorization: Bearer <token>` header or `?token=<token>` query param using constant-time timing-safe comparisons.
- **Subscriptions**: Clients send `{ type: "subscribe", sessionId }` and `{ type: "unsubscribe", sessionId }` to listen to specific session events.
- **Event Protocol**:
  - `turn_start`: `{ type: "turn_start", sessionId, prompt }`
  - `delta`: `{ type: "delta", sessionId, text }`
  - `activity`: `{ type: "activity", sessionId, tool, text }`
  - `done`: `{ type: "done", sessionId }`
  - `error`: `{ type: "error", sessionId, error }`
  - `approval_request`: `{ type: "approval_request", id, sessionId, tool, command, details, description }`
  - `approval_resolved`: `{ type: "approval_resolved", id, approved, approval }`
  - `session_created` / `session_updated` / `session_deleted`: Lifecycle events broadcast across all clients.
- **Heartbeat**: 25s ping-pong keepalive prevents cellular NAT timeouts.

## Streaming Speech-to-Text (`/api/stt-stream`)

When `STT_MODE=whisper-stream` is enabled, the browser captures audio in 250ms chunks and streams binary frames over `/api/stt-stream`. The bridge proxies audio to a local `whisper.cpp` server (`STT_STREAM_URL`) or streaming subprocess (`STT_STREAM_CMD`), returning progressive transcript deltas back to the client.

## Shutdown & Lifecycle Behavior

- The bridge handles `SIGINT` and `SIGTERM` gracefully and idempotently.
- Closes the HTTP listener, terminates active WebSocket connections, and sends `SIGTERM` to all running live children.
- tmux workspaces (`tmux attach -t vb_<session>`) persist across bridge restarts for interactive terminal inspection.

## API Reference

| Method & path | Purpose |
|---------------|---------|
| `GET /api/health` | Public. `{ ok, version, uptime, sessions }` for liveness/uptime checks. |
| `GET /api/config` | Public bootstrap: STT mode, auth required, agent list with modes, runner types. |
| `GET /api/browse` | List subdirectories of a path (folder picker). |
| `GET /api/commands` | Session project's commands (`.claude/commands` + npm scripts). |
| `GET /api/sessions` | List sessions. |
| `POST /api/sessions` | Create a new session. |
| `POST /api/sessions/:id` | Update session metadata (rename, change mode, toggle voice). |
| `DELETE /api/sessions/:id` | Delete a session (except default). |
| `POST /api/ask` | Stream a turn `{ text, sessionId, mode?, reset? }` → NDJSON. |
| `POST /api/reset` | Reset a session's conversation history. |
| `GET /api/approvals` | Get pending tool approval requests for a session. |
| `POST /api/approvals/:id` | Settle an approval request `{ approved: true/false }`. |
| `GET /api/git/status` | Get modified, added, and untracked files in the session repo. |
| `GET /api/git/diff` | Get unified git diff for a specific file in the session repo. |
| `POST /api/stt` | Whisper batch STT: transcribe uploaded audio blob. |
| `POST /api/tts` | Generate WAV audio via Piper neural TTS. |
| `GET /api/claude-sessions` | List existing Claude session files in project directory. |
| `POST /api/handoff` | Coordinate mobile ↔ desktop session handoff. |
| `GET /api/tmux-attach` | Status and attach command for tmux session. |
| `POST /api/tmux-rc` | Start/stop `/remote-control` in tmux session. |
| `POST /api/tmux-send` | Send keys/commands directly to tmux session. |
| `GET /api/session-history` | Read transcript turns from session jsonl. |
| `GET /api/session-watch` | Real-time NDJSON stream of session transcript updates. |
| `GET /api/mobile-state` | Desktop host heartbeat status. |
| `POST /api/mobile-seen` | Mobile client activity heartbeat. |
| `GET /api/ollama/models` | List models from the local Ollama instance. |
| `GET /api/push/key` | Get VAPID public key and push status. |
| `POST /api/push/subscribe`| Register Web Push subscription. |
| `WS /ws` | Full-duplex live session synchronization hub. |
| `WS /api/stt-stream` | Real-time streaming STT proxy. |
