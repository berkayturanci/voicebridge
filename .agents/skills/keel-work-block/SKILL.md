---
name: keel-work-block
description: Daytime multi-issue work block — process an explicit issue list or queue selector through ship with per-issue isolation and operator-visible stopping points.
---

# keel-work-block

Use this skill when the user asks to run the keel command `work-block` (e.g. `keel work-block ...`, `work-block <args>`, or `/keel:work-block`). It reads every project value from `.keel/project.yaml` via the `keel` CLI.

# /keel:work-block

## Command step evidence

Every numbered step in this command is contractual. Complete the step, record the
evidence it asks for, or explicitly mark it `N/A — <reason>` before moving on. Any GitHub
comment, review, issue label, branch, PR, merge, report, or queue write must be posted or
written through the selected transport and cited in the final summary.
Never silently skip a step because the runtime, agent, or prompt feels obvious.

Run a daytime work block: process a prioritized set of issues sequentially through
`/keel:ship` while the operator may still be present to approve, redirect, or stop between
items. This is not a second ship implementation and not a copy of `/keel:overnight`; it
uses the shared `contract.session_contract.work_block` primitive and hands every ready item
to `ship`.

## Step 0 — Resolve config + work-block contract

```bash
keel validate .keel/project.yaml --root .
keel plan     .keel/project.yaml --root . --command work-block --live --json
keel work-block .keel/project.yaml --root . --live --json
keel window   .keel/project.yaml --root .
```

Parse `contract.operator_consent` before selecting work, creating branches/worktrees,
spawning implementers, opening PRs, merging, writing reports, or touching GitHub labels or
comments. If `requires_operator_consent` is true, STOP and ask the operator to rerun with
the required `--approve-scope` values. Pass
`operator_consent.delegated_agent_scope` into every child `/keel:ship` handoff. Children
may use only `approved_mutation_scopes`; scope expansion blocks or escalates.

Read `contract.session_contract.work_block`. It is the queue primitive shared with
`/keel:overnight`: queue snapshot, readiness refresh, per-issue worktree isolation, ship
handoff, checkpoint/resume, run ledger, final report buckets, and stop conditions. Do not
invent project-specific queue tiers in this adapter; read project policy from
`.keel/project.yaml` or extension output.

## Step 1 — Snapshot the queue

Use explicit issue numbers in the order provided. If none are provided, resolve `--queue`
through the project policy or GitHub query and sort deterministically by configured
priority, then issue number. Apply `--max` to the snapshot, not to a live re-poll.

Write or update the checkpoint with `--checkpoint-command overnight` only when resuming an
overnight run; otherwise use the daytime command name `work-block`. Store the issue queue,
active issue, current child branch/worktree/PR when known, and stop reason at each safe
boundary.

## Step 2 — Refresh readiness before each item

Before a child ship handoff, fetch the current issue title/body/labels and run:

```bash
keel plan .keel/project.yaml --root . --command ship --live --json \
  --target "issue #<N>" \
  --issue-title "$ISSUE_TITLE" \
  --issue-body "$ISSUE_BODY" \
  --issue-label "$ISSUE_LABELS"
```

If `contract.issue_intake.status` is `needs-input`, `blocked`, or `out-of-scope`, record the
reason and questions in the final report. In daytime mode, stop for operator attention on
`needs-input` or consent gaps; skip only when policy explicitly allows continuing.

## Step 3 — Handoff each ready issue to ship

Run `/keel:ship <N>` for one ready issue at a time. The child ship run owns branch creation,
worktree isolation, implementation, CI, review, test, merge lock/window, capture, ledger
append, and closeout. A child failure must never reuse or contaminate the next issue's
branch/worktree.

Re-check `keel window` before each child merge handoff. Daytime work blocks may merge only
when the normal ship merge gate allows it; the work-block command cannot weaken the merge
lock, merge window, review requirements, CI requirements, capture marker, or closeout
rules.

## Step 4 — Stop or continue by policy

Stop on hard blockers, consent gaps, user cancellation, or ambiguous resume state. Continue
only when the work-block contract says the outcome can be isolated from the next item.
Examples: a skipped non-ready issue may be safe to continue; unresolved CI budget exhaustion
may stop the block or defer according to policy.

## Step 5 — Final report

Write a concise session report to the configured `session` report destination when present.
If no destination is configured, print the report in the final command summary. The report
must include the fixed queue snapshot and these buckets:

- Shipped
- PR-opened-not-merged
- Deferred
- Blocked
- Skipped
- Needs-input

Also include open questions, consent gaps, and the next 1–3 operator actions.

<!-- keel-generated: surface=skills command=work-block keel_version=1.2.3 source_sha256=0698f77f77539c09880a4299aada98027d29f98c63b5e6f05a45ba071a8c4d94 generated_sha256=f58e09065ab95b6ddb16ea12f76ba7c1d4bd4e267c9cb037b004e2fe22f06eea -->
