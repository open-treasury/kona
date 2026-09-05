# Portable Issues Skill Technical Specification

## Status

Approved

## Decision

Add one canonical, self-contained `issues` skill to the existing Kona capability bundle. Native host
discovery exposes the same skill without a separate execution agent. `br` is the selected backend
for this release, while issue, epic, dependency, claim, and lifecycle semantics remain stable and
backend-neutral.

## Components

| Component           | Change                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| Canonical skill     | Define activation, bootstrap consent, issue/epic workflow, command discovery, closure, and safety boundaries. |
| Capability manifest | Record the skill hash, modes, scopes, and `issues` host invocations.                                          |
| Capability registry | Support an adapter-free workflow capability after copy, PRD, and SPEC.                                        |
| Lifecycle           | Add schema 4 for `copy/prd/spec/issues`; preserve schemas 1–3 as exact legacy capability sets.                |
| Host discovery      | Verify `issues`, `$issues`, `/kona:issues`, and `/skill:issues` through native host interfaces.               |
| Release and docs    | Include the canonical payload deterministically and document lifecycle and bootstrap boundaries.              |
| Tests               | Add static, scenario, migration, rollback, host, release, and real-model parity coverage.                     |

## Runtime Design

The stable workflow is:

```text
request
  -> activate issues skill
  -> consent-gated br installation and initialization when needed
  -> inspect or create issue; create epic and child graph for substantial work
  -> validate dependencies and ready work
  -> claim one actionable issue
  -> implement only its scope and record material state
  -> verify acceptance criteria
  -> close with evidence or leave accurate non-closed handoff state
  -> re-read and report; do not automatically start unrelated work
```

Concrete syntax is resolved from installed `br` help. Machine-readable output is preferred. Every
mutation is followed by a read. Missing semantics block work rather than triggering direct storage
access, `bd`, Dolt, or another tracker.

## Consent

Binary installation and project initialization are distinct mutations. The agent discloses the exact
installation action and effect before approval, verifies the installed executable, then separately
checks initialization. One approval may cover both only when both were explicit. Declined or failed
consent leaves implementation blocked without substitute task state.

## Lifecycle And Migration

| Schema | Recorded capabilities   | Behavior before explicit update                              |
| ------ | ----------------------- | ------------------------------------------------------------ |
| 1      | PRD                     | Inspectable; lifecycle operates only on PRD.                 |
| 2      | PRD, SPEC               | Inspectable; lifecycle operates only on PRD and SPEC.        |
| 3      | Copy, PRD, SPEC         | Inspectable; lifecycle operates only on its recorded bundle. |
| 4      | Copy, PRD, SPEC, Issues | Current idempotent lifecycle.                                |

`install` and `verify` return `UPDATE_REQUIRED` for legacy schemas. Only approved `update` validates
legacy ownership, installs the current bundle transactionally, verifies native discovery, and
commits schema 4. Failure restores exact copied state or retains native recovery evidence when exact
rollback cannot be proved.

## Host Contracts

- OpenCode copies the canonical skill and discovers `issues`; no writer or execution subagent exists.
- Codex copies the canonical skill and discovers `$issues`; one bounded block controls all skills.
- Claude Code discovers `/kona:issues` from the existing package at project, local, and user scopes.
- Pi discovers `/skill:issues` from the existing package at project and user scopes.

## Testing Strategy

Follow RED-GREEN-REFACTOR.

1. Static contracts verify frontmatter, mandatory workflow, path independence, backend boundaries,
   hashes, modes, registry order, and release contents.
2. Deterministic scenarios cover consent, small work, epic decomposition, dependencies, claims,
   blockers, discovered work, failed verification, closure, and bounded continuation.
3. Lifecycle integration covers every host/scope, schemas 1–4, migration, tamper, conflicts, rollback,
   and tracker/config/document canaries.
4. Real-model dogfood on all four hosts proves implicit activation and equivalent state decisions.

## Definition Of Done

- All repository tests, type checks, lint, formatting, plugin build, validation, and plugin tests pass.
- All four hosts discover exactly `copy`, `prd`, `spec`, and `issues` at supported scopes.
- Runtime guidance has no destination repository assumption, executable `bd` or Dolt command, direct
  storage access, parallel task tracker, or unauthorized version-control behavior.
- Schemas 1–3 migrate only through explicit update and preserve exact state on failure.
- Existing copy, PRD, SPEC, workflow, installer, and release behavior does not regress.
- Four-host real-model evidence covers activation, consent, issue planning, execution, failure, and
  closure with no skipped host.

## Alternatives Rejected

- Naming the capability `br`: couples user-facing identity to a replaceable backend.
- A dedicated execution agent: may not share the active user's consent and implementation context.
- Automatic installation or initialization: violates informed consent.
- Falling back to host todos, `bd`, or Dolt: creates split-brain or incompatible state.
- Reinterpreting schema 3: breaks existing ownership evidence; schema 4 is explicit instead.

## Open Questions

None blocking.
