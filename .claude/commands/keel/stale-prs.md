---
description: Find open PRs that have gone quiet or drifted off the base branch; triage, comment, and optionally refresh from the configured base branch — respecting the merge window.
argument-hint: "[--days <N>] [--rebase|--merge-develop] [--dry-run]"
allowed-tools: Bash(keel:*), Bash(git:*), Bash(gh:*), Read, Edit
---

# /keel:stale-prs

## Live progress — stamp this run (required)

So this run shows live on `keel-visual`'s board, record it with `keel activity` **as you
go**. This command's phases are: `orient` → `list` → `classify` → `triage` → `post` → `rebase` → `summary`. Pick one stable `--run-id` for the whole run
(e.g. `stale-prs-<issue-or-pr>`):

- **Right now, before the work below**, stamp the first phase:
  `keel activity .keel/project.yaml --root . --write --command stale-prs --run-id "$RUN" --phase orient`
- Re-run with the next `--phase` (`list`, …) **as you advance** through the flow.
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

Project-neutral stale-PR sweep. Triages open PRs that have either gone quiet or drifted out
of sync with `base_branch`. All project values come from `.keel/project.yaml` via the `keel`
CLI — the base branch, the merge window, and the CI workflows are never hardcoded here.

The command is **read-only on PR code by default**: it never modifies a PR's diff, never
closes a PR, never re-triggers CI manually, and never merges. Without `--rebase` the only
write is one triage comment per stale PR. It is safe to re-run on a schedule — the same-day
idempotency check (Step 4) is load-bearing.

## Step 0 — orient + parse arguments

```bash
keel validate .keel/project.yaml --root .
keel plan     .keel/project.yaml --root .     # read base_branch, ci_workflows, merge window
keel plan     .keel/project.yaml --root . --command stale-prs --live --json
keel window   .keel/project.yaml              # is the merge window open right now?
```

The live plan is the operator-consent preflight. Before posting comments, checking out or
merging branches, pushing refresh commits, using secrets, publishing, or calling
production-adjacent systems, parse `contract.operator_consent`; if
`requires_operator_consent` is true, STOP and ask the operator to rerun with the required
`--approve-scope` values.

Arguments:
- `--days <N>` — staleness threshold in calendar days. Default `3`. Reject `0`, negatives,
  and non-integers.
- `--rebase` — boolean; actually update each drift-bucket non-draft PR off `base_branch` and
  push. Without it the command is comment-only.
- `--merge-develop` — legacy alias for `--rebase`. It MUST behave exactly like `--rebase`
  and merge the configured `base_branch`, not a hardcoded `develop` branch. Reject runs that
  pass both aliases together as repeated refresh intent.
- `--dry-run` — boolean; print intended actions as `would …: …` lines and make **no** API
  call and **no** push. Every state-changing call (comment, checkout, merge, push) is
  redirected to stdout and skipped. May be combined with `--rebase` (prints the would-be
  rebase per PR, posts nothing).
- Reject unknown flags.

All published artifacts (comments, branch names) MUST be written in English; free-form chat
may be in any language.

## Step 1 — list open PRs targeting the base branch

Enumerate every open PR whose base is `base_branch`, paginating until all are collected. For
each, capture: number, title, last-activity timestamp (the activity signal advances on the
last commit OR comment OR review, so a PR with recent reviewer chatter but no new commits is
correctly *not* stale), head ref, draft flag, and author. Compute the cutoff as
`now − <days>` in UTC; keep only PRs whose last activity is strictly older than the cutoff.
PRs inside the window are skipped entirely.

## Step 2 — classify each stale PR

For each candidate, fetch its merge-state and confirm draft status. Assign one bucket, in
**priority order drift > review-stalled > abandoned** (a PR matching multiple goes to the
highest):

1. **Drift** — behind `base_branch` or merge-conflicted. A refresh is the unblocking action.
2. **Review-stalled** — mergeable but with no reviewer activity inside the window. Waiting on
   humans.
3. **Likely-abandoned** — a draft whose age from creation exceeds `2 × <days>`. **Informational
   only** — this command never closes abandoned PRs.

A PR both behind and a stale draft → drift; a clean stale draft → abandoned. PRs whose
merge-state cannot be classified and that do not match the abandoned criteria are dropped
with a one-line stdout note and no comment.

## Step 3 — build the per-PR triage comment

Build a comment body whose **literal first line** is a codename `STALE-PRS-<DATE>-<UTC_TIMESTAMP>`
(`<DATE>` in the project timezone). **Codename pin (load-bearing):** no blank line above it,
no leading whitespace, no quoting, no Markdown prefix or surrounding formatting — Step 4's
same-day dedupe finds prior runs by the `STALE-PRS-<DATE>-` prefix, and any deviation makes it
miss the prior comment and post a duplicate.

The body carries: a mandatory `@author` mention (how the author gets notified), the bucket,
last-activity timestamp + age in whole UTC days, merge state, the most-recent review/comment
link (or "none in window"), and a **suggested action** per bucket:
- **Drift** — fetch + merge `base_branch` into the head branch, resolve conflicts, push; or
  re-run with `--rebase` to let the sweep attempt the auto-merge.
- **Review-stalled** — ping the most-recent requested reviewer (fall back to "ping a
  reviewer" if none is parseable) or request a fresh one.
- **Likely-abandoned** — note the inactivity; informational, the PR will not be auto-closed.

If `--rebase` is set and the Step 5 auto-merge hits a conflict, append a final line to the
same body before posting: `Merge conflict detected — manual resolution needed on <head>.`

## Step 4 — post the triage comment (same-day idempotent)

For each PR with a built body, read its existing comments and look for one whose first line
starts with `STALE-PRS-<DATE>-` for today's `<DATE>`:
- **Prior same-day comment exists** → skip the post; log `already commented today on #N`. This
  is the idempotency guarantee that makes scheduled re-runs safe — do not weaken it.
- **No prior same-day comment** and not `--dry-run` → post the comment.
- **`--dry-run`** → print `would comment on #N` followed by the indented body; no API call.

## Step 5 — `--rebase` action (only when the flag is set)

Skip entirely when `--rebase` is unset. Otherwise, for each **drift-bucket non-draft** PR
(drafts are skipped to avoid pushing work the author may be rebasing), refresh the branch:

1. Fetch the head ref; check it out onto a throwaway local branch.
2. Merge `base_branch` into it with a no-fast-forward merge commit.
3. **Conflict handling — straightforward only:**
   - Merge clean → push to the head ref. Record `merge-pushed`. The push organically retriggers
     CI — that is the *only* intended CI side-effect (no manual re-run / dispatch).
   - Any conflict whatsoever → **abort and skip** (`git merge --abort`). Do NOT auto-resolve;
     arbitrary three-way conflicts are not safely automatable. Record `conflict-skipped` and
     append the conflict note to the triage comment (or a follow-up if today's comment already
     posted).
4. Local cleanup: return to the prior branch and delete the throwaway branch.

`--dry-run` prints `would rebase <head> for #N` per drift-bucket non-draft PR and performs no
fetch/checkout/merge/push. **Per-PR failures** (push auth error, network drop, merge-driver
crash) MUST NOT abort the sweep — record `error-skipped — <reason>` and continue.

Respect the **merge window**: this command never merges a PR into `base_branch`. Route a clean,
review-ready PR to `/keel:ship` (window + lock + review) or `/keel:review-cycle` rather than
merging here.

## Step 6 — session summary

Print a summary table: PR · title · bucket · action, where action is one of `commented`,
`already-commented-today`, `merge-pushed`, `conflict-skipped`, `dry-run-noted`,
`error-skipped — <reason>`. If no PR is stale at the threshold, print a single line
`No stale PRs at threshold <days> days.`

## Stop conditions / invariants

- **Never close a stale PR** — the abandoned bucket is informational; closing is a human call.
- **Never re-trigger CI manually** — the only CI side-effect is the natural retrigger from a
  push after a successful `--rebase`.
- **Never auto-resolve arbitrary conflicts** — Step 5 aborts and records `conflict-skipped`.
- **Per-PR errors never abort the sweep** — each is recorded and the loop continues.
- **Same-day idempotency** — never post a duplicate triage comment on the same date.
- **No silent dry-run mutations** — every would-be write is printed and skipped.
- **Never modify a PR's tree** beyond the merge commit that brings in `base_branch`.
- Fail-soft per PR; deterministic ordering.

<!-- keel-generated: surface=claude command=stale-prs keel_version=1.6.5 source_sha256=c38026730f14278d6bb7c41bc9ee38d2b1ed30b9c9ca370c079291613c0dd67a generated_sha256=c38026730f14278d6bb7c41bc9ee38d2b1ed30b9c9ca370c079291613c0dd67a -->
