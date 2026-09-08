import type { ArmType, EvidenceStatus, FailureClass, TaskResult } from "./contracts.ts";

export type ArmSummary = {
  evidence: EvidenceStatus;
  quality: {
    passedPct: number | null;
    resolvedPct: number | null;
    taskCount: number;
    gradedCount: number;
  };
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
  };
  cost: { actualUsd: number | null };
  latency: { taskP50Seconds: number | null; taskP95Seconds: number | null };
  adoption: {
    instructionsLoadedTasks: number;
    invokedTasks: number;
    successfulInvocations: number;
    failedInvocations: number;
    validGraphTasks: number;
  };
  failures: Record<Lowercase<FailureClass>, number>;
  missingTaskIds: string[];
};

export type PairedComparison = {
  tasks: number;
  meanDeltaPoints: number;
  confidence95Points: { low: number; high: number };
  observedSdPoints: number;
  mde80Points: number;
};

const percentile = (values: readonly number[], probability: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(probability * sorted.length) - 1);
  return sorted[index] ?? null;
};

const failureCounts = (): Record<Lowercase<FailureClass>, number> => ({
  task: 0,
  provider: 0,
  harness: 0,
  kona_setup: 0,
  grader: 0,
  infrastructure: 0,
  timeout: 0,
  quota: 0,
  provenance: 0,
});

export const summarizeArm = (
  expectedTaskIds: readonly string[],
  results: readonly TaskResult[],
  artifactsVerified: boolean,
  armType: ArmType = "pure-gpt",
): ArmSummary => {
  const expected = new Set(expectedTaskIds);
  const seen = new Set<string>();
  let invalid = !artifactsVerified;
  const failures = failureCounts();
  for (const result of results) {
    if (!expected.has(result.taskId) || result.attempt !== 1 || seen.has(result.taskId))
      invalid = true;
    seen.add(result.taskId);
    for (const failure of [result.inference.failure, result.grade?.failure]) {
      if (failure) failures[failure.class.toLowerCase() as Lowercase<FailureClass>] += 1;
    }
  }
  const missingTaskIds = expectedTaskIds.filter((task) => !seen.has(task));
  const graded = results.filter((result) => result.grade?.status === "completed");
  const ambiguous = results.some(
    (result) =>
      result.inference.status !== "completed" ||
      result.inference.providerThrottles > 0 ||
      result.inference.quotaRetries > 0 ||
      (result.inference.failure !== null && result.inference.failure.class !== "TASK") ||
      result.grade === null ||
      result.grade.status !== "completed" ||
      result.grade.failure !== null ||
      result.grade.total === 0,
  );
  const adoptionMissing = armType === "kona" && results.some((result) => result.adoption === null);
  const passedPct =
    expectedTaskIds.length === 0
      ? null
      : (graded.reduce((sum, result) => {
          const grade = result.grade;
          return sum + (grade && grade.total > 0 ? grade.passed / grade.total : 0);
        }, 0) /
          expectedTaskIds.length) *
        100;
  const resolvedPct =
    expectedTaskIds.length === 0
      ? null
      : (graded.filter((result) => result.grade?.resolved === true).length /
          expectedTaskIds.length) *
        100;
  const costs = results
    .map((result) => result.inference.costUsd)
    .filter((v): v is number => v !== null);
  const seconds = results.map((result) => result.inference.wallMilliseconds / 1000);
  const adoptions = results.map((result) => result.adoption).filter((v) => v !== null);
  return {
    evidence: invalid
      ? "INVALID"
      : missingTaskIds.length > 0 ||
          graded.length < expectedTaskIds.length ||
          ambiguous ||
          adoptionMissing
        ? "INCOMPLETE"
        : "VALID",
    quality: {
      passedPct,
      resolvedPct,
      taskCount: expectedTaskIds.length,
      gradedCount: graded.length,
    },
    usage: {
      inputTokens: results.reduce((sum, result) => sum + result.inference.inputTokens, 0),
      outputTokens: results.reduce((sum, result) => sum + result.inference.outputTokens, 0),
      cachedInputTokens: results.reduce(
        (sum, result) => sum + result.inference.cachedInputTokens,
        0,
      ),
      cacheWriteTokens: results.reduce((sum, result) => sum + result.inference.cacheWriteTokens, 0),
    },
    cost: {
      actualUsd:
        costs.length === expectedTaskIds.length
          ? costs.reduce((sum, value) => sum + value, 0)
          : null,
    },
    latency: {
      taskP50Seconds: percentile(seconds, 0.5),
      taskP95Seconds: percentile(seconds, 0.95),
    },
    adoption: {
      instructionsLoadedTasks: adoptions.filter((value) => value.instructionsLoaded).length,
      invokedTasks: adoptions.filter((value) => value.invocationCount > 0).length,
      successfulInvocations: adoptions.reduce(
        (sum, value) => sum + value.successfulInvocationCount,
        0,
      ),
      failedInvocations: adoptions.reduce((sum, value) => sum + value.failedInvocationCount, 0),
      validGraphTasks: adoptions.filter((value) => value.validGraphProduced).length,
    },
    failures,
    missingTaskIds,
  };
};

const passRate = (result: TaskResult): number | null => {
  const grade = result.grade;
  return grade?.status === "completed" && grade.total > 0 ? grade.passed / grade.total : null;
};

export const compareArms = (
  candidate: readonly TaskResult[],
  comparator: readonly TaskResult[],
): PairedComparison => {
  const byTask = new Map(comparator.map((result) => [result.taskId, result]));
  const deltas = candidate.flatMap((result) => {
    const left = passRate(result);
    const paired = byTask.get(result.taskId);
    const right = paired === undefined ? null : passRate(paired);
    return left === null || right === null ? [] : [(left - right) * 100];
  });
  if (deltas.length < 2) throw new Error("at least two graded task pairs are required");
  const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const variance =
    deltas.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (deltas.length - 1);
  const sd = Math.sqrt(variance);
  const halfWidth = (1.96 * sd) / Math.sqrt(deltas.length);
  return {
    tasks: deltas.length,
    meanDeltaPoints: mean,
    confidence95Points: { low: mean - halfWidth, high: mean + halfWidth },
    observedSdPoints: sd,
    mde80Points: (2.802 * sd) / Math.sqrt(deltas.length),
  };
};
