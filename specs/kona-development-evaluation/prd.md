# Kona Development Evaluation PRD

## 0. TL;DR

- Build an immutable evaluation ledger for pure GPT and every evaluated Kona version.
- Use one existing benchmark: FeatureBench Fast-100, with its native grader and one primary decision metric, test pass rate (`%PASSED`).
- Run each arm once: one attempt on each of the 100 tasks. Do not rerun pure GPT or prior Kona versions for every new version.
- Track every arm as a named DVC experiment tied to its Git baseline; store parameters and summary metrics in the experiment ref and large artifacts in DVC remote storage.
- Compare each Kona version with the stored pure-GPT baseline and the immediately preceding compatible Kona version, task by task.
- A new evaluation epoch, including a new pure-GPT baseline, is required when the model version, benchmark, harness, prompt envelope, tools, limits, or analysis policy changes.
- Under current GPT-5.6 Sol Standard Global promotional pricing, one 100-task arm is estimated at **$1,000-$6,000 and 3-8 hours**, using configurable concurrency of 20 or 50 according to Azure and AWS quotas. Pure GPT plus the first Kona version costs two arms; each later Kona version normally adds one arm.
- With 100 independent tasks, the estimated minimum detectable change is approximately **6-10 percentage points** at 80% power and two-sided 5% significance, subject to the observed paired-task variance.
- The evaluator reports evidence. The maintainer manually decides whether to merge or upgrade and records the rationale.

## 1. Meta Information

| Field            | Value                                                                   |
| ---------------- | ----------------------------------------------------------------------- |
| Status           | Draft                                                                   |
| Primary users    | Kona maintainers and contributors                                       |
| Initial delivery | DVC-backed FeatureBench Fast-100 version ledger                         |
| Model provider   | Azure OpenAI-compatible API                                             |
| Model            | GPT-5.6-sol through a configurable Azure deployment                     |
| Execution        | Amazon ECS on AWS Fargate, Linux x86-64                                 |
| Pricing basis    | Standard Global, short context; promotional metered rates on 2026-09-05 |

## 2. What

Create a development-focused evaluation system that shows whether each Kona version makes GPT-5.6-sol better, worse, or merely more expensive on sustained feature-development work. The system runs pure GPT once and every Kona version once against the same frozen FeatureBench Fast-100 tasks, then reuses those immutable results for comparisons.

Each arm is a named DVC experiment based on the Git commit that defines its evaluator and Kona assets. DVC experiment metrics and parameters provide the comparison index; DVC-tracked remote artifacts hold task outputs, grader results, trajectories, and logs that should not be committed directly to Git.

### Evaluation Arms

| Arm               | Frequency                  | Contents                                                                                                     |
| ----------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Pure GPT baseline | Once per evaluation epoch  | Stock harness and model; no Kona binary, skill, prompt text, seed, hook, graph, or Kona-generated context    |
| Kona version      | Once per evaluated version | Exact immutable Kona version with its matching binary, instructions, seed, hooks, and other evaluated assets |

"Run an arm once" means one model attempt on each of the 100 tasks. A version is not rerun merely because a newer Kona version is added.

Each Kona version is compared with:

1. Pure GPT in the same evaluation epoch, showing Kona's net product value.
2. The immediately preceding compatible Kona version, showing the version-to-version change.

### Evaluation Epoch

Stored arms are directly comparable only while all non-Kona inputs remain identical:

- Azure deployment and underlying model version;
- FeatureBench data version and Fast-100 task manifest;
- agent harness and system prompt envelope;
- tools, network policy, task environment, time limit, and token limit;
- model parameters and API behavior;
- grader and analysis policy.

Concurrency is recorded but does not start a new epoch by itself. Quality comparisons across the supported concurrency presets are valid only when no arm records provider throttling, quota retries, or altered task-level limits. Cost and latency comparisons require matching concurrency.

A change to any of these inputs starts a new epoch. The evaluator must run a new pure-GPT baseline before comparing Kona versions in that epoch. Results from different epochs may be displayed historically but must not be used as direct evidence for a merge or upgrade decision.

### In Scope

- Pure GPT-5.6-sol and every evaluated Kona version.
- FeatureBench Fast-100 tasks and native executable grader.
- One attempt per task and configuration.
- Immutable arm provenance, validity checks, comparison, cost reporting, and decision recording.
- DVC experiment tracking integrated with Git and a configured DVC artifact remote.
- Amazon ECS/Fargate execution with a requested concurrency preset of 20 or 50 tasks.
- A Fargate-compatible task package that runs one FeatureBench task, agent, and grader without privileged containers or Docker-in-Docker.
- Manual merge and upgrade decisions.

## 3. Motivation

### Problem

Kona needs a repeatable answer to two development questions:

1. Does this Kona version outperform pure GPT?
2. Did this Kona version improve over the previous Kona version?

Rerunning pure GPT and all prior versions for every change would be prohibitively expensive. Comparing ad hoc demonstrations or runs with different model and harness configurations would be cheaper but not trustworthy.

### Goals

1. Produce one comparable result for pure GPT and every evaluated Kona version.
2. Reuse compatible historical arms to limit each new version to one paid benchmark arm.
3. Measure sustained development work with an existing benchmark and native grader.
4. Detect approximately 6-10 point changes when observed variance matches planning assumptions.
5. Report quality, cost, latency, adoption, and failures without making the merge or upgrade decision automatically.
6. Preserve enough provenance to identify exactly when a fresh baseline is required.
7. Make version metrics comparable through DVC while keeping large run artifacts out of Git history.

### Users

| User             | Need                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| Kona maintainer  | Compare a new Kona version with pure GPT and the previous version before deciding whether to merge or upgrade |
| Kona contributor | Understand task-level improvements, regressions, failures, and overhead                                       |
| Reviewer         | Verify that compared arms belong to the same evaluation epoch                                                 |

## 4. User Stories

1. As a maintainer, I want pure GPT evaluated once so that later Kona versions can reuse a valid baseline.
2. As a contributor, I want each Kona version evaluated once on the same tasks so that version history remains comparable.
3. As a reviewer, I want epoch compatibility checks so that model or harness drift is not attributed to Kona.
4. As a maintainer, I want one primary quality metric plus cost, latency, adoption, and failure evidence so that I can make the final decision myself.
5. As a release owner, I want historical reports to remain immutable so that a new run cannot rewrite earlier evidence.

## 5. User Flow

### Start an Evaluation Epoch

1. The maintainer pins the Azure deployment and model version, FeatureBench version and Fast-100 manifest, harness, prompt envelope, tools, limits, grader, and analysis policy.
2. Preflight validates the environment and verifies that the pure-GPT arm contains no Kona surface.
3. Preflight checks Azure TPM/RPM and AWS capacity for the requested concurrency. If 50 is unavailable, the maintainer may explicitly restart scheduling at 20; the evaluator must not downgrade silently.
4. The evaluator runs pure GPT once on every Fast-100 task.
5. Native grading, usage, timing, failure, and provenance artifacts are stored immutably as the epoch baseline.
6. The completed baseline is assigned a deterministic DVC experiment name and pushed with its DVC-tracked artifacts.

### Evaluate a Kona Version

1. The maintainer identifies an immutable Kona version.
2. Preflight verifies that its binary and all evaluated assets come from that version and that the epoch inputs have not changed.
3. The evaluator runs the version once on every Fast-100 task.
4. The native grader scores every task and the evaluator stores quality, usage, cost, latency, adoption, failures, and provenance.
5. The report compares the new version with pure GPT and the preceding Kona version on matching tasks.
6. The report marks evidence `VALID`, `INCOMPLETE`, or `INVALID`.
7. The maintainer records `MERGE`, `DO_NOT_MERGE`, or `DEFER`, or records `UPGRADE`, `KEEP_CURRENT`, or `DEFER`, with rationale.
8. The experiment ref and DVC artifacts are pushed so another repository checkout can reproduce the report with `dvc exp pull` and compare it with `dvc exp show` or `dvc exp diff`.

### Failure and Recovery

- A missing or failed task remains visible and does not silently become a score of zero.
- Provider, harness, grader, environment, and Kona setup failures are classified separately from valid task failures.
- An arm with incompatible epoch inputs is invalid for direct comparison.
- A retry creates a new run record and never overwrites the original attempt. It is diagnostic evidence, not part of the one-attempt primary metric unless a new epoch is declared before results are reviewed.
- If the Azure deployment's underlying model version changes, all subsequent arms belong to a new epoch even when the deployment name remains unchanged.
- If an experiment ref or required DVC artifact fails to push, the arm remains INCOMPLETE and must not be treated as a durable ledger entry.

## 6. Definition of Done

### Functional Requirements

| ID   | Requirement                                                                                                                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR1  | The evaluator must create immutable evaluation epochs containing all non-secret comparison inputs.                                                                                                                                                              |
| FR2  | Each epoch must contain exactly one valid pure-GPT baseline before a Kona version can receive a decision report.                                                                                                                                                |
| FR3  | The pure-GPT arm must contain no Kona binary, instruction, seed, hook, graph, or Kona-generated context; automated preflight must verify this isolation.                                                                                                        |
| FR4  | Every evaluated Kona version must run exactly one primary attempt on each FeatureBench Fast-100 task.                                                                                                                                                           |
| FR5  | A Kona arm must package matching binary and instruction assets from one immutable version; mixed-version assets invalidate the arm.                                                                                                                             |
| FR6  | The evaluator must use the unmodified FeatureBench Fast-100 task manifest and native grader. It must not create Kona-specific tasks, alter expected solutions, or substitute an LLM judge.                                                                      |
| FR7  | The primary decision metric must be FeatureBench test pass rate (`%PASSED`). FeatureBench resolve rate (`%RESOLVED`) remains a supporting metric.                                                                                                               |
| FR8  | Every Kona report must show task-paired and aggregate differences against pure GPT and the immediately preceding compatible Kona version.                                                                                                                       |
| FR9  | Reports must include `%PASSED`, `%RESOLVED`, input/output/cache tokens, estimated and actual API cost, wall-clock time, completion status, and classified failures.                                                                                             |
| FR10 | Kona reports must include whether instructions were loaded, whether Kona was invoked, successful and failed invocation counts, and whether a valid graph was produced.                                                                                          |
| FR11 | The evaluator must mark evidence `VALID`, `INCOMPLETE`, or `INVALID` according to a versioned policy without issuing an automatic merge or upgrade verdict.                                                                                                     |
| FR12 | The evaluator must record the maintainer's decision, decision maker, timestamp, and rationale separately from computed evidence.                                                                                                                                |
| FR13 | Historical arms and reports must be append-only. A retry or policy revision creates a new record and does not rewrite prior evidence or decisions.                                                                                                              |
| FR14 | The evaluator must refuse direct comparison across different epochs and identify every field that caused the mismatch.                                                                                                                                          |
| FR15 | The evaluator must estimate cost before scheduling and require confirmation when projected spend exceeds the configured run budget.                                                                                                                             |
| FR16 | Scheduling must respect container capacity and Azure TPM/RPM quota. Provider throttling must not be scored as task failure.                                                                                                                                     |
| FR17 | Each arm must run its first three tasks as a staged cost and integration probe. If valid and within budget, those same task results remain part of the arm and execution continues with the other 97 tasks without rerunning them.                              |
| FR18 | Every arm must be recorded as a deterministically named DVC experiment tied to the Git commit that defines the run. The name must identify the evaluation epoch and either `pure-gpt` or the immutable Kona version.                                            |
| FR19 | DVC parameters must include all epoch compatibility inputs and the evaluated Kona version. DVC metrics must include `%PASSED`, `%RESOLVED`, token usage, model cost, wall-clock time, validity status, adoption counts, and classified failure counts.          |
| FR20 | Task-level grader output, trajectories, logs, and other large artifacts must be DVC-tracked and stored in the configured DVC remote rather than committed directly to Git.                                                                                      |
| FR21 | A completed arm must be shareable with `dvc exp push` and recoverable in another clean checkout with `dvc exp pull`, including the artifacts required to regenerate its report offline.                                                                         |
| FR22 | Users must be able to compare pure GPT and Kona versions through `dvc exp show` and `dvc exp diff` without rerunning model inference.                                                                                                                           |
| FR23 | The maintainer's manual decision and rationale must be included in the durable experiment record or a Git-tracked index that references the immutable DVC experiment.                                                                                           |
| FR24 | The evaluator must support requested concurrency values of 20 and 50. Preflight must verify Azure TPM/RPM and AWS capacity before scheduling and must require explicit confirmation to fall back from 50 to 20.                                                 |
| FR25 | Requested and effective concurrency, throttling, retries, and quota errors must be stored as DVC parameters or metrics. Quality comparisons across concurrency presets require no quota-induced behavior change; latency comparisons require equal concurrency. |
| FR26 | Each FeatureBench task must run directly as an isolated Linux x86-64 Fargate task. The solution must not require privileged mode, a host Docker socket, or Docker-in-Docker, which Fargate does not support.                                                    |

### Non-Functional Requirements

| ID                            | Requirement                                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR1 - Reproducibility        | Every arm must record enough immutable provenance to reconstruct all non-secret inputs.                                                                        |
| NFR2 - Comparability          | Direct comparisons are allowed only within one evaluation epoch and on matching task IDs.                                                                      |
| NFR3 - Security               | Azure credentials must never appear in committed files, task containers, commands, logs, or reports and must be redacted from provider errors.                 |
| NFR4 - Cost control           | The evaluator must show projected and accumulated spend before scheduling further tasks.                                                                       |
| NFR5 - Deterministic analysis | Given the same stored artifacts and policy, analysis must produce identical metrics and evidence status without model calls.                                   |
| NFR6 - Statistical honesty    | Reports must identify the 100-task sample size, one-attempt design, confidence interval, estimated MDE, missing tasks, and limitations.                        |
| NFR7 - DVC integrity          | A ledger entry is complete only when its experiment ref and required DVC objects are available from the configured remotes and resolve to the recorded hashes. |

### Acceptance Criteria

1. **Given** an empty epoch, **When** a Kona version is submitted before pure GPT completes, **Then** the evaluator reports the missing baseline and does not produce a valid comparison.
2. **Given** a pure-GPT arm, **When** preflight inspects its image, prompts, mounted files, and environment, **Then** no Kona surface is present.
3. **Given** a valid epoch, **When** pure GPT completes, **Then** exactly one primary result exists for each of the 100 FeatureBench tasks or the arm is marked INCOMPLETE.
4. **Given** a Kona version, **When** preflight resolves its assets, **Then** every evaluated asset maps to the declared immutable version or the arm is marked INVALID.
5. **Given** a completed Kona arm, **When** analysis runs, **Then** the report shows `%PASSED` and its paired delta against both pure GPT and the preceding Kona version.
6. **Given** a second or later Kona version in the same epoch, **When** it is evaluated, **Then** pure GPT and prior Kona arms are reused without new model calls.
7. **Given** a change to model version, benchmark manifest, harness, prompt envelope, tools, limits, grader, or analysis policy, **When** the next version is submitted, **Then** the evaluator requires a new epoch and pure-GPT baseline.
8. **Given** a provider, infrastructure, grader, setup, or task failure, **When** reporting runs, **Then** the failure is classified and is not silently converted into an ordinary failed solution.
9. **Given** the same artifacts and policy, **When** analysis runs twice, **Then** metrics and evidence status are identical.
10. **Given** a report, **When** the maintainer records a merge or upgrade decision, **Then** the manual decision and rationale remain distinct from computed evidence.
11. **Given** any stored credential or provider error, **When** artifacts are inspected, **Then** no secret is present.
12. **Given** a completed pure-GPT or Kona arm, **When** it is listed with `dvc exp show`, **Then** its epoch, version, primary metric, supporting metrics, validity, and cost are visible without reading raw logs.
13. **Given** two compatible arm experiments, **When** `dvc exp diff` is used, **Then** the parameter differences and metric deltas correspond to the stored version comparison report.
14. **Given** a clean checkout with access to the Git and DVC remotes, **When** the experiment is pulled, **Then** all artifacts needed to regenerate the report offline are restored and hash-verified.
15. **Given** a completed local run whose experiment ref or required artifacts were not pushed, **When** ledger status is evaluated, **Then** the arm is marked INCOMPLETE.
16. **Given** requested concurrency 50 and insufficient Azure or AWS quota, **When** preflight runs, **Then** no benchmark task starts until the maintainer explicitly selects concurrency 20 or resolves the quota limitation.
17. **Given** two otherwise compatible arms with concurrency 20 and 50, **When** reporting compares them, **Then** quality is compared only if neither arm experienced quota-induced retries or throttling, and latency is labeled non-comparable.

### Decision Metric

The one primary decision metric is **FeatureBench test pass rate (`%PASSED`)**.

For each Kona version, report:

- absolute `%PASSED`;
- percentage-point delta versus pure GPT;
- percentage-point delta versus the preceding Kona version;
- a paired 95% confidence interval for each delta.

Do not combine quality, cost, latency, or adoption into a synthetic score. `%RESOLVED`, cost, latency, adoption, and failure rates are supporting evidence reviewed by the maintainer.

### Runtime, Cost, and Statistical Power

Microsoft's GPT-5.6 announcement lists Standard Global short-context pricing at `$5.00/M` input, `$0.50/M` cached input, `$6.25/M` cache writes, and `$30.00/M` output. It states a promotion from **2026-09-01 through at least 2026-11-30** reducing metered input to `$4.00/M` and output to `$20.00/M`.

For usage measured in millions of tokens:

`model cost = 4.00 * uncached_input + 0.50 * cached_input + 6.25 * cache_writes + 20.00 * output`

Planning assumptions for one FeatureBench task are 3M-10M input tokens, 0.3M-1M output tokens, and a 90-minute cap. The low estimate assumes the lower token volume and approximately 80% cached input; the high estimate assumes upper token volume with no cache benefit.

| Work                                                     | Concurrency | Trials | Estimated model cost | Estimated AWS compute |    Estimated elapsed time |
| -------------------------------------------------------- | ----------: | -----: | -------------------: | --------------------: | ------------------------: |
| Staged probe, first 3 tasks of pure GPT and one Kona arm |           3 |      6 |           `$60-$360` |                 `<$5` | 3-5 hours including setup |
| One FeatureBench Fast-100 arm                            |          20 |    100 |      `$1,000-$6,000` |             `$20-$40` |                 6-8 hours |
| One FeatureBench Fast-100 arm                            |          50 |    100 |      `$1,000-$6,000` |             `$25-$60` |                 3-4 hours |
| New epoch, two arms run sequentially                     |          20 |    200 |     `$2,000-$12,000` |             `$40-$80` |               12-16 hours |
| New epoch, two arms run sequentially                     |          50 |    200 |     `$2,000-$12,000` |            `$50-$120` |                 6-8 hours |

AWS estimates assume Linux x86 Fargate tasks sized between 2 vCPU/4 GB and 4 vCPU/8 GB and include a planning allowance for compute, storage, logging, and networking, but not the one-time engineering work required to adapt the current Docker-based runner. Data Zone, Regional, Priority, Provisioned Throughput, long-context, post-promotion, or contract model pricing can differ. The staged probe must replace the estimates with observed cache rate, token mix, task duration, grader duration, TPM/RPM quota, and effective concurrency before the remaining tasks are scheduled.

For 80% power, a two-sided 5% significance level, 100 paired tasks, and paired-task SD of 0.20-0.35:

`MDE ~= 2.80 * paired_task_SD / sqrt(100) = 5.6-9.8 percentage points`

This is a planning estimate, not a guarantee. One attempt per task does not measure run-to-run reliability, and the observed paired-task variance determines the final confidence interval. Smaller observed changes remain descriptive evidence for the maintainer rather than statistically established improvements.

### Risks

| Risk                                                              | Mitigation                                                                                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Azure silently updates the model behind a deployment              | Record the underlying model version for every arm and start a new epoch when it changes.                                         |
| Non-contemporaneous arms reflect provider or infrastructure drift | Freeze every observable input, monitor latency and error shifts, and start a new epoch when compatibility cannot be established. |
| One attempt produces a noisy ranking                              | Report paired confidence intervals and describe sub-MDE changes as directional rather than significant.                          |
| Public tasks become tuned test cases                              | Freeze Kona's generic instructions, prohibit task-specific guidance, and version the manifest.                                   |
| A higher score hides unacceptable overhead                        | Report cost, latency, adoption, and failures beside `%PASSED`; require the manual rationale to address material tradeoffs.       |
| Model-only accidentally receives Kona context                     | Verify the absence of all Kona surfaces before baseline execution.                                                               |
| A failed arm is mistaken for poor model performance               | Classify infrastructure, provider, grader, setup, and task failures separately and mark incomplete evidence.                     |
| The estimate exceeds available budget                             | Run the staged first-three-task probe, enforce a spend ceiling, and stop scheduling before the ceiling is exceeded.              |
| Requested concurrency exceeds Azure or AWS quota                  | Validate both quotas before scheduling and require an explicit downgrade from 50 to 20 rather than allowing throttled execution. |
| DVC experiment refs are assumed to move with plain Git push       | Require `dvc exp push`/`pull` in the lifecycle and verify remote availability before marking an arm complete.                    |
| Large artifacts make Git history unusable                         | Commit only DVC metadata and compact decision records to normal Git; store large content-addressed artifacts in the DVC remote.  |

## 7. Out of Scope

1. Running pure GPT or every prior Kona version again for each new version.
2. Multiple primary attempts per task in the initial delivery.
3. Benchmarks other than FeatureBench Fast-100 in the initial delivery.
4. Kona-authored tasks, modified benchmark graders, or LLM judging.
5. Automatic merge, upgrade, or release decisions.
6. Combining quality and operational metrics into one synthetic score.
7. Comparing arms across incompatible evaluation epochs.
8. Claims that the result generalizes to every model, benchmark, or software-development task.
9. Rewriting the existing long-horizon evaluation's frozen pre-registration.
10. Storing large benchmark outputs directly in Git objects.
11. Requiring DVC Studio; local CLI and Git/DVC remotes are sufficient for the initial delivery.

## 8. Open Decisions

1. Confirm the exact FeatureBench data version and immutable Fast-100 manifest hash.
2. Record the Azure deployment's immutable model version, API behavior, TPM/RPM quota, and applicable price schedule.
3. Set the per-arm spend ceiling after the staged first-three-task probe.
4. Define which Kona versions require evaluation and how version identifiers map to commits and packaged assets.
5. Define how long an epoch remains valid when Azure reports no model-version change but operational metrics drift.
6. Select the DVC remote backend, access policy, retention period, and recovery owner.
7. Decide whether accepted experiments are additionally promoted to ordinary Git branches with `dvc exp branch` or remain shared experiment refs plus a Git-tracked decision index.
8. Confirm the Fargate task size, AWS region, ephemeral storage allocation, networking path, and account task quota after the staged probe.

## 9. References

- `eval/README.md` - current paired model-only versus Kona rig and known fidelity gaps.
- `docs/eval.md` - historical long-horizon proposal and frozen pre-registration; preserved unchanged.
- `eval/analyze/paired.ts` - current paired benchmark analysis.
- `eval/analyze/trajectory.ts` - current adoption and trajectory analysis.
- [FeatureBench](https://github.com/LiberCoders/FeatureBench) - feature-development benchmark with an existing CPU-only Fast-100 split and native executable grading.
- [AgentSpec](https://arxiv.org/abs/2606.14674) - controlled agent-component composition and non-additive scaffold effects.
- [Azure GPT-5.6 announcement and pricing](https://azure.microsoft.com/en-us/blog/gpt-5-6-now-available-in-microsoft-foundry/) - model availability and dated Standard Global pricing used by the estimate.
- [Azure OpenAI latency guidance](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/latency) - response usage fields and throughput measurement.
- [Azure OpenAI quota guidance](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/quota) - deployment quota and rate-limit behavior.
- [DVC experiment tracking](https://dvc.org/doc/start/experiments/experiment-tracking) - experiment execution, metrics, parameters, and comparison workflow.
- [DVC experiment sharing](https://dvc.org/doc/user-guide/experiment-management/sharing-experiments) - experiment refs, `dvc exp push`/`pull`, DVC remotes, and optional promotion to Git branches.
