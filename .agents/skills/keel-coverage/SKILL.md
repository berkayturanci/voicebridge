---
name: keel-coverage
description: Compute and post the per-PR test-coverage delta (base → head), flag low-coverage × high-risk hot spots, and open issues to close gaps — routed to keel:ship.
---

# keel-coverage

Use this skill when the user asks to run the keel command `coverage` (e.g. `keel coverage ...`, `coverage <args>`, or `/keel:coverage`). It reads every project value from `.keel/project.yaml` via the `keel` CLI.

# /keel:coverage

## Command step evidence

Every numbered step in this command is contractual. Complete the step, record the
evidence it asks for, or explicitly mark it `N/A — <reason>` before moving on. If a step
has an external side effect such as a GitHub comment, issue, review, report, branch, or
PR, the side effect must be posted or written through the selected transport and cited in
the final summary. Never silently skip a step because the runtime, agent, or prompt feels
obvious.

Project-neutral coverage report. Every project value — the base branch, the coverage tooling
per area, the risk map, the repo — is read from `.keel/project.yaml` via the `keel` CLI. The
coverage command is **the project's** (its test/coverage command via its toolchain); this
adapter never names a specific coverage tool.

The command is **read-only on PR code**: it never modifies the PR diff, never closes the PR,
and never merges. It runs coverage twice (base + head), produces a delta table, and posts (or
updates) exactly one PR comment. Re-runs find the existing codename-prefixed comment and update
it in place so the timeline never stacks duplicates. All published artifacts (the PR comment)
MUST be English.

## Step 0 — orient + parse arguments

```bash
keel validate .keel/project.yaml --root .
keel plan     .keel/project.yaml --root .     # read base_branch, tier3_globs, repo
keel plan     .keel/project.yaml --root . --command coverage --live --json
```

The live plan is the operator-consent preflight. Before creating worktrees, writing local
coverage cache files, posting comments/labels/issues, using secrets, publishing, or calling
production-adjacent systems, parse `contract.operator_consent`; if
`requires_operator_consent` is true, STOP and ask the operator to rerun with the required
`--approve-scope` values.

Arguments:
- Positional, optional: a single positive integer **PR number**. Default: derive the PR from
  the current branch; if no open PR is tied to the current branch and no positional was given,
  exit non-zero with `no PR for current branch — pass an explicit PR number`. Reject more than
  one positional and zero/negative integers.
- `--base <branch>` — consumes exactly one branch name after the flag. Default: `base_branch`
  from the plan. Reject `--base` with no value after it.
- `--threshold <pct>` — a coverage floor to compare hot spots against (Step 5).
- `--changed` — scope coverage to the PR diff (`git diff base...HEAD`) rather than the whole
  tree.
- `--open-issues` — open a deduped issue per hot spot (Step 6) and route each to `/keel:ship`.
- `--dry-run` — compute the report and log the would-be comment/label mutations to stdout as
  `DRY-RUN: …`; make no write.
- Reject unknown flags.

## Step 1 — detect areas touched + availability

Get the PR's changed-file list and classify which project **areas** it touches (derive areas
from the repo layout). If the PR touches **no instrumented area**, post a short
codename-prefixed comment noting there is no coverage signal (no files under an instrumented
area) and exit; under `--dry-run`, log the would-be body and skip the post.

Coverage needs the host CLI (or MCP read path) for the PR file list and the comment. If that is
unreachable, note it and degrade per the MCP-mode rule in Step 6.

## Step 2 — compute the baseline (base-branch head)

Use a **dedicated worktree** so the PR checkout is not disturbed: fetch `--base` and add a
worktree at its head. For each touched area, run the project's coverage command **for that
area** and parse its report for the per-area + overall **line** coverage percentage
(`covered / (covered + missed) * 100`). Cache results keyed by `<commit-sha>:<area>` so a
re-run on the same SHA does not recompute.

**Graceful degradation (per area):** if an area's coverage tool is not wired up, **skip** that
area's coverage and add a note (`<area> coverage skipped: tooling not wired up`), continuing
with the other areas. Discover the exact coverage task by name rather than hardcoding it (task
names vary by tool version).

## Step 3 — compute head (PR head)

Run the same commands against the PR-head checkout (the working tree if it is already on the PR
head, else a second worktree), reusing the task discovered in Step 2. Cache keyed by
`<head-sha>:<area>`.

## Step 4 — build the delta report

A single markdown body whose **literal first line** is the codename
`COVERAGE-<PR>-<UTC_TIMESTAMP>`. **Codename pin (load-bearing):** no blank line above it, no
leading whitespace, no quoting, no Markdown prefix or surrounding formatting — Step 6 finds the
existing comment by the `COVERAGE-<PR>-` prefix to update it in place, and any deviation makes
it miss the prior comment and post a duplicate. The prefix here MUST match the literal first
line emitted — change them together or find-and-update silently breaks.

Body: a `base@<short> → head@<short>` header, then one section per touched area with rows
(unit · base % · head % · signed Δ · files-in-diff) plus a bold **overall** summary row.
Formatting rules:
- One row per sub-area/module; one bold overall row per section that ran.
- Show the absolute signed delta: `+1.2%`, `-0.3%`, `+0.0%`.
- **Bold the whole row** when `|Δ| >= 0.5%` so reviewers' eyes catch it.
- Omit a section entirely if its area was not touched.
- A skipped area renders as a single italic line (`_<area> coverage skipped: …_`).

## Step 5 — flag hot spots (low coverage × high risk)

Cross the per-file/area coverage against `tier3_globs`: a low-coverage file that **also** matches
a tier-3 glob is a **hot spot** — surface these first (high risk × low coverage). Compare each
against `--threshold` if given. Hot spots are what Step 6 opens issues for.

## Step 6 — post / update the PR comment + open hot-spot issues

Find the existing coverage comment by the `COVERAGE-<PR>-` prefix on the PR.
- Existing found and not `--dry-run` → **update it in place** (edit the existing comment).
- None found and not `--dry-run` → post a new comment.
- `--dry-run` → log the body to stdout, no API call.

Only ever one coverage comment per PR after the first run. **In-place-update gap:** if the
runtime can create comments but cannot edit one in place (e.g. an MCP path with no
update-comment tool), do **not** post a second comment — compute and log the delta, emit a
one-line note that an existing comment was found and in-place update is unavailable (re-run
locally, or delete the prior comment first), and continue.

**Label** (compute the worst overall regression across the areas that ran): if at least one area
regressed by ≥ 0.5%, idempotently ensure and add a `coverage-regression` label; otherwise remove
it if a prior run added it (ignore "not present" errors). The label is informational, not
gating. Under `--dry-run`, log the would-be transition and skip.

When `--open-issues` is set, open a **deduped** issue per hot spot (Step 5), tiered by
`tier3_globs`, and hand each fix to **`/keel:ship`** (window + lock + review). Under `--dry-run`,
print the would-be issues and route nothing.

## Stop conditions / invariants

- **Never modify the PR's code; never close or merge** — the only writes are one PR comment
  (created or edited) and one PR label edit (plus hot-spot issues under `--open-issues`).
  Gating/merge is `/keel:ship`'s job.
- **Fail loudly on a coverage build/test failure** — print the failing command and exit
  non-zero; do NOT post a half-formed table (reviewers would treat it as authoritative). This is
  distinct from a tool **not wired up**, which degrades gracefully per Step 2.
- **Worktree cleanup** — always remove the base (and head) worktree in a trap on EXIT so a
  mid-run failure never leaks a worktree.
- **No silent dry-run mutations** — every comment/label/issue write is printed as `DRY-RUN: …`
  and skipped.
- Deterministic for identical coverage data.

<!-- keel-generated: surface=skills command=coverage keel_version=1.2.3 source_sha256=64fd36967be8b855e523cec7d22eb26eb47f16bccd4ea3d8b45c28ea821611a1 generated_sha256=d8ff41feade9512b67dea8b017ffe627580782e6f93363c03fbc11267f894c0c -->
