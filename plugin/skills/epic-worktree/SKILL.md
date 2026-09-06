---
name: epic-worktree
description: Safely propose, create, verify, resume, and remove the deterministic linked Git worktree for an implementation epic.
---

# Epic Worktree

Use this skill only for an implementation epic's repository-local linked worktree. The private helper adjacent to this file is the sole authority for Git discovery and mutation:

```text
node <this-skill-directory>/scripts/epic-worktree.mjs <propose|start|check|finish> --json
```

Resolve `<this-skill-directory>` from the installed skill, invoke Node with an argv array, and send one schema-versioned JSON request on stdin. Never run Git mutations directly, recreate the helper's decisions in shell, or use a host's default worktree manager.

## Invariants

- The worktree is `<canonical-repository-root>/.worktrees/<epic-key>` on `epic/<epic-key>`.
- New work starts only from the primary, clean `main` worktree after the helper successfully runs a fresh `git pull --ff-only origin main`.
- Existing mapped worktrees are inspected, never refreshed, reset, rebased, merged, stashed, pruned, force-removed, or branch-deleted.
- Only `start` and confirmed `finish` mutate Git. `propose`, `check`, and unconfirmed `finish` are read-only apart from configured readiness commands run by `check`.
- Creation and removal require separate, state-bound confirmation tokens. Never reuse or synthesize a token.
- Readiness requires this host's current Git top level to be the expected linked worktree. Registration alone is not readiness.
- Do not copy ignored files, environment files, credentials, or secrets between worktrees. Do not run `direnv allow`, `mise trust`, or equivalent trust commands.
- The helper owns no persistent mapping. The issues workflow owns `agent_context.kona.workspace`; preserve all unrelated context.

## Request

Build the request from the current epic record and repository evidence:

```json
{
  "schemaVersion": 1,
  "epic": { "id": "E-42", "slugSeed": "Import settlement reports" },
  "sourceRepoPath": "/canonical/primary/repository",
  "agentContextDigest": "digest-bound-to-current-epic-context",
  "mapping": null,
  "knownMappings": [],
  "confirmationToken": null,
  "baselineExceptionToken": null,
  "readiness": {
    "setup": [{ "argv": ["bun", "install"], "source": "README.md:20" }],
    "baseline": [{ "argv": ["bun", "test"], "source": "package.json:29" }]
  }
}
```

Use the immutable epic identifier and the title-derived `slugSeed` captured when the epic was created. For resume or finish, pass the complete existing workspace mapping. Build `knownMappings` from epics belonging to the same canonical source repository. Every readiness command must be an argv array supported by cited repository guidance or project configuration. Empty setup means not required; empty baseline blocks readiness until the user explicitly accepts the helper's bound exception.

## Start

1. Invoke `propose` without a confirmation token.
2. Stop on any blocker. Otherwise show the exact path, branch, and base policy returned by the helper.
3. Ask the user explicitly whether to create that worktree. A decline ends the flow without invoking `start`, claiming the epic, or changing its context.
4. After the issues workflow has atomically claimed and re-read the epic, invoke `start` with the exact proposal token and current context evidence.
5. Treat a stale token as a new decision: rerun `propose`, show the changed proposal, and ask again.
6. Persist successful or partial creation evidence as `starting` through the issues workflow. Never delete partial artifacts.
7. Enter or relaunch the host at `hostTransition.path`, then invoke `check` there. Do not authorize implementation from the original process.

Host entry uses only directory plumbing:

- OpenCode: reopen with the reported directory, including its `--dir` mechanism where applicable.
- Codex: launch or reopen Codex in the reported directory; do not use managed detached worktrees.
- Claude Code: reopen in the reported directory; native worktree support may provide entry only and must not create a different worktree.
- Pi: restart or open Pi in the reported directory.

## Check And Resume

Invoke `check` from the expected mapped path before activation and every implementation dispatch. A clean valid worktree is usable only after `READY`. `READY_EXISTING_WORK` is usable only for an already-`active` mapping with accepted creation-baseline evidence; the helper skips setup and baseline to preserve existing bytes. It can never activate a `starting` mapping.

If baseline fails, show the command, source, exit, and bounded output evidence. Ask separately whether to accept that exact failure. Only a second `check` with the returned `baselineExceptionToken` can accept it. The token cannot waive identity, mapping, path, branch, host-location, or dirty-starting failures.

Stop on `HOST_TRANSITION_REQUIRED`, `DIRTY_STARTING_WORKTREE`, mapping conflict, collision, lock contention, or any identity/safety failure. Do not repair automatically.

## Finish

1. Invoke `finish` without a confirmation token for read-only cleanup preflight.
2. Show dirty state, branch-tip preservation, upstream/`origin/main` containment warnings, and all blockers.
3. If unsafe, stop and retain the worktree, branch, and `cleanup-pending` mapping state.
4. If safe, ask explicitly whether to remove only the linked worktree. A decline performs no helper mutation.
5. Invoke `finish` again with the exact removal token. Only `REMOVED` permits the issues workflow to record `finished`.

Confirmed removal is non-forced and retains the branch. Never prune, clean, push, merge, rebase, reset, or delete the branch as part of this procedure.

## Result Handling

Parse the single JSON result and use both process exit and `code`. Exit `0` means the requested inspection or mutation completed, not necessarily that implementation may begin. Exit `3` requires fresh confirmation; `4` or `5` is a safety/collision failure; `6` is a Git or partial-mutation failure; `7` is readiness failure; `8` requires host transition; and `9` means the repository lock is unavailable.

Preserve and report the helper's evidence. Never claim readiness after a partial snapshot, and never persist absolute worktree paths in the epic mapping.
