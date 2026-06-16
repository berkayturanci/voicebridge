# Antigravity full (tmux) session — plan (next epic)

Codex full-session shipped (#137, commit `5e023d2`): codex writes a clean text
rollout transcript, so the existing Tat Y watch/history/live-sync machinery
transferred with just a new line-parser + rollout binder. Antigravity is harder.

## What antigravity actually exposes (investigated 2026-06-16, agy 1.0.8)

| Aspect | Finding |
|---|---|
| CLI flags | `--continue`/`-c`, `--conversation <ID>`, `--print`/`-p`, `--prompt-interactive`/`-i`, `--dangerously-skip-permissions`, `--sandbox`. No streaming-JSON, no remote-control/app-server. |
| Transcript store | `~/.gemini/antigravity-cli/conversations/<uuid>.{db,pb}` — SQLite (`steps` table, `step_payload` = **protobuf blob**) + protobuf. **Not** tailable text. |
| User-turn log | `~/.gemini/antigravity-cli/history.jsonl` — `{display, timestamp, workspace, conversationId}`, one line per **user** prompt. Tailable, but no assistant text. |
| Resume | `--conversation <id>` / `--continue`. New conversation id assigned per run. |
| Native remote | `bin/agentapi` needs `ANTIGRAVITY_LS_ADDRESS` (IDE language-server). Bound to a running IDE — not a usable CLI remote for v1. |

## The core problem

There is **no clean text transcript** for assistant turns — they live in protobuf
blobs inside SQLite. So the codex approach (tail a rollout `.jsonl`) does not apply.

## Proposed approach (v1)

Drive the same Tat Y tmux runner (`runner: "tmux"`, agent `antigravity`):

1. **Launch**: `agy --prompt-interactive` (or bare `agy -i`) in tmux; auto-confirm
   any first-run/permission gate the way `ensureTmuxCodex` handles codex's trust gate.
2. **Send**: `send-keys -l <text>` + Enter (identical to claude/codex).
3. **Assistant turns — pane scrape** (not transcript): add an antigravity branch to
   the reply path that captures the pane and extracts the assistant body using
   antigravity's TUI markers (to be spiked the way codex/claude were — learn the
   ready marker, the generating marker, and the assistant-line prefix).
4. **User turns — `history.jsonl` tail** (optional nicety): bind the session's
   `conversationId` from `history.jsonl` (newest line whose `workspace` ==
   projectDir, after launch) so user turns sync cleanly across clients even though
   assistant turns are pane-derived.
5. **Binding**: store `conversationId` for `--conversation <id>` resume.
6. **Attach sheet**: antigravity-flavored steps (attach the tmux on the Mac; no
   `/remote-control` analog — `agentapi` is IDE-bound, omit for v1).

## Open questions to resolve by spiking (before coding)

- Antigravity TUI markers: ready / generating / assistant-line prefix (the way we
  learned codex's `OpenAI Codex` / `esc to interrupt` / `•`).
- Whether `--prompt-interactive` keeps a stable input box we can `send-keys` into
  turn after turn, or whether it exits after one turn (would force `--continue` per
  turn, losing the persistent-session feel).
- Whether protobuf decode of `steps.step_payload` is tractable enough to get clean
  assistant text without pane-scraping (likely not worth it for v1).

## Sequencing

User chose **finish + verify codex first, then antigravity**. Start the spike once
codex full-session is confirmed working on-device.
