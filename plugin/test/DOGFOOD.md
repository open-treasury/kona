# Copy, PRD, and SPEC Skill Dogfood Evidence

## 2026-09-04 - OpenCode 1.18.29

- **Model:** `gpt-5.6-sol`
- **Create prompt:** Create a concise PRD for manual CSV export of the currently filtered account activity table.
- **Create output:** `specs/sample-export/prd.md` in an isolated repository.
- **Create result:** Passed semantic review; only the requested PRD was written.
- **Refine prompt:** Review the portable PRD agent PRD against its approved technical specification.
- **Refine output:** `specs/portable-prd-agent-plugin/prd.md`.
- **Refine result:** Found one CLI scope contradiction. After correction, a second review returned `PASS` with no additional writes.

This is real-model dogfood evidence, not part of the deterministic parity suite.

## 2026-09-04 - Codex 0.153.3

- **Model:** `gpt-5.6-sol`
- **Create prompt:** Create a concise PRD for manual CSV export of currently filtered account activity, excluding scheduling and non-CSV formats.
- **Create output:** `specs/sample-export/prd.md` in an isolated repository.
- **Create result:** Passed semantic review; Codex loaded the installed `$prd` skill and wrote only the requested PRD.
- **Refine prompt:** Add a confirmed UTC filename timestamp requirement and acceptance coverage while preserving unrelated content.
- **Refine result:** Updated only the user flow, existing filename requirement, and acceptance criteria; unrelated decisions remained unchanged.

## 2026-09-04 - Claude Code 2.1.257

- **Model:** Claude Code default model; text mode did not report the model identifier.
- **Create prompt:** Create a concise PRD for manual CSV export of currently filtered account activity, excluding scheduling and non-CSV formats.
- **Create output:** `specs/sample-export/prd.md` in an isolated repository.
- **Create result:** Passed semantic review; `/kona:prd` loaded from the plugin and wrote only the requested PRD.
- **Refine prompt:** Confirm UTC filename timestamps and add acceptance coverage while preserving unrelated content.
- **Refine result:** Updated only the related requirement, acceptance coverage, and resolved open question; unrelated decisions remained unchanged.

## Remaining

Pi create/refine dogfood is deferred with user approval because Pi has no configured model-provider credentials in this environment. It remains a pre-release check owned by the release maintainer. Deterministic Pi package, discovery, and lifecycle tests pass at the pinned version without model calls.

### Copy Run Matrix (12 Required Runs)

No copy real-model run has been performed or evidenced. Every row below is pending and blocks the
copy release. The deterministic copy contracts and safety fixtures are not substitutes for these
semantic runs.

| Host        | Mode        | Status  | Required evidence when run                                                                              |
| ----------- | ----------- | ------- | ------------------------------------------------------------------------------------------------------- |
| OpenCode    | Generate    | Pending | Host/model versions, prompt, payload hash, output, operations, validation, and human rubric assessment. |
| OpenCode    | Revise      | Pending | Host/model versions, prompt, payload hash, output, operations, validation, and human rubric assessment. |
| OpenCode    | Source-edit | Pending | Host/model versions, prompt, payload hash, diff, approvals, validation, and human rubric assessment.    |
| Codex       | Generate    | Pending | Host/model versions, prompt, payload hash, output, operations, validation, and human rubric assessment. |
| Codex       | Revise      | Pending | Host/model versions, prompt, payload hash, output, operations, validation, and human rubric assessment. |
| Codex       | Source-edit | Pending | Host/model versions, prompt, payload hash, diff, approvals, validation, and human rubric assessment.    |
| Claude Code | Generate    | Pending | Host/model versions, prompt, payload hash, output, operations, validation, and human rubric assessment. |
| Claude Code | Revise      | Pending | Host/model versions, prompt, payload hash, output, operations, validation, and human rubric assessment. |
| Claude Code | Source-edit | Pending | Host/model versions, prompt, payload hash, diff, approvals, validation, and human rubric assessment.    |
| Pi          | Generate    | Pending | Host/model versions, prompt, payload hash, output, operations, validation, and human rubric assessment. |
| Pi          | Revise      | Pending | Host/model versions, prompt, payload hash, output, operations, validation, and human rubric assessment. |
| Pi          | Source-edit | Pending | Host/model versions, prompt, payload hash, diff, approvals, validation, and human rubric assessment.    |

## 2026-09-05 - SPEC Writer

The SPEC writer used the same isolated notification-digest fixture on each available host. The
fixture contained an approved PRD, a four-line immediate-delivery implementation, and repository
test/typecheck/lint scripts. The create prompt required a durable daily batching decision with
retry-safe exactly-once inclusion. The refinement prompt added a confirmed 100-event cap with
durable next-digest overflow and required preservation of unrelated decisions.

| Host        | Version / model                    | Create result                                                                                                                                                                                                                                                           | Refinement result                                                                                                                                                         | Write-scope evidence                                                                                                                                                                                                                                                                         |
| ----------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode    | 1.18.29 / `gpt-5.6-sol`            | Passed. The installed `spec` skill produced a decision-oriented SPEC with current-state citations, three credible options, an explicit relational durable-batch selection, consequences, RED-GREEN-REFACTOR boundaries, DoD, and unresolved provider/storage decisions. | Passed. Updated only the existing SPEC with the cap, transactional FIFO overflow behavior, failure semantics, tests, and DoD.                                             | PRD, `src/digest.ts`, and `package.json` retained their original SHA-256 hashes. The non-interactive CLI cannot select a subagent as the primary agent, so it fell back to the default agent, which loaded the installed `spec` skill and delegated the draft to the discovered SPEC writer. |
| Codex       | 0.153.3 / configured default model | Passed. `$spec` loaded the installed canonical skill and selected a transactional ledger with immutable batches and provider idempotency.                                                                                                                               | Passed. Preserved unrelated decisions and added bounded FIFO overflow only to consequential architecture, recovery, tests, and DoD.                                       | Only `specs/digest/spec.md` changed; fixture input hashes match OpenCode and Claude.                                                                                                                                                                                                         |
| Claude Code | 2.1.257 / configured default model | Passed. `/kona:spec` loaded from the plugin and selected an outbox with a run-scoped atomic claim, comparing three rejected alternatives.                                                                                                                               | Passed. Added one bounded-claim decision, deterministic overflow ordering, failure behavior, tests, and DoD while retaining security, compatibility, and retry decisions. | Only `specs/digest/spec.md` changed; fixture input hashes match OpenCode and Codex.                                                                                                                                                                                                          |

Semantic review passed for all six available-host runs. Wording and internal decomposition differed,
but each output made drivers, viable options, a selected durable design, external-delivery limits,
consequences, unit/integration tests, repository-derived checks, and unresolved decisions explicit.
All three refinements retained the immediate security-alert path, no-preference compatibility, stable
retry identity, and unrelated alternatives.

### SPEC Writer Remaining Release Evidence

Pi 0.85.0 was installed into an isolated temporary prefix, and the no-skip release-validation matrix
passes for its project and user lifecycles. This environment has no configured Pi model-provider
credentials: `pi auth check` reports `credentials_not_configured` for OpenAI, Anthropic, Google, and
OpenCode. The two required Pi real-model runs therefore remain blocking release evidence; release
mode continues to reject host skips.
