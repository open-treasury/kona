# Epic Worktree Skill PRD

## 0. TL;DR

- Add a portable worktree capability that ensures every implementation epic is worked in one dedicated Git worktree rather than the primary checkout.
- Store all epic worktrees inside the repository at `.worktrees/<epic-key>/`; sibling checkouts and host-default locations do not satisfy the contract.
- Before creating an epic worktree, update local `main` with `git pull --ff-only` from `origin/main`, then create the epic branch and worktree from that exact commit.
- Before starting or resuming epic work, verify the current directory, linked-worktree identity, epic branch, registered path, and baseline state. Never assume isolation from the directory name alone.
- Ship one canonical Agent Skill across OpenCode, Codex, Claude Code, and Pi, integrated with epic creation and start/resume flows. Use a host-native worktree mechanism only when it can preserve and prove the same location, branch, and base guarantees.
- Starting epic implementation requires user confirmation before creating its worktree. Finishing an epic requires separate confirmation before removing it. The capability does not automatically merge, rebase, push, delete branches, discard changes, or bypass Git safety checks.

## 1. Meta Information

| Field            | Value                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| Status           | Approved                                                                                           |
| Primary audience | Engineers and coding agents working on implementation epics                                        |
| Initial delivery | Portable epic worktree skill and epic-workflow integration on OpenCode, Codex, Claude Code, and Pi |
| Default base     | Fresh, fast-forwarded `main` from `origin/main`                                                    |
| Worktree root    | `<repository-root>/.worktrees/`                                                                    |

## 2. What

Create a portable capability that makes a dedicated, repository-local Git worktree a prerequisite for implementation work under an epic. The capability must create a new worktree from freshly pulled `main`, or validate and re-enter the epic's existing worktree, before source changes begin.

The smallest useful delivery cut is one canonical Agent Skill plus thin host integration and an epic-boundary check. It must work with the repository's issue/epic workflow so creating, claiming, starting, or resuming an epic cannot silently continue in the primary checkout.

### In Scope

1. Git repositories with an `origin` remote and a `main` branch.
2. One durable worktree and one branch per implementation epic.
3. Repository-local placement under `.worktrees/`.
4. Creation, validation, entry, status reporting, recovery guidance, and safe cleanup.
5. Integration with epic creation and epic start/resume behavior.
6. Project setup and clean-baseline verification after creation.
7. Equivalent behavior across OpenCode, Codex, Claude Code, and Pi.

## 3. Motivation

### Problem

Epic work can currently begin in the primary checkout or in host-managed worktrees with different paths and base semantics. That creates avoidable collisions between concurrent agents, mixes unrelated changes, and makes it difficult to prove that an epic started from current `main`.

Host defaults are not equivalent. Claude Code normally creates worktrees under `.claude/worktrees/`; Codex managed worktrees normally live under `$CODEX_HOME/worktrees` and begin detached; current OpenCode and Pi documentation provides portable skill discovery but no equivalent stable native worktree contract. A common skill must therefore enforce product invariants independently of host defaults.

The repository also does not currently ignore `.worktrees/`; only `.claude/worktrees/` is ignored. Creating nested worktrees before correcting that would expose entire worktree contents as untracked files.

### Goals

1. Make isolated worktrees the default and required workspace for every implementation epic.
2. Guarantee that a newly created epic starts from freshly pulled `origin/main`, not stale local state or the caller's current branch.
3. Keep all epic workspaces discoverable inside `.worktrees/` in the primary repository.
4. Detect incorrect, stale, ambiguous, or unsafe workspace state before implementation changes begin.
5. Preserve uncommitted work and Git safeguards during creation, validation, and cleanup.
6. Provide semantically equivalent behavior on all four supported hosts from one canonical procedure.

### Users

| User         | Need                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------ |
| Engineer     | Start and resume an epic in a predictable isolated checkout without disturbing other work. |
| Coding agent | Determine mechanically whether it is in the correct epic worktree before editing files.    |
| Maintainer   | Apply one worktree policy across hosts and evolve it without adapter drift.                |
| Reviewer     | Trace an epic to its branch, worktree path, base commit, and baseline verification result. |

## 4. User Stories

1. As an engineer starting an epic, I want its worktree created from current remote `main` so that stale local state does not become part of the implementation.
2. As an engineer running concurrent epics, I want each epic under `.worktrees/` so that all isolated checkouts are visible in one predictable repository-local place.
3. As a coding agent, I want to verify my Git identity and epic mapping before editing so that I never mistake the primary checkout, a submodule, or another epic's worktree for the correct workspace.
4. As an engineer resuming an epic, I want the existing worktree preserved without an automatic reset or rebase so that in-progress work is not lost.
5. As a maintainer, I want the same policy on OpenCode, Codex, Claude Code, and Pi even when their native worktree features differ.
6. As a reviewer, I want a concise readiness report so that I can confirm path, branch, base, setup, and tests before implementation proceeds.

## 5. User Flow

### Start an Epic

1. An implementation epic already exists with a stable identifier and title. Creating or planning the epic alone does not create a worktree.
2. When the user or issue workflow attempts to claim or start implementation, the capability shows the proposed epic path, branch, and `origin/main` base, then asks the user to confirm worktree creation.
3. If the user declines, the epic remains not-started and no branch, directory, or worktree is created.
4. After confirmation, the capability locates the repository root and primary checkout, confirms that the repository has `origin/main`, and checks registered worktrees using Git metadata.
5. It derives a deterministic epic key for the path and branch, then checks for path, branch, and issue-to-worktree collisions.
6. It verifies that `.worktrees/` is ignored. If not, it stops worktree creation and presents the required repository change; it does not hide the problem with a machine-local exclude rule.
7. It verifies that the primary `main` checkout can be updated safely. It does not stash, reset, discard, or overwrite local changes.
8. It updates `main` with a fast-forward-only pull from `origin/main`. Any fetch, authentication, divergence, dirty-checkout, or pull failure blocks creation and is reported.
9. It creates the epic branch and `.worktrees/<epic-key>/` from the exact pulled `main` commit, or uses a host-native mechanism only if that mechanism can prove the same outcome.
10. It enters the worktree, verifies the registered path and checked-out branch, runs repository-appropriate setup, and runs the configured baseline checks.
11. It records the epic-to-worktree association in the epic workflow and reports the epic identifier, absolute worktree path, branch, base commit, setup result, and baseline result. Implementation may begin only after the workspace gate passes.

### Resume an Epic

1. The capability resolves the epic's expected branch and `.worktrees/<epic-key>/` path.
2. It verifies the path through `git worktree list --porcelain`, confirms it is a linked worktree for the same repository, and rules out a submodule false positive.
3. It confirms that the expected epic branch is checked out only in that worktree and that the current session is operating there.
4. It reports divergence from `main` and working-tree state without resetting, rebasing, pulling, or deleting in-progress work.
5. It reruns required readiness checks and allows work to resume only when identity and safety checks pass.

### Finish or Retire an Epic

1. Moving an epic to finished automatically starts its worktree-retirement check after the epic's work is committed, pushed, merged, or otherwise preserved according to the team's workflow.
2. The capability verifies worktree cleanliness and reports untracked files, modifications, unpushed commits, or an unmerged branch.
3. It asks the user to confirm removal of the identified epic worktree. Confirmation is required even when the worktree is clean.
4. After confirmation, it removes only that clean epic worktree through Git's worktree operation and records successful retirement.
5. If confirmation is declined or removal is unsafe or fails, it preserves the worktree and leaves the epic in an explicit cleanup-pending state rather than claiming the lifecycle is complete.
6. Branch deletion, pruning, and forced removal require separate explicit user intent and are not implied by epic completion.

### Failure and Recovery

- If `main` cannot be fast-forwarded, creation stops; the capability never merges, rebases, or force-updates `main` automatically.
- If the primary checkout has changes that make pulling unsafe, creation stops and reports them without stashing or discarding anything.
- If `.worktrees/` is not ignored, creation stops before materializing a checkout.
- If the expected path or branch belongs to another epic, creation stops and reports the collision.
- If an existing worktree contains changes, the capability preserves it and reports the state; it never recreates or resets it to become "fresh."
- If the session is already inside a different or non-conforming linked worktree, the capability stops and directs the host to the epic's worktree; it never nests another worktree from there.
- If dependency setup or baseline checks fail, the worktree remains available, but implementation is blocked until the user chooses to investigate or explicitly accepts the known baseline failure.
- If a host-native mechanism cannot honor `.worktrees/`, a named epic branch, and a fresh `main` base, the capability uses safe Git worktree operations instead of silently accepting host defaults.

## 6. Definition of Done

### Functional Requirements

| ID   | Requirement                                                                                                                                                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR1  | The capability must activate when implementation of an epic is claimed or started and when it is resumed, whether invoked directly or through the repository's issues workflow. Creating or planning an epic alone must not create a worktree.                                                                                  |
| FR2  | It must not edit implementation files for an epic until the workspace gate confirms that the session is in that epic's valid linked worktree.                                                                                                                                                                                   |
| FR3  | Every new epic worktree must be stored at `<repository-root>/.worktrees/<epic-key>/`. A sibling checkout, `.claude/worktrees/`, `$CODEX_HOME/worktrees`, or another host-managed default does not satisfy this requirement.                                                                                                     |
| FR4  | The epic key and branch name must be deterministic from a stable epic identifier and a readable lowercase ASCII slug. Repeated invocation for the same epic must resolve to the same path and branch.                                                                                                                           |
| FR5  | Before creating the first nested worktree, the capability must prove `.worktrees/` is ignored using Git's ignore semantics. It must not rely only on the directory name or a global/machine-local exclude.                                                                                                                      |
| FR6  | Every worktree creation must first update the primary checkout's `main` using a successful fast-forward-only pull from `origin/main` and capture the resulting commit. The new epic branch must start at exactly that commit; cached remote state, stale local `main`, and the caller's current `HEAD` are not valid fallbacks. |
| FR7  | A failed or unsafe update of `main` must block creation. The capability must not automatically stash, reset, clean, merge, rebase, force, or discard changes to recover.                                                                                                                                                        |
| FR8  | Creation must use normal Git collision safeguards. It must not use `-B`, `--force`, or equivalent behavior to overwrite an existing branch or registered worktree.                                                                                                                                                              |
| FR9  | Before creation, it must inspect registered worktrees in machine-readable form and detect path reuse, branch reuse, missing paths, locked worktrees, prunable entries, and epic mapping conflicts.                                                                                                                              |
| FR10 | Before treating the current directory as isolated, it must compare canonical absolute Git and common-Git directories, then distinguish a linked worktree from the primary checkout and from a submodule. Raw path-string comparison and directory naming are insufficient.                                                      |
| FR11 | Resume must validate repository identity, expected path, expected branch, registration, and current session location. It must preserve and report existing changes and commits without refreshing the branch from `main`.                                                                                                       |
| FR12 | After creation, it must run repository-appropriate environment setup and configured baseline validation. Commands must come from authoritative repository guidance or detected project configuration, not an invented universal command.                                                                                        |
| FR13 | A baseline failure must be shown separately from worktree-identity failure. Work may proceed past a baseline failure only after explicit user direction; the original failure remains in the readiness report.                                                                                                                  |
| FR14 | A successful readiness report must include epic identifier, absolute worktree path, branch, base commit, current commit, working-tree status, setup result, and baseline result. The epic workflow must durably retain at least the epic-to-path, branch, and base-commit association for later resume checks.                  |
| FR15 | Moving an epic to finished must trigger cleanup preflight and required user confirmation before removing its worktree. Cleanup must use Git worktree removal and refuse destructive cleanup by default.                                                                                                                         |
| FR16 | One canonical Agent Skill must define the workflow for OpenCode, Codex, Claude Code, and Pi. Host adapters may differ only in discovery, invocation, permission, directory-entry, and lifecycle plumbing.                                                                                                                       |
| FR17 | A host-native worktree feature may be used only when the capability can configure or verify all locked invariants. Otherwise the canonical Git fallback is required.                                                                                                                                                            |
| FR18 | The existing epic/issues capability must invoke or enforce this workspace gate at epic boundaries. A descriptive skill alone, dependent on optional model activation, is insufficient for the "every epic" guarantee.                                                                                                           |
| FR19 | The capability must be idempotent: invoking it again for an already valid epic worktree must validate and reuse that worktree rather than creating another checkout.                                                                                                                                                            |
| FR20 | The capability must not access secrets, copy ignored environment files, or emit analytics or telemetry. Any future ignored-file copying requires a separate explicit product decision.                                                                                                                                          |
| FR21 | Worktree creation is not complete until the active host session's canonical working directory resolves inside the verified epic worktree. If the host cannot enter or relaunch there, implementation remains blocked.                                                                                                           |
| FR22 | Repository setup must not automatically trust executable environment configuration such as `.envrc` or tool-manager configuration. Trust requires explicit user approval after the relevant content is identified for review.                                                                                                   |
| FR23 | Ignore verification must test the directory form `.worktrees/` so a valid directory-only ignore rule is recognized before the directory exists.                                                                                                                                                                                 |
| FR24 | Before creating a worktree for an epic that is starting implementation, the capability must show the proposed path, branch, and base and obtain explicit user confirmation. Declining confirmation must leave the epic not-started and create nothing.                                                                          |
| FR25 | If finish-time removal is declined, unsafe, or unsuccessful, the worktree must remain intact and the epic must remain cleanup-pending. Forced removal, branch deletion, and pruning require separate explicit intent.                                                                                                           |

### Host Requirements

| Host        | Required behavior                                                                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode    | Discover the canonical skill through its Agent Skills locations. Because current documented CLI/tools do not expose a stable worktree primitive, use the Git fallback and run or enter OpenCode with the verified worktree as its working directory. |
| Codex       | Discover the canonical skill from `.agents/skills`. A managed Codex worktree is acceptable only when its configured root, branch state, and base satisfy this PRD; the documented detached and `$CODEX_HOME/worktrees` defaults do not.              |
| Claude Code | Discover the skill through the Kona plugin. Its native `--worktree`/`EnterWorktree` flow is acceptable only when customized to `.worktrees/` and verified; the `.claude/worktrees/` default does not satisfy this PRD.                               |
| Pi          | Discover the canonical skill through package metadata or `.agents/skills`, then use the verified Git fallback unless a future native primitive satisfies the same contract.                                                                          |

### Non-Functional Requirements

| ID                        | Requirement                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| NFR1 - Safety             | No default path may destroy, hide, overwrite, or relocate uncommitted work, untracked files, commits, branches, or worktrees.       |
| NFR2 - Portability        | The core workflow must remain valid on macOS and Linux and must not depend on a single host's proprietary worktree feature.         |
| NFR3 - Determinism        | The same repository and epic identifier must resolve to the same expected path and branch on every supported host.                  |
| NFR4 - Verifiability      | Workspace readiness must be determined from Git and repository evidence, not an agent's self-report.                                |
| NFR5 - Maintainability    | Canonical skill changes must trigger payload-integrity and semantic-parity checks across all distributed adapters.                  |
| NFR6 - Context efficiency | Host adapters must remain thin; the full procedure must not be duplicated across host-specific prompts.                             |
| NFR7 - Host awareness     | The capability must not leave a manually created "phantom" worktree that the active host cannot enter, resume, identify, or report. |

### Acceptance Criteria

1. **Given** a clean repository whose `main` is behind `origin/main`, **When** a new epic starts, **Then** `main` is fast-forward pulled first and the epic branch and worktree start at the resulting commit.
2. **Given** the caller is on a feature branch, **When** a new epic starts, **Then** the new worktree is based on freshly pulled `main`, not the caller's `HEAD`.
3. **Given** `.worktrees/` is not ignored, **When** creation is requested, **Then** no worktree is created and the required repository ignore change is reported.
4. **Given** a new epic with identifier and title, **When** creation succeeds, **Then** exactly one registered linked worktree exists under `.worktrees/<epic-key>/` on its deterministic epic branch.
5. **Given** the same epic is started again, **When** its worktree is valid, **Then** the capability reuses it and creates neither a second path nor a second branch.
6. **Given** the current directory is the primary checkout or a submodule, **When** the workspace check runs, **Then** it does not report a valid epic worktree.
7. **Given** the expected branch is checked out in another worktree, **When** creation is requested, **Then** the capability reports the owner path and makes no change.
8. **Given** `main` is dirty, diverged, unavailable, or cannot be pulled, **When** a new epic starts, **Then** creation stops without stash, reset, merge, rebase, force, or cleanup.
9. **Given** an existing epic worktree has uncommitted changes or epic commits, **When** the epic resumes, **Then** those changes remain byte-for-byte intact and no refresh from `main` occurs.
10. **Given** setup succeeds but baseline tests fail, **When** readiness is evaluated, **Then** the worktree remains registered, implementation is blocked, and the failure is reported separately from isolation status.
11. **Given** a clean valid worktree and passing baseline, **When** readiness completes, **Then** the report contains every field in FR14 and implementation can proceed there.
12. **Given** an epic is created or planned but implementation has not started, **When** the epic is saved, **Then** no worktree or branch is created.
13. **Given** implementation is about to start and no worktree exists, **When** the capability proposes the path, branch, and base, **Then** it creates nothing until the user confirms.
14. **Given** the user declines start-time creation, **When** the confirmation closes, **Then** the epic remains not-started and no Git or filesystem state changes.
15. **Given** an epic is moved to finished, **When** finalization runs, **Then** it performs cleanup preflight and asks the user to confirm removal of the identified worktree.
16. **Given** an epic worktree is clean and the user confirms removal, **When** cleanup runs, **Then** only that linked worktree is removed and its branch remains unless separately requested.
17. **Given** the user declines removal or the worktree has unpreserved changes or commits, **When** finalization runs, **Then** the worktree remains intact and the epic is reported as cleanup-pending.
18. **Given** equivalent epic-start fixtures on OpenCode, Codex, Claude Code, and Pi, **When** the capability runs, **Then** each produces the same path, branch, fresh-base, safety, confirmation, and readiness outcomes.
19. **Given** a host-native tool proposes a host-default location or detached state, **When** it cannot be configured to satisfy this PRD, **Then** the capability rejects that result and uses the canonical Git fallback.
20. **Given** an epic is moved into active implementation through the issues workflow, **When** no valid epic worktree exists, **Then** the workflow requests confirmation and blocks implementation until creation and the workspace gate pass.
21. **Given** the session is already inside a linked worktree for another epic or outside `.worktrees/`, **When** a new epic is started, **Then** no nested worktree is created and work remains blocked until the host enters the correct epic worktree.
22. **Given** a Git worktree was created but the host remains in the primary checkout, **When** readiness runs, **Then** readiness fails rather than reporting isolation based only on registration.
23. **Given** `.worktrees/` is covered by a directory-only ignore rule, **When** preflight runs before the directory exists, **Then** the rule is recognized and no duplicate ignore entry is added.
24. **Given** ignored environment files or executable tool configuration exist in the primary checkout, **When** an epic worktree is created, **Then** secrets are not copied and tool configuration is not auto-trusted.

### Risks

| Risk                                                          | Mitigation                                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Nested worktree contents appear as source changes             | Require committed repository-level `.worktrees/` ignore coverage before creation.                     |
| Pulling `main` disturbs a user's checkout                     | Require a clean, safe primary `main` and fast-forward-only pull; stop on any ambiguity.               |
| Host-native behavior violates the common contract             | Treat native support as an optimization behind verification, never as authority.                      |
| Manual Git creation produces a worktree the host does not use | Require a verified host transition into the canonical worktree before readiness passes.               |
| Agents skip an implicitly matched skill                       | Integrate the gate into epic lifecycle behavior and add deterministic negative tests.                 |
| Existing epic work is overwritten in pursuit of freshness     | Apply freshness only at creation; resume is validate-and-preserve.                                    |
| Worktrees consume excessive disk                              | Provide explicit status and safe retirement; never trade disk cleanup for data loss.                  |
| Epic names collide or change                                  | Include the immutable epic identifier in the deterministic key; title text is only a readable suffix. |

## 7. Out of Scope

1. Automatically merging, rebasing, pushing, opening pull requests, or resolving conflicts.
2. Automatically deleting epic branches, forcing removal, pruning unrelated worktrees, or cleaning files.
3. Copying `.env`, credentials, secrets, caches, dependencies, or other ignored files into worktrees.
4. Supporting a base branch other than `main` or a remote other than `origin` in the initial release.
5. Per-task worktrees inside an epic; the initial unit of isolation is one worktree per epic.
6. Non-Git version control systems and Git submodule worktree orchestration.
7. Guaranteeing that external tools launched outside the verified worktree obey the workspace boundary.

## 8. References

- [Using Git Worktrees skill](https://www.skills.sh/obra/superpowers/using-git-worktrees) and its [canonical `SKILL.md`](https://github.com/obra/superpowers/blob/main/skills/using-git-worktrees/SKILL.md): isolation detection, ignore verification, setup, baseline validation, and safe fallback patterns.
- [`ce-worktree`](https://www.skills.sh/everyinc/compound-engineering-plugin/ce-worktree): resolved-path isolation detection, submodule handling, host-native ownership, non-nesting behavior, branch exclusivity, and blocking on failed isolation.
- [`git-worktree` manager](https://www.skills.sh/everyinc/compound-engineering-plugin/git-worktree): repository-local `.worktrees/`, idempotent lookup, interactive lifecycle, and environment/tool-trust concerns. Its automatic secret copying, auto-trust, and forced bulk cleanup are intentionally excluded from this product.
- [`git-worktrees`](https://www.skills.sh/neolabhq/context-engineering-kit/git-worktrees): worktree lifecycle, machine-readable listing, branch locking, repair, and pruning reference. Its sibling-directory convention is intentionally superseded by the confirmed `.worktrees/` requirement.
- [Git worktree documentation](https://git-scm.com/docs/git-worktree): linked-worktree identity, branch exclusivity, porcelain listing, removal, locking, pruning, and repair behavior.
- [Agent Skills specification](https://agentskills.io/specification): portable skill structure, metadata, progressive disclosure, and validation.
- [OpenCode Agent Skills](https://opencode.ai/docs/skills/) and [OpenCode CLI](https://opencode.ai/docs/cli/): skill discovery and current command surface.
- [Claude Code worktrees](https://code.claude.com/docs/en/worktrees) and [skills](https://code.claude.com/docs/en/skills): native worktree defaults, `EnterWorktree`, fresh-base behavior, cleanup, and skill packaging.
- [Codex worktrees](https://developers.openai.com/codex/environments/git-worktrees/) and [skills](https://developers.openai.com/codex/build-skills/): managed worktree location/state and `.agents/skills` discovery.
- [Pi skills](https://pi.dev/docs/latest/skills): Agent Skills discovery, project trust, and package distribution.
- `specs/portable-prd-agent-plugin/prd.md` and `specs/portable-spec-agent-plugin/prd.md`: Kona's established canonical-skill and thin-adapter product model.

## 9. Decision Record

| Status      | Decision                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirmed   | Every new implementation epic is worked in a dedicated worktree.                                                                                                                                              |
| Confirmed   | Epic worktrees live inside the repository under `.worktrees/`, not as sibling copies.                                                                                                                         |
| Confirmed   | Every new epic worktree requires a successful fresh pull of `origin/main`, and its branch starts at exactly the resulting `main` commit; there is no stale or current-HEAD fallback.                          |
| Confirmed   | Epic start and resume both include an explicit worktree check.                                                                                                                                                |
| Confirmed   | Starting epic implementation requires user confirmation before creating its worktree; declining leaves the epic not-started.                                                                                  |
| Confirmed   | Finishing an epic requires user confirmation and successful safe removal of its worktree; otherwise the epic remains cleanup-pending.                                                                         |
| Recommended | Deliver the behavior as one portable Agent Skill with epic-workflow integration across the four hosts Kona already supports.                                                                                  |
| Recommended | Use `epic/<epic-id>-<slug>` for branches and `<epic-id>-<slug>` for worktree directories. Exact naming may be finalized in the technical specification if determinism and collision resistance are preserved. |
| Unresolved  | None blocking.                                                                                                                                                                                                |
