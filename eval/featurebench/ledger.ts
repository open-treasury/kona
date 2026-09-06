import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson, sha256, type ArmType, type EvidenceStatus } from "./contracts.ts";

export type CommandResult = { exitCode: number; stdout: string; stderr: string };
export type CommandRunner = (argv: readonly string[], cwd: string) => Promise<CommandResult>;

export type ExperimentParams = {
  schema_version: 1;
  epoch: Record<string, unknown> & { epochSha256: string; epochId: string };
  arm: {
    type: ArmType;
    key: string;
    git_revision: string;
    kona_revision: string | null;
    kona_asset_hashes: Record<string, string>;
  };
  execution: {
    region: "us-east-1";
    requested_concurrency: 20 | 50;
    effective_concurrency: number;
    probe_tasks: 3;
    budget_usd: number;
    provider_throttles: number;
    quota_retries: number;
  };
};

export type ExperimentMetrics = {
  schema_version: 1;
  quality: {
    passed_pct: number | null;
    resolved_pct: number | null;
    task_count: 100;
    graded_count: number;
  };
  usage: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    cache_write_tokens: number;
  };
  cost: { estimated_usd: number; actual_usd: number | null };
  latency: {
    arm_wall_seconds: number;
    task_p50_seconds: number | null;
    task_p95_seconds: number | null;
  };
  adoption: {
    instructions_loaded_tasks: number;
    invoked_tasks: number;
    successful_invocations: number;
    failed_invocations: number;
    valid_graph_tasks: number;
  };
  failures: Record<string, number>;
  execution: {
    requested_concurrency: 20 | 50;
    effective_concurrency: number;
    throttles: number;
    quota_retries: number;
  };
  evidence: { valid: boolean; incomplete: boolean; invalid: boolean };
};

export type Decision = "MERGE" | "DO_NOT_MERGE" | "UPGRADE" | "KEEP_CURRENT" | "DEFER";
export type DecisionRecord = {
  schemaVersion: 1;
  epochSha256: string;
  experimentName: string;
  experimentRefSha256: string;
  armKey: string;
  konaRevision: string;
  evidenceStatus: EvidenceStatus;
  decision: Decision;
  decisionMaker: string;
  decidedAt: string;
  rationale: string;
  pureComparator: string;
  previousKonaComparator: string | null;
  supersedesSha256: string | null;
};

const FULL_SHA = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;

export const experimentName = (epochId: string, armKey: string): string => {
  const name = `${epochId}--${armKey}`;
  if (!/^[a-z0-9][a-z0-9-]{1,126}[a-z0-9]$/.test(name)) {
    throw new Error("experiment name must be lowercase ASCII and hyphen-delimited");
  }
  return name;
};

export const assertComparable = (left: ExperimentParams, right: ExperimentParams): void => {
  if (left.epoch.epochSha256 !== right.epoch.epochSha256) {
    throw new Error("experiments belong to different evaluation epochs");
  }
  if (
    left.execution.requested_concurrency !== right.execution.requested_concurrency ||
    left.execution.effective_concurrency !== right.execution.effective_concurrency
  ) {
    throw new Error("latency is not comparable across concurrency settings");
  }
  if (
    left.execution.provider_throttles > 0 ||
    right.execution.provider_throttles > 0 ||
    left.execution.quota_retries > 0 ||
    right.execution.quota_retries > 0
  ) {
    throw new Error("quality is not comparable after quota-induced behavior changes");
  }
};

export const configureDvcRemote = async (
  repositoryRoot: string,
  bucket: string,
  run: CommandRunner,
): Promise<void> => {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("invalid S3 bucket name");
  const result = await run(
    ["dvc", "remote", "add", "--local", "-f", "eval-s3", `s3://${bucket}/dvc/cache`],
    repositoryRoot,
  );
  if (result.exitCode !== 0) throw new Error(`DVC remote configuration failed: ${result.stderr}`);
};

export const saveAndPushExperiment = async (
  repositoryRoot: string,
  name: string,
  params: ExperimentParams,
  metrics: ExperimentMetrics,
  sourceArtifacts: string,
  run: CommandRunner,
): Promise<void> => {
  const head = await run(["git", "rev-parse", "HEAD"], repositoryRoot);
  if (head.exitCode !== 0 || head.stdout.trim() !== params.arm.git_revision) {
    throw new Error("experiment must be saved from its recorded clean Git baseline");
  }
  const status = await run(["git", "status", "--porcelain=v1"], repositoryRoot);
  if (status.exitCode !== 0 || status.stdout.trim()) {
    throw new Error("experiment collection requires a clean Git worktree");
  }
  const experimentRoot = join(repositoryRoot, "eval", "experiments");
  const artifactTarget = join(experimentRoot, "artifacts");
  if (!existsSync(sourceArtifacts)) throw new Error("sealed artifact source does not exist");
  rmSync(artifactTarget, { recursive: true, force: true });
  mkdirSync(experimentRoot, { recursive: true });
  cpSync(sourceArtifacts, artifactTarget, { recursive: true, errorOnExist: false });
  writeFileSync(join(experimentRoot, "params.yaml"), canonicalJson(params));
  writeFileSync(join(experimentRoot, "metrics.json"), canonicalJson(metrics));
  const verificationCache = `/tmp/kona-dvc-verify-${sha256(name).slice(0, 12)}`;
  rmSync(verificationCache, { recursive: true, force: true });
  const commands = [
    ["dvc", "add", "eval/experiments/artifacts"],
    ["dvc", "exp", "save", "--name", name],
    ["dvc", "exp", "push", "-r", "eval-s3", "origin", name],
    ["dvc", "exp", "show", "--json"],
    ["dvc", "status", "--cloud", "-r", "eval-s3"],
  ] as const;
  for (const argv of commands) {
    const result = await run(argv, repositoryRoot);
    if (result.exitCode !== 0)
      throw new Error(`${argv.slice(0, 3).join(" ")} failed: ${result.stderr}`);
  }
  const configured = await run(
    ["dvc", "config", "--local", "cache.dir", verificationCache],
    repositoryRoot,
  );
  if (configured.exitCode !== 0) {
    throw new Error(`DVC verification cache configuration failed: ${configured.stderr}`);
  }
  try {
    const pulled = await run(
      ["dvc", "pull", "--force", "-r", "eval-s3", "eval/experiments/artifacts.dvc"],
      repositoryRoot,
    );
    if (pulled.exitCode !== 0) {
      throw new Error(`DVC recovery verification failed: ${pulled.stderr}`);
    }
  } finally {
    await run(["dvc", "config", "--local", "--unset", "cache.dir"], repositoryRoot);
    rmSync(verificationCache, { recursive: true, force: true });
  }
};

export const validateDecision = (value: DecisionRecord): DecisionRecord => {
  if (value.schemaVersion !== 1) throw new Error("decision schemaVersion must be 1");
  if (!FULL_SHA.test(value.epochSha256) || !FULL_SHA.test(value.experimentRefSha256)) {
    throw new Error("decision hashes must be lowercase SHA-256 values");
  }
  if (!GIT_SHA.test(value.konaRevision))
    throw new Error("decision Kona revision must be a full Git SHA");
  if (!value.decisionMaker.trim() || !value.rationale.trim())
    throw new Error("decision maker and rationale are required");
  if (!Number.isFinite(Date.parse(value.decidedAt)))
    throw new Error("decision timestamp must be RFC 3339");
  return value;
};

export const appendDecision = (path: string, value: DecisionRecord): string => {
  validateDecision(value);
  const line = canonicalJson(value);
  const recordSha256 = sha256(line);
  if (existsSync(path)) {
    const records = readFileSync(path, "utf8").split("\n").filter(Boolean);
    if (records.some((record) => sha256(`${record}\n`) === recordSha256)) {
      throw new Error("decision record already exists");
    }
    if (
      value.supersedesSha256 !== null &&
      !records.some((record) => sha256(`${record}\n`) === value.supersedesSha256)
    ) {
      throw new Error("superseded decision record does not exist");
    }
  } else if (value.supersedesSha256 !== null) {
    throw new Error("cannot supersede a decision in an empty ledger");
  }
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line);
  return recordSha256;
};
