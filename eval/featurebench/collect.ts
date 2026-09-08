import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { canonicalJson, sha256, type Failure, type TaskResult } from "./contracts.ts";

type WorkerFailure = { class?: string; code?: string; message?: string; retryable?: boolean };
type WorkerResult = {
  instance_id?: string;
  status?: string;
  patch_sha256?: string | null;
  usage?: Record<string, number | null>;
  passed?: number;
  total?: number;
  resolved?: boolean;
  wall_milliseconds?: number;
  failure?: WorkerFailure | null;
  adoption?: {
    instructions_loaded?: boolean;
    invocation_count?: number;
    successful_invocation_count?: number;
    failed_invocation_count?: number;
    valid_graph_produced?: boolean;
  };
};
type ArtifactManifest = {
  schema_version?: number;
  epoch_sha256?: string;
  run_id?: string;
  task_id?: string;
  image_name?: string;
  attempt?: number;
  phase?: "prepare" | "infer" | "grade";
  ecs_task_arn?: string;
  producer_image_digest?: string;
  observed_image_digest?: string;
  files?: Record<string, { sha256?: string; bytes?: number }>;
};

export type ArtifactSeal = {
  schemaVersion: 1;
  epochSha256: string;
  runId: string;
  manifests: { path: string; sha256: string }[];
  sealSha256: string;
};

const manifests = (root: string, output: string[] = []): string[] => {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) manifests(path, output);
    else if (entry === "manifest.json") output.push(path);
  }
  return output;
};

export const createArtifactSeal = (
  root: string,
  identity: { epochSha256: string; runId: string },
): ArtifactSeal => {
  const entries = manifests(root)
    .map((path) => ({ path: relative(root, path), sha256: sha256(readFileSync(path)) }))
    .toSorted((left, right) => left.path.localeCompare(right.path));
  const value = {
    schemaVersion: 1 as const,
    epochSha256: identity.epochSha256,
    runId: identity.runId,
    manifests: entries,
  };
  return { ...value, sealSha256: sha256(canonicalJson(value)) };
};

export const verifyArtifactSeal = (root: string, expected: ArtifactSeal): boolean => {
  const actual = createArtifactSeal(root, {
    epochSha256: expected.epochSha256,
    runId: expected.runId,
  });
  if (canonicalJson(actual) !== canonicalJson(expected)) return false;
  for (const entry of expected.manifests) {
    const path = join(root, entry.path);
    let manifest: ArtifactManifest;
    try {
      manifest = JSON.parse(readFileSync(path, "utf8")) as ArtifactManifest;
    } catch {
      return false;
    }
    if (!manifest.files) return false;
    for (const [name, detail] of Object.entries(manifest.files)) {
      const artifact = join(dirname(path), name);
      const stat = statSync(artifact, { throwIfNoEntry: false });
      if (
        !stat?.isFile() ||
        stat.size !== detail.bytes ||
        sha256(readFileSync(artifact)) !== detail.sha256
      ) {
        return false;
      }
    }
  }
  return true;
};

const failure = (value: WorkerFailure | null | undefined): Failure | null => {
  if (!value) return null;
  const allowed = new Set([
    "TASK",
    "PROVIDER",
    "HARNESS",
    "KONA_SETUP",
    "GRADER",
    "INFRASTRUCTURE",
    "TIMEOUT",
    "QUOTA",
    "PROVENANCE",
  ]);
  const kind = allowed.has(value.class ?? "") ? value.class : "INFRASTRUCTURE";
  return {
    class: kind as Failure["class"],
    code: value.code ?? "UNKNOWN",
    message: value.message ?? "",
    retryable: value.retryable === true,
  };
};

export const collectTaskResults = (
  root: string,
  identity: {
    epochSha256: string;
    runId: string;
    armKey: string;
    inferenceDigests?: Record<string, string>;
    graderDigests?: Record<string, string>;
  },
): { results: TaskResult[]; artifactsVerified: boolean } => {
  const inference = new Map<string, WorkerResult>();
  const grades = new Map<string, WorkerResult>();
  let artifactsVerified = true;
  for (const path of manifests(root)) {
    let manifest: ArtifactManifest;
    try {
      manifest = JSON.parse(readFileSync(path, "utf8")) as ArtifactManifest;
    } catch {
      artifactsVerified = false;
      continue;
    }
    if (
      manifest.schema_version !== 1 ||
      manifest.epoch_sha256 !== identity.epochSha256 ||
      manifest.run_id !== identity.runId ||
      manifest.attempt !== 1 ||
      !manifest.task_id ||
      !manifest.image_name ||
      !manifest.ecs_task_arn ||
      !manifest.producer_image_digest?.match(/@sha256:[a-f0-9]{64}$/) ||
      !manifest.observed_image_digest?.match(/^sha256:[a-f0-9]{64}$/) ||
      !manifest.files
    ) {
      artifactsVerified = false;
      continue;
    }
    const expectedDigests =
      manifest.phase === "infer" ? identity.inferenceDigests : identity.graderDigests;
    const expectedDigest = expectedDigests?.[manifest.image_name];
    if (
      expectedDigests !== undefined &&
      (expectedDigest === undefined ||
        !manifest.producer_image_digest.endsWith(`@${expectedDigest}`) ||
        manifest.observed_image_digest !== expectedDigest)
    ) {
      artifactsVerified = false;
    }
    for (const [artifactName, expected] of Object.entries(manifest.files)) {
      const artifact = join(dirname(path), artifactName);
      const detail = statSync(artifact, { throwIfNoEntry: false });
      if (
        !detail?.isFile() ||
        sha256(readFileSync(artifact)) !== expected.sha256 ||
        detail.size !== expected.bytes
      ) {
        artifactsVerified = false;
      }
    }
    const resultPath = join(dirname(path), "result.json");
    if (!statSync(resultPath, { throwIfNoEntry: false })?.isFile()) {
      artifactsVerified = false;
      continue;
    }
    let parsed: WorkerResult;
    try {
      parsed = JSON.parse(readFileSync(resultPath, "utf8")) as WorkerResult;
    } catch {
      artifactsVerified = false;
      continue;
    }
    if (parsed.instance_id !== manifest.task_id) {
      artifactsVerified = false;
      continue;
    }
    if (manifest.phase === "prepare") continue;
    const target =
      manifest.phase === "grade" ? grades : manifest.phase === "infer" ? inference : null;
    if (target === null) {
      artifactsVerified = false;
      continue;
    }
    if (target.has(parsed.instance_id))
      throw new Error(
        `duplicate ${target === grades ? "grade" : "inference"} result for ${parsed.instance_id}`,
      );
    target.set(parsed.instance_id, parsed);
  }
  const results = [...new Set([...inference.keys(), ...grades.keys()])].toSorted().map((taskId) => {
    const infer = inference.get(taskId);
    const grade = grades.get(taskId);
    if (grade && (!infer?.patch_sha256 || grade.patch_sha256 !== infer.patch_sha256)) {
      artifactsVerified = false;
    }
    const usage = infer?.usage ?? {};
    return {
      schemaVersion: 1 as const,
      epochSha256: identity.epochSha256,
      runId: identity.runId,
      armKey: identity.armKey,
      taskId,
      attempt: 1 as const,
      inference: {
        status: infer?.status === "completed" ? ("completed" as const) : ("failed" as const),
        patchSha256: infer?.patch_sha256 ?? null,
        inputTokens: usage["input_tokens"] ?? 0,
        outputTokens: usage["output_tokens"] ?? 0,
        cachedInputTokens: usage["cached_input_tokens"] ?? 0,
        cacheWriteTokens: usage["cache_write_tokens"] ?? 0,
        costUsd: usage["cost_usd"] ?? null,
        wallMilliseconds: infer?.wall_milliseconds ?? 0,
        providerThrottles: usage["provider_throttles"] ?? 0,
        quotaRetries: usage["quota_retries"] ?? 0,
        failure: failure(infer?.failure),
      },
      grade: grade
        ? {
            status: grade.status === "completed" ? ("completed" as const) : ("failed" as const),
            passed: grade.passed ?? 0,
            total: grade.total ?? 0,
            resolved: grade.resolved === true,
            wallMilliseconds: grade.wall_milliseconds ?? 0,
            failure: failure(grade.failure),
          }
        : null,
      adoption: infer?.adoption
        ? {
            instructionsLoaded: infer.adoption.instructions_loaded === true,
            invocationCount: infer.adoption.invocation_count ?? 0,
            successfulInvocationCount: infer.adoption.successful_invocation_count ?? 0,
            failedInvocationCount: infer.adoption.failed_invocation_count ?? 0,
            validGraphProduced: infer.adoption.valid_graph_produced === true,
          }
        : null,
    };
  });
  return { results, artifactsVerified };
};
