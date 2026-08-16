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
| `AGENT` | `claude` | Default agent for the boot session: `claude`, `codex`, `antigravity`, `ollama`, `aider`, or `gemini`. |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code executable. |
| `CODEX_BIN` | `codex` | Path to the Codex executable. |
| `AGY_BIN` | `agy` | Path to the Antigravity executable. |
| `OLLAMA_BIN` | `ollama` | Path to the Ollama executable. |
| `OLLAMA_MODEL` | `llama3.2` | Default model for `ollama` sessions (must be pulled, e.g. `ollama pull llama3.2`). |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama HTTP API base. Ollama sessions stream via `/api/chat` and keep per-session history (continuity); models are listed from `/api/tags`. |
| `AIDER_BIN` | `aider` | Path to the Aider CLI executable. |
| `AIDER_ARGS` | _(none)_ | Custom base arguments passed to Aider. |
| `GEMINI_BIN` | `gemini` | Path to the Google Gemini CLI executable. |
| `GEMINI_ARGS` | _(none)_ | Custom base arguments passed to Gemini CLI. |
| `GEMINI_CONTINUE_ARGS` | _(none)_ | Custom continue/resume arguments for Gemini CLI. |
| `GEMINI_PROMPT_ARG` | _(unset)_ | If set (e.g. `1`), pass the prompt to Gemini as a positional argument instead of stdin. |
| `CODEX_CONTINUE_ARGS` | _(none)_ | Optional Codex resume override. By default continued Codex turns use `codex exec resume <id> -` when a session id is known, or `codex exec resume --last -` otherwise. |
| `AGY_CONTINUE_ARGS` | _(none)_ | Optional Antigravity resume override. By default continued turns use `--conversation <id>` when a conversation id is known, or `--continue` otherwise. |
| `AGY_ARGS` | `--print` | Override Antigravity's base args if your `agy` build differs. |
| `AGY_PROMPT_ARG` | _(unset)_ | If set (e.g. `1`), pass the prompt as a positional argument instead of stdin. Try this if `agy` returns an empty reply. |
| `MAX_INFLIGHT` | `8` | Maximum concurrent active turns across all sessions. |
| `PERSISTENT_SESSIONS` | `0` | If set (`1`), maintains persistent live child processes for interactive sessions. |
| `LIVE_IDLE_MS` | `300000` | Inactivity idle timeout (in ms) before reaping a persistent live child process (default: 5 min). |
| `TMUX_IDLE_MS` | `3600000` | Inactivity idle timeout (in ms) before cleaning up an idle tmux workspace (default: 1 hr). |
| `ACCESS_TOKEN` | _(none)_ | If set, protected `/api/*` and `/ws` routes require `Authorization: Bearer <token>` or `?token=<token>`. `/api/health`, `/api/push/key`, and the public bootstrap subset of `/api/config` remain public. |
| `STT_MODE` | `browser` | `browser` (Web Speech), `whisper` (local batch), or `whisper-stream` (local streaming over WebSocket). |
| `STT_CMD` | _(none)_ | Whisper mode only: shell command; `{file}` is replaced with the recorded audio path; it must print the transcript to stdout. |
| `STT_STREAM_URL` | _(none)_ | Whisper-stream mode only: local WebSocket transcriber URL. The bridge proxies browser mic chunks to this URL and relays JSON transcript messages back to the client. |
| `STT_STREAM_CMD` | _(none)_ | Whisper-stream mode only: local streaming subprocess command (e.g. `whisper-stream -m ~/models/ggml-base.bin`). |
| `PIPER_BIN` | `piper` | Optional path to Piper neural TTS executable for `/api/tts`. |
| `PIPER_VOICE` | _(none)_ | Voice model name or onnx model path for Piper TTS. |
| `PIPER_DATA_DIR` | `~/.local/share/piper-voices` | Directory where Piper onnx voice models are stored. |
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
3. Start the bridge and enable **Notify** in the UI — the browser subscribes
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
| `aider` | `aider --message <prompt>` | positional arg | plain text | yes (`--restore-chat-history`) |
| `gemini` | `gemini --print` | stdin (or arg if `GEMINI_PROMPT_ARG=1`) | plain text | yes (`--continue` / `--conversation`) |

The **Ollama** backend is fully local — the model runs on your machine, so
nothing (not even the prompt) leaves it. Install [Ollama](https://ollama.com),
`ollama pull llama3.2`, and pick the **Ollama (local)** agent.

The Claude backend is fully implemented and tested. Codex, Antigravity, Aider, and
Gemini CLI use CLI resume flags and keep session continuity across
bridge restarts when the CLI exposes enough state.

## Modes

A session's **mode** sets how much autonomy the agent has by adding flags to its
invocation. Pick a fuller-auto mode for hands-free use; the agent then edits and
runs commands without asking.

| Agent | Mode | Flags | Behavior |
|-------|------|-------|----------|
| Claude | `ask` (default) | — | Normal interactive permissions. |
| Claude | `autoEdit` | `--permission-mode acceptEdits` | Auto-accepts file edits. |
| Claude | `full` | `--dangerously-skip-permissions` | Skips all permission prompts. |
| Codex | `safe` | `-s read-only` | Read-only sandbox. |
| Codex | `auto` (default) | `-s workspace-write -c approval_policy="never"` | Workspace-write, no approvals. |
| Codex | `full` | `--dangerously-bypass-approvals-and-sandbox` | No sandbox, no approvals. |
| Antigravity | `safe` (default) | `--sandbox` | Sandboxed. |
| Antigravity | `full` | `--dangerously-skip-permissions` | No restrictions. |
| Ollama | `default` | — | Local LLM inference. |
| Aider | `code` (default) | `—` | Standard code editing (`--chat-mode code`). |
| Aider | `architect` | `--chat-mode architect` | Architect / editor two-step mode. |
| Aider | `ask` | `--chat-mode ask` | Read-only questions without edits. |
| Aider | `auto` | `--auto-commits --chat-mode code` | Auto-commits edits after changes. |
| Gemini | `default` (default) | — | Standard prompt execution. |
| Gemini | `yolo` | `--yolo` | Auto-approves tool actions. |
| Gemini | `sandbox` | `--sandbox` | Safe sandboxed execution. |

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

The streaming endpoint accepts browser `MediaRecorder` audio chunks in 250ms timeslices at
`/api/stt-stream`, forwards them to `STT_STREAM_URL` or `STT_STREAM_CMD`, and relays transcript JSON
back to the page.
