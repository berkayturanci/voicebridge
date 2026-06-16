---
description: Codebase-wide regression scan — fan out per-area review subagents in parallel, dedupe against existing issues, open fix issues for high-confidence findings, and hand each to keel:ship.
argument-hint: "[--scope <changed|full>] [--since <ref>] [--dry-run]"
allowed-tools: Bash(keel:*), Bash(git:*), Bash(gh:*), Read, Edit, Agent
---

# /keel:regression

## Live progress — stamp this run (required)

So this run shows live on `keel-visual`'s board, record it with `keel activity` **as you
go**. This command's phases are: `orient` → `preflight` → `fanout` → `aggregate` → `dedupe` → `open` → `report`. Pick one stable `--run-id` for the whole run
(e.g. `regression-<issue-or-pr>`):

- **Right now, before the work below**, stamp the first phase:
  `keel activity .keel/project.yaml --root . --write --command regression --run-id "$RUN" --phase orient`
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

Project-neutral, codebase-wide regression scan. Surfaces real bugs and regressions
as new GitHub issues without duplicating issues that already exist, then routes each
fix to `/keel:ship`. Every project specific (the base branch, the risk areas, the
test/build command) is read from `.keel/project.yaml` via the `keel` CLI — nothing is
hardcoded here.

## Step 0 — orient (deterministic, via the CLI)

```bash
keel validate .keel/project.yaml --root .     # config + extensions must be valid
keel plan     .keel/project.yaml --root .     # read base_branch, tier3_globs, ci_workflows
keel plan     .keel/project.yaml --root . --command regression --live --json
keel regression .keel/project.yaml --root . --scope full --live --json
```

The live regression contract is the operator-consent preflight and includes
`scan_contract`: configured areas, active branch policy, dedupe rules, issue labels, and
dry-run write suppression. Before creating scan worktrees, spawning
reviewers, opening issues, handing fixes to `/keel:ship`, using secrets, publishing, or
calling production-adjacent systems, parse `contract.operator_consent`; if
`requires_operator_consent` is true, STOP and ask the operator to rerun with the required
`--approve-scope` values. Pass `operator_consent.delegated_agent_scope` into every reviewer
or fix handoff. Delegates may use only `approved_mutation_scopes`; scope expansion blocks
or escalates.

Read `base_branch`, `tier3_globs`, and scan areas from the contract. `tier3_globs` is
the risk map used to tier every finding (Step 2), while `policy_pack.scan.areas` owns the
project-specific fan-out modules. `gh` (or its MCP equivalent) is required
for the issue list/search/create calls; if it is unavailable, exit cleanly with a single
note rather than partial-running.

## Step 1 — preflight + canonical scan target

1. **Codename.** Mint a per-run codename `REGRESSION-<UTC_TIMESTAMP>` and state it in the
   first user-facing line.
2. **Clean tree.** Refuse if the working tree is dirty — a scan against an unstable tree
   produces noise. Abort with a one-line message.
3. **Scan canonical, not the local checkout.** The scan target is `base_branch` at its
   canonical head, not the operator's branch — otherwise patterns already fixed on
   `base_branch` but still present in a stale local checkout become false positives.
   Fetch `base_branch`, then add a **detached, read-only worktree** at its head and point
   every subagent's `Read`/`Grep`/`Glob` at that worktree path. Register cleanup (remove
   the worktree) on EXIT/INT/TERM so a mid-run abort never leaks it.
4. **Lag warning.** If the local checkout lags `base_branch` by a large margin, warn loudly
   that the scan runs against canonical via the worktree and that the operator should also
   reconcile their branch — but proceed.
5. **Scope.** `--scope full` (default) scans the whole tree; `--scope changed` limits the
   scanned set to `git diff base...HEAD`. `--since <ref>` overrides the diff base.

## Step 2 — area fan-out (parallel, read-only)

Spawn one reviewer subagent per top-level project area in **a single Agent-tool message**
so they run concurrently. Derive the area list from the repository layout; areas must be
**disjoint by construction** (no two agents see the same path) so findings cannot be
double-reported. Each agent receives an **absolute path inside the canonical worktree** —
verify the worktree head matches `base_branch` before scanning.

Each area agent is **strictly read-only**: no issue create/edit/close/comment, no PR
writes, no `git commit`/`push`/`reset`, no `Edit`/`Write`, and no catch-all API escape
hatch. The orchestrator owns every state-changing call. Agents scan for these regression
classes:

1. **Logic errors** — off-by-one, wrong branch/operator, unreachable code, swapped args.
2. **Null-safety / nil-deref** — force-unwraps on nullable values, missing guards,
   read-before-init.
3. **Lifecycle / concurrency** — leaked scopes/handles, thread/isolation confinement
   violations, blocking calls on a UI/main path, unclosed resources.
4. **Deprecated API usage** — platform/SDK/runtime deprecations relevant to the project's
   declared targets.
5. **Security** — OWASP-class issues, over-permissioned rules, hardcoded secrets/keys/tokens,
   logs that leak PII or credentials.
6. **Performance** — N+1 access patterns, redundant reads, large allocations on a hot path,
   missing pagination.
7. **Missing tests** — public surface with no coverage and no documented stub reason,
   untested error paths.
8. **Misconfiguration** — config/schema that contradicts documented behaviour; drift between
   a shared schema source and the consumers that model it.

Each agent returns a structured finding list (one entry per finding) with: `severity`
(`blocker|major|minor|low-confidence`), `paths` (`;`-separated for multi-file findings),
`line` (int / range / empty for cross-cutting), `type` (one of the eight tags above),
`description` (one sentence), `suggested_fix` (file/line-targeted), and `confidence`
(`high|medium|low`). Confidence rubric: **high** = the offending line is quotable and the
failure mode is reproducible by inspection; **medium** = the smell is real but needs runtime
context (tiebreaker: if a specific input/call-site is required to manifest, it is medium even
if quotable); **low** = speculative. Prefer fewer high-confidence findings over broad
speculation. Agents must NOT return advisory `nit`-level findings — they are dropped at
aggregation by design.

## Step 3 — aggregate + second-pass confidence

Collect every agent's findings into one list, then:

1. **Drop low-confidence** findings from the issue-creation set (still surfaced in the final
   report under "review-only").
2. **Within-agent dedup.** Collapse a repeated `(path, line, type)` triple to one. Keep
   distinct lines of the same `(path, type)` — they may be separate defects.
3. **Severity sanity.** `blocker` requires high confidence; downgrade to `major` if only
   medium. Drop any stray `nit`.
4. **Tier every finding** via `tier3_globs`: a finding whose `paths` match a tier-3 glob is
   escalated (higher reviewer/priority weight, tier label on the issue).

The remainder is the **issue-creation candidate set**.

## Step 4 — dedupe against existing issues

Pull existing issues two ways and union them, deduped by issue number:
- the **labelled** set (state = all, the `regression` label), and
- a **search** set (issues whose title/body mention regression).
Cap each query at a bounded window; validate each payload is well-formed before the union;
on a rate-limit/network error, emit the partial report and exit cleanly (never feed a
truncated payload into the dedupe).

A candidate is a **duplicate** only when **all** hold:
1. **Path match** — split `paths` on `;`, tokenise each path on `/`, `:`, whitespace, and
   quote characters, and require **every** token to appear as a whole token in the existing
   issue's title + body opening (substring hits inside longer tokens do not count). For
   multi-file findings, **every** path must match.
2. **Type match** — the finding's `type` tag appears as a label or as a whole token in the
   body opening.
3. **Near-text match** — token Jaccard similarity `|A ∩ B| / |A ∪ B| ≥ 0.6` between the
   candidate's first description sentence and the existing issue's title + body opening, both
   normalised to lowercase, diacritics stripped, non-alphanumerics spaced, stop-words removed.
   Edge case: if both sides reduce to empty, define Jaccard = 0 (never `0/0`, never an
   automatic match).

"Body opening" = the first ~200 characters of the body after stripping leading whitespace and
any leading heading lines.

Outcome by state:
- **Match against an OPEN issue** → drop the candidate; record under "duplicates skipped"
  with the issue number.
- **Match against a CLOSED issue** → **promote** to a regression-of issue (do not silently
  swallow): open a new issue titled `Possible regression of #N — <summary>` with a grep-able
  `regression-of: #N` cross-reference line at the bottom of the body.

## Step 5 — open fix issues (orchestrator only) and route to ship

Wrap the dedupe queries (Step 4) and every issue-create call in a single locked critical
section — a `mkdir`-based mutex held for this span only — so two concurrent `/keel:regression`
runs cannot race and double-open. Run the whole span inside one shell invocation so the
release trap stays alive across the sweep; recover a stale lock by checking the owner PID and
reclaiming if dead. Area agents in Step 2 are read-only and need no lock.

For each remaining candidate, open a GitHub issue with: a one-line problem statement, the
`path:line` location, reproduction/evidence (the grep/snippet), the suggested fix, and a
severity justification. Label by **severity** and by **tier** (tier-3 findings carry the
tier label). For a promoted regression-of candidate, use the regression-of title and append
the `regression-of: #N` line as the body's last line. Create labels idempotently. Capture each
opened issue number.

Hand each opened fix to **`/keel:ship`** (or a `--delegate` agent) — never auto-merge a fix
here. `/keel:regression` is scan-and-file only.

## `--dry-run`

Run Steps 0–4 read-only and print the candidate set, the dedupe outcomes, and what would be
opened (tier + severity per candidate). Open no issues, take no lock, route nothing.

## Step 6 — final report

Always print a final report, even on partial/early exit: codename; areas scanned + file/line
counts; findings raw → after-confidence → duplicates-skipped (with refs) → promoted-regressions
(with refs) → opened; severity distribution; the opened-issue list; and a "review-only"
section for the dropped low-confidence findings.

## Stop conditions / invariants

- Every area agent returned (or was timed out / skipped) — a per-agent timeout skips just that
  area and flags it under "open questions"; the others still proceed.
- A rate-limit/network error prints the partial report and exits without further writes.
- **Area agents are read-only**; only the orchestrator opens issues or creates labels.
- Never open an issue for a low-confidence or `nit` finding; never re-open against an OPEN
  duplicate (CLOSED matches are promoted, not dropped).
- Fail-soft (a missing tool degrades to a skipped check) · deterministic grouping (same
  findings ⇒ same issues) · `/keel:regression` never edits code, pushes, or merges — fixes go
  through `/keel:ship`'s backbone (window + lock + review).

<!-- keel-generated: surface=claude command=regression keel_version=1.6.5 source_sha256=148d0e8ebc7bc6cbcc8105de5617725b5abdb69818754f5c4ed4445a43543dfb generated_sha256=148d0e8ebc7bc6cbcc8105de5617725b5abdb69818754f5c4ed4445a43543dfb -->
