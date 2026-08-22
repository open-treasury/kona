/**
 * The seam: `kona` as a **subprocess**.
 *
 * `demo/` never imports `@kona/cli`. §6.12 buys one property with the package graph —
 * "exactly one package calls `writeFile`" — and a rig that reached into the store's
 * internals would spend it. So the rig talks to the same surface a human on stage does:
 * argv in, JSON and an exit code out.
 *
 * It is also the honest test of §6.8's read contract. If `kona graph --json` is really "the
 * only read contract", then a consumer holding nothing but that JSON must be able to drive
 * and inspect a whole pursuit — and this file is that consumer.
 *
 * Exit codes are the API (§6.8): `0` ok · `1` refused · `3` stale base version · `4`
 * invariant violation. They are 8-bit, which is why they are small numbers rather than
 * HTTP-shaped ones — `409` truncates to `153`.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dir, "..", "packages", "kona", "src", "bin.ts");

/** §6.8's table, as values. */
export const EXIT = {
  OK: 0,
  REFUSED: 1,
  STALE_BASE_VERSION: 3,
  INVARIANT_VIOLATION: 4,
} as const;

export class KonaError extends Error {
  readonly code: number;
  readonly stderr: string;
  /** The symbolic reason §6.8 requires every failure to carry. */
  readonly reason: string;

  constructor(argv: readonly string[], code: number, stderr: string) {
    const reason = reasonOf(stderr);
    super(`kona ${argv.join(" ")} exited ${code}: ${stderr.trim()}`);
    this.name = "KonaError";
    this.code = code;
    this.stderr = stderr;
    this.reason = reason;
  }
}

/**
 * There are two stderr grammars, and taking the first token is right for only one of them.
 *
 * The store rejects with `<REASON> node=… detail` — `UNKNOWN_NODE`, `STALE_BASE_VERSION`. The
 * CLI layer rejects with `REFUSED <REASON> detail`, where `REFUSED` is the class and the
 * reason is the second token. One parser, both shapes.
 */
export function reasonOf(stderr: string): string {
  const tokens = stderr.trim().split(/\s+/);
  const first = tokens[0] ?? "UNKNOWN";
  return first === "REFUSED" ? (tokens[1] ?? first) : first;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn the binary. Returns the result whatever the exit code; nothing throws here. */
export async function run(cwd: string, argv: readonly string[]): Promise<RunResult> {
  const proc = Bun.spawn(["bun", BIN, ...argv], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // A pursuit's state is the directory, not the environment. Passing the parent's env
    // through unfiltered would let an ambient variable change what the demo does.
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Spawn, and throw `KonaError` on any non-zero exit. */
export async function runOk(cwd: string, argv: readonly string[]): Promise<RunResult> {
  const result = await run(cwd, argv);
  if (result.code !== EXIT.OK) throw new KonaError(argv, result.code, result.stderr);
  return result;
}

/**
 * The identity `kona brief` speaks as. Written onto the GENESIS RECORD by `kona init
 * --config`, because §6.1 allows `.kona/` no config file and §6.7 requires the pursuit to
 * be reconstructible from the log alone.
 *
 * `brief` REFUSES without one — an executor cannot speak for somebody the graph cannot
 * name — so a rig that skipped this could not dispatch a single node.
 */
export interface PursuitIdentity {
  mailbox: string;
  display_name: string;
  signature: string;
  authority: string;
}

export async function init(
  cwd: string,
  actorId: string,
  config?: { identity: PursuitIdentity; effect_budget?: number },
): Promise<void> {
  if (config === undefined) {
    await runOk(cwd, ["init", "--actor-id", actorId]);
    return;
  }
  const path = join(cwd, "kona-config.json");
  await Bun.write(path, JSON.stringify(config));
  await runOk(cwd, ["init", "--actor-id", actorId, "--config", path]);
}

/**
 * `kona brief <node>` — the correlation token, the identity, and the fail-closed
 * preconditions, from the binary that owns them.
 *
 * NOT `runOk`: `brief` exits non-zero when the preconditions are not met, and it still
 * prints the whole brief. That is the point of it — the caller is meant to read WHY it is
 * not dispatchable, not just learn that it is not.
 */
export interface Brief {
  node: { id: string; label: string; type: string };
  identity: PursuitIdentity;
  correlation: { reply_to: string; subject_tag: string } | null;
  effect_key: string | null;
  preconditions_satisfied: { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] };
  disclosure: { disclosable: string[]; withheld: string[] };
}

export async function brief(cwd: string, nodeId: string): Promise<Brief> {
  const result = await run(cwd, ["brief", nodeId, "--json"]);
  if (result.stdout.trim().length === 0) {
    throw new KonaError(["brief", nodeId], result.code, result.stderr);
  }
  return JSON.parse(result.stdout) as Brief;
}

export interface MutateRequest {
  ops: readonly unknown[];
  baseVersion: number;
  /** Required. §8: "a commit without a rationale is impossible, not discouraged". */
  why: string;
  reasonCode: string;
  actorId?: string;
}

/**
 * The only write path (§6.8). Ops go through a file rather than argv because a batch is
 * routinely larger than a shell's argument limit and because the file is the thing a human
 * can be shown when a commit is refused.
 */
export async function mutate(cwd: string, request: MutateRequest): Promise<RunResult> {
  const dir = await mkdtemp(join(tmpdir(), "kona-demo-ops-"));
  const opsPath = join(dir, "ops.json");
  try {
    await writeFile(opsPath, JSON.stringify(request.ops, null, 2), "utf8");
    const argv = [
      "mutate",
      "--ops",
      opsPath,
      "--base-version",
      String(request.baseVersion),
      "--why",
      request.why,
      "--reason-code",
      request.reasonCode,
      ...(request.actorId === undefined ? [] : ["--actor-id", request.actorId]),
    ];
    return await runOk(cwd, argv);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The only read contract (§6.8). Deliberately typed as `unknown` at the boundary: the rig
 * asserts against the JSON it was actually handed, so a change in the store's shape shows up
 * as a failing assertion rather than as a type that quietly lies.
 */
export async function graph(cwd: string, version?: number): Promise<unknown> {
  const argv =
    version === undefined
      ? ["graph", "--json"]
      : ["graph", "--json", "--version", String(version)];
  const { stdout } = await runOk(cwd, argv);
  return JSON.parse(stdout);
}

/** The ready frontier — computed, never stored. */
export async function next(cwd: string): Promise<string> {
  const { stdout } = await runOk(cwd, ["next"]);
  return stdout;
}
