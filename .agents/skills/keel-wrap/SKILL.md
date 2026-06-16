---
name: keel-wrap
description: Finish the current work session — run the configured gates, commit, push, open a PR, and record a session recap. Project-neutral; reads .keel/project.yaml.
---

# keel-wrap

Use this skill when the user asks to run the keel command `wrap` (e.g. `keel wrap ...`, `wrap <args>`, or `/keel:wrap`). It reads every project value from `.keel/project.yaml` via the `keel` CLI.

# /keel:wrap

## Live progress — stamp this run (required)

So this run shows live on `keel-visual`'s board, record it with `keel activity` **as you
go**. This command's phases are: `config` → `sanity` → `gates` → `commit` → `push` → `recap`. Pick one stable `--run-id` for the whole run
(e.g. `wrap-<issue-or-pr>`):

- **Right now, before the work below**, stamp the first phase:
  `keel activity .keel/project.yaml --root . --write --command wrap --run-id "$RUN" --phase config`
- Re-run with the next `--phase` (`sanity`, …) **as you advance** through the flow.
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

Wrap up the current work session. This adapter is project-neutral: it contains no
branch name, build/lint command, or path literal. Read every project specific
from `.keel/project.yaml` via the `keel` CLI (`base_branch`, `build_gate_cmd`,
`lint_cmd`).

## Language

All committed/published artifacts (commits, branch names, PR/issue titles and
bodies, comments, file contents) MUST be written in English. Free-form chat may
stay in any language (`knobs.sot_doc` § language policy).

## Step 0 — Resolve config

```bash
keel validate .keel/project.yaml --root .
keel plan     .keel/project.yaml --root .   # base_branch, build_gate_cmd, lint_cmd
keel plan     .keel/project.yaml --root . --command wrap --live --json
```

The live plan is the operator-consent preflight. Before committing, pushing, opening a PR,
writing a recap, using secrets, publishing, or calling production-adjacent systems, parse
`contract.operator_consent`; if `requires_operator_consent` is true, STOP and ask the
operator to rerun with the required `--approve-scope` values.

Resolve GitHub access through the shared runtime contract (`keel capabilities --json` →
`github_transport`). GitHub writes use the selected transport. The PR is opened **ready**
(not draft) only when `pr_write` is supported; otherwise stop with the degraded operation
listed instead of falling through to an implicit best effort.

## Step 1 — Sanity check

1. `git status --short`
2. If on `base_branch` (or any protected base), ABORT — tell the user to switch
   to a feature branch.
3. `git diff --stat HEAD`
4. **Workspace isolation check:** `/keel:wrap` MUST run from a **linked
   worktree**, not the main worktree (the user's primary checkout). Detect with
   `git rev-parse --git-dir`: the main worktree returns the literal `.git`; a
   linked worktree returns an absolute path containing `/.git/worktrees/<name>`.
   If the value is `.git`, ABORT and tell the user to re-run from a linked
   worktree (list candidates with `git worktree list`). This check is portable
   across OSes/home directories and immune to symlink trickery (`.git` resolution
   is performed by git, not by shell-level path matching).

## Step 2 — Quality gates (do NOT skip)

Run the configured gates via the keel CLI so the command strings stay
config-driven (`build_gate_cmd` + `lint_cmd` plus any `tester` Lego):

```bash
keel run-gates .keel/project.yaml --root .
```

Any file-change-conditional suites (schema migration, entitlement, or
config-validation checks gated on which paths changed) are **project-specific;
stay in the project** — express them as a `.keel/extensions/` Lego that
`run-gates` picks up, never inline a project command here.

If any gate FAILS — STOP. Report the failure. Do not commit broken code.

## Step 3 — Commit

- `git add -A`
- Write a commit message in Conventional Commits format
  (feat/fix/chore/docs/refactor/test).
- Include `Closes #N` if this implements an issue.
- `git commit -m "<message>"`

## Step 4 — Push + PR

- `git push -u origin HEAD`
- If a PR-title argument was provided, use it as the PR title; otherwise derive
  from the commit message.
- Include the agent run codename in the PR body when the branch was produced by
  an agent run.
- Open the PR with `base=<base_branch>` (or the current PR target),
  `head=<current branch>`, the resolved title, and a body covering: `Closes #N`,
  a Summary of what changed, the agent run codename (or none), docs impact, and a
  test plan. Open it ready, not draft, in both `gh` and MCP modes.

## Step 5 — Session recap

Append a session recap to the project's session log: what was accomplished,
what's still open, and what to pick up next session. Hand deferred items to the
cross-session morning queue for `/keel:morning`. Read `contract.run_ledger.path` with
`keel ledger .keel/project.yaml --root . --json` and include structured ship outcomes in
the recap when present. Missing ledger files are an empty history; malformed records block
the recap until the operator resolves the corrupted ledger.

Before declaring the session clean, include the ledger payload's `capture_health` block in
the recap. The recap must distinguish applied capture, marker-only learning, allowed
skips, deferred capture, and missing markers. If `capture_health.status` is
`needs-reconcile`, list the dry-run-safe commands from
`capture_health.reconcile_actions` and hand the gap to the morning queue; do not mutate the
ledger, GitHub, or project capture destinations from this reporting step.

<!-- keel-generated: surface=skills command=wrap keel_version=1.6.5 source_sha256=6d6b85fa68abda9dc20c031ff4f78c42840817f31d91070051e7410f8587379a generated_sha256=94b2a0ddef6c4f74d99d273a1c19b22cd54b399ae9f565714f6b51b04cc65d09 -->
