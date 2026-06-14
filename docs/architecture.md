# Architecture

voicebridge is a small Node bridge plus a single-page web UI. The agent model
runs in its vendor's cloud (via the agent's own CLI); voicebridge only carries
**voice and text** between your phone and that CLI, and removes the paid voice
middleman.

## Components

| Component | Where | Responsibility |
|-----------|-------|----------------|
| Web UI (`public/index.html`) | phone browser | Speech-to-text & text-to-speech (Web Speech API), text composer, chat rendering, session switching, mode selection. |
| Bridge (`server.js`) | your computer | Zero-config HTTP server: serves the UI, exposes `/api/*`, spawns the agent CLI per turn and streams its output back. |
| Agent CLI | your computer | `claude`, `codex`, or `agy` — does the actual work in a project directory. |
| Tailscale | both | Private network + automatic HTTPS so the phone can reach the bridge securely. |

## Request flow

```
[ phone browser ]                                  [ your computer ]
  mic ─Web Speech STT─▶ text ─┐
  composer ───── typed text ──┤
                              ▼  POST /api/ask  (https via Tailscale)
                         [ bridge ] ── spawn ──▶ claude / codex / agy
                              │   stream-json / stdout
   speaker ◀─ speechSynthesis ◀── NDJSON {type:"delta"|"done"|"error"}
```

1. The phone turns speech into text (or you type it) and `POST`s it to
   `/api/ask` with the target `sessionId` (and optional `mode`).
2. The bridge looks up the session, builds the agent's argv from its **adapter**
   (plus the session's **mode** flags), and `spawn`s the CLI in the session's
   project directory.
3. The CLI's streamed output is normalized to newline-delimited JSON events —
   `{type:"delta",text}`, then `{type:"done"}` (or `{type:"error"}`) — and
   written back over the open response.
4. The browser appends each delta to the chat bubble and feeds finished
   sentences to `speechSynthesis`, so the reply is spoken as it arrives.

If the client disconnects (the **Stop** button aborts the `fetch`), the bridge
kills the spawned child via the response `close` handler.

## Agent adapters

Each agent is one entry in the `AGENTS` map in `server.js`:

```js
claude: {
  label: "Claude Code",
  bin: () => process.env.CLAUDE_BIN || "claude",
  supportsContinue: true,        // can resume a rolling conversation
  stream: "ndjson",              // "ndjson" (parse) or "text" (pass through)
  defaultMode: "ask",
  modes: { ask: {…}, autoEdit: {…}, full: {…} },
  command(prompt, { cont, modeArgs }) { return { argv, stdin }; },
  parseLine(line) { /* ndjson only: return text or null */ },
}
```

- **`command`** returns the argv and an optional `stdin` string. Claude takes the
  prompt as a positional arg after `-p`; Codex (`codex exec`) and Antigravity
  (`agy --print`) take it on **stdin** (injection-safe, no `/proc/cmdline` leak).
- **`stream`** selects how output is read: Claude emits `--output-format
  stream-json` (NDJSON, parsed by `parseLine`); the others stream plain text
  straight through.
- **`modes`** map an autonomy level to extra CLI flags — see
  [configuration.md](configuration.md#modes).

Adding an agent is a single new entry; see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Sessions

The bridge keeps an in-memory **session registry**. A session is
`{ id, name, agent, projectDir, mode, started }`. Sessions are independent: each
has its own agent, working directory, autonomy mode, and conversation
continuity. The UI keeps a separate transcript per session and a switcher.

State is in-memory only — restarting the bridge clears sessions (the default
session is recreated on boot).

## API

| Method & path | Purpose |
|---------------|---------|
| `GET /api/health` | Public. `{ ok, version, uptime, sessions }` for liveness/uptime checks. |
| `GET /api/config` | Public. STT mode, whether auth is required, the agent list (with modes), the default project dir and session id. |
| `GET /api/browse` | List subdirectories of a path (folder picker). `runner=cloud` proxies to the cloud runner's `GET /browse` for remote dirs. |
| `GET /api/commands` | A session project's commands (`.claude/commands` + npm scripts) for the palette. |
| `GET /api/sessions` | List sessions. |
| `POST /api/sessions` | Create a session `{ name, agent, projectDir, mode }`. |
| `DELETE /api/sessions/:id` | Remove a session (not the default). |
| `POST /api/ask` | Stream a turn `{ text, sessionId, mode?, reset? }` → NDJSON. |
| `POST /api/reset` | Forget a session's conversation `{ sessionId }`. |
| `POST /api/stt` | Whisper mode only: transcribe uploaded audio. |

All `/api/*` routes except `/api/config` require the access token when
`ACCESS_TOKEN` is set.
