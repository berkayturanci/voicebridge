# voicebridge

**Hands-free, two-way voice for Claude Code from your phone — free, open-source, no ElevenLabs.**

You speak to your phone, Claude Code (running on your Mac/Linux box) does the work,
and the reply is read back aloud — like a phone call with your coding agent.

- 🎙️ **Speech-to-text** and 🔊 **text-to-speech** run in your phone's **browser**
  (Web Speech API) — no per-minute cloud voice cost, no API keys.
- ⚡ **Streaming** — Claude's reply is spoken **sentence-by-sentence as it's
  generated**, not after the whole turn finishes.
- 🧩 A **tiny zero-dependency Node bridge** relays the recognized text to the
  `claude` CLI on your machine and streams its reply back.
- 🔒 Reached over **Tailscale** (your private network) with real HTTPS, with an
  optional **shared access token** — your code never touches a third-party voice
  service.
- 🗣️ Optional **fully-local speech-to-text** via your own Whisper command
  (`STT_MODE=whisper`), so even the transcription stays on your machine.

> Honest scope: the Claude **model** still runs in Anthropic's cloud (that's how
> Claude Code works). voicebridge just removes the *voice* middleman (ElevenLabs)
> and its limits. Speech recognition on iOS uses Apple's free dictation service;
> text-to-speech is fully on-device.

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
| `PROJECT_DIR`  | current directory    | Working directory Claude Code runs in              |
| `CLAUDE_BIN`   | `claude`             | Path to the `claude` executable                    |
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

## How it works

```
[ iPhone Safari ]                         [ your Mac ]
  mic ─Web Speech STT─▶ text ──https/Tailscale──▶ voicebridge ──spawn──▶ claude -p --continue
  speaker ◀─speechSynthesis── reply ◀──────────── reply  ◀──────────────  (Claude Code)
```

- The bridge keeps one rolling conversation (`--continue`); **Yeni sohbet** resets it.
- Spoken text is passed to `claude` as a separate argv (no shell), so it's safe
  from injection.

## Security notes

- The server binds to `127.0.0.1` and is only reachable through your **Tailscale**
  tailnet — it is not exposed to the public internet.
- iOS speech **recognition** streams audio to Apple for transcription (free, but
  not local). Speech **synthesis** is fully on-device. If you need fully-local
  STT too, swap the browser recognizer for a local Whisper endpoint (see ideas
  below).
- Anyone on your tailnet who opens the URL can drive Claude Code in `PROJECT_DIR`.
  Keep your tailnet private.

## Ideas / roadmap

- Fully-local STT: stream mic audio over WebSocket to a local `whisper.cpp`
  server instead of the browser recognizer.
- Streaming replies (speak as Claude generates) via `--output-format stream-json`.
- Per-session isolation with `--session-id`.

## License

MIT
