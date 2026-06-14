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
| `CODEX_CONTINUE_ARGS` | _(none)_ | Opt-in Codex resume: argv added on continued turns (e.g. `resume --last`). When set, Codex sessions keep context. Best-effort — verify your build's resume flag. |
| `AGY_CONTINUE_ARGS` | _(none)_ | Opt-in Antigravity resume: argv added on continued turns. Best-effort. |
| `AGY_ARGS` | `--print` | Override Antigravity's base args if your `agy` build differs. |
| `AGY_PROMPT_ARG` | _(unset)_ | If set (e.g. `1`), pass the prompt as a positional argument instead of stdin. Try this if `agy` returns an empty reply. |
| `ACCESS_TOKEN` | _(none)_ | If set, every `/api/*` route (except `/api/config`) requires `Authorization: Bearer <token>`. |
| `STT_MODE` | `browser` | `browser` (Web Speech) or `whisper` (local, server-side). |
| `STT_CMD` | _(none)_ | Whisper mode only: shell command; `{file}` is replaced with the recorded audio path; it must print the transcript to stdout. |
| `FAVORITES` | _(none)_ | JSON array of favorite projects to prefill the new-session dialog, e.g. `[{"name":"App","projectDir":"/Users/me/app","agent":"claude","mode":"full"}]`. Users can also save their own favorites locally. |
| `CLOUD_RUNNER_URL` | _(none)_ | If set, enables **cloud** sessions: turns are proxied here instead of spawning a local CLI. The endpoint must speak the same NDJSON protocol. |
| `CLOUD_RUNNER_TOKEN` | _(none)_ | Optional `Authorization: Bearer` token sent to the cloud runner. |
| `SESSIONS_FILE` | _(none)_ | If set, sessions (name/agent/dir/mode/voice/runner) are saved here and restored on restart, e.g. `~/.voicebridge/sessions.json`. Unset = in-memory only. |
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
| `codex` | `codex exec` | stdin | plain text | opt-in (`CODEX_CONTINUE_ARGS`) |
| `antigravity` | `agy --print` | stdin | plain text | opt-in (`AGY_CONTINUE_ARGS`) |
| `ollama` | HTTP `/api/chat` (local) | JSON body | NDJSON | yes (per-session history) |

The **Ollama** backend is fully local — the model runs on your machine, so
nothing (not even the prompt) leaves it. Install [Ollama](https://ollama.com),
`ollama pull llama3.2`, and pick the **Ollama (yerel)** agent.

The Claude backend is fully implemented and tested. The Codex and Antigravity
backends mirror the invocations used by
[ai-jury](https://github.com/berkayturanci/ai-jury); verify them on a machine
that has those CLIs installed.

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
| Codex | `auto` (default) | `--full-auto` | Workspace-write, no approvals. |
| Codex | `full` | `--dangerously-bypass-approvals-and-sandbox` | No sandbox, no approvals. |
| Antigravity | `safe` (default) | `--sandbox` | Sandboxed. |
| Antigravity | `full` | `--yolo` | No restrictions. |

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
