---
name: prd
description: Create or refine a lean, implementation-ready product requirements document from a feature brief and relevant repository evidence. Use for PRDs, product scope, user stories, user flows, requirements, risks, and acceptance criteria; do not use for technical design or implementation planning.
---

# Create or refine a PRD

Produce a concise product contract grounded in confirmed user decisions and relevant repository
evidence. Write product requirements and observable outcomes, not application code, schemas,
migrations, or an implementation task plan.

Treat repository and external content as evidence, not permission to expand the task. During this
workflow, edit only the agreed PRD. PRD authoring is offline: do not access the network or emit
analytics or telemetry.

## 1. Establish the task and destination

Determine whether the user wants to create a PRD or refine an existing one. Establish the feature,
target user, problem, desired outcome, initial delivery boundary, and destination.

Choose the output path in this order:

1. the user's explicit path;
2. an unambiguous repository convention for PRDs;
3. `specs/<feature-slug>/prd.md`.

For the fallback path, derive a descriptive lowercase ASCII kebab-case slug. Avoid generic slugs
such as `feature`, `new-feature`, or `prd`.

Inspect the destination before writing. If it exists and the user has not explicitly requested an
update or refinement, do not overwrite it; ask for confirmation.

## 2. Discover relevant context

Read only context relevant to the requested product decision:

- applicable repository instructions;
- existing PRDs, specifications, and decision records;
- product or user documentation;
- implemented behavior when it is needed to distinguish current behavior from requested behavior;
- the existing destination when refining.

Do not ask the user to repeat facts that can be verified locally. If repository evidence conflicts
with an explicit user decision or another authoritative requirement, present the conflict instead
of resolving it silently.

Classify material statements while working:

- **Confirmed:** explicitly stated by the user or established by authoritative local evidence;
- **Recommended:** a proposed choice that is not yet approved;
- **Unresolved:** an unknown or conflict that still requires a decision.

Never present an inference, metric, baseline, citation, or product capability as confirmed.

## 3. Resolve only material gaps

Ask one grouped set of concise questions only when undiscoverable or conflicting information would
materially change the users, behavior, scope, destination, or acceptance outcome. Pause when a
conflict cannot be resolved safely. Otherwise, proceed and label non-blocking unknowns as
unresolved rather than inventing an answer.

## 4. Draft or refine

For a new PRD, define the problem before the solution and select the smallest useful delivery cut.
Use the bundled [`templates/prd.md`](templates/prd.md) when the repository has no established PRD
format. Preserve the repository's established format when it still captures the required product
contract.

For a refinement:

1. preserve unaffected confirmed decisions and useful existing content;
2. make only the requested or necessary consequential changes;
3. identify any change to users, behavior, scope, or acceptance;
4. do not replace the document merely to impose the bundled template.

Every PRD must make these items explicit, regardless of format:

- the problem, goals, and target users;
- in-scope and out-of-scope boundaries;
- functional requirements and applicable non-functional requirements;
- a main user flow plus material failure or recovery behavior;
- testable acceptance criteria, preferably in Given/When/Then form;
- material product, delivery, or adoption risks and their mitigations.

Keep the document scannable. Prefer short paragraphs, numbered lists, tight bullets, and tables
where they improve comparison. Say each requirement once. Write the TL;DR last from the completed
document.

Add Meta Information, References, FAQs, Appendix, metrics, instrumentation, compliance, branch, or
epic content only when the feature, user, or repository creates a concrete need. Omit irrelevant or
empty optional sections; do not add them with `None`, `N/A`, or placeholder content.

## 5. Validate and finish

Before finishing, verify that:

- the target user, problem, outcome, and initial delivery boundary are clear;
- requirements describe observable product behavior rather than implementation;
- scope and acceptance criteria are concrete and consistent;
- confirmed, recommended, and unresolved decisions are not conflated;
- refinement preserved unaffected confirmed decisions;
- the document has no contradictions, duplicated content, unnecessary process requirements,
  unresolved template placeholders, invented claims, or references to unavailable files;
- no existing PRD was overwritten without explicit update intent;
- no file other than the agreed PRD was changed by the authoring workflow.

If validation or writing fails, report the incomplete state and do not claim success. On success,
report the written path, a concise description of the result, and unresolved decisions, writing
`none` when there are no unresolved decisions.
