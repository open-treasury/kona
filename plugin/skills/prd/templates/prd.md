# <Feature Name> PRD

> Keep this document scannable. Prefer tight bullets, numbered lists, and tables over dense prose.
> Remove all instructional text and placeholders before finishing.

## 0. TL;DR

Write this section last. In a short, scannable summary, state what is being built, why it matters,
the initial delivery cut, important confirmed decisions, and any blocking unresolved decision.

## 2. What

Describe the product change and smallest useful delivery cut in two to four sentences.

### In Scope

- <Included capability, behavior, user, or platform>

## 3. Motivation

### Problem

Describe the user need or problem and why it matters.

### Goals

1. <Observable product outcome>

### Users

| User          | Need                         |
| ------------- | ---------------------------- |
| <Target user> | <Need served by this change> |

## 4. User Stories

1. As a <role>, I want <goal> so that <benefit>.

## 5. User Flow

1. <Trigger or starting condition>
2. <User interaction and observable system response>
3. <Successful outcome>

Describe material failure and recovery paths when they affect the product contract.

## 6. Definition of Done

### Functional Requirements

| ID  | Requirement                                    |
| --- | ---------------------------------------------- |
| FR1 | <Observable behavior the product must provide> |

### Non-Functional Requirements

Include only qualities that materially constrain the product, such as accessibility, security,
privacy, reliability, or performance. Remove this subsection when none apply.

| ID   | Requirement                   |
| ---- | ----------------------------- |
| NFR1 | <Testable product constraint> |

### Acceptance Criteria

1. Given <precondition>, When <action>, Then <observable outcome>.

### Risks

| Risk                                           | Mitigation            |
| ---------------------------------------------- | --------------------- |
| <Material product, delivery, or adoption risk> | <Required mitigation> |

## 7. Out of Scope

1. <Explicitly excluded capability, edge case, user, or platform>

<!-- Add Meta Information, References, FAQs, or Appendix only when they provide concrete value. -->
