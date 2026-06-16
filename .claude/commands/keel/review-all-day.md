---
description: Time-window diff review sweep — scan every commit in a configurable merge-window-aligned span, classify each diff via parallel reviewers, and open one GitHub issue per serious finding. Read-only w.r.t. git/PRs; the only state change is issue creation.
argument-hint: "[days] [--review-delegate <...>] [--dry-run]"
allowed-tools: Bash(keel:*), Bash(git:*), Bash(gh:*), Bash(jury:*), Read, Edit, Agent
---

# /keel:review-all-day

## Live progress — stamp this run (required)

So this run shows live on `keel-visual`'s board, record it with `keel activity` **as you
go**. This command's phases are: `config` → `parse` → `commits` → `decide` → `classify` → `open` → `report`. Pick one stable `--run-id` for the whole run
(e.g. `review-all-day-<issue-or-pr>`):

- **Right now, before the work below**, stamp the first phase:
  `keel activity .keel/project.yaml --root . --write --command review-all-day --run-id "$RUN" --phase config`
- Re-run with the next `--phase` (`parse`, …) **as you advance** through the flow.
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

A continuous, time-windowed review sweep over recent history. Resolve a span (a window
aligned to the project's configured timezone), collect every commit in that span across the
trunk plus active work branches, fan reviewers out over the diffs, classify each for
defects, and open **one GitHub issue per serious finding**. **Project-neutral** — every
project specific (`base_branch`, `ci_workflows`, `tier3_globs`, `build_gate_cmd`, `lint_cmd`,
`implementer_agents`, the timezone driving the window, the active-branch naming convention)
is read from `.keel/project.yaml` via the `keel` CLI. If you are about to type a literal
branch name, timezone, build command, or path glob — stop and read it from config instead.

This command **never** pushes code, opens/closes PRs, comments on PRs, or merges. Its only
state-changing action is `gh issue create` per serious finding. Reviewer subagents are
strictly findings-only and never call a GitHub write API — the orchestrator owns every write.

## Step 0 — Resolve config + window

```bash
keel validate .keel/project.yaml --root .                 # abort if config/extensions invalid
keel plan     .keel/project.yaml --root .                 # base_branch, ci_workflows, tier3_globs, gates
keel plan     .keel/project.yaml --root . --command review-all-day --live --json
keel review-all-day .keel/project.yaml 1 --root . --live --json
keel window   .keel/project.yaml --root .                 # window state in the project timezone
```

The live review-all-day contract is the operator-consent preflight and includes
`scan_contract`: configured active branch patterns, title prefix, dedupe rules, diff
truncation, issue labels, and dry-run write suppression. Before fetching/checking refs, spawning
reviewers, opening issues, using secrets, publishing, or calling production-adjacent
systems, parse `contract.operator_consent`; if `requires_operator_consent` is true, STOP
and ask the operator to rerun with the required `--approve-scope` values. Pass
`operator_consent.delegated_agent_scope` into every reviewer brief. Delegates may use only
`approved_mutation_scopes`; scope expansion blocks or escalates.

Read the knobs you will need: `base_branch`, `tier3_globs` (the risk map used to tier every
finding), `ci_workflows`, and `policy_pack.scan.active_branch_patterns`. The span
boundaries are derived from the project **timezone** and **`merge_window`** as reported by
`keel window` — never hardcode a timezone or offset here. `gh` (or its MCP equivalent) is
required for the issue calls; if it is unavailable, exit cleanly with a single note rather
than partial-running.

## Step 1 — Parse arguments + resolve the span

Argument grammar:

- **No argument** ⇒ the span is the current window's start (today, at the window's open
  boundary in the project timezone) → now.
- **A single positive integer `N`** ⇒ the span covers the last `N+1` calendar days, each day
  inclusive from its open boundary to its close. So `1` = yesterday + today; `7` = today plus
  the 7 prior calendar days.

Reject: negative integers, non-integers (anything not matching `^[0-9]+$`), and more than one
positional argument.

Let the CLI own the deterministic boundary math: resolve `[SINCE, UNTIL]` (ISO-8601 with the
numeric offset that `git log --since/--until` accepts) from the project timezone + window via
`keel window`, rather than re-deriving timezone arithmetic inline. State the parsed `DAYS`
value and the resolved `[SINCE, UNTIL]` timestamps in your first user-facing line.

Also print `Resolved span: N+1 calendar days` (where `N` is the parsed `DAYS`, or `0` for the
no-arg case which scans only today). This makes the off-by-one explicit so the operator
catches it before the scan: `/keel:review-all-day 7` actually covers 8 calendar days.

## Step 2 — Build the commit set

**Scope:** the trunk (`base_branch`) plus **active work branches** only — do NOT scan every
remote branch (that explodes scope and produces noise on stale forks). The active-branch
naming convention is a project policy knob (project-specific; stays in the project) — read it
from config rather than hardcoding a prefix here.

**Remote refs only.** Fetch first so newly-pushed branches are visible, then collect the
active branches from `origin` remotes. Local-only commits that have not been pushed are NOT
scanned — push the branch first if you want them reviewed. Warn loudly on a network/fetch
failure (and proceed against local refs) rather than silently scanning stale state.

The ref set is `origin/<base_branch>` first (so it dominates the dedup), then the active
work branches. Collect commit SHAs in `[SINCE, UNTIL]` across all refs, dedup by SHA, and
preserve newest-first ordering. Compute `COMMIT_COUNT` with a counter that is robust to empty
input (e.g. `grep -c .`, not `wc -l`, which mis-counts a trailing newline on empty input).

Print the count and the SHA+subject lines. If the set is empty, write the final report
(Step 6) saying "0 commits in window" and exit cleanly — no failure.

## Step 3 — Decide batch vs fan-out

Let `COMMIT_COUNT` be the number of unique SHAs from Step 2:

| `COMMIT_COUNT` | Strategy |
|---|---|
| `0` | Skip Steps 4–5; jump to Step 6. |
| `1 ≤ count ≤ 5` | **Batch mode** — a single reviewer, one Agent-tool call, all diffs concatenated in the prompt. |
| `count > 5` | **Fan-out mode** — one reviewer per commit, all spawned in a single Agent-tool message so they run concurrently. |

The threshold is 5: below it, per-agent overhead dominates and batching is faster; above it,
single-agent attention degrades and fan-out's parallelism wins. Document the choice in the
user-facing log: `STRATEGY=batch|fan-out, COMMIT_COUNT=<n>`.

Reviewers are the host agent, or the agent named by `--review-delegate` (a non-host reviewer
runs read-only / findings-only). Any `reviewers` Lego extensions also slot in here.

## Step 4 — Classify each commit (delegate to reviewers)

For every commit, the orchestrator **pre-fetches** the diff so subagents do not re-shell into
git: `git show --no-color --stat --patch "$SHA"`.

**Large-diff guard.** Truncate to ~200 KB per commit if the diff is enormous, but never cut
mid-hunk — a malformed diff confuses the reviewer. Truncate at the next `^diff --git ` file
boundary past the threshold (file boundaries fall between hunks, so this is safe), then emit a
synthetic trailing line:

  `--- diff truncated at <N> bytes; <M> bytes remaining ---`

so the reviewer can flag "diff too large for full review" rather than guess from a half-hunk.
(Account for the newline `awk` strips when byte-counting: `length($0) + 1` per line.)

### 4a. Batch mode (≤ 5 commits)

Spawn ONE reviewer in a single Agent-tool message. Give it a per-run codename
`REVIEW-WINDOW-<UTC_TIMESTAMP>-BATCH`, the window `[SINCE, UNTIL]`, the commit count, the
concatenated `git show` outputs (delimited `----- COMMIT k -----`), and this classification
contract. For each commit, classify the diff for:

- **Bug-insert** — logic error, null/nil deref, incorrect branching.
- **Regression risk** — breaks an existing flow (data-layer, entitlement,
  lifecycle/concurrency, auth) — generalize to the project's own high-risk areas implied by
  `tier3_globs`.
- **Security** — secrets, injection, OWASP-class, race condition.
- **Config drift** — CI/build/dependency/manifest/rules drift (the project's
  `ci_workflows` / build config / shared-schema sources).
- **Test-coverage gap** — new logic without a test, or a stub-only test.

For every serious finding, emit ONE block in exactly this shape:

```
FINDING:
  SHA: <full SHA>
  SEVERITY: blocker | major | minor
  CATEGORY: bug-insert | regression | security | config | test-coverage
  FILE: <path>:<line-or-range>
  DESCRIPTION: <one paragraph>
  SUGGESTED_FIX: <one paragraph>
```

For a clean commit, emit `CLEAN: <SHA>`. **Do NOT post anywhere — return findings as the
final message.**

**Severity reconciliation** (canonical reviewer vocabulary): BLOCKER ≡ must-fix → `blocker`;
SUGGESTION that materially harms maintainability → `major`; cosmetic SUGGESTION → `minor`;
**NIT → drop** (informational only; never emit a FINDING block for a nit, never opens an
issue).

### 4b. Fan-out mode (> 5 commits)

In a single Agent-tool message, spawn `COMMIT_COUNT` reviewers concurrently, each receiving
exactly one commit's diff and the same finding-output contract as 4a, with a per-commit
codename `REVIEW-WINDOW-<UTC_TIMESTAMP>-<SHORT_SHA>`. Each fan-out prompt MUST include the
**no-cross-reading** rule: "Do NOT read the other reviewers' output — your review must be
fully independent." Reviewers draw their full rubric (severity vocabulary, return format)
from the canonical reviewer rubric, not from inline heuristics here. The orchestrator collects
every agent's `FINDING:` / `CLEAN:` output before Step 5.

Optionally run `keel run-gates .keel/project.yaml --root .` (build / lint / **jury** / tester)
so deterministic gate findings join the reviewer findings on the same severity scale before
issue triage.

## Step 5 — Open one issue per serious finding (orchestrator only)

Aggregate all `FINDING:` blocks. **Filter:** skip any `SEVERITY=minor` **unless** its
`CATEGORY` is `security` (security minors still get an issue — never silently drop a security
finding). **Deduplicate** findings sharing the same `(FILE, CATEGORY, DESCRIPTION)` tuple —
keep the highest severity.

For each surviving finding, open a GitHub issue:

- **Title** carries a stable, grep-able prefix so downstream watchers can regex on it — use a
  consistent `[review-all-day] ` prefix (with the trailing space) character-for-character.
- **Labels**: a base `review-finding` label, plus a `bug` label when the category is
  `bug-insert`, `regression`, or `security`. Create labels idempotently.
- **Body**: the source commit (SHA · branch(es) · authored date), the `path:line` location,
  the problem (DESCRIPTION), the suggested fix, and a detection footer naming this command,
  the codename, and the window `[SINCE, UNTIL]`.

If `gh issue create` fails (rate limit / network / auth), record the failure, continue with
the rest, and report the failed count in Step 6 — do NOT abort the whole run on one hit.

Each opened fix can be routed to **`/keel:ship`** for the windowed, locked backbone — this
command is scan-and-file only and never edits code, pushes, or merges.

## `--dry-run`

Run Steps 0–4 read-only (including the reviewer fan-out, so findings stay meaningful) and
print what **would** be opened (title prefix + labels + severity per surviving finding).
Redirect every `gh issue create` to a logged `DRY-RUN: <action>` line; open no issues, create
no labels.

## Step 6 — Final report (printed to the user)

Always print a terse report on exit, even if partial:

```
Review window: <SINCE> .. <UNTIL>
Commits scanned: <COMMIT_COUNT>
Strategy: <batch|fan-out>
Findings (serious): <N>
Issues opened: <opened>/<N>  (failed: <failed>)
Clean commits: <COMMIT_COUNT - findings_with_distinct_shas>
```

If at least one issue was opened, list the new issue numbers and titles below so the user can
click through.

## Stop conditions

- `git log` returns no commits in the window ⇒ exit cleanly with the "0 commits" report.
- `gh` reports `403: API rate limit exceeded` during issue creation ⇒ stop creating new
  issues; list the unfiled findings under "Findings not filed (rate-limited)" so the user can
  re-run later.
- A reviewer subagent fails to return findings (timeout / error) ⇒ note the SHA(s) under
  "Findings not filed (review failed)" and continue with the others.
- User cancels.

Always print the final report on exit, even if partial.

## Invariants (never overridable)

- **Read-only w.r.t. git**: never `git commit`, `git push`, `git checkout`, `git merge`,
  `git rebase`, or any working-tree mutation.
- **No PR writes**: no PR comments, no PR reviews, no branch creation. Only `gh issue create`
  is a permitted state-changing call; the orchestrator owns it.
- The title prefix MUST be preserved character-for-character — downstream tooling matches on
  it.
- **Reviewer subagents are findings-only**: they never read another reviewer's output
  (fan-out) and never call any GitHub write API.
- Branch scope is the trunk (`base_branch`) + active work branches only — never widen to all
  remote branches.
- The span timezone + boundaries come from the project config via `keel window` — never inline
  a timezone or offset, and keep it in lockstep with `/keel:ship`'s window resolution.
- Fail-soft (a missing tool/gate degrades to a skipped check, never aborts) · deterministic
  ordering (same commits ⇒ same findings ⇒ same issues).

<!-- keel-generated: surface=claude command=review-all-day keel_version=1.6.5 source_sha256=842cce774206617213e7abe7c71913873a7cf78c1bcfd8b65800440611f9b6c5 generated_sha256=842cce774206617213e7abe7c71913873a7cf78c1bcfd8b65800440611f9b6c5 -->
