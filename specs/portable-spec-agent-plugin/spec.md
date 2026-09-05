# Portable SPEC Writer Technical Specification

## 0. TL;DR

- **SPEC status: Approved.** The sibling [PRD](./prd.md) is Approved.
- Add one canonical `spec` skill and bundled template beside the existing `prd` skill; no runtime content may reference or read `guidelines/`.
- Ship PRD and SPEC as one Kona authoring bundle across OpenCode, Codex, Claude Code, and Pi; lifecycle commands continue to select only host and scope.
- Generalize copied-host resource planning, discovery, manifests, release assembly, and tests from one hard-coded capability to an ordered capability registry.
- Preserve the existing lifecycle safety model and migrate shipped schema-v1 PRD-only ownership state to schema v2 only during an explicit update.
- Keep the OpenCode `spec-writer` adapter documentation-only; Codex, Claude Code, and Pi use native skill discovery without wrappers.
- Enforce SPEC-only authoring, material-evidence classification, meaningful option comparison, RED-GREEN-REFACTOR test strategy, and repository-derived Definition of Done.
- Release validation must prove exact payloads, no `guidelines/` dependency, both-capability discovery, lifecycle preservation, and real-model create/refine parity on all four hosts.

## 1. Meta Information

| Field       | Value                                                         |
| ----------- | ------------------------------------------------------------- |
| SPEC status | Approved                                                      |
| Branch      | `main`                                                        |
| Epic        | Portable SPEC writer                                          |
| PRD         | [Portable SPEC Writer Capability PRD](./prd.md), Approved     |
| Scope       | SPEC authoring plus multi-capability distribution integration |

## 2. Context

Kona currently distributes one self-contained PRD writer. Its skill, template, manifest, OpenCode adapter, lifecycle implementation, release archive, Pi package metadata, documentation, and tests are all PRD-specific (`plugin/capabilities/prd.json:1-35`, `plugin/lib/plugin-lifecycle.mjs:130-175`, `plugin/scripts/release-lib.mjs:7-15`).

The approved PRD requires an equivalent SPEC writer on the same four hosts. The source SPEC and engineering guidance are migration inputs only: installed authoring must work in a clean repository without a Kona checkout or `guidelines/`. This feature adds technical-document authoring, not implementation, beads planning, or workflow-engine behavior.

## 3. Key Technical Drivers

| Driver                     | Contract                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One SPEC method            | `plugin/skills/spec/SKILL.md` and its bundled template are the only complete SPEC procedure.                                                           |
| Existing-host parity       | OpenCode, Codex, Claude Code, and Pi expose both PRD and SPEC through their current package and lifecycle channel.                                     |
| Self-containment           | Canonical, copied, installed, and adapter payloads contain no `guidelines/` path or runtime dependency.                                                |
| Lifecycle compatibility    | Existing PRD behavior, six lifecycle verbs, host/scope syntax, ownership, locking, rollback, and one-active-scope rules remain intact.                 |
| Shipped-state migration    | Existing schema-v1 PRD-only installs remain inspectable and removable; only explicit `update` promotes them to the two-capability schema.              |
| Decision quality           | SPECs distinguish evidence, recommendations, and unresolved decisions; compare credible options; and trace the selected solution to technical drivers. |
| Safe authoring             | The capability writes only the agreed SPEC and does not implement code, create task plans, or manage beads.                                            |
| Deterministic distribution | Capability hashes, release contents, installed copies, and native discovery are reproducible and testable without model calls.                         |

## 4. Current State

### 4.1. PRD-Specific Distribution

| Surface                           | Current behavior                                                                     | Required change                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `plugin/skills/prd/`              | Canonical PRD procedure and template.                                                | Preserve unchanged; add sibling canonical `spec` payload.         |
| `plugin/capabilities/prd.json`    | Defines one capability, hashes, hosts, scopes, and invocations.                      | Add `spec.json`; validate both through an ordered registry.       |
| `plugin/lib/plugin-lifecycle.mjs` | Hard-codes PRD roots, source files, discovery names, state identity, and output.     | Plan, own, discover, and report the complete authoring bundle.    |
| `plugin/scripts/contracts.mjs`    | Validates one manifest and one canonical payload.                                    | Validate each capability and bundle-level invariants.             |
| `plugin/scripts/release-lib.mjs`  | Enumerates only PRD capability files in `RELEASE_FILES`.                             | Derive or explicitly validate the complete deterministic payload. |
| `package.json`                    | Pi discovers only `./plugin/skills/prd` (`package.json:8-12`).                       | Declare both canonical skill directories in stable order.         |
| OpenCode adapter                  | `prd-writer.md` delegates to `prd` with Markdown-only edits and no shell.            | Add an equivalent thin `spec-writer.md`.                          |
| Ownership manifest                | Schema 1 identifies `capability: "prd"` (`plugin/lib/plugin-lifecycle.mjs:470-520`). | Introduce schema 2 bundle identity and strict schema-1 migration. |

### 4.2. Host Surface

| Host        | Existing PRD invocation | New SPEC invocation | Managed scope roots                                                            |
| ----------- | ----------------------- | ------------------- | ------------------------------------------------------------------------------ |
| OpenCode    | `@prd-writer`           | `@spec-writer`      | Project `.opencode/{skills,agents}`; user `~/.config/opencode/{skills,agents}` |
| Codex       | `$prd`                  | `$spec`             | Project `.agents/skills`; user `~/.agents/skills`                              |
| Claude Code | `/kona:prd`             | `/kona:spec`        | Existing Kona plugin at project, local, or user scope                          |
| Pi          | `/skill:prd`            | `/skill:spec`       | Existing Kona package at project or user scope                                 |

## 5. Considered Options

| Option                                    | Advantages                                                     | Costs and risks                                                                    | Decision   |
| ----------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------- |
| Publish a separate SPEC package           | Independent lifecycle and versioning                           | Duplicates channels, ownership state, commands, and user setup                     | Reject     |
| Add a `--capability` selector             | Users can install writers independently                        | Expands CLI/state matrices and violates the PRD requirement for the same lifecycle | Reject     |
| Keep lifecycle code duplicated per writer | Minimal edits to existing PRD path                             | Doubles safety-sensitive logic and guarantees drift                                | Reject     |
| Registry-driven two-capability bundle     | One lifecycle operation, shared safety model, extensible tests | Requires careful schema-v1 migration and broader native discovery checks           | **Select** |

The selected approach treats PRD and SPEC as separately hashed authoring capabilities delivered by one versioned Kona bundle. It generalizes only the capability-dependent portions of lifecycle code; locking, transactions, backups, native package operations, and public verbs remain shared and unchanged.

## 6. Proposed Solution

### 6.1. Canonical SPEC Payload

| Component                                     | Responsibility                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `plugin/skills/spec/SKILL.md`                 | Sole create/refine procedure with Agent Skills frontmatter (`name: spec`).                  |
| `plugin/skills/spec/templates/spec.md`        | Sole fallback technical SPEC scaffold adapted from the migration inputs.                    |
| `plugin/capabilities/spec.json`               | Schema, version, modes, canonical paths/hashes/modes, hosts, scopes, and exact invocations. |
| `plugin/hosts/opencode/agents/spec-writer.md` | Thin subagent adapter delegating to `spec`; Markdown edits allowed, shell denied.           |
| `.opencode/agents/spec-writer.md`             | Byte-identical contributor-local copy of the distributed OpenCode adapter.                  |

The skill and template must express all normal authoring behavior directly. They may adapt ideas from `guidelines/docs/spec.md` and `guidelines/roles/em.md`, but neither canonical content nor any adapter, package manifest, documentation invocation, or installed file may point users or agents back to `guidelines/`.

### 6.2. SPEC Authoring Contract

| Concern          | Rule                                                                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Destination      | Explicit user path; then unambiguous repository convention; otherwise `specs/<feature-slug>/spec.md`, using descriptive lowercase ASCII kebab-case.                                |
| Existing file    | Creation never overwrites an existing destination without confirmation; targeted refinement preserves unaffected confirmed decisions and identifies consequential changes.         |
| Evidence         | Read only relevant PRD/equivalent requirements, existing SPEC, repository instructions, decisions, code, tests, configuration, and technical docs.                                 |
| Decision classes | Material statements are **Confirmed**, **Recommended**, or **Unresolved**; inference is never represented as confirmed fact.                                                       |
| Clarification    | Ask one grouped set only for undiscoverable gaps or conflicts that materially change architecture, interfaces, data, security, operations, testing, scope, or acceptance.          |
| External sources | Use host/user-approved research only when a material external fact affects the decision; cite it or leave the claim unresolved. No background network behavior.                    |
| Content          | Include TL;DR, meta, context, drivers, current state, viable options/comparison, selected solution/components, consequences, TDD strategy, DoD, rejected alternatives, references. |
| Presentation     | Prefer tables and tight bullets, make the selected option explicit, and place useful `file:line` evidence in tables or references rather than every clause.                        |
| Write boundary   | Edit only the agreed SPEC; do not modify application code, create implementation plans or task DAGs, or invoke/manage beads.                                                       |
| Completion       | Validate the document, then report path, concise result, and unresolved decisions (`none` when empty).                                                                             |

The bundled template uses the sections above in the order established by this repository's SPEC convention. Repository-specific universal checks are discovered from available scripts and instructions; the writer must not copy unavailable commands or compliance files into another repository. RED-GREEN-REFACTOR remains explicit, with unit and integration boundaries selected for the proposed solution.

### 6.3. Capability Registry and Bundle Planning

Introduce one ordered internal registry for `prd` and `spec`. Each descriptor resolves its manifest, canonical files, copied-host destination directory, OpenCode adapter when applicable, and invocation. Static validation rejects duplicate names, paths, adapters, or invocations and requires every capability version to equal the plugin/package release version.

For OpenCode and Codex, `resourcePlan` flattens the registry into a fixed ordered allowlist:

1. PRD skill and template.
2. SPEC skill and template.
3. OpenCode PRD and SPEC adapters when the host is OpenCode.

For Claude Code, `plugin/.claude-plugin/plugin.json` continues to discover `./skills/`; no wrapper or extra plugin is added. For Pi, root `package.json` declares `./plugin/skills/prd` and `./plugin/skills/spec` in that order. Release assembly includes both manifests, both canonical directories, and both OpenCode adapters.

The public CLI remains:

```text
kona <install|update|verify|disable|enable|remove> --host <opencode|codex|claude|pi> --scope <project|user|local>
```

There is no `--capability` flag. One operation installs, verifies, updates, disables, enables, or removes both authoring capabilities at the selected scope. Existing `details.invocation` remains the PRD invocation for response compatibility; a new `details.invocations` object reports both `prd` and `spec` invocations.

### 6.4. Copied-Host Lifecycle

OpenCode and Codex retain the current protected-state, fixed-allowlist, hash ownership, backup, transaction, recovery, and one-active-scope behavior. The allowlist expands only to registry-derived canonical files and adapters.

OpenCode native verification must prove both subagents and both canonical skills resolve from the selected scope. Codex verification must prove both skills resolve from their expected paths and share the expected enabled state. The bounded disabled Codex block contains one `[[skills.config]]` entry for each installed skill between one pair of Kona-owned markers; unrelated TOML remains byte-identical.

Install remains idempotent only when the current bundle version, complete resource set, hashes, state, and native discovery match. A PRD-only schema-v1 install is not reported as current by a newer binary.

### 6.5. Ownership Schema Migration

New copied-host state uses schema 2:

```json
{
  "schema": 2,
  "bundle": "authoring",
  "capabilities": ["prd", "spec"],
  "version": "<release-version>",
  "host": "opencode|codex",
  "scope": "project|user",
  "state": "active|disabled",
  "paths": [],
  "resources": [],
  "backups": []
}
```

Claude and Pi native manifests use the same schema/bundle/capabilities identity while retaining their validated native package identity. `capabilities` order is fixed and duplicates or unknown names invalidate state.

Schema-v1 compatibility is narrowly defined because `0.1.1` ownership manifests are persisted user data:

| Operation | Schema-v1 behavior                                                                                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify`  | Validate the legacy fixed PRD allowlist, owned bytes/backups, and PRD native discovery, then return `UPDATE_REQUIRED`; never claim SPEC is installed.                 |
| `install` | Validate legacy state and return `UPDATE_REQUIRED`; do not silently mutate an existing installation.                                                                  |
| `update`  | Require active state, validate legacy ownership and backups, transactionally add SPEC resources/update PRD resources, verify both capabilities, then commit schema 2. |
| `disable` | Preserve existing legacy behavior and state shape so an old binary can still inspect it.                                                                              |
| `enable`  | Preserve existing legacy behavior and verify only the PRD surface recorded by that state.                                                                             |
| `remove`  | Remove/restore only the legacy recorded PRD resources and native package identity.                                                                                    |

No generic schema converter runs before ownership validation. Unknown or newer schemas remain hard failures. Migration failure rolls back all files and retains the schema-v1 manifest; confirmed legacy replacement backups remain authoritative.

### 6.6. Native Package Hosts

Claude and Pi install one package containing both skills, so their native mutation commands and approval flow do not change. Native verification changes from one-command discovery to exact discovery of both expected commands at the selected scope. Extra unrelated commands are ignored; a missing, duplicate, wrong-scope, or wrong-source PRD/SPEC command fails verification.

Updating a schema-v1 Claude or Pi installation invokes the existing native update operation, confirms the installed package version, verifies both commands, and then commits schema 2. Disable, enable, and removal continue to act on the Kona package as a whole. Pi configuration instructions refer to the Kona package rather than telling users to toggle one skill independently.

### 6.7. Build, Validation, and Documentation

| Surface                          | Required change                                                                                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin/scripts/contracts.mjs`   | Iterate both manifests; validate hashes, frontmatter, templates, adapters, invocations, Pi roots, self-containment, and aligned versions.                |
| `plugin/scripts/release-lib.mjs` | Include both manifests/payloads/adapters in deterministic path order and in the internal archive manifest.                                               |
| Contract tests                   | Add SPEC content/write-boundary tests and generalize manifest/adapter payload tests over both capabilities.                                              |
| Lifecycle fixtures               | Assert both resources and invocations across all scopes, migration from schema 1, complete disable/enable/remove, rollback, and unrelated-file canaries. |
| Root and plugin READMEs          | Present PRD and SPEC invocations, installed roots, bundle lifecycle, migration/update behavior, and no-`guidelines/` boundary.                           |
| Release workflow                 | Trigger on this SPEC directory and require all existing pinned hosts with no release-validation skips.                                                   |

Static self-containment checks scan canonical skills, templates, adapters, manifests, release payloads, and installed fixtures for any `guidelines/` path. This prohibition does not apply to design-history references in this PRD/SPEC.

### 6.8. Pros, Cons, and Consequences

- **Pros:** One method per document type, one lifecycle operation, native host discovery, exact payload parity, no second package, and safe migration of shipped ownership state.
- **Cons:** Lifecycle validation becomes multi-capability; schema migration and Codex disabled-state handling add test surface; users cannot install only one writer.
- **Consequences:** Adding another bundled capability later requires a manifest, registry entry, migration decision, native discovery contract, and full bundle regression suite. A changed canonical file requires a release version and explicit update for copied hosts.

## 7. Testing Strategy

Implementation follows RED-GREEN-REFACTOR. Tests use isolated homes and repositories and never mutate developer host configuration.

### 7.1. Test Layers

| Layer                    | Required coverage                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SPEC contract            | Frontmatter, create/refine behavior, destination precedence, evidence classes, option quality, required sections, TDD/DoD, validation, and SPEC-only writes. |
| Self-containment         | Positive bundled-template resolution plus negative controls for any `guidelines/` path in source, archive, copied install, or adapter.                       |
| Capability registry      | Stable order, aligned versions, exact hashes/modes, unique names/paths/invocations, both Pi roots, and complete release files.                               |
| Adapter payload parity   | Every distributed and installed host resolves byte-identical canonical PRD and SPEC payloads and exact host contracts.                                       |
| Copied lifecycle         | OpenCode/Codex all scopes, both discoveries, idempotence, conflicts, backups, tamper refusal, disable/enable/remove, rollback, and canaries.                 |
| Schema migration         | Active schema-v1 update success; install/verify update-required; legacy disable/enable/remove; malformed state refusal; failure rollback to exact v1 bytes.  |
| Native package lifecycle | Claude all scopes and Pi project/user discover both commands through install/update/verify/disable/enable/remove and preserve package identity.              |
| Non-regression           | Existing PRD contracts, invocations, output compatibility, workflow baseline, installer, marketplace, release reproducibility, and privacy checks.           |

### 7.2. Acceptance Traceability

| PRD acceptance criteria | Verification                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1-AC8                 | SPEC contract tests plus real-model create/refine fixtures covering paths, evidence, questions, structure, refinement, and external-claim handling.             |
| AC9                     | Static and installed-payload scans reject `guidelines/`; clean fixture dogfood runs without a Kona checkout.                                                    |
| AC10-AC11               | All-host/scope native discovery and lifecycle matrices verify both writers while authored documents and unrelated files remain byte-identical.                  |
| AC12                    | Build/static/payload/negative/lifecycle/pinned-host suites gate release.                                                                                        |
| AC13-AC14               | Real-model all-host dogfood records semantic review and write scope; negative prompts prove no implementation, task planning, or beads output outside the SPEC. |
| AC15                    | Existing PRD, workflow, marketplace, Pi package, installer, and lifecycle suites remain green; schema-v1 migration fixtures cover shipped state.                |

Automated adapter tests prove payload and contract parity, not model-output equivalence. Before release, run one create and one targeted-refinement prompt through each pinned host with a real model; record host/model versions, prompts, output paths, unresolved decisions, semantic review, and changed files.

## 8. Definition of Done

### Universal

- [ ] Tests pass: `bun run test`.
- [ ] TypeScript passes: `bun run typecheck`.
- [ ] Lint passes: `bun run lint`.
- [ ] Formatting passes: `bun run format:check`.
- [ ] This SPEC reflects the implementation.
- [ ] The local one-way-door review is updated for ownership schema migration and expanded managed resources.

### Feature-Specific

- [ ] Canonical `spec` skill/template and `spec.json` exist, are hashed, version-aligned, and contain no `guidelines/` reference.
- [ ] OpenCode has byte-identical thin distributed/contributor SPEC adapters with Markdown-only edit permission and shell denied.
- [ ] One lifecycle operation manages both skills at every supported host/scope; no new public verb or capability selector exists.
- [ ] OpenCode, Codex, Claude Code, and Pi native verification reports both exact invocations.
- [ ] Schema-v1 PRD-only install/verify/update/disable/enable/remove behavior matches §6.5, including exact rollback on migration failure.
- [ ] Schema-v2 manifests strictly bind the ordered capability set and complete fixed resource allowlist.
- [ ] Codex disable/enable controls both skill entries in one bounded Kona block and preserves unrelated TOML bytes.
- [ ] Root Pi metadata, Claude discovery, release archive, installer, and public documentation include both canonical skills.
- [ ] `bun run plugin:build`, `bun run plugin:validate`, and `bun run test:plugin` pass with both-capability and existing PRD/workflow coverage.
- [ ] Pinned-host release CI has no skip and real-model create/refine dogfood is recorded for all four hosts.
- [ ] Authored PRDs, authored SPECs, unrelated configuration, and confirmed replacement backups survive lifecycle and injected-failure tests unchanged.

## 9. Alternatives Not Chosen

| Alternative                                      | Why rejected                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Copy `guidelines/docs/spec.md` at runtime        | Installed destinations may not contain it and the PRD explicitly forbids the dependency.        |
| Make `spec-writer` invoke the PRD writer         | Product and technical documents have different evidence, decision, structure, and safety rules. |
| Add SPEC prose to every host adapter             | Creates four behavioral sources and invalidates exact canonical parity.                         |
| Keep schema 1 and label the bundle `prd`         | Misrepresents owned resources and cannot prove which capabilities an installation contains.     |
| Automatically migrate during `verify` or install | Makes nominally read-only/idempotent operations mutate persisted user state.                    |
| Remove support for schema-v1 state               | Existing `0.1.1` ownership manifests and backups are persisted and require safe lifecycle.      |
| Install only SPEC files into existing state      | Produces partially owned resources that cannot be safely disabled, restored, or removed.        |

## 10. References

| Reference                                             | Relevance                                                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [Approved PRD](./prd.md)                              | Product scope, platform requirements, safety boundaries, and acceptance criteria.                    |
| `specs/portable-prd-agent-plugin/spec.md:43-212`      | Existing canonical packaging, host, lifecycle, release, and ownership decisions to preserve.         |
| `plugin/skills/prd/SKILL.md:16-109`                   | Existing self-contained create/refine procedure pattern.                                             |
| `plugin/capabilities/prd.json:1-35`                   | Capability manifest schema, supported hosts/scopes, and PRD invocations.                             |
| `plugin/lib/plugin-lifecycle.mjs:130-175,470-534`     | PRD-specific resource planning, Codex config, and ownership validation to generalize.                |
| `plugin/lib/plugin-lifecycle.mjs:2044-2324`           | Existing update, ownership, transaction, operation-details, and copied-host dispatch behavior.       |
| `plugin/scripts/contracts.mjs:14-173`                 | Current static canonical, packaging, privacy, and workflow non-regression gates.                     |
| `plugin/scripts/release-lib.mjs:7-15,68-142`          | Explicit release payload and deterministic archive assembly.                                         |
| `plugin/test/prd-contract.test.ts:31-149`             | Canonical procedure, bundled-template, self-containment, thin-adapter, and local-copy test model.    |
| `plugin/test/adapter-payload-contract.node.mjs:39-87` | Distributed/installed exact-payload parity and negative controls.                                    |
| `package.json:5-12`                                   | Current Pi package discovery metadata that must include both skills.                                 |
| `guidelines/docs/spec.md:1-124`                       | One-time migration input for SPEC content; never a runtime or installed dependency.                  |
| `guidelines/roles/em.md:9-30`                         | One-time input for grounding and unknown resolution; beads/task decomposition is expressly excluded. |

No blocking technical question remains. The PRD and SPEC are approved for implementation.
