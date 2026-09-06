import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  epochIdentity,
  sha256,
  validateFastManifest,
  type Epoch,
} from "../contracts.ts";
import { taskKey } from "../workflow.ts";

let directory = "";
afterEach(() => directory && rmSync(directory, { recursive: true, force: true }));

test("prepare creates isolated 3/97 workflow inputs without model calls", async () => {
  directory = mkdtempSync(join(tmpdir(), "kona-prepare-"));
  const sourceManifest = join(import.meta.dir, "..", "manifests", "fast-v1.1.json");
  const manifest = validateFastManifest(JSON.parse(readFileSync(sourceManifest, "utf8")));
  const digestMap = Object.fromEntries(
    manifest.imageFamilies.map((image) => [image, `sha256:${"a".repeat(64)}`]),
  );
  const epoch: Epoch = {
    schemaVersion: 1,
    benchmark: {
      datasetRepo: manifest.datasetRepo,
      dataVersion: manifest.dataVersion,
      datasetRevision: manifest.datasetRevision,
      split: "fast",
      taskManifestSha256: sha256(canonicalJson(manifest)),
    },
    images: {
      platform: "linux/amd64",
      sourceDigests: digestMap,
      inferenceDigests: digestMap,
      graderDigests: digestMap,
    },
    harness: {
      featureBenchRevision: "b".repeat(40),
      miniSweAgentVersion: "2.4.6",
      promptSha256: "a".repeat(64),
      adapterSha256: "a".repeat(64),
      nAttempts: 1,
    },
    model: {
      provider: "azure",
      logicalModel: "gpt-5.6-sol",
      deployment: "sol",
      modelVersion: "2026-07-09",
      apiVersion: "v1",
      endpointHost: "example.openai.azure.com",
      parameters: {},
    },
    limits: {
      inferenceTimeoutSeconds: 3600,
      tokenLimit: 1,
      costLimitUsd: 1,
      networkPolicyVersion: "v1",
    },
    policy: {
      graderSha256: "a".repeat(64),
      analysisVersion: "v1",
      failureTaxonomyVersion: "v1",
    },
  };
  const identity = epochIdentity(epoch, manifest);
  const rows = manifest.tasks.map((task, index) => ({
    instance_id: task,
    image_name: manifest.imageFamilies[index % 18],
    problem_statement: "implement feature",
    repo_settings: "{}",
    patch: "mask",
    FAIL_TO_PASS: ["test.py"],
    repo: "owner/repo",
    level: 1,
    test_patch: "hidden",
    PASS_TO_PASS: [],
  }));
  const definitions = Object.fromEntries(
    manifest.imageFamilies.map((image) => [image, `arn:task:${image}`]),
  );
  const paths = {
    epoch: join(directory, "epoch.json"),
    request: join(directory, "request.json"),
    rows: join(directory, "rows.json"),
    infra: join(directory, "infra.json"),
    out: join(directory, "plan"),
  };
  writeFileSync(paths.epoch, canonicalJson(epoch));
  writeFileSync(
    paths.request,
    canonicalJson({
      schemaVersion: 1,
      epochSha256: identity.epochSha256,
      armType: "pure-gpt",
      gitRevision: "b".repeat(40),
      requestedConcurrency: 20,
      budgetUsd: 100,
      azureSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:azure",
      kona: null,
    }),
  );
  writeFileSync(paths.rows, canonicalJson(rows));
  writeFileSync(
    paths.infra,
    canonicalJson({
      artifactBucket: "bucket",
      stateMachineArn: "arn:states",
      inferenceTaskDefinitions: definitions,
      prepareTaskDefinitions: definitions,
      graderTaskDefinitions: definitions,
      pureInferenceTaskRoleArn: "arn:role:pure",
      konaInferenceTaskRoleArn: "arn:role:kona",
      probeSigningKeyArn: "arn:kms:probe",
    }),
  );
  const preparedProcess = Bun.spawn(
    [
      "bun",
      join(import.meta.dir, "..", "cli.ts"),
      "prepare",
      "--manifest",
      sourceManifest,
      "--epoch",
      paths.epoch,
      "--request",
      paths.request,
      "--rows",
      paths.rows,
      "--infra",
      paths.infra,
      "--out",
      paths.out,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await preparedProcess.exited).toBe(0);
  expect(JSON.parse(readFileSync(join(paths.out, "probe.json"), "utf8"))).toHaveLength(3);
  expect(JSON.parse(readFileSync(join(paths.out, "continue.json"), "utf8"))).toHaveLength(97);
  const firstTask = manifest.tasks[0];
  expect(firstTask).toBeDefined();
  const first = JSON.parse(
    readFileSync(
      join(paths.out, "requests", "inference", `${taskKey(firstTask ?? "")}.json`),
      "utf8",
    ),
  );
  expect(first.task.test_patch).toBeUndefined();
  const control = JSON.parse(readFileSync(join(paths.out, "control.json"), "utf8"));
  const bin = join(directory, "bin");
  const awsCalls = join(directory, "aws-calls.txt");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "aws"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${awsCalls}'\ncase "$*" in\n  *"stepfunctions start-execution"*) printf '%s\\n' '{"executionArn":"arn:execution"}' ;;\n  *) printf '%s\\n' '{"VersionId":"version-1"}' ;;\nesac\n`,
  );
  chmodSync(join(bin, "aws"), 0o755);
  const start = Bun.spawn(
    [
      "bun",
      join(import.meta.dir, "..", "cli.ts"),
      "start",
      "--plan-dir",
      paths.out,
      "--phase",
      "probe",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    },
  );
  expect(await start.exited).toBe(0);
  const calls = readFileSync(awsCalls, "utf8");
  expect(calls).toContain('"versionId":"version-1"');
  expect(calls).toContain(
    `${control.runId}-probe-${sha256(readFileSync(join(paths.out, "probe.json"))).slice(0, 12)}`,
  );
  const probeArtifacts = join(directory, "probe-artifacts");
  for (const taskId of manifest.tasks.slice(0, 3)) {
    for (const phase of ["infer", "grade"] as const) {
      const target = join(
        probeArtifacts,
        taskKey(taskId),
        phase === "infer" ? "inference" : "grader",
        "id",
      );
      mkdirSync(target, { recursive: true });
      const result = JSON.stringify(
        phase === "infer"
          ? {
              instance_id: taskId,
              status: "completed",
              patch_sha256: "a".repeat(64),
              usage: { cost_usd: 0.5 },
              wall_milliseconds: 1,
            }
          : {
              instance_id: taskId,
              status: "completed",
              patch_sha256: "a".repeat(64),
              passed: 1,
              total: 1,
              resolved: true,
              wall_milliseconds: 1,
            },
      );
      writeFileSync(join(target, "result.json"), result);
      writeFileSync(
        join(target, "manifest.json"),
        JSON.stringify({
          schema_version: 1,
          epoch_sha256: identity.epochSha256,
          run_id: control.runId,
          task_id: taskId,
          attempt: 1,
          phase,
          ecs_task_arn: "arn:aws:ecs:us-east-1:123456789012:task/cluster/id",
          producer_image_digest: `ecr/image@sha256:${"c".repeat(64)}`,
          files: {
            "result.json": {
              sha256: createHash("sha256").update(result).digest("hex"),
              bytes: Buffer.byteLength(result),
            },
          },
        }),
      );
    }
  }
  const seal = join(directory, "probe-seal.json");
  writeFileSync(join(bin, "aws"), "#!/bin/sh\nprintf '%s\\n' '{\"Signature\":\"c2ln\"}'\n");
  chmodSync(join(bin, "aws"), 0o755);
  const approval = Bun.spawn(
    [
      "bun",
      join(import.meta.dir, "..", "cli.ts"),
      "approve",
      "--plan-dir",
      paths.out,
      "--approved-budget",
      "75",
      "--probe-seal",
      seal,
      "--probe-artifacts",
      probeArtifacts,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    },
  );
  expect(await approval.exited).toBe(0);
  expect(JSON.parse(readFileSync(seal, "utf8"))).toMatchObject({
    approved: true,
    projectedCostUsd: 50,
  });
  writeFileSync(
    seal,
    canonicalJson({
      schemaVersion: 1,
      runId: "wrong",
      epochSha256: identity.epochSha256,
      projectedCostUsd: 50,
      approvedBudgetUsd: 75,
      approved: true,
    }),
  );
  const refused = Bun.spawn(
    [
      "bun",
      join(import.meta.dir, "..", "cli.ts"),
      "start",
      "--plan-dir",
      paths.out,
      "--phase",
      "continue",
      "--probe-seal",
      seal,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await refused.exited).not.toBe(0);
});
