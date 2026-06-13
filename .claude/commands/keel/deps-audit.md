---
description: On-demand dependency security + licence audit across the project's ecosystems; classify security vs. routine, append findings to today's tracking issue, and route fixes to keel:ship.
argument-hint: "[<ecosystem>|all] [--severity low|moderate|high|critical] [--open-issues] [--dry-run]"
allowed-tools: Bash(keel:*), Bash(git:*), Bash(gh:*), Read, Edit
---

# /keel:deps-audit

## Command step evidence

Every numbered step in this command is contractual. Complete the step, record the
evidence it asks for, or explicitly mark it `N/A — <reason>` before moving on. If a step
has an external side effect such as a GitHub comment, issue, review, report, branch, or
PR, the side effect must be posted or written through the selected transport and cited in
the final summary. Never silently skip a step because the runtime, agent, or prompt feels
obvious.

Project-neutral dependency audit. Every project value — which ecosystems exist, the audit
command per ecosystem, the licence baseline path, the timezone for the run date, the risk map
— is read from `.keel/project.yaml` via the `keel` CLI. The actual audit tool for each
ecosystem is **the project's** (invoked through the toolchain referenced by `build_gate_cmd`);
this adapter never names a specific package manager.

The command is **read-only on application code**: it never edits dependency manifests or
lockfiles, never applies upgrades, never updates the licence baseline, and never closes the
tracking issue. It runs the project's per-ecosystem vulnerability audit, computes licence
drift against a committed baseline, and appends one codename-prefixed comment to today's
tracking issue. Re-runs append a fresh comment; the codename prefix is the search anchor that
lets a briefing or a later run find the latest run inside a multi-comment issue.

All published artifacts (issue/comment bodies) MUST be in English; free-form chat may be any
language.

## Step 0 — orient + parse arguments

```bash
keel validate .keel/project.yaml --root .
keel plan     .keel/project.yaml --root .     # read ecosystems, tier3_globs, timezone, repo
keel plan     .keel/project.yaml --root . --command deps-audit --live --json
```

The live plan is the operator-consent preflight. Before posting tracking comments, opening
issues, routing fixes to `/keel:ship`, using secrets, publishing, or calling
production-adjacent systems, parse `contract.operator_consent`; if
`requires_operator_consent` is true, STOP and ask the operator to rerun with the required
`--approve-scope` values.

Arguments:
- Positional, optional: one **ecosystem** the project declares, or `all`. Default `all`.
  Reject any value that is not a declared ecosystem or `all`; reject more than one positional.
- `--severity <level>` — one of `low`, `moderate`, `high`, `critical`. Default `moderate`.
  Severity ordering is a numeric map (`critical=4`, `high=3`, `moderate=2`, `low=1`); a finding
  is reported when `severity_rank >= threshold_rank`. Reject a missing or out-of-set value.
- `--security-only` — report only vulnerabilities (CVE/advisory findings); skip routine/licence
  reporting noise.
- `--open-issues` — open a deduped fix issue per finding (Step 6) and route each to
  `/keel:ship`. Without it the command is report-only against the tracking issue.
- `--dry-run` — compute the report and log the would-be tracking-issue create/comment to stdout
  as `DRY-RUN: …`, but make no write.
- Reject unknown flags.

## Step 1 — find or create today's tracking issue

Compute the run **date in the project timezone** (from the plan, never a hardcoded zone).
Search for an open tracking issue whose title is exactly `deps-audit: <DATE>`:
- Found → capture its number.
- Not found and not `--dry-run` → create it (title `deps-audit: <DATE>`, a one-line body
  noting each run appends a comment) and capture the number.
- Not found and `--dry-run` → print `DRY-RUN: would create tracking issue deps-audit: <DATE>`
  and continue (Step 6 will skip the post anyway).

## Step 2 — per-ecosystem vulnerability audit

For each in-scope ecosystem (skip ecosystems excluded by the positional), run the project's
declared audit command for that ecosystem via its toolchain. Many audit tools **exit non-zero
when they find anything** — capture output without letting that abort the run (the equivalent
of a trailing `|| true`). Parse the report and extract per vulnerability: the advisory/CVE id,
severity (normalise from any numeric CVSS the tool emits), the dependency name, the current
resolved version, the recommended non-vulnerable version, and a **fix-available** flag. Filter
to `severity_rank >= threshold_rank`.

**Graceful degradation (per ecosystem, never fatal):** if an audit tool is not wired up,
cannot run (missing installed deps, network down), or errors, do **not** abort. Add a note
under the report's "Skipped" section (`<ecosystem> audit skipped: <one-line reason>`) — e.g.
"audit plugin not wired up; follow-up: add it to the build" — and continue with the others.
The only fatal case is an argument-parse failure in Step 0.

## Step 3 — licence drift

Read the committed licence-baseline path from the project config. Format: sorted
`<package>@<version> <licence>` lines that are the canonical licence set for the current
lockfile state.
- Baseline **missing** → write a one-time scaffolding note to the report (capture the current
  set as a new baseline in a separate intentional commit) and skip the diff.
- Otherwise build the **current** licence set for each ecosystem that ran (read each installed
  package's declared licence; for ecosystems whose licences resolve over the network, skip that
  half with a note if the network is unreachable), sort it, and diff against the baseline.
  Classify each diff line as `added`, `removed`, or `changed` (same package, different
  licence/version). Empty diff → report `licences: no drift`.

## Step 4 — tier the findings

Tier every vulnerability and drift entry by blast radius against `tier3_globs`: a finding that
touches a tier-3 path (or a dependency consumed from one) is escalated — higher priority and a
tier label on any issue opened in Step 6.

## Step 5 — build the report comment

A single markdown body whose **literal first line** is the codename
`DEPS-AUDIT-<DATE>-<UTC_TIMESTAMP>`. **Codename pin (load-bearing):** no blank line above it,
no leading whitespace, no quoting, no Markdown prefix or surrounding formatting — downstream
consumers (briefing, future-run search anchors) locate the latest run by the
`DEPS-AUDIT-<DATE>-` prefix, and any deviation makes them miss it.

Body shape: a summary count line (`critical: n | high: n | moderate: n | low: n`, counting all
ecosystems that ran, after threshold filtering); one section per in-scope ecosystem (package ·
version · severity · advisory · fix-available); a licence-drift section (status · package ·
baseline licence · current licence); and a "Skipped" section.

Formatting rules:
- Omit an ecosystem section entirely if it was out of scope.
- An in-scope ecosystem with zero findings above threshold → a single italic line
  `_No <ecosystem> findings at or above <severity> severity._` in place of the table.
- Licence section ran with empty diff → `_licences: no drift_`.
- Omit "Skipped" if nothing was skipped.
- Under `--security-only`, omit the licence-drift section and any routine-update rows.

## Step 6 — post / open issues + route to ship

Locate any prior comment for today's run by the `DEPS-AUDIT-<DATE>-` prefix inside the tracking
issue. The comment API appends (it does not edit in place), and the prefix is the anchor — so
appending one comment per run is correct.
- `--dry-run` → print the body under `DRY-RUN: would post comment on issue #<N>:` and skip.
- Otherwise → post a fresh comment to the tracking issue.

When `--open-issues` is set, additionally open a **deduped** fix issue per finding (one issue
per CVE/dependency; do not re-open against an existing open issue for the same finding),
labelled by **severity** and **tier**, and hand each fix to **`/keel:ship`** (window + lock +
review). Never bump a dependency and merge directly from here. Under `--dry-run`, print
`DRY-RUN: would open issue …` per finding and route nothing.

## Stop conditions / invariants

- **Never auto-apply upgrades** — version bumps go through `/keel:ship`, not this command.
- **Never close the tracking issue; never modify manifests, lockfiles, or the licence
  baseline** (the baseline is updated by a separate intentional commit).
- **Per-audit failure continues with the others** — network/missing-tool/missing-baseline are
  reported under "Skipped", not fatal. Only Step 0 arg-parse failure is fatal.
- **No silent dry-run mutations** — every issue create / comment post is printed as `DRY-RUN: …`
  and skipped.
- Fail-soft · deterministic for identical inputs.

<!-- keel-generated: surface=claude command=deps-audit keel_version=1.2.3 source_sha256=2eb4428507b9b87917adae0dcff83e885423dc8eed861063698f2aa29ffa93f6 generated_sha256=2eb4428507b9b87917adae0dcff83e885423dc8eed861063698f2aa29ffa93f6 -->
