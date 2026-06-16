---
name: keel-overnight
description: Unattended overnight work block — time-aware merge mode keyed on the merge window; runs /keel:ship over the queue until the window closes, then writes a session/morning report. Project-neutral; reads .keel/project.yaml.
---

# keel-overnight

Use this skill when the user asks to run the keel command `overnight` (e.g. `keel overnight ...`, `overnight <args>`, or `/keel:overnight`). It reads every project value from `.keel/project.yaml` via the `keel` CLI.

# /keel:overnight

## Live progress — stamp this run (required)

So this run shows live on `keel-visual`'s board, record it with `keel activity` **as you
go**. This command's phases are: `config` → `preflight` → `queue` → `loop` → `report`. Pick one stable `--run-id` for the whole run
(e.g. `overnight-<issue-or-pr>`):

- **Right now, before the work below**, stamp the first phase:
  `keel activity .keel/project.yaml --root . --write --command overnight --run-id "$RUN" --phase config`
- Re-run with the next `--phase` (`preflight`, …) **as you advance** through the flow.
- At the end: `keel activity .keel/project.yaml --root . --run-id "$RUN" --done`

Treat this like any other contractual step — do not skip it. The one allowed exception is a
core too old to ship `keel activity` (keel < 1.6.0): then skip it silently and never block
the command.

## Command step evidence

Every numbered step in this command is contractual. Complete the step, record the
evidence it asks for, or explicitly mark it `N/A — <reason>` before moving on. If a step
has an external side effect such as a GitHub comment, issue, review, report, branch, or
PR, the side effect must be posted or written through the selected transport and cited in
the final summary. Never silently skip a step because the runtime, agent, or prompt feels
obvious.

Run `/keel:ship` unattended over the backlog until the **merge window** closes,
the time budget runs out, or `--max` issues are shipped. This adapter is
project-neutral: it contains no timezone, branch, command, or path literal. Read
every project specific from `.keel/project.yaml` via the `keel` CLI
(`timezone`, `merge_window`, `base_branch`, `tier3_globs`, `ci_workflows`).

## Language

All committed/published artifacts (commits, branch names, PR/issue titles and
bodies, comments, file contents, the session/morning report) MUST be written in
English. Free-form chat may stay in any language (`knobs.sot_doc` § language
policy).

## Step 0 — Resolve config + mode

```bash
keel validate .keel/project.yaml --root .
keel plan     .keel/project.yaml --root .
keel plan     .keel/project.yaml --root . --command overnight --live --json
keel window   .keel/project.yaml --root .   # OPEN (merge-as-you-go) or CLOSED (no-merge)
```

The live plan is the operator-consent preflight. Before selecting work, spawning
implementers, creating PRs, merging, writing reports, using secrets, publishing, or calling
production-adjacent systems, parse `contract.operator_consent`; if
`requires_operator_consent` is true, STOP and ask the operator to rerun with the required
`--approve-scope` values. Pass `operator_consent.delegated_agent_scope` into every
`/keel:ship` or implementer handoff. Delegates may use only `approved_mutation_scopes`;
scope expansion blocks or escalates.

Mode is keyed on `keel window`, which derives the cutover from the configured
`timezone` + `merge_window` (down to the exact minute, not just the hour):

| `keel window` | Mode | Merge rule |
|---|---|---|
| CLOSED (no-merge phase) | **Night** | No merges except blockers. Write a morning report at end. |
| OPEN | **Day** | Merge CI-green + fully-reviewed PRs as you go. Write a brief session summary at end. |

The boundary is shared with `/keel:ship`, so both commands defer or merge the
same PR at the same wall-clock minute. Re-check `keel window` each loop — the
mode can flip mid-session.

Read `contract.checkpoint` from the live plan. At session start, call
`keel resume .keel/project.yaml --root . --json`. If the resume plan is
`no-checkpoint`, begin a new work block. If it is `ambiguous`, stop and reconcile the
recorded PR/worktree state before selecting more work. If it points to an already-merged
PR, hand off to capture/closeout and do not repeat the merge.

Write a checkpoint at each work-block boundary: after queue selection, after each
`/keel:ship` handoff returns, before stopping on CI/review/window blockers, and before the
final report write. Use `--checkpoint-command overnight`, keep the active issue queue in
`--issue-queue`, set `--active-issue` for the current issue, and preserve branch,
worktree, PR, merge, capture, and close state when a child ship run has created them.
The checkpoint is the active resume point; the run ledger remains append-only history.

## Two non-negotiable rules

1. **Night mode — no auto-merge except blockers.** Every PR stays open for the
   user to review and merge in the morning. The one exception: a PR may merge at
   night if it is a **blocker** AND the full review loop is complete with CI
   green. The morning report must list it explicitly under
   "Merged at night — reason:".

   **Day mode** — merge each PR immediately once the review loop is complete and
   CI is green.

   This never overrides the keel invariant: the night no-merge window and the
   merge lock are enforced by keel-core and cannot be weakened by this command.

   ### What counts as a blocker?
   - A CI fix currently red on `base_branch` that is blocking every other queued
     PR.
   - A foundational doc/process update every subsequent overnight PR must read
     first.
   - A data-safety or security fix that cannot wait until morning.

   A regular feature PR, a refactor/conversion PR, a test-only PR, or a docs
   cleanup is **not** a blocker — it stays unmerged in night mode.

2. **Work until the budget runs out** (`hours`, default 8). If the primary queue
   empties early, expand test coverage, open modernization issues, or improve CI
   infrastructure — never stop early.

For everything else (review protocol, issue lifecycle, branch naming, docs gate,
do-not-touch list, code-quality checklist) follow the project's source-of-truth
doc (`knobs.sot_doc`) exactly.

## Pre-flight — workspace isolation

`/keel:overnight` performs state mutations (creates PRs, merges in day mode,
spawns implementer subagents), so it MUST run from a **linked worktree**, never
the user's primary checkout. Detect with `git rev-parse --git-dir`: the main
worktree returns the literal `.git`; a linked worktree returns an absolute path
containing `/.git/worktrees/<name>`. If the value is `.git`, ABORT and tell the
user to re-run from a session worktree created off `origin/<base_branch>`
(repo-nested path, never a sibling). Each implementer subagent this command
spawns MUST also receive its own worktree under `worktrees/issue-<N>` (per
`/keel:implement` Step 5).

```bash
git fetch origin
git status          # if dirty → stop and ask the user
```

Then scan open PRs and issues to build the session queue.

## Priority queue (refresh each session)

| Tier | Scope |
|------|-------|
| T0 | Blocker: CI red on `base_branch` → fix first |
| T1 | Open PRs with pending review rounds |
| T2 | Test coverage batches |
| T3 | CI/quality infrastructure — lint rules, threshold gate, workflow improvements |
| T4 | Small modernization/conversion tasks (do-not-touch list excluded) |
| T5 | Docs / backlog issues — update `knobs.sot_doc`, open new issues |

The do-not-touch list (issues too large for one session) is project-specific —
keep it in the project's source-of-truth doc, not here. If a plan file exists in
the project's plans directory, use it as the queue instead.

## Main loop

1. `keel window .keel/project.yaml --root .` — only merge while OPEN; in CLOSED
   mode leave PRs open (blocker exception above). Stop the loop at window close.
2. Pick the next candidate issue in queue order. Fetch its title, body, and labels, then
   run the shared intake preflight before handing it to ship:
   ```bash
   keel plan .keel/project.yaml --root . --command ship --live --json \
     --target "issue #<N>" \
     --issue-title "$ISSUE_TITLE" \
     --issue-body "$ISSUE_BODY" \
     --issue-label "$ISSUE_LABELS"
   ```
   Parse `contract.issue_intake`. If the issue is `needs-input`, `blocked`, or
   `out-of-scope`, record its `ledger_record`, skip reason, and generated questions in the
   session report, then continue to the next candidate when policy allows. Only `ready`
   issues may proceed.
3. Run `/keel:ship` for it (full backbone, inline-hybrid review, `jury` gate if
   configured in `gates:`), respecting `--review-comments`.
4. On a blocking failure that can't be auto-fixed within the round budget,
   **defer** it to the cross-session morning queue (for `/keel:morning`) and move
   on — never force a risky merge.
5. Loop until window close, `hours` exhausted, or `--max` reached.

## Session report (mandatory)

Write to the project's reports path (do not `git add` a gitignored reports path).

- **Night mode** → an `overnight-<DATE>` report.
- **Day mode** → a `session-<DATE>-<HH>` report.

Sections: PRs Created · PRs Touched (existing) · Skipped / Deferred (with
reasons) · Time Budget (planned vs actual per tier) · Open Questions · Next Steps
(1–3 concrete actions). Output the file path when done.

## Stop conditions

- Window closed (night cutover) or time budget exceeded or `--max` reached.
- Hard blocker (network, missing credentials, ambiguous requirement).
- Three consecutive PRs hit CI failures the agent cannot resolve.
- User cancels.

When stopped, write the session report immediately, even if partial.

## Invariants (never overridable)

Never merge outside the window · merge lock · fail-soft per issue (one failure
never aborts the loop) · attribute the effective agents (vendor + base model).

<!-- keel-generated: surface=skills command=overnight keel_version=1.6.5 source_sha256=1ccc85b63576106f661e9fe7efbef62296c783a08276075692294caa72486ffb generated_sha256=93d3af553cd96ad795ba40e0731fb10099813d6754523a9f43c39d64ce54b047 -->
