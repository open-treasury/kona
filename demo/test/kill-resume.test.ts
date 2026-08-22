/**
 * T8.3 — kill and resume, as an automated test.
 *
 * `packages/kona/test/kill-resume.test.ts` covers the same ground faster and in-process, by
 * writing the state a crash leaves. This file is the one that sends the actual signal, and
 * the two are not redundant: the in-process tests are only as good as the assumption that
 * their simulation is faithful, and that assumption is exactly what a real `SIGKILL` to a
 * real process group checks.
 *
 * It is slow — every assertion below rests on eleven pursuits spawned and destroyed — so the
 * sweep is three points here against the script's eight. The property is the same; the
 * coverage of it is thinner. Run `bun demo/script/kill-resume.ts` for the full sweep.
 */

import { describe, expect, test } from "bun:test";

import { KonaError, reasonOf } from "../kona.ts";
import * as kona from "../kona.ts";
import { STATUS_BUDGET_MS, rehearse } from "../script/kill-resume.ts";
import type { RehearsalResult } from "../script/kill-resume.ts";

const REHEARSAL: RehearsalResult = await rehearse({
  narrate: false,
  sweep: [
    { iteration: 1, thenMs: 0 },
    { iteration: 2, thenMs: 120 },
    { iteration: 3, thenMs: 0 },
  ],
});

const midSend = REHEARSAL.rehearsals[0];
const restarted = REHEARSAL.rehearsals.at(-1);

describe("a fresh terminal states the status, whatever it was killed doing", () => {
  test("every kill was answered, and the slowest was far inside the budget", () => {
    // §8: "states pursuit status in <60s with no session state". The measured number is
    // around a tenth of a second, and what makes it that is the absence of a snapshot to
    // rebuild — `resume` folds a JSONL file and answers.
    expect(REHEARSAL.slowestStatusMs).toBeLessThan(STATUS_BUDGET_MS);
    for (const rehearsal of REHEARSAL.rehearsals) {
      expect(`${rehearsal.name}:${String(rehearsal.fresh.tookMs < STATUS_BUDGET_MS)}`).toBe(
        `${rehearsal.name}:true`,
      );
    }
  });

  test("no fold was damaged — a torn tail is a shape, not a corruption", () => {
    // Append-then-fsync can only ever truncate the last line, so the worst a `kill -9` mid
    // write can do is leave a partial record. `resume` exits non-zero on damage; every one
    // of these exited 0.
    for (const rehearsal of REHEARSAL.rehearsals) {
      expect(`${rehearsal.name}:${String(rehearsal.fresh.exitCode)}`).toBe(`${rehearsal.name}:0`);
      expect(`${rehearsal.name}:${String(rehearsal.fresh.report.counts["damaged"] ?? 0)}`).toBe(
        `${rehearsal.name}:0`,
      );
    }
  });

  test("the report is a real one — it names where the pursuit actually got to", () => {
    // Guard the premise. A report of v0 for every kill would satisfy the two tests above and
    // mean nothing: the runs have to have been interrupted at genuinely different places.
    const versions = REHEARSAL.rehearsals.map((rehearsal) => rehearsal.fresh.report.version);
    expect(Math.min(...versions)).toBeGreaterThan(0);
    expect(new Set(versions).size).toBeGreaterThan(1);
  });

  test("a lock left by a dead writer is REPORTED, and never silently taken", () => {
    // Where the signal landed inside a write, the corpse still holds the lock. Whether that
    // happens on any given run is luck; what must not vary is the handling. The failure this
    // rules out is the quiet one: two writers appending to one log because the second judged
    // the first dead and took the lock, which no POSIX operation makes atomic.
    for (const rehearsal of REHEARSAL.rehearsals) {
      if (!rehearsal.fresh.stuckLock.present) {
        expect(`${rehearsal.name}:${String(rehearsal.fresh.canWrite)}`).toBe(`${rehearsal.name}:true`);
        continue;
      }
      expect(rehearsal.fresh.stuckLock.reason).toBe("STALE_LOCK");
      // Named as gone rather than as busy, which is the whole point of the liveness probe:
      // an operator staring at a crashed machine is told the holder is dead, not that
      // somebody might still be writing.
      expect(rehearsal.fresh.stuckLock.message).toContain("that process is gone");
      expect(rehearsal.fresh.stuckLock.message.toLowerCase()).toContain("delete the file");
      // And a read worked anyway — `resume --dry-run` never takes the write lock, which is
      // what makes "state the status" possible while a corpse is holding it.
      expect(rehearsal.fresh.exitCode).toBe(0);
    }
  });
});

describe("killed with a slot reserved and nothing sent (§6.6 window 2)", () => {
  test("the unknown send is surfaced for a human, with the key and the recipient", () => {
    const unknown = midSend?.fresh.report.unknown_sends ?? [];
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.node_id).toBe("ask-dana-to-play-in-goal");
    expect(unknown[0]?.effect_key).toMatch(/^ek_[0-9a-f]{16}$/);
    expect(midSend?.unknownSend?.effect_key).toBe(unknown[0]?.effect_key ?? "");
  });

  test("resume repairs NOTHING about it — the log cannot tell sent from unsent", () => {
    // Windows 2 and 3 leave identical bytes: an `in_flight` node with `completed_at: null`.
    // Nothing on disk distinguishes "fsynced but never sent" from "sent but never recorded",
    // so guessing sends a second email at exactly the moment nobody is watching.
    //
    // "Nothing" means nothing ABOUT THE SEND, not nothing at all — the pursuit's deadlines
    // are in the past by the time this runs, and firing an overdue timeout is `resume` doing
    // its job. The line is which repairs are derivable from the clock (all of them) and which
    // would require knowing something the file does not record (this one).
    const repairs = (midSend?.fresh.report.repairs ?? []) as { node?: string }[];
    expect(repairs.filter((repair) => repair.node === "ask-dana-to-play-in-goal")).toEqual([]);
    // And the repairs that ARE proposed are all deadline work, so the guard above is not
    // passing merely because the list happened to be empty.
    expect(repairs.length).toBeGreaterThan(0);
    expect(new Set(repairs.map((repair) => repair.node))).toEqual(new Set(["goalie-confirmed"]));
  });

  test("the node is not offered as work, so nothing picks it back up", () => {
    expect(midSend?.fresh.report.frontier ?? []).not.toContain("ask-dana-to-play-in-goal");
  });

  test("RE-SENDS NOTHING: re-reserving is idempotent and appends no second slot", async () => {
    const cwd = midSend?.fresh.report === undefined ? "" : cwdOf(midSend);
    const before = await effectLogOf(cwd, "ask-dana-to-play-in-goal");
    expect(before).toHaveLength(1);
    expect(before[0]?.completed_at).toBeNull();

    // What a restarted executor would do: reserve, and be told the slot is already open for
    // these exact bytes. Same key, no new version, no second email.
    const again = await kona.run(cwd, [
      "effect",
      "reserve",
      "ask-dana-to-play-in-goal",
      "--payload-hash",
      before[0]?.payload_hash ?? "",
      "--why",
      "a restarted executor re-reserving the same bytes",
      "--json",
    ]);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ idempotent: true, reserved: false });

    const after = await effectLogOf(cwd, "ask-dana-to-play-in-goal");
    expect(after).toEqual(before);
  });

  test("offering DIFFERENT bytes for the open slot is refused, loudly", async () => {
    // The check a body-derived key would have made unreachable. A crashed send resumed with
    // a regenerated message is not the message that was approved.
    const cwd = cwdOf(midSend);
    const refused = await kona.run(cwd, [
      "effect",
      "reserve",
      "ask-dana-to-play-in-goal",
      "--payload-hash",
      "sha256:deadbeef",
      "--why",
      "a restarted executor that regenerated the message",
    ]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("EFFECT_PAYLOAD_MISMATCH");
  });
});

describe("killed before anything was sent, and finished by a different process", () => {
  test("the restarted loop reached the same end as an uninterrupted run", () => {
    // The strongest form of §6.7's D1, and the one the ticket does not ask for: not "a fresh
    // terminal can report", but "a fresh process can pick the work up and finish it". Nothing
    // carried over — a different `runPursuit`, a different mailbox, no memory of the plan.
    expect(restarted?.finishedAt).toBe(16);
  });

  test("it was genuinely interrupted first — the restart had work left to do", () => {
    // Otherwise the test above passes on a run that was never killed.
    expect(restarted?.fresh.report.version ?? 0).toBeLessThan(16);
    expect(restarted?.fresh.report.frontier.length ?? 0).toBeGreaterThan(0);
  });

  test("and nothing was in flight when it was killed, so no send could be duplicated", () => {
    expect(restarted?.fresh.report.unknown_sends).toEqual([]);
  });
});

describe("a subprocess killed by a signal says so (kona-atq)", () => {
  /**
   * The bug: a rare `KonaError` with an EMPTY stderr under full-suite load, which read as a
   * mystery for as long as nothing could tell 143 from a refusal.
   *
   * It was a timeout cascade. `demo/test/divergence.test.ts` ran the whole divergence twelve
   * times; on a loaded machine one would exceed bun's 5s default, and the runner then
   * SIGTERMs the `kona` subprocesses still in flight — which lands on whatever test is
   * running next. §6.8 requires every non-zero exit to write a symbolic reason, so an empty
   * stderr means the process never reached its own error path at all. The fix is one shared
   * run; this is the part that makes the NEXT occurrence name itself.
   */
  test("143 and 137 are read as signals, not as refusals", () => {
    expect(reasonOf("", 143)).toBe("KILLED_BY_SIGNAL_15");
    expect(reasonOf("", 137)).toBe("KILLED_BY_SIGNAL_9");
    expect(new KonaError(["graph"], 143, "").message).toContain("SIGTERM");
    expect(new KonaError(["graph"], 137, "").message).toContain("SIGKILL");
    expect(new KonaError(["graph"], 143, "").message).toContain("never reached its own error path");
  });

  test("a real refusal is still read as its reason, whatever the code", () => {
    // The guard against over-reading: an exit code above 128 with real stderr is not a
    // signal, and §6.8's codes (1, 3, 4) are never confused for one.
    expect(reasonOf("REFUSED STALE_LOCK the file is there", 1)).toBe("STALE_LOCK");
    expect(reasonOf("UNKNOWN_NODE node='x' does not exist", 1)).toBe("UNKNOWN_NODE");
    expect(reasonOf("STALE_BASE_VERSION head=4", 3)).toBe("STALE_BASE_VERSION");
    expect(new KonaError(["mutate"], 4, "INVARIANT_VIOLATION invariant=2").message).toContain(
      "INVARIANT_VIOLATION",
    );
  });

  test("an empty stderr with an ordinary code is UNKNOWN, not a fabricated signal", () => {
    expect(reasonOf("", 1)).toBe("UNKNOWN");
    expect(new KonaError(["graph"], 1, "").message).toContain("(no stderr)");
  });
});

/* ── helpers ─────────────────────────────────────────────────────────────────────────── */

interface EffectEntry {
  effect_key: string;
  payload_hash: string;
  completed_at: string | null;
}

/** The pursuit directory a rehearsal used. Recovered from the report it produced. */
function cwdOf(rehearsal: RehearsalResult["rehearsals"][number] | undefined): string {
  const cwd = rehearsal?.cwd;
  if (cwd === undefined) throw new Error("the rehearsal did not record its directory");
  return cwd;
}

async function effectLogOf(cwd: string, nodeId: string): Promise<EffectEntry[]> {
  const graph = (await kona.graph(cwd)) as {
    nodes: { id: string; status: { effect_log?: EffectEntry[] } }[];
  };
  return graph.nodes.find((node) => node.id === nodeId)?.status.effect_log ?? [];
}
