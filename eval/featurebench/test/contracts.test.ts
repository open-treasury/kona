import { describe, expect, test } from "bun:test";
import {
  armKey,
  assertPrimaryAttemptAvailable,
  canonicalJson,
  epochIdentity,
  sealResults,
  sha256,
  validateArmRequest,
  validateFastManifest,
  type Epoch,
  type FastManifest,
  type TaskResult,
} from "../contracts.ts";
import { compareArms, summarizeArm } from "../analyze.ts";

const hash = "a".repeat(64);
const revision = "b".repeat(40);
const manifest = (): FastManifest => ({
  schemaVersion: 1,
  datasetRepo: "LiberCoders/FeatureBench",
  dataVersion: "v1.1",
  datasetRevision: revision,
  split: "fast",
  tasks: Array.from({ length: 100 }, (_, index) => `task-${index.toString().padStart(3, "0")}`),
  imageFamilies: Array.from(
    { length: 18 },
    (_, index) => `image-${index.toString().padStart(2, "0")}`,
  ),
});

const epoch = (source: FastManifest): Epoch => {
  const digests = Object.fromEntries(
    source.imageFamilies.map((image) => [image, `sha256:${hash}`]),
  );
  return {
    schemaVersion: 1,
    benchmark: {
      datasetRepo: source.datasetRepo,
      dataVersion: source.dataVersion,
      datasetRevision: source.datasetRevision,
      split: "fast",
      taskManifestSha256: sha256(canonicalJson(source)),
    },
    images: {
      platform: "linux/amd64",
      sourceDigests: digests,
      inferenceDigests: digests,
      graderDigests: digests,
    },
    harness: {
      featureBenchRevision: revision,
      miniSweAgentVersion: "2.4.6",
      promptSha256: hash,
      adapterSha256: hash,
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
    policy: { graderSha256: hash, analysisVersion: "v1", failureTaxonomyVersion: "v1" },
  };
};

const result = (taskId: string, passed: number, total = 10): TaskResult => ({
  schemaVersion: 1,
  epochSha256: hash,
  runId: "run",
  armKey: "kona-aaaaaaaaaaaa",
  taskId,
  attempt: 1,
  inference: {
    status: "completed",
    patchSha256: hash,
    inputTokens: 10,
    outputTokens: 2,
    cachedInputTokens: 5,
    cacheWriteTokens: 0,
    costUsd: 1,
    wallMilliseconds: 1000,
    providerThrottles: 0,
    quotaRetries: 0,
    failure: null,
  },
  grade: {
    status: "completed",
    passed,
    total,
    resolved: passed === total,
    wallMilliseconds: 100,
    failure: null,
  },
  adoption: {
    instructionsLoaded: true,
    invocationCount: 2,
    successfulInvocationCount: 2,
    failedInvocationCount: 0,
    validGraphProduced: true,
  },
});

describe("canonical contracts", () => {
  test("canonical JSON recursively orders keys and ends with one newline", () => {
    expect(canonicalJson({ z: 1, a: { y: true, b: false } })).toBe(
      '{"a":{"b":false,"y":true},"z":1}\n',
    );
  });

  test("manifest requires the exact Fast-100 cardinalities", () => {
    expect(validateFastManifest(manifest()).tasks).toHaveLength(100);
    expect(() => validateFastManifest({ ...manifest(), tasks: ["one"] })).toThrow("exactly 100");
    expect(() =>
      validateFastManifest({
        ...manifest(),
        tasks: [...manifest().tasks.slice(0, 99), "task-000"],
      }),
    ).toThrow("unique");
  });

  test("epoch identity changes with compatibility inputs but not execution concurrency", () => {
    const source = manifest();
    const first = epochIdentity(epoch(source), source);
    const changed = epoch(source);
    changed.model.deployment = "sol-next";
    expect(epochIdentity(changed, source).epochSha256).not.toBe(first.epochSha256);
    expect(first.epochId).toMatch(/^fb11-fast-[a-f0-9]{16}$/);
  });

  test("pure rejects Kona assets and Kona requires exact hashes", () => {
    const pure = validateArmRequest({
      schemaVersion: 1,
      epochSha256: hash,
      armType: "pure-gpt",
      gitRevision: revision,
      requestedConcurrency: 20,
      budgetUsd: 10,
      azureSecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:azure",
      kona: null,
    });
    expect(armKey(pure)).toBe("pure-gpt");
    expect(() => validateArmRequest({ ...pure, kona: { revision } })).toThrow(
      "must not contain Kona",
    );
    const kona = validateArmRequest({
      ...pure,
      armType: "kona",
      requestedConcurrency: 50,
      kona: {
        revision,
        binarySha256: hash,
        bundleSha256: hash,
        instructionSha256: hash,
        configSha256: hash,
        seedSha256: hash,
        hooksSha256: hash,
      },
    });
    expect(armKey(kona)).toBe(`kona-${revision.slice(0, 12)}`);
    expect(() => validateArmRequest({ ...pure, unexpected: true })).toThrow("unknown fields");
    const historical = validateArmRequest({
      ...kona,
      gitRevision: "c".repeat(40),
    });
    expect(armKey(historical)).toBe(`kona-${revision.slice(0, 12)}`);
  });

  test("one-attempt claim and result seal fail closed on duplicates", () => {
    expect(() => assertPrimaryAttemptAvailable(true)).toThrow("already claimed");
    expect(
      sealResults([result("b", 1), result("a", 2)]).results.map((item) => item.taskId),
    ).toEqual(["a", "b"]);
    expect(() => sealResults([result("a", 1), result("a", 2)])).toThrow("duplicate");
  });
});

describe("analysis", () => {
  test("reports partial credit over the complete expected task population", () => {
    const summary = summarizeArm(["a", "b"], [result("a", 10), result("b", 5)], true);
    expect(summary.evidence).toBe("VALID");
    expect(summary.quality.passedPct).toBe(75);
    expect(summary.quality.resolvedPct).toBe(50);
    expect(summary.cost.actualUsd).toBe(2);
    expect(summary.adoption.invokedTasks).toBe(2);
  });

  test("missing and duplicate tasks are not ordinary zero scores", () => {
    const incomplete = summarizeArm(["a", "b"], [result("a", 10)], true);
    expect(incomplete.evidence).toBe("INCOMPLETE");
    expect(incomplete.quality.passedPct).toBe(100);
    expect(summarizeArm(["a"], [result("a", 0), result("a", 0)], true).evidence).toBe("INVALID");
  });

  test("Kona evidence is incomplete when the tool was not observed", () => {
    const withoutAdoption = { ...result("a", 10), adoption: null };
    expect(summarizeArm(["a"], [withoutAdoption], true, "kona").evidence).toBe("INCOMPLETE");
    const zeroUse = {
      ...result("a", 10),
      adoption: {
        instructionsLoaded: false,
        invocationCount: 0,
        successfulInvocationCount: 0,
        failedInvocationCount: 0,
        validGraphProduced: false,
      },
    };
    expect(summarizeArm(["a"], [zeroUse], true, "kona").evidence).toBe("VALID");
    expect(summarizeArm(["a"], [zeroUse], true, "kona").adoption.invokedTasks).toBe(0);
  });

  test("paired comparison reports delta, confidence interval, and observed MDE", () => {
    const comparison = compareArms(
      [result("a", 8), result("b", 6)],
      [result("a", 6), result("b", 5)],
    );
    expect(comparison.tasks).toBe(2);
    expect(comparison.meanDeltaPoints).toBeCloseTo(15);
    expect(comparison.confidence95Points.low).toBeLessThan(15);
    expect(comparison.confidence95Points.high).toBeGreaterThan(15);
    expect(comparison.mde80Points).toBeGreaterThan(0);
  });
});
