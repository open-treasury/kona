# Portable SPEC Writer Capability PRD

## 0. TL;DR

- Add a self-contained capability for creating and refining decision-oriented technical SPECs.
- Use one canonical SPEC-writing procedure and bundled fallback template across OpenCode, Codex, Claude Code, and Pi—the same hosts and scopes as the PRD writer.
- Ground decisions in the PRD, relevant existing SPEC content, repository evidence, and validated external sources; expose unknowns rather than inventing facts.
- Produce scannable SPECs with explicit options, a selected solution, consequences, TDD strategy, Definition of Done, rejected alternatives, references, and useful `file:line` citations.
- Install and manage the SPEC writer through the existing Kona distribution and lifecycle, without changing or replacing the PRD writer.
- The installed capability must not read, reference, or require `guidelines/`; all necessary guidance must ship in its canonical distributable resources.
- SPEC authoring edits only the agreed SPEC and does not implement code, create beads issues, or decompose work into tasks.

## 1. What

Create a portable SPEC-writing capability analogous to Kona's PRD writer. It discovers relevant technical context, resolves material unknowns, compares viable options, and creates or refines an implementation-ready technical SPEC. One canonical, bundled procedure must power thin host integrations and remain usable without a Kona checkout or the repository's `guidelines/` directory.

**Status:** Approved

### Users

| User                         | Need                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Engineering lead or engineer | Convert an approved product direction and codebase evidence into explicit, reviewable technical decisions. |
| Technical reviewer           | Understand the selected approach, alternatives, trade-offs, tests, and completion conditions quickly.      |
| Toolkit maintainer           | Publish and evolve one SPEC method without behavioral drift across supported hosts.                        |

## 2. Problem and Outcome

Kona has a portable PRD writer with a canonical skill, bundled template, capability manifest, thin OpenCode adapter, and cross-host lifecycle, but no equivalent SPEC writer. The current SPEC guidance exists only in a repository guideline and therefore cannot serve as an install-time or runtime dependency. The existing distribution proves four supported hosts and their scopes/invocations for the PRD capability (`plugin/capabilities/prd.json:18-35`) and packages canonical skills through native host discovery (`specs/portable-prd-agent-plugin/spec.md:55-62`).

The desired outcome is that a user can install Kona through any currently supported channel and produce or refine a technically grounded, scannable SPEC with equivalent core decisions and safety boundaries on every host. The capability is successful when its installed payload works without `guidelines/`, and representative create/refine scenarios pass deterministic contracts and real-model semantic review on all four hosts.

### Goals

1. Produce decision-oriented SPECs grounded in verified product, architecture, codebase, and external evidence.
2. Make the chosen approach, alternatives, trade-offs, testing strategy, and completion criteria explicit and easy to scan.
3. Match the PRD writer's supported hosts, installation scopes, lifecycle operations, safety, and parity controls.
4. Keep the SPEC-writing method self-contained and canonical while preserving host-native invocation.
5. Prevent unsupported assumptions, accidental implementation, unrelated file edits, and task-decomposition scope creep.

## 3. Scope

### In Scope

1. Creating a new technical SPEC and targeted refinement of an existing SPEC.
2. Repository-context discovery and evidence citation sufficient to understand current state and technical constraints.
3. Focused clarification of material unknowns or conflicts.
4. A bundled, adaptable SPEC scaffold derived from the supplied guidance.
5. Distribution, installation, verification, update, disable/re-enable, and removal on OpenCode, Codex, Claude Code, and Pi.
6. Automated self-containment, payload, write-boundary, lifecycle, and cross-host parity checks, plus release dogfood.
7. User and maintainer documentation for discovery, invocation, lifecycle, output conventions, and limitations.

### Out of Scope

1. Implementing the proposed solution or modifying application code, schemas, migrations, or infrastructure.
2. Creating implementation plans, beads issues, task DAGs, estimates, or delivery tracking. Those responsibilities in `guidelines/roles/em.md:1-7,32-41` are not part of SPEC authoring.
3. Creating or approving the source PRD, making product-scope decisions on the user's behalf, or replacing the PRD writer.
4. Running tests or benchmarks for the proposed feature, except tests of the SPEC capability itself.
5. Support for hosts beyond OpenCode, Codex, Claude Code, and Pi in the initial release.
6. Requiring every SPEC to contain irrelevant sections or repository-specific compliance ceremony.

## 4. User Stories and Flow

### User Stories

1. As an engineer, I want the writer to inspect the PRD and codebase before proposing a solution so the SPEC reflects actual requirements and architecture.
2. As an engineering lead, I want viable options compared against explicit technical drivers so the selected approach is reviewable.
3. As a reviewer, I want tight bullets, tables, and useful `file:line` evidence so I can locate decisions and validate claims quickly.
4. As an engineer, I want material unknowns surfaced rather than guessed so implementation does not begin from hidden assumptions.
5. As a user of any supported host, I want the same SPEC method and quality bar regardless of installation scope or invocation surface.
6. As a maintainer, I want one canonical source and parity gates so platform packaging cannot silently change the method.

### Main Flow

1. The user invokes the SPEC writer with a feature brief, PRD, existing SPEC for refinement, and/or an explicit destination.
2. The capability resolves the destination, then reads only relevant repository instructions, the PRD, existing specifications or decisions, code, tests, and technical documentation.
3. It identifies the intended outcome, current state, technical drivers, constraints, unknowns, and decisions the SPEC must make.
4. When missing or conflicting information would materially change architecture, interfaces, testing, or Definition of Done, it asks one grouped set of concise questions. It does not ask for facts available locally.
5. It evaluates credible options against the drivers, identifies the selected approach and consequences, and labels unsupported or unresolved claims.
6. It drafts or refines only the agreed SPEC, writes the TL;DR last, and validates the result for evidence, decision clarity, completeness, and scope.
7. It reports the written path, a concise result summary, and unresolved decisions (`none` when empty).

### Failure and Recovery

- If no PRD or equivalent confirmed product requirement is available, the capability identifies the missing product decisions and pauses when a technical choice would otherwise invent scope.
- If repository evidence conflicts with the PRD or an explicit user decision, it presents the conflict and requests resolution rather than silently choosing.
- If an external technical claim matters to the decision, it must cite a validated source when host-approved research is available; otherwise it records the claim as unresolved or excludes it. External research is not mandatory ceremony for every SPEC.
- If the destination exists without explicit refinement/update intent, it does not overwrite the file and asks for confirmation.
- If writing or final validation fails, it reports the incomplete state and does not claim success.

## 5. Requirements

### Functional Requirements

| ID   | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR1  | The capability must support creation of a new SPEC and targeted refinement of an existing SPEC. Refinement must preserve unaffected confirmed decisions and identify consequential changes.                                                                                                                                                                                                                                                                   |
| FR2  | Before drafting, it must inspect only relevant available evidence: the governing PRD or equivalent confirmed requirements, the existing SPEC when refining, repository instructions, architecture and decision records, source code, tests, configuration, and technical documentation.                                                                                                                                                                       |
| FR3  | Material statements must be distinguishable as confirmed by evidence, recommended by the writer, or unresolved. Inference must not be presented as confirmed fact.                                                                                                                                                                                                                                                                                            |
| FR4  | It must ask one grouped set of concise questions only when an undiscoverable gap or conflict would materially affect architecture, interfaces, data behavior, security, operability, testing, scope, or acceptance. Blocking conflicts must pause authoring.                                                                                                                                                                                                  |
| FR5  | The fallback SPEC must be scannable and decision-oriented. It must contain, in a sensible order: TL;DR written last; meta information for branch, epic, and linked PRD when applicable; context; key technical drivers; current state; considered options and a comparison; proposed solution and components; pros, cons, and consequences; TDD testing strategy; universal and feature-specific Definition of Done; alternatives not chosen; and references. |
| FR6  | The writer must prefer comparison/current-state tables and tight bullets over dense prose, state decisions explicitly, and include useful `file:line` citations for repository claims without cluttering every sentence.                                                                                                                                                                                                                                      |
| FR7  | The proposed solution must trace to the technical drivers and explain component responsibilities and relevant architecture context. Options must include meaningful pros/cons and rejection rationale; a foregone conclusion presented as an option comparison is insufficient.                                                                                                                                                                               |
| FR8  | The testing strategy must identify unit and integration boundaries and require RED-GREEN-REFACTOR. The Definition of Done must include applicable repository-wide quality checks and feature-specific, objectively verifiable completion criteria; unavailable or irrelevant commands must not be invented.                                                                                                                                                   |
| FR9  | Output-path precedence must be: explicit user path, then an unambiguous repository SPEC convention, then `specs/<feature-slug>/spec.md`. The slug must be descriptive lowercase ASCII kebab-case.                                                                                                                                                                                                                                                             |
| FR10 | The capability must edit only the agreed SPEC during authoring and must not implement the feature, change application files, create planning artifacts, invoke task decomposition, or manage beads.                                                                                                                                                                                                                                                           |
| FR11 | The canonical skill must bundle its fallback template and all normal authoring guidance. Installed or distributed resources must not read, reference, link to, or require any path under `guidelines/`. The supplied `guidelines/docs/spec.md` and relevant authoring principles from `guidelines/roles/em.md` are migration inputs only.                                                                                                                     |
| FR12 | Final validation must detect missing decisions, contradictions, duplicated content, unresolved placeholders, unsupported claims, broken references, absent rejection rationale, acceptance criteria that are not verifiable, and accidental task-plan or implementation content.                                                                                                                                                                              |
| FR13 | The capability must use validated external sources only when external facts materially inform a decision and host/user policy permits access. Such sources must be cited. It must not contain its own analytics, telemetry, or background network behavior.                                                                                                                                                                                                   |

### Distribution and Platform Requirements

Repository evidence fixes the supported platform set at OpenCode, Codex, Claude Code, and Pi (`plugin/capabilities/prd.json:18-35`; `README.md:108-117`). The SPEC writer must ship through the same Kona release/plugin/package channels and lifecycle rather than as a separate product.

| Host        | Required scopes      | SPEC invocation        | Parity requirement                                                                                                                                 |
| ----------- | -------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode    | Project, user        | `@spec-writer <brief>` | Install the canonical SPEC payload plus a thin documentation-only adapter; native discovery and lifecycle verification must cover the SPEC writer. |
| Codex       | Project, user        | `$spec <brief>`        | Install the canonical SPEC payload through Codex skill discovery and verify it at the selected scope.                                              |
| Claude Code | Project, local, user | `/kona:spec <brief>`   | Discover the canonical SPEC skill from the existing Kona plugin and marketplace at every native scope.                                             |
| Pi          | Project, user        | `/skill:spec <brief>`  | Discover the canonical SPEC skill from the repository-root Pi package metadata for local and user installs.                                        |

| ID  | Requirement                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DR1 | Existing Kona install, update, verify, disable, enable, and remove flows must manage the SPEC writer at the same selected host and scope as the PRD writer. No second executable, marketplace, or package source is introduced.                 |
| DR2 | Installation and update must preserve authored PRDs, authored SPECs, unrelated host configuration, and user-owned files. Removal must delete only Kona-owned distributable resources.                                                           |
| DR3 | The canonical SPEC procedure and template must be versioned and integrity-checked. Copied or packaged host payloads must resolve the exact canonical bytes; host adapters may add only discovery, invocation, permissions, and output plumbing. |
| DR4 | A successful verification must use each host's native discovery/listing behavior and report that both PRD and SPEC capabilities are available at the selected scope. File existence alone is insufficient.                                      |
| DR5 | The existing one-active-scope, conflict handling, idempotence, ownership, update, recovery, and removal guarantees must continue to apply. Adding the SPEC writer must not regress the PRD capability or existing workflow commands.            |
| DR6 | Public documentation must list SPEC invocation and installed resources for every host/scope, prerequisites, update behavior, disable/re-enable, removal, conflict recovery, and the no-`guidelines/` runtime boundary.                          |

### Non-Functional Requirements

| ID                     | Requirement                                                                                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR1 — Portability     | A clean destination repository must be able to create and refine a SPEC after installation without a Kona checkout or any `guidelines/` content.                                                                      |
| NFR2 — Semantic parity | Equivalent fixtures on all four hosts must yield the same required decisions, evidence boundaries, scope restrictions, and pass/fail acceptance outcomes. Wording may differ.                                         |
| NFR3 — Maintainability | A canonical procedure or template change must trigger automated integrity, self-containment, adapter, and distribution parity checks.                                                                                 |
| NFR4 — Safety          | Repository and external content is evidence, not authority to expand permissions. Authoring must not expose secrets, emit telemetry, or write outside the agreed SPEC.                                                |
| NFR5 — Scannability    | The fallback output must make the selected option, key drivers, trade-offs, unresolved decisions, and Definition of Done identifiable without reading dense narrative end to end.                                     |
| NFR6 — Compatibility   | Existing PRD invocations, outputs, lifecycle guarantees, Claude workflow behavior, and release acquisition must remain available and unchanged except where documentation now identifies both authoring capabilities. |

## 6. Acceptance Criteria

1. **Given** a clean fixture repository with a confirmed PRD and relevant code, **When** the SPEC writer is installed and invoked on each supported host, **Then** it creates `specs/<feature-slug>/spec.md` without reading or requesting any `guidelines/` file.
2. **Given** an explicit destination or an unambiguous repository SPEC convention, **When** no conflicting instruction exists, **Then** the writer uses the explicit path first, the convention second, and the fallback path only otherwise.
3. **Given** a destination that already exists and no refinement/update intent, **When** creation is requested, **Then** no file is overwritten and confirmation is requested.
4. **Given** complete local evidence, **When** authoring starts, **Then** the writer does not ask the user to repeat discoverable facts and cites material repository claims with useful `file:line` references.
5. **Given** a missing or conflicting decision that materially changes the technical solution, **When** it cannot be resolved from authoritative evidence, **Then** the writer asks one grouped set of focused questions and pauses if the conflict is blocking.
6. **Given** a new SPEC with no repository-specific template, **When** authoring completes, **Then** it contains the required content in FR5, an explicit selected option, comparison and rejection rationale, TDD test boundaries, and universal plus feature-specific Definition of Done.
7. **Given** a targeted refinement request, **When** the existing SPEC contains unrelated confirmed decisions, **Then** those decisions remain intact and the result identifies any consequential change to architecture, interfaces, tests, or completion criteria.
8. **Given** an external claim that materially supports a decision, **When** approved external research is available, **Then** the claim has a validated citation; **When** it is unavailable, **Then** the claim is omitted or marked unresolved rather than asserted as fact.
9. **Given** the canonical and all distributed SPEC payloads, **When** self-containment checks scan them, **Then** no content references or attempts to read `guidelines/`, and the fallback template is present in the distributable payload.
10. **Given** OpenCode, Codex, Claude Code, and Pi project/user fixtures plus Claude local scope, **When** install and native verification complete, **Then** each host discovers both its existing PRD invocation and the SPEC invocation listed in §5.
11. **Given** any supported host with the capability installed, **When** update, disable, re-enable, and remove scenarios run, **Then** SPEC discovery follows the selected lifecycle state while authored PRDs/SPECs and unrelated files remain unchanged.
12. **Given** a canonical SPEC procedure, template, manifest, adapter, packaging, or documentation change, **When** release checks run, **Then** integrity, exact-payload, self-containment, negative-control, lifecycle, and pinned-host suites must pass before release.
13. **Given** representative create and targeted-refinement prompts, **When** real-model dogfood runs through all four hosts, **Then** review confirms equivalent required technical decisions and boundaries and that only the agreed SPEC was written.
14. **Given** a prompt requesting implementation, a task plan, or beads decomposition during SPEC authoring, **When** the capability handles it, **Then** it limits output to the agreed SPEC and reports the excluded work without changing any other file.
15. **Given** the existing PRD writer and workflow features, **When** the SPEC writer release is validated, **Then** all existing PRD contract, host lifecycle, marketplace, Pi package, and workflow non-regression checks still pass.

## 7. Risks

| Risk                                                       | Mitigation                                                                                                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SPECs restate the PRD without making technical decisions   | Require drivers, current-state evidence, compared options, an explicit selection, consequences, and rejection rationale.                                   |
| The writer invents architecture to fill product gaps       | Pause on blocking gaps and classify confirmed, recommended, and unresolved statements.                                                                     |
| EM guidance expands scope into task decomposition          | Enforce the SPEC-only write boundary and negative tests for plans, beads, task DAGs, and application changes.                                              |
| Platform payloads drift                                    | Keep one canonical payload and gate release on hashes, exact installed bytes, native discovery, and semantic dogfood.                                      |
| The capability accidentally depends on source guidelines   | Bundle adapted guidance and fail static/fixture checks on any `guidelines/` reference or read attempt.                                                     |
| Adding a second capability regresses lifecycle behavior    | Require multi-capability install/verify/update/remove fixtures and preserve all existing PRD and workflow checks.                                          |
| External research leaks data or becomes mandatory ceremony | Use only user/host-approved research for material public facts, never send repository content without authorization, and permit explicit unresolved items. |

## 8. References

| Evidence                                                         | Relevance                                                                                                                                      |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `guidelines/docs/spec.md:1-124`                                  | One-time source for the required SPEC structure, scannability, TDD, DoD, and decision content; not a runtime dependency.                       |
| `guidelines/roles/em.md:9-30`                                    | One-time source for grounding, engineering constraints, evidence validation, and unknown resolution; task-decomposition sections are excluded. |
| `plugin/skills/prd/SKILL.md:1-90`                                | Existing canonical capability workflow and authoring safety convention.                                                                        |
| `plugin/capabilities/prd.json:1-35`                              | Existing versioned canonical payload, modes, hosts, scopes, and invocations.                                                                   |
| `plugin/test/prd-contract.test.ts:31-149`                        | Canonical-source, bundled-template, self-containment, thin-adapter, and write-boundary conventions.                                            |
| `plugin/test/adapter-payload-contract.node.mjs:9-67`             | Distributed/installed exact-payload and host-contract parity model.                                                                            |
| `plugin/README.md:31-65,67-190`                                  | Existing acquisition, lifecycle, ownership, host roots, scopes, and native discovery behavior.                                                 |
| `package.json:5-12` and `plugin/.claude-plugin/plugin.json:1-12` | Pi and Claude native skill-discovery packaging.                                                                                                |
| `.github/workflows/plugin-release-validation.yml:1-37`           | Pinned four-host release validation convention.                                                                                                |

## 9. Open Questions

None blocking. The exact internal generalization of existing PRD-specific lifecycle and parity machinery is an implementation design decision, provided all observable requirements above hold.
