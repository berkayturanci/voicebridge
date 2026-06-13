---
name: keel-flake-audit
description: Detect intermittently-failing tests from recent CI history (or repeated local runs); dedupe against tracked flakes and open one tracking issue per newly-detected flake — routed to keel:ship.
---

# keel-flake-audit

Use this skill when the user asks to run the keel command `flake-audit` (e.g. `keel flake-audit ...`, `flake-audit <args>`, or `/keel:flake-audit`). It reads every project value from `.keel/project.yaml` via the `keel` CLI.

# /keel:flake-audit

## Command step evidence

Every numbered step in this command is contractual. Complete the step, record the
evidence it asks for, or explicitly mark it `N/A — <reason>` before moving on. If a step
has an external side effect such as a GitHub comment, issue, review, report, branch, or
PR, the side effect must be posted or written through the selected transport and cited in
the final summary. Never silently skip a step because the runtime, agent, or prompt feels
obvious.

Project-neutral flaky-test audit. Every project value — the CI workflows, the base branch, the
test gate, the repo — is read from `.keel/project.yaml` via the `keel` CLI. The test command is
**the project's** (`keel run-gates .keel/project.yaml --root .`); this adapter never names a
specific test runner.

The command is **read-only on test code**: it never edits test sources, never auto-disables a
test (no skip/ignore/only annotation), never reruns a test to "confirm" a flake, and never
closes an existing flake issue. It aggregates per-test pass/fail signal, classifies tests whose
failure rate crosses the threshold as flaky, dedupes against open flake issues, and opens one
tracking issue per newly-detected flake. Re-runs MUST NOT spam duplicates — the Step 4 dedupe is
load-bearing.

**The defining rule:** only an **across-runs disagreement** (a test that both passes and fails
under identical conditions) marks a flake. A test that **consistently fails** is a real bug, not
a flake — it belongs to `/keel:ci-check` and human triage; do not classify it here. All
published artifacts (report, issue bodies) MUST be English.

## Step 0 — orient + parse arguments + runtime gate

```bash
keel validate .keel/project.yaml --root .
keel plan     .keel/project.yaml --root .     # read base_branch, ci_workflows, repo
keel plan     .keel/project.yaml --root . --command flake-audit --live --json
```

The live plan is the operator-consent preflight. Before opening issues, routing fixes to
`/keel:ship`, using secrets, publishing, or calling production-adjacent systems, parse
`contract.operator_consent`; if `requires_operator_consent` is true, STOP and ask the
operator to rerun with the required `--approve-scope` values.

Arguments:
- `--days <N>` — CI-history lookback window in calendar days (UTC). Default `14`. Reject `0`,
  negatives, non-integers.
- `--runs <N>` — when reading CI history is unavailable, re-run the project's test gate `N`
  times locally instead (default `5`). The two evidence sources are mutually supportive:
  prefer CI history; fall back to repeated local runs.
- `--threshold <P>` — minimum failure rate to flag, a decimal in `[0, 1]`. Default `0.10`.
  Reject anything outside `[0, 1]`, non-numeric, or a missing value after the flag.
- `--open-issues` — open a deduped tracking issue per newly-detected flake (Step 6) and route
  each fix to `/keel:ship`. Without it, report-only.
- `--dry-run` — compute the report and print findings, but skip every issue-create mutation;
  print `would create: <title>` per skipped issue.
- Reject unknown flags.

**Runtime-availability gate.** Test-level CI-history analysis needs the host's check-run +
artifact APIs (via the host CLI; no MCP equivalent today). If those are unreachable AND the
project's test gate cannot be run locally either, exit cleanly with a single line saying flake
detection requires either CI check-run/artifact access or a runnable local test gate, neither
available in this runtime. Do not error or partial-run.

## Step 1 — gather evidence

**CI-history mode (preferred, full fidelity):** enumerate the in-window CI runs of the
project's `ci_workflows` on `base_branch` (drive it via commits in the window + their
check-runs where a direct run-by-date listing is unavailable; document the substitution
honestly in the report's Limitations). For each failing check run keep its conclusion, workflow
name, start time, the run-page URL (for "sample run URLs"), and the test-report artifact URL if
extractable.

**Local-runs mode (fallback):** run `keel run-gates .keel/project.yaml --root .` `--runs`
times on a clean tree and record per-run pass/fail.

## Step 2 — build per-test aggregates

- **Test-level (full fidelity):** parse each run's test-report into per-test results keyed by
  **fully-qualified test name**; track `pass_count` and `fail_count`. Capture, per failing
  test, the first ~5 lines of the failure signature from the most recent failing run.
- **Degraded run-level (no per-test granularity — artifacts unreachable):** aggregate only at
  the run level (which runs failed, on which commit, with which URL); skip per-test
  classification and per-flake issue creation, and produce a Limitations-flagged summary only.

## Step 3 — classify flakes (test-level only)

A fully-qualified test with both passes and failures in the window is **flaky** when:

```
fail_count >= 3  AND  fail_count / (pass_count + fail_count) >= <threshold>
```

The `fail_count >= 3` floor is load-bearing: it stops a single transient blip being labelled
flaky. A test that **never passed** in the window is a deterministic failure, not a flake — do
not classify it here.

## Step 4 — dedupe against tracked flakes

Search open issues labelled `flake` (canonical title shape `flaky test: <fully.qualified.name>`)
and build the tracked-name set by stripping that prefix. Carry forward **only** newly-classified
flakes not already tracked. This dedupe is the only reason the command is safe to re-run on a
schedule — do not weaken it.

## Step 5 — build the report

A single markdown body whose **literal first line** is the codename
`FLAKE-AUDIT-<DATE>-<UTC_TIMESTAMP>`. **Codename pin (load-bearing):** no blank line above it,
no leading whitespace, no quoting, no Markdown prefix or surrounding formatting — downstream
consumers locate the run by the `FLAKE-AUDIT-<DATE>-` prefix.

Body: a summary line (runs examined · distinct failing tests · classified flakes ·
newly-opened issues); a **newly-classified flakes** table (test · fail rate · failures · up to
3 sample run URLs, most-recent first · first ~5 lines of the failure signature, fenced inline);
an **already-tracked (deduped)** list (`<name> — see #<existing>`); and a **Limitations**
section.

Formatting rules:
- Zero new flakes → render `_no new flakes above threshold_` instead of the table.
- Omit "already-tracked" if nothing was deduped.
- Omit "Limitations" if no degradation occurred; otherwise include every honest caveat (history
  enumerated commit-by-commit, an artifact download that failed, degraded run-level mode, etc.).
- Degraded run-level mode → replace the flakes table with a short list of failing runs (commit ·
  workflow · URL) and add the Limitations bullet that test-level classification was skipped.

## Step 6 — open issues per new flake + route to ship

Only under `--open-issues`, and test-level mode only (degraded mode skips this). Per newly
classified flake:
- `--dry-run` → print `would create: flaky test: <name>` and skip.
- Otherwise → open an issue titled `flaky test: <fully.qualified.name>` whose body carries the
  detecting codename + window, the fail rate (`<fail>/<total>`), the threshold, up to 3 sample
  run URLs, the fenced failure-signature excerpt, and a triage note: **do NOT auto-disable**;
  investigate root cause (timing, shared state, ordering, network); close with a fix PR or mark
  wontfix if the test is being retired.

Labels: always `flake`; add an **area** label tiered from `tier3_globs` / the test's path or
FQN where the project's layout makes the area derivable; if the area is indeterminate, apply
only `flake` and note that in the body. If a needed label does not yet exist, the create may
fail to apply it — detect that, **retry the create without the label**, and add a Limitations
bullet recommending the operator pre-create the label.

Hand each opened flake fix to **`/keel:ship`** (window + lock + review). Optionally suggest a
quarantine annotation in the issue — but never silently skip a test from this command.

## Step 7 — print

Always print the Step 5 report to stdout, even when not `--dry-run` — a silent run would force
the operator to spelunk the tracker after the fact.

## Stop conditions / invariants

- **Never auto-disable a flaky test; never rerun a test to "confirm" flakiness** (a rerun
  invalidates the very signal being measured) — only observed history counts.
- **One flake = one issue** — the Step 4 dedupe is load-bearing; re-runs never duplicate a
  tracked flake.
- **Never close/edit/comment on existing flake issues** — triage is a human call; this command
  only opens new ones.
- **Per-step failure continues with what was fetched**, documented under Limitations; only Step
  0 arg-parse failure is fatal.
- **No silent dry-run mutations** — each create is printed as `would create: <title>` and
  skipped.
- Fail-soft · deterministic for identical inputs.

<!-- keel-generated: surface=skills command=flake-audit keel_version=1.2.3 source_sha256=17b5e120e6978bb027e088280a2f318252b676f77cc8498b3417b5cc06607c68 generated_sha256=77250792011b635ccd1596b38bd3e071276fc8667a29cdec110112400e5f0e07 -->
