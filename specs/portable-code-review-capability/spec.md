# Portable Code Review Capability Technical Specification

## 0. TL;DR

- **SPEC status: Approved.** The user approved the sibling [PRD](./prd.md), including the recommended cumulative epic gate, one infrastructure retry, and two remediation re-reviews.
- Add one composite `code-review` capability containing `code-review` and `receiving-code-review` skills, one canonical reviewer contract, a private snapshot helper, and host-specific read-only `code-reviewer` adapters where the host supports named agents.
- Capture task boundaries without commits: a Node.js 20+ helper stores content-addressed pre/post manifests and only the necessary non-HEAD bytes in protected user-local state, then emits a deterministic scope digest and review patch.
- Serialize repository-changing children within one epic worktree for the initial release. Non-writing work may remain parallel. Ambiguous or intervening mutation fails closed rather than guessing attribution.
- Keep issue statuses unchanged. Persist structured review records as issue comments, mirror pass/fail into the advertised `br` `code_review` gate when available, and re-read the exact record and current scope immediately before closure.
- Reviewers receive immutable task inputs and read-only repository access, never implementer history, credentials, network, shell, writes, tracker mutation, or nested delegation.
- Append the capability to the existing Kona bundle, advance ownership schema 5 to schema 6 and release version `0.6.0`, and preserve schemas 1-5 exactly through explicit update.

## 1. Meta Information

| Field       | Value                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| SPEC status | Approved                                                                                                                                  |
| PRD         | [Portable Code Review Capability PRD](./prd.md), approved by the user                                                                     |
| Scope       | Review orchestration, reviewer isolation, snapshot boundaries, issue gates, feedback reception, distribution, migration, and verification |
| Runtime     | Node.js 20+ ESM, built-ins and Git CLI only for the private helper                                                                        |
| Release     | `0.6.0`, ownership schema 6                                                                                                               |

## 2. Context

Kona currently distributes five capabilities as one lifecycle bundle: copy, PRD, SPEC, issues, and epic-worktree. Canonical skills are manifest-hashed, copied or natively discovered per host, included in deterministic releases, and owned by one host/scope installation (`plugin/lib/capability-registry.mjs:74-80`, `plugin/lib/plugin-lifecycle.mjs:22-50`). The registry assumes one public skill directory and at most one adapter per capability, which cannot represent two review skills plus a reviewer agent (`plugin/lib/capability-registry.mjs:26-72,82-113`).

The issues workflow currently verifies acceptance criteria and then closes the issue; it has no independent review step (`plugin/skills/issues/SKILL.md:134-153`). Epic worktrees may remain dirty between tasks, and their current `statusDigest` hashes porcelain status rather than file contents, so it cannot establish which bytes one task introduced (`plugin/skills/epic-worktree/scripts/epic-worktree.mjs:1457-1464`). The installed `br 0.5.2` exposes structured issue comments and `gate report`/`gate list`, but a gate becomes backend-enforced only when repository policy requires it.

User approval resolves the PRD's product questions as follows:

1. Cumulative review is mandatory before epic completion.
2. Reviewer infrastructure is retried once in a new session, then escalated.
3. At most two remediation re-reviews follow the initial review.
4. Uncommitted task boundaries must not require or imply commit authority.

## 3. Technical Drivers

| Driver               | Required property                                                                                                                                      | Evidence                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Independence         | Every pass uses a new reviewer context without implementer reasoning or prior verdicts.                                                                | `prd.md:64-72,104-111`                        |
| Exact scope          | Review includes task-caused staged, unstaged, tracked, deleted, renamed, binary, symlink, and non-ignored untracked changes without requiring commits. | `prd.md:67,92,109,153-155`                    |
| Signal quality       | Findings are introduced, evidence-backed, actionable, severity-calibrated, and distinct from questions or deterministic-tool output.                   | `prd.md:70,112-116,156-159`                   |
| Security             | Repository content is untrusted; reviewer authority is read-only and externally enforced.                                                              | `prd.md:117,128-138,166`                      |
| Closure integrity    | Review evidence is durable, current, issue-linked, and checked before task or epic closure.                                                            | `prd.md:95,107,120-125,162-172`               |
| Portability          | The same review inputs, outputs, blocking policy, and feedback dispositions work on all four hosts.                                                    | `prd.md:136-149,168`                          |
| Bundle compatibility | Existing capabilities and ownership schemas retain their meaning and safe lifecycle.                                                                   | `plugin/lib/plugin-lifecycle.mjs:22-50`       |
| Determinism          | Canonical payloads, adapters, scope manifests, releases, and validation evidence are reproducible.                                                     | `plugin/scripts/release-lib.mjs:6-29,122-175` |

## 4. Current State

| Surface              | Current behavior                                                                                                                                          | Consequence                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability registry  | Kinds encode fixed one-skill shapes and one optional adapter (`plugin/lib/capability-registry.mjs:26-72`).                                                | Generalize descriptors to ordered resources and host surfaces rather than adding another special-case kind.                                                      |
| Static contracts     | Manifests must match registry paths, modes, hashes, versions, scopes, and one invocation (`plugin/scripts/contracts.mjs:27-115`).                         | Validate multiple skill and agent surfaces while preserving strict equality and deterministic order.                                                             |
| Copied hosts         | OpenCode and Codex copy canonical skill directories; OpenCode also receives agent adapters (`plugin/lib/plugin-lifecycle.mjs:237-267`).                   | Copy both review skills; install the OpenCode reviewer adapter separately.                                                                                       |
| Native hosts         | Claude discovers `./skills/`; Pi lists each skill root explicitly (`plugin/.claude-plugin/plugin.json:11-12`, `package.json:8-15`).                       | Add both skill roots. Claude also receives a packaged reviewer agent; Pi dispatches the canonical reviewer contract through its native fresh-subagent mechanism. |
| OpenCode permissions | The epic-worktree adapter demonstrates deny-by-default permissions with one allowlisted tool path (`plugin/hosts/opencode/agents/epic-worktree.md:1-16`). | Reviewer adapters deny all mutation, shell, network, question, and delegation tools; repository inspection uses read/glob/grep only.                             |
| Issue lifecycle      | Verification is immediately followed by closure (`plugin/skills/issues/SKILL.md:134-153`).                                                                | Insert snapshot, review, disposition, remediation, and freshness checks before close.                                                                            |
| Workspace lifecycle  | The issues skill owns `agent_context.kona.workspace` and conflict-safe context writes (`plugin/skills/issues/SKILL.md:101-128`).                          | Preserve that namespace; review records live on child issues, while only an epic-level active-writer marker uses `kona.review`.                                  |
| Quality commands     | Root scripts expose plugin build/validation/tests plus test, typecheck, lint, knip, and format checks (`package.json:23-39`).                             | Use these exact commands in Definition of Done; do not invent a replacement aggregate.                                                                           |

## 5. Considered Options

### 5.1. Capability and Reviewer Shape

| Option                                                                   | Advantages                                                            | Costs and risks                                                                                           | Decision   |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------- |
| One monolithic review skill                                              | Minimal packaging change                                              | Conflates orchestration, independent judgment, and feedback handling; encourages same-context self-review | Reject     |
| Three independent capabilities                                           | Fits current one-skill registry                                       | Splits lifecycle identity and permits incompatible partial installation                                   | Reject     |
| Composite capability with two skills and one canonical reviewer contract | One lifecycle unit, clear responsibilities, portable fresh delegation | Requires registry and manifest generalization                                                             | **Select** |
| Native reviewer implementation per host                                  | Uses host-specific affordances                                        | Four behavior sources drift and differ in safety                                                          | Reject     |

### 5.2. Task Boundary

| Option                                            | Advantages                                                             | Costs and risks                                                                       | Decision          |
| ------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------- |
| Task checkpoint commits                           | Durable native Git diff                                                | Requires commit authority and mishandles pre-existing dirty work                      | Reject as default |
| Temporary Git index/tree objects                  | Compact and Git-native                                                 | Mutates object storage; retention requires refs; filters complicate raw-byte identity | Reject            |
| Text patch only                                   | Simple artifact                                                        | Incomplete for binary files, modes, symlinks, deletes, and untracked content          | Reject            |
| External content-addressed logical-tree snapshots | Exact raw-byte identity without source, index, ref, or object mutation | Adds protected local state, retention, and size controls                              | **Select**        |

### 5.3. Closure Enforcement

| Option                                            | Advantages                                                        | Costs and risks                                                                         | Decision     |
| ------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------ |
| Skill-only prose check                            | Backend-neutral                                                   | Direct tracker closure can bypass it                                                    | Reject alone |
| Required backend gate only                        | Machine-enforced where configured                                 | Gate result does not itself prove current source bytes; policy may be absent            | Reject alone |
| Workflow freshness check plus backend gate/report | Validates exact scope and uses backend enforcement when available | Requires issue record, scope recomputation, and honest limitation when policy is absent | **Select**   |

### 5.4. Reviewer Count

| Option                                        | Advantages                                  | Costs and risks                                                | Decision                   |
| --------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------- | -------------------------- |
| Specialized reviewer panel on every task      | Broader coverage                            | Cost, latency, duplicate findings, and correlated model errors | Reject for initial release |
| One fresh reviewer with risk-triggered checks | Predictable cost and one accountable report | Less independent coverage                                      | **Select**                 |
| Same-context self-review                      | Lowest latency                              | Confirmation bias and context contamination                    | Reject                     |

## 6. Selected Design

### 6.1. Components

| Component                                                    | Responsibility                                                                                                                                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin/skills/code-review/SKILL.md`                         | Resolve review mode and scope, invoke snapshots, assemble minimum reviewer context, dispatch a fresh reviewer, validate its envelope, coordinate dispositions, and enforce review limits.             |
| `plugin/skills/code-review/references/reviewer-contract.md`  | Canonical reviewer role, review axes, finding schema, severity, signal filters, verdict rules, and untrusted-content boundary.                                                                        |
| `plugin/skills/code-review/references/security-checklist.md` | Risk-triggered OWASP/NIST-aligned checks for trust boundaries, auth, input/sinks, secrets, crypto, dependencies, privacy, concurrency, files, SSRF, deserialization, migrations, and secure defaults. |
| `plugin/skills/code-review/scripts/review-snapshot.mjs`      | Private deterministic helper for repository identity, protected content-addressed snapshots, scope diff generation, freshness verification, locking, and retention cleanup.                           |
| `plugin/skills/receiving-code-review/SKILL.md`               | Understand, verify, classify, remediate, test, reject, defer, clarify, and request fresh re-review without performative or blind agreement.                                                           |
| Reviewer adapters                                            | Host-specific metadata and least-privilege tool declarations generated from the canonical reviewer contract. They contain no independent review policy.                                               |
| `plugin/capabilities/code-review.json`                       | Composite modes, ordered canonical resources, derived adapters, scopes, invocations, versions, modes, and hashes.                                                                                     |
| `plugin/skills/issues/SKILL.md`                              | Mandatory pre-closure task review, cumulative pre-finish epic review, source-writer serialization, issue evidence, backend gate reporting, and fail-closed recovery.                                  |
| Registry/lifecycle/release                                   | Model, own, install, verify, disable, remove, and package multiple skill roots and agent surfaces as one capability.                                                                                  |

The public skills remain independently discoverable because feedback may arrive outside a Kona-generated review. The `code-reviewer` is not user-facing implementation authority; only `code-review` dispatches it for a review attempt.

### 6.2. Composite Registry and Manifest

Replace descriptor fields that assume one directory or adapter with normalized ordered collections:

- `canonicalResources`: every canonical skill, reference, and helper path.
- `copiedSkillRoots`: `skills/code-review` and `skills/receiving-code-review` for copied hosts.
- `agentAdapters`: host, source path, destination path, and canonical-source provenance.
- `surfaces`: `code-review`, `receiving-code-review`, and `code-reviewer`, each with kind and host invocation/delegation identity.

Existing descriptors normalize into this model without changing their installed paths or public invocations. Registry order becomes `copy`, `prd`, `spec`, `issues`, `epic-worktree`, `code-review`. Within a capability, resources and surfaces are sorted by their declared stable order, never filesystem enumeration.

The manifest remains strict and typed. It records all canonical and derived resources with SHA-256 and mode, both skill invocations, reviewer delegation identity, supported scopes, and release version. Tests may choose exact JSON field names, but cannot collapse the three public surfaces into one ambiguous invocation.

### 6.3. Host Contracts

| Host        | Installed surfaces                                                                                           | Reviewer isolation                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode    | `code-review`, `receiving-code-review`, and `@code-reviewer` under normal project/user roots                 | Named subagent with `edit`, `bash`, `webfetch`, `question`, `task`, and unrelated skills denied; read/glob/grep only.                        |
| Codex       | `$code-review` and `$receiving-code-review` at project/user scope                                            | Skill starts a fresh subagent and injects the canonical reviewer contract and immutable context; mutation and network tools are unavailable. |
| Claude Code | `/kona:code-review`, `/kona:receiving-code-review`, and packaged `code-reviewer` at project/local/user scope | Native subagent declares only Read, Grep, and Glob tools.                                                                                    |
| Pi          | `/skill:code-review` and `/skill:receiving-code-review` at project/user scope                                | Skill starts a fresh isolated subagent with the canonical contract and read-only inspection tools.                                           |

If a host cannot prove a new context and the required read-only tool boundary, dispatch returns `REVIEWER_UNAVAILABLE`; it never falls back to same-context review. OpenCode and Claude adapters are deterministic derivatives of `reviewer-contract.md`; generation records source and output hashes and CI rejects drift. Codex and Pi pass those exact canonical bytes as the reviewer system/task contract instead of maintaining another prompt.

### 6.4. Snapshot Helper Interface

The private interface is:

```text
node <skill-root>/scripts/review-snapshot.mjs <capture|compare|verify|dispose> --json
```

The helper reads one schema-versioned JSON request from stdin and returns one JSON result. It invokes Git with argv arrays and `shell: false`; it never runs repository hooks, external diff/text-conversion commands, package scripts, or content filters.

```json
{
  "schemaVersion": 1,
  "operation": "capture",
  "repositoryRoot": "/canonical/worktree",
  "epicId": "kona-epic",
  "taskId": "kona-task",
  "phase": "before",
  "explicitIgnoredPaths": []
}
```

`capture` resolves the canonical worktree and common-directory identity, current `HEAD`, index entries, tracked worktree state, non-ignored untracked files, explicit task-authorized ignored files, modes, symlink targets, deletions, and submodule gitlinks. It rejects special files, paths outside the worktree, symlink traversal, unstable files, case-fold collisions, unsupported submodule changes, or any path that changes while being read.

The logical snapshot uses the `HEAD` tree for unchanged tracked content and stores protected content blobs only for staged overrides, modified tracked bytes, untracked files, explicit ignored files, and metadata not represented by `HEAD`. A canonical manifest references every logical path by byte hash, mode, source class, and content source. Canonical JSON SHA-256 is the `snapshotId`.

State lives under `${XDG_STATE_HOME:-$HOME/.local/state}/kona/reviews/<repository-key>/<epic-key>/<task-key>/`, outside the repository and Git common directory. Directories are `0700`; manifests and blobs are `0600`; writes use temporary siblings plus atomic rename under a repository-scoped lock. Repository, epic, and task keys are hashes or normalized identifiers and never raw untrusted paths.

`compare` accepts before/after snapshot IDs, verifies every referenced blob, computes the exact changed-path set, and emits:

- canonical `scopeId = SHA-256(beforeId + afterId + ordered changed-path manifest)`;
- binary-safe path and metadata inventory;
- deterministic text patch for text files;
- before/after hashes and metadata for binary or non-text files;
- explicit exclusions and unsupported entries;
- review context manifest containing Git/helper versions and repository identity.

Patch rendering operates on helper-controlled temporary files and disables external diff, textconv, pager, and repository attributes. The inventory, not patch formatting, is the identity authority.

`verify` recaptures the current logical state and succeeds only when its snapshot ID equals the reviewed after-snapshot ID and repository identity still matches. `dispose` removes task blobs only after issue closure and retains no hidden approval state; the issue record keeps the manifest, scope digest, report, and disposition evidence. Epic cumulative artifacts remain until epic closure. Interrupted cleanup is safe and retryable.

Default limits are 100 MiB per changed file, 1 GiB per snapshot set, and 100,000 logical paths. Exceeding a limit returns `SCOPE_TOO_LARGE`; the user may narrow or separately authorize a higher bounded limit, but the workflow cannot omit files and still pass.

### 6.5. Source-Writer Serialization

Exact pre/post attribution requires one repository writer at a time. Before granting source-edit authority to an epic child, the issues workflow:

1. Passes the existing active-worktree dispatch gate.
2. Re-reads the epic, sibling claims, and complete `agent_context`.
3. Requires no other child to hold the epic's source-writer slot.
4. Conflict-safely records `agent_context.kona.review.activeTask` with task ID, actor, start time, and before-snapshot ID.
5. Re-reads and verifies the complete context before implementation starts.

Non-writing child work may run concurrently but cannot receive source-edit authority. The slot remains through review and remediation and is cleared only after successful closure or an explicit blocked handoff that preserves snapshot evidence. A conflict, unexpected workspace mutation, missing holder, or non-cooperating writer fails attribution and leaves the task non-closed. The protocol does not claim to eliminate races from actors that bypass Kona.

### 6.6. Reviewer Input and Output

The coordinator writes an immutable review context artifact containing only:

- review ID, task/epic ID, attempt number, and `scopeId`;
- exact issue contract and acceptance criteria;
- approved PRD/SPEC references or embedded relevant excerpts;
- trusted standards loaded from authenticated host policy or the reviewed base snapshot;
- changed path/artifact inventory and patch;
- relevant deterministic verification commands and results;
- security triggers selected from the changed interfaces and task contract;
- paths the reviewer may inspect for surrounding context.

It excludes implementer conversation, reasoning, self-review, prior reviewer prose, proposed dispositions, secrets, environment values, unrelated issue history, and untrusted instructions as authority. Changed `AGENTS.md`, skill files, comments, issue text, PR text, generated content, and tool output remain review data.

The reviewer returns one JSON envelope:

```json
{
  "schemaVersion": 1,
  "reviewId": "rvw-...",
  "scopeId": "sha256:...",
  "verdict": "blocking",
  "findings": [
    {
      "id": "rvw-...-F01",
      "severity": "important",
      "category": "correctness",
      "location": { "path": "src/example.ts", "line": 42 },
      "problem": "...",
      "trigger": "...",
      "impact": "...",
      "evidence": ["..."],
      "requirement": "AC4",
      "remedy": "..."
    }
  ],
  "questions": [],
  "residualTestGaps": [],
  "reviewedPaths": ["src/example.ts"]
}
```

Allowed verdicts are `pass`, `pass-with-nonblocking-findings`, and `blocking`. Allowed severities are `critical`, `important`, and `minor`. Uncertain material concerns go in `questions`; they prevent a pass but are not findings. The coordinator rejects malformed envelopes, mismatched IDs, omitted changed paths, duplicate finding identities, invalid severity/verdict combinations, or reports that cite content outside the supplied scope without explaining the integration path.

### 6.7. Review Axes and Standards

Every pass covers:

1. Requirements and scope: missing, partial, incorrect, or unrequested behavior.
2. Correctness and reliability: invariants, boundaries, errors, state transitions, concurrency, retries, idempotency, compatibility, and partial failure.
3. Design and maintainability: responsibility placement, coupling, unnecessary abstraction, comprehensibility, operability, migration, and rollback.
4. Tests and documentation: behavior-focused failure detection, meaningful edge cases, suitable test level, user/API/operations documentation, and honest verification gaps.
5. Performance when implicated: complexity, I/O, database/network calls, allocation, contention, and bounded resources; claims require benchmark or profile evidence.
6. Security and privacy when triggered: changed trust boundaries, authentication, object/action/tenant authorization, validation, injection sinks, secrets, cryptography, dependencies, logging, races, deserialization, SSRF, path handling, migrations, and secure defaults.

Standards precedence is explicit task requirements, trusted repository standards from the base snapshot, version-applicable language/framework guidance, then general engineering heuristics. Deterministic formatter, linter, compiler, type-checker, scanner, and generated-file failures remain coordinator evidence and are not duplicated as model findings. Generated/vendor outputs are reviewed through their generator, inputs, provenance, and relevant security impact rather than ordinary style comments.

Critical means exploitable security, data loss, or unusable core behavior. Important means an introduced correctness failure, missing requirement, material reliability risk, or material test gap. Minor means worthwhile but non-blocking maintainability or clarity. A finding is reportable only when it is caused or materially worsened by the scope, actionable, and supported by a concrete trigger or reasoning path.

### 6.8. Feedback Reception and Re-review

The coordinator validates the complete report before editing. Every finding receives exactly one disposition:

| Disposition           | Required evidence                                                     | Closure effect                                                                                                                               |
| --------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `accepted`            | Code/requirement/test evidence confirming the problem                 | Critical/important remains blocking until fixed and freshly re-reviewed.                                                                     |
| `rejected`            | Technical evidence showing the finding is incorrect or inapplicable   | Non-blocking after rationale is recorded.                                                                                                    |
| `needs-clarification` | The exact ambiguity and missing evidence                              | Prevents pass and remediation until resolved.                                                                                                |
| `deferred`            | Reason, scope decision, and linked follow-up issue when work is valid | Only minor or genuinely out-of-scope work may permit current closure; an in-scope critical/important defect cannot be deferred past closure. |

Ambiguous or interdependent feedback is clarified as one grouped request before edits. Accepted items are fixed in coherent units and receive proportionate verification. Any source or reviewed-artifact change invalidates the prior after-snapshot and verdict. The coordinator captures a new after-snapshot and dispatches a new reviewer session with the current contract, current scope, unresolved finding IDs and factual evidence only, not prior reviewer conclusions.

One review attempt may retry once only for infrastructure or malformed-output failure. The initial review may be followed by at most two remediation re-reviews. Exhaustion, repeated disagreement, or inability to persist evidence leaves the issue non-closed and escalates to the user.

### 6.9. Issue and Epic Gates

Insert review between acceptance verification and `br close`:

```text
verify acceptance
  -> capture after snapshot
  -> compare exact scope
  -> fresh reviewer
  -> validate and dispose findings
  -> remediate, verify, and fresh re-review when needed
  -> persist review record
  -> verify current snapshot equals reviewed snapshot
  -> report/read backend gate when advertised
  -> close and re-read issue
```

The durable issue comment contains a canonical JSON review record: schema version, capability version, review/scope/snapshot IDs, requirement sources, inventories, verdict, findings, dispositions, verification evidence, attempt count, reviewer runtime identity when available, and timestamp. The coordinator writes through advertised `br comments` commands and re-reads the exact comment. Large blobs never enter the tracker.

When `br gate report` is advertised, report gate `code_review`, provider `kona:0.6.0`, status `pass` or `fail`, target `closed`, and a compact note containing review ID, scope ID, and issue-comment identity. Immediately before close, `br gate list` and the issue comment must agree with the recomputed current scope. If repository policy requires the gate, `br close` supplies an additional machine boundary. Kona does not silently create or edit project policy, and documentation states that actors bypassing the capability are machine-blocked only where repository policy requires the gate.

After every epic child closes, its task snapshots may be disposed. Before worktree cleanup or epic closure, capture the final logical tree and run a mandatory cumulative review from the workspace creation baseline to that final snapshot against the PRD, SPEC, all child contracts, and child review records. Cumulative remediation uses the same two-review limit. Only a current cumulative pass permits cleanup preflight; only successful worktree removal and preserved review evidence permit epic closure.

For an epic already active when schema 6 is adopted, the first review-enabled dispatch captures the current tree as the task baseline. Previously closed tasks are not retroactively assigned fabricated passes. Mandatory cumulative review still uses the recorded workspace base commit and flags any attribution limitation in its evidence.

### 6.10. Security and Privacy

- The reviewer has read/glob/grep access only. Shell, edit/write, network, question, tracker, Git mutation, external communication, secrets, and subagent dispatch are denied by host configuration rather than prompt promises.
- The snapshot helper is coordinator-only. It accepts one JSON request, validates canonical roots and identifiers, uses `shell: false`, and writes only beneath its protected state root.
- Snapshot bytes never enter prompts unless they are part of the exact review scope or requested surrounding context. Environment files, ignored secrets, Git internals, and files outside the worktree are excluded unless explicitly authorized and required.
- Security policies come from the protected host configuration or trusted base snapshot. Changed policy and instruction files cannot weaken reviewer permissions or finding requirements.
- Reports are data, not executable instructions. The coordinator schema-validates output and never interpolates model text into shell, SQL, paths, URLs, or tracker commands.
- Review state contains source-derived hashes and potentially source bytes. It uses least-readable modes, bounded retention, no telemetry, no background network, and deterministic cleanup after the required retention boundary.
- Human approval remains mandatory where repository policy, ownership, security, privacy, migration, infrastructure, or release controls require it. Automated review never approves or merges.

### 6.11. Bundle Lifecycle and Migration

Append `code-review` to the bundle and advance ownership schema to 6/version `0.6.0`. Schemas 1-5 retain their exact historical capability sets and versions. Only explicit `update` may migrate a valid schema-1-through-5 installation after verifying every owned byte, mode, backup, managed block, native identity, host, scope, and project identity.

For OpenCode and Codex, one deterministic transaction installs both skill trees and applicable adapters, updates one ownership record, verifies all surfaces, and rolls back all resources on failure. For Claude and Pi, the native package remains the lifecycle unit; verification checks package identity plus every skill and reviewer surface the host exposes. There is no `--capability` selector and no partial review installation.

Migration never adopts matching review files as owned. Occupied destinations remain unowned conflicts requiring the existing digest-bound replacement consent and backup. Disable, enable, and remove apply to the whole Kona bundle and preserve review records, tracker data, project source, authored documents, and user configuration.

## 7. Testing Strategy

Implementation follows RED-GREEN-REFACTOR: add one failing behavior-focused test, make the smallest change pass, then refactor with the suite green.

### 7.1. Unit Tests

| Boundary             | Required coverage                                                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot manifest    | Canonical ordering/JSON, raw-byte hashes, modes, symlinks, staged/unstaged/deleted/renamed/binary/untracked state, explicit ignored paths, HEAD/index identity, and stable IDs.        |
| Snapshot safety      | Path traversal, symlink escape, special files, unstable reads, case collisions, submodules, size/path limits, partial writes, lock contention, corrupt blobs, and idempotent disposal. |
| Scope comparison     | Already-dirty before state, changes with unchanged porcelain output, metadata-only changes, deterministic inventory/patch, exclusions, and stale verification.                         |
| Review envelope      | Every required field, verdict/severity combinations, questions, duplicate IDs, scope mismatch, changed-path coverage, and clean-review residual gaps.                                  |
| Finding policy       | Introduced versus pre-existing defects, deterministic-tool duplication, unsupported speculation, ungrounded style, severity, risk triggers, and generated code.                        |
| Feedback disposition | All four states, evidence requirements, blocking deferral refusal, grouped clarification, linked out-of-scope work, and attempt limits.                                                |
| Registry/manifests   | Composite resource/surface normalization, uniqueness, deterministic order, hashes, modes, invocations, provenance, and legacy-descriptor equivalence.                                  |

### 7.2. Integration Tests

| Boundary             | Required coverage                                                                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issues workflow      | Pre-closure review ordering, source-writer serialization, no-code artifact review, stale pass, blocking/question/infrastructure failure, persistence failure, read-back, remediation, and closure.                      |
| Backend gates        | Advertised gate pass/fail, target `closed`, comment/scope correlation, configured-policy refusal, unconfigured-policy limitation, and no bypass by Kona.                                                                |
| Epic lifecycle       | All children reviewed, mandatory cumulative review before cleanup, cross-task defect, cumulative remediation, successful removal before epic close, and legacy-active epic evidence.                                    |
| Reviewer permissions | Attempts to edit, shell, mutate Git/index/tracker, use network, request secrets, or dispatch agents fail; read/glob/grep inspection succeeds; source/index/HEAD/tracker canaries remain unchanged.                      |
| Prompt injection     | Malicious comments, issue/PR text, generated files, changed `AGENTS.md`, encoded instructions, and tool-output instructions cannot alter policy or permissions.                                                         |
| Host parity          | OpenCode, Codex, Claude, and Pi discover both skills, create a fresh reviewer context, enforce read-only tools, return the same normalized fields/verdicts/dispositions, and fail closed when isolation is unavailable. |
| Lifecycle            | Every host/scope and verb; schema 1-5 explicit migration to 6; conflicts, backups, drift, rollback, canary preservation, one active scope, and no partial composite capability.                                         |
| Release              | Exact resource inventory, generated adapter provenance, deterministic archives, internal/external hashes, missing/corrupt resource rejection, and version alignment.                                                    |

Use fixtures for committed and dirty scopes, non-code artifacts, clean and mixed-signal changes, security defects, incorrect advice, ambiguous findings, remediation, stale scope, reviewer failure, evidence failure, cumulative-only defects, and malicious repository instructions. Automated fixtures compare normalized fields and outcomes, not model prose.

Before release, run real-model dogfood on all four hosts for: clean review, mixed blocking/minor/pre-existing signals, security-triggered review, artifact-only review, incorrect feedback rejection, remediation re-review, cumulative cross-task review, and prompt-injection attempts. Record host/model versions, capability and reviewer-contract hashes, snapshot/scope IDs, complete outputs, dispositions, tool attempts, closure outcome, and human assessment. Static checks are not labeled semantic parity.

### 7.3. Acceptance Traceability

| PRD acceptance | Required evidence                                                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1-AC3        | Issues workflow scenarios and snapshot fixtures prove every task receives fresh review with exact dirty-state coverage.                       |
| AC4-AC7        | Mixed-signal, deterministic-tool, security, missing-requirement, test-gap, and minor-only fixtures prove finding quality and blocking policy. |
| AC8-AC10       | Feedback fixtures prove evidence-backed rejection, grouped clarification, remediation verification, and new-session re-review.                |
| AC11-AC13      | Snapshot freshness, mandatory cumulative gate, and versioned non-code artifact review.                                                        |
| AC14           | Injection and permission negative controls on all host adapters.                                                                              |
| AC15, AC19     | Fixed retry/remediation limits and reviewer-unavailability escalation.                                                                        |
| AC16-AC18      | Four-host normalized semantic fixture, clean report, and preserved human approval.                                                            |
| AC20           | Tracker failure/recovery fixture and comment/gate read-back before closure.                                                                   |

## 8. Definition of Done

### Universal

- [ ] `bun run plugin:build` and `bun run plugin:validate` pass.
- [ ] `bun run test:plugin` and `bun run test` pass.
- [ ] `bun run typecheck`, `bun run lint`, `bun run knip`, and `bun run format:check` pass (`package.json:23-39`).
- [ ] The SPEC reflects consequential implementation decisions without becoming a task plan.

### Feature-Specific

- [ ] The composite capability contains both canonical skills, reviewer contract, conditional security checklist, snapshot helper, and generated/provenance-checked reviewer adapters.
- [ ] Every epic child remains non-closed until its latest exact code scope or versioned artifact scope passes a fresh-context review and all findings have valid dispositions.
- [ ] Repository-changing epic children are serialized; attribution ambiguity and intervening mutation fail closed.
- [ ] Snapshot tests prove exact staged, unstaged, tracked, untracked, binary, mode, symlink, delete, already-dirty, and unchanged-porcelain behavior without source/index/ref/object mutation.
- [ ] Reviewer permissions deny mutation, shell, network, secrets, tracker access, and delegation on all supported hosts.
- [ ] Findings and questions satisfy the canonical schema, high-signal filters, review axes, security triggers, severity, and verdict rules.
- [ ] Accepted blocking feedback receives verification and a new reviewer; incorrect advice is rejected with evidence; in-scope blocking defects cannot be deferred through closure.
- [ ] One infrastructure retry and at most two remediation re-reviews are enforced before escalation.
- [ ] Current issue-linked review evidence and scope freshness are re-read before close; backend gate results correlate where supported.
- [ ] Every epic receives a cumulative review before worktree cleanup and closes only after cumulative pass and successful cleanup.
- [ ] OpenCode, Codex, Claude, and Pi discover both skills and enforce equivalent fresh-context, read-only reviewer behavior at every supported scope.
- [ ] Schema 6/version `0.6.0` lifecycle preserves exact schemas 1-5, never adopts unowned review files, and rolls back copied-host migration atomically.
- [ ] Release archives include every declared skill, reference, helper, and adapter with deterministic order, hashes, modes, and provenance.
- [ ] Existing copy, PRD, SPEC, issues, epic-worktree, lifecycle, installer, and release behavior does not regress.
- [ ] Real-model review and feedback dogfood passes the shared scenarios on all four hosts.
- [ ] Documentation explains review boundaries, security coverage, feedback dispositions, limits, local snapshot retention, backend-policy enforcement limits, and human-review requirements.

## 9. Alternatives Not Chosen

| Alternative                              | Why rejected                                                                                                    | Reconsider when                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Require a commit after every task        | Violates the default no-commit authority and cannot isolate pre-existing dirty bytes by itself.                 | The product explicitly adopts agent-owned checkpoint commits.                                         |
| Persist snapshots in Git objects or refs | Mutates repository internals and creates retention/GC concerns.                                                 | A separately approved Git checkpoint protocol owns those mutations.                                   |
| Persist source blobs in tracker comments | Leaks large or sensitive source into task history and exceeds tracker purpose.                                  | Never for source bytes; only compact hashes and evidence belong there.                                |
| Allow parallel source-writing children   | Exact attribution is not provable without stronger leases or per-task worktrees.                                | A future design provides machine-enforced non-overlapping scopes or isolated task worktrees.          |
| Let reviewers run tests                  | Project commands may mutate the checkout or execute malicious code.                                             | A sandbox runner with externally enforced filesystem, process, secret, and egress isolation is added. |
| Always run a reviewer panel              | Higher cost and duplicate noise do not justify the initial release.                                             | Measured single-reviewer recall is insufficient for defined high-risk classes.                        |
| Trust head-branch instructions           | Changed repository policy is a direct prompt-injection path.                                                    | Never; authority remains protected or base-derived.                                                   |
| Automatically edit `.beads` policy       | Tracker policy is project-owned configuration and no safe advertised portable mutation contract is established. | `br` exposes an explicit consent-bound policy API suitable for all supported repositories.            |

## 10. References

| Reference                                                                                                       | Relevance                                                                                         |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [Approved code review PRD](./prd.md)                                                                            | Product scope, review/feedback behavior, safety, distribution, and acceptance criteria.           |
| `plugin/lib/capability-registry.mjs:1-123`                                                                      | Current single-skill descriptor and host invocation constraints.                                  |
| `plugin/lib/plugin-lifecycle.mjs:11-50,237-267`                                                                 | Current scopes, ownership schemas/versions, and copied-host resource planning.                    |
| `plugin/scripts/contracts.mjs:27-115`                                                                           | Manifest, resource, hash, mode, version, and host-contract validation.                            |
| `plugin/scripts/release-lib.mjs:6-29,122-175`                                                                   | Registry-derived deterministic release and archive integrity.                                     |
| `plugin/skills/issues/SKILL.md:101-153,210-228`                                                                 | Conflict-safe context writes, issue closure flow, epic dispatch gate, and Git authority boundary. |
| `plugin/skills/epic-worktree/scripts/epic-worktree.mjs:1457-1500`                                               | Existing status digest and dirty-worktree behavior that cannot identify reviewed bytes.           |
| `plugin/hosts/opencode/agents/epic-worktree.md:1-16`                                                            | Existing deny-by-default OpenCode adapter pattern.                                                |
| `plugin/test/manifest-contract.test.ts:22-125`                                                                  | Registry order, manifest identity, versions, invocations, and scope tests.                        |
| `plugin/test/issues-workflow.test.ts:14-56,172-286`                                                             | Existing issue and epic-workspace scenario extension points.                                      |
| `package.json:23-39`                                                                                            | Repository-wide build, validation, test, type, lint, dependency, and format commands.             |
| [Google Code Review: What to Look For](https://google.github.io/eng-practices/review/reviewer/looking-for.html) | Correctness, design, complexity, tests, naming, comments, style, and documentation review axes.   |
| [Google Code Review Standard](https://google.github.io/eng-practices/review/reviewer/standard.html)             | Code-health approval standard and non-perfection principle.                                       |
| [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/)                         | Risk-triggered application-security review baseline.                                              |
| [NIST Secure Software Development Framework](https://csrc.nist.gov/projects/ssdf)                               | Secure development and review lifecycle controls.                                                 |
| [OWASP AI Agent Security](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html)    | Prompt-injection, least-privilege, tool, output-validation, and audit controls.                   |
| [GitHub Copilot code-review responsible use](https://docs.github.com/en/copilot/responsible-use/code-review)    | AI false-positive, missed-defect, insecure-suggestion, and human-validation limitations.          |

## 11. Open Questions

None blocking. Exact composite-manifest field names, normalized host adapter metadata, and snapshot artifact encoding are implementation choices, but tests must lock them before release without weakening the interfaces, authority boundaries, or evidence requirements above.
