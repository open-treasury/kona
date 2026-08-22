import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

describe("a stale lock is a crash, not a slow peer", () => {
  test("is reclaimed once it is older than the longest legal write", async () => {
    await acquireLock(lockPath, fixedClock(T0), 99);
    const later = new Date(Date.parse(T0) + STALE_LOCK_MS).toISOString();
    const outcome = await acquireLock(lockPath, fixedClock(later), 100);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.lock.reclaimed).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(100);
  });

  test("is NOT reclaimed one millisecond early", async () => {
    await acquireLock(lockPath, fixedClock(T0), 99);
    const early = new Date(Date.parse(T0) + STALE_LOCK_MS - 1).toISOString();
    expect((await acquireLock(lockPath, fixedClock(early), 100)).ok).toBe(false);
  });

  test("an unreadable lockfile is itself evidence of a crash mid-write", async () => {
    writeFileSync(lockPath, "{not json");
    const outcome = await acquireLock(lockPath, fixedClock(T0), 100);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.lock.reclaimed).toBe(true);
  });

  test("a lockfile missing its fields is treated the same way", async () => {
    writeFileSync(lockPath, JSON.stringify({ pid: "not a number" }));
    expect((await acquireLock(lockPath, fixedClock(T0), 100)).ok).toBe(true);
  });

  test("a fresh acquire is not marked reclaimed", async () => {
    const outcome = await acquireLock(lockPath, fixedClock(T0), 99);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.lock.reclaimed).toBe(false);
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

describe("reclaiming a stale lock is atomic", () => {
  /**
   * `rm` then `open(wx)` is NOT atomic across two reclaimers: A unlinks and creates, then
   * B unlinks — deleting A's fresh lock — and creates its own. Both believe they hold it
   * and both append. Reclaiming by `rename` closes that window, and this asserts the
   * property rather than the branch: whatever the interleaving, exactly one winner.
   */
  test("exactly one of two concurrent reclaimers wins, every time", async () => {
    const stale = new Date(Date.parse(T0) + STALE_LOCK_MS).toISOString();
    for (let round = 0; round < 25; round++) {
      writeFileSync(lockPath, JSON.stringify({ pid: 1, started_at: T0 }));
      const outcomes = await Promise.all([
        acquireLock(lockPath, fixedClock(stale), 100),
        acquireLock(lockPath, fixedClock(stale), 200),
      ]);
      expect(outcomes.filter((o) => o.ok)).toHaveLength(1);

      // The loser must lose *properly*: whichever of the two reclaim races it lost, it
      // reports contention with a message naming the path, never a silent empty refusal.
      const loser = outcomes.find((o) => !o.ok);
      if (loser?.ok === false) {
        expect(loser.reason).toBe("LOCK_HELD");
        expect(loser.message).toContain(lockPath);
        expect(loser.message.length).toBeGreaterThan(lockPath.length);
      }

      const winner = outcomes.find((o) => o.ok);
      if (winner?.ok === true) await winner.lock.release();
    }
  });

  test("leaves no stashed lockfile behind", async () => {
    const { readdirSync } = await import("node:fs");
    writeFileSync(lockPath, JSON.stringify({ pid: 1, started_at: T0 }));
    const stale = new Date(Date.parse(T0) + STALE_LOCK_MS).toISOString();
    const outcome = await acquireLock(lockPath, fixedClock(stale), 100);
    if (!outcome.ok) throw new Error("unreachable");
    await outcome.lock.release();
    expect(readdirSync(h.dir)).toEqual([]);
  });
});

describe("a lockfile must carry both fields to be believed", () => {
  test.each([
    ["no started_at", { pid: 99 }],
    ["no pid", { started_at: T0 }],
    ["pid of the wrong type", { pid: "99", started_at: T0 }],
    ["started_at of the wrong type", { pid: 99, started_at: 1 }],
    ["not an object", "nope"],
  ])("%s is treated as a crashed writer, not as a live one", async (_name, content) => {
    writeFileSync(lockPath, JSON.stringify(content));
    const outcome = await acquireLock(lockPath, fixedClock(T0), 100);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.lock.reclaimed).toBe(true);
  });

  test("a complete lockfile is believed and blocks", async () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 99, started_at: T0 }));
    expect((await acquireLock(lockPath, fixedClock(T0), 100)).ok).toBe(false);
  });
});

describe("only EEXIST means 'someone else has it'", () => {
  test("any other failure propagates rather than being read as contention", async () => {
    // A missing directory is a bug in the caller, not a busy lock. Swallowing it would
    // make `kona mutate` report LOCK_HELD forever against a path that cannot exist.
    let thrown: unknown;
    try {
      await acquireLock(join(h.dir, "no-such-dir", "lock"), fixedClock(T0), 1);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string } | undefined)?.code).toBe("ENOENT");
  });
});
