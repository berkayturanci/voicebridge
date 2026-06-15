# Tat X — Persistent multi-agent sessions + eyes-free voice layer

**Goal.** Re-architect the bridge from per-turn headless `claude -p` (which forgets
context between turns and can't run slash commands) into **persistent, live agent
sessions** that the phone drives and a human can hand off to from the terminal —
with a voice (TTS/STT) layer on top. The differentiator vs. Happy and Claude Code's
native Remote Control is **fully eyes-free / hands-free operation in the car
(CarPlay) and while exercising** — i.e. solving slopus/happy#624, a niche neither
competitor owns.

## Validated assumption (the make-or-break)

`claude` **v2.1.177** supports `--input-format stream-json` (realtime streaming
input) with `--print --output-format stream-json`. A single long-lived process
keeps conversation history **in-memory** across turns — proven by probe:

- Turn 1: "favori sayım 42 … sadece 'tamam' yaz" → "Tamam."
- Turn 2: "favori sayım neydi?" → "42"  ✅ (no `--resume`, recalled from memory)

So Tat X core needs **no extra npm SDK** — the installed CLI does it.

## Architecture: Tat X ("client on both ends", not native-TUI mirror)

- The bridge owns a **persistent process per session** (`claude --print
  --input-format stream-json --output-format stream-json --verbose`). User turns
  are written as Anthropic Messages-style NDJSON lines to stdin; assistant/tool
  events are read from stdout (reuse existing `parseClaudeEvents`).
- "Continue on PC live" = open the app's **macOS/web build** against the same
  bridge (same live session). Native terminal continuation is a **handoff**
  (`claude --resume <id>`), one writer at a time — simultaneous phone+terminal on
  the same `.jsonl` is unsafe (file lock).
- Multi-agent: same persistent model per agent CLI; fall back to per-turn for CLIs
  without streaming input.

## Phases / issue queue (riskiest first, per decision)

| # | Phase | Item | Autonomously verifiable? |
|---|-------|------|--------------------------|
| 1 | Core | Persistent stream-json session for `claude`, replacing per-turn `-p`. Process registry, lifecycle (idle-timeout, kill, crash-restart). Feature-flagged additive path. | Yes — multi-turn curl context test |
| 2 | Core | Wire the live turn loop: route `streamLocal` through the persistent process; map stdin/stdout to existing `emit()` events; keep barge-in/cancel working. | Yes — curl stream + cancel |
| 3 | Core | Multi-agent: persistent model for Codex/Antigravity where streaming-input exists; per-turn fallback otherwise. | Partial |
| 4 | Commands | Per-agent command palette: enumerate built-in + `.claude/commands` + plugin commands, filtered by agent; `/api/commands?agent=`. | Yes — curl |
| 5 | Commands | Execute commands in the persistent session (real input where supported; expand custom commands otherwise). | Yes — curl |
| 6 | Handoff | Handoff endpoint + UI: pause phone session → surface `claude --resume <id>` for PC; safe single-writer lock; reverse handoff. | Yes — curl + lock test |
| 7 | Voice | "Summarize-before-speak" for long/code replies (happy#624 idea); per-agent TTS. Strip/990 already drops code blocks. | Partial |
| 8 | Voice | In-app **voice picker** (fix Siri/Yelda: app force-selects Yelda; iOS 26 ignores system default). Plus STT/TTS polish on the new session model. | Build+install; **user verifies sound** |
| 9 | Voice | CarPlay end-to-end pass. | **User verifies** (physical) |
| 10 | Desktop | macOS/web build of the app → live desktop view of the same bridge session. | Build + smoke |

## Verification boundary (honest)

Code, builds, bridge smoke tests (curl), and install-to-phone are autonomous.
**Voice/CarPlay "working" cannot be autonomously verified** — that half is the
user's, with the physical phone. Items 9 and the sound-quality half of 8 are
checkpoints, not autonomous gates.

## Execution

- Riskiest-first; auto-merge green PRs to `main` (user decision).
- Phases 1–2 (core swap) are the highest blast radius — proven feasible by probe,
  but land behind a feature flag (`PERSISTENT_SESSIONS=1`) so the per-turn path
  stays as fallback until verified on-device.
