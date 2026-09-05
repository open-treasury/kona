# PRD Skill Dogfood Evidence

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
