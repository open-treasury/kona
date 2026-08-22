import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STALE_LOCK_MS, acquireLock, withLock } from "../src/lock.ts";
import type { Clock } from "../src/clock.ts";
import { fixedClock } from "../src/clock.ts";
import { harness, type Harness } from "./harness.ts";

let h: Harness;
let lockPath: string;

beforeEach(() => {
  h = harness();
  lockPath = join(h.dir, "lock");
});
afterEach(() => h.cleanup());

const T0 = "2026-08-21T12:00:00.000Z";

/**
 * Acquire, with the holder treated as ALIVE unless a test says otherwise.
 *
 * The pids below are synthetic — 99, 100, 200 — and not one of them is a running process, so
 * the real liveness probe would call every holder dead and turn every LOCK_HELD case into a
 * STALE_LOCK. Injecting keeps each test about the one thing its name says. The probe itself
 * has its own block at the end.
 */
function take(now: Clock, pid: number, alive = true) {
  return acquireLock(lockPath, now, pid, STALE_LOCK_MS, () => alive);
}

describe("O_EXCL, not flock (§1) — portable to all three platforms", () => {
  test("writes {pid, started_at} and creates the file", async () => {
    const outcome = await take(fixedClock(T0), 99);
    expect(outcome.ok).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual({ pid: 99, started_at: T0 });
  });

  test("a second acquire is refused while the first is held", async () => {
    const first = await take(fixedClock(T0), 99);
    expect(first.ok).toBe(true);
    const second = await take(fixedClock(T0), 100);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.reason).toBe("LOCK_HELD");
    expect(second.holder?.pid).toBe(99);
    expect(second.message).toContain("99");
  });

  test("release removes the file and lets the next writer in", async () => {
    const first = await take(fixedClock(T0), 99);
    if (!first.ok) throw new Error("unreachable");
    await first.lock.release();
    expect(existsSync(lockPath)).toBe(false);
    expect((await take(fixedClock(T0), 100)).ok).toBe(true);
  });

  test("releasing twice is not an error", async () => {
    const first = await take(fixedClock(T0), 99);
    if (!first.ok) throw new Error("unreachable");
    await first.lock.release();
    await first.lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("a stale lock is reported, never reclaimed", () => {
  /**
   * Reversal of an earlier design, and the reason is a real race rather than taste.
   * Unlinking or renaming a stale lock cannot be made atomic with the check that judged it
   * stale: B reads the holder, A completes its whole reclaim, then B moves A's FRESH lock
   * aside and takes the lock too — two writers, one log, interleaved lines. §6.7 gives
   * write authority to the orchestrator alone, so reclaiming was solving a problem this
   * design does not have, at the cost of one it would.
   */
  test("an old lock is refused with STALE_LOCK, distinctly from a busy one", async () => {
    await take(fixedClock(T0), 99);
    const later = new Date(Date.parse(T0) + STALE_LOCK_MS).toISOString();
    const outcome = await take(fixedClock(later), 100);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("STALE_LOCK");
    expect(outcome.holder?.pid).toBe(99);
  });

  test("and the message tells the operator exactly what to do", async () => {
    await take(fixedClock(T0), 99);
    const later = new Date(Date.parse(T0) + STALE_LOCK_MS).toISOString();
    const outcome = await take(fixedClock(later), 100);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.message).toContain("no longer running");
    expect(outcome.message).toContain("delete the file");
    expect(outcome.message).toContain(lockPath);
  });

  test("the lock file is left exactly where it was", async () => {
    await take(fixedClock(T0), 99);
    const later = new Date(Date.parse(T0) + STALE_LOCK_MS).toISOString();
    await take(fixedClock(later), 100);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(99);
  });

  test("a lock one millisecond short of stale is merely LOCK_HELD", async () => {
    await take(fixedClock(T0), 99);
    const early = new Date(Date.parse(T0) + STALE_LOCK_MS - 1).toISOString();
    const outcome = await take(fixedClock(early), 100);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("LOCK_HELD");
  });

  test.each([
    ["unreadable", "{not json"],
    ["missing started_at", JSON.stringify({ pid: 99 })],
    ["missing pid", JSON.stringify({ started_at: T0 })],
    ["wrongly typed", JSON.stringify({ pid: "99", started_at: 1 })],
  ])("a %s lockfile is itself evidence of a crash, so it reports STALE_LOCK", async (_n, body) => {
    writeFileSync(lockPath, body);
    const outcome = await take(fixedClock(T0), 100);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("STALE_LOCK");
  });

  test("once the operator clears it, the next writer proceeds", async () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 99, started_at: T0 }));
    rmSync(lockPath);
    expect((await take(fixedClock(T0), 100)).ok).toBe(true);
  });
});

describe("withLock", () => {
  test("releases even when the body throws — a crash must not wedge the pursuit", async () => {
    let thrown: unknown;
    try {
      await withLock(lockPath, fixedClock(T0), 99, () => Promise.reject(new Error("boom")));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe("boom");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("returns the body's value and releases on success", async () => {
    const held = await withLock(lockPath, fixedClock(T0), 99, () => Promise.resolve(7));
    expect(held).toEqual({ ok: true, value: 7 });
    expect(existsSync(lockPath)).toBe(false);
  });

  test("reports LOCK_HELD without running the body", async () => {
    await take(fixedClock(T0), 99);
    let ran = false;
    const held = await withLock(lockPath, fixedClock(T0), 100, () => {
      ran = true;
      return Promise.resolve(1);
    });
    expect(ran).toBe(false);
    expect(held.ok).toBe(false);
  });
});

describe("is the holder actually running? (the kill rehearsal's finding)", () => {
  /**
   * Age is a PROXY for "the holder is dead", and a poor one for the first thirty seconds —
   * which is exactly the window a crash is discovered in.
   *
   * Measured by `demo/script/kill-resume.ts`: `kill -9` a writer mid-write, and the next
   * command answered `LOCK_HELD — another writer holds it (pid 41usa)`. It was naming a
   * corpse, and a human either believed it and waited, or disbelieved it and deleted a lock
   * on a hunch. Neither is a tool doing its job.
   *
   * The probe answers it in the moment. It still does not RECLAIM — the race that made
   * reclaiming unsafe is untouched, and this only changes what a person is told.
   */
  test("a dead holder is STALE immediately, whatever the clock says", async () => {
    await take(fixedClock(T0), 99);
    // Same instant. Age says fresh; the pid says gone.
    const outcome = await take(fixedClock(T0), 100, false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("STALE_LOCK");
    expect(outcome.message).toContain("that process is gone");
    expect(outcome.message).toContain("Delete the file to continue");
  });

  test("a live holder inside the window is LOCK_HELD, and said to be running", async () => {
    await take(fixedClock(T0), 99);
    const outcome = await take(fixedClock(T0), 100, true);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("LOCK_HELD");
    expect(outcome.message).toContain("still running");
  });

  test("a live holder that has held it too long is stale by AGE, and not called gone", async () => {
    // Both signals are reported, and they disagree: the process exists but has been in a
    // write for thirty seconds, which no legal write takes. The operator is told to check
    // before deleting, because this one might really be working.
    await take(fixedClock(T0), 99);
    const later = new Date(Date.parse(T0) + STALE_LOCK_MS).toISOString();
    const outcome = await take(fixedClock(later), 100, true);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("STALE_LOCK");
    expect(outcome.message).toContain("Make sure no kona process is running");
    expect(outcome.message).not.toContain("that process is gone");
  });

  test("the REAL probe knows this process is alive", async () => {
    // No stub: the default is the real `process.kill(pid, 0)`. Our own pid is the one pid
    // that is certainly running, so a lock claiming it must read as held.
    await acquireLock(lockPath, fixedClock(T0), process.pid);
    const outcome = await acquireLock(lockPath, fixedClock(T0), process.pid + 1);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("LOCK_HELD");
  });

  test("the real probe treats an impossible pid as gone rather than throwing", async () => {
    // Signal 0 on pid 0 means "the whole process group", and on a negative pid means a
    // different group entirely — neither is a liveness question, so both are rejected before
    // the syscall. A lock file carrying one is a corrupt lock, and a corrupt lock is a crash.
    for (const pid of [0, -1, 1.5]) {
      writeFileSync(lockPath, JSON.stringify({ pid, started_at: T0 }));
      const outcome = await acquireLock(lockPath, fixedClock(T0), 100);
      if (outcome.ok) throw new Error("unreachable");
      expect(`${String(pid)}:${outcome.reason}`).toBe(`${String(pid)}:STALE_LOCK`);
    }
  });

  test("a lock left behind still blocks the write — reported, never reclaimed", async () => {
    await take(fixedClock(T0), 99);
    expect((await take(fixedClock(T0), 100, false)).ok).toBe(false);
    // And the file is untouched, so the human's decision is still theirs to make.
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(99);
  });
});

describe("two writers can never both hold it", () => {
  test("exactly one of many concurrent acquirers wins, every time", async () => {
    for (let round = 0; round < 25; round++) {
      const outcomes = await Promise.all([
        take(fixedClock(T0), 100),
        take(fixedClock(T0), 200),
        take(fixedClock(T0), 300),
      ]);
      expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
      for (const outcome of outcomes) {
        if (!outcome.ok) expect(outcome.reason).toBe("LOCK_HELD");
      }
      const winner = outcomes.find((o) => o.ok);
      if (winner?.ok === true) await winner.lock.release();
    }
  });

  test("and a stale lock does not create a second winner, because nobody takes it", async () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 1, started_at: T0 }));
    const stale = new Date(Date.parse(T0) + STALE_LOCK_MS).toISOString();
    const outcomes = await Promise.all([
      take(fixedClock(stale), 100),
      take(fixedClock(stale), 200),
    ]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(0);
  });

  test("no stray files are left behind", async () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 1, started_at: T0 }));
    const stale = new Date(Date.parse(T0) + STALE_LOCK_MS).toISOString();
    await take(fixedClock(stale), 100);
    expect(readdirSync(h.dir)).toEqual(["lock"]);
  });
});

describe("only EEXIST means 'someone else has it'", () => {
  test("any other failure propagates rather than being read as contention", async () => {
    // A missing directory is a bug in the caller, not a busy lock. Swallowing it would
    // make every write report a stale lock against a path that cannot exist, and tell the
    // operator to delete a file that was never there.
    let thrown: unknown;
    try {
      await acquireLock(join(h.dir, "no-such-dir", "lock"), fixedClock(T0), 1);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string } | undefined)?.code).toBe("ENOENT");
  });
});

describe("the refusal names the holder, or says it cannot", () => {
  test("a readable holder is named", async () => {
    await take(fixedClock(T0), 99);
    const outcome = await take(fixedClock(T0), 100);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.message).toContain("pid 99");
    expect(outcome.message).toContain(`since ${T0}`);
  });

  test("an unreadable one says 'unknown' rather than printing undefined", async () => {
    writeFileSync(lockPath, "{not json");
    const outcome = await take(fixedClock(T0), 100);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.message).toContain("pid unknown");
    expect(outcome.message).toContain("since unknown");
    expect(outcome.message).not.toContain("undefined");
  });

  test("a half-written one is unknown too — a partial record is not a holder", async () => {
    // Both fields are required to believe a lockfile. Trusting a pid without a timestamp
    // would print `since undefined` at the operator and, worse, treat a live writer's
    // half-flushed lock as identifiable.
    writeFileSync(lockPath, JSON.stringify({ pid: 99 }));
    const outcome = await take(fixedClock(T0), 100);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.message).toContain("pid unknown");
    expect(outcome.message).not.toContain("undefined");
  });

  test("the lock never exists without its contents", async () => {
    // Written to a staging name and linked into place, so a peer can never read an empty
    // lock and conclude that a live writer has crashed.
    const outcome = await take(fixedClock(T0), 99);
    if (!outcome.ok) throw new Error("unreachable");
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual({ pid: 99, started_at: T0 });
    expect(readdirSync(h.dir)).toEqual(["lock"]);
  });
});
