---
description: Daily morning briefing — cross-session deferrals, shipped-since-last-brief, production/health signals, GitHub status, and a ranked focus list. Project-neutral; reads .keel/project.yaml.
argument-hint: "[--since <ref|timestamp>]"
allowed-tools: Bash(keel:*), Bash(git:*), Bash(gh:*), Read, Write
---

# /keel:morning

## Live progress — stamp this run (required)

So this run shows live on `keel-visual`'s board, record it with `keel activity` **as you
go**. This command's phases are: `config` → `deferrals` → `shipped` → `health` → `enrichment` → `window` → `output`. Pick one stable `--run-id` for the whole run
(e.g. `morning-<issue-or-pr>`):

- **Right now, before the work below**, stamp the first phase:
  `keel activity .keel/project.yaml --root . --write --command morning --run-id "$RUN" --phase config`
- Re-run with the next `--phase` (`deferrals`, …) **as you advance** through the flow.
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

Project-neutral daily brief. This adapter contains no project, repo, dashboard,
timezone, or data-source literal — read every project specific from
`.keel/project.yaml` via the `keel` CLI (`timezone`, `merge_window`, repo). Emit
one structured report. Be terse, English only (`knobs.sot_doc` § language policy).

> **Sync resilience.** Keep live signal logic out of this adapter. Project-side
> health/telemetry pipelines (crash, vitals, store reviews, analytics, function
> errors, etc.) are **(project-specific; stay in the project)** as a script the
> project owns or a `.keel/extensions/` Lego. This file is a thin agent-side
> wrapper, which keeps it immune to cross-project sync churn. If you ever see a
> project-specific reference appear here, re-derive from this neutral spec plus
> the project's own brief script/spec.

## Step 0 — Resolve config

```bash
keel validate .keel/project.yaml --root .
keel plan     .keel/project.yaml --root .   # repo, base_branch, timezone, merge_window
keel plan     .keel/project.yaml --root . --command morning --live --json
```

The live plan is the operator-consent preflight. Before writing reports, sending
notifications, using secrets, publishing, or calling production-adjacent systems, parse
`contract.operator_consent`; if `requires_operator_consent` is true, STOP and ask the
operator to rerun with the required `--approve-scope` values.

Resolve GitHub access through the shared runtime contract (`keel capabilities --json` →
`github_transport`). Use the selected transport for issue/PR reads and state any degraded
operations at the top of the brief when they affect the report.

## Step 1 — Cross-session deferral queue (surface at top)

Read the cross-session deferral store — items deferred by `/keel:ship` /
`/keel:overnight` because they fell outside the merge window or hit an
unresolved blocker. Surface any entries at the **top** of the brief under a
"Overnight deferrals" section, then clear the store after surfacing.

Read the structured run ledger from `contract.run_ledger.path` with
`keel ledger .keel/project.yaml --root . --json`. Missing ledger files mean an empty
history. Malformed records are a report blocker; do not recover by scraping free-form
comments.

Also read the ledger payload's `capture_health` block and surface it in the brief. It is a
dry-run/no-mutation summary: morning must report missing markers, allowed skips grouped by
reason, deferred capture, learning decisions, and the safe reconcile commands listed under
`capture_health.reconcile_actions`; it must not write capture artifacts or mutate GitHub
while producing the brief.

## Step 2 — Shipped since last brief

Query through the selected GitHub transport for issues closed and PRs merged since
`--since` (default: the last brief's timestamp, else the prior 24h). Section: "Shipped".
Include the effective agent, tier, gate summary, merge decision, and capture status from
the structured ledger where available; use GitHub only to fill timeline gaps.

## Step 3 — Project health/telemetry signals (project-specific)

If the project provides a health/telemetry brief (crash reports, performance
vitals, store reviews, analytics pulse, serverless error counts, etc.), run it
and splice its output in. That pipeline is **(project-specific; stays in the
project)** — either a script the project owns or a `.keel/extensions/` Lego that
this command invokes. Missing credentials should degrade to an `_unavailable_`
note, not an error — that is expected until the operator finishes monitoring
setup. If no such pipeline is configured, skip this section.

## Step 4 — Model-side enrichment / ranked focus

Compute the ranked focus live (not from a static file), weighting in order:

1. Production fires (a health signal over threshold — crash spike, vitals
   breach, error surge) when the project provides such signals.
2. Review-approved + CI-green PRs ready to merge.
3. Stale PRs (no activity > 3 days).
4. Unassigned bugs.
5. CI failures on `base_branch`.

Cross-reference any active-fires list against the new health signals, and flag a
health signal whose blast radius crosses the project's threshold when no matching
issue exists yet (automated issue-opening is project-specific). Append any
project `priorities.md` as a "Manual focus" note. Produce a ranked 3-item
Suggested Focus.

## Step 5 — Window

Run `keel window .keel/project.yaml --root .` so the brief states whether the
merge window (derived from `timezone` + `merge_window`) is currently open or in
its no-merge phase.

## Step 6 — Output, save, notify

Emit in this order: Overnight deferrals (if any) → Shipped → project health
sections (if any) → Capture Health → Window status → ranked Suggested Focus.

Write the brief to the project's reports path (deterministic for identical
state; do not `git add` a gitignored reports path). Fire a push notification
when the project configures one (title = project + date; body = a terse summary,
e.g. `<crashes> · <reviews> · <fires_summary> · <deferred_summary>` where
`<fires_summary>` is `🚨 <K> fires` when any active fire exists else `✅ no
fires`, and `<deferred_summary>` is `🌙 <K> deferred` when overnight deferrals
exist else omitted); otherwise skip.

On the **first run** (no prior brief at the reports path), offer to schedule the
brief on a recurring cadence at the configured `timezone` — the exact scheduler
mechanism is project-specific.

<!-- keel-generated: surface=claude command=morning keel_version=1.6.5 source_sha256=5bcd4d2e1d791805237934d8333fa14283bf5bac184020b71fdfdcd80fd25b65 generated_sha256=5bcd4d2e1d791805237934d8333fa14283bf5bac184020b71fdfdcd80fd25b65 -->
