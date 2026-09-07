import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectTaskResults, createArtifactSeal, verifyArtifactSeal } from "../collect.ts";

let directory = "";
afterEach(() => directory && rmSync(directory, { recursive: true, force: true }));

const manifest = (phase: "infer" | "grade", content: string) =>
  JSON.stringify({
    schema_version: 1,
    epoch_sha256: "b".repeat(64),
    run_id: "run",
    task_id: "task",
    image_name: "image",
    attempt: 1,
    phase,
    ecs_task_arn: "arn:aws:ecs:us-east-1:123456789012:task/cluster/id",
    producer_image_digest: `ecr/image@sha256:${"c".repeat(64)}`,
    observed_image_digest: `sha256:${"c".repeat(64)}`,
    files: {
      "result.json": {
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: Buffer.byteLength(content),
      },
    },
  });

test("collector verifies manifests before joining inference and grader outputs", () => {
  directory = mkdtempSync(join(tmpdir(), "kona-collect-"));
  const inference = join(directory, "task", "inference", "id");
  const grader = join(directory, "task", "grader", "id");
  mkdirSync(inference, { recursive: true });
  mkdirSync(grader, { recursive: true });
  const inferenceResult = JSON.stringify({
    instance_id: "task",
    status: "completed",
    patch_sha256: "a".repeat(64),
    usage: { input_tokens: 2, output_tokens: 1, cost_usd: 0.2 },
    wall_milliseconds: 10,
  });
  const graderResult = JSON.stringify({
    instance_id: "task",
    status: "completed",
    passed: 4,
    total: 5,
    resolved: false,
    patch_sha256: "a".repeat(64),
    wall_milliseconds: 5,
  });
  writeFileSync(join(inference, "result.json"), inferenceResult);
  writeFileSync(join(grader, "result.json"), graderResult);
  writeFileSync(join(inference, "manifest.json"), manifest("infer", inferenceResult));
  writeFileSync(join(grader, "manifest.json"), manifest("grade", graderResult));
  const identity = {
    epochSha256: "b".repeat(64),
    runId: "run",
    armKey: "pure-gpt",
    inferenceDigests: { image: `sha256:${"c".repeat(64)}` },
    graderDigests: { image: `sha256:${"c".repeat(64)}` },
  };
  const collected = collectTaskResults(directory, identity);
  expect(collected.artifactsVerified).toBe(true);
  expect(collected.results).toHaveLength(1);
  expect(collected.results[0]?.grade?.passed).toBe(4);
  expect(collected.results[0]?.inference.inputTokens).toBe(2);
  expect(
    collectTaskResults(directory, {
      ...identity,
      inferenceDigests: { image: `sha256:${"d".repeat(64)}` },
    }).artifactsVerified,
  ).toBe(false);
  const seal = createArtifactSeal(directory, identity);
  expect(verifyArtifactSeal(directory, seal)).toBe(true);
  writeFileSync(
    join(inference, "result.json"),
    `${readFileSync(join(inference, "result.json"), "utf8")}tampered`,
  );
  expect(collectTaskResults(directory, identity).artifactsVerified).toBe(false);
  expect(verifyArtifactSeal(directory, seal)).toBe(false);
});
