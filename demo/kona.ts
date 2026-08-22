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
    const reason = reasonOf(stderr, code);
    super(`kona ${argv.join(" ")} exited ${String(code)}: ${stderr.trim() || describe(code)}`);
    this.name = "KonaError";
    this.code = code;
    this.stderr = stderr;
    this.reason = reason;
  }
}

/**
 * What a bare exit code means when there is no stderr to read.
 *
 * §6.8 requires every non-zero exit to write a symbolic reason, so an EMPTY stderr means the
 * process never reached its own error path — it was killed. A shell reports a signal death as
 * `128 + signum`, which is where 143 (SIGTERM) and 137 (SIGKILL) come from.
 *
 * This exists because of `kona-atq`: a rare `KonaError` with empty stderr under full-suite
 * load, which read as a mystery for as long as nobody could tell 143 from a refusal. It was
 * bun's test runner SIGTERMing the subprocesses of a test that had timed out, and the
 * cascade landing on whatever ran next. Naming it is what turned it into a five-minute fix.
 */
function describe(code: number): string {
  const SIGNALS: Record<number, string> = { 137: "SIGKILL", 143: "SIGTERM", 130: "SIGINT" };
  const signal = SIGNALS[code];
  if (signal !== undefined) {
    return `killed by ${signal} — no stderr, because it never reached its own error path`;
  }
  return code > 128
    ? `killed by signal ${String(code - 128)} — no stderr, because it never reached its own error path`
    : "(no stderr)";
}

/**
 * There are two stderr grammars, and taking the first token is right for only one of them.
 *
 * The store rejects with `<REASON> node=… detail` — `UNKNOWN_NODE`, `STALE_BASE_VERSION`. The
 * CLI layer rejects with `REFUSED <REASON> detail`, where `REFUSED` is the class and the
 * reason is the second token. One parser, both shapes.
 */
export function reasonOf(stderr: string, code = 1): string {
  const trimmed = stderr.trim();
  // Nothing to read. §6.8 makes that impossible for a refusal, so this is a signal.
  if (trimmed.length === 0) return code > 128 ? `KILLED_BY_SIGNAL_${String(code - 128)}` : "UNKNOWN";
  const tokens = trimmed.split(/\s+/);
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
 *
 * Returns the version it committed, read back out of the binary rather than counted here.
 * The caller still passes the `baseVersion` it BELIEVES head to be — that is the CAS, and
 * a wrong belief exits 3 — but what it then narrates is what actually landed.
 */
export async function mutate(cwd: string, request: MutateRequest): Promise<number> {
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
      "--json",
      ...(request.actorId === undefined ? [] : ["--actor-id", request.actorId]),
    ];
    const { stdout } = await runOk(cwd, argv);
    return (JSON.parse(stdout) as { version: number }).version;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Commit, and hand back the refusal instead of throwing when the store says no.
 *
 * `mutate` throws, which is right for a script that knows what it is doing. This exists for
 * the caller that does NOT: an orchestrator proposes, and being refused is information —
 * `PREDICATE_UNSATISFIABLE` means "you cannot record that without also saying what you will
 * do about it", and the right response is a better batch, not a stack trace.
 */
export type MutateOutcome =
  | { ok: true; version: number }
  | { ok: false; reason: string; code: number; stderr: string };

export async function tryMutate(cwd: string, request: MutateRequest): Promise<MutateOutcome> {
  try {
    return { ok: true, version: await mutate(cwd, request) };
  } catch (error) {
    if (!(error instanceof KonaError)) throw error;
    return { ok: false, reason: error.reason, code: error.code, stderr: error.stderr };
  }
}

/* ── the outbox (§6.6) ───────────────────────────────────────────────────────────────── */

/**
 * Step 1: append the intent and fsync, BEFORE a byte moves.
 *
 * Returns the `effect_key` — the slot's name, a function of `(node, created_by_version)` and
 * NOT of the payload, so the same node reserved twice for the same bytes is the same slot
 * rather than a second email. The hash is what proves the bytes; passing the wrong one is
 * refused with `EFFECT_PAYLOAD_MISMATCH` rather than silently sent.
 */
export async function effectReserve(
  cwd: string,
  nodeId: string,
  hash: string,
  why: string,
): Promise<string> {
  const { stdout } = await runOk(cwd, [
    "effect", "reserve", nodeId,
    "--payload-hash", hash,
    "--why", why,
    "--json",
  ]);
  return (JSON.parse(stdout) as { effect_key: string }).effect_key;
}

/**
 * Step 3: the world answered. `sent` moves the node to `done`, `failed` to `failed`, and
 * either way the reservation is closed — which is what stops the slot being re-reserved.
 */
export async function effectRecord(
  cwd: string,
  nodeId: string,
  key: string,
  outcome: "sent" | "failed",
  messageId: string,
  why: string,
): Promise<void> {
  await runOk(cwd, [
    "effect", "record", nodeId,
    "--key", key,
    "--outcome", outcome,
    "--message-id", messageId,
    "--why", why,
  ]);
}

/** The bytes, hashed the way `kona` writes them into the reservation. */
export function payloadHash(body: string): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(body).digest("hex")}`;
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

/**
 * The frontier as data. **The plugin's only source of work** (§6.8), so a rig driving a whole
 * pursuit has to read it the same way — anything else would be the rig deciding what to do
 * next from its own script and calling the result an end-to-end run.
 */
export interface ReadyNode {
  id: string;
  type: "task" | "wait";
  label: string;
  spec: { effect_class: string; effect?: { channel: string; recipient_ref: string } };
}

export async function readyNodes(cwd: string): Promise<ReadyNode[]> {
  const { stdout } = await runOk(cwd, ["next", "--json"]);
  return (JSON.parse(stdout) as { nodes: ReadyNode[] }).nodes;
}

/* ── the mailbox seam (§6.5) ─────────────────────────────────────────────────────────── */

/** A wait that is expecting mail, and the literal address its replies arrive at. */
export interface WaitAddress {
  node_id: string;
  label: string;
  address: string;
  armed: boolean;
}

/** `kona poll` — what should I fetch? The fetching itself is the rig's job, never `kona`'s. */
export async function pollTargets(cwd: string): Promise<WaitAddress[]> {
  const { stdout } = await runOk(cwd, ["poll", "--json"]);
  return (JSON.parse(stdout) as { poll: WaitAddress[] }).poll;
}

/**
 * `kona poll --inbound` — here is what I fetched; which wait does each message belong to?
 *
 * It answers WHICH, never WHAT. Whether Dana said yes is a judgement about prose and the
 * binary refuses to make it — which is the determinism law showing up as an API boundary.
 */
export interface InboundMatch {
  node_id: string;
  message_id: string;
  from: string;
  on: string;
  /** The wait had already resolved. Recorded, never reopening it (§6.5). */
  late: boolean;
}

export async function pollInbound(cwd: string, messages: readonly unknown[]): Promise<InboundMatch[]> {
  const dir = await mkdtemp(join(tmpdir(), "kona-demo-inbound-"));
  const path = join(dir, "inbound.json");
  try {
    await writeFile(path, JSON.stringify(messages), "utf8");
    const { stdout } = await runOk(cwd, ["poll", "--inbound", path, "--json"]);
    return (JSON.parse(stdout) as { matches: InboundMatch[] }).matches;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * `.kona/rejections.jsonl`, through the read contract rather than off the disk.
 *
 * §8: "a refused mutation is procedural memory too" — what the mutator meant to do, in its
 * own words, beside what the store said about it. It is deliberately not a system of record:
 * nothing folds it, and deleting it loses memory rather than state.
 */
export interface Refusal {
  at: string;
  rejection: { reason: string; message: string };
  rationale: { why: string; reason_code: string } | null;
}

export async function rejections(cwd: string): Promise<Refusal[]> {
  const { stdout } = await runOk(cwd, ["graph", "--json", "--rejections"]);
  return (JSON.parse(stdout) as { rejections: Refusal[] }).rejections;
}

/**
 * `kona resume --dry-run` — what a fresh terminal is told, with no session state anywhere.
 *
 * Dry run, so it reports without writing: the repairs it WOULD make are still listed, which
 * is what makes it safe to call at the end of a run purely to assert that there is nothing
 * left to repair.
 */
export interface ResumeReport {
  version: number;
  counts: Record<string, number>;
  frontier: string[];
  waits: { node_id: string; deadline: string | null; overdue: boolean }[];
  unknown_sends: { node_id: string; effect_key: string }[];
  repairs: unknown[];
}

export async function resume(cwd: string): Promise<ResumeReport> {
  const { stdout } = await runOk(cwd, ["resume", "--dry-run", "--json"]);
  return JSON.parse(stdout) as ResumeReport;
}
