import { describe, expect, test } from "bun:test";
import { prepareTasks, phaseTasks, taskKey, type DatasetRow } from "../workflow.ts";
import { type ArmRequest, type FastManifest } from "../contracts.ts";

const manifest: FastManifest = {
  schemaVersion: 1,
  datasetRepo: "LiberCoders/FeatureBench",
  dataVersion: "v1.1",
  datasetRevision: "b".repeat(40),
  split: "fast",
  tasks: Array.from({ length: 100 }, (_, index) => `task-${index}.lv${(index % 2) + 1}`),
  imageFamilies: Array.from({ length: 18 }, (_, index) => `image-${index}`),
};
const row = (index: number): DatasetRow => ({
  instance_id: `task-${index}.lv${(index % 2) + 1}`,
  image_name: `image-${index % 18}`,
  problem_statement: `problem ${index}`,
  repo_settings: "{}",
  patch: "mask",
  FAIL_TO_PASS: ["test.py"],
  repo: "owner/repo",
  test_patch: "tests",
  PASS_TO_PASS: [],
});
const request: ArmRequest = {
  schemaVersion: 1,
  epochSha256: "a".repeat(64),
  armType: "pure-gpt",
  gitRevision: "b".repeat(40),
  requestedConcurrency: 20,
  budgetUsd: 1,
  azureSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:azure",
  kona: null,
};

describe("workflow preparation", () => {
  test("separates inference from grader-only fields", () => {
    const definitions = Object.fromEntries(
      manifest.imageFamilies.map((image) => [image, `arn:${image}`]),
    );
    const tasks = prepareTasks(
      manifest,
      manifest.tasks.map((_, index) => row(index)),
      request,
      "run",
      {
        artifactBucket: "bucket",
        stateMachineArn: "arn:states",
        inferenceTaskDefinitions: definitions,
        prepareTaskDefinitions: definitions,
        graderTaskDefinitions: definitions,
        pureInferenceTaskRoleArn: "arn:role:pure",
        konaInferenceTaskRoleArn: "arn:role:kona",
        probeSigningKeyArn: "arn:kms:probe",
      },
    );
    expect(tasks).toHaveLength(100);
    expect(tasks[0]?.inferenceRequest).not.toHaveProperty("task.test_patch");
    expect(tasks[0]?.inferenceRequest).not.toHaveProperty("task.FAIL_TO_PASS");
    expect(tasks[0]?.prepareRequest).toHaveProperty("task.FAIL_TO_PASS");
    expect(tasks[0]?.graderRequest).toHaveProperty("task.test_patch", "tests");
    expect(tasks[0]?.graderRequest).toHaveProperty("task.level", 1);
    expect(tasks[1]?.graderRequest).toHaveProperty("task.level", 2);
    expect(tasks[0]?.workflowItem.inferenceTaskRoleArn).toBe("arn:role:pure");
    expect(tasks[0]?.workflowItem.inferenceCommand[0]).toBe("infer");
    expect(tasks[0]?.workflowItem.prepareCommand[0]).toBe("prepare");
    expect(tasks[0]?.workflowItem.graderCommand[0]).toBe("grade");
    expect(phaseTasks(tasks, "probe")).toHaveLength(3);
    expect(phaseTasks(tasks, "continue")).toHaveLength(97);
  });

  test("task keys are stable and collision-resistant", () => {
    expect(taskKey("Owner/Repo.test")).toMatch(/^owner-repo-test-[a-f0-9]{8}$/);
    expect(taskKey("a/b")).not.toBe(taskKey("a-b"));
  });
});
