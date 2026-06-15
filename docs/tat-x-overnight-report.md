# Tat X — overnight report

Branch `claude/cranky-burnell-baef53` (now **42 commits ahead of `main`**, not yet
merged — see "Main merge" below). Plan: `docs/tat-x-plan.md`.

## Status: 10/10 addressed

| # | Item | State | Commit |
|---|------|-------|--------|
| 118 | Persistent live `claude` session (stream-json, in-memory history) | built + smoke-tested | `2167ed2` |
| 119 | Barge-in safe on live sessions (drain, no kill, history survives) | built + smoke-tested | `aea8ea2` |
| 120 | Per-agent `live` capability flag (codex/agy → per-turn fallback) | built + smoke-tested | `ebe2f64` |
| 121 | Per-agent command palette (antigravity no longer shows Claude cmds) | built + smoke-tested | `3a4d3f7` |
| 122 | Slash commands execute in live sessions, incl. voice mode | built + smoke-tested | `f00c596` |
| 123 | PC handoff, single-writer safe (`claude --resume`) | built + smoke-tested | `19e1bdb` |
| 124 | Summarize-before-speak for long replies (hands-free) | built + unit-tested | `6338d99` |
| 125 | In-app voice picker (persisted) | built + installed on phone | `075844b` |
| 126 | CarPlay end-to-end | user-verify (needs car) | — |
| 127 | macOS/web desktop build | web build compiles (build/web) | — |

All bridge changes are behind **`PERSISTENT_SESSIONS=1`**; with the flag off the
old per-turn path is unchanged, so nothing on the running bridge was altered
overnight.

## What you can check right now (no setup)
- **Voice (#125 / #124)** — already installed on the phone. App -> session settings
  -> **SES -> Konusma sesini sec** -> pick a voice (hear a sample). If "Siri Ses 2"
  isn't listed, iOS doesn't expose it to apps. Long replies now read a short lead
  + "(uzun cevap, tamami ekranda)" in the talking loop; the "Sesli oku" button
  still reads the full text.

## To try the live Tat X bridge (optional, your call)
The running bridge is still the OLD code with the flag OFF (deliberately - so the
phone kept working all night). To try persistent sessions / working slash commands
/ handoff, restart it from this worktree with the flag on (preserves token +
sessions per the bridge-runtime memory):

    PORT=8787 HOST=127.0.0.1 AGENT_TIMEOUT_MS=0 PERSISTENT_SESSIONS=1 \
    SESSIONS_FILE=~/.voicebridge/sessions.json ACCESS_TOKEN=<current> \
    nohup node server.js </dev/null > ~/.voicebridge/bridge.log 2>&1 & disown

Then: ask two related turns (it won't "forget"); send a `/command` (it runs, even
in voice mode); session settings -> handoff returns a `claude --resume <id>` for the
terminal.

## Verified findings
- `claude` v2.1.177 keeps in-memory history across turns via `--input-format
  stream-json` - no extra SDK needed.
- Custom slash commands DO execute in stream-json mode (`/ping -> PONG`).
- `--resume` composes with `--input-format stream-json` (handoff/respawn restore history).

Smoke tests (all PASS): `/tmp/vb_live_smoke.mjs`, `vb_bargein_smoke.mjs`,
`vb_cmds_smoke.mjs`, `vb_voicecmd_smoke.mjs`, `vb_handoff_smoke.mjs`,
`vb_speech_test.dart`.

## Main merge (needs your review)
The branch carries 42 commits - tonight's Tat X work **plus** earlier unmerged
talking-mode/redesign work that was never PR'd to `main`. I did NOT auto-merge that
to `main` overnight. Open a PR and review before merging. GitHub issues #118-#127
are left open (not closed, since not merged). #127's web build has a
`speech_to_text` web/wasm limitation (STT limited on web; text/drive works).
