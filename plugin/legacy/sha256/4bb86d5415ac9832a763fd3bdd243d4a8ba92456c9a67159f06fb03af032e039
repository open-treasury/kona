---
name: issues
description: Require durable issue and epic tracking for planning, implementation, and task management. Use for substantive work and whenever the user mentions issues, tasks, epics, dependencies, blockers, ready work, claims, handoffs, or br.
---

# Track work with issues

Use issues as the durable record of planned and active work. The `br` CLI is the sole todo and task
tracker for the current backend. Do not maintain a parallel todo list, Markdown checklist, chat-only
plan, or private memory of follow-up work.

Use **issue** as the canonical tracked-object term. An **epic** groups a substantial feature. A
**task** is an executable issue type.

Never invoke, install, recommend, or fall back to the original Beads `bd` command. Never install,
initialize, configure, inspect, migrate, or depend on Dolt. Never read or edit tracker storage
directly.

## 1. Establish the backend

Before planning or substantive implementation, check whether the executable named exactly `br` is
available. Do not probe `bd`.

If `br` is unavailable:

1. choose a supported Beads Rust installation method for the environment;
2. show the exact command, source, and expected system effect;
3. ask for explicit confirmation;
4. install only after approval, then verify the executable and version.

Do not replace or upgrade an existing `br` installation through this flow. Silence, ambiguity, or
approval of another action is not installation consent.

Determine initialization through an advertised read-only `br` command. If the project is not
initialized, explain the project-level effect and ask for explicit confirmation before running
`br init`. One response may authorize installation and initialization only when both actions were
disclosed. If either action is declined or fails, report that tracked work is blocked. Do not create
substitute task state.

## 2. Discover commands

Use the installed CLI's root and subcommand help before relying on uncertain syntax, flags, statuses,
issue types, dependency types, or output shapes. Prefer advertised machine-readable output. If a
required operation is unavailable, stop instead of guessing or emulating it outside `br`.

Use these semantics even when syntax varies:

- inspect project health and ready work;
- create, read, claim or activate, update, and close issues;
- create epics and parent-child relationships;
- make dependent work depend on its blocker;
- detect dependency cycles and verify the ready set;
- re-read affected state after every mutation.

Examples such as `br ready --json`, `br show <issue-id> --json`, `br update <issue-id> --claim`, and
`br close <issue-id> --reason <evidence>` are illustrative. Confirm support before use.

## 3. Represent all work as issues

Before substantive implementation, reuse an existing issue or create one. Do not begin work that
exists only in the prompt or conversation.

For a small bounded change, use one issue. For a substantial feature, reuse or create one epic and
decompose it into child issues before implementing a child. Work is substantial when it has multiple
independently deliverable units, crosses components or interfaces, includes migration work, or
requires dependency ordering. Follow explicit project policy; ask the user when a borderline choice
changes whether decomposition is needed.

Each executable issue must state the outcome, bounded scope, relevant constraints, enough design
context for a fresh agent, objective acceptance criteria, and required dependencies. Reuse or refine
existing issues instead of creating duplicates. Preserve established types, priorities, labels, and
states instead of inventing policy.

After graph changes, verify that dependencies are acyclic and ready work contains only genuinely
actionable issues. Numbering or creation order does not imply a dependency.

## 4. Execute one issue

1. Inspect the user-named issue or select one actionable issue from ready work.
2. Read its parent epic, blockers, acceptance criteria, claim state, and relevant evidence.
3. Claim or mark it active before substantive implementation when supported.
4. Do not silently take work held by another active actor. Follow explicit coordination policy; age
   alone does not authorize takeover.
5. Implement only the selected issue's scope.
6. Record material progress, discoveries, changed assumptions, blockers, and handoff facts, not
   routine narration.
7. Create or update issues and dependencies for newly discovered required work before undertaking it.
8. Run applicable verification and compare it with the acceptance criteria.
9. Close only when the criteria pass, with a reason summarizing the outcome and evidence.
10. Re-read the issue and epic. Report newly ready work when useful, but do not automatically start
    another issue unless the user or active workflow authorized continued execution.

If blocked or verification fails, leave the issue accurately non-closed and record recovery context.
After a partial mutation failure, re-read current state before retrying.

## 5. Preserve boundaries

- Preserve user-authored issue intent. Change scope, priority, dependencies, acceptance criteria, or
  closure only when supported by the request, evidence, or governing workflow, and record rationale.
- Tracker work does not authorize commits, pushes, pulls, merges, releases, or other version-control
  actions.
- Keep queries focused on the active issue and relevant graph neighborhood.
- Use the backend only for issue state. Product and technical decisions remain governed by their
  approved sources.

## 6. Finish

Report issue and epic identifiers, resulting states, verification, unresolved blockers, and newly
ready work when relevant. Never claim success when installation, initialization, a required
operation, or verification did not complete.

The public capability is `issues`; `br` is its required backend for this release. Keep issue and epic
semantics separate from backend commands so a future Kona backend can replace `br` without changing
the workflow contract.
