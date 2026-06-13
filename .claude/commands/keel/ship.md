---
description: Drive a GitHub issue end-to-end through the keel backbone (select → branch → implement → CI → review → test → merge → close → capture), reading every project value from .keel/project.yaml via the keel CLI.
argument-hint: "[issue numbers...] [--compound|--profile <standard|compound>] [--delegate <claude|codex|agy|ollama:MODEL>] [--review-delegate <claude|codex|agy|ollama:MODEL>] [--review-comments <inline|summary>] [--reviewers <1|2|3>] [--jury|--no-jury|--jury-advisory] [--hotfix] [--dry-run] [--wizard]"
allowed-tools: Bash(keel:*), Bash(git:*), Bash(gh:*), Bash(jury:*), Read, Edit, Write, Agent
---

# /keel:ship

## Command step evidence

Every numbered step in this command is contractual. Complete the step, record the
evidence it asks for, or explicitly mark it `N/A — <reason>` before moving on. If a step
has an external side effect such as a GitHub comment, issue, review, report, branch, or
PR, the side effect must be posted or written through the selected transport and cited in
the final summary. Never silently skip a step because the runtime, agent, or prompt feels
obvious.

Project-neutral flagship workflow. **Every project value comes from `.keel/project.yaml`
via the `keel` CLI** — never hardcode a branch, command, glob, agent, timezone, window,
allowlist, or workflow name here. Reference knobs by name: `base_branch`, `build_gate_cmd`,
`lint_cmd`, `implementer_agents`, `tier3_globs`, `ci_workflows`, `docs_gate_paths`,
`merge_window`, `merge_window_mode`, `timezone`. Anything truly app-specific stays in the
project (config knobs, or a `.keel/extensions/` Lego), never inlined here.

All committed/published artifacts (commits, branch names, PR/issue titles + bodies,
comments, queue files) follow the project's language policy. Free-form chat with the user
may stay in any language.

## Step 0 (s0) — orient (deterministic, via the CLI)

```bash
keel validate .keel/project.yaml --root .     # config + extensions must be valid
keel plan     .keel/project.yaml --root .     # the backbone + this project's gates/Lego
keel plan     .keel/project.yaml --root . --command ship --live --json
keel window   .keel/project.yaml              # is the merge window open right now?
```

The live plan is the operator-consent preflight. Before s1 and before any branch,
worktree, GitHub write, delegation, secret, release, or production-adjacent access, parse
`contract.operator_consent`; if `requires_operator_consent` is true, STOP and ask the
operator to rerun with the required `--approve-scope` values. Do not infer secret or
credential approval from project knowledge. Store `operator_consent.delegated_agent_scope`
for every later delegated-agent brief.

`keel validate`/`plan` resolve `base_branch`, the knob commands (`build_gate_cmd`,
`lint_cmd`), `implementer_agents`, `tier3_globs`, `ci_workflows`, `docs_gate_paths`,
and the `tester` / `pre-merge` / `reviewers` / `capture` extensions. `keel window`
evaluates `merge_window` in the project `timezone` and reports `merge_window_mode`
(`pause` = halt outside the window; `freeze` = defer to the morning queue). The merge
resource claim is acquired and released by `keel merge` at the merge step (s10) only.

After s1 selects an issue, rerun the live preflight with the selected issue title/body/labels:

```bash
keel plan .keel/project.yaml --root . --command ship --live --json \
  --target "issue #<N>" \
  --issue-title "$ISSUE_TITLE" \
  --issue-body "$ISSUE_BODY" \
  --issue-label "$ISSUE_LABELS"
```

Parse `contract.issue_intake` before s2. If `status` is `needs-input`, post or ask the
generated `questions` and STOP that issue before branch/worktree/code mutation. If `status`
is `blocked` or `out-of-scope`, append or preserve the structured run-ledger record,
skip mutation, and move to the next selected issue when watch/work-block policy allows.
Only `ready` may proceed to s2. This is the same readiness discipline expected from a
human teammate: clarify the ticket before starting work and keep the clarification trail
in the run ledger.

**Run ledger.** Read `contract.run_ledger` from `keel plan --json` or the
`result.run_ledger` block from `keel ship --json`. Do not infer ship outcomes by parsing
free-form PR or issue comments. For live runs, append exactly one structured record with
`keel ship .keel/project.yaml --root . --live --append-ledger --run-id <id> --issue <N>
--pull-request <PR> --capture-status <applied|deferred|skipped[:reason]> --capture-reason <reason>
--implementer <agent> --reviewer-agent <agent> --tester <agent>
--host-agent <HOST_AGENT> --transport <gh|mcp> --profile <standard|compound>
--approve-scope <scopes>
--operator <operator> --json` after the ship assessment and capture status are known.
Pass the s0 preflight **run context** through: `--host-agent` (the resolved `HOST_AGENT`)
and `--transport` (the detected `gh`|`mcp` transport from s0); `--profile`, the jury mode,
and the consent summary are already available from the run and are stamped onto the
`ship_run` record so the s11 closure comment renders a durable **Run context** block.
`--transport` defaults to the transport keel resolved for the run when omitted. A missing
`--host-agent` emits a warning on live append; pass `--strict-run-context` when the run
should fail instead of producing a degraded closure audit trail.
If the configured ledger path is missing, treat it as empty history; if a ledger record is
malformed, stop capture/reporting and ask for operator help instead of silently falling
back to comment scraping.

**Checkpoint / resume.** Read `contract.checkpoint` from `keel plan --json` before live
work. At the start of a run, call `keel resume .keel/project.yaml --root . --json` and
inspect `resume_plan`. If it returns `no-checkpoint`, start normally. If it returns
`ambiguous`, stop and reconcile the PR/worktree state it names before doing any mutation.
If it reports a merged PR, resume at capture or closeout; never repeat the merge.

During live ship runs, write a checkpoint after each safe step boundary and before moving
to the next step:

```bash
keel checkpoint .keel/project.yaml --root . --write \
  --run-id "$RUN_ID" --checkpoint-command ship --step s6 \
  --target "issue #<N>" --issue-queue <N> --active-issue <N> \
  --branch "$BRANCH" --worktree "$WORKTREE" --pull-request "$PR" \
  --head-sha "$HEAD_SHA" --last-check ci
```

Update the arguments to match the actual boundary: completed steps, last gate/review/check,
merge state, capture state, close state, and stop reason. The checkpoint is the active
resume point, not run history. Do not delete or overwrite project extensions while writing
or resuming from it.

**GitHub transport.** Prefer the `gh` CLI when present (richer JSON, `--watch`); detect
once at session start (`command -v gh`) and, when absent, fall back to an equivalent
GitHub MCP/API transport for the same operations (issue read/list/comment/close/label,
PR read/create/ready/merge/branch-update, check-runs, review writes). Translate field
semantics consistently (e.g. mergeable-state `behind`/`dirty`, draft flag, base ref) and
poll-with-delay where no native `--watch` exists. The orchestrator passes the resolved
transport mode to the implementer so it uses the same one (push via `git push` first,
fall back to an API push on an HTTP 403). Raw failed-CI-log access may be unavailable on
the fallback transport — there the fixer gets the check name + details URL and reproduces
locally; if it cannot, mark blocked and quote the details URL. State the detected transport
mode in your first user-facing line, **and record it** (alongside the resolved host agent)
for the s11 closure comment: carry the transport (`gh`|`mcp`) and `HOST_AGENT` forward so
the `--append-ledger` call at s11 stamps them onto the `ship_run` record as durable PR
evidence (see s11). Evidence verification flags a closure Run context where every field
degraded as `run-context-empty`; do not treat an all-unknown Run context as acceptable
capture.

### Argument parsing

- **Bare positive integers** ⇒ explicit issue number(s). Reject zero/negative.
- `--compound` / `--profile <standard|compound>` — select the workflow profile. Default
  `standard`; `--compound` is an alias for `--profile compound`. The compound profile swaps
  the `s4`/`s7`/`s9`/`s11` steps to compound behavior (see the **Compound profile** section)
  without forking the backbone. Composes with every other flag (e.g. `--compound --jury`).
- `--delegate <claude|codex|agy|ollama:MODEL>` — the **implementer**. Per-run override
  of any issue role/delegate label. `ollama:` requires a non-empty model. Default: the
  **host agent** (the CLI driving this run).
- `--review-delegate <…>` — the **reviewer** vendor (same value set). Default: host agent.
- `--review-comments <inline|summary>` — how reviewer findings post (s7). Default `inline`.
- `--reviewers <1|2|3>` — override the tier-derived reviewer count. Default: auto (from tier).
- `--jury` / `--no-jury` / `--jury-advisory` — control the cross-vendor jury gate (s8).
  Precedence `--no-jury` > `--jury` > tier-3 auto > off. `--jury-advisory` = report-only.
- `--hotfix` — audited merge-window bypass (s10). Use sparingly.
- `--dry-run` — read-only rehearsal (see `--dry-run` section).
- `--wizard` — interactive opt-in only; runs the guided pre-s1 config collector (see
  `--wizard` section). In any non-interactive context it degrades to a logged no-op.

Reject unknown `--flags`, out-of-range `--reviewers`, an empty `ollama:` model, a flag
missing its value, or a negative/zero positional. A flag and its value must appear
together; positionals are everything not consumed by a flag. Repeated single-value flags
(e.g. `--reviewers 2 --reviewers 3`) are user error. With **no issue numbers**, run in
watch mode: take the top of the backlog (s1). Resolve **`HOST_AGENT`** from the runtime
(the CLI executing this command: `claude` / `codex` / `agy`) — it is the default
implementer and reviewer; a delegate label or an explicit `--delegate`/`--review-delegate`
overrides it. State the detected window state and host agent in your first user-facing line.

## Backbone (do not reorder; the step IDs are fixed)

### s1 select
Take the issue(s) from args, or the top of the backlog (highest priority first, then
ascending issue number; cap the watch-mode batch and let the next run pick up the rest).
Validate each issue (skip/warn on closed ones); on a `gh` rate-limit/auth/network error,
log partial state and stop. Snapshot the queue once — do not re-poll mid-session. If the
queue is empty, log a one-line summary and exit.

For every selected issue, read title, body, and labels through the selected GitHub transport
and feed them into the issue intake preflight described in s0. In work-block/watch mode,
non-ready issues are skipped with their readiness reason and concrete questions recorded,
then the run continues with the next ready issue if one exists.

### s2 branch
Cut a work branch off `base_branch`. A **git worktree per issue** is the isolation
contract: never mutate the user's primary checkout. Create it under a gitignored,
repo-nested path (e.g. `worktrees/issue-<N>`); the worktree path is returned in the JSON
contract and hard-validated at s10 (must be nested under the repo root, never the repo
root or filesystem root). Every edit/build/push happens inside the worktree.

### s3 guard
Refuse if the working tree is dirty or the branch already has an open PR. **Blocker
auto-detection** (any rule promotes the issue to a window-bypassing blocker — see s10):
an explicit `--hotfix`/blocker flag; an alert/escalation label; a title/body match on a
**word-boundary, case-insensitive** blocker regex (CI breakage, data loss, security fix,
breaking change, crash, critical regression); a high-priority label plus an urgent-keyword
title (`critical|urgent|blocker`); or `base_branch` currently red on a **gating**
`ci_workflow` whose paths this PR touches. These are heuristics — humans override by
passing or omitting the blocker flag. Word-bounded regexes still match negated phrasings
("no crashes on…") — bounded false-positive risk, accepted. When the branch-scoped
red-`base_branch` signal is unavailable on the fallback transport, treat that rule as
no-fire and log it.

### s4 implement *(agent)*
Resolve the implementer: `implementer_agents` by the issue's role label, **overridden by
`--delegate`**, defaulting to `HOST_AGENT`. Precedence: `--delegate` flag > issue
`delegate:*` label > `HOST_AGENT`. Dispatch:

- **Host / Claude-class subagent** — pick the role agent from `implementer_agents` by the
  issue's labels/paths; run the standard implement brief.
- **Delegated CLI implementer** (`codex exec`, `agy --print`, an Ollama model) — write the
  prompt to a temp file and pipe via **stdin** (positional-arg passing hangs some CLIs);
  run in the project root with the vendor's **network-enabled** mode so it can reach the
  GitHub API (sandbox-blocking flags break PR creation). Pass any per-issue model override
  from a `delegate-model:<name>` label. A bare local model (Ollama) **cannot run tools** —
  there the orchestrator does every git/PR step itself and delegates only code generation
  (generate a unified diff against a size-limited slice of the in-scope files, apply it,
  run gates, then commit/push/open the PR); retry up to 2 times on a bad/unapplicable
  diff, then fall back. **Local-model implementers are refused on tier-3** (high-risk,
  per `tier3_globs`; pre-classified from the issue's target paths/labels before the diff
  exists, ambiguous ⇒ treat as tier-2 and let s7 gate) — fall back to `HOST_AGENT` there.

Every implementer (delegated or not) receives the same brief plus:
- The approved `operator_consent.delegated_agent_scope`. If the implementer attempts work
  outside `approved_mutation_scopes`, the orchestrator blocks or escalates instead of
  silently continuing. Secret access requires the explicit `secrets` scope for this run.
- Worktree isolation + branch-off-`base_branch` + a detailed PR body + open as **draft**.
  When `keel ship --json` exposes `result.artifact_bodies.pr_body`, use that rendered
  body as the PR-body shape and fill in the concrete implementation/testing details before
  opening or updating the PR. The PR body MUST NOT be only a closing reference. It must
  include at least: `Context / Root Cause`, `Changes Made`, `Testing`, `Docs Impact`, and
  a final `Closes #<N>` reference. If any section is not applicable, write
  `N/A — <reason>` inside that section instead of omitting it.
- A pre-push scope self-check: `git diff base_branch...HEAD --name-only`, revert anything
  outside the issue's scope.
- The vendor's `Co-Authored-By:` trailer on every commit.
- **The JSON return contract** as the final fenced block of the response:
  ```json
  { "pr_number": <int>, "branch": "<string>", "files_changed": ["<string>"],
    "test_results": "<string>", "codename": "<string>", "worktree_path": "<abs path>" }
  ```
  The orchestrator parses this for s5/s10. `worktree_path` must be the absolute path passed
  to `git worktree add`. Free-text above the block is fine; the JSON envelope is the contract.

**Quota / unavailability fail-over.** On a missing CLI, nonzero exit with no parseable
JSON, or a quota error (HTTP 429 / RESOURCE_EXHAUSTED — do **not** retry; quota resets
slowly), fall back to `HOST_AGENT` and log the reason. A local-model harness that already
created a worktree must remove it before the host path recreates one at the same path
(same obligation under `--dry-run` if it created one).

**Attribution (mandatory on every path, even a plain run).** Record and persist a vendor
label and the full `IMPLEMENTER_SYSTEM` string (vendor + model when known, e.g.
`codex:<model>`, `ollama:<model>`). When a specific model is known, also add a versionless
`model:<base>` label (strip an Ollama `:tag`; drop a trailing numeric run on non-hyphenated
families, e.g. `<word>2.5`→`<word>`; keep `<word>-<major>` on hyphenated ones, dropping a
`.minor`). Attribution always reflects the **effective** implementer that actually ran —
never the requested-but-fell-back one — and is written at label-flip time (skipped only
under `--dry-run`, logged instead).

After the implementer returns, the **orchestrator** runs a **branch-scope validation gate**:
diff `base_branch...origin/<branch>`, compare against the declared `files_changed`, and if
anything falls outside the issue's scope (and is not a `docs_gate_paths` exempt path), hand
it back for **one** correction pass; if it persists, mark blocked and quote the offending
files. (One pass is intentionally stricter than the CI budget — the implementer's own
pre-push self-check should have caught drift; a second failure is systemic.) Docs-only PRs
(all paths in `docs_gate_paths`) treat the scope check as advisory. This gate is the primary
defence against branch contamination — it catches scope creep before review spends budget.

### s5 classify
`keel ship .keel/project.yaml --root .` prints, deterministically: the **risk tier** (from
`tier3_globs` against the diff) → reviewer count, the window state, the gate results, and
the merge decision. Tiers: **tier-3** (any `tier3_globs` match → most reviewers + jury
auto-on), **tier-1** (all paths in `docs_gate_paths` → fewest reviewers), **tier-2**
(everything else). `--reviewers N` overrides the count but does **not** suppress the
tier-3 jury auto-trigger logic below; log the detected tier and reason
(`tier-<N> → reviewers=<N> (reason: <matched glob | docs-only>)`). When `--reviewers` is
passed the tier is not computed, so the tier-3 jury auto-trigger does not apply.

**Jury enablement** (always evaluated, even when `--reviewers` was passed; precedence
`--no-jury` > `--jury` > tier-3 auto > off): tier-3 ⇒ auto-on. Mode is **gating** by
default (`--jury-advisory` ⇒ advisory-only). The jury never changes the reviewer count.
Log the decision (`jury: enabled (reason; mode) / disabled`).

### Step boundary verification
At every successful backbone transition, persist the canonical JSON handoff produced from
`keel.stepverifier.build_handoff`, write/update the checkpoint for the next safe boundary,
and run `keel step-verify --step sN --handoff-file <file> --evidence-report <file>` before
advancing. A failed step verification is a BLOCKER: do not continue, merge, or mark the
step complete from chat prose alone.

### s6 ci
Push the branch, open the **draft** PR, and wait for the project's `ci_workflows` to go
green. The required `keel evidence (required)` check is provenance-armed for ship-driven PRs
(ship branch, posted review marker, ship-run ledger record, or legacy gate label); only an
operator-applied `keel:evidence-waived` label may disarm it. Evaluate the rollup with
**failure-before-pending** precedence — a
mixed state with any failure is a failure, never poll past it. Three branches:
- **all green** (`success`/`skipped`/`neutral`/`stale`) ⇒ proceed.
- **empty check set** ⇒ allow only if every changed path is in `docs_gate_paths`, else
  mark blocked ("CI did not run on a non-docs PR").
- **any failure/pending** ⇒ watch with a hard timeout (portable `timeout`/`gtimeout`
  wrapper; require `coreutils` on hosts lacking GNU `timeout`), then on a real failure run
  the fix-and-reply loop (read the failed log, fix, self-review, push) and re-enter s6.

**Per-issue CI retry budget: 3 fix-and-push rounds**, then mark blocked.
**Session-wide cooldown: 3 consecutive issues hitting a budget without a successful merge ⇒
abort the session** (counter resets after any merge).

### s7 review *(agent)* + slot `reviewers`
Run **N reviewers** (N from the s5 tier, or `--reviewers`), the host or `--review-delegate`
vendor. A non-host reviewer vendor runs **read-only / findings-only** (the vendor's
read-only mode or local endpoint), the orchestrator still posts — the **orchestrator owns
all writes**; reviewers never call a GitHub write API. Spawn all reviewers in a **single
Agent message** so they run concurrently; each gets a fresh codename, the PR head SHA, its
focus slice, and a no-cross-reading instruction. Coverage invariant: when the count drops,
focus dimensions **merge, never drop** (a 1-reviewer slot covers all dimensions; suitable
only for narrow tier-1 PRs). Run any `reviewers` Lego extensions. Capture per-reviewer
**effective** vendor+model for attribution (lock-step parallel arrays so the s11 closure
can zip them by index). On a missing/erroring delegate vendor, fall back to the host
reviewer and log it (record the effective vendor that ran).

**Post findings per `--review-comments` (inline default):** review findings are public PR
evidence. The orchestrator MUST post each reviewer's final verdict to the GitHub PR through
the selected transport as a distinct PR review or PR comment. This applies on every path:
operator-driven, delegated, every tier, and the TIER-1 single-reviewer path. A single
reviewer still emits a posted verdict comment/review for the current PR head.
Local/chat-only review output does not satisfy the step, a rich PR body is not a substitute
for this s7 evidence, and the automated `keel ship` CI assessment block is not a substitute
for the operator-posted review verdict.
When available, use `result.artifact_bodies.review_verdict_template` as the canonical
comment shape: keep `keel.review-verdict.v1`, `reviewer: <stable-id>`, and `head: <sha>`
intact, then fill in the reviewer-specific verdict, scope, findings, and testing notes.
Post each review verdict through `keel post-comment` with a reviewer-scoped run id
(`--run-id "$RUN_ID:<reviewer-id>"`) so same-run idempotency updates that reviewer only and
does not collapse multiple reviewer verdicts into one comment.

- `inline` → fetch the diff once; anchor each `critical`/`major` finding as an **inline
  review comment** on its `file:line` (resolve `RIGHT`/`LEFT` side; `line` is the new-file
  number on `RIGHT`, old-file on `LEFT`; non-anchorable or whole-PR findings go to the
  summary), posting **one submitted review per reviewer** (create the review carrying its
  inline comments in one call — do not post standalone unattached comments). On any
  inline-API error for a reviewer, **fall soft to a summary comment for that one reviewer**
  and continue (scoped to that reviewer, never a whole-round fallback).
- `summary` → one consolidated review comment per reviewer.

Severity → action: **critical/major = block**, minor = suggestion (gated — apply before
merge unless explicitly user-deferred), nit = advisory. The s9 loop-exit parser reads the
reviewer's **returned findings**, not the comment shape, so it is mode-independent.

### s8 test (gates + jury)
`keel run-gates .keel/project.yaml --root .` runs the project gates (`build_gate_cmd`,
`lint_cmd`, plus the `tester` Lego — the manual-test list, which may loop back to the
implementer defensively without spending review budget unless it surfaces a blocking fix).
When a gating or advisory jury is enabled and `result.artifact_bodies.jury_verdict_template`
is available, use that canonical shape for the posted jury verdict and preserve
`keel.jury-verdict.v1` plus `head: <sha>`.
The **`jury` gate** runs the ai-jury CLI read-only on the PR diff when present (and a no-op
fail-soft otherwise) using the committed panel; it never passes `--strict`. In **gating**
mode the depth is the full verified run; only **verified consensus**
`critical`/`major`/`minor` findings fold into s9 (`critical`/`major` ⇒ block, `minor` ⇒
gated suggestion, `nit` ⇒ advisory; a jury-driven fix consumes one round). A sub-2-vendor
panel is downgraded to advisory (count distinct participating vendors before assembling the
verdict so the posted comment matches what is enforced), and any jury run that did not
complete cleanly **never gates**. Honour `--review-comments` (pass the jury's native inline
flag through in inline mode, never under `--dry-run`). The orchestrator MUST POST the
single jury summary/verdict comment to the GitHub PR through `keel post-comment`:
`keel post-comment .keel/project.yaml --root . --target pr:<PR> --artifact jury-verdict
--body-file <file> --run-id "$RUN_ID"`. Raw `gh pr comment`, `gh issue comment`, or
hand-rolled comment API calls are spec violations for jury/review/closure/issue-update
artifacts because they bypass marker validation, transport selection, and same-run
idempotency. Never interpolate report text into a shell argument. Re-runs use the jury's
incremental/cache flags to stay cheap.

### s9 fixloop
While there are blocking findings and the budget (**≤3 review-fix rounds**) is not spent:
aggregate findings → hand to the implementer → fix → push → re-run s6/s7/s8. A **blocker**
triggers a full re-review; **suggestion-only** fixes trigger a **narrowed re-review** of
just the originating focus(es) (carry the original reviewer codename forward, fresh codename
per narrowed reviewer, "verify only the applied fix in commit `<sha>`; do not re-review what
you already approved" prompt; spawn multiple narrowed focuses in one Agent message). A
suggestion is gated like a blocker — apply it, or obtain an explicit, tracked user deferral;
never silently relabel one "advisory/flake". Recorded suggestion deferrals must be public
and checkable: post a `keel.deferral.v1` PR/issue comment marker that names the finding,
authorising operator, and reason before treating the suggestion as deferred. A narrowed
reviewer that surfaces a NEW blocker
escalates back to the full loop. Each round posts its own review (per `--review-comments`)
and increments the counter; exceeding the budget marks the issue blocked with the
outstanding findings quoted. Defensive loop-backs (tester, merge-conflict prep) don't spend
budget unless they require a fix. Before exiting, surface any deferred suggestion/nit with
its authorising decision/issue — a silent skip is a process violation.

Append each fix/review/test round to the run-events file with `keel runcontrols`. A hard
halt from `keel runcontrols` is fail-closed and must stop the ship run until an operator
chooses an explicit `--max-rounds` override.

### s10 merge
The literal merge is **core-owned**: route it through `keel merge`. Raw `gh pr merge`
calls and hand-rolled lock shells are **spec violations** for ship-style flows — the
lock, window re-check, CI rollup read, and evidence verification must run deterministically
inside core, not as adapter prose.

- **Pre-merge prep:** re-assert mergeability; if behind/dirty, integrate `base_branch`
  (merge, not rebase), re-green CI, run a single focused merge-conflict review (max 2
  integration iterations, then blocked + morning queue). Run any `pre-merge` Lego. Then
  pre-clean the worktree so `--delete-branch` won't be held by a local ref — remove it
  with `keel worktree-remove <worktree_path> --root .`, which validates the path is nested
  under the repo root and registered in `git worktree list` before removing (never call
  `git worktree remove --force` directly on an implementer-supplied path).
- **Core-owned merge:** run
  `keel merge .keel/project.yaml --root . --pr <PR> --approve-scope <scopes> --operator <operator>`.
  The command acquires the merge resource claim (atomic `mkdir`, single-host), re-checks
  the **merge window inside the claim**, reads the live PR check rollup with
  failure-before-pending precedence, runs `evidence-verify` against the current PR
  artifacts, and only then performs the squash-merge. Any failed stage exits non-zero
  **without merging** — on a closed window, append to the morning queue, post the deferral
  comment via `keel post-comment`, leave the PR ready, and continue with the next issue;
  on a denied claim, treat it as lock contention (mark the issue blocked, comment,
  continue). For a blocker issue, pass `--hotfix` — the audited window bypass; it still
  requires the approved consent scopes and is recorded in the ledger.
- **Outcome:** treat the **PR state (`MERGED`)** as authoritative. A non-zero exit after a
  successful server-side squash is a local-cleanup failure — proceed to capture/close; a
  real non-MERGED state aborts the closure block and blocks the issue.

`merge_window_mode`: `pause` halts here outside the window; `freeze` defers to the morning
queue. The merge claim and "the only merge path is `keel merge` at s10" are non-negotiable
invariants.

### s11 capture
Record the run for `/keel:wrap`: the **effective** implementer + reviewer vendors/models,
tier, rounds, window decision, and outcome. Post the **closure comment** to **both** the
issue and the PR as distinct comments through `keel post-comment` with
`--artifact closure-comment` and the same `--run-id`. The PR closure comment MUST be a PR
conversation comment, not appended to or folded into the PR body, and not represented by
the automated `keel ship` CI assessment block. Render it deterministically from the
`ship_run` ledger record via the `result.closure_comment` field of `keel ship --json` (the
`contract.closure_comment` contract describes its stable marker plus sections: heading,
Implementer `vendor (model)`, Reviewers — noting AI Jury when present, Tester, PR number,
changed files, capture outcome, run id). Do **not** hand-write closure prose: post the
rendered markdown verbatim so the issue and PR comments mirror the ledger byte-for-byte.
Use `keel post-comment` for issue-update, review-verdict, jury-verdict, and
closure-comment artifacts; a malformed body missing its marker must stop the step before
any public comment is posted.
Run any post-merge
`capture` Lego (e.g. durable-learning capture: classify the merged PR's signal, optionally
file a follow-up issue or hand off to a project-owned destination) fail-soft, emit its
core marker, and do a post-merge worktree safety-net cleanup. **Marker discipline:** every
merged PR that reaches capture must write exactly one structured ledger record with this
stable marker: `compound-learning: pr=<N> status=<applied|deferred|skipped:reason>`.
Allowed skip reasons are closed: `dry-run`, `deferred`, `merge-failed`,
`recursion-guard`, `capability-unavailable`, and `no-policy`. Capture-on-capture recursion
must skip with `skipped:recursion-guard`. A session-end verifier runs
`keel capture-verify .keel/project.yaml --root . --merged-pr <PR> ...` and blocks the
session if any merged PR is missing a valid marker. The closure comment's capture field is
mandatory and never empty, but it is a human audit mirror, not the parser source.

Also append the structured `ship_run` record to `contract.run_ledger.path` via
`keel ship --live --append-ledger` or the equivalent core ledger writer. The ledger append
is the machine-readable source for `/keel:morning`, `/keel:wrap`, overnight summaries, and
capture verification; the closure comments are human/audit mirrors, not the parser source.
Capture artifacts MUST pass through the core redaction policy first: default secret rules plus
any project-owned `policy_pack.capture_redaction.deny_patterns`. If the configured redaction
policy is invalid, stop the durable write and ask for operator help rather than persisting
unsanitized output. The audit may include rule ids and counts, never original secret values.

### s12 close
Close the issue (idempotent if the squash auto-closed it via `Closes #<N>`), link the PR,
flip the status label to done **only here** (post-merge), and drop the lock.

## Compound profile (`--compound`)

`--compound` (or `--profile compound`) selects the **compound-engineering** workflow
profile. It is a first-class profile of `ship`, **not** a second backbone and **not** a
project extension: the same selection, worktree safety, guard, classification, CI, gates,
review/jury/merge-gate contract, merge window, merge lock, closeout, and capture-marker
discipline apply. It differs only where `workflow_profile.step_overrides` says it differs.

Render the compound contract through the same deterministic CLI before mutating work:

```bash
keel plan .keel/project.yaml --root . --command ship --profile compound --live --json
keel ship .keel/project.yaml --root . --compound --live --json
```

The JSON contract's `workflow_profile` then reports:

- `profile: "compound"`
- `inherits: "ship"`
- `first_class_variant: true`
- `step_overrides` for `s4 implement`, `s7 review`, `s9 fixloop`, and `s11 capture`

The compound profile differs only at these four steps:

| step | profile mode | compound behavior |
|---|---|---|
| `s4 implement` | `compound` | Use a compound implement pass that emphasizes PR quality, scope simplification, and value-first change shaping before handoff. |
| `s7 review` | `compound` | Use compound/persona reviewer fan-out when available, while **preserving the reviewer count, posting mode, and gating semantics (including jury) from `review_merge_contract`**. |
| `s9 fixloop` | `compound` | Resolve PR feedback through a structured compound loop, but keep the shared blocker/suggestion policy and review-fix budget. |
| `s11 capture` | `compound` | Run durable-learning capture through the capture slot, with the shared canonical marker requirement. |

Compound helpers may be supplied by the host runtime or by project extensions. If a
compound helper is unavailable for a step, fall back to the standard behavior for that step,
log the degraded step, and continue unless the configured extension marks the degradation as
blocking.

Under `--dry-run`, the compound profile must show the same non-mutating contract as the
standard profile, plus the compound `workflow_profile`; it must not create branches, edit
files, push commits, post comments, request reviews, merge, close issues, or write capture
artifacts.

## `--dry-run`

Run s0–s8 read-only and print the plan + `keel ship` assessment (tier, window, gates,
decision). Do **not** push, open a PR, post comments/labels, or merge — log every would-be
write as `DRY-RUN: …` (every label edit, comment, ready-flip, merge, close, and any review-
API or jury-inline write). The implementer is told not to push or open a PR; reviewers still
run for real (read-only) so findings stay meaningful. `keel merge --dry-run` may still be
run to exercise the claim/window/rollup path without merging. The capture step is a logged
no-op (`dry-run` marker).

## `--wizard` (interactive opt-in only)

A pre-s1 front layer that collects the same options the grammar above produces — it adds no
new pipeline behaviour and cannot produce a config the grammar could not. **Hard
interactivity guard:** never enter the wizard in any non-interactive context (watch mode,
overnight/background/headless runs); there it degrades to a logged no-op and proceeds with
the literal flags as parsed (never a hang, never a rejection). Best-effort tool/model probe
(installed CLIs + local models) builds the offered choices; detection failures just yield
shorter lists. First question is a **Quick-start vs Customize** fast path (Quick-start
resolves every option to its default and only still asks for Issues). Every question shows
its `(default)` option first with a one-line description of what the default does. After
collecting, echo the resolved config in the worked-example shape, then proceed to s1.

## Invariants (always)

The only merge path is `keel merge` at s10 (claim, window, CI rollup, and evidence checks
run in core) · never merge
in the night no-merge window except a blocker / audited `--hotfix` · fail-soft (a missing
CLI/gate/jury/capture-path degrades, never crashes the run; an absent/erroring jury can
never manufacture a block) · the **orchestrator owns all writes** (reviewers are
findings-only, every vendor) · never push directly to `base_branch` · the status-done label
is set in exactly one place (s12, post-merge) · attribute the **effective** vendor+model
everywhere · a local-model implementer is orchestrator-driven, refused on tier-3, and never
bypasses review/tester/merge gates or the lock.

<!-- keel-generated: surface=claude command=ship keel_version=1.2.3 source_sha256=df387b5031c2b143f324227d9792063041fc76aa3fc01ca6a134dca5368443b0 generated_sha256=df387b5031c2b143f324227d9792063041fc76aa3fc01ca6a134dca5368443b0 -->
