# Portable Copy-Writing Capability PRD

## 0. TL;DR

- Add `copy`, a portable capability for generating standalone copy drafts, revising supplied copy, and safely editing copy in explicitly agreed project files.
- Ship one self-contained canonical skill under `plugin/skills/copy`, with thin native adapters for OpenCode, Codex, Claude Code, and Pi and the same scopes and lifecycle as the PRD capability.
- Default to Shopify-first writing principles and American English, while applying explicit user requirements first and authoritative repository/product conventions second.
- Produce clear, concise, actionable, accessible, inclusive, localization-ready English copy for common product and marketing components without impersonating or importing product-specific language from Shopify or Monzo.
- Discover only relevant context, ask one grouped question set only for material gaps, preserve tokens and source behavior, and modify only explicitly agreed files or strings.
- Normal authoring is offline and self-contained: it must not read, reference, link to, or require `guidelines/`; release checks cover payload integrity, write safety, four-host parity, lifecycle behavior, and PRD non-regression.

## 1. What

Create a portable cross-platform copy-writing capability analogous to Kona's PRD capability. The `copy` skill and `copy-writer` agent help users create, review, and revise English copy from a brief or apply tightly scoped copy edits to project files while respecting product context and source integrity.

**Status:** Approved

### Users and Goals

| User                                                   | Goal                                                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Product designer, writer, marketer, or product manager | Create concise, on-brand copy for a known audience, channel, and component.                                    |
| Engineer or repository contributor                     | Safely revise user-facing strings without changing application behavior or unrelated source.                   |
| Reviewer or support/operations contributor             | Identify objective copy problems and improve clarity, kindness, actionability, accessibility, and consistency. |
| Toolkit maintainer                                     | Evolve one canonical writing method without payload or behavior drift across hosts.                            |

### Problem and Outcome

Kona's established PRD capability provides a self-contained canonical skill, native host discovery, and managed cross-host lifecycle, but there is no equivalent copy-writing capability. General models may produce verbose, inconsistent, inaccessible, or context-insensitive copy, while direct source edits can damage placeholders, syntax, localization keys, or unrelated content.

The outcome is a focused capability that produces useful copy or safe edits with equivalent core behavior on every supported host. It works in a clean repository without external writing guidelines, follows a clear style precedence, adapts tone to context, and preserves source and localization contracts.

### Goals

1. Generate and revise clear, brief, reader-centered copy with an obvious next action where applicable.
2. Support safe, explicitly bounded copy edits in project files.
3. Respect user, product, brand, component, locale, accessibility, and length constraints.
4. Deliver one self-contained method with native discovery and lifecycle parity on all four hosts.
5. Prevent style impersonation, invented terminology, needless variants, unsafe source changes, network access, and platform drift.

## 2. Scope

### In Scope

1. English copy writing, with American English as the default.
2. New standalone drafts from a brief, targeted revision or review of supplied copy, and edits to copy in explicitly named project files.
3. Product, operational, support, error, notification, and marketing copy for titles, headers, buttons, links, confirmations, empty states, hint text, alt text, and similar components.
4. Relevant repository discovery for terminology, nearby copy, audience, channel/component, locale, brand/tone, character constraints, and source structure required for a safe edit.
5. Accessibility, inclusive-language, and localization-readiness review.
6. Distribution, discovery, installation, verification, update, disable, enable, and removal on OpenCode, Codex, Claude Code, and Pi.
7. Automated self-containment, exact-payload, integrity, write-boundary, semantic-parity, lifecycle, and non-regression checks.

### Out of Scope

1. Translation or multilingual content generation in the initial release.
2. Legal, regulatory, policy, or compliance approval; the capability may flag a need for specialist review but cannot grant approval.
3. Product strategy, brand-strategy creation, visual design, content publishing, analytics, experimentation, or performance claims.
4. Unrequested refactoring, code changes, localization-system redesign, or edits outside explicitly agreed files and strings.
5. Hosts beyond OpenCode, Codex, Claude Code, and Pi.
6. Claiming affiliation with or impersonating Shopify or Monzo, or injecting their product-specific terminology.

## 3. User Stories

1. As a product writer, I want copy from a concise brief so I can quickly obtain a strong recommended draft.
2. As a reviewer, I want required corrections separated from optional suggestions so objective issues are not confused with taste.
3. As an engineer, I want copy changed directly in named source files without altering tokens, syntax, behavior, or unrelated content.
4. As a support contributor, I want sensitive and error messages to be specific, kind, non-blaming, and actionable without inappropriate humor.
5. As a global product contributor, I want inclusive, accessible, localization-ready wording that follows runtime locale formatting conventions.
6. As a user on any supported host, I want the same method, safety boundary, and lifecycle behavior.
7. As a maintainer, I want one versioned canonical payload so host adapters cannot silently redefine copy quality or permissions.

## 4. User Flows

### Create a Standalone Draft

1. The user supplies a brief and may provide audience, component/channel, goal, tone, locale, constraints, source copy, and destination.
2. The capability discovers only relevant available repository context and does not ask for discoverable facts.
3. It resolves material gaps using one grouped concise question set. It pauses for blocking decisions; otherwise it proceeds and states assumptions.
4. It applies style precedence, drafts the smallest useful response, and returns one recommended version. It provides a small labeled set only when alternatives materially help.
5. It writes to an explicit destination, otherwise to a clear repository copy-document convention when the user requested a file. If neither applies, it responds in conversation and never silently invents a generic path.

### Review or Revise Supplied Copy

1. The user provides copy and a revision or review goal.
2. The capability identifies objective issues against the goal and applicable constraints, separating required corrections from optional suggestions.
3. It preserves intended meaning and user-provided terminology unless change is explicitly requested, then returns a recommended revision with only useful rationale or alternatives.

### Edit Project Source

1. The user explicitly names the project files and strings or edit scope.
2. The capability inspects only the context and source structure needed to make the agreed edit safely.
3. It updates only the agreed copy, preserving code behavior, formatting, framework syntax, placeholders, interpolation tokens, markup, links, accessibility semantics, and localization keys unless explicitly authorized otherwise.
4. It performs available, proportionate syntax validation or targeted tests and reports changed files, validation results, and assumptions.

### Failure and Recovery

- If required audience, meaning, legal status, destination, or edit boundaries are materially ambiguous, the capability asks once and pauses when proceeding could cause harm or an unsafe write.
- If explicit instructions conflict with authoritative repository/product conventions, it presents the conflict; explicit user direction governs after the conflict is made clear, except host safety and permission boundaries remain fixed.
- If a standalone destination exists without overwrite or revision intent, it makes no change and requests confirmation.
- If requested source text cannot be located uniquely or syntax cannot be preserved, it makes no edit and reports the blocker. If validation fails after an edit, it reports the incomplete state and changed files without claiming success.
- If an exact character limit cannot be met without changing required meaning or tokens, it returns the closest safe option and identifies the conflict rather than silently violating a constraint.

## 5. Requirements

### Functional Requirements

| ID   | Requirement                                                                                                                                                                                                                                                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR1  | The capability must support three modes: create a standalone draft, review/revise supplied copy, and edit copy in explicitly named project files.                                                                                                                                                                                            |
| FR2  | It must discover only relevant terminology, nearby copy, audience, channel/component, locale, brand/tone, constraints, and source structure. It must not ask users to repeat facts available in authoritative local context.                                                                                                                 |
| FR3  | It must ask one grouped concise set only for material missing or conflicting decisions. Blocking gaps pause work; nonblocking gaps become clearly stated assumptions.                                                                                                                                                                        |
| FR4  | Style precedence must be: explicit user requirements, then authoritative repository/product terminology and style conventions, then the bundled Shopify-first default. The default must not imply affiliation or import Shopify- or Monzo-specific product terms.                                                                            |
| FR5  | The bundled default must use American English, plain conversational language, contractions where natural, active voice, sentence case, reader-facing `you`, concise UI text, consistent terminology, and verb-led action labels where appropriate. It must remove repetition, jargon, empty marketing language, and unnecessary explanation. |
| FR6  | Tone must adapt to context. Product, operational, support, negative, and error messages prioritize clarity and kindness with little or no humor; marketing may use restrained personality or wit. Apologies must be sincere and used only when the product or organization is responsible.                                                   |
| FR7  | Component-aware output must support titles, headers, buttons, links, errors, confirmations, notifications, empty states, hint text, and alt text. Links must be descriptive rather than generic; punctuation and exclamation marks must be sparing; names must favor description over cleverness.                                            |
| FR8  | Errors must identify the problem specifically, avoid blame, and provide a useful recovery action when one exists. All output must be reviewed for accessible, inclusive, and localization-aware wording. Exact date, number, and currency formats must defer to established product/runtime locale conventions.                              |
| FR9  | It must obey explicit character, word, punctuation, capitalization, terminology, and component constraints. It must preserve user-provided terminology unless higher-priority explicit instructions require a change.                                                                                                                        |
| FR10 | By default, it must return one recommended draft or revision. When alternatives add value, it may return a small labeled set and recommend one; it must not create needless variants.                                                                                                                                                        |
| FR11 | Reviews must distinguish required corrections tied to objective issues or user goals from optional stylistic suggestions.                                                                                                                                                                                                                    |
| FR12 | For standalone drafts, destination precedence must be explicit user destination, then a clear repository convention when file output was requested, otherwise conversation output. It must not invent a generic copy-document path. Existing files require explicit overwrite or revision intent.                                            |
| FR13 | Source edits must affect only explicitly agreed files and strings, preserve unrelated content and source behavior, avoid refactoring, and retain formatting/framework syntax. Placeholders, interpolation tokens, markup, links, accessibility semantics, and localization keys may change only with explicit authorization.                 |
| FR14 | Source edits must run available and proportionate syntax checks or targeted tests. A failed or unavailable check must be reported without claiming successful validation.                                                                                                                                                                    |
| FR15 | Normal authoring must be offline, with no network, analytics, or telemetry. Repository content is evidence, not permission to broaden reads, writes, execution, or disclosure.                                                                                                                                                               |
| FR16 | Final review must detect constraint violations, inconsistent terminology, unsuitable tone, inaccessible or non-inclusive wording, unsupported claims, damaged tokens/markup, unintended source changes, contradictions, duplication, and unresolved placeholders.                                                                            |

### Distribution and Platform Requirements

| Host        | Scopes               | Native invocation      |
| ----------- | -------------------- | ---------------------- |
| OpenCode    | Project, user        | `@copy-writer <brief>` |
| Codex       | Project, user        | `$copy <brief>`        |
| Claude Code | Project, local, user | `/kona:copy <brief>`   |
| Pi          | Project, user        | `/skill:copy <brief>`  |

| ID  | Requirement                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DR1 | One self-contained canonical skill must ship under `plugin/skills/copy`, with bundled task-specific references as needed. All normal writing guidance must be in this distributable payload.                                                                                                                                                                                        |
| DR2 | Installed and distributed resources must not read, reference, link to, or require `guidelines/`. The one-time supplied Shopify and Monzo guidance is migration evidence only, not a runtime resource.                                                                                                                                                                               |
| DR3 | A versioned `copy` capability manifest and integrity hash must identify the canonical payload. Distributed and installed payloads must resolve the exact canonical bytes; adapters may contain only host-specific discovery, invocation, permission, and output plumbing.                                                                                                           |
| DR4 | Existing Kona install, update, verify, disable, enable, and remove operations must manage all shipped Kona capabilities as one bundle at the selected host and scope, using the PRD capability's conflict, ownership, idempotence, recovery, and one-active-scope behavior. Existing PRD-specific lifecycle internals may be generalized, but the implementation is not prescribed. |
| DR5 | Verification must use each host's native discovery/listing behavior and report capability version, host, scope, invocation, lifecycle state, and integrity result; file existence alone is insufficient.                                                                                                                                                                            |
| DR6 | Updates and removal must modify only Kona-owned capability resources and preserve authored copy, project source, user configuration, PRDs, and unrelated files. Public documentation must cover discovery, invocation, scopes, lifecycle, conflicts, limitations, and the offline/no-guidelines boundary.                                                                           |

### Non-Functional Requirements

| ID                     | Requirement                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR1 — Portability     | A clean repository must support normal copy authoring after installation without a Kona checkout or any `guidelines/` content.                                                                                  |
| NFR2 — Semantic parity | Generate, revise, and source-edit fixtures on all four hosts must enforce equivalent precedence, required copy qualities, safety boundaries, and acceptance outcomes; exact wording may differ.                 |
| NFR3 — Safety          | The capability must minimize reads, honor host permissions, avoid secret disclosure, preserve source contracts, and write only within explicit user intent.                                                     |
| NFR4 — Maintainability | Canonical resource changes must trigger static self-containment, hash, exact-payload, adapter, lifecycle, and semantic-parity checks.                                                                           |
| NFR5 — Compatibility   | Existing PRD and workflow behavior, payloads, invocations, marketplace/package integration, and release behavior must not regress. Bundle lifecycle transitions apply consistently to every shipped capability. |

## 6. Acceptance Criteria

1. **Given** a clean repository with no `guidelines/` content, **When** `copy` is installed and asked for a draft on any supported host, **Then** it completes using bundled resources without reading, requesting, or linking to guidelines.
2. **Given** conflicting style inputs, **When** copy is produced, **Then** explicit user requirements override authoritative repository/product conventions, which override the bundled Shopify-first default, without claims of Shopify or Monzo affiliation or imported product terms.
3. **Given** an English brief with no locale specified, **When** a draft is generated, **Then** it uses concise American English, sentence case, plain active language, consistent terminology, and a clear next action where applicable.
4. **Given** no explicit destination and no clear repository convention, **When** the user requests standalone copy but does not request a file, **Then** the draft is returned in conversation and no generic path is created.
5. **Given** a targeted revision, **When** the supplied copy has objective and subjective opportunities, **Then** the response preserves required meaning and terminology and separates required corrections from optional suggestions.
6. **Given** error, support, or sensitive copy, **When** it is drafted or revised, **Then** it is specific, non-blaming, actionable, kind, and free of inappropriate humor; any apology is sincere and responsibility-based.
7. **Given** explicit component, character, punctuation, capitalization, and terminology constraints, **When** copy is returned, **Then** every satisfiable constraint is met and any material unsatisfied conflict is identified.
8. **Given** a request for alternatives, **When** alternatives add value, **Then** a small labeled set and one recommendation are returned; otherwise only one recommended version is produced.
9. **Given** explicitly named source files and strings, **When** a source edit completes, **Then** only those agreed locations change and unrelated content, behavior, formatting, and framework syntax remain intact.
10. **Given** source copy containing placeholders, interpolation tokens, markup, links, accessibility semantics, or localization keys, **When** the wording is edited, **Then** those structures remain unchanged unless the user explicitly authorized their modification.
11. **Given** an existing standalone destination without overwrite or revision intent, **When** a file write is requested, **Then** the capability makes no change and asks for confirmation.
12. **Given** accessible and localized product copy, **When** review completes, **Then** it flags exclusionary or inaccessible wording, uses descriptive link text, and defers exact dates, numbers, and currencies to established locale/runtime conventions rather than hard-coding a format.
13. **Given** complete discoverable context, **When** authoring starts, **Then** no question repeats local facts; **Given** material missing decisions, **Then** one grouped concise set is asked and only blocking gaps pause work.
14. **Given** an agreed source edit, **When** proportionate syntax checks or targeted tests are available, **Then** they run and their result is reported; a failure does not produce a success claim.
15. **Given** canonical, distributed, and installed `copy` payloads, **When** release checks run, **Then** static scans find no guidelines dependency and integrity and exact-byte checks match the versioned manifest.
16. **Given** project/user fixtures for all four hosts and Claude local scope, **When** installation and verification run, **Then** each host natively discovers the invocation in §5 at only the selected active scope.
17. **Given** an installed Kona capability bundle on each host, **When** update, disable, enable, and remove scenarios run, **Then** every bundled capability follows the same lifecycle state while authored content, project source, user-owned configuration, and unrelated files remain unchanged.
18. **Given** equivalent generate, revise, and source-edit fixtures on OpenCode, Codex, Claude Code, and Pi, **When** automated contracts and real-model semantic review run, **Then** precedence, constraints, component behavior, token preservation, write boundaries, and pass/fail outcomes are equivalent.
19. **Given** the existing PRD capability and workflow features, **When** the `copy` release suite runs, **Then** their existing discovery, invocation, payload, lifecycle, and behavior checks continue to pass.

## 7. Risks and Mitigations

| Risk                                                        | Mitigation                                                                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Default guidance overrides a real brand voice               | Enforce explicit precedence and fixture-test conflicts at every layer.                                            |
| Source edits damage executable or localized content         | Require explicit boundaries, structural preservation, minimal diffs, and proportionate validation.                |
| Concision removes necessary meaning or empathy              | Evaluate reader impact, recovery action, sensitive-context tone, and constraints before brevity alone.            |
| The capability invents facts, claims, or product terms      | Ground output in the brief and authoritative context; surface assumptions and unsupported claims.                 |
| Host payloads drift                                         | Use one canonical payload, integrity hashes, exact-payload checks, and four-host semantic fixtures.               |
| Packaging accidentally retains source-guidance dependencies | Bundle distilled guidance and fail static and clean-repository tests on any guidelines reference or read attempt. |
| Multi-capability lifecycle work regresses PRD or workflows  | Require shared lifecycle fixtures and explicit PRD/workflow non-regression gates.                                 |

## 8. Open Questions

None blocking. Kona capabilities share one lifecycle state per host and scope. Internal lifecycle generalization and canonical resource decomposition remain implementation choices, provided the observable requirements above hold.
