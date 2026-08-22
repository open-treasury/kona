/**
 * §1, §6.7 — an `O_EXCL` lockfile, not `flock`.
 *
 * `open(path, 'wx')` fails atomically if the file exists, on macOS, Linux and Windows
 * alike. `flock` is POSIX-only and Windows has no equivalent; it is the same amount of
 * code, so the portable one is the one to write first.
 *
 * The lock is held only for the duration of a write (§6.1), which is why a stale lock is
 * a crash rather than a slow peer, and why reclaiming one after a bounded age is safe.
 */

import { link, readFile, rm, writeFile } from "node:fs/promises";
import type { Clock } from "./clock.ts";

/** A legal write is a read, a validate and an append. Thirty seconds is generous. */
export const STALE_LOCK_MS = 30_000;

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

/** Distinguishes two temp files created in the same millisecond by the same process. */
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
    await rm(staging, { force: true });
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
): Promise<LockOutcome> {
  const info: LockInfo = { pid, started_at: now() };

  try {
    return { ok: true, lock: { info, release: await writeLock(path, info) } };
  } catch (error) {
    if (!isEexist(error)) throw error;
  }

  const holder = await readLockInfo(path);
  const age = holder === null ? Number.NaN : Date.parse(now()) - Date.parse(holder.started_at);
  const stale = Number.isNaN(age) || age >= staleAfterMs;

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
  return {
    ok: false,
    reason: stale ? "STALE_LOCK" : "LOCK_HELD",
    message: stale
      ? `${path} was left behind by a writer that is no longer running ` +
        `(pid ${holder?.pid ?? "unknown"}, since ${holder?.started_at ?? "unknown"}). ` +
        `Make sure no kona process is running, then delete the file to continue.`
      : `another writer holds ${path} (pid ${holder?.pid ?? "unknown"}, since ${holder?.started_at ?? "unknown"})`,
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
