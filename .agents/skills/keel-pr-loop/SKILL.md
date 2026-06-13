---
name: keel-pr-loop
description: Iterate on an open PR's review comments + CI until checks are green and reviewers are satisfied, then hand off to the windowed merge (s6–s12, standalone).
---

# keel-pr-loop

Use this skill when the user asks to run the keel command `pr-loop` (e.g. `keel pr-loop ...`, `pr-loop <args>`, or `/keel:pr-loop`). It reads every project value from `.keel/project.yaml` via the `keel` CLI.

# /keel:pr-loop

## Command step evidence

Every numbered step in this command is contractual. Complete the step, record the
evidence it asks for, or explicitly mark it `N/A — <reason>` before moving on. If a step
has an external side effect such as a GitHub comment, issue, review, report, branch, or
PR, the side effect must be posted or written through the selected transport and cited in
the final summary. Never silently skip a step because the runtime, agent, or prompt feels
obvious.

Drive an already-implemented branch from open PR to merge-ready over the fixed keel
backbone (`s6`–`s12`): open the PR, wait for CI, run the review+gate+fix loop, and hand a
clean PR to the windowed, locked merge. **Project-neutral** — every project specific
(`base_branch`, `build_gate_cmd`, `lint_cmd`, `ci_workflows`, `implementer_agents`,
`tier3_globs`, `merge_window`, `merge_window_mode`) is read from `.keel/project.yaml` via
the `keel` CLI. If you are about to type a literal branch name, build command, CI workflow
name, timezone, or agent — stop and read it from config instead.

## Step 0 — Resolve config + plan

```bash
keel validate .keel/project.yaml --root .   # abort if config/extensions are invalid
keel plan     .keel/project.yaml --root .    # the run plan: backbone s6–s12 with this
                                             # project's gates + Lego extensions slotted in
keel plan     .keel/project.yaml --root . --command pr-loop --live --json
```

The live plan is the operator-consent preflight. Before pushing, opening/updating a PR,
posting reviews/comments, committing fixes, merging, using secrets, publishing, or calling
production-adjacent systems, parse `contract.operator_consent`; if
`requires_operator_consent` is true, STOP and ask the operator to rerun with the required
`--approve-scope` values. Pass `operator_consent.delegated_agent_scope` into any delegated
review/fix agent brief. Delegates may use only `approved_mutation_scopes`; scope expansion
blocks or escalates.

Read the knobs you will need: `base_branch`, `ci_workflows` (name → path glob),
`build_gate_cmd`, `lint_cmd`, `tier3_globs`, `implementer_agents`, `merge_window`,
`merge_window_mode`.

Resolve GitHub access through the shared runtime contract (`keel capabilities --json` →
`github_transport`). Use the selected transport for all issue/PR/check/comment/review
operations and treat any `github_transport.degraded` operation as an explicit limitation.
Do not duplicate a local `gh` vs MCP capability table in this adapter.

## Step 1 — Find the PR

- If a PR number is given as `$1`, use it. Otherwise auto-detect the open PR for the
  current branch through the selected GitHub transport (the first open PR whose head is
  the current branch).
- If no PR exists for the current branch, halt and report — do not proceed.
- **Workspace isolation:** this command runs `git commit` / `git push` against the working
  tree, so it MUST run from a **linked worktree**, never the user's primary checkout.
  Detect with `git rev-parse --git-dir`: the primary checkout returns `.git`; a linked
  worktree returns an absolute path containing `/.git/worktrees/<name>`. If the value is
  `.git`, ABORT and tell the user to re-run from the PR's worktree (`git worktree list`).
  If this command must create the worktree for the PR, use the project's nested convention
  (project-specific path layout; stays in the project) — never the user's primary tree.

## Step 2 — Open / confirm the PR (s6 entry)

Push the branch and open the PR against `base_branch` if it is not open yet. Otherwise
push any local commits so the PR head matches your working tree.

## Step 3 — Read everything

Gather the full PR state before deciding anything:

- The conversation timeline (issue-level comments).
- The inline review-comment threads (`file:line` anchored).
- Reviews + the overall review decision.
- The last few CI runs for the branch and their status/conclusion per workflow in
  `ci_workflows`.
- If CI is failing and `raw_actions_logs` is supported, fetch the failed-run log (tail it)
  so fixes are evidence-based. If raw logs are degraded, quote the check name/details URL
  and reproduce locally; do not imply raw-log access was available.

## Step 4 — Categorize feedback

Group every review comment into:

- **Must-fix** — correctness, security, data-safety, and any project-defined
  high-risk rules (the tier-3 areas implied by `tier3_globs`).
- **Should-fix** — style, naming, performance.
- **Skip** — opinion differences / wontfix (record the reason).
- **Reply-only** — questions needing a text reply, not a code change.

## Step 5 — Fix and reply (s9 fix loop)

For each must-fix and should-fix, smallest change first:

1. Read the relevant source file.
2. Make the minimal, targeted fix.
3. Run the relevant gates locally: `keel run-gates .keel/project.yaml --root .` (executes
   the project's `build_gate_cmd` / `lint_cmd` and any `tester` Lego; critical/major =
   block, minor = suggest, nit = advisory).
4. Commit with a clear message (e.g. `fix: address review comment — <short description>`).

Reply to reply-only comments with a text answer; note skipped comments with the reason.

## Step 6 — Self-review before push (mandatory)

Read the full diff against `base_branch` (`git diff origin/<base_branch>...HEAD`) top to
bottom and verify:

- **Scope** — only files within the issue / CI-fix scope changed.
- **Security** — no injection, secrets, or hard-coded credentials introduced.
- **Dead code / stale refs** — no leftovers from deleted or moved code.
- **CI prediction** — for every changed file, answer "what would make CI fail here?"
- **Test coverage** — changed logic has new or existing test coverage.

If self-review finds a problem (out-of-scope change, security risk, CI risk) → return to
Step 5, fix, re-commit, then restart Step 6.

## Step 7 — Push

`git push`. (Under `--dry-run`, log `DRY-RUN: git push` and do not push.)

## Step 8 — Review + gates (s7) — required after every code-change push, CI fixes included

Run **N reviewers** (host agent, or the agent from `--review-delegate`) plus any
`reviewers` Lego extensions. Spawn them in **parallel** in a single Agent-tool message;
give each a fresh codename and the no-cross-reading instruction (a reviewer must never read
another reviewer's output). Each reviewer verifies it is reviewing the **PR head SHA**,
returns structured findings only (severity + `file:line`), and does **not** call any
GitHub write API — this command (the orchestrator) posts. Reviewer count and focus split
follow the project's risk tier from `keel ship`; reviewers draw their rubric (severity
vocabulary, PR-head-SHA verification, return format) from the canonical reviewer rubric,
not from inline heuristics here.

Then run `keel run-gates .keel/project.yaml --root .` (build / lint / **jury** / tester) so
gate findings join the reviewer findings on the same severity scale.

## Step 9 — Post findings (per `--review-comments`, inline-hybrid default)

- **inline** (default): anchor every **critical/major** finding as an inline comment on its
  `file:line`, plus a single summary comment. critical/major = **block**; minor = **suggest**;
  nit = **advisory**.
- **summary**: post one consolidated comment with all findings in a severity table.

## Step 10 — Re-check CI

Wait for the workflows in `ci_workflows` to go green (`gh pr checks`). Re-kick transient
failures; surface real ones (re-enter Step 5 with the failed-log evidence). Do **not**
advance to the close-out while CI is red.

## Step 11 — Collect findings and close the loop

- **Blocking finding (critical/major) remains** → return to Step 5, fix, re-commit, then
  re-run Steps 6 → 7 → 8 → 9 → 10 → 11.
- **No blocking findings AND every suggestion either applied or explicitly user-deferred
  (recorded as a tracked issue AND surfaced to the user) AND CI green** → exit the loop.
  Nits SHOULD be applied where reasonable; an unapplied nit is noted but does NOT gate exit.
- Cap the fix rounds at the project's round budget (≤3 by default); if the budget is spent
  with blockers remaining, stop and report the verdict rather than forcing a merge.

CI green is required on **every** exit path. Never exit this loop with CI red.

## Step 12 — Summary + handoff

Post one summary comment on the PR listing: what was addressed (with file refs), what was
intentionally skipped and why, and the per-reviewer verdicts. Then hand the clean PR to the
windowed, locked merge:

```bash
keel ship .keel/project.yaml --root . --pr <N>   # confirm the decision is MERGE
```

The actual **s10 merge** happens only inside the merge window (`keel window`), holding the
merge lock, after a final re-confirm of green CI + zero blocking findings → squash-merge;
then capture the run (for `/keel:wrap`), close the linked issue, and drop the lock. Outside
the window, `merge_window_mode` decides: `pause` halts, `freeze` defers.

## Invariants (never overridable)

merge lock · night no-merge window · fail-soft (a soft gate/extension failure degrades to a
no-op, never aborts) · orchestrator-only-writes (reviewers return findings; this command
posts them) · vendor+model attribution.

## `--dry-run`

Do every read plus `keel validate` / `keel plan` / `keel run-gates`, but redirect every
state-changing `git`/`gh` write to a logged `DRY-RUN: <action>` line. No push, no PR, no
merge.

<!-- keel-generated: surface=skills command=pr-loop keel_version=1.2.3 source_sha256=c0543e98390a3c6cfab487ef0c9f06ef6340be0a0208dfcc49bf9b2da18ee0a1 generated_sha256=383547b288af9b6a4afead175ad223a153ae1b31b3aa217ff2f012d339a5470d -->
