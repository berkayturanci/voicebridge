---
name: keel-ci-check
description: Check the latest CI run's status; on failure, locate the failing job/step, diagnose the root cause, and propose one fix — never auto-apply.
---

# keel-ci-check

Use this skill when the user asks to run the keel command `ci-check` (e.g. `keel ci-check ...`, `ci-check <args>`, or `/keel:ci-check`). It reads every project value from `.keel/project.yaml` via the `keel` CLI.

# /keel:ci-check

## Command step evidence

Every numbered step in this command is contractual. Complete the step, record the
evidence it asks for, or explicitly mark it `N/A — <reason>` before moving on. If a step
has an external side effect such as a GitHub comment, issue, review, report, branch, or
PR, the side effect must be posted or written through the selected transport and cited in
the final summary. Never silently skip a step because the runtime, agent, or prompt feels
obvious.

Project-neutral CI status check. Reads `.keel/project.yaml` (`ci_workflows`, `base_branch`)
via the `keel` CLI — the workflow names and branch are never hardcoded here. It inspects the
latest CI run, and when that run failed it pulls the failing log, reads the offending source,
and proposes exactly **one** fix. It is read-only: it never edits code, pushes, re-kicks, or
merges.

All user-facing diagnoses MUST be written in English; free-form chat may be in any language.

## Step 0 — orient + runtime gate

```bash
keel validate .keel/project.yaml --root .
keel plan     .keel/project.yaml --root .     # read base_branch, ci_workflows
```

CI status lives behind the host's Actions/checks API, which is reached through `gh` (or its
MCP equivalent). Detect availability first:

- If a PR is in scope, prefer `keel ship .keel/project.yaml --root . --pr <N>` for the CI
  rollup + merge decision, falling back to `gh pr checks <N>` for per-workflow detail across
  the project's `ci_workflows`.
- If neither `gh` nor an MCP checks-read path is reachable in this runtime, **exit cleanly**
  with a single line saying CI data requires the host CLI and is unavailable in this sandbox
  (re-run from a local checkout with the CLI installed, or use the host's web UI). Do **not**
  error or partial-run — surfacing nothing here advances nothing.

## Step 1 — latest run(s)

List the most recent runs (a small limit, e.g. the last 3) across the project's
`ci_workflows`, capturing per run: id, status, conclusion, workflow name, head branch, and
created-at. The newest run is the one under analysis; the prior two give context for "did this
just start failing?".

## Step 2 — if the latest run failed

1. Pull the failing job's **log tail** (the last screenful of `--log-failed`, not the whole
   log) for the newest failing run.
2. Identify the **failing job and step name**.
3. **Read the source file** the failure points at (use the `file:line` the tool output carries
   where it has one).
4. **Classify** the failure: a real code/test failure vs. a flake (intermittent; cross-check
   with the prior runs from Step 1) vs. infra/quota (runner, network, rate-limit, credentials).
5. **Diagnose** the root cause in 2–4 sentences.
6. **Propose ONE specific fix** — describe it concretely (file/line-targeted). Do **not** apply
   it automatically.

## Step 3 — if all runs passed

Print a single green line: CI is green, with the latest run's workflow name, branch, and time.

## Step 4 — recommend the next action

Route by the Step 2 classification — never merge here:

- **Transient / flake** → re-kick (a fresh push or the host's re-run), and consider
  `/keel:flake-audit` if it recurs.
- **Real failure** → apply the proposed fix, then run `/keel:review-cycle` (self-review +
  independent reviewers) and re-check; the fix is not "done" until every reviewer is clear of
  blockers AND CI is green. Land it through `/keel:ship` (window + lock + review), never by a
  direct merge from here.
- **Infra / quota** → escalate; this is not a code fix.

## Stop conditions / invariants

- **Read-only** — propose a fix, never apply, push, re-kick, or merge.
- **Deterministic** for identical CI state.
- **Fail-soft** — a missing CLI degrades to the Step 0 clean-exit note, not a crash.

<!-- keel-generated: surface=skills command=ci-check keel_version=1.2.3 source_sha256=a9515465d188c9db8ab6ce3badfcd87837ac61abaaff5396946992af9f677fd7 generated_sha256=fa07460b6d8bfe8989d6d473119fcaceabc3b2dfb70153a4b18983e472df7f36 -->
