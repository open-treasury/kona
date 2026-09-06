#!/usr/bin/env bun
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { summarizeArm } from "./analyze.ts";
import {
  collectTaskResults,
  createArtifactSeal,
  verifyArtifactSeal,
  type ArtifactSeal,
} from "./collect.ts";
import {
  armKey,
  canonicalJson,
  epochIdentity,
  sha256,
  validateArmRequest,
  validateFastManifest,
} from "./contracts.ts";
import {
  appendDecision,
  configureDvcRemote,
  experimentName,
  saveAndPushExperiment,
  type DecisionRecord,
  type ExperimentMetrics,
  type ExperimentParams,
} from "./ledger.ts";
import {
  phaseTasks,
  prepareTasks,
  type DatasetRow,
  type InfrastructureOutputs,
} from "./workflow.ts";

const exec = async (argv: readonly string[], cwd: string) => {
  const process = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: await process.exited,
    stdout: await new Response(process.stdout).text(),
    stderr: await new Response(process.stderr).text(),
  };
};

const load = (path: string): unknown => JSON.parse(readFileSync(path, "utf8")) as unknown;
const write = (path: string, value: unknown): void => writeFileSync(path, canonicalJson(value));

const parsed = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    manifest: { type: "string" },
    epoch: { type: "string" },
    request: { type: "string" },
    rows: { type: "string" },
    infra: { type: "string" },
    out: { type: "string" },
    phase: { type: "string" },
    "plan-dir": { type: "string" },
    "run-id": { type: "string" },
    artifacts: { type: "string" },
    params: { type: "string" },
    metrics: { type: "string" },
    experiment: { type: "string" },
    decision: { type: "string" },
    ledger: { type: "string" },
    "probe-seal": { type: "string" },
    "approved-budget": { type: "string" },
    "dvc-bucket": { type: "string" },
    "probe-artifacts": { type: "string" },
    seal: { type: "string" },
  },
});
const command = parsed.positionals[0];
const required = (name: keyof typeof parsed.values): string =>
  parsed.values[name] ??
  (() => {
    throw new Error(`--${name} is required`);
  })();
const repositoryRoot = resolve(import.meta.dir, "..", "..");

if (command === "preflight") {
  const manifest = validateFastManifest(load(required("manifest")));
  const epoch = epochIdentity(load(required("epoch")), manifest);
  const request = validateArmRequest(load(required("request")));
  const infrastructure = load(required("infra")) as InfrastructureOutputs;
  const runId = `${epoch.epochId}--${armKey(request)}`;
  prepareTasks(manifest, load(required("rows")) as DatasetRow[], request, runId, infrastructure);
  if (request.epochSha256 !== epoch.epochSha256) throw new Error("arm request epoch hash mismatch");
  const head = await exec(["git", "rev-parse", "HEAD"], repositoryRoot);
  const status = await exec(["git", "status", "--porcelain=v1"], repositoryRoot);
  if (head.exitCode !== 0 || head.stdout.trim() !== request.gitRevision || status.stdout.trim()) {
    throw new Error("preflight requires the recorded clean Git revision");
  }
  for (const argv of [
    ["git", "remote", "get-url", "origin"],
    ["dvc", "exp", "show", "--json"],
  ] as const) {
    const result = await exec(argv, repositoryRoot);
    if (result.exitCode !== 0)
      throw new Error(`preflight failed: ${argv.join(" ")}: ${result.stderr}`);
  }
  const quota = await exec(
    [
      "aws",
      "service-quotas",
      "get-service-quota",
      "--service-code",
      "fargate",
      "--quota-code",
      "L-3032A538",
      "--output",
      "json",
    ],
    repositoryRoot,
  );
  if (quota.exitCode !== 0) throw new Error(`Fargate quota check failed: ${quota.stderr}`);
  const availableVcpu = (JSON.parse(quota.stdout) as { Quota?: { Value?: number } }).Quota?.Value;
  if (!availableVcpu || availableVcpu < request.requestedConcurrency * 2) {
    throw new Error("Fargate vCPU quota is below requested concurrency capacity");
  }
  const existing = await exec(
    [
      "aws",
      "s3api",
      "head-object",
      "--bucket",
      infrastructure.artifactBucket,
      "--key",
      `requests/v1/runs/${runId}/control.json`,
    ],
    repositoryRoot,
  );
  if (existing.exitCode === 0) throw new Error("primary arm already exists");
  if (!/404|Not Found|NotFound/i.test(existing.stderr)) {
    throw new Error(`primary-arm existence check failed: ${existing.stderr}`);
  }
  console.log(
    canonicalJson({ ok: true, runId, requestedConcurrency: request.requestedConcurrency }),
  );
} else if (command === "prepare") {
  const manifest = validateFastManifest(load(required("manifest")));
  const epoch = epochIdentity(load(required("epoch")), manifest);
  const request = validateArmRequest(load(required("request")));
  if (request.epochSha256 !== epoch.epochSha256) throw new Error("arm request epoch hash mismatch");
  const infrastructure = load(required("infra")) as InfrastructureOutputs;
  const runId = `${epoch.epochId}--${armKey(request)}`;
  const tasks = prepareTasks(
    manifest,
    load(required("rows")) as DatasetRow[],
    request,
    runId,
    infrastructure,
  );
  const output = resolve(required("out"));
  mkdirSync(join(output, "requests", "inference"), { recursive: true });
  mkdirSync(join(output, "requests", "prepare"), { recursive: true });
  mkdirSync(join(output, "requests", "grader"), { recursive: true });
  for (const task of tasks) {
    write(join(output, "requests", "prepare", `${task.taskKey}.json`), task.prepareRequest);
    write(join(output, "requests", "inference", `${task.taskKey}.json`), task.inferenceRequest);
    write(join(output, "requests", "grader", `${task.taskKey}.json`), task.graderRequest);
  }
  write(
    join(output, "probe.json"),
    phaseTasks(tasks, "probe").map((task) => task.workflowItem),
  );
  write(
    join(output, "continue.json"),
    phaseTasks(tasks, "continue").map((task) => task.workflowItem),
  );
  write(join(output, "control.json"), { schemaVersion: 1, runId, epoch, request, infrastructure });
  console.log(runId);
} else if (command === "start") {
  const planDir = resolve(required("plan-dir"));
  const phase = required("phase");
  if (phase !== "probe" && phase !== "continue")
    throw new Error("--phase must be probe or continue");
  const control = load(join(planDir, "control.json")) as {
    runId: string;
    epoch: { epochSha256: string };
    request: { requestedConcurrency: number; budgetUsd: number };
    infrastructure: InfrastructureOutputs;
  };
  if (phase === "continue") {
    const seal = load(required("probe-seal")) as {
      schemaVersion: number;
      runId: string;
      epochSha256: string;
      projectedCostUsd: number;
      approvedBudgetUsd: number;
      approved: boolean;
      probeEvidence: unknown;
      probeAuthorization: {
        runId: string;
        epochSha256: string;
        phase: string;
        continuationManifestSha256: string;
      };
      probeSealSha256: string;
      probeMessage: string;
      probeSignature: string;
    };
    const computedSeal = sha256(canonicalJson(seal.probeAuthorization));
    if (
      seal.schemaVersion !== 1 ||
      !seal.approved ||
      seal.runId !== control.runId ||
      seal.epochSha256 !== control.epoch.epochSha256 ||
      seal.probeAuthorization.runId !== control.runId ||
      seal.probeAuthorization.epochSha256 !== control.epoch.epochSha256 ||
      seal.probeAuthorization.phase !== "continue" ||
      seal.probeAuthorization.continuationManifestSha256 !==
        sha256(readFileSync(join(planDir, "continue.json"))) ||
      seal.projectedCostUsd > seal.approvedBudgetUsd ||
      seal.approvedBudgetUsd > control.request.budgetUsd ||
      seal.probeSealSha256 !== computedSeal ||
      seal.probeMessage !==
        Buffer.from(canonicalJson(seal.probeAuthorization)).toString("base64") ||
      !seal.probeSignature
    ) {
      throw new Error("continuation requires a matching approved probe seal within budget");
    }
  }
  const prefix = `requests/v1/runs/${control.runId}`;
  let result = await exec(
    [
      "aws",
      "s3",
      "sync",
      join(planDir, "requests"),
      `s3://${control.infrastructure.artifactBucket}/${prefix}`,
    ],
    repositoryRoot,
  );
  if (result.exitCode !== 0) throw new Error(result.stderr);
  result = await exec(
    [
      "aws",
      "s3api",
      "put-object",
      "--bucket",
      control.infrastructure.artifactBucket,
      "--key",
      `${prefix}/control.json`,
      "--body",
      join(planDir, "control.json"),
      "--if-none-match",
      "*",
    ],
    repositoryRoot,
  );
  if (result.exitCode !== 0) throw new Error(`run control publication failed: ${result.stderr}`);
  const manifestKey = `orchestration/${control.runId}/${phase}.json`;
  result = await exec(
    [
      "aws",
      "s3",
      "cp",
      join(planDir, `${phase}.json`),
      `s3://${control.infrastructure.artifactBucket}/${manifestKey}`,
    ],
    repositoryRoot,
  );
  if (result.exitCode !== 0) throw new Error(result.stderr);
  const input = canonicalJson({
    phase,
    runId: control.runId,
    epochSha256: control.epoch.epochSha256,
    manifestSha256: sha256(readFileSync(join(planDir, `${phase}.json`))),
    probeApproved: phase === "continue",
    probeSealSha256:
      phase === "continue"
        ? (load(required("probe-seal")) as { probeSealSha256: string }).probeSealSha256
        : null,
    probeMessage:
      phase === "continue"
        ? (load(required("probe-seal")) as { probeMessage: string }).probeMessage
        : null,
    probeSignature:
      phase === "continue"
        ? (load(required("probe-seal")) as { probeSignature: string }).probeSignature
        : null,
    requestedConcurrency: control.request.requestedConcurrency,
    manifest: { bucket: control.infrastructure.artifactBucket, key: manifestKey },
    resultPrefix: `orchestration/${control.runId}/${phase}-results`,
  }).trim();
  result = await exec(
    [
      "aws",
      "stepfunctions",
      "start-execution",
      "--state-machine-arn",
      control.infrastructure.stateMachineArn,
      "--name",
      `${control.runId}-${phase}`,
      "--input",
      input,
    ],
    repositoryRoot,
  );
  if (result.exitCode !== 0) throw new Error(result.stderr);
  process.stdout.write(result.stdout);
} else if (command === "approve") {
  const planDir = resolve(required("plan-dir"));
  const control = load(join(planDir, "control.json")) as {
    runId: string;
    epoch: { epochSha256: string };
    request: { budgetUsd: number };
    infrastructure: InfrastructureOutputs;
  };
  const approvedBudgetUsd = Number(required("approved-budget"));
  const collected = collectTaskResults(resolve(required("probe-artifacts")), {
    epochSha256: control.epoch.epochSha256,
    runId: control.runId,
    armKey: control.runId.split("--").slice(1).join("--"),
  });
  if (
    !collected.artifactsVerified ||
    collected.results.length !== 3 ||
    collected.results.some((result) => result.grade?.status !== "completed")
  ) {
    throw new Error("probe approval requires three hash-verified graded task results");
  }
  const expectedProbeIds = (load(join(planDir, "probe.json")) as { taskId: string }[])
    .map((item) => item.taskId)
    .toSorted();
  if (
    canonicalJson(collected.results.map((result) => result.taskId).toSorted()) !==
    canonicalJson(expectedProbeIds)
  ) {
    throw new Error("probe artifacts do not match the canonical first three tasks");
  }
  const observedCost = collected.results.map((result) => result.inference.costUsd);
  if (observedCost.some((cost) => cost === null)) {
    throw new Error("probe approval requires measured provider cost for every task");
  }
  const measuredCost = observedCost.filter((cost): cost is number => cost !== null);
  const projectedCostUsd =
    (measuredCost.reduce((sum, cost) => sum + cost, 0) / collected.results.length) * 100;
  if (
    !Number.isFinite(approvedBudgetUsd) ||
    approvedBudgetUsd < projectedCostUsd ||
    approvedBudgetUsd > control.request.budgetUsd
  ) {
    throw new Error(
      "approved budget must cover measured projection without exceeding the arm ceiling",
    );
  }
  const probeEvidence = collected.results.map((result) => ({
    taskId: result.taskId,
    patchSha256: result.inference.patchSha256,
    passed: result.grade?.passed,
    total: result.grade?.total,
  }));
  const authorization = {
    schemaVersion: 1,
    runId: control.runId,
    epochSha256: control.epoch.epochSha256,
    phase: "continue",
    continuationManifestSha256: sha256(readFileSync(join(planDir, "continue.json"))),
    projectedCostUsd,
    approvedBudgetUsd,
    probeEvidence,
  };
  const probeMessageText = canonicalJson(authorization);
  const messagePath = `${required("probe-seal")}.message`;
  writeFileSync(messagePath, probeMessageText);
  const signed = await exec(
    [
      "aws",
      "kms",
      "sign",
      "--key-id",
      control.infrastructure.probeSigningKeyArn,
      "--message",
      `fileb://${messagePath}`,
      "--message-type",
      "RAW",
      "--signing-algorithm",
      "RSASSA_PSS_SHA_256",
      "--output",
      "json",
    ],
    repositoryRoot,
  );
  rmSync(messagePath, { force: true });
  if (signed.exitCode !== 0) throw new Error(`probe signing failed: ${signed.stderr}`);
  const probeSignature = (JSON.parse(signed.stdout) as { Signature?: string }).Signature;
  if (!probeSignature) throw new Error("probe signing returned no signature");
  write(required("probe-seal"), {
    schemaVersion: 1,
    runId: control.runId,
    epochSha256: control.epoch.epochSha256,
    projectedCostUsd,
    approvedBudgetUsd,
    approved: true,
    probeEvidence,
    probeAuthorization: authorization,
    probeSealSha256: sha256(probeMessageText),
    probeMessage: Buffer.from(probeMessageText).toString("base64"),
    probeSignature,
  });
} else if (command === "seal") {
  const params = load(required("params")) as ExperimentParams;
  write(
    required("seal"),
    createArtifactSeal(resolve(required("artifacts")), {
      epochSha256: params.epoch.epochSha256,
      runId: required("run-id"),
    }),
  );
} else if (command === "collect") {
  const runId = required("run-id");
  const artifacts = resolve(required("artifacts"));
  const params = load(required("params")) as ExperimentParams;
  const seal = load(required("seal")) as ArtifactSeal;
  if (
    seal.epochSha256 !== params.epoch.epochSha256 ||
    seal.runId !== runId ||
    !verifyArtifactSeal(artifacts, seal)
  ) {
    throw new Error("artifact seal does not match collected files");
  }
  const name = required("experiment");
  if (name !== experimentName(params.epoch.epochId, params.arm.key)) {
    throw new Error("experiment name does not match epoch and arm identity");
  }
  const collected = collectTaskResults(artifacts, {
    epochSha256: params.epoch.epochSha256,
    runId,
    armKey: params.arm.key,
  });
  const summary = summarizeArm(
    (load(required("manifest")) as { tasks: string[] }).tasks,
    collected.results,
    collected.artifactsVerified,
    params.arm.type,
  );
  const metrics = {
    ...(load(required("metrics")) as ExperimentMetrics),
    quality: {
      passed_pct: summary.quality.passedPct,
      resolved_pct: summary.quality.resolvedPct,
      task_count: 100 as const,
      graded_count: summary.quality.gradedCount,
    },
    usage: {
      input_tokens: summary.usage.inputTokens,
      output_tokens: summary.usage.outputTokens,
      cached_input_tokens: summary.usage.cachedInputTokens,
      cache_write_tokens: summary.usage.cacheWriteTokens,
    },
    cost: { estimated_usd: 0, actual_usd: summary.cost.actualUsd },
    latency: {
      arm_wall_seconds: 0,
      task_p50_seconds: summary.latency.taskP50Seconds,
      task_p95_seconds: summary.latency.taskP95Seconds,
    },
    adoption: {
      instructions_loaded_tasks: summary.adoption.instructionsLoadedTasks,
      invoked_tasks: summary.adoption.invokedTasks,
      successful_invocations: summary.adoption.successfulInvocations,
      failed_invocations: summary.adoption.failedInvocations,
      valid_graph_tasks: summary.adoption.validGraphTasks,
    },
    failures: summary.failures,
    evidence: {
      valid: summary.evidence === "VALID",
      incomplete: summary.evidence === "INCOMPLETE",
      invalid: summary.evidence === "INVALID",
    },
  } satisfies ExperimentMetrics;
  await configureDvcRemote(repositoryRoot, required("dvc-bucket"), exec);
  await saveAndPushExperiment(repositoryRoot, name, params, metrics, artifacts, exec);
} else if (command === "decision") {
  const record = load(required("decision")) as DecisionRecord;
  console.log(appendDecision(resolve(required("ledger")), record));
} else {
  throw new Error(
    "usage: cli.ts <preflight|prepare|start|approve|seal|collect|decision> [options]",
  );
}
