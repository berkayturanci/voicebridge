# Tat Y — full interactive (tmux) sessions — report

Goal (the user's actual ask): a **full interactive Claude session shared live with
the local PC CLI** — drive it from the phone, attach to the SAME session on the Mac
with `tmux attach`, and have built-in commands like **`/remote-control`** work
(reaching it from the Claude mobile app). Tat X (headless stream-json) couldn't do
those; Tat Y can.

## Status: #128–#132 done (opt-in, coexists with Tat X)

| # | Item | State | Commit |
|---|------|-------|--------|
| 128 | tmux runner — interactive claude per session (send-keys) | ✅ smoke-tested | `5cb8baf` |
| 129 | reply extraction + completion detection (scrape the TUI) | ✅ smoke-tested | `5cb8baf` |
| 130 | opt-in runner 'tmux' + lifecycle (kill on delete, idle) | ✅ | `5cb8baf` |
| 131 | `/api/tmux-attach` — attach + /remote-control steps | ✅ smoke-tested | `cfda152` |
| 132 | app: create full session + Mac attach/remote-control screen | ✅ built + installed | `d699df6` |

## How it works
- A `runner:'tmux'` session starts a real interactive `claude` in a detached tmux
  session `vb_<id>` (default/auto mode; no `--dangerously-skip-permissions`).
- Phone turns are typed in with `tmux send-keys`; the reply is scraped from
  `tmux capture-pane` (extractTuiReply strips the welcome box, ─── input borders,
  the ❯ echo, ✻ Cogitated and ⎿ chrome, keeps the ⏺ body) once the pane settles.
- On the Mac: `tmux attach -t vb_<id>` opens the SAME live session; run
  `/remote-control` there to reach it from the Claude app.

## Use it from the phone
1. New session → turn on **"Tam oturum (tmux)"** (claude only) → create.
2. Talk to it normally. Replies are scraped from the real TUI.
3. Session settings → **"Mac'te aç / Claude app'ten eriş"** → copy the
   `tmux attach -t vb_<id>` command, run it on the Mac, then `/remote-control`.

## Verification boundary
Bridge runner + extraction + attach endpoint are smoke-tested (a tmux session turn
returns the scraped reply). **PC attach + `/remote-control` + Claude-app access are
user-verified** (real tmux/terminal). Known fragility: reply scraping depends on the
claude TUI format (markers ❯ ⏺ ✻, box chars) — a future claude version could shift it.

## Smoke tests
`/tmp/vb_tmux_spike.sh`, `vb_tmux_spike2.sh`, `vb_tui_extract.mjs`,
`vb_tmux_e2e.mjs`, `vb_attach_smoke.mjs` — all PASS.

## Next (planned, not built)
- Same full-session approach for **codex** and **antigravity** agents (separate epic).
- Parked: **Piper** bridge-TTS app side (`/api/tts` shipped in `4e03a1a`); the
  CarPlay choppiness (#133) may ultimately want this continuous-audio path.
