# Kona Development Evaluation Technical Specification

## 0. TL;DR

- **SPEC status: Approved.** The governing [PRD](./prd.md) is user-approved despite its in-file `Draft` label.
- Evaluate FeatureBench dataset v1.1 `fast` split (100 tasks) with Azure GPT-5.6-sol, one attempt per task, using the FeatureBench-native `mini_swe_agent` prompt and harness in both arms. Pure GPT has no Kona surface; a Kona arm adds only one immutable, versioned Kona bundle and its instructions.
- Run a Standard Step Functions workflow in `us-east-1`. A Distributed Map uses `MaxConcurrencyPath` with the explicitly selected value `20` or `50`; each item runs separate Linux x86-64 Fargate inference and grader tasks through `ecs:runTask.sync`.
- Do not run Docker in Fargate. Mirror the 18 official Fast image families by source digest in ECR and derive separate inference and grader images from every base. The inference image never contains native/hidden grading assets.
- Write task results to append-only S3 staging keys, collect them locally into one deterministically named DVC experiment per arm, and use `dvc exp push`/`pull` for experiment refs and DVC objects. Keep manual decisions in a compact append-only Git index.
- Use two Terraform roots: `infra/eval/bootstrap` for durable state and artifact storage, and `infra/eval/runtime` for replaceable execution infrastructure. Pin Terraform to `~> 1.16.0`, AWS provider to `= 6.33.0`, and use S3 `use_lockfile = true` without DynamoDB.
- The selected public-subnet design assigns public IPs, permits no ingress, and permits outbound HTTPS. It avoids persistent NAT cost for an ephemeral evaluator, with the accepted trade-off that task ENIs are internet-routable and egress is not domain-restricted by security groups.
- Pure GPT runs once per epoch. Every manually selected Kona revision runs once and is compared, task-paired, with the stored pure baseline and preceding compatible Kona arm. Evidence never makes the merge or upgrade decision.

## 1. Meta Information

| Field              | Value                                                                    |
| ------------------ | ------------------------------------------------------------------------ |
| SPEC status        | Approved                                                                 |
| Branch             | `main`                                                                   |
| Governing PRD      | [Kona Development Evaluation PRD](./prd.md), approved by the user        |
| Initial scope      | FeatureBench v1.1 Fast-100 evaluation ledger                             |
| Model              | Azure GPT-5.6-sol through a pinned deployment and reported model version |
| AWS deployment     | `us-east-1`, ECS Fargate Linux x86-64                                    |
| Infrastructure     | Terraform `~> 1.16.0`; `hashicorp/aws = 6.33.0`                          |
| Decision authority | Maintainer; computed evidence is advisory                                |

No blocking technical decision remains. Deployment name, provider quotas, budget ceiling, exact source/image digests, bucket names, retention days, and selected Kona revisions are required operator inputs or generated immutable provenance, not open architecture decisions.

## 2. Context and Current State

The existing rig is a six-task Terminal-Bench/Frontier-Bench Harbor A/B, not the required FeatureBench ledger (`eval/README.md:1-18`). It launches two concurrent Harbor jobs with Terminus-2-derived agents and then performs local analysis (`eval/run/02-ab.sh:14-42`). Its defaults are DeepSeek, Terminal-Bench, and concurrency 12 (`eval/run/lib.sh:16-30`), while credentials are sourced from a local `.env` file (`eval/run/lib.sh:56-94`).

The current Kona adapter uploads a binary and skills into an already running task container, initializes `/.kona`, optionally applies a seed, and can append a matched planning directive (`eval/harbor/kona_agent.py:44-168,197-273`). This gives useful provenance and adoption lessons, but it is tied to Harbor's container controller and Terminus-2. The current analyzer discovers non-contractual Harbor JSON layouts, classifies arms by names, and reports six-task sign patterns (`eval/analyze/paired.ts:35-58,170-272`). Trajectory and graph-shape analysis already establish useful Kona adoption fields and mutation-log semantics (`eval/analyze/trajectory.ts:145-207`; `eval/analyze/shape.ts:31-119`).

The new evaluator therefore lives beside the old rig, reuses only behavior that is independently validated, and does not reinterpret old results. `docs/eval.md` remains byte-for-byte unchanged.

| Current evidence                                                                                                                                                                              | Consequence for this design                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `eval/` deliberately drives the product as a subprocess rather than becoming a product package (`eval/README.md:7-9`).                                                                        | Keep the new evaluator under `eval/` with no imports from it into `packages/*`.                     |
| Existing preflight detects stale Kona binaries and validates the installed layer before paid work (`eval/run/lib.sh:97-125`; `eval/run/00-preflight.sh:105-148`).                             | Preserve fail-closed binary/bundle provenance and zero-token image smoke tests.                     |
| Existing runs can silently measure no Kona use unless skill loading and invocations are recorded (`eval/analyze/trajectory.ts:145-205`).                                                      | Adoption is required supporting evidence; zero adoption is visible, not rewritten as model failure. |
| Existing tests pin seed validity, frontmatter discovery, and shape semantics (`eval/test/seed.test.ts:63-106`; `eval/test/skill-frontmatter.test.ts:28-57`; `eval/test/shape.test.ts:15-60`). | Keep these tests and add FeatureBench-specific contracts rather than replacing them.                |
| Root checks include eval TypeScript and all Bun tests (`package.json:23-39`).                                                                                                                 | `bun run check` and `bun run format:check` are release gates.                                       |

FeatureBench's official CLI supports `--agent mini_swe_agent`, `--n-attempts` (default `1`), `--n-concurrent`, and `--timeout` (default `3600` seconds). Its native evaluation CLI accepts the Fast split and produces per-task reports. This design explicitly sets one attempt, inner concurrency one, and the native 3,600-second inference timeout so results retain benchmark fidelity.

## 3. Technical Drivers

| Driver                | Required property                                                                                                              | PRD trace                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| Comparability         | Same benchmark, task set, model version, harness, prompt envelope, tools, limits, grader, and analysis policy within an epoch. | `prd.md:47-60`, FR1-FR8     |
| One-attempt economy   | One primary attempt for each of 100 tasks; reuse pure and preceding compatible arms.                                           | `prd.md:35-45`, FR2-FR4     |
| Harness control       | FeatureBench-native mini-SWE-agent in both arms; Kona is the only intended arm difference.                                     | `prd.md:35-40`, FR3-FR6     |
| Hidden-test isolation | Model execution cannot read grader image, test payload, credentials, or outputs.                                               | FR6, NFR3                   |
| Durable provenance    | Immutable task artifacts, deterministic epoch identity, named DVC experiments, and recoverable remote objects.                 | FR13, FR18-FR23, NFR1, NFR7 |
| Failure honesty       | Missing, infrastructure, provider, harness, setup, grader, and task outcomes remain distinct.                                  | `prd.md:143-150`, FR11-FR14 |
| Cost control          | Three-task staged probe, explicit 20/50 concurrency, quota checks, budget approval, no silent downgrade.                       | FR15-FR17, FR24-FR25        |
| Replaceable compute   | Durable data survives teardown; execution resources are reproducible from Terraform.                                           | FR27-FR35                   |
| Least privilege       | Secret ARN only in Terraform, separate inference/grader roles, no ingress, narrowly scoped artifact access.                    | NFR3, FR30-FR31             |

## 4. Considered Options

### 4.1. Orchestration and Runtime

| Option                                                     | Advantages                                                                                                 | Costs and risks                                                                                               | Decision   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------- |
| Step Functions Standard + Distributed Map + direct Fargate | Durable execution history, dynamic 20/50 cap, per-item isolation, native `.sync`, no long-lived controller | More AWS resources and state-transition cost                                                                  | **Select** |
| Local controller calling ECS `RunTask`                     | Simple initial control code                                                                                | Laptop/session is the coordinator; recovery, fan-out state, and audit history become custom concerns          | Reject     |
| Harbor/Docker on ECS EC2                                   | Reuses current Docker-oriented rig and supports nested containers                                          | Requires privileged host access, EC2 fleet patching/capacity, Docker socket exposure, and a different harness | Reject     |

Distributed Map is selected even at concurrency 20 because the 50 preset exceeds Inline Map's 40-iteration limit and because child histories isolate 100 long-running items. Standard, not Express, owns the parent because Distributed Map is unavailable in an Express parent and executions may span hours.

### 4.2. Agent Harness

| Option                                           | Advantages                                                                                           | Costs and risks                                                                                                 | Decision   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------- |
| FeatureBench-native mini-SWE-agent for both arms | Officially supported, small surface, matched prompt/parser/loop, straightforward Kona-only extension | Needs a thin direct-container transport because upstream normally controls Docker                               | **Select** |
| OpenHands                                        | FeatureBench-supported and capable                                                                   | Larger runtime, more configuration and tool surface, higher risk that scaffold behavior obscures Kona's effect  | Reject     |
| Terminus-2/Harbor                                | Existing local integration                                                                           | Not the selected FeatureBench-native harness; current fidelity gaps flatten Kona roles (`eval/README.md:67-79`) | Reject     |

The Fargate transport adapter must import the pinned FeatureBench prompt builder, mini-SWE-agent adapter, result parser, and grading policy. It may replace only the outer Docker lifecycle with “current Fargate task is the container.” It must not copy or independently evolve FeatureBench's stock prompt. A parity fixture must prove that a pure task produces the same prompt bytes, command, patch envelope, and parsed fields as the pinned stock Docker path.

### 4.3. Inference and Grading Isolation

| Option                                             | Advantages                                                           | Costs and risks                                                                                                 | Decision   |
| -------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------- |
| Separate inference and grader Fargate tasks/images | Grader assets never enter model environment; distinct roles and logs | Two task launches per benchmark item; patch transfer through S3                                                 | **Select** |
| One task with inference and grader containers      | Lower launch overhead and easy shared volume                         | Containers in one Fargate task share ephemeral storage/network; model-side compromise can reach grader material | Reject     |

### 4.4. Networking

| Option                                                      | Advantages                                                                             | Costs and risks                                                                       | Decision                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------- |
| Public subnets, public task IPs, zero ingress, HTTPS egress | No hourly NAT gateway; direct Azure/ECR/S3/Logs access; appropriate for ephemeral runs | Public ENIs and broad destination egress; security groups cannot restrict by DNS name | **Select**                 |
| Private subnets with NAT gateways                           | No public task IPs and conventional private placement                                  | Persistent hourly/per-GB NAT cost; one NAT per AZ is needed for resilient egress      | Reject for initial release |
| Private subnets with VPC endpoints plus controlled proxy    | Strongest egress control                                                               | More fixed endpoints/operations; Azure still requires an internet egress proxy        | Reject for initial release |

Public IP assignment does not imply inbound reachability: both task security groups have no ingress rules. Flow Logs, task roles, image separation, and no long-lived service listener are the compensating controls.

### 4.5. Durable Ledger

| Option                                                   | Advantages                                                                                                                | Costs and risks                                                                                             | Decision   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------- |
| Named DVC experiment refs + Git decision index           | Keeps generated metrics/params tied to source baseline and large artifacts out of Git; supports `exp show/diff/push/pull` | Experiment refs need DVC-specific sharing and retention discipline                                          | **Select** |
| Convert every accepted run to a normal Git commit/branch | Familiar Git reachability                                                                                                 | Pollutes source history with generated evaluator state and makes manual decision history harder to separate | Reject     |
| S3-only custom ledger                                    | Direct fit for workers                                                                                                    | Reimplements comparison, content addressing, sharing, and Git association                                   | Reject     |

## 5. Selected Architecture

### 5.1. End-to-End Flow

```text
local preflight/controller
  -> validate Git/Kona/FeatureBench/model/quota/budget/image provenance
  -> upload immutable arm request + 100-item manifest to S3 staging
  -> Step Functions Standard execution
       -> Distributed Map over first 3 tasks
            -> inference Fargate task (Azure secret; no grader assets)
            -> patch + trajectory + usage to immutable S3 key
            -> grader Fargate task (no Azure secret; native tests)
            -> native grade + logs to immutable S3 key
       -> terminal AWAITING_APPROVAL
  -> maintainer approves observed budget/quota or stops
  -> continuation execution validates the same run/epoch and probe seal
       -> Distributed Map over remaining 97 tasks, MaxConcurrencyPath 20 or 50
       -> seal orchestration summary
  -> local collector hash-verifies S3 objects
  -> deterministic analysis and paired reports
  -> named DVC experiment save + dvc exp push
  -> append manual decision reference to Git-tracked index
```

The first three tasks are the first three IDs in the canonical byte-sorted task manifest. Their results are retained in the final 100 and never rerun. Probe approval starts a new Step Functions execution rather than leaving a paid workflow waiting; it supplies the original `runId`, `epochSha256`, and probe `sealSha256`.

### 5.2. Repository Layout

| Path                                            | Responsibility                                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `eval/featurebench/cli.ts`                      | Local `preflight`, `start`, `continue`, `collect`, `compare`, and `decision` interface; no model execution.    |
| `eval/featurebench/contracts.ts`                | Canonical schemas, hashing, IDs, statuses, and validation.                                                     |
| `eval/featurebench/epoch.ts`                    | Build and compare epoch contracts and report every mismatch.                                                   |
| `eval/featurebench/analyze.ts`                  | Deterministic aggregation, paired deltas, confidence intervals, cost, latency, adoption, and validity.         |
| `eval/featurebench/runtime/infer.py`            | One-task direct-container adapter around pinned FeatureBench mini-SWE-agent behavior.                          |
| `eval/featurebench/runtime/grade.py`            | One-task adapter around the pinned native FeatureBench grading implementation.                                 |
| `eval/featurebench/images/inference.Dockerfile` | Parameterized derivative of one pinned official task base; excludes grader assets.                             |
| `eval/featurebench/images/grader.Dockerfile`    | Parameterized derivative of the same base with native grading assets.                                          |
| `eval/featurebench/manifests/fast-v1.1.json`    | Canonical 100 task IDs, dataset commit, 18 source image digests, and derived image digests.                    |
| `eval/featurebench/schemas/*.json`              | JSON Schemas for epoch, arm request, task result, metrics, report, and decision records.                       |
| `eval/featurebench/test/*`                      | Unit, contract, parity, integration, and analysis fixtures.                                                    |
| `dvc.yaml`                                      | Top-level declaration of the evaluator params and metrics files.                                               |
| `.dvc/config.local`                             | Generated, Git-ignored DVC configuration naming remote `eval-s3` at the bootstrap bucket's `dvc/cache` prefix. |
| `eval/experiments/params.yaml`                  | Current workspace's DVC parameter file.                                                                        |
| `eval/experiments/metrics.json`                 | Current workspace's DVC summary metrics.                                                                       |
| `eval/experiments/artifacts/`                   | DVC-tracked collected arm artifacts and report.                                                                |
| `eval/experiments/artifacts.dvc`                | Generated content-addressed pointer for the collected artifact directory.                                      |
| `eval/ledger/decisions.jsonl`                   | Git-tracked append-only manual decision records.                                                               |
| `infra/eval/bootstrap/`                         | Durable state bucket and durable DVC/artifact bucket.                                                          |
| `infra/eval/runtime/`                           | VPC, ECR, ECS, Step Functions, IAM, logs, secret references, and alarms.                                       |

The old `eval/run`, `eval/harbor`, and existing analysis commands remain available for their frozen experiment. No migration edits `docs/eval.md`, rewrites `eval/jobs`, or imports old Harbor results into the new ledger.

### 5.3. Image Contract

1. Pin the FeatureBench source commit and dataset v1.1 revision. Resolve all 18 official Fast image names to Linux/amd64 registry digests; tags are discovery inputs only.
2. Mirror each source manifest into an ECR base repository and record the source digest, ECR digest, platform, and task IDs in `fast-v1.1.json`.
3. Build one inference and one grader derivative per base. Pin every `FROM` by digest and record each resulting ECR digest. Mutable tags may aid humans but task definitions use digests only.
4. Inference images contain the task repository, pinned FeatureBench inference code, pinned mini-SWE-agent, and a bootstrap capable of installing a separately hashed Kona bundle. The image itself contains no Kona asset, native/hidden test, grader code, grader manifest, expected patch, or grader credential.
5. Grader images contain the pristine task repository and native grader. They receive only the candidate patch and non-secret task identity. They contain no Azure credential, Kona bundle, inference trajectory, or model client configuration.
6. The pure and Kona task definitions use the same inference image digest for a task family. The Kona bundle is a separately hashed, read-only artifact installed before prompt construction; pure preflight proves the bundle path, binary, skills, seed, hooks, and Kona environment variables are absent.

Fargate has no privileged mode or host Docker socket. The outer FeatureBench Docker launcher is therefore not called. The direct-container adapters must preserve native FeatureBench behavior at the prompt, agent, parser, patch, and grader boundaries and fail parity tests before images can be promoted.

## 6. Identity, Interfaces, and Data Contracts

### 6.1. Epoch Identity

`epoch.json` is UTF-8 canonical JSON: object keys sorted lexicographically at every level, arrays retained in declared order, no insignificant whitespace, integers only for numeric configuration, and exactly one trailing newline. `epochSha256` is lowercase SHA-256 of those bytes; `epochId` is `fb11-fast-` plus its first 16 hex characters. The full hash is always authoritative.

The hashed object contains:

| Group     | Required fields                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Benchmark | `datasetRepo`, `dataVersion` (`v1.1`), immutable dataset revision, `split` (`fast`), ordered 100 task IDs, task-manifest SHA-256                                         |
| Images    | 18 source digests, 18 inference digests, 18 grader digests, platform `linux/amd64`                                                                                       |
| Harness   | FeatureBench commit/package version, mini-SWE-agent version, agent `mini_swe_agent`, stock prompt SHA-256, transport-adapter SHA-256, `nAttempts: 1`                     |
| Model     | provider `azure`, logical model `gpt-5.6-sol`, deployment name, provider-reported immutable model version, API version, endpoint host, all sampling/reasoning parameters |
| Limits    | inference timeout `3600`, grader timeouts from pinned native settings, token limit, USD `50` per-task cost limit, network policy version                                 |
| Policy    | grader commit/hash, analysis schema/policy version and hash, failure taxonomy version                                                                                    |

Concurrency, timestamps, run IDs, S3 locations, and cost ceilings are arm execution parameters and do not change the epoch. A provider throttle, quota retry, or different effective concurrency makes latency non-comparable; it makes quality non-comparable when it changes task behavior, as required by the PRD.

### 6.2. Arm and Experiment Identity

- `armKey` is `pure-gpt` or `kona-` plus the first 12 characters of the evaluated Git commit.
- A Kona arm records the full Git commit, clean-tree assertion, binary SHA-256, bundle SHA-256, instruction SHA-256, config/seed/hook hashes, and build provenance. Mixed revisions are `INVALID`.
- `runId` is the concatenation of `epochId`, `--`, and `armKey`. Starting an existing primary `runId` is refused. Diagnostic reruns concatenate `diag-`, a UTC basic timestamp, `-`, and eight random lowercase hex characters and are excluded from primary metrics.
- The DVC experiment name equals `runId`. A name collision is accepted only when baseline Git SHA and all content hashes match; otherwise collection fails closed.
- Pure has exactly one valid named experiment per epoch. A Kona report selects the latest earlier Kona decision-index entry with the same full epoch hash as `previousKona`; absence is reported as `null`, not substituted from another epoch.

### 6.3. Local CLI Contract

```text
bun eval/featurebench/cli.ts preflight --request arm-request.json
bun eval/featurebench/cli.ts start --request arm-request.json
bun eval/featurebench/cli.ts continue --run-id RUN_ID --probe-seal-sha256 SHA256
bun eval/featurebench/cli.ts collect --run-id RUN_ID
bun eval/featurebench/cli.ts compare --experiment EXPERIMENT_NAME
bun eval/featurebench/cli.ts decision --record decision.json
```

`arm-request.json` requires schema version 1, full epoch hash, arm type, immutable Git revision, requested concurrency (`20` or `50`), USD budget ceiling, AWS region `us-east-1`, 100-task manifest hash, and the Azure secret ARN. It never contains a secret value. `preflight` validates exact images/assets, clean source, pure isolation, 100 unique tasks, one attempt, AWS capacity, Azure TPM/RPM, projected spend, DVC/Git remotes, and absence of an existing primary arm. A 50-to-20 change requires a new explicit request; no command silently lowers it.

### 6.4. Task Result and Failure Contract

Every inference and grade invocation writes a schema-versioned `result.json` plus `manifest.json` containing each object's SHA-256, byte length, media type, producer image digest, ECS task ARN, start/end timestamps, and exit code.

| Field     | Contract                                                                                                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity  | `schemaVersion`, full `epochSha256`, `runId`, `armKey`, `taskId`, `attempt: 1`, `phase`, `invocationId`                                                                                        |
| Inference | `status`, patch hash/path, trajectory path, prompt hash, mini-SWE exit status, input/output/cache/cache-write tokens, provider request IDs, measured and estimated USD cost, wall milliseconds |
| Kona-only | `instructionsLoaded`, `invocationCount`, `successfulInvocationCount`, `failedInvocationCount`, `validGraphProduced`, mutation-log hash/path                                                    |
| Grade     | native `%PASSED` numerator/denominator, `resolved`, native report hash/path, wall milliseconds                                                                                                 |
| Failure   | `class`, `code`, redacted message, retryability, provider throttling count, quota retry count                                                                                                  |

Failure classes are `TASK`, `PROVIDER`, `HARNESS`, `KONA_SETUP`, `GRADER`, `INFRASTRUCTURE`, `TIMEOUT`, `QUOTA`, and `PROVENANCE`. A valid native failing solution is `TASK` with a valid grade, not an infrastructure error. Missing output is never converted to zero.

Process exits are stable interfaces. Local CLI exit `0` means the requested operation completed, `2` means request/preflight refusal, `3` means collected evidence is incomplete, `4` means evidence is invalid, and `5` means an orchestration, S3, Git, or DVC control-plane failure. Fargate exit `0` means a schema-valid result envelope was durably written, including ordinary task, provider, timeout, or grader outcomes; exit `20` means invalid input/provenance before work, `21` means durable result publication failed, and `22` means an unclassified runtime failure. Native test failure is data in a grader envelope, never a non-zero container exit.

Arm evidence status is:

- `VALID`: exact epoch match; all 100 unique attempt-1 inference and native grade records present; no ambiguous model execution; artifact hashes and remote experiment objects verified.
- `INCOMPLETE`: any task/grade missing, any provider/infrastructure/setup ambiguity, pending probe approval, budget stop, throttling that altered execution, or failed DVC experiment/object push.
- `INVALID`: epoch mismatch, duplicate primary model attempt, pure-arm Kona surface, mixed Kona revision, modified task manifest/grader, digest mismatch, or secret exposure.

### 6.5. Params and Metrics Schemas

`dvc.yaml` declares `eval/experiments/params.yaml` under top-level `params` and `eval/experiments/metrics.json` under top-level `metrics`. The collector tracks `eval/experiments/artifacts/` through `eval/experiments/artifacts.dvc`; it never defines a DVC stage that could rerun paid inference. The dependency lock pins DVC with its S3 extra, FeatureBench, mini-SWE-agent, and every transitive Python package.

`eval/experiments/params.yaml` is the human-readable projection of immutable provenance. Its checked-in JSON Schema forbids additional properties and requires concrete values at collection:

| Path                              | Type and contract                                                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`                  | Integer constant `1`                                                                                                                          |
| `epoch`                           | Complete canonical `epoch.json` object from §6.1, including every benchmark, image, harness, model, limit, and policy field plus full SHA-256 |
| `arm.type`                        | Enum: `pure-gpt` or `kona`                                                                                                                    |
| `arm.key`                         | Deterministic arm key from §6.2                                                                                                               |
| `arm.git_revision`                | Full 40-character lowercase Git SHA                                                                                                           |
| `arm.kona_revision`               | `null` for pure or full 40-character lowercase Git SHA for Kona                                                                               |
| `arm.kona_asset_hashes`           | Empty object for pure; binary, bundle, instruction, config, seed, and hook SHA-256 values for Kona                                            |
| `execution.region`                | Constant `us-east-1`                                                                                                                          |
| `execution.requested_concurrency` | Integer enum: `20` or `50`                                                                                                                    |
| `execution.effective_concurrency` | Observed integer from `1` through requested concurrency                                                                                       |
| `execution.probe_tasks`           | Integer constant `3`                                                                                                                          |
| `execution.budget_usd`            | Positive approved decimal amount                                                                                                              |
| `execution.provider_throttles`    | Non-negative integer                                                                                                                          |
| `execution.quota_retries`         | Non-negative integer                                                                                                                          |

Thus every epoch-compatibility input is visible to DVC params/diffs even though `epochSha256` remains the comparison authority.

`metrics.json` contains numeric/boolean/null leaves so DVC can display and diff them:

```json
{
  "schema_version": 1,
  "quality": { "passed_pct": 0, "resolved_pct": 0, "task_count": 100, "graded_count": 0 },
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "cached_input_tokens": 0,
    "cache_write_tokens": 0
  },
  "cost": { "estimated_usd": 0, "actual_usd": 0 },
  "latency": { "arm_wall_seconds": 0, "task_p50_seconds": 0, "task_p95_seconds": 0 },
  "adoption": {
    "instructions_loaded_tasks": 0,
    "invoked_tasks": 0,
    "successful_invocations": 0,
    "failed_invocations": 0,
    "valid_graph_tasks": 0
  },
  "failures": {
    "task": 0,
    "provider": 0,
    "harness": 0,
    "kona_setup": 0,
    "grader": 0,
    "infrastructure": 0,
    "timeout": 0,
    "quota": 0,
    "provenance": 0
  },
  "execution": {
    "requested_concurrency": 20,
    "effective_concurrency": 0,
    "throttles": 0,
    "quota_retries": 0
  },
  "evidence": { "valid": false, "incomplete": true, "invalid": false }
}
```

`report.json` additionally contains paired task rows and, for each valid comparator, percentage-point delta, paired 95% confidence interval, sample size, missing IDs, estimated MDE, and comparability reasons. The primary metric is native `%PASSED`; `%RESOLVED`, cost, latency, adoption, and failures remain separate supporting evidence.

### 6.6. S3 Layout and Immutability

The bootstrap artifact bucket has versioning, SSE-KMS, public-access block, bucket-owner enforced ownership, access logging, and lifecycle rules. Runtime roles have no `DeleteObject` or version-deletion permission.

```text
staging/v1/epochs/{epochSha256}/arms/{armKey}/control/request.json
staging/v1/epochs/{epochSha256}/arms/{armKey}/control/probe-seal.json
staging/v1/epochs/{epochSha256}/arms/{armKey}/control/final-seal.json
staging/v1/epochs/{epochSha256}/arms/{armKey}/tasks/{taskKey}/claims/model-attempt-1.json
staging/v1/epochs/{epochSha256}/arms/{armKey}/tasks/{taskKey}/inference/{invocationId}/manifest.json
staging/v1/epochs/{epochSha256}/arms/{armKey}/tasks/{taskKey}/inference/{invocationId}/result.json
staging/v1/epochs/{epochSha256}/arms/{armKey}/tasks/{taskKey}/grader/{invocationId}/manifest.json
staging/v1/epochs/{epochSha256}/arms/{armKey}/tasks/{taskKey}/grader/{invocationId}/result.json
dvc/cache/
```

`taskKey` is a URL-safe task slug plus the first eight hex characters of SHA-256 of the original task ID. `invocationId` is the ECS task ID. The inference worker atomically claims the stable attempt key with an S3 conditional put using `If-None-Match: *`; a precondition failure forbids a model call. Writers otherwise create only their own invocation prefix. A seal lists the selected invocation and hashes for every included task; sealing refuses duplicates or mismatches. Versioning protects accidental overwrite, while conditional claims, unique invocation keys, deny-delete IAM, and hash seals provide application-level append-only behavior.

## 7. Workflow, Idempotency, and Recovery

### 7.1. Step Functions Contract

The Standard state machine accepts only validated schema-version-1 input and has these states:

1. `ValidateRequest`: reject wrong region, epoch, arm, manifest, phase, budget approval, or concurrency.
2. `SelectTasks`: `PROBE` selects canonical tasks 1-3; `CONTINUE` verifies the probe seal and selects tasks 4-100.
3. `RunTasks`: Distributed Map with child `ExecutionType: STANDARD`, `MaxConcurrencyPath: $.requestedConcurrency`, and a result writer under the execution-specific S3 prefix.
4. Child `RunInference`: `arn:aws:states:::ecs:runTask.sync`, Linux x86-64 inference task, no state-level retry. Its 4,800-second outer timeout preserves the 3,600-second agent limit while allowing 20 minutes for cold image startup, shutdown, and durable result publication.
5. Child `RunGrader`: only after a sealed inference patch, separate `ecs:runTask.sync` grader task. Retry only ECS launch/service failures, maximum two retries with exponential backoff; native grader failures are recorded once and not retried automatically.
6. Child catches return a structured failure item so the map continues. `ToleratedFailurePercentage` is 100; evidence policy, not Map failure threshold, determines validity.
7. `SealPhase`: writes orchestration summary and expected item count. `PROBE` returns `AWAITING_APPROVAL`; `CONTINUE` returns `READY_TO_COLLECT`.

Fatal control-plane states are `REJECTED_PREFLIGHT`, `INVALID_REQUEST`, `BUDGET_REFUSED`, `PROBE_FAILED`, `MANIFEST_MISMATCH`, and `ORCHESTRATION_FAILED`. Per-task failures do not abort unrelated tasks.

### 7.2. At-Most-One Primary Model Attempt

Before its first Azure call, inference creates a durable `MODEL_CALL_STARTED` record containing the invocation ID and timestamp. A worker that sees any start or terminal marker for the same `runId/taskId/attempt=1` exits without a model call. Step Functions does not retry inference. If the task dies after the marker but before a terminal record, the result is `INCOMPLETE/AMBIGUOUS_MODEL_ATTEMPT`; resume must not guess whether Azure was called.

`continue` and workflow restarts skip only hash-verified sealed task results. Grading can be safely resumed from an immutable patch. Any operator-authorized diagnostic inference uses a diagnostic run ID and is never merged into primary metrics. This makes crash recovery conservative while preserving the one-attempt design.

## 8. DVC Ledger and Manual Decisions

The collector creates a clean temporary worktree at the arm's recorded Git baseline, downloads only sealed objects, verifies every hash, writes the fixed params/metrics/artifact layout, refreshes `artifacts.dvc`, and saves the deterministic experiment name with `dvc exp save --name`. It then runs `dvc exp push -r eval-s3 origin "$experiment_name"` for that exact experiment and verifies the remote ref and required objects by resolving them from a clean cache. Plain `git push` is not sufficient because DVC experiments use custom refs.

Remote `eval-s3` resolves from the bootstrap artifact-bucket output to its `dvc/cache` prefix; staging is not itself the ledger. The bucket URL is local DVC configuration because AWS account-specific names are deployment data, while the remote name is stable repository contract. Only after experiment ref and objects are verified does the arm become `VALID`. Reproduction uses `dvc exp pull origin` for the named experiment and performs report generation offline without Azure calls.

`eval/ledger/decisions.jsonl` is append-only through normal Git review. Each canonical JSON line contains schema version, full epoch hash, experiment name/ref hash, arm key, Kona revision or null, evidence status, decision (`MERGE`, `DO_NOT_MERGE`, `UPGRADE`, `KEEP_CURRENT`, or `DEFER`), decision maker, RFC 3339 UTC timestamp, rationale, pure comparator experiment, and nullable previous-Kona comparator experiment. Corrections append a superseding record by prior record SHA-256; they never edit history. Experiment refs remain the default and are not promoted to branches.

## 9. Terraform and AWS Boundaries

### 9.1. Version and Root Contract

Both roots declare `required_version = "~> 1.16.0"`, `hashicorp/aws = "= 6.33.0"`, and commit `.terraform.lock.hcl` with provider hashes for `linux_amd64` and `darwin_arm64`, the CI and operator platforms.

| Root                   | Owns                                                                                                                                                                                                                                 | Must not own                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `infra/eval/bootstrap` | KMS keys, versioned encrypted Terraform-state bucket, versioned encrypted DVC/artifact bucket, public-access blocks, bucket policies, lifecycle/retention inputs                                                                     | Compute, VPC, ECR, ECS, Step Functions, secret values |
| `infra/eval/runtime`   | VPC, two public subnets across AZs, internet gateway/routes, zero-ingress security groups, ECR repositories, ECS cluster/task definitions, Step Functions, IAM roles/policies, CloudWatch logs/alarms, Secrets Manager ARN reference | State/artifact bucket lifecycle, Azure secret value   |

Bootstrap initially runs with local state, creates both durable buckets, and then migrates its state to `states/bootstrap/terraform.tfstate` using `terraform init -migrate-state`. Runtime initializes directly at `states/runtime/terraform.tfstate`. Both S3 backends set `region = "us-east-1"`, encryption, and `use_lockfile = true`; no DynamoDB table exists because DynamoDB locking is deprecated. Backend credentials are supplied through the AWS credential chain, never backend files or plans.

Bootstrap outputs only bucket/KMS identifiers. Runtime reads those through explicitly configured remote state or validated inputs. Runtime destroy cannot address bootstrap resources. Bucket deletion protection, versioning, and restricted break-glass principals make durable deletion an explicit administrative operation.

### 9.2. Runtime Inputs and Outputs

Validated inputs are region fixed to `us-east-1`, environment name, concurrency enum `20|50`, inference/grader CPU, memory and ephemeral storage, 18-by-2 image digest map, FeatureBench manifest hash, log retention days, common cost tags, artifact/state identifiers, and Azure secret ARN. Defaults may not hide a missing digest or secret ARN.

Outputs are non-secret: cluster ARN, state machine ARN, task-definition ARNs, subnet IDs, security-group IDs, log-group names, ECR repository URLs, artifact bucket name, KMS key ARNs, and region. No output exposes secret versions or values.

### 9.3. IAM and Secrets

- The Azure secret value is created and rotated outside Terraform. Terraform receives only its ARN. ECS secret injection places the value transiently in the inference process environment; it is never in source, image layers, task commands, task-definition plaintext, Terraform plan/state/output, S3 artifacts, or logs.
- Use separate inference and grader task execution roles and task roles. Inference execution can pull only inference ECR images, write its CloudWatch stream, and resolve the Azure secret; its task role can read only sanitized inference requests and write only its own inference/claim prefixes. It cannot read grader requests, grader images, or grader prefixes.
- Grader execution can pull only grader ECR images and write its CloudWatch stream, with no Azure-secret permission. Its task role can read only grader requests, the selected patch and claim, and write its grader prefix; it cannot read inference trajectories or DVC cache.
- The Step Functions role may start only the two task-definition families, pass only their exact roles, describe/stop tasks started by the workflow, use the managed EventBridge integration rule, start/describe child workflows, and access only orchestration result prefixes.
- Human/CI collector credentials, not runtime roles, read sealed staging and read/write the DVC prefix. Terraform operators and backend users are separate from task roles.
- Logs redact authorization headers, API keys, URLs with credentials, provider request bodies, and environment dumps. ECS Exec is disabled for paid runs.

## 10. Observability, Cost, and Operations

- Structured logs include epoch/run/arm/task/invocation IDs, phase, image digest, state transition, durations, provider request ID, retry/throttle class, and redacted error code. They exclude prompts containing secrets, response bodies by default, and environment values.
- CloudWatch dashboards/alarms cover running/pending/stopped tasks, non-zero exits, Map item failures, Azure throttles, grader failures, missing seals, wall time, and estimated/actual spend. Tags include `Project=kona`, `System=evaluation`, epoch ID, arm key, and environment.
- Preflight verifies Fargate vCPU/task quotas and Azure TPM/RPM for the requested preset. Effective concurrency is measured. The scheduler never silently changes 50 to 20.
- The first three tasks update observed token mix, cache rate, duration, grader time, and projected total. Continuation requires an approval record whose ceiling covers projected remaining spend; IAM authorization and CloudTrail identify the principal that started the continuation.
- Current PRD planning remains `$1,000-$6,000` model cost per 100-task arm, approximately `$20-$40` AWS cost at concurrency 20 and `$25-$60` at 50, with 6-8 or 3-4 hours respectively (`prd.md:244-262`). Observed probe data supersedes estimates for approval, not for epoch identity.
- Public subnet/public IP avoids NAT gateway fixed and processing charges. Reconsider private networking when evaluations become continuous, organization policy forbids public ENIs, or a managed egress proxy/VPC endpoint design is funded.

## 11. Deterministic Analysis

Analysis reads only sealed artifacts and the versioned policy. It performs no model or network calls. It validates the full epoch hash before joining exactly on task ID and rejects cross-epoch direct comparisons with a field-level diff.

For pure and previous-Kona comparators it reports all 100 task rows, missing/failure state, absolute native `%PASSED`, paired percentage-point delta, and paired 95% confidence interval. The report states one attempt, sample size, observed paired variance, approximate 80%-power MDE, and limitations. It separately reports `%RESOLVED`, tokens, actual/estimated cost, wall time, requested/effective concurrency, throttles, failures, and Kona adoption. No synthetic score or automatic merge/upgrade verdict is produced.

## 12. Migration and Consequences

1. The FeatureBench evaluator is additive under `eval/featurebench`; existing Harbor scripts and reports retain their original meaning.
2. `docs/eval.md` is frozen and must not be edited by this feature. The new PRD/SPEC govern only the FeatureBench ledger.
3. Existing `eval/analyze/*.ts` logic may be reused only after extraction behind the new schemas and tests; direct parsing of Harbor's non-contractual layout is not an accepted production path.
4. Old jobs are not backfilled as FeatureBench experiments. The first new epoch requires a new pure GPT arm and then the first manually selected Kona revision.
5. Advantages are strong task isolation, honest one-attempt accounting, durable provenance, low idle infrastructure cost, and reproducible comparisons. Costs are 36 derived task images, two Fargate launches per item, local DVC collection, and conservative incomplete outcomes after ambiguous inference crashes.

## 13. Testing Strategy

Implementation follows **RED-GREEN-REFACTOR**: add one failing behavior-focused test, make the smallest change pass, then refactor only with all relevant tests green.

### 13.1. Unit and Contract Tests

| Boundary           | Required coverage                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical identity | Recursive key ordering, newline, integer constraints, full/short hash, changed epoch field, unchanged concurrency, collision refusal                |
| Schemas            | Valid/invalid epoch, request, task result, seal, params, metrics, report, and decision records; unknown fields rejected                             |
| Arm isolation      | Pure rejects every Kona binary/path/env/instruction/hash; Kona rejects mixed revision assets and missing adoption artifacts                         |
| Manifest/images    | Exactly 100 unique Fast IDs, exactly 18 linux/amd64 source and paired derived digests, no mutable task-definition image reference                   |
| Idempotency        | Existing start marker, terminal marker, ambiguous crash, duplicate invocation, grader retry, seal replay, and diagnostic exclusion                  |
| Analysis           | `%PASSED`, `%RESOLVED`, paired deltas/CI, missing tasks, MDE, cost formula, latency comparability, adoption, failure taxonomy, deterministic output |
| Redaction          | Secret values and credential-bearing provider errors never reach logs, manifests, reports, plans, or snapshots                                      |
| Decision index     | Canonical append, allowed decisions, comparator compatibility, supersession, duplicate and mutation rejection                                       |

### 13.2. Integration Tests

| Boundary            | Required coverage                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FeatureBench parity | Pinned stock Docker and direct-container adapters produce byte-identical pure prompt, mini-SWE command/config, patch envelope, parsed result, and native grade on deterministic fixtures |
| Image separation    | Inference image cannot enumerate/read native test or grader assets; grader has no model/Kona/secret surface; both run as linux/amd64                                                     |
| Workflow            | Probe 3 then continuation 97, dynamic 20/50 path, separate `.sync` tasks, no inference retry, grader retry, item catch, seals, and all terminal states                                   |
| Resume              | Completed tasks skip, incomplete grader resumes from patch, post-model ambiguous crash refuses rerun, duplicate primary start fails                                                      |
| S3/DVC              | Unique immutable keys, deny-delete roles, hash corruption rejection, named experiment save/push, clean-cache pull, offline regeneration, `exp show/diff` visibility                      |
| Pairing             | Pure reuse, preceding compatible Kona selection, no previous arm, cross-epoch refusal, quota/throttle comparability rules                                                                |
| Security            | Role-policy negative tests, no inference access to grader ECR/prefix, no grader secret access, zero ingress, TLS egress, secret redaction                                                |
| Migration           | Existing Harbor tests/scripts remain green and `docs/eval.md` hash is unchanged                                                                                                          |

Paid validation begins only after zero-token image/preflight tests pass. A three-task probe validates Azure authentication, both arm configurations over the epoch lifetime, patch transfer, native grading, usage capture, and budget projection. Probe outputs remain primary results; test fixtures and dry runs never enter the ledger.

### 13.3. Infrastructure Tests

- `terraform fmt -check -recursive` passes in both roots.
- `terraform init -backend=false` and `terraform validate` pass in both roots.
- A reviewed, non-secret `terraform plan` proves provider/version locks, 20 and 50 validation, linux/amd64 Fargate definitions, 36 digest-pinned derivatives, Standard Distributed Map with `MaxConcurrencyPath`, separate roles, zero ingress, public IP assignment, logs, tags, and durable/runtime ownership boundaries.
- Bootstrap migration test creates local state, migrates it to versioned S3 with native lockfile, confirms locking, and verifies no DynamoDB resource.
- Destructive sandbox test removes runtime and proves state, staging, DVC cache, versions, and a pulled experiment remain recoverable.

## 14. Definition of Done

### Universal

- [ ] `bun run check` passes, covering typecheck, lint, knip, and tests (`package.json:23-39`).
- [ ] `bun run format:check` passes (`package.json:27-28`).
- [ ] Terraform formatting, backend-disabled initialization, validation, and reviewed speculative plans pass for both roots.
- [ ] No file outside this feature's implementation scope is changed accidentally; `docs/eval.md` remains unchanged.

### Feature-Specific

- [ ] The pinned v1.1 Fast manifest contains exactly 100 tasks and maps all 18 official linux/amd64 image families to source, inference, and grader digests.
- [ ] Pure and Kona use the same pinned FeatureBench-native mini-SWE-agent prompt/harness; automated parity and pure-isolation tests pass.
- [ ] Inference and grading execute directly in separate Fargate tasks without privileged mode, Docker socket, or Docker-in-Docker, and inference cannot access grader assets.
- [ ] A Standard Distributed Map runs 3 probe tasks and then 97 remaining tasks at explicitly approved concurrency 20 or 50 through `ecs:runTask.sync`.
- [ ] At-most-one primary model-attempt behavior survives starts, retries, crashes, resumes, duplicate submissions, and ambiguous completion.
- [ ] Every task emits hash-sealed provenance, result, usage, timing, failure, patch, grading, and applicable Kona adoption artifacts to append-only staging keys.
- [ ] Epoch hashing detects every compatibility input change while allowing concurrency to remain an arm parameter.
- [ ] Analysis deterministically reports native `%PASSED`, paired deltas and confidence intervals against pure and preceding compatible Kona, plus all required supporting evidence.
- [ ] Every completed arm is a deterministic named DVC experiment; `dvc exp push` and clean-checkout `dvc exp pull` restore all artifacts needed for offline reporting.
- [ ] The Git-tracked append-only decision index records a human decision and rationale separately from computed evidence.
- [ ] Bootstrap and runtime Terraform roots use Terraform `~> 1.16.0`, AWS provider `6.33.0`, committed locks, S3 `use_lockfile`, no DynamoDB, and preserve durable data through runtime destroy.
- [ ] Azure secret values remain outside Terraform and persisted artifacts; separate least-privilege inference, grader, orchestration, and collector permissions pass negative tests.
- [ ] CloudWatch evidence and cost controls expose quota, throttling, requested/effective concurrency, failures, duration, and accumulated/projected spend without leaking secrets.
- [ ] The existing eval tests remain green and the frozen long-horizon evaluation is neither rewritten nor reinterpreted.

## 15. References

| Reference                                                                                                                          | Relevance                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [Approved PRD](./prd.md)                                                                                                           | Product scope, economics, metrics, validity, DVC, infrastructure, and acceptance criteria.                                  |
| `eval/README.md:1-79`                                                                                                              | Existing Harbor experiment, isolation intent, execution, and known fidelity gaps.                                           |
| `eval/run/lib.sh:16-30,56-125`                                                                                                     | Current dataset/model/concurrency, credential, and binary-provenance behavior.                                              |
| `eval/run/02-ab.sh:14-47`                                                                                                          | Existing two-job A/B and local analysis flow.                                                                               |
| `eval/harbor/kona_agent.py:44-173,197-273`                                                                                         | Current Kona installation, seed, instruction, and matched baseline mechanics.                                               |
| `eval/analyze/paired.ts:35-58,128-168,170-272`                                                                                     | Existing cost and paired-analysis assumptions to replace with stable schemas.                                               |
| `eval/analyze/trajectory.ts:145-207`                                                                                               | Existing adoption semantics.                                                                                                |
| `eval/analyze/shape.ts:31-119`                                                                                                     | Existing mutation-log graph metrics.                                                                                        |
| `package.json:23-39`                                                                                                               | Repository-wide checks.                                                                                                     |
| [FeatureBench README](https://github.com/LiberCoders/FeatureBench/blob/main/README.md)                                             | Dataset v1.1, 100-task Fast split, 18 official Fast image families, mini-SWE-agent support, and native infer/eval commands. |
| [FeatureBench inference CLI](https://github.com/LiberCoders/FeatureBench/blob/main/docs/infer_cli_arg.md)                          | `mini_swe_agent`, one-attempt default, concurrency, 3,600-second default timeout, resume, and output layout.                |
| [FeatureBench evaluation CLI](https://github.com/LiberCoders/FeatureBench/blob/main/docs/harness_cli_arg.md)                       | Native split-aware grading, task selection, concurrency, timeout, resume, and report layout.                                |
| [FeatureBench Fast images](https://github.com/LiberCoders/FeatureBench/blob/main/featurebench/resources/constants/fast_images.txt) | Authoritative list of 18 Fast image families before digest resolution.                                                      |
| [Step Functions Distributed Map](https://docs.aws.amazon.com/step-functions/latest/dg/state-map-distributed.html)                  | Standard-parent requirement, child workflows, `MaxConcurrencyPath`, result writer, and failure behavior.                    |
| [Step Functions ECS integration](https://docs.aws.amazon.com/step-functions/latest/dg/connect-ecs.html)                            | `arn:aws:states:::ecs:runTask.sync`, failure semantics, and required IAM actions.                                           |
| [ECS Fargate security](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-security-considerations.html)           | Task isolation and lack of privileged containers/host access, including Docker-in-Docker impact.                            |
| [ECS Fargate networking](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-networking.html)                 | Per-task ENIs, public-IP internet path, private NAT alternative, and flow visibility.                                       |
| [DVC experiment sharing](https://dvc.org/doc/user-guide/experiment-management/sharing-experiments)                                 | Experiment custom refs, `dvc exp push`/`pull`, and Git plus DVC remote synchronization.                                     |
| [Terraform S3 backend v1.16](https://developer.hashicorp.com/terraform/language/backend/s3)                                        | Current v1.16.x backend, `use_lockfile`, versioning recommendation, and deprecated DynamoDB locking.                        |
| [Terraform AWS provider v6.33.0](https://github.com/hashicorp/terraform-provider-aws/releases/tag/v6.33.0)                         | Exact selected provider release.                                                                                            |
