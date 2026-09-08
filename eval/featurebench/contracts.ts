import { createHash } from "node:crypto";

export const FAILURE_CLASSES = [
  "TASK",
  "PROVIDER",
  "HARNESS",
  "KONA_SETUP",
  "GRADER",
  "INFRASTRUCTURE",
  "TIMEOUT",
  "QUOTA",
  "PROVENANCE",
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];
export type ArmType = "pure-gpt" | "kona";
export type EvidenceStatus = "VALID" | "INCOMPLETE" | "INVALID";

export type FastManifest = {
  schemaVersion: 1;
  datasetRepo: "LiberCoders/FeatureBench";
  dataVersion: "v1.1";
  datasetRevision: string;
  split: "fast";
  tasks: string[];
  imageFamilies: string[];
};

export type Epoch = {
  schemaVersion: 1;
  benchmark: {
    datasetRepo: string;
    dataVersion: string;
    datasetRevision: string;
    split: "fast";
    taskManifestSha256: string;
  };
  images: {
    platform: "linux/amd64";
    sourceDigests: Record<string, string>;
    inferenceDigests: Record<string, string>;
    graderDigests: Record<string, string>;
  };
  harness: {
    featureBenchRevision: string;
    miniSweAgentVersion: string;
    promptSha256: string;
    adapterSha256: string;
    nAttempts: 1;
  };
  model: {
    provider: "azure";
    logicalModel: "gpt-5.6-sol";
    deployment: string;
    modelVersion: string;
    apiVersion: string;
    endpointHost: string;
    parameters: Record<string, string | number | boolean>;
  };
  limits: {
    inferenceTimeoutSeconds: 3600;
    tokenLimit: number;
    costLimitUsd: 50;
    networkPolicyVersion: string;
  };
  policy: {
    graderSha256: string;
    analysisVersion: string;
    failureTaxonomyVersion: string;
  };
};

export type EpochIdentity = {
  epoch: Epoch;
  epochSha256: string;
  epochId: string;
};

export type KonaAssets = {
  revision: string;
  binarySha256: string;
  bundleSha256: string;
  instructionSha256: string;
  configSha256: string;
  seedSha256: string;
  hooksSha256: string;
};

export type ArmRequest = {
  schemaVersion: 1;
  epochSha256: string;
  armType: ArmType;
  gitRevision: string;
  requestedConcurrency: 20 | 50;
  budgetUsd: number;
  azureSecretArn: string;
  kona: KonaAssets | null;
};

export type Failure = {
  class: FailureClass;
  code: string;
  message: string;
  retryable: boolean;
};

export type TaskResult = {
  schemaVersion: 1;
  epochSha256: string;
  runId: string;
  armKey: string;
  taskId: string;
  attempt: 1;
  inference: {
    status: "completed" | "failed";
    patchSha256: string | null;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    costUsd: number | null;
    wallMilliseconds: number;
    providerThrottles: number;
    quotaRetries: number;
    failure: Failure | null;
  };
  grade: {
    status: "completed" | "failed";
    passed: number;
    total: number;
    resolved: boolean;
    wallMilliseconds: number;
    failure: Failure | null;
  } | null;
  adoption: {
    instructionsLoaded: boolean;
    invocationCount: number;
    successfulInvocationCount: number;
    failedInvocationCount: number;
    validGraphProduced: boolean;
  } | null;
};

const fail = (message: string): never => {
  throw new Error(message);
};

const object = (value: unknown, name: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
};

const string = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length === 0) fail(`${name} must be a non-empty string`);
  return value as string;
};

const integer = (value: unknown, name: string, minimum = 0): number => {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    fail(`${name} must be an integer >= ${minimum}`);
  }
  return value as number;
};

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void => {
  const actual = Object.keys(value).toSorted();
  const required = [...expected].toSorted();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    fail(`${name} has missing or unknown fields`);
  }
};

const sha256Value = (value: unknown, name: string): string => {
  const result = string(value, name);
  if (!/^[a-f0-9]{64}$/.test(result)) fail(`${name} must be a lowercase SHA-256`);
  return result;
};

const gitRevision = (value: unknown, name: string): string => {
  const result = string(value, name);
  if (!/^[a-f0-9]{40}$/.test(result)) fail(`${name} must be a full lowercase Git revision`);
  return result;
};

const canonicalValue = (value: unknown): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("canonical JSON does not support non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  fail(`canonical JSON does not support ${typeof value}`);
};

export const canonicalJson = (value: unknown): string =>
  `${JSON.stringify(canonicalValue(value))}\n`;

export const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export const validateFastManifest = (value: unknown): FastManifest => {
  const input = object(value, "manifest");
  if (input["schemaVersion"] !== 1) fail("manifest.schemaVersion must be 1");
  if (input["datasetRepo"] !== "LiberCoders/FeatureBench") {
    fail("manifest.datasetRepo must be LiberCoders/FeatureBench");
  }
  if (input["dataVersion"] !== "v1.1") fail("manifest.dataVersion must be v1.1");
  gitRevision(input["datasetRevision"], "manifest.datasetRevision");
  if (input["split"] !== "fast") fail("manifest.split must be fast");
  const rawTasks = input["tasks"];
  if (!Array.isArray(rawTasks) || rawTasks.length !== 100) {
    fail("manifest.tasks must contain exactly 100 task ids");
  }
  const tasks = (rawTasks as unknown[]).map((task, index) =>
    string(task, `manifest.tasks[${index}]`),
  );
  if (new Set(tasks).size !== tasks.length) fail("manifest.tasks must be unique");
  const rawImages = input["imageFamilies"];
  if (!Array.isArray(rawImages) || rawImages.length !== 18) {
    fail("manifest.imageFamilies must contain exactly 18 image names");
  }
  const imageFamilies = (rawImages as unknown[]).map((image, index) =>
    string(image, `manifest.imageFamilies[${index}]`),
  );
  if (new Set(imageFamilies).size !== imageFamilies.length) {
    fail("manifest.imageFamilies must be unique");
  }
  return input as FastManifest;
};

const validateDigestMap = (value: unknown, name: string, expected: readonly string[]): void => {
  const entries = object(value, name);
  const keys = Object.keys(entries).toSorted();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(`${name} must contain exactly the manifest image families`);
  }
  for (const [key, digest] of Object.entries(entries)) {
    const text = string(digest, `${name}.${key}`);
    if (!/^sha256:[a-f0-9]{64}$/.test(text)) fail(`${name}.${key} must be an OCI digest`);
  }
};

export const epochIdentity = (value: unknown, manifest: FastManifest): EpochIdentity => {
  const rawEpoch = object(value, "epoch");
  exactKeys(
    rawEpoch,
    ["schemaVersion", "benchmark", "images", "harness", "model", "limits", "policy"],
    "epoch",
  );
  const epoch = rawEpoch as Epoch;
  if (epoch.schemaVersion !== 1) fail("epoch.schemaVersion must be 1");
  if (epoch.benchmark?.taskManifestSha256 !== sha256(canonicalJson(manifest))) {
    fail("epoch benchmark manifest hash does not match the pinned manifest");
  }
  if (
    epoch.benchmark.datasetRevision !== manifest.datasetRevision ||
    epoch.benchmark.dataVersion !== manifest.dataVersion ||
    epoch.benchmark.split !== manifest.split
  ) {
    fail("epoch benchmark identity does not match the pinned manifest");
  }
  if (epoch.images?.platform !== "linux/amd64") fail("epoch images must use linux/amd64");
  const imageNames = manifest.imageFamilies.toSorted();
  validateDigestMap(epoch.images.sourceDigests, "epoch.images.sourceDigests", imageNames);
  validateDigestMap(epoch.images.inferenceDigests, "epoch.images.inferenceDigests", imageNames);
  validateDigestMap(epoch.images.graderDigests, "epoch.images.graderDigests", imageNames);
  if (epoch.harness?.nAttempts !== 1) fail("epoch harness must use one attempt");
  string(epoch.harness.featureBenchRevision, "epoch.harness.featureBenchRevision");
  string(epoch.harness.miniSweAgentVersion, "epoch.harness.miniSweAgentVersion");
  sha256Value(epoch.harness.promptSha256, "epoch.harness.promptSha256");
  sha256Value(epoch.harness.adapterSha256, "epoch.harness.adapterSha256");
  if (epoch.model?.provider !== "azure" || epoch.model.logicalModel !== "gpt-5.6-sol") {
    fail("epoch model must be Azure GPT-5.6-sol");
  }
  for (const field of ["deployment", "modelVersion", "apiVersion", "endpointHost"] as const) {
    string(epoch.model[field], `epoch.model.${field}`);
  }
  if (epoch.limits?.inferenceTimeoutSeconds !== 3600) {
    fail("epoch must preserve FeatureBench's 3600-second inference timeout");
  }
  if (epoch.limits?.costLimitUsd !== 50) {
    fail("epoch must use the approved USD 50 per-task cost limit");
  }
  for (const [name, limit] of Object.entries({
    tokenLimit: epoch.limits?.tokenLimit,
  })) {
    integer(limit, `epoch.limits.${name}`, 1);
  }
  string(epoch.limits.networkPolicyVersion, "epoch.limits.networkPolicyVersion");
  sha256Value(epoch.policy?.graderSha256, "epoch.policy.graderSha256");
  string(epoch.policy?.analysisVersion, "epoch.policy.analysisVersion");
  string(epoch.policy?.failureTaxonomyVersion, "epoch.policy.failureTaxonomyVersion");
  const epochSha256 = sha256(canonicalJson(epoch));
  return { epoch, epochSha256, epochId: `fb11-fast-${epochSha256.slice(0, 16)}` };
};

export const validateArmRequest = (value: unknown): ArmRequest => {
  const input = object(value, "arm request");
  exactKeys(
    input,
    [
      "schemaVersion",
      "epochSha256",
      "armType",
      "gitRevision",
      "requestedConcurrency",
      "budgetUsd",
      "azureSecretArn",
      "kona",
    ],
    "arm request",
  );
  if (input["schemaVersion"] !== 1) fail("arm request schemaVersion must be 1");
  sha256Value(input["epochSha256"], "armRequest.epochSha256");
  gitRevision(input["gitRevision"], "armRequest.gitRevision");
  if (input["requestedConcurrency"] !== 20 && input["requestedConcurrency"] !== 50) {
    fail("armRequest.requestedConcurrency must be 20 or 50");
  }
  if (typeof input["budgetUsd"] !== "number" || input["budgetUsd"] <= 0) {
    fail("armRequest.budgetUsd must be positive");
  }
  if (!/^arn:aws:secretsmanager:us-east-1:\d{12}:secret:/.test(String(input["azureSecretArn"]))) {
    fail("armRequest.azureSecretArn must be a us-east-1 Secrets Manager ARN");
  }
  if (input["armType"] === "pure-gpt") {
    if (input["kona"] !== null) fail("pure-gpt arm must not contain Kona assets");
  } else if (input["armType"] === "kona") {
    const kona = object(input["kona"], "armRequest.kona");
    exactKeys(
      kona,
      [
        "revision",
        "binarySha256",
        "bundleSha256",
        "instructionSha256",
        "configSha256",
        "seedSha256",
        "hooksSha256",
      ],
      "armRequest.kona",
    );
    gitRevision(kona["revision"], "armRequest.kona.revision");
    for (const field of [
      "binarySha256",
      "bundleSha256",
      "instructionSha256",
      "configSha256",
      "seedSha256",
      "hooksSha256",
    ]) {
      sha256Value(kona[field], `armRequest.kona.${field}`);
    }
  } else {
    fail("armRequest.armType must be pure-gpt or kona");
  }
  return input as ArmRequest;
};

export const armKey = (request: ArmRequest): string => {
  if (request.armType === "pure-gpt") return "pure-gpt";
  const kona = request.kona;
  if (kona === null) return fail("Kona arm requires Kona assets");
  return `kona-${kona.revision.slice(0, 12)}`;
};

export const primaryClaimKey = (runId: string, taskId: string): string =>
  `staging/v1/runs/${runId}/tasks/${taskId}/claims/model-attempt-1.json`;

export const assertPrimaryAttemptAvailable = (claimExists: boolean): void => {
  if (claimExists) fail("primary model attempt is already claimed");
};

export const sealResults = (
  results: readonly TaskResult[],
): { sha256: string; results: TaskResult[] } => {
  const keys = new Set<string>();
  for (const result of results) {
    const key = `${result.taskId}:${result.attempt}`;
    if (keys.has(key)) fail(`duplicate task attempt ${key}`);
    keys.add(key);
  }
  const sorted = [...results].toSorted((left, right) => left.taskId.localeCompare(right.taskId));
  return { sha256: sha256(canonicalJson(sorted)), results: sorted };
};
