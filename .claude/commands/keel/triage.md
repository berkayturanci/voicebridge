---
description: Auto-classify open issues missing a status label by spawning a classifier subagent and applying role/priority/status labels from the existing label set; risk-tier from tier3_globs. Project-neutral; reads .keel/project.yaml.
argument-hint: "[--dry-run] [--label <name>] [--assign]"
allowed-tools: Bash(keel:*), Bash(gh:*), Read, Agent
---

# /keel:triage

## Live progress — stamp this run (required)

So this run shows live on `keel-visual`'s board, record it with `keel activity` **as you
go**. This command's phases are: `config` → `find` → `tier` → `classify` → `rank` → `apply` → `summary`. Pick one stable `--run-id` for the whole run
(e.g. `triage-<issue-or-pr>`):

- **Right now, before the work below**, stamp the first phase:
  `keel activity .keel/project.yaml --root . --write --command triage --run-id "$RUN" --phase config`
- Re-run with the next `--phase` (`find`, …) **as you advance** through the flow.
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

Project-neutral backlog triage. This adapter contains no repo, role name, path
glob, or label literal beyond the generic vocabulary below — read every project
specific from `.keel/project.yaml` via the `keel` CLI (`tier3_globs`,
`implementer_agents`, repo).

The command scans open issues missing any `status:*` label, spawns one classifier
subagent per issue that proposes a routing role + `priority:* + status:*` label
triple drawn **only from the existing repo label set**, applies those labels, and
posts a one-line audit comment. It is **advisory and label-only**: it never edits
titles or bodies, never closes or assigns issues (except the role label under
`--assign`), and never invents new labels.

## Language

All committed/published artifacts (commits, branch names, titles/bodies,
comments, file contents) MUST be written in English. Free-form chat may stay in
any language (`knobs.sot_doc` § language policy). The per-issue audit comment is a
published artifact and MUST be English.

## Step 0 — Resolve config

```bash
keel validate .keel/project.yaml --root .
keel plan     .keel/project.yaml --root .   # tier3_globs, implementer_agents, repo
keel plan     .keel/project.yaml --root . --command triage --live --json
```

The live plan is the operator-consent preflight. Before spawning classifiers, applying
labels, posting audit comments, using secrets, publishing, or calling production-adjacent
systems, parse `contract.operator_consent`; if `requires_operator_consent` is true, STOP
and ask the operator to rerun with the required `--approve-scope` values. Pass
`operator_consent.delegated_agent_scope` into every classifier brief. Classifiers may use
only `approved_mutation_scopes`; scope expansion blocks or escalates.

The **role/platform** vocabulary is project-defined — derive it from the keys of
`implementer_agents` (each key is a routing role). Do not hardcode role names.
Legacy wrappers that used `platform:*` labels must migrate by either defining
matching routing-role keys in project config for the transition or translating the
legacy platform value to one configured role before invoking this adapter. keel
core never invents `platform:*` labels and never broadens the vocabulary at
runtime.

## Step 0 — Parse arguments

Argument grammar (no positional arguments; reject any positional value and any
unknown `--` flag):

- `--dry-run` — boolean. Perform every read but skip every label-add and
  comment-post mutation. Each would-be mutation is redirected to stdout as
  `DRY-RUN: <command>`.
- `--label <name>` — optional filter: only triage issues already carrying
  `<name>`.
- `--assign` — also set the **role label** that routes the implementer
  (`implementer_agents`). Without it, the role/platform label is suggested but the
  routing assignment is left to a human / `/keel:ship`.

Worked examples:

```
/keel:triage             → DRY_RUN=false
/keel:triage --dry-run   → DRY_RUN=true (full computation, no writes)
```

## Step 0 — Runtime detection (gh vs GitHub MCP)

GitHub access goes through `gh` (CLI when available) or the GitHub MCP read/write
tools (sandbox/web runtime). State the detected mode in the first user-facing
line. Mappings, applied whenever the prose names a `gh` call:

| gh CLI | GitHub MCP equivalent |
|---|---|
| list open issues with labels/body | list-issues (state=open, page size 100); apply the same client-side filter (drop issues whose labels include any `status:*`) |
| view issue / view issue comments (subagent) | issue-read (get / get-comments); subagents stay read-only |
| comment on issue | add-issue-comment |
| add labels to issue | issue-write (update). MCP **overwrites** the label set — compute the union of existing + new labels explicitly before calling and log the exact added vs. preserved label difference. |

`--dry-run` semantics are identical in both modes: every would-be mutation is
redirected to a `DRY-RUN:` stdout line and skipped.

## Step 1 — Find issues missing a status:* label

List open issues and filter to those with no `status:`-prefixed label (and, if
`--label` was given, only those carrying that label). Capture `number`, `title`,
`body`, and the existing `labels` array — you never strip a pre-existing label,
you only **add** the missing role / priority / status components, and only where
each component is currently absent.

If the result is empty, print `No untriaged issues — nothing to do.` and exit 0.

## Step 2 — Risk tier (deterministic, from config)

For each candidate, infer a **risk tier** deterministically from the files the
issue implies vs. `tier3_globs`: an issue touching a tier-3 glob is **high risk**
(needs deeper review / a senior reviewer). This is config-driven keel work, not a
model guess — keep it deterministic for identical backlog state. Carry the tier
into the audit comment and the ranking.

## Step 3 — Classify each issue via a subagent

For every candidate, spawn one general-purpose `Agent`. Its task is purely
classification: it MUST NOT mutate anything (no label edits, no comments). It may
read extra context (view the issue / its comments) but stays read-only. Propagate
`DRY_RUN` into the prompt so the agent knows it is read-only even when the flag is
off — classification is always read-only.

### Allowed label set (closed vocabulary — do NOT invent labels)

- Role/platform: one of the **roles defined in `implementer_agents`** (config).
- Priority: one of `priority:critical`, `priority:high`, `priority:medium`,
  `priority:low`.
- Status: one of `status:backlog`, `status:in-progress`, `status:needs-review`,
  `status:needs-test`, `status:needs-fix`, `status:done`, `status:blocked`.

If the agent cannot confidently pick a role/platform, default to the project's
neutral/shared role (the catch-all key in `implementer_agents`, or the host
agent).

### Classifier subagent prompt (template)

```
You are classifying a single GitHub issue. Output exactly one JSON object on
stdout, nothing else:

  {"role": "...", "priority": "...", "status": "...", "reasoning": "..."}

Constraints (closed vocabulary — picking anything outside these lists is a bug):
  role     ∈ the roles defined in implementer_agents (passed in below)
  priority ∈ {priority:critical, priority:high, priority:medium, priority:low}
  status   ∈ {status:backlog, status:in-progress, status:needs-review,
              status:needs-test, status:needs-fix, status:done, status:blocked}
              OR the literal "" (empty) if the issue body explicitly declares
              itself a meta/tracking/umbrella issue.

Priority heuristics:
  - Keywords "crash", "ANR", "alert", "security", "CVE", "data loss",
    "auth bypass" + user-visible impact or data loss ⇒ priority:critical.
  - Reproducible production bug, no data loss ⇒ priority:high.
  - Reproducible non-production bug, or a small feature ⇒ priority:medium.
  - Refactor / cleanup / docs / cosmetic / nice-to-have ⇒ priority:low.

Status:
  - Default to status:backlog for any fresh untriaged issue.
  - If the body explicitly says this is a meta/tracking/umbrella issue (e.g.
    "tracking issue for ...", a "meta:" prefix, or a body that is purely a
    checklist of other issue links), set status to "" and explain in reasoning;
    the orchestrator posts a note and skips the status label.

Role/platform heuristics:
  - Map the files/paths the issue implies to the routing role in
    implementer_agents (e.g. a path that matches a role's ownership ⇒ that role).
  - Source-of-truth doc / agent config / slash commands / shared schema ⇒ the
    neutral/shared role.
  - If unclear, default to the neutral/shared role.

reasoning MUST be a single sentence ≤ 120 chars, English.

Issue payload:
  number: <N>
  title: <TITLE>
  existing labels: <CSV of label names>
  risk tier: <tier from Step 2>
  roles: <CSV of implementer_agents keys>
  body: <BODY>

You MAY read the issue or its comments for extra context but MUST NOT run any
mutating command. You are read-only regardless of the orchestrator's --dry-run
flag.
```

Parse the JSON. Validate every field is in the allowed set; if validation fails,
log `skip #<N>: classifier returned out-of-vocabulary label '<value>'` and move
on — do not retry, do not guess (silent fallback would let bad labels leak in).

## Step 4 — Rank by readiness

Rank the classified issues: clear + unblocked + high-severity (and high risk
tier) first; vague / blocked / low-priority last. Deterministic ordering for
identical backlog state.

## Step 5 — Apply labels (or print the dry-run table)

Build the proposed label set per issue:

- Add the `role/platform` label only if the issue has none — **and only write the
  routing assignment when `--assign` is set**; without `--assign` the role is
  shown as a suggestion.
- Add the `priority:*` label only if the issue has none.
- Add the `status:*` label only if the classifier returned a non-empty status (so
  meta/tracking issues stay status-less).

### Under `--dry-run`

Print a table and exit; no writes occur. Both the comment post and the label edit
are skipped — log each as `DRY-RUN: <comment command>` and
`DRY-RUN: <label-add command>`.

```
DRY-RUN — proposed classification
| # | title | risk | proposed labels | reasoning |
|---|---|---|---|---|
| 512 | bug: foo crashes on resume | high | <role>,priority:high,status:backlog | reproducible crash on resume path |
| 519 | docs: typo in source-of-truth doc | low | <shared-role>,priority:low,status:backlog | cosmetic docs fix |
```

### Otherwise (live run)

For each issue, in order:

1. Post one audit comment:
   `auto-triaged: <labels> (risk: <tier>) — <reasoning>`
   where `<labels>` is the comma-joined set of labels actually being added (not
   pre-existing ones) and `<reasoning>` is the classifier's one sentence.
2. Apply the labels additively (never remove a label; never pass a label outside
   the closed vocabulary). In MCP mode, write the explicit union of existing + new
   labels.

If either call fails for an issue, log the failure and continue with the next —
one bad issue does not abort the run.

## Step 6 — Session summary

Print a one-screen summary:

```
Triage summary
--------------
classified: <n>
skipped (meta / out-of-vocab / api error): <n>
assign: <true|false>
dry-run: <true|false>
```

Under `--dry-run`, `classified` reflects would-be classifications, not actual
writes. Hand ready items to `/keel:ship`.

## Stop conditions / safety invariants

- **Never invent labels.** The role (from `implementer_agents`) / priority /
  status vocabularies are the entire allowed set. If the repo label set changes,
  update config in the same commit — never broaden the vocabulary at runtime.
- **Never modify titles or bodies.** Labels and comments only.
- **Never close issues; only assign the role label under `--assign`.** Closure is
  a human / `/keel:ship` decision.
- **`--dry-run` propagates to subagents.** Classifier subagents are read-only
  regardless; the prompt states it so an agent never starts mutating on its own.
- **One issue's failure does not abort the run.** Per-issue errors are logged and
  the loop continues; only Step 0 argument parsing is fatal.
- **No silent dry-run mutations.** Under `--dry-run`, every state-changing call is
  redirected to a `DRY-RUN: <command>` stdout line and skipped.

## Prerequisites

- `gh` authenticated with `repo` scope (issue read / edit / comment), or the
  GitHub MCP tools in a sandbox/web runtime.
- The closed label vocabulary above (the `implementer_agents` roles + the
  priority/status families) must exist in the repo. If any label is missing, fix
  the repo labels (not this command) before invoking.

<!-- keel-generated: surface=claude command=triage keel_version=1.6.5 source_sha256=11f13596a4347f6c02ed8f45ee21e844271ed251ffa9cdfd71617f63caeb072f generated_sha256=11f13596a4347f6c02ed8f45ee21e844271ed251ffa9cdfd71617f63caeb072f -->
