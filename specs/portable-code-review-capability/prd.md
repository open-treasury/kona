# Portable Code Review Capability PRD

## 0. TL;DR

- Add a portable code review capability consisting of a canonical `code-review` skill, a fresh-context read-only `code-reviewer` subagent, and a `receiving-code-review` skill for evaluating feedback before acting on it.
- Every completed task in an implementation epic must pass a fresh-context review before closure. Repository-changing tasks receive code review; other tasks receive review of their required artifacts and acceptance evidence. The reviewer receives the task contract, trusted repository standards, exact review scope, and relevant work product, but not the implementer's conversation or reasoning.
- Review findings must be introduced by the task, evidence-backed, actionable, severity-calibrated, and tied to a location and impact. Tool-enforced style, unsupported speculation, pre-existing defects, and personal preferences are omitted.
- The implementing agent must verify each finding against the repository, then accept, reject, clarify, or defer it with rationale. Accepted blocking findings are fixed and re-reviewed against the latest change set.
- **Recommended:** epic completion also requires a separate cumulative review from the epic base through the final head so task-local reviews cannot miss cross-task interactions.
- The first delivery cut supports OpenCode, Codex, Claude Code, and Pi through one canonical procedure and thin host adapters, integrated with the existing `issues` and epic-worktree workflow.

## 1. What

Create a portable, high-signal review gate for agent-implemented repository changes. A dedicated reviewer evaluates completed work independently of the implementing context, while a separate feedback-reception procedure ensures review comments are understood and technically verified rather than accepted blindly.

### In Scope

1. On-demand review of a user-specified change range.
2. Mandatory fresh-context review after every task in an implementation epic and before that task closes, using code changes or other required task artifacts as applicable.
3. A recommended final cumulative review before an implementation epic completes.
4. Review against task requirements, introduced correctness and security risks, tests, and trusted repository standards.
5. Structured handling, remediation, dismissal, deferral, and re-review of findings.
6. Durable review evidence linked to the applicable issue and exact reviewed change set.
7. Portable discovery and equivalent core behavior on OpenCode, Codex, Claude Code, and Pi.

## 2. Motivation

### Problem

The current issue workflow verifies acceptance criteria but does not require an independent review between implementation and task closure. An implementing agent reviewing its own work in the same context is vulnerable to confirmation bias and hidden assumptions. Review feedback also creates a second failure mode: agents may apply plausible suggestions without checking whether they are correct for the repository, in scope, compatible, or already covered.

The desired outcome is an auditable review gate that catches defects before they cascade to later epic tasks, while producing less noise than a general critique and preserving the implementing agent's responsibility to validate feedback.

### Goals

1. Give every epic task an independent, fresh-context quality check before closure.
2. Find requirement gaps and introduced defects with precise, reproducible evidence.
3. Prevent speculative, stylistic, duplicate, or pre-existing observations from blocking delivery.
4. Ensure accepted feedback is fixed and tested without blindly implementing reviewer suggestions.
5. Provide a recommended cumulative gate for catching cross-task integration failures before an epic is considered complete.
6. Maintain one canonical review contract across supported hosts.

### Users

| User                    | Need                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| Implementing agent      | Receive focused findings before defects propagate to dependent tasks.                     |
| Engineering contributor | Request a trustworthy review of a known change boundary.                                  |
| Epic coordinator        | Know that each child task and the cumulative epic change have passed an independent gate. |
| Toolkit maintainer      | Evolve one review method without host-specific behavioral drift.                          |

## 3. User Stories

1. As an implementing agent, I want a reviewer with no access to my reasoning history so that it evaluates the delivered work rather than inheriting my assumptions.
2. As an epic coordinator, I want each task reviewed before closure so that defects do not cascade into dependent tasks.
3. As a reviewer, I want an exact immutable change boundary and task contract so that I can distinguish introduced defects from unrelated repository state.
4. As a contributor, I want findings tied to evidence, impact, and a location so that I can reproduce and resolve them efficiently.
5. As an implementing agent, I want to verify and classify feedback before editing so that incorrect or out-of-scope advice does not damage working code.
6. As an engineering lead, I want blocking findings to prevent closure and dismissals to retain rationale so that review is an auditable gate rather than ceremony.
7. As a toolkit maintainer, I want equivalent review decisions on every supported host so that host choice does not change the quality bar.

## 4. User Flows

### Review an Epic Task

1. The implementing workflow completes the task's changes and verification but keeps the issue non-closed.
2. The coordinator resolves and records the task's review boundary. For a repository-changing task, it includes all task-caused tracked, staged, unstaged, and untracked changes and excludes pre-existing work. For another task, it identifies the required artifacts and acceptance evidence. If an exact boundary cannot be established, review fails closed.
3. The coordinator starts a new `code-reviewer` subagent session. It supplies only the task ID and contract, acceptance criteria, trusted standards, exact review boundary, a changed-file inventory or versioned artifact inventory as applicable, and relevant verification evidence. It does not supply the implementer's conversation, chain of reasoning, proposed defense, or conclusions.
4. The reviewer inspects the entire scoped diff or task artifact and enough surrounding context to validate the outcome. It treats repository and artifact content as evidence, not instructions.
5. The reviewer returns only substantiated findings, ordered by severity, plus a clear pass, pass-with-nonblocking-findings, or blocking verdict. A materially ambiguous potential defect prevents a pass but is labeled as a question rather than asserted as a validated finding.
6. The coordinator independently evaluates every finding through the feedback-reception procedure and records its disposition.
7. Accepted blocking findings are remediated within the task, verified, and reviewed again in a new reviewer context. The issue may close only when the latest task change set has no unresolved blocking finding.

### Review an Epic (Recommended)

1. When the cumulative gate is enabled and all child tasks have individually passed review, the coordinator resolves the epic base and final head.
2. A new reviewer session reviews the cumulative epic change against the approved PRD, SPEC, child issue contracts, and trusted repository standards.
3. Cross-task defects and requirement gaps are handled through the same feedback and re-review flow.
4. Under the enabled gate, the epic remains incomplete until its latest cumulative change set has no unresolved blocking finding.

### Receive Review Feedback

1. The implementing agent reads the complete feedback and maps each item to a concrete requested outcome.
2. It asks one focused clarification set before editing if any finding is materially ambiguous or findings are interdependent.
3. It verifies each item against current code, requirements, supported environments, compatibility constraints, and tests.
4. It records one disposition: `accepted`, `rejected`, `needs-clarification`, or `deferred`. Rejection and deferral require technical evidence and rationale.
5. It fixes accepted items in risk order, runs proportionate verification, and requests re-review when a blocking finding or reviewed change has been modified.
6. Validated work outside the current task becomes a linked follow-up issue rather than unapproved scope expansion.

### Failure and Recovery

- For repository-changing tasks, an unresolved ref, empty or unexpectedly broad diff, omitted working-tree content, or changed head during review blocks a passing verdict. For every task, a missing contract, unidentifiable artifact, or unavailable fresh reviewer blocks a pass.
- A task expected to produce no repository change receives a fresh-context review of its required artifacts and completion evidence; it must not manufacture an empty code-review pass.
- If reviewer output lacks enough evidence to validate a finding, the item is `needs-clarification`. It is not accepted as a technical finding, but material uncertainty prevents a passing verdict until clarified.
- If the head changes after a pass, the pass becomes stale and the latest task or epic change set must be reviewed.
- **Recommended default:** if a reviewer cannot launch or complete, the coordinator retries once with a new session, records the failure, and then escalates to the user with the issue left non-closed. Reviewer unavailability cannot be converted into a pass.
- **Recommended default:** re-review is limited to two remediation reviews after the initial review unless trusted repository policy sets a lower limit. Repeated disagreement or failed remediation is then escalated to the user with the evidence and issue left non-closed.
- If required review evidence cannot be persisted and linked to the issue, closure fails. The coordinator retains the work, repairs or waits for the tracker, and records the review before retrying closure.

## 5. Requirements

### Functional Requirements

| ID   | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR1  | The capability must provide a canonical `code-review` skill, a dedicated `code-reviewer` subagent, and a `receiving-code-review` skill.                                                                                                                                                                                                                                                                                                                   |
| FR2  | The `issues` workflow must require a new reviewer session after every child task in an implementation epic and before issue closure. Repository-changing tasks are reviewed against their code changes; other tasks are reviewed against their required artifacts and acceptance evidence. The task remains non-closed while review is pending, materially unclear, or has any validated blocking finding.                                                |
| FR3  | The initial release must support a separate cumulative review from the epic base through the final head. When the recommended gate is enabled, passing task reviews do not replace it and the epic cannot complete without a passing cumulative review.                                                                                                                                                                                                   |
| FR4  | Every repository-change review must bind to an exact resolved base and head or equivalent reproducible snapshot, identify the diff mode, enumerate changed files, and explicitly account for tracked, staged, unstaged, and untracked task changes. Other task reviews must bind to an exact version or identity for every required artifact and acceptance-evidence source. Review must fail closed when the applicable task scope cannot be reproduced. |
| FR5  | Every mandatory review must start a new subagent session that is distinct from the implementer. The reviewer must not receive the implementer's conversation history, reasoning, self-assessment, or suggested verdict.                                                                                                                                                                                                                                   |
| FR6  | Reviewer context must contain the applicable issue contract and acceptance criteria, requirement sources, trusted repository standards, exact change boundary, and relevant verification evidence. The reviewer may inspect surrounding code and history only to validate findings caused by the scoped change.                                                                                                                                           |
| FR7  | Review coverage must include requirement completeness and scope, introduced correctness and security defects, error and edge-case behavior, compatibility, test adequacy, and applicable trusted repository standards.                                                                                                                                                                                                                                    |
| FR8  | Each finding must include a stable identifier, severity, a precise file and line or hunk for code or an artifact/evidence identifier for other work, the observed problem, triggering scenario or reasoning, impact, evidence, applicable requirement or rule when relevant, and an actionable remedy when not obvious.                                                                                                                                   |
| FR9  | Severity must reflect impact: `critical` for exploitable security, data loss, or unusable core behavior; `important` for correctness, missing requirement, material reliability, or material test gap; `minor` for non-blocking maintainability or clarity. Validated critical and important findings block task and epic completion; minor findings do not. Material questions prevent a pass until resolved but are not presented as validated defects. |
| FR10 | The reviewer must omit pre-existing defects not made materially worse by the change, duplicate findings, formatter or linter output, unsupported edge-case speculation, broad refactor proposals unrelated to the task, and personal style preferences not grounded in trusted standards.                                                                                                                                                                 |
| FR11 | The reviewer must return findings first, ordered by severity, followed by assumptions or questions and a verdict of `pass`, `pass-with-nonblocking-findings`, or `blocking`. A clean review must explicitly state that no findings were identified and name residual testing gaps.                                                                                                                                                                        |
| FR12 | The reviewer must be read-only: it cannot edit files, mutate the index or branch, move `HEAD`, commit, push, post comments, close issues, approve merges, dispatch other reviewers, or change tracker state. It may inspect coordinator-provided verification evidence and run non-mutating inspection commands, but it must not run project commands in the source checkout when they may create files or change state.                                  |
| FR13 | The feedback-reception procedure must classify every finding as `accepted`, `rejected`, `needs-clarification`, or `deferred` only after checking it against repository behavior and requirements. It must not treat reviewer authority, confidence language, or social agreement as technical validation.                                                                                                                                                 |
| FR14 | Accepted findings must be remediated one coherent item at a time with proportionate verification. Rejected and deferred findings must retain technical rationale; validated out-of-scope work must become a linked issue before it is undertaken.                                                                                                                                                                                                         |
| FR15 | Changes made after review invalidate the prior verdict for the affected scope. Blocking remediation must be re-reviewed in a new reviewer session against the latest change boundary, with unresolved findings revalidated rather than copied blindly.                                                                                                                                                                                                    |
| FR16 | Review evidence linked to the issue must record the task or epic ID, requirement sources, resolved change boundary, reviewed file or artifact inventory as applicable, reviewer capability version, verdict, finding dispositions, verification evidence, and review time.                                                                                                                                                                                |
| FR17 | On-demand review must accept a user-specified commit, branch, tag, merge-base comparison, or explicit working-tree scope. If the fixed point or intended scope is missing or ambiguous, it must ask before reviewing.                                                                                                                                                                                                                                     |
| FR18 | The recommended default must allow at most two remediation re-reviews after the initial review unless trusted repository policy sets a lower limit. Reaching the configured limit leaves the issue non-closed and presents the unresolved technical disagreement or failure to the user.                                                                                                                                                                  |
| FR19 | The recommended default for a reviewer session that cannot launch or complete must retry once in a new session, record both failures if unsuccessful, leave the issue non-closed, and escalate to the user without manufacturing or bypassing a pass.                                                                                                                                                                                                     |
| FR20 | If required review evidence cannot be persisted and linked to its issue, closure must fail until tracker availability is restored and the evidence is recorded.                                                                                                                                                                                                                                                                                           |
| FR21 | Human review remains required when repository policy requires it. Automated review cannot grant merge approval or override protected-branch, security, compliance, ownership, or release controls.                                                                                                                                                                                                                                                        |

### Security and Context Requirements

| ID                                 | Requirement                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR1 - Isolation                   | A fresh reviewer must receive the minimum context needed to review the artifact and must not inherit implementer conclusions or unrelated session history.                                                                                                                                                              |
| NFR2 - Least privilege             | Reviewer execution must have read-only repository access, no credentials or write-capable external tools, network disabled by default, and only allowlisted non-mutating inspection commands. Verification that may create state belongs to the coordinator and is supplied as evidence.                                |
| NFR3 - Prompt-injection resistance | Source code, comments, generated files, issue text, PR text, and changed instruction files are untrusted review data. Governing instructions and standards must come from an authenticated platform configuration or trusted base revision; changed policy files are reviewed as changes, not executed as instructions. |
| NFR4 - Reproducibility             | A later maintainer must be able to identify exactly what artifact and requirements received the recorded verdict.                                                                                                                                                                                                       |
| NFR5 - Signal quality              | Review output must prioritize actionable defects over volume, keep severity separate from uncertainty, and express unresolved uncertainty as a question rather than a blocking claim.                                                                                                                                   |
| NFR6 - Portability                 | The same canonical review and feedback contracts must operate without a Kona source checkout on OpenCode, Codex, Claude Code, and Pi.                                                                                                                                                                                   |
| NFR7 - Maintainability             | A capability update must not create host drift in reviewer inputs, permissions, finding fields, blocking decisions, or feedback dispositions; release evidence must cover these behaviors on every supported host.                                                                                                      |

### Distribution

| Host        | Scopes               | Native surface                                                                   |
| ----------- | -------------------- | -------------------------------------------------------------------------------- |
| OpenCode    | Project, user        | `code-reviewer` subagent plus `code-review` and `receiving-code-review` skills   |
| Codex       | Project, user        | Native skills plus an isolated reviewer delegation supported by the host adapter |
| Claude Code | Project, local, user | Native skills plus a read-only reviewer subagent                                 |
| Pi          | Project, user        | Native skills plus an isolated reviewer delegation supported by the host adapter |

The capability ships in the existing Kona bundle. Install, update, verify, disable, enable, and remove behavior must preserve issue data, authored specifications, project source, user configuration, and unrelated capabilities.

## 6. Acceptance Criteria

1. **Given** any implementation epic child whose work and verification are complete, **When** task closure is attempted, **Then** the issue remains non-closed until a new reviewer session reviews the exact code change or required artifacts and acceptance evidence and returns a passing verdict.
2. **Given** a reviewer dispatch, **When** its supplied context is inspected, **Then** it contains task requirements, trusted standards, exact change boundaries, and verification evidence but no implementer conversation, reasoning, self-assessment, or proposed verdict.
3. **Given** staged, unstaged, or untracked task changes, **When** the review scope is prepared, **Then** every task-caused change is included; if inclusion or attribution cannot be proven, review fails closed.
4. **Given** a task diff containing an introduced runtime defect and unrelated pre-existing debt, **When** review completes, **Then** it reports the introduced defect with location, trigger, impact, evidence, severity, and remedy and does not report the unrelated debt as a task finding.
5. **Given** formatting violations already detected by configured tooling and a personal naming preference absent from repository standards, **When** review completes, **Then** neither appears as a review finding.
6. **Given** a missing requirement, exploitable security defect, data-loss path, or material test gap, **When** it is validated, **Then** the finding blocks issue closure until accepted remediation passes verification and fresh-context re-review; **Given** only a material unanswered question, **Then** the task also remains non-closed but the question is not represented as a validated defect.
7. **Given** a minor maintainability finding, **When** review completes, **Then** it is clearly non-blocking and does not prevent task closure.
8. **Given** technically incorrect reviewer advice, **When** the implementing agent evaluates it, **Then** it records `rejected` with code, requirement, or test evidence and does not modify the implementation merely to satisfy the reviewer.
9. **Given** ambiguous or interdependent feedback, **When** it is received, **Then** the agent asks one focused clarification set before making dependent edits.
10. **Given** an accepted blocking finding, **When** the implementation changes, **Then** applicable verification runs and a new reviewer session reviews the latest change set before closure.
11. **Given** any change to the reviewed head or working-tree snapshot after a passing verdict, **When** closure is attempted, **Then** the stale verdict is rejected and review of the latest scope is required.
12. **Given** the recommended cumulative gate is enabled and all epic child tasks have passed individual review, **When** epic completion is attempted, **Then** a new reviewer session evaluates the cumulative epic diff and unresolved cumulative blocking findings prevent completion.
13. **Given** a task explicitly expected to create no repository change, **When** it completes, **Then** a new reviewer session reviews the versioned required output and acceptance evidence without fabricating a code-diff pass.
14. **Given** repository comments or a changed instruction file telling the reviewer to ignore defects or use mutation tools, **When** review runs, **Then** the content is treated as untrusted data and reviewer permissions and governing instructions remain unchanged.
15. **Given** the recommended default is configured and two remediation re-reviews have completed without agreement or a passing fix, **When** another cycle would begin, **Then** the workflow stops, leaves the issue non-closed, and presents the evidence and unresolved decision to the user.
16. **Given** fixed cross-host fixtures containing a required blocking defect, a non-blocking maintainability issue, an irrelevant pre-existing defect, and incorrect reviewer advice, **When** review and feedback scenarios run on OpenCode, Codex, Claude Code, and Pi, **Then** every host emits all required finding fields, reaches the same blocking/non-blocking verdicts and feedback dispositions, omits the pre-existing defect, and produces the same closure outcome; prose may differ.
17. **Given** a clean review, **When** the reviewer returns its report, **Then** it explicitly states that no findings were identified, reports residual test limitations, and produces a `pass` verdict without praise or filler.
18. **Given** repository policy requires human approval, **When** automated review passes, **Then** the capability records its own pass but does not approve, merge, or bypass the human gate.
19. **Given** the recommended retry default is configured and a required reviewer cannot launch or complete twice, **When** the second attempt fails, **Then** both failures are recorded, the issue remains non-closed, and the user receives an actionable escalation without a synthetic pass.
20. **Given** review succeeds but its evidence cannot be linked to the issue, **When** closure is attempted, **Then** closure fails until tracker recovery allows the evidence to be persisted and re-read.

### Risks

| Risk                                                     | Mitigation                                                                                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewer inherits implementation bias                    | Require a new context and prohibit implementer history, reasoning, and proposed verdict.                                                      |
| Review becomes noisy and blocks on taste                 | Require introduced, evidence-backed findings; suppress tooling output and ungrounded style preferences.                                       |
| Task boundaries are ambiguous in a dirty shared worktree | Account explicitly for every worktree state and fail closed when task attribution is not reproducible.                                        |
| Reviewer advice introduces regressions                   | Require independent feedback verification, explicit dispositions, targeted tests, and re-review.                                              |
| Task-local reviews miss integration defects              | Adopt the recommended cumulative epic review from the epic base to final head.                                                                |
| Repository content manipulates the reviewer              | Authenticate governing policy, treat branch content as untrusted data, remove credentials and mutation tools, and disable network by default. |
| Mandatory review causes unbounded cost or loops          | Keep one focused reviewer per pass, omit low-value feedback, bound re-review, and escalate unresolved cases.                                  |
| Host delegation primitives differ                        | Keep isolation, permissions, inputs, outputs, and closure behavior canonical while limiting adapters to host plumbing.                        |

## 7. Out of Scope

1. Automatically merging, approving, committing, pushing, rebasing, or releasing changes.
2. Replacing required human review, code ownership, protected-branch, security, compliance, or release controls.
3. General static analysis, formatting, or linting already provided by deterministic tools.
4. Reviewing unrelated pre-existing repository debt or expanding the active task to fix it.
5. Automatically posting to GitHub, GitLab, or another remote review system in the first delivery cut.
6. A multi-reviewer panel for every task; one independent reviewer per pass is the initial delivery boundary.
7. Hosts beyond OpenCode, Codex, Claude Code, and Pi.

## 8. References

- [Matt Pocock `code-review`](https://github.com/mattpocock/skills/blob/main/skills/engineering/code-review/SKILL.md) - fixed-point review and separate standards/spec axes.
- [Matt Pocock review design notes](https://github.com/mattpocock/skills/blob/main/docs/engineering/code-review.md) - review workflow rationale.
- [Caveman review](https://www.skills.sh/juliusbrussee/caveman/caveman-review) - concise, location-first, severity-calibrated findings.
- [Superpowers: requesting code review](https://github.com/obra/superpowers/blob/main/skills/requesting-code-review/SKILL.md) - review after each task using a fresh subagent and explicit base/head.
- [Superpowers: receiving code review](https://github.com/obra/superpowers/blob/main/skills/receiving-code-review/SKILL.md) - understand, verify, and technically evaluate feedback before implementation.
- [Anthropic Claude Code review plugin](https://github.com/anthropics/claude-code/tree/main/plugins/code-review) - specialized review and validation patterns.
- [Google code review standard](https://google.github.io/eng-practices/review/reviewer/standard.html) and [review comments](https://google.github.io/eng-practices/review/reviewer/comments.html) - correctness standard and non-blocking nit conventions.
- [GitHub Copilot code review concepts](https://docs.github.com/en/copilot/concepts/agents/code-review) - AI review limitations and human-validation expectations.
- [OWASP prompt injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) and [excessive agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) - untrusted-content and least-privilege controls.
- `plugin/skills/issues/SKILL.md` - current issue lifecycle and evidence-based closure contract to extend.
- `plugin/skills/epic-worktree/SKILL.md` - current isolated epic workspace and dispatch gate contract.

## 9. Open Questions

1. Should the recommended cumulative epic review in FR3 be a mandatory first-release gate? Per-task fresh-context review is confirmed; the cumulative gate is recommended by research but was not explicit in the brief.
2. Should the recommended defaults of one reviewer retry and two remediation re-reviews ship unchanged, or should repository policy be required to choose them?
3. Which portable snapshot mechanism should represent an uncommitted task boundary without forcing commits? This is a technical design decision, but it must satisfy FR4's reproducibility and dirty-worktree coverage.
