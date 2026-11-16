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
| `VOICE_MODE_DEFAULT` | `1` | Whether voice sessions (the **Brief voice** toggle) get the spoken answer style when the session has no explicit `voiceMode`. `0`/`false`/`off` disables it unless a session opts in. |
| `VOICE_STYLE_PROMPT` | _(built-in, see below)_ | The spoken-style instruction. Write `\n` for a newline in `.env`. |
| `VOICE_STYLE_PROMPT_FILE` | _(none)_ | Path to a text file holding the instruction. Wins over `VOICE_STYLE_PROMPT`; re-read when the file changes (no restart needed). Falls back to `VOICE_STYLE_PROMPT` / the default if unreadable. |
| `NARRATOR` | `1` | Spoken progress updates and final summaries for voice-mode sessions. `0` = Stage 1 behaviour only (filtered raw speech). |
| `NARRATOR_INTERVAL_MS` | `30000` | How often a running turn's new tool activity is summarized into one spoken sentence. `0` disables progress updates. |
| `NARRATOR_FINAL_SUMMARY` | `1` | Boil long final replies down to 1–2 spoken sentences. `0` = read the (filtered) reply. |
| `NARRATOR_FINAL_MIN_CHARS` | `280` | Speakable replies up to this length are read as they are (no model call). |
| `NARRATOR_LANG` | `en` | Language of the built-in spoken templates (`en`, `tr`): approval notices and "read the full answer" replies. Summaries follow the conversation's language. |
| `NARRATOR_APPROVAL_TEXT` | _(template)_ | Override the approval notice; `{session}` and `{action}` are filled in, e.g. `{session} onayını bekliyor: {action}.` |
| `NARRATOR_READ_FULL_PHRASES` | _(built-in)_ | `\|`-separated phrases that speak the last full reply instead of going to the agent. Default: "read the full answer", "full answer", "tam cevabı oku", "cevabın tamamını oku", … |
| `NARRATOR_LOG` | `1` | Log each summarizer call with its added latency (`[narrator] final ok provider=… +812ms`). `0` silences it. |
| `SUMMARY_PROVIDER` | `auto` | Summarizer model provider: `anthropic`, `openai` (any OpenAI-compatible endpoint), `ollama`, `off`, or `auto` (Anthropic if `ANTHROPIC_API_KEY` is set, else OpenAI-compatible if `SUMMARY_BASE_URL` is set, else Ollama if `SUMMARY_OLLAMA_URL` is set, else off). |
| `SUMMARY_MODEL` | per provider | `claude-haiku-5-5` (Anthropic), `gpt-4o-mini` (OpenAI-compatible), `llama3.2` (Ollama). |
| `ANTHROPIC_API_KEY` | _(none)_ | API key for the Anthropic summarizer. |
| `SUMMARY_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base URL (`…/chat/completions` is appended), e.g. LM Studio, vLLM, OpenRouter. |
| `SUMMARY_API_KEY` | _(none)_ | Bearer key for the OpenAI-compatible endpoint. |
| `SUMMARY_OLLAMA_URL` | `OLLAMA_URL` | Ollama base URL for summaries — can be another machine, e.g. `http://macbook-b.tailnet:11434`. |
| `SUMMARY_TIMEOUT_MS` | `6000` | Per-call timeout; on timeout the raw reply is read. |
| `SUMMARY_COOLDOWN_MS` | `60000` | After a failed call, skip the summarizer (read raw replies) for this long. |
| `VOICE_AGENT` | `0` | Turn on the voice agent (router) for voice-mode sessions. The web UI's **Voice agent** switch, or `"voiceAgent": true/false` on `POST /api/ask`, overrides it per request. Uses the summarizer model above. |

## Voice mode

Voice mode shapes the agent's answers for listening instead of reading.

**Per-session setting** — `voiceMode` on a session:

| Value | Effect |
|-------|--------|
| `null` (default) | Follow the session's `voice` flag (gated by `VOICE_MODE_DEFAULT`). |
| `true` | Always use the spoken style, even in a typed session. |
| `false` | Never use it, even in a voice session. |

Set it at creation (`POST /api/sessions { ..., "voiceMode": true }`), later
(`POST /api/sessions/:id { "voiceMode": false }`), or per turn on
`POST /api/ask`. Sessions report `voiceMode` and the effective
`voiceModeActive`; `/api/ask` responses carry `X-VB-Voice-Mode: 1|0`.

**Default instruction** (override with `VOICE_STYLE_PROMPT` or `VOICE_STYLE_PROMPT_FILE`):

> You are talking with the user over the phone: they are listening, not
> reading. Answer like a spoken conversation, in 1 to 4 short sentences. Do not
> read out code, file paths, links, or markdown. If the answer needs long
> detail, write it to a file and only say which file you wrote it to. Answer in
> the user's language.

Example `.env` in Turkish:

```
VOICE_STYLE_PROMPT="Telefonda konuşur gibi cevap ver. 1–4 kısa cümle. Kod, dosya yolu, link, markdown okuma. Uzun detay gerekiyorsa bir dosyaya yaz ve sadece 'detayı şu dosyaya yazdım' de. Kullanıcının dilinde cevap ver."
```

**How each agent receives it:**

| Agent / runner | Delivery |
|----------------|----------|
| Claude (local and persistent live) | `--append-system-prompt <instruction>`. A persistent live child is restarted (idle, same conversation) when the instruction or voice mode changes. |
| Ollama | A `system` message on `/api/chat` for that turn (not stored in history). |
| Codex, Gemini, Aider, Antigravity, tmux runner, cloud runner | Prepended to the prompt. |

Slash commands (`/compact`, `/help`, …) are never prefixed.

### Speech filter

Every `/api/ask` stream also carries `speech` events
(`{ "type": "speech", "text": "…" }`) next to the usual `delta` events: the
same reply cut at sentence boundaries with fenced code blocks, markdown
markers, table rules, HTML, URLs and long file paths (shortened to their file
name) removed. Code fences split across many deltas are never spoken. The
final `speech` tail is sent before `done`. Responses set `X-VB-Speech: 1` so
clients know to speak `speech` events and only render `delta` text — the chat
always shows the full reply. `POST /api/tts` (Piper) applies the same filter
unless the body has `"raw": true`.

## Narrator (progress updates and spoken summaries)

For voice-mode sessions the narrator decides what you hear while you aren't
looking at the screen. The chat always shows every `delta` unchanged.

- **Progress** — while a turn runs, every `NARRATOR_INTERVAL_MS` (30 s) the
  new tool activity (Claude's stream-json tool calls and failed tool results)
  is summarized by the summarizer model into one sentence, e.g. *"Running the
  tests; two files edited so far."* Nothing is said when nothing new happened,
  and progress is never spoken while your mic is open.
- **Final** — a long reply is replaced by a 1–2 sentence summary
  (`{type:"narration", kind:"final"}`). Replies shorter than
  `NARRATOR_FINAL_MIN_CHARS` are read as they are.
- **Approvals** — a pending tool approval is announced at once
  (`kind:"approval"`), e.g. *"api is waiting for your approval: git push."*
- **Read the full answer** — saying/typing "read the full answer" or "tam
  cevabı oku" speaks the session's last full reply (filtered) without sending
  anything to the agent. `GET /api/sessions/:id/last-reply` returns it as text.

**Fallback.** If no summarizer is configured, the model is unreachable,
times out, refuses, or returns nothing, the narrator silently reads the raw
(filtered) reply instead and skips the model for `SUMMARY_COOLDOWN_MS`.
Cloud-runner sessions always use raw speech.

**Latency.** Each summarizer call is logged with the time it added:

```
[narrator] progress ok provider=anthropic model=claude-haiku-5-5 +640ms
[narrator] final ok provider=ollama model=llama3.2 +1210ms
[narrator] final failed provider=ollama +6003ms (timeout); reading raw replies for 60s
```

`narration` events also carry `ms`. `GET /api/narrator` reports the current
settings, summarizer status (provider, model, cooldown, last error) and whether
the user is speaking.

**Not talking over you.** The web UI sends `{type:"listening", active}` on
`/ws` while the mic is open (or call `POST /api/listening {active}`); the flag
expires after 60 s. Progress updates are dropped while it is set, and final
summaries / approval notices wait until the mic closes.

## Voice agent (router)

With `VOICE_AGENT=1` (or the **Voice agent** switch in the web UI) a small
model sits between your voice and the sessions. For each utterance it returns a
plan of tool calls that the bridge executes:

| Tool | Does |
|------|------|
| `send_to_session(session, text)` | Runs a turn. The session you are on streams back as usual; any other session runs in the background (its events still reach `/ws`), and you hear "Sent to web." |
| `stop_session(session)` | Interrupts the running turn (closes it; persistent live children are killed and resume the conversation next turn; tmux gets Esc/Ctrl-C). The interrupted stream ends with `{type:"done", stopped:true}`. |
| `get_status(session)` | "api is working, for 2 minutes. Last step: Bash npm test." / "api is idle. Last answer: …" |
| `read_full_answer(session)` | Speaks that session's last full reply. |
| `list_sessions()` | "3 sessions: api, web, docs." |

- **One step for "stop, add this, then continue"** — the plan is
  `stop_session` + `send_to_session` with a combined instruction; the agent
  keeps its conversation, so it can pick up where it left off.
- **Sessions by name** — "run the tests in api" targets the session named
  (or whose project folder is) *api*. If the name is unknown or matches more
  than one session, it asks ("Which session? api, web.") instead of guessing.
  Without a name, the session you are on is the target.
- **Spoken confirmation** for risky instructions (commit, push, merge, rebase,
  delete/remove, `rm -`, `reset --hard`, force, deploy, publish, and Turkish
  equivalents such as *commitle, pushla, sil, kaldır, yayınla*) or when the
  model flags one: *"I'll send this to api: commit and push the fix. Do you
  confirm?"* Answer "yes / evet / onaylıyorum" or "no / hayır / iptal" (no
  model call). Anything else drops the pending action. Confirmations expire
  after 2 minutes.
- **Busy session** — sending to a session that is still working, without
  saying stop, asks: *"api is still working. Should I stop it and send: …?"*
- The web UI lets you talk while a turn runs: in Talk mode, tap the orb while
  it shows *Thinking…*.

The model only produces a JSON plan, so any summarizer provider works
(Anthropic, OpenAI-compatible, Ollama). **Off, or no usable plan** (no
summarizer, timeout, unparseable output): the utterance goes to the current
session unchanged — Stage 1–2 behaviour. Slash commands and "read the full
answer" bypass the router. Each routing decision is logged with its latency:
`[narrator] router ok provider=… +420ms` and `[voice-agent] plan=stop_session,send_to_session +455ms`.
The `/api/ask` stream starts with `{type:"router", actions:[…], confirmed}`.

**Summarizer examples**

```
# Anthropic (Haiku)
ANTHROPIC_API_KEY=sk-ant-...
# Local Ollama on another Mac on your tailnet
SUMMARY_PROVIDER=ollama
SUMMARY_OLLAMA_URL=http://macbook-b:11434
SUMMARY_MODEL=llama3.2
# Any OpenAI-compatible server
SUMMARY_PROVIDER=openai
SUMMARY_BASE_URL=http://127.0.0.1:1234/v1
SUMMARY_MODEL=qwen2.5-7b-instruct
```

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
