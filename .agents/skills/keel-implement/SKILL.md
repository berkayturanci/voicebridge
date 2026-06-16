---
name: keel-implement
description: Delegate a single issue to the right implementer and drive the s4 implement step standalone. Project-neutral — every project specific is read from .keel/project.yaml via the keel CLI.
---

# keel-implement

Use this skill when the user asks to run the keel command `implement` (e.g. `keel implement ...`, `implement <args>`, or `/keel:implement`). It reads every project value from `.keel/project.yaml` via the `keel` CLI.

# /keel:implement

## Live progress — stamp this run (required)

So this run shows live on `keel-visual`'s board, record it with `keel activity` **as you
go**. This command's phases are: `config` → `fetch` → `branch` → `resolve` → `codename` → `delegate` → `report`. Pick one stable `--run-id` for the whole run
(e.g. `implement-<issue-or-pr>`):

- **Right now, before the work below**, stamp the first phase:
  `keel activity .keel/project.yaml --root . --write --command implement --run-id "$RUN" --phase config`
- Re-run with the next `--phase` (`fetch`, …) **as you advance** through the flow.
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

The standalone **implement step (`s4`)** of the keel backbone. This adapter is
project-neutral: it contains no branch name, build command, agent, path glob, or
timezone. Read every project-specific value from `.keel/project.yaml` via the
`keel` CLI.

> **Hard rule.** If you are about to type a literal like a base-branch name, a
> build/lint command, an implementer agent, or a path glob — **stop** and read it
> from config (`base_branch`, `build_gate_cmd`, `lint_cmd`, `implementer_agents`,
> `tier3_globs`). Hardcoding a project specific here is the exact bug keel exists
> to kill.

## Language

All committed/published artifacts (commits, branch names, PR/issue titles and
bodies, comments, file contents) MUST be written in English. Free-form chat with
the user may stay in any language. (project-specific language policy lives in the
project's source-of-truth doc — `knobs.sot_doc`.)

## Step 0 — Resolve config

```bash
keel validate .keel/project.yaml --root .   # abort if config/extensions invalid
keel plan     .keel/project.yaml --root .    # read base_branch, implementer_agents, tier3_globs
keel plan     .keel/project.yaml --root . --command implement --live --json
```

The live plan is the operator-consent preflight. Before posting comments, creating a
worktree/branch, delegating, editing files, committing, pushing, opening a PR, using
secrets, publishing, or calling production-adjacent systems, parse
`contract.operator_consent`; if `requires_operator_consent` is true, STOP and ask the
operator to rerun with the required `--approve-scope` values. Store
`operator_consent.delegated_agent_scope` for Step 5.

Read the knobs you will need: `base_branch`, `implementer_agents`, `tier3_globs`,
`build_gate_cmd`, `lint_cmd`.

## Step 1 — Fetch the issue

Read the issue (title, body, labels) via `gh` (CLI when available) or the GitHub
MCP read tools (sandbox/web runtime). Capture `number`, `title`, `body`, and the
`labels` array — the role/platform label drives implementer routing below.

Rerun the live preflight with the selected issue context before branch/worktree
or delegation:

```bash
keel plan .keel/project.yaml --root . --command implement --live --json \
  --target "issue #<N>" \
  --issue-title "$ISSUE_TITLE" \
  --issue-body "$ISSUE_BODY" \
  --issue-label "$ISSUE_LABELS"
```

Parse `contract.issue_intake`. If `status` is `needs-input`, ask or post the
generated `questions` and stop before any code mutation. If `status` is
`blocked` or `out-of-scope`, record the `ledger_record`, report the skip reason,
and stop. Only `ready` may continue to Step 2.

## Step 2 — Check for an existing branch

Look for a branch already associated with this issue (e.g. matching
`*issue-<N>*`). If one exists, report it and ask the human whether to continue on
it or start fresh — do not silently clobber in-flight work.

## Step 3 — Resolve the implementer

Resolve the implementer agent from `implementer_agents` keyed by the issue's
**role/platform label**, overridden by `--delegate`, defaulting to the **host
agent**. Do not hardcode an agent name — the mapping is config.

Project-specific routing nuances (e.g. a particular file-pattern that demands a
specialized tool or a record-and-validate script for snapshot/baseline tests)
live in the project, not here: express them as a `.keel/extensions/` Lego
(an `after-implement` slot) or mark them "(project-specific; stays in the
project)".

## Step 4 — Agent run codename + start comment

Mint an agent run codename and record attribution. Use a deterministic,
collision-free form: `<ROLE_PREFIX>-<issue>-<UTC timestamp>` where `ROLE_PREFIX`
derives from the resolved implementer role and the timestamp is generated at run
time (UTC, e.g. `YYYYMMDD-HHMMSS`). Attribution is `agent:<vendor>` plus a
versionless `model:<base>`.

Post a start comment on the issue before delegating (via `gh` or the GitHub MCP
comment tool), including: codename, chosen agent, implementer system (host agent
id), and the planned branch name.

## Step 5 — Delegate (with worktree isolation)

Dispatch to the resolved implementer with the issue context. Mandatory steps the
implementer must follow:

0. Receive and obey the approved `operator_consent.delegated_agent_scope`. If the
   implementer attempts work outside `approved_mutation_scopes`, the orchestrator blocks or
   escalates. Secret access requires explicit `secrets` approval for this run.
1. Read the project's source-of-truth doc (`knobs.sot_doc`) and any platform
   context it points to.
2. **Workspace isolation (mandatory):** before any code-modifying work, create a
   git worktree off `origin/<base_branch>` (config — never assume the branch) and
   perform every edit, build, and push from inside it. Never mutate the user's
   primary checkout. Use a repo-nested worktree path (never a sibling), e.g.:
   ```bash
   git fetch origin "$BASE_BRANCH" --quiet
   git worktree add -b feature/issue-<N>-<slug> worktrees/issue-<N> origin/"$BASE_BRANCH"
   ```
   Run the gates from inside that path. After the PR merges, clean up with
   `git worktree remove worktrees/issue-<N> --force`.
3. Implement all acceptance criteria with focused commits scoped to the issue.
4. Run the applicable gates from inside the worktree via the keel CLI so the
   command strings stay config-driven:
   ```bash
   keel run-gates .keel/project.yaml --root .
   ```
   This executes the built-in `build_gate_cmd` / `lint_cmd` plus any `tester`
   Lego. Gate selection that depends on which files changed (schema migration,
   entitlement, or config-specific suites) is project-specific: express it as a
   Lego or mark it "(project-specific; stays in the project)".
5. Include the codename in commits / PR body / final summary when practical.
6. Return the contract: codename, branch/commit, files changed, gate results,
   docs impact, and anything needing manual/device/infra verification.

## Step 6 — Report back + hand off

After the implementer completes, summarize: codename, branch/commit, what was
implemented, gate results, and anything needing manual verification. Post a
completion comment on the issue with the same codename and the gate results if
the implementer did not already do so.

Do **not** merge here — that is `/keel:ship`'s job (window + lock + review). Hand
the contract to `/keel:ship` (or `/keel:pr-loop`) to open the PR and drive
review / CI / merge.

Fail over to the host agent on delegate quota errors; attribute the **effective**
agent.

<!-- keel-generated: surface=skills command=implement keel_version=1.6.5 source_sha256=0cf5c8d3387b4736ebdccb7ea928fefe56dd4e280c517bfb9fe71d72593ec17d generated_sha256=79bd41da7e2d79d0ed5e2ee70c4eb21161a085b2c64d4e4a8cf3d726f3747be6 -->
