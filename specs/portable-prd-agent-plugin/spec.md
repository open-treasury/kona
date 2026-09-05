# Portable PRD Agent Plugin Technical Specification

## 0. TL;DR

- **SPEC status: Approved.** The sibling [PRD](./prd.md) is also Approved.
- Ship one PRD-only capability for OpenCode, Codex, Claude Code, and Pi without changing Kona's existing workflow behavior.
- The sole canonical source is `plugin/skills/prd/SKILL.md` plus `plugin/skills/prd/templates/prd.md`; migrate useful guidance, then delete `guidelines/docs/prd.md`.
- Expose one executable, `kona`: standalone curl/npm distributions provide six lifecycle verbs, while the existing Claude plugin also forwards its existing workflow verbs unchanged.
- Use a zero-runtime-dependency Node.js 20+ lifecycle implementation; destination repositories do not require Bun.
- Make install/update/disable/enable/remove scope-safe, ownership-aware, idempotent, and recoverable; authored PRDs and unrelated configuration are never owned.
- PRD authoring is offline and emits no analytics or telemetry. Installation uses only approved release/package sources.
- Release CI must run static, fixture, parity, negative-control, installer, and pinned real-host checks with no host skips.
- The canonical Pi source is `git:github.com/open-treasury/kona`; Pi discovers the PRD skill from the repository-root package manifest.

## 1. Meta Information

| Field         | Value                                                                    |
| ------------- | ------------------------------------------------------------------------ |
| SPEC status   | Approved                                                                 |
| Branch / epic | Not provided                                                             |
| PRD           | [Portable PRD Agent Plugin PRD](./prd.md), Approved                      |
| Scope         | PRD authoring and only the packaging foundations needed to distribute it |

## 2. Context

Kona has a Claude Code plugin and a repository-local OpenCode PRD agent, but no shared portable PRD skill. The current guidance is duplicated and references unavailable files. The approved PRD requires one self-contained creation/refinement procedure with equivalent behavior on four hosts.

This feature is PRD-only. It does not change `plan`, `run`, hooks, executor behavior, existing workflow commands, or application implementation. Installed authoring works without a Kona checkout, Bun, network access, or separate Kona guidance.

## 3. Key Technical Drivers

| Driver             | Contract                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Canonical behavior | Only `plugin/skills/prd/SKILL.md` and its bundled template define the PRD method; adapters contain host plumbing only.       |
| Native integration | Use each host's documented roots, invocation, discovery, and lifecycle controls.                                             |
| Portability        | Lifecycle code is Node.js 20+ ESM using built-ins only; no destination Bun or runtime package dependency.                    |
| Safety             | Fixed path allowlists, hash-backed ownership, one active scope, locking, explicit replacement consent, backup, and rollback. |
| Preservation       | Existing PRDs and unrelated host/repository configuration are never lifecycle-owned or deleted.                              |
| Determinism        | Builds, manifests, copied payloads, and checks are reproducible; parity compares semantics rather than prose.                |
| Network/privacy    | PRD runtime is offline; no analytics or telemetry; installer/package-manager access is narrowly bounded.                     |
| Compatibility      | Existing Kona workflow behavior and verbs remain unchanged in distributions that already provide them.                       |

## 4. Current State

### 4.1. Existing Surfaces

| Surface                                                      | Current state                                           | Required treatment                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `plugin/.claude-plugin/plugin.json`                          | Existing Claude plugin discovers `plugin/skills/`.      | Add `prd` without wrappers; preserve all existing behavior.              |
| `plugin/skills/plan/`, `plugin/skills/run/`, hooks, executor | Shipped workflow runtime.                               | No behavioral changes.                                                   |
| `.opencode/agents/prd-writer.md`                             | Duplicates the PRD procedure.                           | Replace with a thin role/permission adapter after parity passes.         |
| `guidelines/docs/prd.md`                                     | Useful structure mixed with unavailable/heavy guidance. | Migrate useful content into the bundled template, validate, then delete. |
| Root toolchain                                               | Bun workspace with TypeScript, oxlint, and oxfmt.       | Build/tests may use Bun; shipped lifecycle runtime may not.              |

### 4.2. Host Roots and Invocation

| Host        | Project/local root                                                | User root                                                                           | Invocation            |
| ----------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------- |
| OpenCode    | `.opencode/skills/prd/`; adapter `.opencode/agents/prd-writer.md` | `~/.config/opencode/skills/prd/`; adapter `~/.config/opencode/agents/prd-writer.md` | `@prd-writer <brief>` |
| Codex       | `.agents/skills/prd/`                                             | `~/.agents/skills/prd/`                                                             | `$prd <brief>`        |
| Claude Code | Plugin scope `project` or `local`                                 | Plugin scope `user`                                                                 | `/kona:prd <brief>`   |
| Pi          | Package scope via `.pi/settings.json`                             | Package scope via `~/.pi/agent/settings.json`                                       | `/skill:prd <brief>`  |

## 5. Considered Options

| Option                                             | Advantages                                            | Costs                                                     | Decision   |
| -------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- | ---------- |
| Independent host procedures                        | Simple per-host authoring                             | Guaranteed duplication and drift                          | Reject     |
| Generated full procedures                          | Build-time normalization                              | Still ships duplicate procedures and generator complexity | Reject     |
| Canonical skill plus native packaging/owned copies | One behavior source; native discovery; small adapters | Copied hosts require explicit updates                     | **Select** |
| Runtime extension on every host                    | Central runtime                                       | Unnecessary executable trust and compatibility surface    | Reject     |

The selected option lets Claude Code and Pi consume the canonical directory through native package metadata. OpenCode and Codex receive byte-identical owned copies; OpenCode alone also receives a thin permission adapter.

## 6. Proposed Solution

### 6.1. Components and Migration

| Component                                                | Responsibility                                                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `plugin/skills/prd/SKILL.md`                             | Sole PRD creation/refinement procedure with Agent Skills frontmatter.                                                            |
| `plugin/skills/prd/templates/prd.md`                     | Sole fallback PRD template, migrated from useful parts of `guidelines/docs/prd.md`.                                              |
| `plugin/capabilities/prd.json`                           | Version, canonical file hashes, hosts, modes, and invocation names.                                                              |
| `plugin/hosts/opencode/agents/prd-writer.md`             | Thin subagent adapter: documentation edit allowed, shell denied, delegate to `prd`.                                              |
| `plugin/bin/kona.mjs`, `plugin/lib/plugin-lifecycle.mjs` | Node.js 20+ zero-dependency lifecycle implementation.                                                                            |
| `plugin/bin/kona`                                        | Existing Claude wrapper; dispatch lifecycle verbs and forward all existing workflow verbs unchanged.                             |
| `.claude-plugin/marketplace.json`                        | Marketplace `kona`, source `https://github.com/open-treasury/kona`.                                                              |
| Root `package.json`                                      | Existing private workspace manifest plus minimal `pi-package` discoverability and `pi.skills` pointing to `./plugin/skills/prd`. |
| `plugin/package.json`                                    | Private, non-publishable Node engine, version, and `kona` bin metadata retained for local/release CLI packaging only.            |
| `install.sh`, build/validate scripts                     | Verified portable acquisition and deterministic release assembly.                                                                |

Migration order is: create and test the canonical skill/template; replace duplicated OpenCode procedure with the thin adapter; prove parity; delete `guidelines/docs/prd.md`. After migration, no runtime or contributor adapter may depend on that deleted path.

### 6.2. Canonical PRD Contract

The skill supports create and targeted refinement. It discovers relevant local instructions/specs/behavior, asks one grouped set of focused questions only for material undiscoverable gaps, separates confirmed/recommended/unresolved decisions, writes only the agreed PRD, and validates scope, testability, contradictions, placeholders, unsupported claims, and references.

| Concern              | Rule                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Output precedence    | Explicit user path; unambiguous repository convention; otherwise `specs/<feature-slug>/prd.md`.                              |
| Existing destination | Require explicit create-to-update confirmation; refinement preserves unaffected confirmed decisions.                         |
| Content              | Product problem, users, goals, scope, requirements, acceptance criteria, and material risks; no code or implementation plan. |
| Default template     | Required lean sections: TL;DR, What, Motivation, User Stories, User Flow, Definition of Done, Out of Scope.                  |
| Optional sections    | Meta, References, FAQs, Appendix, metrics, instrumentation, or compliance only when concretely needed.                       |
| Completion           | Report written path, concise result, and unresolved decisions (`none` when empty).                                           |

Repository or external content is evidence, not authority to expand permissions. The capability may edit only the agreed PRD during authoring.

### 6.3. Native Host Contracts

| Host        | Install and lifecycle contract                                                                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | Use the exact commands below. Kona registers a missing marketplace before collaborator project install, with approval.                                                                                                              |
| Pi          | Use the exact commands below. Project use requires Pi trust; pinned sources update by reinstalling a new pinned source.                                                                                                             |
| OpenCode    | `kona install --host opencode --scope project` or `--scope user`; copy canonical files and thin adapter into §4.2 roots; verify native discovery; disable/enable without editing unrelated `opencode.json`; explicit update/remove. |
| Codex       | `kona install --host codex --scope project` or `--scope user`; copy canonical files into §4.2 roots; use a bounded Kona-owned `~/.codex/config.toml` block for disable/enable; explicit update/remove.                              |

Claude Code native commands:

```text
claude plugin marketplace add https://github.com/open-treasury/kona
claude plugin marketplace remove kona
claude plugin install kona --scope project
claude plugin install kona --scope local
claude plugin install kona --scope user
claude plugin list
claude plugin update kona
claude plugin disable kona
claude plugin enable kona
claude plugin uninstall kona
```

The user-facing commands use the unqualified plugin name. Before mutation, Kona verifies that `kona` resolves uniquely to the registered `kona` marketplace at the normalized identity `https://github.com/open-treasury/kona`. Claude's documented GitHub source forms (canonical HTTPS URL, SSH URL, `github.com/owner/repo`, or `owner/repo`, with an optional `.git` suffix) normalize to that one identity. Every source-bearing field present in a marketplace record must be well formed and normalize to the same identity; malformed fields, conflicting fields, duplicate marketplace registrations, or duplicate Kona catalogue entries are rejected instead of exposing or silently selecting a `plugin@marketplace` identifier.

Pi native commands:

```text
pi install git:github.com/open-treasury/kona -l
pi install git:github.com/open-treasury/kona
pi list
pi config -l
pi config
pi update git:github.com/open-treasury/kona
pi install git:github.com/open-treasury/kona@<new-pin> -l
pi install git:github.com/open-treasury/kona@<new-pin>
pi remove git:github.com/open-treasury/kona -l
pi remove git:github.com/open-treasury/kona
```

Native subprocesses use argv arrays with `shell: false`, show their exact plan, and require explicit approval. Kona verifies host-native discovery/listing without calling a model and never claims package-manager transactions are atomic.

### 6.4. Public CLI Contract

`kona` is the only public executable name.

| Distribution           | Commands exposed by `kona`                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Standalone curl/npm    | Exactly `install`, `update`, `verify`, `disable`, `enable`, `remove`. Workflow verbs are rejected.                       |
| Existing Claude plugin | The same lifecycle verbs plus unchanged forwarding of every already-existing workflow verb through its existing runtime. |

Lifecycle shape:

```text
kona <install|update|verify|disable|enable|remove> --host <opencode|codex|claude|pi> --scope <project|user|local>
```

`local` is valid only for Claude. Host-specific source/marketplace, project-root, approval, replacement-confirmation, and JSON flags are documented in command help; they do not introduce additional public verbs.

### 6.5. Safe Lifecycle and Ownership

| Contract         | Requirement                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scope            | All hosts support project/user; Claude also supports local. At most one scope per host is active. Disabled scopes may coexist.                                                                                                                                                                                                                               |
| Serialization    | One host-wide lock covers recovery, all-scope inspection, approval, mutation, verification, and rollback.                                                                                                                                                                                                                                                    |
| Ownership        | Protected manifests record schema/capability/version, host/scope/state, exact allowlisted paths, hashes/modes, backups, and managed config blocks or native identity. Project and Claude local state is stored below a SHA-256 of the canonical project root; user state remains host-wide. Metadata cannot authorize paths outside code-defined allowlists. |
| Existing content | Unowned allowlisted content is replaced only after explicit digest-bound confirmation and a verified protected restoration backup. No generic force/adoption path exists.                                                                                                                                                                                    |
| Integrity        | Hash drift, unsafe links/permissions, malformed/newer state, scope ambiguity, or changed backups block destructive action.                                                                                                                                                                                                                                   |
| Operations       | Install is idempotent; update is version-aware and refuses downgrade; verify is read-only after recovery; disable/enable preserve install state; remove deletes only verified owned resources and restores confirmed replacements.                                                                                                                           |
| Recovery         | Every mutation has a durable crash journal and preimages/compensation plan. Next invocation recovers under lock; unprovable rollback reports partial state and retains evidence.                                                                                                                                                                             |
| User content     | Authored PRDs, existing PRDs, repository conventions, and unrelated configuration are never owned, updated, or deleted.                                                                                                                                                                                                                                      |

Tests define filesystem sequencing and failure injection. This SPEC intentionally does not prescribe per-step fsync mechanics, lock JSON, exhaustive parser rules, archive rejection enumerations, or full ownership/journal schemas.

### 6.6. Release and Bootstrap

Release identity is strict: version `X.Y.Z`, tag `vX.Y.Z`, and assets `install.sh`, `kona-vX.Y.Z-portable.tar.gz`, and `SHA256SUMS`. Builds are deterministic and version/hash alignment is validated.

Required one-line install:

```bash
curl -fsSL https://github.com/open-treasury/kona/releases/latest/download/install.sh | sh
```

Documentation must also provide an inspect-before-run flow that downloads the same script, lets the user inspect it, and executes the local file separately.

On macOS/Linux, the bootstrap requires Node.js 20+, downloads immutable versioned release assets, verifies `SHA256SUMS` and the archive's internal manifest before installation, stages before activation, and refuses unowned `kona` destinations. It installs under `${XDG_DATA_HOME:-$HOME/.local/share}/kona/versions/vX.Y.Z/` and links `${KONA_BIN_DIR:-$HOME/.local/bin}/kona`. It uses no `sudo`, changes no startup file, and emits no telemetry.

Network boundary: PRD runtime is offline. The installer may contact only the approved HTTPS GitHub release/CDN endpoints (`github.com`, `release-assets.githubusercontent.com`, `objects.githubusercontent.com`, `github-releases.githubusercontent.com`); native package managers may contact only configured sources. No branch/raw/API/analytics endpoints are used.

### 6.7. Build, Versioning, and Review

| Root script       | Proposed command                   | Purpose                                                                                                               |
| ----------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `plugin:build`    | `node plugin/scripts/build.mjs`    | Stage deterministic portable artifacts, manifests, and checksums.                                                     |
| `plugin:validate` | `node plugin/scripts/validate.mjs` | Validate canonical source, thin adapters, host/release contracts, Node-only runtime, references, and reproducibility. |
| `test:plugin`     | `bun test plugin/test`             | Run lifecycle, installer, contract, parity, and host tests.                                                           |

Capability/plugin/package versions align for the first release. Behavioral compatibility follows SemVer; copied-host downgrades are refused. Claude auto-update remains host-controlled; Pi pinned sources update by approved reinstall.

`docs/compliance/one-way-doors.md`, `docs/compliance/soc2/spec-checklist.md`, and `docs/pm/` are absent. Before release, record a concise local one-way-door review covering config mutation, ownership/version state, native external effects, remote bootstrap, and replacement/restoration. Record accepted/deferred rationale and owner; do not claim formal compliance.

The Pi source decision is final: use the repository directly at `git:github.com/open-treasury/kona`; no npm publication or separate Pi repository is required. Lifecycle tests may pass an explicit local repository-root `--source` to remain isolated from the network while exercising the same root manifest.

#### Local one-way-door review

This is a local architecture review, not a formal compliance review. Release owner means the Kona
maintainer preparing the release.

| Surface                        | Decision                                                                                                                                                                                                                               | Rationale                                                                                                                                                                | Owner                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| Configuration mutation         | **Accepted:** only the bounded Kona-owned Codex block is edited directly; OpenCode activation is file-based and Claude/Pi use native commands.                                                                                         | Fixed markers, preimages, drift checks, and unrelated-file canaries keep direct mutation narrow and reversible.                                                          | Lifecycle maintainer    |
| Ownership/version schema       | **Accepted:** protected schema-v1 manifests, hashes, fixed allowlists, one active scope, locks, and journals are the authority for mutation. **Deferred:** schema migration.                                                           | Refusing unknown/newer state is safer for the first release; add migration only with a concrete shipped schema transition and fixture coverage.                          | Lifecycle maintainer    |
| Native package-manager effects | **Accepted with limitation:** Claude and Pi mutations require a displayed argv plan and approval; completion is verified natively.                                                                                                     | External package managers are not transactionally controlled by Kona. Compensation is attempted, and uncertain completion retains evidence instead of claiming rollback. | Host adapter maintainer |
| Remote bootstrap               | **Accepted:** the bootstrap may fetch only immutable versioned assets through the approved GitHub release/CDN hosts and must verify external and internal manifests before activation. **Deferred:** additional distribution channels. | This keeps the initial trust and network boundary auditable without inventing unsigned mirrors or a background updater.                                                  | Release owner           |
| Replacement/restoration        | **Accepted:** unowned allowlisted files require digest-bound consent and a protected verified backup; disable/remove restores them, while drift blocks destructive action.                                                             | Content similarity is not ownership. Preservation takes priority over force/adoption convenience.                                                                        | Lifecycle maintainer    |

### 6.8. Pros and Cons

- **Pros:** One PRD method, native invocation, small adapters, no destination Bun, conservative ownership, recoverable lifecycle, reproducible release.
- **Cons:** Copied hosts require explicit updates; native commands can bypass Kona's scope guard; external package-manager effects cannot be globally atomic.
- **Consequence:** User edits to owned installed files block automatic mutation until resolved, favoring preservation over convenience.

## 7. Testing Strategy

Implementation follows RED-GREEN-REFACTOR. Tests use isolated fixture homes/repositories and never mutate the developer's real host configuration.

### 7.1. Test Layers

| Layer             | Required coverage                                                                                                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static contracts  | Canonical source/template, thin adapters, exact invocations/roots, manifest/version/release names, self-contained references, Node-only zero-dependency runtime, no workflow diff, no telemetry/network client. |
| Fixture lifecycle | Every host/scope install, repeat install, version update, disable/enable/remove, one-active-scope locking, replacement/restore, tamper refusal, journal recovery, and unrelated-file canaries.                  |
| Adapter parity    | Deterministic non-model checks load each installed and distributed host adapter, prove exact canonical skill/template bytes, and verify invocation, supported modes, and the PRD-only write contract.           |
| Negative controls | Requests for code/planning/extra files/network; invalid adapters/manifests; cross-scope conflicts; counterfeit ownership paths; drifted files and backups.                                                      |
| Installer         | Checksum/internal-manifest validation, approved endpoint boundary, exact ownership, idempotence, unowned destination refusal, upgrade activation, crash rollback, no sudo/startup edits.                        |
| Real hosts        | Mandatory release CI uses pinned OpenCode, Codex, Claude Code, and Pi versions; native discovery/lifecycle checks run without model calls and no skip is allowed.                                               |

Local host checks may report an explicit skip when a CLI is absent. `KONA_RELEASE_VALIDATION=1 bun run test:plugin` must fail on any missing or mismatched pinned host.

This automated layer is adapter payload/contract parity and must not be described as semantic output
parity or an LLM test. Before release, dogfooding runs one create and one targeted refinement with a
real model through every supported host, then records host/model versions, prompts, output paths,
semantic review, and write scope. Existing OpenCode create/refine evidence is retained; equivalent
Codex, Claude Code, and Pi evidence remains a release requirement rather than an automated claim.

### 7.2. PRD Acceptance Traceability

| PRD AC             | Coverage                                                                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1-AC7, AC11-AC13 | Automated canonical/template assertions cover the instructed path, question, overwrite, refinement, lean-output, and PRD-only contracts; real-model behavior is release dogfood evidence.                 |
| AC8                | Automated adapter payload/contract parity proves common bytes and host contracts; semantic output parity requires real-model create/refine dogfood on every host. Existing evidence covers OpenCode only. |
| AC9-AC10           | Automated hash, self-containment, and unsupported-content instruction checks.                                                                                                                             |
| AC14-AC15          | Pi package behavior and all-host project/user discovery/invocation.                                                                                                                                       |
| AC16-AC19          | Ownership confirmation, update, disable/enable/remove, idempotence, restoration, and unrelated-file canaries.                                                                                             |
| AC20               | Claude collaborator marketplace registration plus approved project install.                                                                                                                               |
| AC21               | Cross-scope matrices and concurrent host-lock tests, including Claude local.                                                                                                                              |
| AC22               | macOS/Linux installer checksum, manifest, ownership, no-sudo, idempotence, and rollback tests.                                                                                                            |

## 8. Definition of Done

### Universal

- [ ] Tests pass: `bun run test`.
- [ ] TypeScript passes: `bun run typecheck`.
- [ ] Lint passes: `bun run lint`.
- [ ] Formatting passes: `bun run format:check`.
- [ ] SPEC reflects the implementation.
- [ ] The concise local one-way-door review is recorded without a formal compliance claim.

### Feature-Specific

- [ ] `bun run plugin:build` is reproducible and emits only the exact versioned assets in §6.6.
- [ ] `bun run plugin:validate` passes all canonical, host, runtime, release, reference, and non-regression contracts.
- [ ] `bun run test:plugin` passes static, fixture, parity, negative, installer, and host suites.
- [ ] Release CI runs exact pinned versions of all four real hosts with no skip and no model call.
- [ ] The canonical skill/template are self-contained; copied payloads are byte-identical; adapters contain no PRD procedure.
- [ ] Useful guidance is migrated and `guidelines/docs/prd.md` is deleted with no remaining dependency on it.
- [ ] Lifecycle tests prove one active scope, locking, hash ownership, confirmed replacement/restoration, idempotence, version-aware update, disable/enable/remove, and crash rollback.
- [ ] Authored PRDs and unrelated configuration remain byte-identical through lifecycle and failure tests.
- [ ] Standalone `kona` exposes only lifecycle verbs; the Claude plugin forwards all existing workflow verbs unchanged.
- [ ] Installer tests prove checksum/manifest verification, approved network boundary, exact ownership, no sudo/startup edits/telemetry, and rollback.
- [ ] Documentation includes exact roots, native commands, invocations, scope/trust/update behavior, the required curl command, and inspect-before-run alternative.
- [ ] Marketplace is `kona` from `https://github.com/open-treasury/kona`; Pi installs from `git:github.com/open-treasury/kona` through the root manifest.

## 9. Alternatives Not Chosen

| Alternative                                 | Why rejected                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| Keep OpenCode agent canonical               | Host-specific and already duplicates behavior.                          |
| Generate four full prompts                  | Ships unnecessary behavioral copies and review surface.                 |
| Add wrappers/extensions everywhere          | Native skills are sufficient; executable trust would broaden scope.     |
| Require Bun in destination repositories     | Violates portability; Bun is contributor tooling only.                  |
| Symlink copied hosts                        | Packaged and user installs cannot rely on a stable checkout path.       |
| Force/adopt unowned files                   | Content similarity is not ownership and cannot justify deletion.        |
| Let host precedence choose duplicate scopes | Hides ambiguity and conflicts with the PRD's one-active-scope contract. |
| Add a background updater                    | Broadens network/runtime behavior; native or explicit updates suffice.  |
| Rewrite old PRDs during update              | Authored documents are user content, not install resources.             |

## 10. References

| Reference                                                                                          | Relevance                                                            |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [Approved PRD](./prd.md)                                                                           | Product scope, functional/non-functional requirements, and AC1-AC22. |
| `guidelines/docs/spec.md`                                                                          | Required SPEC sections and scannability guidance.                    |
| `guidelines/docs/prd.md`                                                                           | One-time migration input only; deleted after verified migration.     |
| `.opencode/agents/prd-writer.md`                                                                   | Existing duplicated procedure to replace with a thin adapter.        |
| `plugin/.claude-plugin/plugin.json` and `plugin/README.md`                                         | Existing Claude distribution and workflow compatibility boundary.    |
| `docs/agent-toolkit/03-writing-skills-and-commands.md`                                             | Canonical-skill/thin-adapter pattern.                                |
| `docs/agent-toolkit/06-testing-and-governance.md`                                                  | Fixture, parity, provenance, and release testing guidance.           |
| `eval/gen/check-drift.ts`                                                                          | Existing SHA-256 provenance-gate pattern.                            |
| [Claude Code plugins](https://code.claude.com/docs/en/plugins-reference)                           | Plugin scopes, marketplace lifecycle, and invocation.                |
| [Pi packages](https://pi.dev/docs/latest/packages)                                                 | Package resources, trust, scopes, and lifecycle.                     |
| [OpenCode skills](https://opencode.ai/docs/skills/) and [agents](https://opencode.ai/docs/agents/) | Skill/agent roots, invocation, and permissions.                      |
| [Codex skills](https://developers.openai.com/codex/skills/)                                        | Skill roots, invocation, and configuration.                          |
| [Kona releases](https://github.com/open-treasury/kona/releases)                                    | Versioned bootstrap artifacts.                                       |

Unavailable compliance and PM documents are acknowledged in §6.7; they were not reviewed and no formal compliance claim is made.
