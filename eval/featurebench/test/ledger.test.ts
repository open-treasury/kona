import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendDecision,
  assertComparable,
  configureDvcRemote,
  experimentName,
  saveAndPushExperiment,
  type CommandRunner,
  type DecisionRecord,
  type ExperimentMetrics,
  type ExperimentParams,
} from "../ledger.ts";

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);
const temporary = (): string => {
  const path = mkdtempSync(join(tmpdir(), "kona-ledger-"));
  directories.push(path);
  return path;
};
const hash = "a".repeat(64);
const revision = "b".repeat(40);
const params = (): ExperimentParams => ({
  schema_version: 1,
  epoch: { epochId: "fb11-fast-aaaaaaaaaaaaaaaa", epochSha256: hash },
  arm: {
    type: "kona",
    key: "kona-bbbbbbbbbbbb",
    git_revision: revision,
    kona_revision: revision,
    kona_asset_hashes: { binary: hash },
  },
  execution: {
    region: "us-east-1",
    requested_concurrency: 20,
    effective_concurrency: 20,
    probe_tasks: 3,
    budget_usd: 10,
    provider_throttles: 0,
    quota_retries: 0,
  },
});
const metrics: ExperimentMetrics = {
  schema_version: 1,
  quality: { passed_pct: 50, resolved_pct: 10, task_count: 100, graded_count: 100 },
  usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, cache_write_tokens: 0 },
  cost: { estimated_usd: 1, actual_usd: 1 },
  latency: { arm_wall_seconds: 1, task_p50_seconds: 1, task_p95_seconds: 1 },
  adoption: {
    instructions_loaded_tasks: 100,
    invoked_tasks: 100,
    successful_invocations: 1,
    failed_invocations: 0,
    valid_graph_tasks: 100,
  },
  failures: {},
  execution: {
    requested_concurrency: 20,
    effective_concurrency: 20,
    throttles: 0,
    quota_retries: 0,
  },
  evidence: { valid: true, incomplete: false, invalid: false },
};

describe("DVC experiment ledger", () => {
  test("uses deterministic names and rejects cross-epoch or throttled comparisons", () => {
    expect(experimentName("fb11-fast-aaaaaaaaaaaaaaaa", "pure-gpt")).toBe(
      "fb11-fast-aaaaaaaaaaaaaaaa--pure-gpt",
    );
    const left = params();
    expect(() =>
      assertComparable(left, {
        ...params(),
        epoch: { epochId: "other", epochSha256: "c".repeat(64) },
      }),
    ).toThrow("different evaluation epochs");
    expect(() =>
      assertComparable(left, {
        ...params(),
        execution: { ...params().execution, provider_throttles: 1 },
      }),
    ).toThrow("quota-induced");
  });

  test("configures a local S3 DVC remote without exposing credentials", async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (argv) => {
      calls.push([...argv]);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await configureDvcRemote("/repo", "kona-eval-artifacts-123456789012", run);
    expect(calls).toEqual([
      [
        "dvc",
        "remote",
        "add",
        "--local",
        "-f",
        "eval-s3",
        "s3://kona-eval-artifacts-123456789012/dvc/cache",
      ],
    ]);
  });

  test("saves and pushes one named experiment without running inference", async () => {
    const root = temporary();
    const source = join(root, "sealed");
    const calls: string[][] = [];
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "result.json"), "{}\n");
    await saveAndPushExperiment(
      root,
      "fb11-fast-aaaaaaaaaaaaaaaa--kona-bbbbbbbbbbbb",
      params(),
      metrics,
      source,
      async (argv) => {
        calls.push([...argv]);
        return {
          exitCode: 0,
          stdout: argv[0] === "git" && argv[1] === "rev-parse" ? `${revision}\n` : "",
          stderr: "",
        };
      },
    );
    expect(calls).toEqual([
      ["git", "rev-parse", "HEAD"],
      ["git", "status", "--porcelain=v1"],
      ["dvc", "add", "eval/experiments/artifacts"],
      ["dvc", "exp", "save", "--name", "fb11-fast-aaaaaaaaaaaaaaaa--kona-bbbbbbbbbbbb"],
      [
        "dvc",
        "exp",
        "push",
        "-r",
        "eval-s3",
        "origin",
        "fb11-fast-aaaaaaaaaaaaaaaa--kona-bbbbbbbbbbbb",
      ],
      ["dvc", "exp", "show", "--json"],
      ["dvc", "status", "--cloud", "-r", "eval-s3"],
      ["dvc", "config", "--local", "cache.dir", "/tmp/kona-dvc-verify-819f0f74bbc3"],
      ["dvc", "pull", "-r", "eval-s3", "eval/experiments/artifacts.dvc"],
      ["dvc", "config", "--local", "--unset", "cache.dir"],
    ]);
    expect(
      JSON.parse(readFileSync(join(root, "eval", "experiments", "metrics.json"), "utf8")).quality
        .passed_pct,
    ).toBe(50);
  });

  test("manual decisions append and corrections reference an existing record", () => {
    const path = join(temporary(), "decisions.jsonl");
    const record: DecisionRecord = {
      schemaVersion: 1,
      epochSha256: hash,
      experimentName: "fb11-fast-aaaaaaaaaaaaaaaa--kona-bbbbbbbbbbbb",
      experimentRefSha256: hash,
      armKey: "kona-bbbbbbbbbbbb",
      konaRevision: revision,
      evidenceStatus: "VALID",
      decision: "MERGE",
      decisionMaker: "maintainer",
      decidedAt: "2026-09-06T00:00:00Z",
      rationale: "Improved primary metric without material overhead.",
      pureComparator: "fb11-fast-aaaaaaaaaaaaaaaa--pure-gpt",
      previousKonaComparator: null,
      supersedesSha256: null,
    };
    const first = appendDecision(path, record);
    appendDecision(path, {
      ...record,
      decision: "DEFER",
      rationale: "Correction.",
      supersedesSha256: first,
    });
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
    expect(() => appendDecision(path, { ...record, supersedesSha256: "c".repeat(64) })).toThrow(
      "does not exist",
    );
  });
});
