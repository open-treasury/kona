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

import { open, readFile, rename, rm } from "node:fs/promises";
import type { Clock } from "./clock.ts";

/** A legal write is a read, a validate and an append. Thirty seconds is generous. */
export const STALE_LOCK_MS = 30_000;

export interface LockInfo {
  pid: number;
  started_at: string;
}

export interface HeldLock {
  info: LockInfo;
  /** Reclaimed a lock left behind by a process that died mid-write. */
  reclaimed: boolean;
  release: () => Promise<void>;
}

export type LockOutcome =
  | { ok: true; lock: HeldLock }
  | { ok: false; reason: "LOCK_HELD"; message: string; holder: LockInfo | null };

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

async function writeLock(path: string, info: LockInfo): Promise<() => Promise<void>> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(JSON.stringify(info));
  } finally {
    await handle.close();
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
    return { ok: true, lock: { info, reclaimed: false, release: await writeLock(path, info) } };
  } catch (error) {
    if (!isEexist(error)) throw error;
  }

  const holder = await readLockInfo(path);

  // One comparison decides it, and `NaN` does the right thing for free: an unreadable
  // lockfile, or one whose timestamp is garbage, fails this test and falls through to
  // reclaim — which is correct, because both are the signature of a writer that died
  // mid-write rather than one still working. There is no "unknown holder" message to
  // write, because a holder that cannot be read is never treated as holding.
  if (holder !== null && Date.parse(now()) - Date.parse(holder.started_at) < staleAfterMs) {
    return {
      ok: false,
      reason: "LOCK_HELD",
      message: `another writer holds ${path} (pid ${holder.pid}, since ${holder.started_at})`,
      holder,
    };
  }

  // Reclaim by RENAME, not by unlink-then-create.
  //
  // `rm` followed by `open(wx)` is not atomic across two reclaimers: A unlinks and
  // creates, then B unlinks — deleting A's fresh lock — and creates its own. Both would
  // believe they held it, and both would append. `rename` moves the stale file aside in
  // one step, so exactly one racer can succeed and the loser gets ENOENT.
  const stashed = `${path}.stale-${pid}-${Date.parse(info.started_at)}`;
  try {
    await rename(path, stashed);
  } catch {
    return {
      ok: false,
      reason: "LOCK_HELD",
      message: `another writer reclaimed ${path} first`,
      holder: await readLockInfo(path),
    };
  }
  // `rename` succeeded, so `stashed` exists; no `force` needed.
  await rm(stashed);

  try {
    return { ok: true, lock: { info, reclaimed: true, release: await writeLock(path, info) } };
  } catch (error) {
    if (!isEexist(error)) throw error;
    return {
      ok: false,
      reason: "LOCK_HELD",
      message: `another writer took ${path} during reclaim`,
      holder: await readLockInfo(path),
    };
  }
}

/** Run `body` under the lock, releasing it even if `body` throws. */
export async function withLock<T>(
  path: string,
  now: Clock,
  pid: number,
  body: (lock: HeldLock) => Promise<T>,
  staleAfterMs: number = STALE_LOCK_MS,
): Promise<{ ok: true; value: T } | { ok: false; reason: "LOCK_HELD"; message: string }> {
  const outcome = await acquireLock(path, now, pid, staleAfterMs);
  if (!outcome.ok) return { ok: false, reason: outcome.reason, message: outcome.message };
  try {
    return { ok: true, value: await body(outcome.lock) };
  } finally {
    await outcome.lock.release();
  }
}
