# Portable Issues Skill PRD

## Status

Approved

## Summary

Add one portable `issues` capability for OpenCode, Codex, Claude Code, and Pi. It requires agents to
use durable issues as their todo and task system: substantial features have epics and decomposed
child issues, while every executable unit is created or reused, claimed, updated, verified, and
closed through the tracker.

For this release, Beads Rust through `br` is the required backend. The original `bd` command and
Dolt are prohibited. The capability name and issue/epic workflow remain backend-neutral so a future
Kona-native backend can replace `br` without changing user-facing behavior.

## Users And Outcome

- Coding agents need one durable source of work state instead of chat plans or host todo tools.
- Engineering leads need substantial features decomposed into actionable dependency graphs.
- Contributors need enough issue context and handoff evidence to resume without prior conversation.
- Toolkit maintainers need one canonical behavior across all supported hosts.

Success means every substantive implementation is issue-backed, ready work is dependency-correct,
closure is evidence-based, and all four hosts enforce equivalent decisions.

## Requirements

1. The skill activates for implementation, planning, task management, and explicit issue concepts.
2. When `br` is available and initialized, it is the sole todo and task tracker. Parallel host todos,
   Markdown checklists, and chat-only plans are prohibited.
3. If `br` is missing, the agent explains one supported installation action and asks for explicit
   confirmation before running it. Existing installations are not silently replaced or upgraded.
4. If the project is uninitialized, the agent explains the effect and asks for confirmation before
   `br init`. Combined consent is valid only when both actions were disclosed.
5. Refusal or failure blocks tracker-backed implementation rather than enabling a substitute tracker.
6. A small bounded change uses one issue. A substantial feature reuses or creates an epic and is
   decomposed into independently verifiable child issues before child implementation begins.
7. Each issue states outcome, scope, relevant constraints, design context, acceptance criteria, and
   dependencies. Existing issues and project taxonomy are reused where possible.
8. Agents select ready work, inspect parent/blocker/claim context, claim before implementation,
   update material progress and blockers, verify acceptance criteria, and close with evidence.
9. Newly discovered required work becomes an issue and dependency before it is undertaken.
10. Agents never invoke, install, recommend, or fall back to `bd`, and never install, configure,
    inspect, migrate, or depend on Dolt.
11. Runtime guidance is self-contained and contains no destination repository path, file, branch,
    script, or Kona-source dependency.
12. Tracker work does not authorize version-control or release operations.
13. The installed capability is named `issues`; host invocations and issue/epic semantics remain
    stable when the backend changes in the future.

## Distribution

| Host        | Scopes               | Invocation      |
| ----------- | -------------------- | --------------- |
| OpenCode    | Project, user        | `issues`        |
| Codex       | Project, user        | `$issues`       |
| Claude Code | Project, local, user | `/kona:issues`  |
| Pi          | Project, user        | `/skill:issues` |

The capability ships in the existing Kona bundle and lifecycle. Installation, update, verification,
disable, enable, and removal preserve tracker data, authored documents, user configuration, and
unrelated capabilities.

## Acceptance

1. Every substantive implementation has an active issue before code changes begin.
2. A substantial feature produces an epic, child issues, valid dependencies, and an accurate ready
   set before implementation.
3. Missing installation and initialization each require informed explicit consent.
4. Claim conflicts, blockers, and failed verification leave accurate non-closed state and actionable
   handoff context.
5. Successful closure records outcome and verification evidence and is confirmed by a subsequent
   read.
6. No runtime path invokes `bd`, uses Dolt, edits tracker storage directly, or creates parallel task
   state.
7. Equivalent scenarios produce equivalent decisions on all four hosts.
8. Existing schemas migrate only through explicit update; current and legacy lifecycle behavior is
   safe and reversible.

## Risks

| Risk                                    | Mitigation                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Broad activation is missed              | Put implementation, planning, task, issue, and epic terms in frontmatter and run implicit-activation dogfood. |
| Prompt rules are ignored                | Combine static contracts, command audits, deterministic scenarios, and real-model parity evidence.            |
| CLI syntax changes                      | Discover installed help and structured output before uncertain operations.                                    |
| Backend identity leaks into the product | Keep the capability named `issues` and isolate `br` instructions from stable workflow semantics.              |

## Open Questions

None blocking.
