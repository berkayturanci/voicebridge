# voicebridge

**Hands-free, two-way voice for your coding agent from your phone — free, open-source, no ElevenLabs.**

You speak to your phone, a coding agent (running on your Mac/Linux box) does the
work, and the reply is read back aloud — like a phone call with your agent.

- 🤖 **Multiple agents** — Claude Code, **Codex**, and **Antigravity**, selectable
  per session.
- 🗂️ **Multiple sessions** — run several conversations in parallel (e.g. "Claude on
  repo A", "Codex on repo B") and switch between them in the UI.
- 🎙️ **Speech-to-text** and 🔊 **text-to-speech** run in your phone's **browser**
  (Web Speech API) — no per-minute cloud voice cost, no API keys.
- ⚡ **Streaming** — the reply is spoken **sentence-by-sentence as it's generated**,
  not after the whole turn finishes, with a **Stop** button to cut it off.
- 🧩 A **tiny zero-dependency Node bridge** relays the recognized text to the agent
  CLI on your machine and streams its reply back.
- 🔒 Reached over **Tailscale** (your private network) with real HTTPS, with an
  optional **shared access token** — your code never touches a third-party voice
  service.
- 🗣️ Optional **fully-local speech-to-text** via your own Whisper command
  (`STT_MODE=whisper`), so even the transcription stays on your machine.

> Honest scope: the agent **model** still runs in its vendor's cloud (that's how
> these CLIs work). voicebridge just removes the *voice* middleman (ElevenLabs)
> and its limits. Speech recognition on iOS uses Apple's free dictation service;
> text-to-speech is fully on-device.
>
> Agent support: the **Claude** backend is fully implemented and tested. The
> **Codex** (`codex exec`) and **Antigravity** (`agy --print`) backends use the
> same invocations as [ai-jury](https://github.com/berkayturanci/ai-jury) and
> stream their plain-text stdout; verify them on your own machine. Conversation
> continuity (`--continue`) is currently Claude-only — other agents treat each
> turn as fresh.

---

## Requirements

- A computer (macOS/Linux) with **Claude Code** installed and logged in
  (`npm i -g @anthropic-ai/claude-code`, then `claude` → `/login`).
- **Node.js ≥ 18** (`brew install node`).
- **Tailscale** on both the computer and the phone (`brew install --cask tailscale`,
  and the Tailscale app from the App Store). Free.
- iPhone/iPad: open in **Safari** (do **not** "Add to Home Screen" — installed PWAs
  can't use the microphone on iOS).

## Setup

### 1. On your computer

```bash
git clone <your-repo-url> voicebridge
cd voicebridge

# Point Claude Code at the project you want it to work on:
export PROJECT_DIR="$HOME/code/my-project"

# Start the bridge (binds to 127.0.0.1:8787 by default)
npm start
```

### 2. Expose it to your phone over HTTPS (Tailscale)

Web Speech needs a secure context. Tailscale gives your machine a real HTTPS
cert automatically:

```bash
tailscale serve --bg 8787
tailscale serve status     # shows the https://<your-machine>.<tailnet>.ts.net URL
```

### 3. On your phone

1. Make sure Tailscale is **connected** (same account).
2. Open the `https://<your-machine>.<tailnet>.ts.net` URL in **Safari**.
3. Tap the 🎤 button, allow the microphone, and **speak**.
4. Toggle **Eller serbest / Hands-free** for a continuous back-and-forth loop.

That's it — talk, and Claude Code talks back. 🎧

---

## Configuration

| Env var        | Default              | Meaning                                            |
|----------------|----------------------|----------------------------------------------------|
| `PORT`         | `8787`               | Port the bridge listens on                         |
| `HOST`         | `127.0.0.1`          | Bind address (keep local; expose via `tailscale serve`) |
| `PROJECT_DIR`  | current directory    | Default working directory for new sessions         |
| `AGENT`        | `claude`             | Default agent for the boot session (`claude`/`codex`/`antigravity`) |
| `CLAUDE_BIN`   | `claude`             | Path to the `claude` executable                    |
| `CODEX_BIN`    | `codex`              | Path to the `codex` executable                     |
| `AGY_BIN`      | `agy`                | Path to the Antigravity executable                 |
| `ACCESS_TOKEN` | _(none)_             | If set, `/api/*` requires `Authorization: Bearer <token>`. The page prompts for it once and stores it. |
| `STT_MODE`     | `browser`            | `browser` (Web Speech) or `whisper` (local, server-side) |
| `STT_CMD`      | _(none)_             | Whisper mode: shell command; `{file}` → recorded audio path; must print the transcript to stdout |

### Optional: a shared access token

```bash
export ACCESS_TOKEN="$(openssl rand -hex 16)"
echo "$ACCESS_TOKEN"   # type this into the phone once when prompted
npm start
```

### Optional: fully-local speech-to-text (Whisper)

Keeps transcription on your machine too (nothing goes to Apple). Needs `ffmpeg`
and a Whisper CLI (e.g. `whisper.cpp`'s `whisper-cli`):

```bash
export STT_MODE=whisper
export STT_CMD='ffmpeg -nostdin -i {file} -ar 16000 -ac 1 -f wav - 2>/dev/null | whisper-cli -m ~/models/ggml-base.bin -nt -f - 2>/dev/null'
npm start
```

In whisper mode the mic button is **tap-to-start / tap-to-stop** (record, then it
transcribes). Hands-free loop is browser-mode only.

## Agents & sessions

- Tap **＋** in the header to create a session: pick an **agent** (Claude / Codex /
  Antigravity), a **project folder**, and a name.
- The session **dropdown** switches between conversations; each keeps its own
  transcript and project directory.
- **Yeni sohbet** resets the active session's conversation; the **🎤 → ⏹** button
  turns into a Stop control while the agent is answering or speaking.

## How it works

```
[ iPhone Safari ]                         [ your Mac ]
  mic ─Web Speech STT─▶ text ──https/Tailscale──▶ voicebridge ──spawn──▶ claude / codex / agy
  speaker ◀─speechSynthesis── reply ◀──────────── reply  ◀──────────────  (coding agent CLI)
```

- Each session maps to one agent + project dir. Claude keeps a rolling
  conversation (`--continue`); **Yeni sohbet** resets it.
- For Claude the prompt is passed as a separate argv (no shell); for Codex and
  Antigravity it's piped on **stdin** — both injection-safe.

## Development

```bash
npm test       # zero-dependency test suite (node:test): adapters, parser,
               # session registry, streaming, and auth — uses stub agents.
```

## Security notes

- The server binds to `127.0.0.1` and is only reachable through your **Tailscale**
  tailnet — it is not exposed to the public internet.
- iOS speech **recognition** streams audio to Apple for transcription (free, but
  not local). Speech **synthesis** is fully on-device. If you need fully-local
  STT too, swap the browser recognizer for a local Whisper endpoint (see ideas
  below).
- Anyone on your tailnet who opens the URL can drive an agent in a session's
  project directory (and create sessions pointing at other directories). Keep
  your tailnet private and set `ACCESS_TOKEN`.

## Ideas / roadmap

- Fully-local STT: stream mic audio over WebSocket to a local `whisper.cpp`
  server instead of the browser recognizer.
- Per-agent conversation continuity for Codex / Antigravity (resume support).
- QR code for the phone URL on startup; a usage GIF in this README.
- ✅ Streaming replies, a Stop button, multiple agents, and multiple sessions.

## License

MIT
