# Portable Copy-Writing Capability Technical Specification

## 0. TL;DR

- **SPEC status: Approved.** The sibling [PRD](./prd.md) is Approved.
- Add `copy` to the single Kona lifecycle bundle; do not add a capability selector.
- Keep one canonical payload at `plugin/skills/copy/`: the procedure plus two small progressively loaded references, with no output template or fallback draft path.
- Add a typed `copy` capability manifest and generalize discovery, lifecycle, release, and tests across all capability manifests while keeping `workflow-baseline` separate.
- OpenCode and Codex install or transition the complete copy+PRD+SPEC bundle atomically. Claude Code and Pi retain native package-level lifecycle.
- Migrate valid active schema-v1 PRD-only and released schema-v2 PRD+SPEC ownership to schema v3 only during explicit update under the existing lock, journal, backup, and rollback protections; never adopt copy files implicitly.
- Normal authoring is offline, with no background networking, analytics, or telemetry. Source validation is local, proportionate, and approval-gated.

## 1. Meta Information

| Field       | Value                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------ |
| SPEC status | Approved                                                                                         |
| PRD         | [Portable Copy-Writing Capability PRD](./prd.md), Approved                                       |
| Scope       | Copy behavior, bundle packaging/lifecycle migration, host integration, release, and verification |

## 2. Context and Current State

Kona v0.2.0 ships PRD and SPEC as portable capabilities. Their canonical payloads, manifests, and OpenCode adapters are independently integrity-bound and delivered as one bundle (`plugin/capabilities/prd.json`, `plugin/capabilities/spec.json`, `plugin/lib/capability-registry.mjs`). The OpenCode distribution adapters and contributor-local adapters are byte-identical thin delegates with Markdown-only edits and no shell access (`plugin/hosts/opencode/agents/prd-writer.md`, `plugin/hosts/opencode/agents/spec-writer.md`).

The root Pi package metadata discovers PRD and SPEC (`package.json:5-13`). Claude already discovers the whole `plugin/skills/` directory, so an added canonical skill needs no Claude wrapper (`plugin/.claude-plugin/plugin.json:11`). `workflow-baseline.json` is a typed baseline hash map, not a capability manifest (`plugin/capabilities/workflow-baseline.json:1-11`).

The lifecycle CLI exposes exactly `install`, `update`, `verify`, `disable`, `enable`, and `remove` with host and scope selection and no capability option (`plugin/bin/kona.mjs:5-20`). The implementation already uses an ordered PRD/SPEC registry for resource plans, source validation, discovery, release packaging, and schema-v2 bundle ownership (`plugin/lib/capability-registry.mjs`, `plugin/lib/plugin-lifecycle.mjs`). Copy extends that registry and advances ownership to schema v3 rather than introducing a parallel lifecycle.

Existing safety machinery includes fixed target boundaries, protected state, ownership hashes, replacement backups, a host-wide lock, transaction preimages/journals, one-active-scope checks, drift refusal, and rollback (`plugin/lib/plugin-lifecycle.mjs`). Release enumeration, static contracts, and adapter parity already cover PRD and SPEC through the shared registry (`plugin/scripts/release-lib.mjs`, `plugin/scripts/contracts.mjs`, `plugin/test/support/host-adapter-harness.mjs`).

The approved change adds copy without changing the existing PRD or SPEC payloads or workflow resources. Package-level disable and remove intentionally affect all three portable capabilities.

## 3. Technical Drivers

| Driver                 | Required property                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| One behavior source    | Adapters delegate; all distilled writing guidance ships under `plugin/skills/copy/`.                           |
| Bundle semantics       | Every lifecycle verb addresses Kona at one host/scope, never an individual capability.                         |
| Source safety          | Explicit write scope, exact structural-token preservation, minimal diffs, and honest validation reporting.     |
| Conservative ownership | New copy resources are never inferred as owned; user content and project source are never lifecycle resources. |
| Determinism            | Stable manifest/resource order, exact hashes/bytes, aligned versions, and reproducible archives.               |
| Compatibility          | PRD bytes, invocations, workflow baseline, and public CLI shape do not regress.                                |
| Privacy                | No normal-authoring network access, background activity, analytics, or telemetry.                              |

## 4. Considered Options

| Option                                         | Benefit                              | Cost                                                  | Decision   |
| ---------------------------------------------- | ------------------------------------ | ----------------------------------------------------- | ---------- |
| Independent copy lifecycle or `--capability`   | Isolated rollout                     | Contradicts package lifecycle and permits split state | Reject     |
| One combined capability manifest               | Simple bundle read                   | Loses capability-level identity and integrity         | Reject     |
| Per-capability manifests plus bundle state     | Auditable payloads and one lifecycle | Requires iterator and schema-v3 migration             | **Select** |
| Duplicate full procedures per host             | Host-local customization             | Drift and larger review surface                       | Reject     |
| Canonical skill plus native/owned distribution | One procedure with native discovery  | Copied hosts require managed updates                  | **Select** |

## 5. Selected Design

### 5.1. Canonical Copy Payload

Add these canonical files:

| Path                                                | Responsibility and loading boundary                                                                                                                                                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin/skills/copy/SKILL.md`                       | Agent Skills frontmatter, mode selection, context/precedence, write boundary, flow control, universal preservation rules, validation, failure, and final reporting. Always loaded.                                               |
| `plugin/skills/copy/references/style-and-safety.md` | Distilled voice, tone, accessibility, inclusion, localization readiness, claims, and review classification. Load before substantive generation, revision, or copy review; skip only when no wording is being authored or judged. |
| `plugin/skills/copy/references/components.md`       | Compact rules for UI, operational/support, error, notification, and marketing components. Load only for the applicable component/category.                                                                                       |

This is the complete runtime guidance. There is no output template because copy shape is component- and destination-dependent, and no generic draft path because conversation output is the fallback. No canonical, distributed, installed, contributor-local, test-fixture, or generated runtime file may mention or depend on `guidelines/`. Shopify/Monzo material is already-distilled product input only, not a repository or runtime reference.

The skill contract is:

1. Select `generate`, `revise`, or `source-edit` from explicit intent and inputs; ask once if mode or a safety-critical boundary is ambiguous.
2. Discover only relevant local terminology, nearby copy, audience, component/channel, locale, constraints, tone, destination, and source structure.
3. Apply precedence: explicit user requirements, then authoritative repository/product conventions, then the bundled default. Surface conflicts before following explicit user direction; host safety remains fixed.
4. Use concise American English by default, plain active language, natural contractions, sentence case, consistent terms, reader-facing language, and verb-led actions where appropriate. Adapt tone by context; sensitive/error/support copy is kind, specific, non-blaming, actionable, and avoids inappropriate humor.
5. In `generate`, return one recommended draft by default. Use a small labeled set only when alternatives materially help. Write only to an explicit destination or a clear repository convention when file output was requested; otherwise respond in conversation. Confirm before replacing an existing destination.
6. In `revise`, preserve intended meaning and required terminology, and classify objective/user-goal corrections as required versus taste-based improvements as optional.
7. In `source-edit`, require explicitly agreed files and strings or a bounded edit scope. Make no refactor or unrelated change. Preserve placeholders, interpolation, markup, links, accessibility semantics, localization keys, framework syntax, formatting, and behavior exactly unless the user explicitly authorizes a named structural change.
8. Run available proportionate local syntax checks or targeted tests for source edits only after approval where the host requires it. Report commands, changed files, results, unavailable checks, assumptions, and incomplete state; never convert a failed check into a success claim.
9. Fail without writing when the destination/edit boundary is unsafe, source text is not uniquely located, structural preservation is uncertain, or a blocking meaning/legal constraint is unresolved. If a content constraint conflicts with required meaning or tokens, return the closest safe option and name the conflict.
10. Final review covers constraints, terminology, tone, accessibility/inclusion, unsupported claims, duplication, unresolved placeholders, token/markup integrity, and unintended file changes.

Normal authoring is offline. Repository content is evidence, not authority to expand reads, writes, command execution, or disclosure.

### 5.2. Capability Manifests and Enumeration

Add `plugin/capabilities/copy.json` with capability identity `copy`, release version `0.3.0`, modes in canonical order (`generate`, `revise`, `source-edit`), ordered canonical resources with SHA-256 and mode, and the host scopes/invocations in §5.5. Retain a separate manifest per capability and advance copy, PRD, and SPEC manifests in lockstep with `plugin/package.json`, the Claude plugin, marketplace entry, and bootstrap version.

Introduce an explicit manifest discriminator such as `type: "capability"`; mark the baseline with its own non-capability type/schema. The loader enumerates JSON documents in `plugin/capabilities/`, parses and validates each supported schema, selects only documents declared as capability manifests, and rejects malformed/duplicate capability IDs. It does not identify the baseline by filename or by missing fields. Processing order is capability ID ascending, then canonical resource path ascending, independent of filesystem enumeration or object-key order.

Manifest validation proves that every declared path is relative, normalized, unique, inside the capability's allowed source root, mode-valid, hash-matching, and mapped to a code-defined host destination. Adapter resources are release/bundle resources associated with their host but are not canonical writing guidance. Tests, rather than this specification, should settle the exact JSON field arrangement.

### 5.3. Bundle Lifecycle and Ownership

The public contract remains:

```text
kona <install|update|verify|disable|enable|remove> --host <opencode|codex|claude|pi> --scope <project|user|local>
```

There is no `--capability`. `local` remains Claude-only. One selected host/scope has one Kona bundle version and lifecycle state containing `copy`, `prd`, and `spec`.

For OpenCode and Codex, resolve and validate all manifests and source hashes before inspecting destinations. Build one deterministic resource plan for all skills and OpenCode adapters, acquire the existing host lock, then perform conflict checks, backups, writes/config changes, ownership-state replacement, native discovery, and commit as one journaled transaction. Any failure restores the complete pre-operation bundle. Disable, enable, and remove likewise transition all bundled resources together. Codex uses one bounded Kona bundle block containing the configuration needed for every bundled skill, not one block per capability.

For Claude and Pi, the native package is the lifecycle unit and already contains all canonical skills. Kona displays exact argv plans, requires approval for mutation, invokes native package lifecycle, and verifies package plus per-capability discovery. It must not claim that an external package manager transaction is filesystem-atomic.

`verify` reports bundle version/state and, for each capability in deterministic ID order, invocation, native discovery, and canonical plus state-appropriate installed/disabled integrity. Missing or divergent members make bundle verification fail; there is no healthy partial bundle. Where a host does not enumerate skills directly, verification combines its native package listing with integrity-backed inspection of the exact installed package identified by that listing; a hard-coded invocation or source-tree file check alone is insufficient.

Ownership schema v3 identifies the Kona package/bundle, bundle version, included capability IDs/versions, exact owned resources and hashes/modes, replacement backups, managed configuration, native package identity, host/scope/state, and applicable project identity. Code-defined allowlists remain authoritative over serialized paths. Existing project files, authored copy, authored PRDs/SPECs, and other user content are never lifecycle-owned.

### 5.4. Schema-v1/v2 to Schema-v3 Migration

Only an explicit `update` may perform the one-way migration at the selected host/scope. `install` and `verify` detect valid schema-v1 or schema-v2 state and return an update-required result without mutation. A disabled legacy installation must be enabled and verified under its existing schema before it can be updated. Under the host lock and before any schema-v3 mutation:

1. Accept only a valid schema-v1 `0.1.1` PRD ownership record or released schema-v2 `0.2.0` PRD+SPEC record matching the current host/scope/project and its known path set/native identity.
2. Validate every legacy-owned byte, mode, managed block, backup record, and backup byte using the old manifest's recorded hashes. Reject drift, malformed state, version skew, ambiguity, unsupported versions, or unsafe paths.
3. Resolve the new bundle manifests and deterministic resource plan. Preserve existing legacy backups exactly in the v3 record.
4. Treat every copy destination as unowned and never infer ownership from matching content. An occupied destination requires the existing digest-bound replacement consent and verified backup before mutation.
5. Journal all old/new resources, configuration, backups, and ownership state before change. Transition copy and rewrite state as one v3 transaction; rollback restores the valid v1 or v2 installation and all preimages.
6. After commit, verify bundle and per-capability discovery/integrity. `verify` remains observational and reports that update is required when it encounters valid legacy state.

Schema v3 is never downgraded. Older binaries reject a manifest whose schema differs from their supported schema before mutation; retain and test that fail-closed behavior. Migration journals must be recoverable by the new binary, and uncertain recovery retains evidence and reports partial state rather than claiming success.

### 5.5. Host Contracts

| Host        | Scopes               | Invocation             | Distribution contract                                                                                                                                               |
| ----------- | -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode    | project, user        | `@copy-writer <brief>` | Owned copies at the existing skill/agent roots, adding `skills/copy/` and `agents/copy-writer.md`; install copy, PRD, and SPEC payloads/adapters atomically.        |
| Codex       | project, user        | `$copy <brief>`        | Owned canonical skill copies under the existing `.agents/skills/` roots; one managed Kona bundle block controls all three skills.                                   |
| Claude Code | project, local, user | `/kona:copy <brief>`   | Native `kona` package; verify native package identity/state, then integrity-check the listed installation's declared `skills/` payload to establish copy discovery. |
| Pi          | project, user        | `/skill:copy <brief>`  | Native repository package; root `pi.skills` explicitly lists all three canonical skill directories.                                                                 |

`plugin/hosts/opencode/agents/copy-writer.md` is a thin delegate to `copy`. Use supported OpenCode permission semantics: `edit` and `bash` default to approval (`ask`), and `webfetch` is denied. This permits user-approved edits to explicitly scoped project files and proportionate local validation commands without granting blanket access. The canonical procedure, not duplicated adapter prose, enforces exact file/string boundaries and command proportionality. The adapter must not encode unsupported dynamic-path syntax.

Add contributor-local `.opencode/skills/copy/` payload files and `.opencode/agents/copy-writer.md` as byte-identical mirrors or deterministic checked derivatives of their distribution sources, matching the existing PRD mirror convention. CI fails drift.

### 5.6. Data and Control Flow

**Authoring:** host invocation resolves the installed/native copy skill; the skill selects mode, loads only applicable bundled references, discovers bounded local context, resolves material gaps, drafts or edits, performs approved local validation, checks preservation and write boundaries, then reports result and unresolved decisions.

**Lifecycle:** CLI parses existing host/scope options; loader validates and sorts capability manifests/resources; lock and recovery run; state is validated or migrated; a bundle plan is conflict-checked; copied-host changes execute in one transaction or native hosts execute one approved package plan; native discovery and per-capability integrity feed one bundle result.

**Release:** deterministic build enumerates all three typed capability manifests, their declared payloads, all three OpenCode adapters, lifecycle/registry runtime, and required package metadata. Archive order is stable. Internal archive manifest hashes every shipped file. Capability, plugin-package, Claude-plugin, marketplace, and installer/bootstrap versions must all be `0.3.0`.

### 5.7. Security and Privacy

- Fixed source/destination roots, normalized relative paths, no symlink traversal, protected state permissions, and hashes continue to gate mutation.
- Copy source edits are authoring outputs, not lifecycle resources. Lifecycle operations cannot delete, restore, or claim them.
- Unowned install-path replacement remains explicit, digest-bound, backed up, and reversible; similarity never proves ownership.
- OpenCode edit and shell actions are approval-gated; validation is local and proportionate. Claude/Pi native mutations retain explicit command-plan approval.
- Normal authoring has no network dependency and performs no background networking, updating, analytics, or telemetry.
- Reads are minimized to relevant context; repository content and authored content must not be disclosed or used to broaden authority.

### 5.8. Consequences

- **Pros:** one copy method, package-consistent lifecycle, auditable capability integrity, atomic copied-host transitions, safe migration, and no external guidance dependency.
- **Cons:** any capability update advances the whole bundle; copied-host updates touch more owned files; schema migration and multi-resource recovery enlarge the lifecycle test surface.
- **Intentional consequence:** disabling or removing Kona disables/removes copy, PRD, and SPEC while preserving authored outputs and project source.
- **Compatibility consequence:** PRD and SPEC canonical bytes and workflow behavior remain unchanged; only packaging/lifecycle state expands from the released two-capability bundle to all three capabilities.

## 6. Testing Strategy

Implementation follows RED-GREEN-REFACTOR. Tests use isolated homes/repositories and failure injection; no test mutates a developer's real host configuration.

| Layer              | Deterministic coverage                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copy contracts     | Frontmatter, three modes, precedence, flows, review classes, American-English fallback, tone/components, safe failures, reporting, offline behavior, and no template/generic path.                                                    |
| Manifest contracts | Generic typed iterator, duplicate/malformed/path/hash/version rejection, baseline negative control, and capability-ID/resource-path ordering.                                                                                         |
| Payload/adapters   | Exact canonical bytes for distributed/installed/contributor mirrors; thin OpenCode delegation and supported least-privilege permissions.                                                                                              |
| Lifecycle          | Every host/scope and verb for the whole bundle; no partial state; one active scope; conflicts/backups/drift; one Codex block; update-only v1/v2-to-v3 success/refusal/crash recovery; disabled-legacy refusal; old-binary v3 refusal. |
| Copy safety        | Write-boundary fixtures, existing-destination refusal, ambiguity/no-write cases, exact placeholder/interpolation/markup/link/a11y/localization-key preservation, minimal diffs, and validation-result reporting.                      |
| Native/package     | Root Pi metadata discovers all three skills; Claude package discovers all three; every invocation and enabled/disabled state is verified natively without model calls.                                                                |
| Release/installer  | Both manifests/payloads/adapter in exact archive, lockstep versions, deterministic rebuild, checksums/internal manifest, missing/corrupt member rejection, and install/update corruption rollback.                                    |
| Self-containment   | Recursive scan of canonical, mirrored, generated, staged, fixture, and archive content for any `guidelines/` dependency.                                                                                                              |
| Non-regression     | Existing `prd-contract.test.ts`, workflow baseline hashes, PRD payload/invocations, lifecycle behavior, and release safety continue to pass.                                                                                          |

Extend the existing suites rather than create disconnected assurance: `prd-contract.test.ts`, `manifest-contract.test.ts`, `adapter-payload-contract.node.mjs`, `support/host-adapter-harness.mjs`, `static-contract.node.mjs`, `plugin-lifecycle.node.mjs`, `host-validation.node.mjs`, `release-installer.node.mjs`, `acceptance-traceability.node.mjs`, `ac-traceability.json`, and `DOGFOOD.md` already provide the corresponding seams (`plugin/test/acceptance-traceability.node.mjs:6-25`, `plugin/test/DOGFOOD.md:1-35`).

Static regexes, hashes, fixture outputs, and adapter loading are deterministic contracts, not semantic parity. Before release, run shared generate, revise, and source-edit fixtures through real models on OpenCode, Codex, Claude Code, and Pi. Record host/model versions, prompts, resolved payload, outputs/diffs, commands and approvals, validation results, and a human semantic assessment against the same rubric. All twelve host-mode runs are required; absence or failure blocks release.

### 6.1. PRD Acceptance Traceability

| PRD AC | Design and required evidence                                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AC1    | Bundled-reference resolver and recursive no-guidelines scan; real-model clean-repository generate on four hosts.                                             |
| AC2    | Precedence fixtures with conflicting user/repository/default input; semantic review rejects affiliation or imported product terms.                           |
| AC3    | Generate contract fixtures plus four-host dogfood assess American English, concision, sentence case, active language, terminology, and action.               |
| AC4    | Destination/no-write fixture proves conversation fallback and absence of a generic path.                                                                     |
| AC5    | Revise fixtures and dogfood prove meaning/terminology preservation and required-versus-optional classification.                                              |
| AC6    | Sensitive/error fixtures and semantic rubric cover specificity, blame, recovery, kindness, humor, and apology.                                               |
| AC7    | Constraint matrix checks component, length, punctuation, capitalization, terminology, and explicit conflict reporting.                                       |
| AC8    | Alternative-request fixtures prove bounded labeled variants and one recommendation; default fixture proves one output.                                       |
| AC9    | Source-edit filesystem fixtures compare allowed locations, unrelated bytes, formatting/syntax, and behavior-focused checks.                                  |
| AC10   | Tokenized fixtures assert byte-exact placeholders, interpolation, markup, links, accessibility semantics, and localization keys.                             |
| AC11   | Existing-destination fixture proves no write before explicit overwrite/revision consent.                                                                     |
| AC12   | Accessibility/inclusion/link/locale fixtures plus semantic review; exact locale formatting remains product-owned.                                            |
| AC13   | Discovery/question fixtures prove local facts are not re-asked, one grouped question set, blocking pause, and stated assumptions.                            |
| AC14   | Approval and command-capture fixtures prove proportionate targeted validation and accurate success/failure reporting.                                        |
| AC15   | Manifest hash/exact-byte checks and recursive scans cover canonical, mirror, installed, staged, and archived payloads.                                       |
| AC16   | Bundle install/verify matrix covers OpenCode/Codex project/user, Claude project/local/user, Pi project/user, native discovery, and one active scope.         |
| AC17   | Bundle update/disable/enable/remove, v1/v2-to-v3, restoration, canary, and recovery matrices prove all-capability transitions and user-content preservation. |
| AC18   | Deterministic contracts establish shared inputs/boundaries; required four-host real-model runs establish semantic outcomes without claiming exact wording.   |
| AC19   | Existing PRD, workflow-baseline, host, lifecycle, payload, and release suites remain mandatory and unchanged in behavioral expectation.                      |

## 7. Definition of Done

- [ ] `plugin/skills/copy/` contains the self-contained procedure and only the two justified references; no output template or generic destination exists.
- [ ] `copy.json` and typed manifest iteration validate all capabilities deterministically and exclude the workflow baseline by type/schema.
- [ ] Existing lifecycle commands manage the entire bundle with no capability selector; copied-host transitions and explicit-update v1/v2-to-v3 migration are atomic and recoverable.
- [ ] Schema v3 preserves proven v1/v2 ownership and backups, never adopts copy resources, and causes older binaries to refuse mutation.
- [ ] OpenCode, Codex, Claude Code, and Pi discover all three capabilities at the selected scope and report bundle plus per-capability health.
- [ ] OpenCode copy permissions are approval-gated and the canonical source-edit boundary is tested; one Codex block controls the bundle.
- [ ] Root Pi metadata, Claude/package/marketplace metadata, capability manifests, release package, and bootstrap versions are in lockstep.
- [ ] Release archives include all three manifests, canonical payloads, and OpenCode adapters and rebuild byte-for-byte deterministically.
- [ ] Recursive scans find no distributed/runtime dependency on `guidelines/`; normal authoring is offline with no telemetry or background networking.
- [ ] PRD payload behavior, invocations, lifecycle expectations, and workflow-baseline hashes do not regress.
- [ ] `bun run plugin:build`, `bun run plugin:validate`, `bun run test:plugin`, `bun run test`, `bun run typecheck`, `bun run lint`, `bun run knip`, and `bun run format:check` pass (`package.json:19-35`).
- [ ] Real-model generate/revise/source-edit evidence passes shared fixtures on all four hosts and is clearly labeled manual semantic evidence.
- [ ] Documentation states that package-level disable/remove affects the whole Kona bundle and that authored content/project files are never lifecycle-owned.

## 8. Alternatives Rejected

| Alternative                                           | Reason                                                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `--capability copy` or independent state              | Breaks the approved package-level lifecycle and permits inconsistent partial activation. |
| Implicitly adopt matching copy files during migration | Matching bytes do not establish ownership or restoration rights.                         |
| Keep schema v1 and overload `capability: prd`         | Misrepresents bundle identity and cannot safely describe multiple capability resources.  |
| Separate Codex managed blocks                         | Allows split enablement and complicates atomic rollback.                                 |
| Full copy procedure in the OpenCode adapter           | Duplicates behavior and creates host drift.                                              |
| Broad pre-approved edit/shell permissions             | Exceeds least privilege for arbitrary project files and validation commands.             |
| Copy output template or fallback file path            | Copy shapes vary, and the approved fallback is conversation output.                      |
| Static tests labeled semantic parity                  | Regex/hash checks cannot establish model behavior or output quality.                     |

## 9. References

| Reference                                                                     | Relevance                                                                           |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [Approved copy PRD](./prd.md)                                                 | Product scope, behavior, bundle decision, and AC1-AC19.                             |
| [Approved PRD capability specification](../portable-prd-agent-plugin/spec.md) | Existing architecture and technical-depth precedent.                                |
| `plugin/capabilities/prd.json:1-35`                                           | Current per-capability manifest shape and host contracts.                           |
| `plugin/capabilities/workflow-baseline.json:1-10`                             | Distinct workflow integrity baseline.                                               |
| `plugin/lib/plugin-lifecycle.mjs:9-24`                                        | Current verbs, host scopes, native identities, and schema version.                  |
| `plugin/lib/plugin-lifecycle.mjs:2051-2332`                                   | Current copied-host ownership, transaction, lifecycle, and reporting flow.          |
| `plugin/scripts/release-lib.mjs`                                              | Registry-derived deterministic release allowlist and version alignment.             |
| `plugin/scripts/contracts.mjs`                                                | Multi-capability manifest, package, Pi, Claude, and marketplace contracts.          |
| `package.json:19-35`                                                          | Existing build, validation, test, and repository quality commands.                  |
| [OpenCode agent permissions](https://opencode.ai/docs/agents/)                | Supported agent-frontmatter `ask`/allow/deny permission model and command patterns. |

## 10. Open Questions

No product decision is blocking. The schema-v3 field names/journal encoding and final pinned host/model versions for release evidence are implementation-time technical decisions; tests must lock them before release without weakening the invariants in this specification.
