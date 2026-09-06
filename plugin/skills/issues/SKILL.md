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
issue types, dependency types, or output shapes. For epic metadata, inspect the root, `create`,
`show`, and `update` help before use. Require machine-readable JSON plus advertised support for
`--agent-context`, `source_repo_path`, and the advertised atomic `--claim`. If a required operation
is unavailable, stop instead of guessing or emulating it outside `br`.

Use these semantics even when syntax varies:

- inspect project health and ready work;
- create, read, claim or activate, update, and close issues;
- create epics and parent-child relationships;
- make dependent work depend on its blocker;
- detect dependency cycles and verify the ready set;
- re-read affected state after every mutation.

Examples such as `br ready --json`, `br show <issue-id> --json`, `br update <issue-id> --claim`, and
`br close <issue-id> --reason <evidence>` are illustrative. Confirm support before use.

The epic-worktree helper's portable operations are `propose`, `start`, `check`, and `finish`. Resolve
the helper from the installed `epic-worktree` skill and follow that skill's current request/result
contract. Invoke it with Node, pass one schema-versioned JSON request on stdin, and consume its JSON
result. Commands in this skill are illustrative and help-discovered; never interpolate epic data or
confirmation tokens into shell command text, issue Git commands in place of the helper, or persist
helper-owned state outside the epic.

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

### Epic metadata

On epic creation, capture the epic's title as the immutable `agent_context.kona.epicSlugSeed`. Set
`source_repo_path` through the advertised `br` create or update interface to the canonical primary
repository root. Preserve the complete existing `agent_context`, leave `kona.workspace` absent, and
do not invoke `start`. Missing `kona.workspace` is the only `not-started` representation; never store
a null, empty, or partial workspace.

The issues workflow owns the reserved `agent_context.kona.workspace` object. A workspace has
`schemaVersion`, `state`, `epicKey`, `relativePath`, `branch`, `baseCommit`, `creationReadiness`, and
`lastCheck`. Its state is exactly `starting`, `active`, `cleanup-pending`, or `finished`. Keep the
relative path rather than an absolute path so the mapping remains clone-portable. The immutable slug
seed, epic key, relative path, branch, and base commit cannot be replaced because a title or checkout
location later changes.

Treat `agent_context` and `kona` as JSON objects. Malformed or non-object `agent_context` and any
reserved-key type conflict must fail closed. For each metadata change, deep-copy the complete current
`agent_context`, modify only `kona.epicSlugSeed` or `kona.workspace`, and send the complete merged
object through the advertised `--agent-context` interface. Preserve semantic equality of every
unrelated top-level key, every other `kona` key, and all of their JSON values.

Canonicalize `source_repo_path` on every start, resume, and finish. Require it to identify the
canonical primary repository root and the same Git common directory reported by the helper. A
mismatch must stop the workflow. `source_repo_path` locates and validates the source repository; it
is not the workspace mapping authority and cannot replace `kona.workspace.relativePath`, branch, or
base commit. Build the helper's `knownMappings` from advertised JSON queries over epics whose
canonical `source_repo_path` identifies this repository.

### Conflict-safe context writes

`br` does not provide an atomic compare-and-set operation for arbitrary `agent_context`; do not
invent one or claim that the following protocol eliminates non-cooperating writer races.

1. Read the complete epic as JSON, verify its identity, parent, status, context types, and claim, then
   hash the canonicalized `agent_context` with the relevant epic identity.
2. Immediately before each context write, re-read the epic. Require the expected claim and context
   digest. If the digest differs, report `ISSUE_CONTEXT_CONFLICT`, do not write, and do not invoke the
   next transition.
3. Deep-copy that complete current `agent_context`, merge only the intended reserved value, and write
   the complete merged context through the advertised interface.
4. Re-read after the write. Require the exact intended reserved value and semantic preservation of
   all unrelated context. On a post-write mismatch, fail closed with before, expected, and after
   evidence; do not attempt a blind rollback.

The atomic claim serializes cooperating actors. The helper's repository lock separately serializes
Git mutations. Resume and finish require the existing claim holder or a newly successful advertised
atomic claim; never steal a claim based on age.

## 4. Execute one issue

1. Inspect the user-named issue or select one actionable issue from ready work.
2. Read its parent epic, blockers, acceptance criteria, claim state, and relevant evidence.
3. For an epic child, pass the epic workspace dispatch gate in section 7 before granting source-edit
   authority.
4. Claim or mark it active before substantive implementation when supported.
5. Do not silently take work held by another active actor. Follow explicit coordination policy; age
   alone does not authorize takeover.
6. Implement only the selected issue's scope.
7. Record material progress, discoveries, changed assumptions, blockers, and handoff facts, not
   routine narration.
8. Create or update issues and dependencies for newly discovered required work before undertaking it.
9. Run applicable verification and compare it with the acceptance criteria.
10. Close only when the criteria pass, with a reason summarizing the outcome and evidence.
11. Re-read the issue and epic. Report newly ready work when useful, but do not automatically start
    another issue unless the user or active workflow authorized continued execution.

If blocked or verification fails, leave the issue accurately non-closed and record recovery context.
After a partial mutation failure, re-read current state before retrying.

## 5. Start or resume an epic workspace

For an epic with no workspace, creation ordering is mandatory:

1. Read the epic and full context, verify its type, parent, status, immutable slug seed, absent
   workspace, source repository identity, and known mappings, then retain the canonical context and
   identity digest.
2. Call `propose` before claiming. It is read-only. Display the proposed path, branch, base policy,
   blockers, and relevant repository snapshot to the user.
3. Ask for explicit confirmation of that displayed creation proposal and exact start action.
   Declining performs no claim, helper mutation, or context mutation; do not call mutating `start`.
4. Run the advertised atomic claim only after confirmation. Claim refusal means another actor owns
   the start: stop and do not invoke the helper.
5. Re-read the epic, verify the claim result, unchanged expected context, and source repository, then
   capture the new context digest. A conflict requires a fresh proposal and confirmation.
6. Invoke confirmed `start` with the exact proposal token only after the claim succeeds. Supply the
   extracted workspace as null, the immutable epic ID and slug seed, known mappings, and only setup
   or baseline argv discovered from cited repository guidance or project configuration.
7. Preserve every helper-created artifact. Record a successful or recoverable partial workspace as
   `starting` using the conflict-safe write protocol. Never reset, refresh, force-remove, prune, or
   delete a branch to compensate for failure.
8. Treat creation as transition-required, not ready. Enter or relaunch the host at the reported
   worktree path and run a host-local `check`. Keep `starting` and block implementation until that
   active host proves its top level is the mapped linked worktree.

Transition `starting` to `active` only when the host-local `check` returns `READY`, including any
helper-validated baseline exception. Persist its creation readiness and `lastCheck` evidence through
the conflict-safe write protocol. `READY_EXISTING_WORK` never activates `starting`; dirty starting
work remains blocked and preserved.

To resume, load the existing `kona.workspace`, validate the source repository and claim, enter its
expected relative path, and invoke only `check`. Never call `start`, fetch, or pull during resume. A
clean valid workspace may return `READY`. `READY_EXISTING_WORK` is accepted only when the mapping is
already `active`, its identity checks pass, and stored creation-baseline evidence is accepted; it
means setup and baseline were skipped to preserve existing tracked or untracked bytes. Any other
result blocks implementation without repair or refresh.

## 6. Finish an epic workspace

After implementation and issue verification, validate the mapping, source repository, and claim,
then call unconfirmed `finish` for a read-only cleanup preflight. Display dirty state, branch-tip and
registration checks, upstream/`origin/main` containment warnings, the exact path, and the proposed
non-forced worktree-only removal.

If preflight is unsafe, set the mapping to `cleanup-pending` through the conflict-safe write protocol
and stop. If it is safe, ask for removal confirmation using the separate finish confirmation token;
a start token is never valid. Declining removal performs no helper mutation and also leaves or sets
`cleanup-pending`. On confirmation, pass the exact preflight token to confirmed `finish` without
changing its bound context first.

Write `finished` only after the helper returns `REMOVED` and verifies that the worktree registration
and directory are absent while the expected branch remains at its prior object ID. Unsafe, declined,
or failed removal remains `cleanup-pending`. Retain the historical mapping and branch name. Never
force removal, delete the branch, prune, clean, push, merge, rebase, or repair Git metadata.

## 7. Enforce the dispatch gate

Every implementation dispatch path for an epic or its children requires
`kona.workspace.state === active` and a current host-local result of `READY` or
`READY_EXISTING_WORK` before granting source-edit authority. Registration, a stored prior check, a
workspace on another host, `starting`, `cleanup-pending`, or `finished` is insufficient.

`READY_EXISTING_WORK` is valid only for an already-active mapping with accepted creation-baseline
evidence. It authorizes preservation and continuation of that existing work, never creation or a
`starting` to `active` transition. On every blocked result, retain the current bytes and accurately
record the blocker without granting implementation authority.

## 8. Preserve boundaries

- Preserve user-authored issue intent. Change scope, priority, dependencies, acceptance criteria, or
  closure only when supported by the request, evidence, or governing workflow, and record rationale.
- Tracker work does not authorize commits, pushes, pulls, merges, releases, or other version-control
  actions. Only the separately confirmed epic-worktree helper flow authorizes its specified Git
  mutation.
- Keep queries focused on the active issue and relevant graph neighborhood.
- Use the backend only for issue state. Product and technical decisions remain governed by their
  approved sources.

## 9. Report completion

Report issue and epic identifiers, resulting states, verification, unresolved blockers, and newly
ready work when relevant. Never claim success when installation, initialization, a required
operation, or verification did not complete.

The public capability is `issues`; `br` is its required backend for this release. Keep issue and epic
semantics separate from backend commands so a future Kona backend can replace `br` without changing
the workflow contract.
