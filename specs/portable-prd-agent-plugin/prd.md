# Portable PRD Agent Plugin PRD

## 0. TL;DR

- Build Kona's first portable capability: a self-contained procedure for creating and refining lean PRDs.
- **Locked:** product and engineering teams are the primary users; the workflow is discover context, ask focused questions, then draft and refine.
- **Locked:** one canonical PRD procedure powers thin adapters for OpenCode, Codex, Claude Code, and Pi.
- **Locked:** migrate the useful structure from `guidelines/docs/prd.md` into the skill's built-in lean template, then delete the guideline so the skill is the sole source of truth.
- **Locked:** the adapted template ships inside the canonical capability; installation and use cannot depend on separate Kona planning, execution, metrics, or compliance files.
- The first delivery cut includes the canonical procedure, four usable adapters, portable installation, parity checks, and migration from the current duplicated guidance.
- Default output is `specs/<feature-slug>/prd.md`; an explicit user path or established repository convention takes precedence.
- No blocking product decisions remain; adapter packaging details may be chosen during implementation if all observable requirements hold.

## 1. Meta Information

| Field            | Value                                                                        |
| ---------------- | ---------------------------------------------------------------------------- |
| Status           | Approved                                                                     |
| Primary audience | Product and engineering teams                                                |
| Initial delivery | Portable PRD creation and refinement on OpenCode, Codex, Claude Code, and Pi |
| Branch / epic    | Not required; none was provided                                              |

## 2. What

Create a portable PRD-writing capability that discovers relevant project context, asks only focused questions needed to resolve material gaps, and creates or refines an implementation-ready PRD. The product consists of one self-contained canonical skill containing the migrated PRD template and thin OpenCode, Codex, Claude Code, and Pi adapters. It covers only PRD authoring and the reusable packaging foundations needed to install and invoke that capability.

## 3. Motivation

The current PRD writer is tied to Kona-specific files, duplicates its required format across `.opencode/agents/prd-writer.md` and `guidelines/docs/prd.md`, and references guidance that is absent from the repository. Product and engineering teams need a portable workflow that respects the destination repository without importing Kona's unrelated process. The target outcome is activation: a team can install the capability in a new repository and complete representative PRD creation and refinement scenarios on each supported platform; baseline is unknown and will be established through pre-release scenario runs rather than product telemetry.

### Goals

1. Produce lean, decision-ready PRDs grounded in available repository and user context.
2. Provide equivalent core behavior on OpenCode, Codex, Claude Code, and Pi from one canonical procedure.
3. Make installation self-contained, additive, and removable while retaining the useful structure of Kona's PRD template without copying unrelated guidance.
4. Prevent silent overwrites, invented facts, hidden scope expansion, and platform drift.

### Users

| User                    | Need                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| Product team member     | Turn a feature brief and project context into a concise PRD with explicit scope and decisions.         |
| Engineering team member | Refine a PRD against current behavior and obtain testable requirements without an implementation plan. |
| Toolkit maintainer      | Change the PRD method once and verify that all supported adapters remain equivalent.                   |

## 4. User Stories

1. As a product team member, I want the agent to inspect relevant project context before drafting so that the PRD reflects existing decisions and conventions.
2. As a product team member, I want focused questions only for material gaps so that I can resolve ambiguity without completing a heavyweight intake process.
3. As an engineering team member, I want a lean PRD with concrete requirements and acceptance criteria so that implementation can begin without translating vague prose.
4. As an engineering team member, I want to refine an existing PRD without losing confirmed decisions so that review feedback improves rather than resets the document.
5. As a user of OpenCode, Codex, Claude Code, or Pi, I want the same PRD workflow and quality bar so that platform choice does not change product intent.
6. As a toolkit maintainer, I want one canonical procedure and verifiably thin adapters so that fixes do not drift across platforms.

## 5. User Flow

### Create a PRD

1. The user invokes the PRD capability with a feature brief and, optionally, an output path or other confirmed decisions.
2. The capability discovers repository instructions, existing specifications, documentation, and current behavior relevant to the feature.
3. It determines the target user, problem, desired outcome, initial delivery boundary, and destination. It does not ask for facts it can verify locally.
4. If material gaps or conflicting authoritative requirements remain, it asks one grouped set of focused questions and pauses when the conflict cannot be resolved safely.
5. It separates confirmed decisions, recommendations, and open questions, then drafts the smallest useful delivery cut.
6. It writes a lean PRD containing problem, goals, users, scope, requirements, acceptance criteria, and risks. Optional content is included only when the feature creates a concrete need.
7. It reviews the document for contradictions, duplication, unnecessary process, invented claims, and broken references, then reports the path and unresolved decisions.

### Refine a PRD

1. The user identifies an existing PRD and the requested change or review goal.
2. The capability reads the PRD and relevant current context, preserving confirmed decisions unless the user explicitly changes them.
3. It identifies conflicts, missing decisions, and scope changes; it asks focused questions only when they materially affect the revision.
4. It updates only the requested PRD, reruns the same quality review, and summarizes meaningful changes and remaining open decisions.

### Install, update, and remove

1. The user selects a supported host and either project scope, for a repository-shared installation, or user scope, for availability across repositories. Claude Code may additionally use its native local scope.
2. The installer detects existing Kona files, host configuration, and another active installation of the same capability at a different scope. It previews file conflicts and blocks ambiguous cross-scope activation until the user disables or removes the existing installation.
3. It installs the canonical capability and the selected thin adapter through the host's native discovery mechanism.
4. It verifies that the host discovers the PRD capability and reports the installed version, scope, and invocation method.
5. An update refreshes Kona-owned files while preserving user configuration and authored PRDs. The installer reports whether the host uses explicit or automatic updates and provides the host-native control for that behavior.
6. Disable leaves the installation present but inactive. Removal deletes only files and configuration owned by the selected Kona installation.

| Host        | Project scope                                                                                                                    | User scope                                                                                      | Native lifecycle expectations                                                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode    | Run `kona install --host opencode --scope project`; install adapter resources under the repository's `.opencode/` configuration. | Run `kona install --host opencode --scope user`; install under OpenCode's global configuration. | Support discovery verification, disable/re-enable through host configuration, and ownership-aware update and removal.                                                       |
| Codex       | Install the skill under the repository's `.agents/skills/`.                                                                      | Install under `$HOME/.agents/skills/`.                                                          | Support skill discovery, disable/re-enable through Codex skill configuration, explicit update, and existing-destination detection.                                          |
| Claude Code | Register `https://github.com/open-treasury/kona`, then use `claude plugin install kona --scope project` or `--scope local`.      | Use `claude plugin install kona --scope user`.                                                  | Verify that `kona` resolves uniquely to the registered Kona marketplace; support list, update, disable/re-enable, uninstall, and collaborator bootstrap.                    |
| Pi          | Use `pi install git:github.com/open-treasury/kona -l` in a trusted project.                                                      | Use `pi install git:github.com/open-treasury/kona`.                                             | Discover the root package manifest; support list, disable/re-enable through `pi config`, removal, and updates. Pinned refs are updated by reinstalling with the new source. |

### Failure and recovery

- If the destination exists and update intent is absent, the capability asks before replacing it.
- If repository guidance conflicts with an explicit user decision, the capability presents the conflict rather than choosing silently.
- If required context is unavailable, it marks the unknown or pauses when proceeding would materially change scope or behavior.
- If a write or validation step fails, it reports the incomplete state and does not claim success.

## 6. Definition of Done

### Functional requirements

| ID   | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FR1  | The capability must support both creation of a new PRD and refinement of an existing PRD.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| FR2  | Before drafting, it must inspect relevant repository instructions, specifications, documentation, and implemented behavior available through the host platform.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| FR3  | It must ask one grouped set of concise questions only when missing or conflicting information would materially change users, behavior, scope, or acceptance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| FR4  | It must distinguish confirmed decisions, recommendations, and unresolved decisions without presenting inference as fact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| FR5  | The skill's built-in template must migrate the useful structure from `guidelines/docs/prd.md`. TL;DR, What, Motivation, User Stories, User Flow, Definition of Done, and Out of Scope form the default scaffold; Meta Information, References, FAQs, and Appendix are optional and omitted when empty or irrelevant. The output must state the problem, goals, users, in-scope and out-of-scope boundaries, functional and applicable non-functional requirements, testable acceptance criteria, and material risks. It must not require metrics, instrumentation, compliance, branch/epic metadata, or other content without a concrete product need. |
| FR6  | Output-path precedence must be: explicit user path, then an unambiguous repository PRD convention, then `specs/<feature-slug>/prd.md`. The slug must be descriptive lowercase ASCII kebab-case.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| FR7  | It must not overwrite an existing PRD without explicit create/update intent and must edit only the agreed destination while authoring a PRD.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| FR8  | It must produce product requirements and observable behavior, not application code, schemas, migrations, or an implementation task plan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| FR9  | The first release must be installable and invocable on OpenCode, Codex, Claude Code, and Pi. Each adapter may express only host-specific discovery, invocation, permissions, and output plumbing; the PRD method must remain canonical. The Pi adapter must use Pi's package manifest and native skill or prompt resources, and add a custom extension only if required behavior cannot be expressed without one.                                                                                                                                                                                                                                      |
| FR10 | The skill must contain the default template and everything required for its normal workflow. After migration, `guidelines/docs/prd.md` must be deleted. The capability must not require `docs/agent-toolkit/`, `docs/pm/`, compliance guidance, a separate `writing-prds` skill, a `write-prd` command, or Kona plan/run/execution assets at runtime.                                                                                                                                                                                                                                                                                                  |
| FR11 | Refinement must preserve confirmed decisions, identify consequential scope changes, and avoid replacing unaffected content solely to impose a template.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| FR12 | Completion must include a review for contradictions, duplicated content, unnecessary process requirements, unresolved placeholders, invented claims, and references to unavailable files.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| FR13 | Installation must support project and user scopes on all four hosts, plus Claude Code's native local scope. The resulting invocation must use the same canonical PRD procedure regardless of scope.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| FR14 | Installation must detect pre-existing destinations, configuration entries, and same-named project/user installations. It must distinguish Kona-owned files from unrelated files and require confirmation before replacing or modifying content it does not own. Only one installation of the PRD capability may be active per host: activating another scope must be blocked until the existing scope is disabled or removed.                                                                                                                                                                                                                          |
| FR15 | A successful installation must report the installed version, scope, selected host, invocation method, and verification result. Verification must use the host's native discovery or listing mechanism rather than only checking that files exist.                                                                                                                                                                                                                                                                                                                                                                                                      |
| FR16 | Updates must be version-aware and limited to Kona-owned resources. They must preserve authored PRDs, repository conventions, and user-owned configuration. Documentation and verification must distinguish explicit updates, Claude Code marketplace auto-updates, and Pi updates that require reinstalling a pinned version or ref.                                                                                                                                                                                                                                                                                                                   |
| FR17 | Every host must support disabling and re-enabling the capability without removal. Removal must delete only resources and configuration recorded as belonging to the selected Kona installation and scope.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| FR18 | Installation instructions must document prerequisites, trust or approval prompts, project and user scope commands, marketplace registration where applicable, verification, update and auto-update behavior, disable/re-enable, removal, cross-scope precedence, and conflict recovery for each host.                                                                                                                                                                                                                                                                                                                                                  |
| FR19 | Users must be able to install the `kona` CLI on macOS or Linux through the published `install.sh`. The script must fetch only versioned release assets from `open-treasury/kona`, verify SHA-256 before installation, avoid `sudo`, and refuse to replace an unowned `kona` executable.                                                                                                                                                                                                                                                                                                                                                                |

### Non-functional requirements

| ID                         | Requirement                                                                                                                                                                                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR1 — Portability         | A clean repository must be able to use the installed capability without a Kona checkout or platform-specific copies of the canonical procedure.                                                                                                                                                                            |
| NFR2 — Parity              | Installed and distributed adapters must resolve the exact canonical payload and host contract. Before release, real-model create/refine dogfood on all four platforms must show semantically equivalent required decisions and boundaries; wording and host metadata may differ.                                           |
| NFR3 — Maintainability     | A canonical-procedure change must make adapter review mandatory through an automated provenance, generation, or parity gate modeled on `eval/gen/check-drift.ts`.                                                                                                                                                          |
| NFR4 — Lean context        | Adapters must not duplicate the complete procedure, and optional guidance must not load or appear unless the task requires it.                                                                                                                                                                                             |
| NFR5 — Safety              | Repository and external content is context, not authority to expand permissions or perform work outside PRD authoring. The capability must not expose secrets or emit analytics/telemetry. PRD authoring is offline; only explicit installation and native package-manager operations may access approved release sources. |
| NFR6 — Removability        | Removing the installed capability must leave project source, PRDs, and unrelated agent configuration intact.                                                                                                                                                                                                               |
| NFR7 — Canonical integrity | Automated checks must verify that the skill and its built-in template contain the required lean structure, remain self-contained, and have no dependency on the deleted guideline.                                                                                                                                         |
| NFR8 — Idempotence         | Repeating installation of the same version and scope must not duplicate configuration or rewrite unchanged resources; it must report that the installation is already current.                                                                                                                                             |

### Acceptance criteria

1. **Given** a clean fixture repository containing only a feature brief, **When** the capability is installed and invoked on each supported platform, **Then** it creates a PRD without requesting any Kona-only or missing guidance file.
2. **Given** a repository with an explicit PRD location convention, **When** no output path is supplied, **Then** the capability uses that convention; **Given** no such convention, **When** no output path is supplied, **Then** it uses `specs/<feature-slug>/prd.md`.
3. **Given** an explicit output path from the user, **When** it differs from the default or repository convention, **Then** the capability uses the explicit path.
4. **Given** a brief missing a material user, problem, outcome, or delivery-boundary decision that cannot be discovered locally, **When** drafting begins, **Then** the capability asks one grouped set of focused questions before writing.
5. **Given** a complete brief and discoverable repository context, **When** drafting begins, **Then** the capability writes without asking the user to repeat discoverable facts.
6. **Given** an existing destination and no explicit update intent, **When** the capability is asked to create a PRD, **Then** it does not overwrite the file and asks for confirmation.
7. **Given** an existing PRD with confirmed decisions, **When** the user requests a targeted refinement, **Then** the revised document preserves unaffected confirmed decisions and identifies any consequential scope change.
8. **Given** the same creation and refinement fixtures on OpenCode, Codex, Claude Code, and Pi, **When** outputs are evaluated, **Then** each contains the same required product decisions, scope boundaries, and pass/fail acceptance outcomes, with no platform-specific procedure changing those results.
9. **Given** a change to the canonical procedure or any adapter, **When** repository checks run, **Then** they fail until the recorded canonical-source hash is current and automated adapter payload/contract parity passes; release remains blocked until manual real-model semantic parity evidence is current for every supported host.
10. **Given** a completed PRD, **When** final validation runs, **Then** it contains no required reference to a nonexistent local file, no application code or implementation task list, and no unsupported factual claim presented as confirmed.
11. **Given** a repository without its own PRD template, **When** the agent creates a PRD, **Then** it uses the skill's built-in lean template without requiring any separate guideline file.
12. **Given** a feature with no concrete metrics, instrumentation, compliance, branch, epic, reference, FAQ, or appendix need, **When** the agent creates a PRD, **Then** the result still contains the required lean-core decisions and omits those heavyweight or empty optional contents.
13. **Given** the PRD capability is installed and invoked, **When** the workflow completes, **Then** it has created or refined only the agreed PRD and has not planned implementation, run tasks, modify application code, or invoke unrelated Kona capabilities.
14. **Given** a trusted project with Pi installed, **When** the Kona package is installed project-locally with `pi install git:github.com/open-treasury/kona -l`, **Then** Pi discovers and can invoke the PRD capability from the repository-root package manifest without a pre-existing Kona checkout.
15. **Given** each supported host and a clean fixture home and repository, **When** Kona is installed at project scope and separately at user scope, **Then** the host discovers the PRD capability only at the selected scope and verification reports the correct version and invocation.
16. **Given** unrelated host configuration or an existing destination, **When** installation would modify or replace it, **Then** the installer shows the conflict and makes no change without explicit confirmation.
17. **Given** an installed older Kona version and existing authored PRDs, **When** the host's documented update path runs, **Then** only Kona-owned capability resources change, the host reports the new version, and the PRDs and user-owned configuration remain unchanged. Claude Code fixtures cover configured marketplace auto-updates; Pi fixtures cover both unpinned updates and pinned-source reinstallation.
18. **Given** an installed capability on each host, **When** the user disables it, **Then** it is unavailable for invocation but remains installed; **When** the user re-enables it, **Then** invocation is restored; **When** the user removes it, **Then** its owned resources are deleted and unrelated configuration and authored PRDs remain intact.
19. **Given** the same installation command is run twice for the same host, scope, and version, **When** the second run completes, **Then** it reports an already-current installation without duplicate entries or changed files.
20. **Given** a collaborator opens a repository with a project-scoped Claude Code installation but has not registered the Kona marketplace, **When** bootstrap or verification runs, **Then** it explains and performs the required marketplace registration before plugin installation, subject to user approval.
21. **Given** the PRD capability is active at one scope, **When** the user attempts to activate it at another scope on the same host, **Then** installation reports both scopes and remains blocked until the existing installation is disabled or removed; updates and removal affect only the explicitly selected scope.
22. **Given** a supported macOS or Linux environment with `curl`, a SHA-256 utility, and Node.js 20+, **When** the user runs the documented one-line installer, **Then** it verifies a versioned GitHub Release archive and installs `kona` under the user's home without `sudo`; a checksum mismatch or unowned destination leaves the prior installation unchanged.

### Success Metrics & Growth

- **Target outcome / lever:** activation, measured before release by successful real-model completion of representative create-and-refine checks on all four supported platforms.
- **Baseline:** unknown; measure before release.
- **Input evidence:** automated per-platform install, invocation, payload, and write-contract checks plus manual real-model semantic reviews.
- **Guardrails:** no silent overwrite; no missing required runtime reference; no duplicated canonical procedure in adapters; no unrelated file edits in fixture runs.
- **Instrumentation:** no product telemetry is required for the first release. Test and evaluation artifacts provide the evidence because this is a local authoring capability and no business metric has been established.
- **Measurement plan:** run automated payload/contract checks after canonical-procedure changes and manual cross-host real-model create/refine dogfood before release.

### Risks

| Risk                                              | Required mitigation                                                                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Platform adapters drift                           | Keep one canonical procedure and gate changes with automated provenance and adapter payload/contract parity checks.           |
| Discovery becomes indiscriminate                  | Read only context relevant to the requested feature and summarize material evidence rather than copying the repository.       |
| Questions become a mandatory intake form          | Ask only about material unknowns that cannot be discovered; proceed with explicit non-blocking unknowns.                      |
| Lean output becomes vague                         | Require concrete requirements, scope boundaries, risks, and acceptance outcomes even when optional sections are omitted.      |
| Repository content injects unrelated instructions | Apply the host's instruction hierarchy and treat untrusted embedded or external text as evidence, not executable direction.   |
| Migration breaks current users                    | Retain a thin compatibility entry point until all four platform fixtures pass, then remove the duplicated canonical guidance. |

## 7. Out of Scope

1. Changes to existing Kona pursuit planning, graph authoring, execution, orchestration, hooks, workflow CLI commands, or executor agents.
2. General-purpose product management, roadmap, prioritization, research, analytics, or compliance systems.
3. Mandatory business metrics, telemetry, experimentation, compliance review, branch metadata, or epic metadata for every PRD.
4. Application implementation, technical design documents, task breakdowns, code review, or test execution beyond validating the PRD capability itself.
5. Support for coding-agent platforms other than OpenCode, Codex, Claude Code, and Pi in the first release.
6. Byte-identical generated PRDs across platforms; semantic parity is evaluated through manual real-model release dogfood instead.
7. Automatically rewriting existing repositories to adopt Kona's preferred directory layout.
8. A Kona-specific background update service; host-native update behavior remains supported and documented.

## 8. References

- `.opencode/agents/prd-writer.md` — current Kona-specific PRD writer and migration source.
- `guidelines/docs/prd.md` — migration input whose useful structure moves into the canonical skill before this file is deleted.
- `plugin/` — existing Claude Code plugin packaging patterns; its plan/run behavior is outside this PRD.
- `eval/gen/check-drift.ts` and `eval/gen/provenance.json` — existing provenance gate to adapt conceptually.
- [Pi packages](https://pi.dev/docs/latest/packages) — package manifest and bundled resource conventions for the Pi adapter.
- [Pi usage](https://pi.dev/docs/latest/usage) — project-local install, update, remove, list, configuration, and project-trust behavior.
- [Pi security](https://pi.dev/docs/latest/security) — trust requirement for loading project-local resources and packages.
- [OpenCode CLI](https://opencode.ai/docs/cli/) and [plugins](https://opencode.ai/docs/plugins/) — plugin installation and project/global resource discovery.
- [Codex skills](https://developers.openai.com/codex/skills/) — project and user skill discovery, configuration, and lifecycle conventions.
- [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference) — plugin scopes, listing, disablement, and installation lifecycle.
- [Kona releases](https://github.com/open-treasury/kona/releases) — source of versioned CLI installer, archive, and checksum assets.

## 9. FAQs

**Is this the overall Kona plugin?**
No. It is the first portable capability and only establishes packaging foundations needed by the PRD agent.

**Must every generated PRD use Kona's current numbered template?**
The built-in default is a lean adaptation of that numbered template. An explicit user format or established repository convention takes precedence, and irrelevant optional sections are not added as ceremony.

**What happens when a repository has no PRD convention?**
The capability uses `specs/<feature-slug>/prd.md` and creates the destination directory when needed.

**Are metrics or compliance sections forbidden?**
No. They are included when the feature or repository creates a concrete need, but they are not universal ceremony.

**Can adapters add platform-specific behavior?**
Only behavior required for host discovery, invocation, permissions, or output plumbing. They cannot redefine the PRD method.

**Can Kona be installed for one project or for all projects?**
Yes. Every supported host must offer project and user scopes through its native conventions. Installation must report and verify the selected scope.

## 10. Appendix

### Decision record

| Status     | Decision                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Locked** | Primary users are product and engineering teams.                                                                                                                |
| **Locked** | Default workflow is context discovery, focused questions, then draft and refine.                                                                                |
| **Locked** | PRDs use a lean core; extra sections require a concrete need.                                                                                                   |
| **Locked** | The PRD template moves into the canonical skill, after which `guidelines/docs/prd.md` is deleted.                                                               |
| **Locked** | First-release platforms are OpenCode, Codex, Claude Code, and Pi.                                                                                               |
| **Locked** | The Claude marketplace source is `https://github.com/open-treasury/kona`, named `kona`.                                                                         |
| **Locked** | The canonical Pi source is `git:github.com/open-treasury/kona`; the repository-root `package.json` declares `./plugin/skills/prd`.                              |
| **Locked** | The single public executable is `kona`; lifecycle uses `kona install`, `update`, `verify`, `disable`, `enable`, and `remove`.                                   |
| **Locked** | Every host supports project and user installation, version-aware updates, verification, disable/re-enable, and safe removal.                                    |
| **Locked** | One self-contained canonical procedure powers thin adapters.                                                                                                    |
| **Locked** | Normal use has no dependency on separate Kona guideline or meta-authoring files.                                                                                |
| **Locked** | Scope excludes Kona plan/run/execution features.                                                                                                                |
| **Locked** | No analytics or telemetry. The PRD capability is offline; only explicit installation and native package-manager operations may access approved release sources. |
| **Open**   | None blocking. Exact adapter file layout and generation mechanism are implementation choices subject to the requirements above.                                 |

### Migration and removal constraints

| Existing surface                 | Required end state                                                                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.opencode/agents/prd-writer.md` | A thin OpenCode adapter replaces its independently maintained procedure; duplicated workflow text is removed only after parity passes.                                                               |
| `guidelines/docs/prd.md`         | Migrate its useful structure and scannability rules into `plugin/skills/prd/templates/prd.md`, remove broken and heavyweight requirements, verify the canonical template, then delete the guideline. |
| Missing or meta-only references  | Runtime requirements do not include `docs/agent-toolkit/02-writing-agents.md`, `docs/pm/`, `docs/compliance/one-way-doors.md`, a separate `writing-prds` skill, or a `write-prd` command.            |
| Platform adapters                | All four are generated or provenance-tracked derivatives of the canonical procedure rather than manually independent workflows.                                                                      |
| Pi package                       | Root `package.json` declares `./plugin/skills/prd` and `pi-package` discoverability so normal and project-local installs work directly from the Kona git source.                                     |
| Compatibility entry point        | Existing invocation remains available until creation, refinement, installation, and parity fixtures pass; removal does not delete authored PRDs.                                                     |

### One-way-door review and unavailable guidance

- Portable prompt behavior becomes a versioned user dependency, so behavioral changes and adapter parity require review before release.
- The capability writes documentation only, preserves existing files unless update intent is explicit, and adds no independent data retention, identity, authorization, synchronization, migration, or irreversible external-effect behavior.
- `docs/compliance/one-way-doors.md` is unavailable in this repository; no compliance review is claimed.
- `docs/pm/` and its referenced product-metrics guidance are unavailable. This PRD therefore uses acceptance-suite evidence and does not invent a business baseline or telemetry requirement.
