import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STALE_LOCK_MS, acquireLock, withLock } from "../src/lock.ts";
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

describe("O_EXCL, not flock (§1) — portable to all three platforms", () => {
  test("writes {pid, started_at} and creates the file", async () => {
    const outcome = await acquireLock(lockPath, fixedClock(T0), 99);
    expect(outcome.ok).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual({ pid: 99, started_at: T0 });
  });

  test("a second acquire is refused while the first is held", async () => {
    const first = await acquireLock(lockPath, fixedClock(T0), 99);
    expect(first.ok).toBe(true);
    const second = await acquireLock(lockPath, fixedClock(T0), 100);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.reason).toBe("LOCK_HELD");
    expect(second.holder?.pid).toBe(99);
    expect(second.message).toContain("99");
  });

  test("release removes the file and lets the next writer in", async () => {
    const first = await acquireLock(lockPath, fixedClock(T0), 99);
    if (!first.ok) throw new Error("unreachable");
    await first.lock.release();
    expect(existsSync(lockPath)).toBe(false);
    expect((await acquireLock(lockPath, fixedClock(T0), 100)).ok).toBe(true);
  });

  test("releasing twice is not an error", async () => {
    const first = await acquireLock(lockPath, fixedClock(T0), 99);
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
    await acquireLock(lockPath, fixedClock(T0), 99);
    const later = new Date(Date.parse(T0) + STALE_LOCK_MS).toISOString();
    const outcome = await acquireLock(lockPath, fixedClock(later), 100);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("STALE_LOCK");
    expect(outcome.holder?.pid).toBe(99);
  });

  test("and the message tells the operator exactly what to do", async () => {
    await acquireLock(lockPath, fixedClock(T0), 99);
    const later = new Date(Date.parse(T0) + STALE_LOCK_MS).toISOString();
    const outcome = await acquireLock(lockPath, fixedClock(later), 100);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.message).toContain("no longer running");
    expect(outcome.message).toContain("delete the file");
    expect(outcome.message).toContain(lockPath);
  });

  test("the lock file is left exactly where it was", async () => {
    await acquireLock(lockPath, fixedClock(T0), 99);
    const later = new Date(Date.parse(T0) + STALE_LOCK_MS).toISOString();
    await acquireLock(lockPath, fixedClock(later), 100);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(99);
  });

  test("a lock one millisecond short of stale is merely LOCK_HELD", async () => {
    await acquireLock(lockPath, fixedClock(T0), 99);
    const early = new Date(Date.parse(T0) + STALE_LOCK_MS - 1).toISOString();
    const outcome = await acquireLock(lockPath, fixedClock(early), 100);
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
    const outcome = await acquireLock(lockPath, fixedClock(T0), 100);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("STALE_LOCK");
  });

  test("once the operator clears it, the next writer proceeds", async () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 99, started_at: T0 }));
    rmSync(lockPath);
    expect((await acquireLock(lockPath, fixedClock(T0), 100)).ok).toBe(true);
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
    await acquireLock(lockPath, fixedClock(T0), 99);
    let ran = false;
    const held = await withLock(lockPath, fixedClock(T0), 100, () => {
      ran = true;
      return Promise.resolve(1);
    });
    expect(ran).toBe(false);
    expect(held.ok).toBe(false);
  });
});

describe("two writers can never both hold it", () => {
  test("exactly one of many concurrent acquirers wins, every time", async () => {
    for (let round = 0; round < 25; round++) {
      const outcomes = await Promise.all([
        acquireLock(lockPath, fixedClock(T0), 100),
        acquireLock(lockPath, fixedClock(T0), 200),
        acquireLock(lockPath, fixedClock(T0), 300),
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
      acquireLock(lockPath, fixedClock(stale), 100),
      acquireLock(lockPath, fixedClock(stale), 200),
    ]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(0);
  });

  test("no stray files are left behind", async () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 1, started_at: T0 }));
    const stale = new Date(Date.parse(T0) + STALE_LOCK_MS).toISOString();
    await acquireLock(lockPath, fixedClock(stale), 100);
    expect(readdirSync(h.dir)).toEqual(["lock"]);
  });
});
