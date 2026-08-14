# Configuration

All configuration is via environment variables read at startup. None are
required — the defaults run a local, Claude-backed bridge on port 8787.

## Environment variables

| Env var | Default | Meaning |
|---------|---------|---------|
| `PORT` | `8787` | Port the bridge listens on. |
| `HOST` | `127.0.0.1` | Bind address. Keep it local and expose with `tailscale serve`. |
| `PUBLIC_URL` | _(none)_ | Public URL shown in the startup QR (e.g. your Tailscale `https://…ts.net`). Falls back to `http://HOST:PORT`. |
| `PROJECT_DIR` | current dir | Default working directory for new sessions. |
| `AGENT` | `claude` | Default agent for the boot session: `claude`, `codex`, or `antigravity`. |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code executable. |
| `CODEX_BIN` | `codex` | Path to the Codex executable. |
| `AGY_BIN` | `agy` | Path to the Antigravity executable. |
| `OLLAMA_BIN` | `ollama` | Path to the Ollama executable. |
| `OLLAMA_MODEL` | `llama3.2` | Default model for `ollama` sessions (must be pulled, e.g. `ollama pull llama3.2`). |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama HTTP API base. Ollama sessions stream via `/api/chat` and keep per-session history (continuity); models are listed from `/api/tags`. |
| `CODEX_CONTINUE_ARGS` | _(none)_ | Optional Codex resume override. By default continued Codex turns use `codex exec resume <id> -` when a session id is known, or `codex exec resume --last -` otherwise. |
| `AGY_CONTINUE_ARGS` | _(none)_ | Optional Antigravity resume override. By default continued turns use `--conversation <id>` when a conversation id is known, or `--continue` otherwise. |
| `AGY_ARGS` | `--print` | Override Antigravity's base args if your `agy` build differs. |
| `AGY_PROMPT_ARG` | _(unset)_ | If set (e.g. `1`), pass the prompt as a positional argument instead of stdin. Try this if `agy` returns an empty reply. |
| `ACCESS_TOKEN` | _(none)_ | If set, protected `/api/*` routes require `Authorization: Bearer <token>`. `/api/health`, `/api/push/key`, and the public bootstrap subset of `/api/config` remain public. |
| `STT_MODE` | `browser` | `browser` (Web Speech), `whisper` (local batch), or `whisper-stream` (local streaming over WebSocket). |
| `STT_CMD` | _(none)_ | Whisper mode only: shell command; `{file}` is replaced with the recorded audio path; it must print the transcript to stdout. |
| `STT_STREAM_URL` | _(none)_ | Whisper-stream mode only: local WebSocket transcriber URL. The bridge proxies browser mic chunks to this URL and relays JSON transcript messages back to the client. |
| `FAVORITES` | _(none)_ | JSON array of favorite projects to prefill the new-session dialog, e.g. `[{"name":"App","projectDir":"/Users/me/app","agent":"claude","mode":"full"}]`. Users can also save their own favorites locally. |
| `CLOUD_RUNNER_URL` | _(none)_ | If set, enables **cloud** sessions: turns are proxied here instead of spawning a local CLI. The endpoint must speak the same NDJSON protocol. |
| `CLOUD_RUNNER_TOKEN` | _(none)_ | Optional `Authorization: Bearer` token sent to the cloud runner. |
| `AGENT_TIMEOUT_MS` | `1200000` | Per-turn cap for local and persistent live agent turns. `0` disables the cap. A timed-out persistent live turn kills that live child and the next turn respawns it from the saved Claude session. |
| `TMUX_CAPTURE_LINES` | `1000` | Scrollback lines captured when extracting the final tmux runner reply. Raise this for unusually long interactive Claude replies. |
| `SESSIONS_FILE` | _(none)_ | If set, sessions (name/agent/dir/mode/voice/runner plus agent continuity state) are saved here and restored on restart, e.g. `~/.voicebridge/sessions.json`. Unset = in-memory only. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | _(none)_ | Enable real Web Push (OS notifications even when the app is closed). Generate with `node scripts/gen-vapid-keys.js` (needs the optional `web-push` dependency). |
| `VAPID_SUBJECT` | `mailto:voicebridge@localhost` | Contact URI sent with push (a `mailto:` or `https:`). |

## Web Push (notifications when the app is closed)

In-page notifications fire while the tab is open or backgrounded. For real OS
push when the app is fully closed:

1. Install the optional dependency: `npm install web-push`.
2. Generate keys: `node scripts/gen-vapid-keys.js` and set the printed
   `VAPID_*` env vars.
3. Start the bridge and enable **Bildirim** in the UI — the browser subscribes
   and the server pushes when a reply ends with a question.

Without VAPID keys (or `web-push`), the app silently falls back to in-page
notifications. Push currently triggers for **local** runner turns.

## Runners: local vs cloud

Each session has a **runner**:

- **local** (default) — the bridge spawns the agent CLI on this machine, in the
  session's project directory.
- **cloud** — available only when `CLOUD_RUNNER_URL` is set. The bridge POSTs
  `{ text, agent, mode, projectDir, sessionId, continue }` to that URL and
  streams the response straight back to the phone. The remote runner is expected
  to emit the same NDJSON events (`{type:"delta"|"done"|"error"}`); it runs the
  agent on its own host, so the project directory refers to the remote machine.

Pick the runner in the new-session dialog (the selector appears only when a cloud
runner is configured). A ready-to-run reference runner lives in
[`examples/cloud-runner/`](../examples/cloud-runner/).

## Agents

| Agent | CLI invocation | Prompt delivery | Output | Continuity |
|-------|----------------|-----------------|--------|------------|
| `claude` | `claude -p --output-format stream-json --verbose` | positional arg | NDJSON (parsed) | `--continue` (yes) |
| `codex` | `codex exec` / `codex exec resume` | stdin | plain text | yes (`resume <id>` or `resume --last`) |
| `antigravity` | `agy --print` | stdin | plain text | yes (`--conversation <id>` or `--continue`) |
| `ollama` | HTTP `/api/chat` (local) | JSON body | NDJSON | yes (per-session history) |

The **Ollama** backend is fully local — the model runs on your machine, so
nothing (not even the prompt) leaves it. Install [Ollama](https://ollama.com),
`ollama pull llama3.2`, and pick the **Ollama (yerel)** agent.

The Claude backend is fully implemented and tested. Codex and Antigravity use
the current non-interactive CLI resume flags and keep session continuity across
bridge restarts when the CLI exposes enough state. If the CLI does not print a
stable id, voicebridge falls back to that CLI's "most recent conversation"
resume behavior.

## Modes

A session's **mode** sets how much autonomy the agent has by adding flags to its
invocation. Pick a fuller-auto mode for hands-free use; the agent then edits and
runs commands without asking.

| Agent | Mode | Flags | Behavior |
|-------|------|-------|----------|
| Claude | `ask` (default) | — | Normal permissions. |
| Claude | `autoEdit` | `--permission-mode acceptEdits` | Auto-accepts edits. |
| Claude | `full` | `--dangerously-skip-permissions` | No prompts at all. |
| Codex | `safe` | `-s read-only` | Read-only sandbox. |
| Codex | `auto` (default) | `-s workspace-write -c approval_policy="never"` | Workspace-write, no approvals. |
| Codex | `full` | `--dangerously-bypass-approvals-and-sandbox` | No sandbox, no approvals. |
| Antigravity | `safe` (default) | `--sandbox` | Sandboxed. |
| Antigravity | `full` | `--dangerously-skip-permissions` | No restrictions. |

Modes are chosen in the new-session dialog and can be changed per session from
the footer selector (`/api/ask` carries the mode and switches it on the fly).

> ⚠️ See [security.md](security.md) before using full-auto modes.

## Examples

A read-only Codex session on a second project, behind a token, exposed publicly:

```bash
export ACCESS_TOKEN="$(openssl rand -hex 16)"
export PUBLIC_URL="https://mybox.tailnet.ts.net"
export AGENT=codex
export PROJECT_DIR="$HOME/code/service"
npm start
# scan the printed QR (it already carries ?token=…)
```

Fully-local speech-to-text with whisper.cpp:

```bash
export STT_MODE=whisper
export STT_CMD='ffmpeg -nostdin -i {file} -ar 16000 -ac 1 -f wav - 2>/dev/null | whisper-cli -m ~/models/ggml-base.bin -nt -f - 2>/dev/null'
npm start
```

Fully-local streaming speech-to-text via a local Whisper WebSocket transcriber:

```bash
export STT_MODE=whisper-stream
export STT_STREAM_URL='ws://127.0.0.1:8910/listen'
npm start
```

The streaming endpoint accepts browser `MediaRecorder` audio chunks at
`/api/stt-stream`, forwards them to `STT_STREAM_URL`, and relays transcript JSON
back to the page. Upstream messages may use `text`, `transcript`, or `partial`
for interim text and `type:"final"` / `type:"done"` / `isFinal:true` for final
text. Keep the transcriber bound to loopback and expose only voicebridge through
Tailscale + `ACCESS_TOKEN`.
