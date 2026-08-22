/**
 * §1, §6.7 — an `O_EXCL` lockfile, not `flock`.
 *
 * `open(path, 'wx')` fails atomically if the file exists, on macOS, Linux and Windows
 * alike. `flock` is POSIX-only and Windows has no equivalent; it is the same amount of
 * code, so the portable one is the one to write first.
 *
 * The lock is held only for the duration of a write (§6.1), so a lock that outlives a write
 * is a crash rather than a slow peer. Which one it is decides only what a HUMAN is told —
 * nothing here ever reclaims. See the note on `acquireLock`.
 */

import { link, readFile, rm, writeFile } from "node:fs/promises";
import type { Clock } from "./clock.ts";

/** A legal write is a read, a validate and an append. Thirty seconds is generous. */
export const STALE_LOCK_MS = 30_000;

/**
 * Is the process that wrote this lock still running?
 *
 * Signal 0 is the POSIX liveness probe: it validates the pid and permissions and delivers
 * nothing. **EPERM means the process EXISTS** and belongs to somebody else, so it counts as
 * alive; only ESRCH means gone. Getting that backwards would tell an operator to delete a
 * lock somebody is actively holding.
 *
 * Two honest limits, and both fail in the safe direction:
 *
 * - **PID reuse.** A recycled pid makes a dead holder look alive, which errs toward "someone
 *   may be writing" — the conservative answer. The dangerous direction, a live holder looking
 *   dead, cannot come from reuse.
 * - **Another machine.** A pid means nothing on a different host. §1 refuses to run on a
 *   network filesystem precisely so that this question never arises: the lock is local, so
 *   the pid is ours to ask about.
 */
function holderIsRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string } | null)?.code === "EPERM";
  }
}

export interface LockInfo {
  pid: number;
  started_at: string;
}

export interface HeldLock {
  info: LockInfo;
  release: () => Promise<void>;
}

export type LockOutcome =
  | { ok: true; lock: HeldLock }
  | {
      ok: false;
      /** `LOCK_HELD` — someone is writing. `STALE_LOCK` — someone died writing. */
      reason: "LOCK_HELD" | "STALE_LOCK";
      message: string;
      holder: LockInfo | null;
    };

function isEexist(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "EEXIST";
}

async function readLockInfo(path: string): Promise<LockInfo | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const info = parsed as Partial<LockInfo>;
    if (typeof info.pid !== "number" || typeof info.started_at !== "string") return null;
    return { pid: info.pid, started_at: info.started_at };
  } catch {
    // An unreadable or half-written lockfile is itself evidence of a crash mid-write.
    return null;
  }
}

/**
 * Distinguishes two temp files created in the same millisecond by the same process.
 *
 * Only distinctness matters, so incrementing and decrementing are equally correct — which is
 * why mutation testing reports `sequence -= 1` as a survivor and will keep doing so. Left as
 * a note rather than chased: an equivalent mutant is not a missing test, and writing one to
 * pin the direction of a counter nobody reads would be testing the test.
 *
 * The other known-equivalent survivors in this file are the defensive `?.` on a caught
 * `error` (a `catch` binding is `unknown`, and `throw null` is legal, but no fs error is
 * null) and `readFile(path, "utf8")` -> `readFile(path, "")`, which Bun coerces identically.
 */
let sequence = 0;

/**
 * Write the contents first, then LINK it into place.
 *
 * `open(path, "wx")` is atomic about creation but not about content: for a moment the
 * lock exists and is empty, and a second writer that reads it in that window sees an
 * unreadable lockfile — which is the signature of a crash. It would then tell the operator
 * to delete a lock somebody is actively holding.
 *
 * `link` is atomic and fails with EEXIST if the target exists, so it keeps the mutual
 * exclusion while guaranteeing the file never appears without its contents.
 */
async function writeLock(path: string, info: LockInfo): Promise<() => Promise<void>> {
  sequence += 1;
  const staging = `${path}.${info.pid}.${sequence}`;
  await writeFile(staging, JSON.stringify(info));
  try {
    await link(staging, path);
  } finally {
    // Whether or not the link took, the staging name is no longer needed: on success it
    // is a second name for the same inode, and removing it leaves the lock in place.
    // `writeFile` above succeeded, so it exists — there is nothing to force.
    await rm(staging);
  }
  return async () => {
    await rm(path, { force: true });
  };
}

export async function acquireLock(
  path: string,
  now: Clock,
  pid: number,
  staleAfterMs: number = STALE_LOCK_MS,
  isRunning: (holderPid: number) => boolean = holderIsRunning,
): Promise<LockOutcome> {
  const info: LockInfo = { pid, started_at: now() };

  try {
    return { ok: true, lock: { info, release: await writeLock(path, info) } };
  } catch (error) {
    if (!isEexist(error)) throw error;
  }

  // A STALE LOCK IS NOT RECLAIMED AUTOMATICALLY, and that is a deliberate reversal.
  //
  // An earlier version unlinked or renamed a stale lock and took it. Both are unsafe, and
  // the failure is silent: B reads the holder and judges it stale, A completes its entire
  // reclaim, then B moves A's FRESH lock aside and takes the lock too. Two writers append
  // to one log and the lines interleave. There is no POSIX compare-and-delete that closes
  // it — the check and the removal cannot be made one operation.
  //
  // Reclaiming is also solving a problem the design does not have: §6.7 gives write
  // authority to the orchestrator alone, so a second writer is already the exception. What
  // a stale lock actually means is that something crashed mid-write, and git has the right
  // answer for exactly this file: say so, and let a human clear it.
  //
  // What follows is three messages, because a human does three different things about them,
  // and each names the evidence it rests on so nobody has to guess how sure the tool is.
  const holder = await readLockInfo(path);

  // A lockfile that will not parse is ITSELF the signature of a crash mid-write, and it is
  // its own case rather than a fall-through. Folding it into the branches below meant every
  // holder field needed a `?? "unknown"` that could never fire — dead expressions that read
  // as caution and were only noise. Mutation testing is what surfaced them: four survivors
  // in one line, all of them unreachable.
  if (holder === null) {
    return {
      ok: false,
      reason: "STALE_LOCK",
      message:
        `${path} exists but cannot be read as a lock, which is what a crash mid-write ` +
        `leaves. Make sure no kona process is running, then delete the file to continue.`,
      holder: null,
    };
  }

  // Age is a PROXY for "the holder is dead", and a poor one for the first thirty seconds —
  // exactly the window a crash is discovered in. Measured: `kill -9` mid-write and the next
  // command said "another writer holds it (pid 41usa)", naming a corpse, and a human had to
  // wait out the timer to be told the truth. Asking whether the pid is running answers it in
  // the moment. A `started_at` that will not parse leaves `age` NaN, which is stale too.
  const age = Date.parse(now()) - Date.parse(holder.started_at);
  const dead = !isRunning(holder.pid);
  const since = `(pid ${String(holder.pid)}, since ${holder.started_at}`;

  if (dead) {
    return {
      ok: false,
      reason: "STALE_LOCK",
      message:
        `${path} was left behind by a writer that is no longer running ${since}; ` +
        `that process is gone). Delete the file to continue.`,
      holder,
    };
  }

  if (Number.isNaN(age) || age >= staleAfterMs) {
    // Still running, and has held the lock longer than any legal write takes. Both signals
    // are reported because they disagree, and the operator is told to check before deleting:
    // this one might really be working.
    return {
      ok: false,
      reason: "STALE_LOCK",
      message:
        `${path} was left behind by a writer that is no longer running ${since}). ` +
        `Make sure no kona process is running, then delete the file to continue.`,
      holder,
    };
  }

  return {
    ok: false,
    reason: "LOCK_HELD",
    message: `another writer holds ${path} ${since}, still running)`,
    holder,
  };
}

/** Run `body` under the lock, releasing it even if `body` throws. */
export async function withLock<T>(
  path: string,
  now: Clock,
  pid: number,
  body: (lock: HeldLock) => Promise<T>,
  staleAfterMs: number = STALE_LOCK_MS,
): Promise<
  { ok: true; value: T } | { ok: false; reason: "LOCK_HELD" | "STALE_LOCK"; message: string }
> {
  const outcome = await acquireLock(path, now, pid, staleAfterMs);
  if (!outcome.ok) return { ok: false, reason: outcome.reason, message: outcome.message };
  try {
    return { ok: true, value: await body(outcome.lock) };
  } finally {
    await outcome.lock.release();
  }
}
