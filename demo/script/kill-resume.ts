/**
 * T8.3 — kill and resume, rehearsed. **With a real `kill -9`.**
 *
 * `packages/kona/test/kill-resume.test.ts` already covers the states a crash leaves behind —
 * a torn line, a stale lock, an open reservation — and it says so honestly in its own header:
 * "a process cannot kill itself mid-syscall inside a test, so what is simulated here is the
 * exact state a crash leaves behind". That is the right test and it has one gap it cannot
 * close: **it assumes the simulation is faithful.** If a real SIGKILL left something else on
 * disk — a different lock shape, a partial line in a place `dropTornTail` does not look —
 * every one of those tests would still pass.
 *
 * So this sends the actual signal. A detached child process group runs a real pursuit through
 * the real binary; the parent sends `SIGKILL` to the whole group, which takes down whichever
 * `kona` subprocess happened to be mid-write; and then a genuinely fresh process reads the
 * directory and has to say what is going on.
 *
 * ## The three rehearsals
 *
 * | | killed | what a fresh terminal has to do |
 * |---|---|---|
 * | 1 | with a reservation open, nothing sent | surface the unknown send, repair nothing, **re-send nothing** |
 * | 2 | at eight offsets through a live run | state the status every time, and let a human clear whatever is stuck |
 * | 3 | before any bytes moved | **finish the pursuit**, from the log alone |
 *
 * Rehearsal 2 is a sweep rather than one kill, and deliberately: where the signal lands is
 * not under anyone's control, so the claim worth making is not "we survive this one moment"
 * but "we survive whichever moment it was". Eight offsets across a run that spawns the binary
 * about forty times lands inside a `kona` process most of the time, and across the range hits
 * before the lock, while holding it, and after the append.
 *
 * Rehearsal 3 is the strongest of the three and the one the ticket does not ask for. §6.7's D1
 * says everything is derivable from the file alone; the honest test of that is not a report,
 * it is picking the work back up in a different process and getting to the end.
 *
 * ## The in-process mailbox dies with the child, and that is not a product limit
 *
 * `MemoryMailboxProvider` holds its threads in memory, so a killed run loses the mailbox as
 * well as its place. That is why rehearsal 3 kills BEFORE any send: what it is testing is
 * whether the pursuit's state survives, and a rig whose fake mail server also died would be
 * failing for a reason no real deployment has. Against Mailpit — or Gmail — the mailbox is
 * exactly the thing that does survive, which is §6.5's point that reconciliation is truth.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { steppingClock } from "../mailbox/clock.ts";
import { MemoryMailboxProvider } from "../mailbox/memory.ts";
import * as kona from "../kona.ts";
import { runPursuit } from "./pursuit.ts";

const RUN_START = "2026-08-20T09:00:00.000Z";
const SELF = import.meta.path;

/** §8's Definition of Done. Generous on purpose: what matters is that it is BOUNDED. */
export const STATUS_BUDGET_MS = 60_000;

/* ── the child ───────────────────────────────────────────────────────────────────────── */

/**
 * What the killed process was doing. Two shapes, because the two interesting crash points
 * are at different levels: one is between two `kona` invocations that the rig sequences, the
 * other is inside one of them.
 */
export type RunnerMode = "reserve-and-hang" | "full-pursuit";

async function runner(mode: RunnerMode, cwd: string): Promise<void> {
  const provider = new MemoryMailboxProvider({ clock: steppingClock(RUN_START) });

  if (mode === "full-pursuit") {
    // `narrate: true` is the protocol: one line per iteration, `  <n>. v<a>→v<b> …`, which
    // is what the parent anchors its kill to. Anchoring beats a wall-clock offset — it
    // cannot overrun the end of the run, and it names WHICH beat was interrupted.
    await runPursuit({ provider, cwd, narrate: true, resume: existsSync(join(cwd, ".kona")) });
    return;
  }

  // Reserve, announce the slot, and then never come back — the exact shape of §6.6's crash
  // window 2: the intent is on disk and fsynced, and nothing has left.
  await runPursuit({
    provider,
    cwd,
    narrate: false,
    beforeSend: async (nodeId, effectKey) => {
      console.log(`REHEARSAL reserved ${nodeId} ${effectKey}`);
      await new Promise<never>(() => undefined);
    },
  });
}

/* ── the parent ──────────────────────────────────────────────────────────────────────── */

export interface Killed {
  /** Lines the child printed before it died. The transcript a stage audience sees. */
  said: string[];
  /** Milliseconds from spawn to signal. */
  after: number;
}

/**
 * Spawn the runner in **its own process group**, wait for `until`, then `kill -9` the group.
 *
 * The group is the point. `kill -9 <child>` would leave the `kona` subprocess it spawned
 * running, and that process would finish its write and release the lock — which is a tidy
 * shutdown wearing a crash's clothes. Killing the group takes the writer down mid-syscall,
 * which is the thing being rehearsed.
 */
export interface KillPoint {
  /** Wait until the child prints a line containing this. */
  marker: string;
  /** Then wait this long, so the signal lands somewhere INSIDE the work that follows. */
  thenMs?: number;
}

export async function killDuring(mode: RunnerMode, cwd: string, until: KillPoint): Promise<Killed> {
  const child = spawn("bun", [SELF, "--runner", mode, cwd], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
  });
  const started = Date.now();
  const said: string[] = [];

  const { pid } = child;
  if (pid === undefined) throw new Error("the runner never started; there is nothing to kill");

  let buffered = "";
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    const arrive = (): void => {
      if (settled) return;
      settled = true;
      if (until.thenMs === undefined) {
        resolve();
        return;
      }
      setTimeout(resolve, until.thenMs);
    };
    const give_up = (why: string): void => {
      if (settled) return;
      settled = true;
      reject(new Error(why));
    };

    child.on("error", (cause) => {
      give_up(`the runner could not be started: ${cause.message}`);
    });
    // A child that finishes before we can kill it is a rehearsal that did not happen. Loud,
    // because the alternative is a passing test that killed nothing.
    child.on("exit", (code, signal) => {
      give_up(
        `the runner exited (code ${String(code)}, signal ${String(signal)}) before it could be ` +
          `killed — the offset needs retuning. It said:\n  ${said.join("\n  ")}`,
      );
    });

    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      said.push(...lines);
      if (lines.some((line) => line.includes(until.marker))) arrive();
    });
  });

  await ready;

  const after = Date.now() - started;
  // Negative pid: the GROUP. This is `kill -9` as a human would type it.
  process.kill(-pid, "SIGKILL");
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  // The group's other members die with it, but `close` only speaks for the leader. A moment
  // here lets the kernel finish reaping before anything reads the directory.
  await new Promise<void>((resolve) => setTimeout(resolve, 50));

  return { said: said.filter((line) => line.length > 0), after };
}

/* ── what a fresh terminal sees ──────────────────────────────────────────────────────── */

export interface FreshTerminal {
  /** How long `kona resume --dry-run` took to answer, wall clock. */
  tookMs: number;
  exitCode: number;
  report: kona.ResumeReport;
  /** Whether a write is possible right now, or whether something is in the way. */
  canWrite: boolean;
  /** A lockfile the dead process left behind, and what the CLI says about it. */
  stuckLock: { present: boolean; reason: string; message: string };
}

/**
 * Everything a person gets by walking up to the machine and typing two commands.
 *
 * No session state is possible here: this is a different process from the one that died, and
 * `resume` is a pure read — it never takes the write lock, so it answers even when a corpse
 * is still holding one. That separation is what makes "state the status" survivable at all.
 */
export async function freshTerminal(cwd: string): Promise<FreshTerminal> {
  const started = Date.now();
  const asked = await kona.run(cwd, ["resume", "--dry-run", "--json"]);
  const tookMs = Date.now() - started;

  // The second command: try to write. Either it works, or it names the lock and says what to
  // do about it. A third outcome — silently taking a dead process's lock — is the one the
  // design refuses, because there is no POSIX compare-and-delete that makes it safe.
  // `effect reserve` on a node that does not exist. The verb takes the lock BEFORE it looks
  // the node up, so a healthy pursuit answers `UNKNOWN_NODE` and a stuck one answers about
  // the lock — and neither writes a byte either way.
  const probe = await kona.run(cwd, [
    "effect",
    "reserve",
    "no-such-node",
    "--payload-hash",
    "sha256:0",
    "--why",
    "probing whether writes are possible at all",
  ]);
  const locked = /^REFUSED (STALE_LOCK|LOCK_HELD) /.exec(probe.stderr.trim());

  return {
    tookMs,
    exitCode: asked.code,
    report: JSON.parse(asked.stdout) as kona.ResumeReport,
    // `UNKNOWN_NODE` means the lock was taken, the log folded, and the only complaint was
    // about the node nobody expected to find. That is a healthy pursuit.
    canWrite: probe.stderr.includes("UNKNOWN_NODE"),
    stuckLock: {
      present: locked !== null,
      reason: locked?.[1] ?? "",
      message: probe.stderr.trim(),
    },
  };
}

/** What a human does about a lock a dead process left: check, then delete. Never the CLI. */
export async function clearStaleLock(cwd: string): Promise<boolean> {
  const path = join(cwd, ".kona", "lock");
  if (!existsSync(path)) return false;
  await rm(path, { force: true });
  return true;
}

/* ── the rehearsals ──────────────────────────────────────────────────────────────────── */

export interface Rehearsal {
  name: string;
  /** The pursuit directory, kept so a caller can go and look at what survived. */
  cwd: string;
  killedAfterMs: number;
  fresh: FreshTerminal;
  /** Only rehearsal 1: the reservation that was open when the process died. */
  unknownSend?: { node_id: string; effect_key: string };
  /** Only rehearsal 3: where the restarted loop got to. */
  finishedAt?: number;
  clearedLock: boolean;
}

export interface RehearsalResult {
  rehearsals: Rehearsal[];
  /** The slowest `kona resume` across every kill. §8's number is a ceiling on this. */
  slowestStatusMs: number;
}

/**
 * Where rehearsal 2 aims: an iteration to wait for, and how long to let the next one run.
 *
 * The marker is printed when an iteration FINISHES, so `{iteration: 2, thenMs: 0}` kills at
 * the top of iteration 3. The offsets are chosen to land mid-spawn — the binary takes about
 * 120ms to start, read, validate and append — because a signal that always arrived between
 * two `kona` processes would never test the thing the lock exists for.
 */
export interface SweepPoint {
  iteration: number;
  thenMs: number;
}

export const FULL_SWEEP: SweepPoint[] = [1, 2, 3, 4].flatMap((iteration) =>
  [0, 120].map((thenMs) => ({ iteration, thenMs })),
);

export interface RehearseOptions {
  narrate?: boolean;
  /**
   * Fewer kills, for the automated run.
   *
   * Every point is a whole pursuit spawned and destroyed, so the eight-point sweep costs
   * about a minute — worth it on stage and on demand, too slow to sit in `bun test` on every
   * save. The test takes three points spanning the same range. The property asserted is
   * identical; the coverage of it is thinner, which is the trade, stated rather than hidden.
   */
  sweep?: SweepPoint[];
}

export async function rehearse(options: RehearseOptions = {}): Promise<RehearsalResult> {
  const narrate = options.narrate ?? true;
  const sweep = options.sweep ?? FULL_SWEEP;
  const say = (line: string): void => {
    if (narrate) console.log(line);
  };
  const rehearsals: Rehearsal[] = [];

  // ── 1 ── killed mid-send, with a slot reserved and nothing sent ──────────────────────
  {
    const cwd = await mkdtemp(join(tmpdir(), "kona-kill-send-"));
    say("1. kill -9 with a reservation open — the window §6.6 exists for");
    const killed = await killDuring("reserve-and-hang", cwd, { marker: "REHEARSAL reserved" });
    const fresh = await freshTerminal(cwd);
    const unknown = fresh.report.unknown_sends[0];
    say(`   fresh terminal answered in ${String(fresh.tookMs)}ms`);
    say(
      unknown === undefined
        ? "   NOTHING SURFACED — a send is in an unknown state and nobody was told"
        : `   NEEDS A HUMAN: ${unknown.node_id} ${unknown.effect_key}`,
    );
    const clearedLock = await clearStaleLock(cwd);
    rehearsals.push({
      name: "mid-send",
      cwd,
      killedAfterMs: killed.after,
      fresh,
      ...(unknown === undefined ? {} : { unknownSend: unknown }),
      clearedLock,
    });
  }

  // ── 2 ── killed at eight points through a live run ───────────────────────────────────
  //
  // Anchored to an iteration and then offset, so the signal lands somewhere inside the NEXT
  // beat's work rather than at a boundary. Where exactly is not under anyone's control, which
  // is the point: the claim worth making is not "we survive this one moment" but "we survive
  // whichever moment it was". Across the range this lands before the lock is taken, while it
  // is held, and after the append — all three of §6.6's shapes.
  say(`2. kill -9 at ${String(sweep.length)} points through a live run`);
  for (const point of sweep) {
    const cwd = await mkdtemp(join(tmpdir(), "kona-kill-mid-"));
    const at = `after ${String(point.iteration)}+${String(point.thenMs)}ms`;
    const killed = await killDuring("full-pursuit", cwd, {
      marker: `  ${String(point.iteration)}. v`,
      thenMs: point.thenMs,
    });
    const fresh = await freshTerminal(cwd);
    const clearedLock = await clearStaleLock(cwd);
    say(
      `   ${at} → v${String(fresh.report.version)} in ${String(fresh.tookMs)}ms` +
        (fresh.stuckLock.present ? `, ${fresh.stuckLock.reason} reported and cleared` : ""),
    );
    rehearsals.push({ name: `mid-pursuit ${at}`, cwd, killedAfterMs: killed.after, fresh, clearedLock });
  }

  // ── 3 ── killed before any bytes moved, then finished by a different process ─────────
  {
    const cwd = await mkdtemp(join(tmpdir(), "kona-kill-early-"));
    say("3. kill -9 before anything was sent, then finish it from the log alone");
    // After the FIRST iteration's line, and no later: iteration 1 reads the roster and plans
    // the fan-out, iteration 2 is where the sends happen. So this is "before any bytes moved"
    // by construction rather than by a lucky offset.
    const killed = await killDuring("full-pursuit", cwd, { marker: "  1. v" });
    const fresh = await freshTerminal(cwd);
    const clearedLock = await clearStaleLock(cwd);
    // A DIFFERENT process, in-process this time, holding nothing the dead one held.
    const finished = await runPursuit({
      provider: new MemoryMailboxProvider({ clock: steppingClock(RUN_START) }),
      cwd,
      narrate: false,
      resume: true,
    });
    say(
      `   restarted at v${String(fresh.report.version)} and finished at v${String(finished.head.version)}` +
        ` — ${String(finished.resume.frontier.length)} ready, ${String(finished.resume.unknown_sends.length)} in flight`,
    );
    rehearsals.push({
      name: "restarted-and-finished",
      cwd,
      killedAfterMs: killed.after,
      fresh,
      finishedAt: finished.head.version,
      clearedLock,
    });
  }

  const slowestStatusMs = Math.max(...rehearsals.map((rehearsal) => rehearsal.fresh.tookMs));
  if (narrate) {
    console.log("");
    console.log(`slowest status: ${String(slowestStatusMs)}ms — the budget is ${String(STATUS_BUDGET_MS)}ms`);
  }
  return { rehearsals, slowestStatusMs };
}

/* ── entry point ─────────────────────────────────────────────────────────────────────── */

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const runnerAt = argv.indexOf("--runner");
  if (runnerAt !== -1) {
    await runner(argv[runnerAt + 1] as RunnerMode, argv[runnerAt + 2] ?? "");
  } else {
    const result = await rehearse({});
    const late = result.slowestStatusMs > STATUS_BUDGET_MS;
    process.exit(late ? 1 : 0);
  }
}
