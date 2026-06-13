---
description: Multi-reviewer review→fix cycle over one or more open PRs — parallel reviewers, structured findings, inline-vs-summary posting, capped fix rounds (s7+s9, standalone). Does not merge.
argument-hint: "[pr number ...] [--review-delegate <...>] [--review-comments <inline|summary>] [--dry-run]"
allowed-tools: Bash(keel:*), Bash(git:*), Bash(gh:*), Bash(jury:*), Read, Edit, Agent
---

# /keel:review-cycle

## Command step evidence

Every numbered step in this command is contractual. Complete the step, record the
evidence it asks for, or explicitly mark it `N/A — <reason>` before moving on. If a step
has an external side effect such as a GitHub comment, issue, review, report, branch, or
PR, the side effect must be posted or written through the selected transport and cited in
the final summary. Never silently skip a step because the runtime, agent, or prompt feels
obvious.

The standalone review→fix loop (`s7` + `s9`) over one or more existing PRs. For each PR, a
set of reviewers reviews the same diff **in parallel**, findings are posted per the chosen
posting mode, blocking findings drive a capped fix loop, and the loop exits clean or at the
budget. **Project-neutral** — every project specific (`base_branch`, `build_gate_cmd`,
`lint_cmd`, `ci_workflows`, `tier3_globs`, `implementer_agents`) is read from
`.keel/project.yaml` via the `keel` CLI. Never inline a branch name, build command, CI
workflow name, or agent here.

This command **does not merge**, never opens/closes PRs, and never pushes outside its own
fix loop on the PR's own branch. Hand a clean PR back to `/keel:ship` (or `/keel:pr-loop`)
for the windowed, locked merge.

## Step 0 — Resolve config + parse args

```bash
keel validate .keel/project.yaml --root .
keel plan     .keel/project.yaml --root .    # read tier3_globs, ci_workflows, gates
keel plan     .keel/project.yaml --root . --command review-cycle --live --json
```

The live plan is the operator-consent preflight. Before posting reviews/comments,
committing/pushing fixes, using secrets, publishing, or calling production-adjacent systems,
parse `contract.operator_consent`; if `requires_operator_consent` is true, STOP and ask the
operator to rerun with the required `--approve-scope` values. Pass
`operator_consent.delegated_agent_scope` into every reviewer/fixer brief. Delegates may use
only `approved_mutation_scopes`; scope expansion blocks or escalates.

Argument grammar: zero or more PR numbers (positive integers, space-separated). Reject any
non-integer / negative / zero argument and comma-separated lists. With **no PR argument**,
default to the open PR for the current branch. State the parsed PR list in your first
user-facing line.

Resolve GitHub access through the shared runtime contract (`keel capabilities --json` →
`github_transport`). Use the selected transport for PR reads, comments, reviews, file
lists, and check data. If an operation is listed in `github_transport.degraded`, surface
that limitation and avoid hidden best-effort behavior.

## Step 1 — Validate PRs

For each PR number, confirm it exists and is open through the selected GitHub transport,
reading `number`, `state`, `isDraft`, `headRefName`, `baseRefName`, `title`, and `url`.
Drop already-merged/closed PRs — warn and list them under "Skipped" in the final report.
Continue with the remaining open or draft PRs. If the selected transport returns a network,
auth, or rate-limit error, stop and surface the error; the final report still covers what
completed.

## Step 2 — Per-PR loop (sequential across PRs)

Process PRs **sequentially** — only one PR in active review at a time, so the timeline stays
readable and rate-limit pressure is bounded. Within a single PR the reviewer fan-out at
Step 3 is genuinely parallel. State the current PR and a one-line title as you start each
one. Do not advance to the next PR until Steps 3–6 complete (or the PR is marked failed and
skipped per Stop conditions).

## Step 3 — Run the reviewers (parallel, single Agent-tool message)

Resolve the **reviewer count** and risk tier from `keel ship .keel/project.yaml --root .
--pr <P>` (uses `tier3_globs`). Spawn that many reviewers (host agent, or the agent from
`--review-delegate`) **in a single Agent-tool message** so they run concurrently, plus any
`reviewers` Lego extensions. Split focus across reviewers (e.g. code-quality &
architecture; bugs & security; tests & regression) — the exact split scales with the
reviewer count; reviewers draw their full rubric (severity vocabulary, return format,
PR-head-SHA verification) from the canonical reviewer rubric, not from inline heuristics
here.

Each reviewer prompt MUST carry:

- A **fresh codename** per reviewer (unique per PR and per cycle), used as the audit-trail
  identifier on its findings.
- The **no-cross-reading** rule: a reviewer must be fully independent and must NOT read any
  other reviewer's output. When a reviewer reads PR context, it skips every comment whose
  body carries this command's codename prefix — that prefix covers both the current cycle's
  sibling reviewers and every prior cycle on the same PR. The shared codename prefix is the
  canonical isolation pin; do not rely on heading-text matching, since prior summaries reuse
  the same heading format.
- The **posting contract** for the chosen `--review-comments` mode (see Step 4) — stated
  explicitly so a reviewer never silently inherits a different default.
- **PR-head-SHA verification**: the reviewer confirms it reviewed the current PR head SHA.

Each reviewer returns the **same findings** to the orchestrator in a machine-readable block
(codename · focus · verdict · per-severity counts `blocker/major/minor/nit` · clean areas ·
`severity | file:line | description | suggested fix` rows) so the orchestrator can build the
consolidated summary without re-parsing GitHub.

### Severity mapping

critical/blocker ≡ must-fix; SUGGESTION ≡ should-fix splits into **major** (not fixing it
meaningfully degrades maintainability / robustness / test confidence) vs **minor**
(otherwise); **nit** is advisory. A reviewer commits to one classification per finding —
the comment table and the returned counts use the same split, no parallel taxonomies.

## Step 4 — Post findings (per `--review-comments`, inline-hybrid default)

- **inline** (default, "inline-hybrid"): anchor every **critical/major** finding as an
  inline comment on its `file:line`, plus one summary comment per reviewer. critical/major =
  **block**; minor = **suggest**; nit = **advisory**.
- **summary**: each reviewer posts a single consolidated comment with all its findings in a
  severity table (`blocker / major / minor / nit` rows; omit empty rows; "No findings" if
  clean).

**Who posts** is a project policy knob (project-specific; stays in the project):

- By default keel uses **orchestrator-only-writes** — reviewers return findings, the
  orchestrator posts them (one timeline entry per reviewer, then the consolidated summary).
- A project MAY opt into **reviewer-posts-directly** via a `reviewers` Lego / config flag,
  where each reviewer posts its own findings comment directly and the orchestrator posts
  only the consolidated summary. When this mode is active it MUST be stated explicitly in
  every reviewer prompt; a reviewer that silently inherits orchestrator-only-writes is a
  contract violation — surface it in the PR's failed-reviewer note.

Also run `keel run-gates .keel/project.yaml --root .` (build / lint / **jury** / tester) so
gate findings join the reviewer findings on the same severity scale.

## Step 4b — Consolidated summary

After all reviewers finish (each posted, if reviewer-posts mode, and each returned its
block), post **one** consolidated summary comment, ordered after the per-reviewer entries so
the timeline reads top-down (reviewers → summary). Include:

- A **severity histogram** = column-wise sum of every reviewer's counts
  (`blocker = ΣblockerᵢR`, likewise major / minor / nit).
- Aggregated **clean areas**.
- Per-reviewer verdicts (with codenames).
- A **merge recommendation**:

  | Condition | Recommendation |
  |---|---|
  | any verdict is "needs fixes" OR `blocker > 0` | ❌ block |
  | `blocker == 0` AND `major + minor > 0` | ⚠️ request changes |
  | `blocker + major + minor == 0` AND any "LGTM-with-suggestions" (nits only) | ✅ approve (cosmetic nits) |
  | `blocker + major + minor == 0` AND all reviewers LGTM (no nits) | ✅ approve |

  The histogram — not the verdict strings — is the source of truth: a reviewer returning
  LGTM while still emitting a `minor` finding downgrades the recommendation to ⚠️ via the
  count clause. SUGGESTIONs (major/minor) are gated like blockers; a non-zero `major + minor`
  is never an approve. This command is review-only, so resolution/deferral is the operator's
  follow-up.

Then apply the project's "review-cycle-complete" marker (label) **only after** the summary
is posted (project-specific label name; stays in the project) — never pre-apply it before
reviewers finish.

## Step 5 — Fix loop (s9, capped)

While **blocking findings** (critical/major) remain and the **round budget** (≤3 rounds by
default) is not spent: fix the smallest change first → re-run the relevant gates
(`keel run-gates`) → self-review the diff against `base_branch` → push → re-review (Step 3).
Stop when the diff is clean or the budget is exhausted; report the verdict either way. (If
this command is being driven in pure review-only mode for read-only PRs, skip the fix loop
and leave resolution to the operator.)

## Step 6 — Final report

After the PR queue drains, print a terse report: PRs requested / reviewed / skipped
(not open) / failed (with reason), and per-PR `recommendation` + `blocker/major/minor/nit`
counts, with links to the consolidated summary comments where practical.

## Stop conditions

- A reviewer fails to return its block AND fails to post (timeout / agent error) ⇒ mark
  THIS PR failed, skip its summary, continue with the next PR. Never abort the whole run.
- Reviewer posted but did not return its block (crash after the post) ⇒ re-fetch its comment
  and parse it with the same severity-table layout; success ⇒ treat as a successful
  reviewer, else failed.
- Reviewer returned its block but the post failed (rate limit / transient 5xx) ⇒ the
  orchestrator re-attempts the post from the returned block, up to 3 retries with
  exponential backoff (2s/4s/8s); still failing ⇒ failed reviewer.
- Partial reviewer failure (some succeed) ⇒ post the consolidated summary from the survivors
  with a clear "Reviewer N (focus …) failed: <reason>; histogram may be incomplete" note.
  Apply the completion marker only if a majority of reviewers succeeded; otherwise skip it
  and mark the PR failed.
- `gh` reports `403: API rate limit exceeded` ⇒ stop processing further PRs; list the
  remaining ones under "Not started (rate-limited)" so the user can re-run later.
- A PR is found merged/closed on the live re-check ⇒ skip it (already filtered at Step 1).
- User cancels.

Always print the final report on exit, even if partial.

## Invariants (never overridable)

- **Read-only w.r.t. git** outside its own fix loop on the PR branch: never `git checkout`
  another branch, `git merge`, or `git rebase` as a side effect.
- **Read-only w.r.t. PR state**: never `gh pr merge`, `gh pr close`, `gh pr ready`, or formal
  `gh pr review --approve` / `--request-changes`. Reviewers post regular comments only — the
  human owns the merge gate.
- **No-cross-reading** + per-reviewer codenames (the codename-prefix isolation pin).
- The completion marker is applied **only after** the consolidated summary posts; never
  pre-applied.
- Concurrent runs on the same PR are unsupported (no orchestrator-side per-PR mutex); the
  operator serialises.
- Fail-soft per PR (one PR's failure never aborts the queue); deterministic ordering.

## `--dry-run`

Do every read plus `keel validate` / `keel plan` / `keel run-gates` and the reviewer fan-out,
but redirect every state-changing `gh` write (comments, label) to a logged
`DRY-RUN: <action>` line.

<!-- keel-generated: surface=claude command=review-cycle keel_version=1.2.3 source_sha256=950f8d2ef9d84e486405a88aac1934713643bc41204254b978c5f49d27b11e25 generated_sha256=950f8d2ef9d84e486405a88aac1934713643bc41204254b978c5f49d27b11e25 -->
