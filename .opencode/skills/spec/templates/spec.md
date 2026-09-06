# <Feature Name> Technical Specification

> Keep this document scannable. Prefer comparison and current-state tables, tight bullets, and short
> paragraphs. Remove all instructional text and placeholders before finishing.
> Label material statements as Confirmed, Recommended, or Unresolved where their status is not clear.

## 0. TL;DR

Write this section last. State the selected approach, key architectural decisions, the main trade-off,
and any blocking unresolved decision in a short, scannable summary.

## 1. Meta Information

| Field  | Value                                   |
| ------ | --------------------------------------- |
| Branch | <Branch, when applicable>               |
| Epic   | <Epic, when applicable>                 |
| PRD    | <Link to governing PRD or requirements> |
| Status | <Confirmed, Recommended, or Unresolved> |

Remove inapplicable optional rows rather than retaining placeholders.

## 2. Context

Summarize the confirmed product outcome, technical scope, and architecture context. Identify any
material unresolved requirement instead of inventing product scope.

## 3. Key Technical Drivers

| Driver                   | Why it matters           | Evidence or status                             |
| ------------------------ | ------------------------ | ---------------------------------------------- |
| <Constraint or priority> | <Effect on the decision> | <`file:line`, confirmed source, or Unresolved> |

## 4. Current State

Describe only the current architecture, components, interfaces, data behavior, and constraints that
affect this decision.

| Surface                 | Current behavior                  | Evidence      |
| ----------------------- | --------------------------------- | ------------- |
| <Component or boundary> | <Relevant behavior or limitation> | <`file:line`> |

## 5. Considered Options

Compare credible, meaningfully distinct choices against criteria derived from the technical drivers.
Do not include a straw option merely to make the preferred choice appear inevitable.

| Option     | Approach       | Advantages            | Costs and risks         | Driver fit         | Decision           |
| ---------- | -------------- | --------------------- | ----------------------- | ------------------ | ------------------ |
| <Option A> | <How it works> | <Meaningful benefits> | <Meaningful trade-offs> | <Fit by criterion> | <Select or reject> |
| <Option B> | <How it works> | <Meaningful benefits> | <Meaningful trade-offs> | <Fit by criterion> | <Select or reject> |

State the selected option explicitly as Confirmed or Recommended. Explain why it best satisfies the
drivers and why each other viable option was rejected.

## 6. Proposed Solution

Explain how the selected solution satisfies the technical drivers. State architecture decisions,
interfaces, data behavior, security, operations, and migration behavior when relevant.

### 6.1. Components

| Component or boundary | Responsibility                  | Key decisions                              | Evidence or status                                   |
| --------------------- | ------------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| <Component>           | <What it owns and does not own> | <Interfaces, data, or technology decision> | <Confirmed, Recommended, Unresolved, or `file:line`> |

### 6.2. Pros, Cons, and Consequences

- **Pros:** <Advantages of the selected solution>
- **Cons:** <Limitations and costs>
- **Consequences:** <Operational, migration, maintenance, compatibility, or future implications>

## 7. Testing Strategy

Implementation follows TDD using RED-GREEN-REFACTOR: first add a failing behavior-focused test,
make the smallest change that passes, then refactor while the suite remains green.

### 7.1. Unit Tests

- <Unit boundary and critical behavior, including important failure cases>

### 7.2. Integration Tests

- <Integration boundary and behavior across components, APIs, persistence, or infrastructure>

## 8. Definition of Done

Use objectively verifiable criteria. Derive universal checks from actual repository instructions and
scripts; do not invent commands or requirements that the repository does not provide.

### Universal

- [ ] <Applicable repository-wide test, type, lint, format, build, or documentation check with evidence>
- [ ] The SPEC reflects consequential implementation changes.

### Feature-Specific

- [ ] <Observable completion criterion for this solution>
- [ ] <Critical failure, compatibility, migration, security, or operability criterion>

## 9. Alternatives Not Chosen

| Alternative   | Why rejected                                        | Reconsider when             |
| ------------- | --------------------------------------------------- | --------------------------- |
| <Alternative> | <Specific rationale tied to drivers and trade-offs> | <Changed condition, if any> |

## 10. References

| Reference                                                                    | Relevance                       |
| ---------------------------------------------------------------------------- | ------------------------------- |
| <Repository `file:line`, PRD, decision record, or validated external source> | <Decision or claim it supports> |
