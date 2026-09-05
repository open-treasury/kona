# Epic Worktree Skill Technical Specification

## 0. TL;DR

- **SPEC status: Approved.** The sibling [PRD](./prd.md) is Approved and authoritative.
- Ship one canonical `epic-worktree` Agent Skill on OpenCode, Codex, Claude Code, and Pi, backed by a private zero-runtime-dependency Node.js 20+ helper rather than prose-assembled Git mutations.
- The helper exposes `propose`, `start`, `check`, and `finish`; only `start` and confirmed `finish` mutate Git, and both use digest-bound user confirmation.
- Every new epic uses `<repo-root>/.worktrees/<epic-key>` on `epic/<epic-key>`. Creation always performs a fresh `git pull --ff-only origin main` in the clean primary `main` worktree and starts the branch at exactly the resulting commit.
- Existing epic worktrees are validated and preserved. They are never refreshed, reset, rebased, merged, stashed, force-removed, pruned, or branch-deleted.
- Dirty in-progress work remains resumable as `READY_EXISTING_WORK` only for an already-active, valid mapping with accepted creation-baseline evidence; dirty `starting` state cannot activate.
- Readiness is not complete until the host's current Git top level is the verified linked worktree. Registration alone is insufficient.
- The existing `br`-backed `issues` skill owns lifecycle status and a reserved `kona.workspace` mapping in epic `agent_context`; the helper owns no persistent mapping. The issues workflow must call the helper before epic status transitions.
- The `issues` capability exists, but does not yet define workspace mapping or deterministic worktree gates. Its skill and contract/scenario tests must gain that integration in the same release; optional `epic-worktree` activation alone cannot satisfy the “every epic” requirement.

## 1. Meta Information

| Field       | Value                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------- |
| SPEC status | Approved                                                                                          |
| Branch      | `main`                                                                                            |
| Epic        | Epic worktree skill                                                                               |
| PRD         | [Epic Worktree Skill PRD](./prd.md), Approved                                                     |
| Scope       | Epic-only worktree lifecycle, four-host distribution, and deterministic epic-boundary enforcement |
| Runtime     | Node.js 20+ ESM, built-ins and Git CLI only                                                       |

## 2. Context

The approved PRD requires one repository-local linked worktree per implementation epic, with strict fresh-base, confirmation, preservation, cleanup, and host-entry guarantees. Host defaults cannot be treated as equivalent, so the initial implementation uses the same Git-backed mechanism on every host and treats host functionality only as directory-entry plumbing.

Kona already has a four-host skill bundle, safety-oriented lifecycle machinery, and a canonical `issues` skill backed by `br`, whose current interface provides atomic claim. The issues skill requires durable issue/epic tracking but does not yet define an epic-workspace mapping or call a deterministic worktree gate. The worktree skill/helper define and prove workspace state; the existing issues workflow must own and enforce it.

## 3. Key Technical Drivers

| Driver          | Contract                                                                                                                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Freshness       | Every creation runs a new successful fast-forward-only pull of `origin/main`, proves fetched `FETCH_HEAD` is contained in the resulting local `main`, and branches from that exact post-pull `main` commit; no cached ref, stale pre-pull state, or caller-branch fallback. |
| Preservation    | Resume is inspection-only apart from configured readiness commands; no automatic branch refresh or destructive recovery.                                                                                                                                                    |
| Identity        | Canonical Git/common-directory evidence and porcelain registration distinguish primary, linked, bare, and submodule contexts.                                                                                                                                               |
| Determinism     | Stable epic inputs derive one key, one repository-relative path, and one branch on every host.                                                                                                                                                                              |
| Explicit intent | Creation and removal use separate, state-bound confirmation tokens. Declining either performs no helper mutation.                                                                                                                                                           |
| Host truth      | Readiness requires the active host process to resolve to the expected worktree, not merely for that worktree to exist.                                                                                                                                                      |
| Enforceability  | Epic status transitions call a machine-enforced gate; optional model activation is not a control.                                                                                                                                                                           |
| Portability     | One Node.js 20+ helper invokes Git with argv arrays and `shell: false` on macOS and Linux.                                                                                                                                                                                  |
| Narrow scope    | The helper manages only epic worktrees; it is not a general task/review worktree manager.                                                                                                                                                                                   |
| Privacy/trust   | No environment-file or secret copying, telemetry, background network activity, `mise trust`, or `direnv allow`.                                                                                                                                                             |

## 4. Current State

### 4.1. Repository Evidence

| Surface              | Current evidence                                                                                                                                                                                                                                                 | Consequence                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Canonical skills     | Copy, PRD, SPEC, and issues are canonical skill payloads (`plugin/skills/copy/SKILL.md:1-15`, `plugin/skills/prd/SKILL.md:1-14`, `plugin/skills/spec/SKILL.md:1-15`, `plugin/skills/issues/SKILL.md:1-17`).                                                      | Add the worktree procedure as a sibling canonical skill and extend issues rather than inventing another tracker workflow. |
| Capability registry  | Registry order is `copy`, `prd`, `spec`, `issues`; kinds are `copywriting`, `authoring`, and `workflow`, and workflow currently means one SKILL with no adapter (`plugin/lib/capability-registry.mjs:26-67,86-99`).                                              | Add a distinct operational descriptor for worktree's helper/adapter while preserving the adapter-free issues shape.       |
| Copied-host planning | OpenCode/Codex resources are flattened from descriptors; adapter destinations are currently derived as `<name>-writer.md` (`plugin/lib/plugin-lifecycle.mjs:157-184`).                                                                                           | Preserve canonical copying but support the explicit `epic-worktree.md` operational adapter destination.                   |
| Ownership state      | Current ownership is schema 4, previous schema 3, version `0.4.2`, bundle `authoring`, with capabilities from the registry (`plugin/lib/plugin-lifecycle.mjs:22-44`).                                                                                            | Add schema 5, preserve schemas 1-4 exactly, and keep the existing bundle identity.                                        |
| Release assembly     | Release files are now derived from every registry manifest, adapter, and canonical resource (`plugin/scripts/release-lib.mjs:6-24,77-98`).                                                                                                                       | Appending the descriptor deterministically includes the new payload; validation must prove completeness.                  |
| Pi discovery         | Root metadata declares `copy`, `prd`, `spec`, `issues` in that order (`package.json:8-15`).                                                                                                                                                                      | Append `epic-worktree` without reordering the existing four capabilities.                                                 |
| `br` metadata API    | Authoritative current CLI evidence provides structured `--agent-context` on create/update, `source_repo_path`, JSON reads, and atomic `--claim`; the issues skill requires help discovery and post-mutation reads (`plugin/skills/issues/SKILL.md:40-56,77-94`). | Use only advertised commands, reserve `kona.workspace`, and acknowledge the lack of arbitrary-context CAS.                |
| Claude discovery     | The plugin discovers all of `./skills/` and retains hooks (`plugin/.claude-plugin/plugin.json:11-12`).                                                                                                                                                           | No Claude wrapper is required for skill discovery.                                                                        |
| Host verification    | Existing tests prove exact skill discovery and invocations across all four hosts (`plugin/test/host-validation.node.mjs:16-21,119-167`).                                                                                                                         | Extend the same fixture and pinned-host matrices to the worktree skill.                                                   |
| Repository ignore    | `.gitignore` contains `.claude/worktrees/`, not `.worktrees/` (`.gitignore:22-24`).                                                                                                                                                                              | Creation must remain blocked until a committed repository-level `.worktrees/` rule exists.                                |
| Quality commands     | Root scripts define test, typecheck, lint, format, plugin build/validation, and plugin tests (`package.json:22-34`).                                                                                                                                             | These commands form the repository-wide DoD and are candidate baseline evidence, not hard-coded universal setup.          |

### 4.2. Issues-Workflow Integration Gap

`plugin/skills/issues/SKILL.md` is the canonical portable issues workflow, `plugin/capabilities/issues.json:1-31` publishes version `0.4.2` with `plan`/`execute` modes, and the registry deliberately gives it no OpenCode adapter (`plugin/lib/capability-registry.mjs:52-67,86-92`). It already requires command discovery, machine-readable output, claiming before implementation, and read-after-mutation (`plugin/skills/issues/SKILL.md:40-56,77-94`); current validated `br` help confirms that `--claim` is atomic.

The gap is narrower but still release-critical: the current issues skill has no `kona.workspace` schema and no mandatory propose/start/check/finish gates at epic boundaries. The selected design extends that existing skill plus `plugin/test/issues-contract.test.ts` and `plugin/test/issues-workflow.test.ts`; merely publishing `epic-worktree` still does not satisfy PRD FR1 or FR18.

## 5. Considered Options

| Option                                                         | Advantages                                                                            | Costs and risks                                                                                | Decision                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------- |
| Prose-only skill issuing ad hoc shell                          | Small payload                                                                         | Quoting, path, race, and rollback behavior varies by model/host; not mechanically enforceable  | Reject                     |
| Host-native worktrees per host                                 | Familiar host UX                                                                      | Default roots, detached state, base freshness, and ownership differ; cannot prove one contract | Reject for initial release |
| Generic Kona worktree manager                                  | Reusable for tasks/reviews                                                            | Expands scope and destructive lifecycle surface beyond the PRD                                 | Reject                     |
| Canonical skill plus epic-only Node/Git helper and issues gate | One safety implementation, deterministic JSON contract, portable fixtures, thin hosts | Requires bundle migration and extension of the existing issues workflow                        | **Selected**               |

The selected option uses Git as the authority for repository/worktree identity and the epic record as the authority for lifecycle intent. Host-native worktree creation is deliberately disabled in the initial release. A future host optimization is acceptable only if it passes the same helper verification and does not change path, branch, base, or confirmation semantics.

## 6. Selected Design

### 6.1. Components

| Proposed component                                      | Responsibility                                                                                                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin/skills/epic-worktree/SKILL.md`                  | Canonical user/agent procedure, confirmation prompts, host transition, setup/baseline evidence selection, and failure guidance.                             |
| `plugin/skills/epic-worktree/scripts/epic-worktree.mjs` | Private Node.js 20+ safety kernel for discovery, naming, tokens, locking, Git inspection/mutation, command execution, and JSON results.                     |
| `plugin/capabilities/epic-worktree.json`                | Operational modes, canonical file hashes/modes, hosts/scopes, and exact invocation names.                                                                   |
| `plugin/hosts/opencode/agents/epic-worktree.md`         | Thin `@epic-worktree` operational adapter; loads only the canonical skill, asks confirmations, and invokes only its helper.                                 |
| `.opencode/agents/epic-worktree.md`                     | Byte-identical contributor-local copy of the distributed OpenCode adapter.                                                                                  |
| `plugin/lib/capability-registry.mjs`                    | Ordered `copy`, `prd`, `spec`, `issues`, `epic-worktree` descriptors; preserve adapter-free workflow validation and add operational validation/destination. |
| Existing lifecycle/build/validation surfaces            | Copy, own, discover, package, hash, migrate, and test the complete five-capability bundle.                                                                  |
| `plugin/skills/issues/SKILL.md`                         | Existing `br` workflow extended to own `agent_context.kona.workspace`, coordinate claims, invoke the helper, and enforce epic boundaries.                   |
| `plugin/test/issues-{contract,workflow}.test.ts`        | Contract and scenario coverage for mapping preservation, claim serialization, gate ordering, conflicts, resume, and finish.                                 |

The helper remains a skill resource, not a new public `kona` lifecycle verb or general-purpose executable. The skill invokes it with an absolute path resolved from its own installed directory.

### 6.2. Deterministic Identity and Paths

Inputs are the immutable epic identifier and an immutable `slugSeed` captured from the epic title when the epic record is created. Capturing the seed does not create a branch, directory, or worktree.

1. Normalize each value with Unicode NFKD, remove combining marks, lowercase, replace every run outside `[a-z0-9]` with `-`, trim `-`, and truncate the identifier component to 32 bytes and slug to 48 bytes without splitting UTF-8 (the output is ASCII).
2. Reject an identifier whose normalized component is empty; use `epic` when only the slug is empty.
3. Let `suffix` be the first 10 lowercase hex characters of SHA-256 over the exact UTF-8 epic identifier.
4. Define `epicKey = <id-component>-<slug>-<suffix>` and `branch = epic/<epicKey>`.
5. Define `relativePath = .worktrees/<epicKey>` and derive the absolute path only from the canonical repository root.

The durable mapping freezes `epicKey`, `relativePath`, and `branch`; later title edits do not rename them. A supplied mapping that disagrees with recomputed immutable inputs is a conflict, not an adoption or rename opportunity.

Path checks reject NUL/newline input, `.`/`..` components, absolute user-supplied paths, case-folded collision with another mapped epic, symlinked `.worktrees`, symlinked destination components, a destination outside the canonical repository root, and any existing unregistered destination. The helper never accepts an arbitrary worktree root.

### 6.3. Private Command Interface

The portable interface is:

```text
node <skill-root>/scripts/epic-worktree.mjs <propose|start|check|finish> --json
```

One schema-versioned JSON request is read from stdin; no epic data or token is interpolated into a shell command.

```json
{
  "schemaVersion": 1,
  "epic": { "id": "E-42", "slugSeed": "Import settlement reports" },
  "mapping": null,
  "knownMappings": [],
  "confirmationToken": null,
  "baselineExceptionToken": null,
  "readiness": {
    "setup": [{ "argv": ["bun", "install"], "source": "README.md:20" }],
    "baseline": [{ "argv": ["bun", "test"], "source": "package.json:27" }]
  }
}
```

`mapping` is the issues workflow's extracted `agent_context.kona.workspace` and is required for resume and finish. `knownMappings` is built from advertised `br` JSON queries over epics whose canonical `source_repo_path` identifies this repository; `propose`/`start` use it to reject cross-epic key, path, and branch collisions, and its digest is confirmation-bound. `baselineExceptionToken` is optional and valid only on the second `check` request described below; it is distinct from start/finish `confirmationToken`. Readiness commands are optional argv arrays selected from repository instructions or detected project configuration and must include their evidence source. They run with `shell: false` in the verified worktree. Empty setup means `not-required`; empty baseline means `not-configured` and blocks readiness until the user explicitly accepts that condition. The helper never invents a package-manager command and never executes trust commands.

| Command   | Contract                                                                                                                                                                                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `propose` | Read-only discovery. Return deterministic path/branch, base policy `origin/main via fresh pull`, current repository snapshot, blockers, and a start token. Never fetch, pull, lock, create, or update epic state.                                                            |
| `start`   | With a valid start token, serialize, revalidate, freshly pull primary `main`, create and verify the branch/worktree, run creation readiness, and return a mapping plus `transition-required`. With an existing mapping, perform `check` semantics and never pull.            |
| `check`   | Validate mapped repository/path/branch/base and current host location. Never fetch, pull, reset, or rewrite. For a dirty active mapping with valid creation-baseline evidence, skip all commands and return `READY_EXISTING_WORK`; dirty `starting` mappings remain blocked. |
| `finish`  | Without a token, perform read-only cleanup preflight and return a removal token when safe. With that token, revalidate under lock and run non-forced `git worktree remove`; retain the branch and mapping history.                                                           |

An explicit baseline exception is a second `check` request carrying the failure token returned by the prior check. It binds the exact commands, exits, current commit, and status digest; it cannot waive identity, path, branch, or dirty-state failures. The epic record retains the original failure and exception evidence.

### 6.4. Result and Exit Contract

Every invocation writes one JSON object to stdout in `--json` mode:

```json
{
  "schemaVersion": 1,
  "command": "check",
  "ok": false,
  "code": "HOST_TRANSITION_REQUIRED",
  "mutation": "none",
  "epic": { "id": "E-42", "key": "e-42-import-settlement-reports-0123456789" },
  "repository": {
    "root": "/repo",
    "commonDir": "/repo/.git",
    "primaryWorktree": "/repo"
  },
  "workspace": {
    "path": "/repo/.worktrees/e-42-import-settlement-reports-0123456789",
    "branch": "epic/e-42-import-settlement-reports-0123456789",
    "baseSource": "post-pull refs/heads/main containing FETCH_HEAD",
    "baseCommit": "<40-or-64-hex-object-id>",
    "currentCommit": "<object-id>",
    "status": "clean|dirty|absent|unknown"
  },
  "checks": [{ "name": "linked-worktree", "status": "pass|fail|skip", "detail": "..." }],
  "setup": { "status": "pass|fail|not-required|not-run", "commands": [] },
  "baseline": { "status": "pass|fail|not-configured|not-run-existing-changes", "commands": [] },
  "confirmation": { "required": false, "action": null, "token": null },
  "hostTransition": { "required": true, "path": "/repo/.worktrees/..." }
}
```

Command records contain argv, source citation, exit code, duration, and SHA-256 digests of bounded stdout/stderr; raw output is shown to the active user but is not stored in the epic mapping. Object IDs are validated using `git rev-parse --verify` and are not hard-coded to SHA-1 length.

| Exit | Meaning                                                                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Requested inspection/mutation completed; inspect `code` for `PROPOSAL`, `READY`, `READY_EXISTING_WORK`, `PREFLIGHT_SAFE`, `REMOVED`, or accepted baseline exception. |
| `2`  | Invalid request/schema/arguments.                                                                                                                                    |
| `3`  | Confirmation absent or stale.                                                                                                                                        |
| `4`  | Identity, path, ignore, mapping, or safety failure.                                                                                                                  |
| `5`  | Path/branch/worktree/epic collision.                                                                                                                                 |
| `6`  | Git pull/add/remove failure or partial Git mutation.                                                                                                                 |
| `7`  | Setup or baseline blocked readiness.                                                                                                                                 |
| `8`  | Host transition required or unverifiable.                                                                                                                            |
| `9`  | Repository lock unavailable.                                                                                                                                         |

Failure results use stable uppercase `code` values and never report readiness from a partial snapshot.

`READY` means the current host is in a valid clean linked worktree and the current baseline passed or was explicitly waived; it may authorize `starting → active`. `READY_EXISTING_WORK` means the same identity checks passed for an already-`active` mapping, existing tracked or untracked work was detected, prior creation baseline evidence is acceptable, and setup/baseline were intentionally skipped. It is a successful resume result, never an activation result.

### 6.5. Repository and Worktree Identity

All Git calls use argv arrays, `shell: false`, an explicit `cwd`, and `--` before path operands where supported. The helper:

1. Resolves `git rev-parse --show-toplevel`, `--absolute-git-dir`, `--git-common-dir`, and `--show-superproject-working-tree`; existing paths are canonicalized with `realpath`.
2. Rejects bare repositories and any non-empty superproject result as a submodule context.
3. Parses `git worktree list --porcelain -z`; unknown fields are retained for diagnostics, while malformed/duplicate fields fail closed.
4. Treats the first non-bare porcelain record as the primary worktree and verifies its common directory. It does not infer the primary checkout from a directory name.
5. Classifies `gitDir === commonDir` as primary and `gitDir !== commonDir` as potentially linked; linked status passes only when the canonical top level has one exact porcelain record for the expected path/branch and the same common directory.
6. Rejects detached HEAD, locked/prunable entries, missing registered paths, branch reuse, path reuse, submodule context, and execution from another linked worktree.

The current host is “inside” the expected worktree only when its `--show-toplevel` canonicalizes to the expected path. A child process cannot change its parent host's directory, so `start` always returns `transition-required` after creation. The host enters or relaunches in that path and reruns `check`; a `starting` mapping can become active only from that host-local check returning `READY`.

### 6.6. Ignore and Main-Branch Preconditions

Before every creation, the helper runs the equivalent of `git check-ignore -v --no-index -- .worktrees/` from the primary root. Success is accepted only when the matching source is the tracked root `.gitignore`; global excludes and `.git/info/exclude` are rejected. The trailing-slash directory operand is tested before `.worktrees/` exists. A clean primary checkout ensures the tested rule matches committed bytes.

Creation additionally requires:

- a non-bare repository with remote `origin` and local `refs/heads/main`; the required pull itself must successfully fetch the remote's `main` into `FETCH_HEAD`, and no remote-tracking-ref update is assumed;
- the canonical primary worktree checked out on `refs/heads/main` and otherwise clean, including untracked files;
- no merge, rebase, cherry-pick, revert, or bisect state in progress;
- no existing mapping conflict, branch, destination, or conflicting porcelain record;
- invocation from the primary worktree or outside every linked worktree, never from another linked worktree.

These conservative rules mean a primary checkout currently on another branch blocks creation; the caller may be on another branch only in a separate session/worktree while the primary checkout remains clean on `main`.

### 6.7. Creation Ordering and Failure Boundaries

After a valid confirmation token, `start` performs this indivisible decision sequence under the repository lock:

1. Recompute the proposal and reject a stale token before any Git mutation.
2. Revalidate canonical paths, issue mapping absence, ignore provenance, primary cleanliness/state, and all porcelain collisions.
3. Run exactly `git -C <primary> pull --ff-only origin main`. No fetch-only path or local-ref fallback exists.
4. Resolve primary `HEAD`, `refs/heads/main`, and `FETCH_HEAD` immediately after that pull; require `HEAD === refs/heads/main` and require `FETCH_HEAD` to be an ancestor of that post-pull commit. Save the post-pull `refs/heads/main` object ID as `baseCommit`. This permits intentional local commits already on `main` while proving the fetched remote main is included. Do not require or substitute `refs/remotes/origin/main`, because an explicit pull refspec need not update it under every valid Git configuration.
5. Re-list worktrees and refs to close the helper-controlled race window.
6. Run `git -C <primary> worktree add -b <branch> <absolute-path> <baseCommit>` without `--force`, `-B`, or an existing branch.
7. Verify exact registration, linked identity, branch, common directory, and `HEAD === baseCommit`.
8. Run declared setup and baseline commands, then verify identity, branch, `HEAD`, and status again; any command-caused `HEAD` change or source change blocks readiness.
9. Return the mapping and require host transition/check. Do not report creation ready.

The fresh pull is a committed boundary: it is never rolled back. A failed add is inspected and reported as `PARTIAL_CREATION` if either branch, path, or registration appeared; the helper never deletes the branch or force-cleans a path as compensation. Setup/baseline failure leaves the verified worktree and branch intact. The issues workflow records recoverable observed state as `starting`; implementation remains blocked.

The exact lock path is `<canonical-common-dir>/kona/epic-worktree.lock/`, intentionally separate from Git's own `<common-dir>/worktrees/` metadata. The helper creates `<common-dir>/kona/` with mode `0700` when absent; if present, every path component must be a canonical real directory owned by the current user and not group/world writable. The final lock directory is acquired atomically and contains `owner.json` with operation, PID, host, start time, and random owner token. It covers proposal revalidation through final verification for `start` and confirmed `finish`. Only the matching owner token may remove it in `finally`; an abandoned lock is never auto-broken, and the error reports manual inspection guidance. External Git processes remain outside this lock, so every mutation is surrounded by fresh Git revalidation.

### 6.8. `br` Epic State and Enforcement

The helper writes no mapping file. The existing issues workflow persists workspace state in the epic's structured `agent_context` under the reserved object `kona.workspace`. All sibling top-level keys, all other `kona` keys, and their JSON values remain semantically unchanged. JSON whitespace/key order may be normalized by `br`; no code reads or edits tracker storage directly.

Before implementation starts, `agent_context.kona.epicSlugSeed` stores the immutable slug seed and `agent_context.kona.workspace` is absent. That absence is the sole `not-started` representation:

```json
{
  "ownerNote": "preserved unrelated value",
  "kona": {
    "epicSlugSeed": "Import settlement reports"
  }
}
```

After confirmed creation begins, the issues workflow adds only `kona.workspace`:

```json
{
  "ownerNote": "preserved unrelated value",
  "kona": {
    "epicSlugSeed": "Import settlement reports",
    "workspace": {
      "schemaVersion": 1,
      "state": "active",
      "epicKey": "e-42-import-settlement-reports-0123456789",
      "relativePath": ".worktrees/e-42-import-settlement-reports-0123456789",
      "branch": "epic/e-42-import-settlement-reports-0123456789",
      "baseCommit": "<object-id>",
      "creationReadiness": {
        "setup": "pass",
        "baseline": "pass",
        "baselineResultDigest": "<sha256>",
        "baselineException": null
      },
      "lastCheck": { "code": "READY", "commit": "<object-id>", "statusDigest": "<sha256>" }
    }
  }
}
```

Absolute worktree paths are reported but not persisted because clones move. On epic create/update, the issues workflow sets `source_repo_path` through the advertised `br` interface to the canonical primary repository root; on start/resume/finish it canonicalizes that field and requires it to identify the same common Git directory as the helper. `source_repo_path` locates the source repository only: it is not the worktree mapping authority and cannot substitute for `kona.workspace.relativePath`, branch, or base commit.

The issues skill must inspect advertised `br` root/create/show/update help before use, request JSON output, and use the supported `--agent-context` JSON field on create/update. It parses the complete current `agent_context`, deep-copies it, modifies only `kona.epicSlugSeed` or `kona.workspace`, writes the complete merged object through `br`, and re-reads the epic to prove the intended value and semantic preservation of every unrelated key. Malformed/non-object `agent_context`, reserved-key type conflicts, unsupported flags, or read-after-write mismatch fail closed.

Current `br` does not provide an established atomic compare-and-set for arbitrary `agent_context`; this design does not invent one. Start serialization is:

1. Read the epic and context through advertised JSON, verify type/parent/status, and hash canonicalized `agent_context` plus relevant epic identity.
2. Run the advertised atomic `br update <epic-id> --claim` before any start mutation. Claim refusal means another actor owns the start; stop without invoking the helper.
3. Re-read the epic, verify the claim result, and capture a new context digest.
4. Run the helper under its independent repository Git lock.
5. Immediately before each `--agent-context` write, re-read and require the claimed epic and expected context digest; on mismatch, do not write.
6. Write the merged complete context, re-read, and require exact expected `kona.workspace` plus semantic equality of unrelated context. On post-write mismatch, fail closed and retain evidence; do not attempt a blind rollback.

The atomic claim serializes cooperating start flows; the helper lock serializes Git mutations. The read/write/read protocol detects but cannot eliminate a race from an external writer that ignores the claim because `br` offers no arbitrary-context CAS. This limitation is explicit and covered by conflict tests. Resume and finish require the existing claim holder or a newly successful atomic claim according to advertised `br` behavior; they never steal a claim based on age.

Once present, `kona.workspace.state` is exactly one of `starting`, `active`, `cleanup-pending`, or `finished`. It is never set to `not-started`; missing `kona.workspace` represents that state and prevents a nullable or partially populated mapping from becoming a second encoding.

Required transitions are:

| Trigger                     | Gate and transition                                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Create/plan epic            | Preserve existing context, store immutable `kona.epicSlugSeed`, leave `kona.workspace` absent, and do not invoke `start`; absence means `not-started`.                                                                               |
| Claim/start with no mapping | Call `propose`, display path/branch/base policy, and ask. Decline performs no claim/helper/context mutation. After confirmation, atomically claim through `br`; confirmed `start` records successful/partial mapping as `starting`.  |
| Host entry                  | Enter/relaunch at the reported path and call `check`. Under the verified claim, write `starting → active` through the read/write/read protocol only for `READY`; an approved baseline exception is validated before `READY`.         |
| Resume                      | Load the mapping, enter its expected path, and call `check`. A clean valid workspace returns `READY`; a dirty valid `active` workspace with accepted creation-baseline evidence returns `READY_EXISTING_WORK`. Never create or pull. |
| Finish                      | Call unconfirmed `finish`, set `cleanup-pending` if unsafe or declined, then pass the separately confirmed token. Under the verified claim, write `finished` only after `REMOVED`; retain historical mapping and branch name.        |

Every implementation dispatch path in `plugin/skills/issues/SKILL.md` must require `kona.workspace.state === active` and a current host-bound result of `READY` or `READY_EXISTING_WORK`. `READY_EXISTING_WORK` is valid only for an already-active mapping and can never perform `starting → active`. The gate belongs before source-edit authority is granted, not inside an optionally selected prompt.

### 6.9. Resume, Readiness, and Preservation

`check` requires the mapping and verifies exact repository identity, path, branch, registration, branch exclusivity, `baseCommit` existence/ancestry, current commit, and current host top level. It reports ahead/behind relationships using existing refs only and performs no network operation.

If tracked or untracked changes already exist, `check` records porcelain status and skips setup and baseline so it cannot alter in-progress bytes. It returns successful code `READY_EXISTING_WORK` only when all identity/path/branch/registration checks pass, `workspace.state` is already `active`, and `creationReadiness.baseline` is `pass` or has a stored explicit exception. The prior baseline record remains unchanged. A dirty `starting` mapping returns `DIRTY_STARTING_WORKTREE` and cannot become active; the user must preserve or resolve the unexpected changes explicitly. If the worktree is clean, configured baseline commands run and identity/status are checked again. Any command-created source or `HEAD` change blocks readiness and remains untouched.

Creation setup may install dependencies but must not copy ignored files from another worktree. The skill may select commands only from cited repository guidance or project configuration. It must never run `direnv allow`, `mise trust`, or an equivalent trust mutation automatically; the user must inspect the relevant configuration and approve trust separately.

### 6.10. Finish and Cleanup Behavior

Finish preflight verifies the exact mapped linked worktree and reports:

- tracked modifications and untracked files;
- whether `HEAD` equals the mapped local branch tip;
- whether the branch tip is contained in the currently available `origin/main`;
- configured-upstream presence and whether the tip is contained in it;
- locked/prunable/submodule conditions and branch/path registration.

Dirty state, detached/unreferenced commits, branch-tip mismatch, identity ambiguity, lock/prunable state, or a changed preflight token is unsafe. A clean commit referenced by the retained expected local branch is preserved even when currently unpushed or unmerged; those conditions remain visible warnings and require confirmation.

Confirmed cleanup runs only `git worktree remove <path>` without force. Success requires the porcelain record and directory to be absent and the expected branch/ref to remain at its prior object ID. Failure, partial removal, unsafe state, or decline leaves the epic `cleanup-pending`. The helper never deletes a branch, prunes, cleans, pushes, merges, rebases, or repairs worktree metadata.

### 6.11. Confirmation Tokens

Start and finish tokens are lowercase SHA-256 over canonical JSON containing action, schema, canonical common-directory identity, epic ID/key, canonical `source_repo_path`, epic `agent_context` digest, known-mappings digest, path, branch, relevant worktree-list/ref/status digest, and base policy or removal preflight. Tokens are intent binders, not authentication secrets.

The host must display the human-readable proposal and receive an explicit yes before passing the exact token. A changed repository snapshot yields `CONFIRMATION_STALE` and requires a new proposal; a start token cannot authorize finish. Decline is represented by not invoking the mutating form, so start decline creates nothing and finish decline preserves everything.

### 6.12. Host and Distribution Contracts

| Host        | Exact invocation       | Contract                                                                                                                                                                                                          |
| ----------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode    | `@epic-worktree`       | Install the canonical skill/helper plus the thin operational adapter. Use Git fallback; after creation use the documented working-directory mechanism (including CLI `--dir` where applicable), then run `check`. |
| Codex       | `$epic-worktree`       | Discover the canonical skill from `.agents/skills`. Do not use managed detached/default-root worktrees; launch or reopen Codex in the reported path and run `check`.                                              |
| Claude Code | `/kona:epic-worktree`  | Discover the canonical skill from the Kona plugin. Do not use default `.claude/worktrees`; any `EnterWorktree`/hook integration is directory-entry plumbing only and must end in helper verification.             |
| Pi          | `/skill:epic-worktree` | Discover the canonical skill through package metadata. Use Git fallback, restart/open Pi in the reported path, and run `check`.                                                                                   |

The capability manifest and registry record those four strings exactly. The OpenCode adapter filename is `epic-worktree.md`, which defines `@epic-worktree`; its body only directs the agent to load `skill({name: "epic-worktree"})`, follow the canonical procedure, ask the required confirmations, and invoke the adjacent helper. Its exact permission shape is:

```yaml
mode: subagent
permission:
  edit: deny
  webfetch: deny
  skill:
    "*": deny
    epic-worktree: allow
  question: allow
  bash:
    "*": deny
    "node */skills/epic-worktree/scripts/epic-worktree.mjs *": allow
```

The adapter contains no Git procedure or direct Git permission; all Git access is encapsulated by the allowed helper. Pinned-host validation must reject an adapter or permission parser that does not enforce this deny-by-default shape.

The registry order becomes exactly `copy`, `prd`, `spec`, `issues`, `epic-worktree`. Existing `workflowCapability("issues")` remains adapter-free with one canonical `SKILL.md`. A new `operational` descriptor kind requires exactly the worktree SKILL, adjacent helper, explicit OpenCode adapter, and adapter destination `agents/epic-worktree.md`; validation must not relax the existing authoring, copywriting, or workflow shapes.

Bundle state advances from schema 4 to schema 5 while retaining `BUNDLE = "authoring"` for compatibility. Schema 5 records the ordered five-capability set. Schemas 1, 2, 3, and 4 retain their existing identities, supported versions, capability allowlists, verification, disable/enable, removal, and rollback behavior; they are never reinterpreted as schema 5. Only explicit `update` migrates a valid schema-4 installation, including currently supported `0.4.1` or `0.4.2` state, transactionally to schema 5. Unknown schemas fail closed. Existing lifecycle locking, ownership, backup, rollback, one-active-scope, and native-package approval contracts remain unchanged.

OpenCode/Codex receive byte-identical canonical skill/helper files through the registry resource plan; OpenCode additionally receives the distributed adapter and its byte-identical `.opencode/agents/` copy. Claude discovers the added skill through `./skills/`. Pi preserves `./plugin/skills/copy`, `./plugin/skills/prd`, `./plugin/skills/spec`, and `./plugin/skills/issues` in that order, then appends `./plugin/skills/epic-worktree`. Release assembly, capability hashes, installed verification, documentation, and adapter-payload tests cover all five capabilities and the worktree skill's four exact invocation names. No full procedure is duplicated in a host adapter.

## 7. Operational Result and Failure Behavior

| Condition                                                                        | Required result                                                                                                                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| User declines creation                                                           | No mutating helper call, no lock, pull, branch, directory, worktree, mapping, or status transition.                                        |
| Ignore is absent/non-repository-local                                            | Block before pull or creation and identify the root `.gitignore` requirement.                                                              |
| Primary `main` dirty, unavailable, not checked out, diverged, or pull/auth fails | Block creation; preserve state; do not stash/reset/merge/rebase/force. A pull-updated remote-tracking ref is not rolled back.              |
| Path/branch/epic collision or stale confirmation                                 | Block without adoption or overwrite and report the owning path/epic when known.                                                            |
| Add partially fails                                                              | Preserve all artifacts, return `PARTIAL_CREATION`, and keep implementation blocked for explicit recovery.                                  |
| Setup/baseline fails                                                             | Keep worktree, distinguish readiness failure from identity, and require a bound explicit baseline exception if work is to proceed.         |
| Active mapped worktree has existing changes                                      | Preserve bytes, skip setup/baseline, and return `READY_EXISTING_WORK` only with valid identity and accepted creation-baseline evidence.    |
| Starting mapped worktree is dirty                                                | Preserve bytes, return `DIRTY_STARTING_WORKTREE`, and forbid activation; dirty state cannot bootstrap its own readiness evidence.          |
| Host cannot enter verified path                                                  | Keep mapping `starting` and block implementation.                                                                                          |
| Finish unsafe, declined, or remove fails                                         | Preserve worktree/branch and set `cleanup-pending`; never force or prune.                                                                  |
| Lock exists                                                                      | Block with owner metadata; never guess that a lock is stale.                                                                               |
| Issues skill lacks workspace extension                                           | Manual worktree use may continue, but the release cannot claim the every-epic guarantee until the issues skill and its tests enforce §6.8. |
| `br` context changes before write                                                | Do not write or invoke the next transition; re-read, report `ISSUE_CONTEXT_CONFLICT`, and preserve Git/worktree state.                     |
| `br` read-after-write differs                                                    | Fail closed, retain observed before/expected/after digests, and do not attempt a blind context rollback.                                   |

## 8. Testing Strategy

Implementation follows RED-GREEN-REFACTOR. Tests use temporary repositories, homes, file-protocol remotes, and fake host CLIs; they never mutate the developer checkout, host configuration, or network remotes.

### 8.1. Test Layers

| Layer             | Required coverage                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure unit         | Epic normalization/hash vectors, byte truncation, canonical JSON/tokens, result/request schemas, porcelain `-z` parser including unknown/locked/prunable records, status parser, path containment, invocation names, and state/result transitions.                                                                                                   |
| Git integration   | Real primary/linked/submodule/bare fixtures; canonical Git/common dirs; directory-form ignore provenance; clean/dirty/diverged/missing main; post-pull `HEAD == refs/heads/main` containing `FETCH_HEAD`, including equal, local-ahead, and remote-ahead cases with an absent/stale remote-tracking ref; caller branch; collisions; safe add/remove. |
| Failure injection | Pull/add/setup/baseline/remove interruption, partial artifacts, stale tokens, exact `<common-dir>/kona/epic-worktree.lock/` contention/abandonment, unsafe lock-path links/modes, path case collisions, malformed Git output, and revalidation races.                                                                                                |
| Preservation      | Byte snapshots prove dirty active resume returns `READY_EXISTING_WORK` without commands or byte changes; dirty `starting`, declined start/finish, baseline failure, unsafe cleanup, and failed removal preserve content. Static tests reject destructive/privacy paths.                                                                              |
| Issues contract   | Extend `issues-contract.test.ts` for reserved `kona.workspace`, advertised `--agent-context`/`--claim` use, required `source_repo_path` validation but non-authority, unrelated-context preservation, helper gates, and no direct tracker storage access.                                                                                            |
| Issues scenarios  | Extend `issues-workflow.test.ts` with a fake `br`: absent-workspace `not-started`, canonical/wrong `source_repo_path`, decline-before-claim, atomic-claim conflict, read/write/read races, unrelated keys, `starting → active` only after `READY`, dirty resume, and cleanup.                                                                        |
| Distribution      | Manifest hashes/modes, exact `copy`/`prd`/`spec`/`issues`/`epic-worktree` order, four worktree invocation names, OpenCode adapter parity, schema-1-through-4 preservation/schema-5 migration, Pi roots, Claude discovery, and lifecycle preservation.                                                                                                |
| Host parity       | Equivalent fixtures on pinned OpenCode, Codex, Claude Code, and Pi prove path, branch, pull/base, confirmations, transition, and readiness outcomes without model judgment.                                                                                                                                                                          |

### 8.2. PRD Acceptance Traceability

| PRD AC    | Verification                                                                                                                                                                                                                                    |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1-AC2   | Real-origin fixtures assert the exact fresh pull command, post-pull `HEAD == refs/heads/main == baseCommit`, `FETCH_HEAD` ancestry for equal/local-ahead/remote-ahead cases, no remote-tracking-ref dependency, and caller-branch independence. |
| AC3       | Missing-ignore fixture blocks before creation.                                                                                                                                                                                                  |
| AC4-AC7   | Naming, single registration, idempotence, primary/submodule rejection, branch exclusivity, and collision fixtures.                                                                                                                              |
| AC8       | Dirty/diverged/unavailable main and pull/auth failures stop without prohibited recovery.                                                                                                                                                        |
| AC9       | Dirty active resume preserves bytes, performs no refresh/setup/baseline, and returns `READY_EXISTING_WORK`; dirty `starting` cannot activate.                                                                                                   |
| AC10-AC11 | Separate identity/setup/baseline results, baseline-exception binding, and complete readiness reports.                                                                                                                                           |
| AC12      | Saving a created/planned epic preserves unrelated `agent_context`, stores only `kona.epicSlugSeed`, and creates no `kona.workspace` or Git artifacts.                                                                                           |
| AC13-AC14 | Start proposal/token tests show path/branch/base before mutation and prove decline/staleness performs no `br --claim`, context update, or Git mutation.                                                                                         |
| AC15-AC17 | Finish preflight/token tests prove required separate confirmation, cleanup-pending behavior, non-forced worktree-only removal, and retained branch.                                                                                             |
| AC18-AC19 | Four-host fixtures prove exact invocations and equivalent behavior; negative fixtures reject host-default paths/detached state.                                                                                                                 |
| AC20      | The extended issues workflow claims through `br`, persists verified `kona.workspace`, and cannot transition to active without host-local `READY`; dirty dispatch is limited to an already-active mapping.                                       |
| AC21-AC22 | Wrong-worktree/no-nesting and created-but-not-entered tests return transition-required.                                                                                                                                                         |
| AC23      | Ignore tests use `.worktrees/` before it exists, accept only tracked root `.gitignore`, and reject global/info-exclude coverage.                                                                                                                |
| AC24      | Canary fixtures prove no ignored-file copy and no automatic environment trust.                                                                                                                                                                  |

## 9. Definition of Done

### Universal

- [ ] `bun run test` passes.
- [ ] `bun run typecheck` passes.
- [ ] `bun run lint` passes.
- [ ] `bun run format:check` passes.
- [ ] `bun run plugin:build`, `bun run plugin:validate`, and `bun run test:plugin` pass.
- [ ] This SPEC reflects the implementation and contains no unsupported completed-state claim.

### Feature-Specific

- [ ] Canonical skill, Node helper, and capability manifest are versioned, hash-validated, zero-runtime-dependency, and distributed identically to all four hosts.
- [ ] `.worktrees/` is committed as a repository-level directory ignore; tests reject global or local-exclude substitutes.
- [ ] Every creation fixture proves the exact fresh `git pull --ff-only origin main`, `HEAD == refs/heads/main == baseCommit`, and `FETCH_HEAD` ancestry, including equal, local-ahead, remote-ahead, and absent/stale `refs/remotes/origin/main` configurations; no pre-pull or caller-branch fallback exists.
- [ ] Identity fixtures distinguish primary, linked, bare, submodule, wrong-repository, missing, locked, prunable, symlinked, and nested-worktree states.
- [ ] Confirmation tokens bind start and finish independently; decline/staleness tests prove the required no-mutation behavior.
- [ ] Dirty active resume returns `READY_EXISTING_WORK` without running setup/baseline or changing bytes; dirty `starting` state cannot activate.
- [ ] Resume and cleanup failure tests preserve existing bytes and branches; no automatic refresh, force, prune, or branch deletion occurs.
- [ ] Host transition is mandatory and verified from the active host top level before epic implementation becomes active.
- [ ] The existing issues skill and its contract/scenario tests own `agent_context.kona.workspace` and deterministically gate every create/claim/start/resume/finish path in the same release.
- [ ] Fake-`br` tests prove advertised-help discovery, atomic claim serialization, complete-context merge, unrelated-key semantic preservation, pre-write conflict refusal, read-after-write verification, and fail-closed post-write mismatch without claiming unavailable CAS.
- [ ] `source_repo_path` is used only for repository location/validation and never as the epic worktree mapping authority.
- [ ] Schema-1-through-4 lifecycle fixtures retain their exact existing contracts, and explicit update migrates every currently valid schema-4 version to schema 5 with exact rollback on failure.
- [ ] Registry, release, installed payload, and Pi tests preserve `copy`, `prd`, `spec`, `issues` order, keep issues adapter-free, append operational `epic-worktree`, and retain bundle identity `authoring`.
- [ ] Pinned-host release validation proves `@epic-worktree`, `$epic-worktree`, `/kona:epic-worktree`, and `/skill:epic-worktree`, including thin OpenCode adapter permissions/parity, with no release-mode skips.
- [ ] Static/privacy tests prove no environment/secret copying, trust automation, telemetry, background network activity, or generic task/review worktree behavior.

## 10. Alternatives Not Chosen

| Alternative                                                        | Why rejected                                                                                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `.claude/worktrees`, `$CODEX_HOME/worktrees`, or sibling worktrees | Violates the repository-local path contract and cross-host determinism.                                                       |
| Detached worktree followed by branch attachment                    | Introduces an unnecessary intermediate state and does not prove exact branch creation from pulled `main`.                     |
| Fetch plus `update-ref main` while primary is elsewhere            | Does not satisfy the approved fresh `git pull --ff-only` rule and bypasses primary-worktree safety.                           |
| Automatic stale-lock breaking                                      | PID/time heuristics cannot prove another operation is dead.                                                                   |
| Automatic rollback by deleting a partially created branch          | Branch deletion is out of scope and could destroy concurrent or recovered work.                                               |
| Persist helper-owned sidecar state under `.git` or `.worktrees`    | Creates competing authorities; the epic workflow already must own durable lifecycle state.                                    |
| Store absolute path in the epic                                    | Breaks clone portability; persist the deterministic repository-relative path and report the resolved absolute path.           |
| Treat a clean local branch as unsafe solely because it is unpushed | The retained branch preserves committed work; report unpushed/unmerged state and still require explicit removal confirmation. |

## 11. Risks and Open Questions

| Item                                                      | Status                              | Treatment                                                                                                                                        |
| --------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Existing issues workflow lacks workspace mapping/gates    | **Required same-release extension** | Extend `plugin/skills/issues/SKILL.md` and both issues test suites with §6.8; the capability already exists and remains the sole issue workflow. |
| `br` lacks arbitrary `agent_context` CAS                  | **Confirmed limitation**            | Use atomic claim plus helper lock and read-before/write/read-after verification; fail closed on mismatch and never claim full race elimination.  |
| Primary checkout not on `main`                            | **Approved conservative behavior**  | Block rather than temporarily switch branches or update refs outside a checked-out `main`; document recovery.                                    |
| Partial `git worktree add` artifacts                      | **Accepted risk**                   | Preserve and report exact observed state; no automatic branch deletion or force cleanup.                                                         |
| Setup/baseline commands may have project-specific effects | **Accepted with guardrails**        | Require cited argv, shell-free execution, clean-state checks, bounded output digests, and explicit baseline exceptions.                          |
| Host process cannot always change directory in place      | **Confirmed constraint**            | Treat relaunch/re-entry plus a new `check` as part of readiness; never infer success from registration.                                          |

No product-scope question is blocking. The required issues-skill extension must ship with this capability; the current absence of workspace mapping and gates is not permission to weaken the every-epic guarantee.

## 12. References

| Reference                                                                   | Relevance                                                                                                                                   |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [Approved PRD](./prd.md)                                                    | Authoritative scope, safety invariants, host requirements, and AC1-AC24.                                                                    |
| `plugin/skills/spec/SKILL.md:8-15,35-59,95-133`                             | Canonical-skill, evidence, write-boundary, testing, and validation conventions used for this SPEC.                                          |
| `specs/portable-spec-agent-plugin/spec.md:43-76,109-188,196-249`            | Established registry, bundle, migration, release, host parity, testing, and DoD style.                                                      |
| `specs/portable-prd-agent-plugin/spec.md:30-42,109-182,233-293`             | Existing Node 20+, lifecycle safety, host contracts, testing, and release boundaries.                                                       |
| `plugin/skills/issues/SKILL.md:1-17,40-56,77-114`                           | Existing canonical `br` workflow, command discovery, atomic claim example, read-after-write rule, execution boundary, and backend contract. |
| `plugin/capabilities/issues.json:1-31`                                      | Existing adapter-free issues capability, version `0.4.2`, modes, and host discovery.                                                        |
| `plugin/capabilities/copy.json:1-42`                                        | Existing copywriting capability and current version evidence.                                                                               |
| `plugin/lib/capability-registry.mjs:26-100`                                 | Current kinds, adapter-free workflow shape, and `copy`, `prd`, `spec`, `issues` order.                                                      |
| `plugin/lib/plugin-lifecycle.mjs:1-48,157-215`                              | Current Node runtime, schema-4/version-0.4.2 ownership, `authoring` bundle identity, and resource/adapter planning.                         |
| `plugin/scripts/contracts.mjs:16-159,185-230`                               | Current manifest, payload, host, privacy, ownership, and workflow-baseline validation.                                                      |
| `plugin/scripts/release-lib.mjs:6-24,77-98`                                 | Registry-derived deterministic release payload and aligned capability versions.                                                             |
| `plugin/test/manifest-contract.test.ts:22-110,138-148`                      | Current four-capability registry order, capability identity, host invocations, and Pi order.                                                |
| `plugin/test/issues-contract.test.ts:14-98`                                 | Existing static issues workflow/backend/manifest contracts to extend.                                                                       |
| `plugin/test/issues-workflow.test.ts:7-68`                                  | Existing issues scenario matrix to extend with epic-workspace gates.                                                                        |
| Validated `br` CLI help for version used by the issues integration          | Structured `--agent-context` on create/update, `source_repo_path`, JSON reads, and atomic `--claim`; implementation revalidates help.       |
| `plugin/test/adapter-payload-contract.node.mjs:43-101`                      | Existing exact distributed/installed payload parity and negative-control model.                                                             |
| [Git worktree documentation](https://git-scm.com/docs/git-worktree)         | Porcelain `-z` records, linked-worktree safeguards, branch exclusivity, and non-forced removal.                                             |
| [Git rev-parse documentation](https://git-scm.com/docs/git-rev-parse)       | Canonical Git directory, common directory, top-level, and superproject discovery.                                                           |
| [Git check-ignore documentation](https://git-scm.com/docs/git-check-ignore) | Directory-form ignore probing and ignore-source diagnostics.                                                                                |
| [Git pull documentation](https://git-scm.com/docs/git-pull)                 | Required fast-forward-only pull behavior.                                                                                                   |
| PRD research references `prd.md:222-234`                                    | Prior worktree skills and current OpenCode, Codex, Claude Code, Pi, and Agent Skills research supplied by the approved product record.      |
