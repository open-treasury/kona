/**
 * A6, and rule 5's panel: eight versions, newest first, each carrying the `why` and the
 * `reason_code` the schema made impossible to omit.
 *
 * The assertions are on the wording as much as on the counts, because the wording is the
 * product here — a row that says `add_edge · wait-for-dana` and nothing else is a row that
 * sends the reader back to the log. In particular the edge direction is asserted verbatim:
 * §6.2 says `{from: A, to: B}` means **B requires A**, getting it backwards is the mistake
 * this codebase has made most often, and it is invisible in a picture because every arrow
 * still draws.
 *
 * The incremental fold gets a test of its own: the diffs the panel shows must equal the diffs
 * you would get by folding the log from scratch at each version. Folding once per version is
 * what this module deliberately does not do, so something has to hold the shortcut to the same
 * answer.
 *
 * The last block covers the half of rule 5's rationale this pursuit happens not to exercise.
 * Every record in the fixture carries `expected_effect: null`, `alternatives_rejected: []` and
 * no trigger, so those three fields could be dropped from the entry entirely and the rest of
 * this file would still pass. They are held by rewriting one real record and folding the
 * result — the line still goes through `MutationRecordSchema`, so a shape the store would
 * reject cannot pass here either.
 */

import { describe, expect, test } from "bun:test";
import type { FoldResult } from "@kona/core";
import { REASON_CODES, foldLog } from "@kona/core";
import { buildTimeline } from "../src/model/timeline.ts";
import { diffGraphs } from "../src/model/diff.ts";
import type { TimelineEntry } from "../src/model/types.ts";
import { V, folded, logText } from "./fixture.ts";

const TIMELINE = buildTimeline(folded().records);

function rowOf(timeline: readonly TimelineEntry[], version: number): TimelineEntry {
  const found = timeline.find((candidate) => candidate.version === version);
  if (found === undefined) throw new Error(`fixture has no v${String(version)}`);
  return found;
}

function entry(version: number): TimelineEntry {
  return rowOf(TIMELINE, version);
}

/**
 * The fixture log with one record rewritten, re-folded.
 *
 * A hand-built graph is banned in this suite; a hand-edited *record* is not the same thing,
 * because it is still parsed by the schema and applied by `applyOps` before anything here sees
 * it. This is the only way to pose a rationale the nine-version fixture does not contain.
 */
function withRecord(version: number, patch: (record: Record<string, unknown>) => void): FoldResult {
  const lines = logText().split("\n").filter((line) => line.trim().length > 0);
  const index = lines.findIndex((line) => (JSON.parse(line) as { v: number }).v === version);
  if (index < 0) throw new Error(`fixture has no v${String(version)}`);

  const record = JSON.parse(lines[index] ?? "") as Record<string, unknown>;
  patch(record);
  lines[index] = JSON.stringify(record);

  return foldLog(lines.join("\n"));
}

/** The rows of one version's ops, as `[kind, node, detail]`, in the order they were committed. */
function opRows(version: number): string[][] {
  return entry(version).ops.map((op) => [op.kind, op.node, op.detail]);
}

describe("A6 — every version, newest first, every one explained", () => {
  test("head is at index 0 and genesis is last", () => {
    expect(TIMELINE).toHaveLength(V.patReserved + 1);
    expect(TIMELINE[0]?.version).toBe(V.patReserved);
    expect(TIMELINE.map((row) => row.version)).toEqual(
      Array.from({ length: V.patReserved + 1 }, (_, index) => V.patReserved - index),
    );
  });

  test("every entry carries a non-empty why and a real reason code", () => {
    for (const row of TIMELINE) {
      expect(row.why.length).toBeGreaterThan(0);
      expect(REASON_CODES as readonly string[]).toContain(row.reasonCode);
    }
    expect(entry(V.danaDeclines).reasonCode).toBe("COUNTERPARTY_DECLINED");
    expect(entry(V.danaDeclines).why).toBe(
      "Dana is away that week. Her arm cannot satisfy the quorum.",
    );
    expect(entry(V.patPlanned).reasonCode).toBe("CONTRADICTION");
    // §6.8 defaults the outbox's own commits to OTHER, and deliberately: the closed
    // vocabulary describes why a PLAN changed, and none of it describes "I sent the message
    // I was told to send". A wrong code is worse than an honest default.
    expect(entry(V.danaReserved).reasonCode).toBe("OTHER");
  });

  test("actors render as kind, or kind plus id when the id says something new", () => {
    expect(entry(V.genesis).actor).toBe("human ilya");
    // The plan changes are the orchestrator's. Every send is the EXECUTOR's, and the
    // timeline says so — which is the only place a reader can see that the thing which
    // touched the world is not the thing which decided to.
    for (const version of [V.roster, V.plan, V.danaDeclines, V.samRefers, V.patPlanned]) {
      expect(`v${version}:${entry(version).actor}`).toBe(`v${version}:orchestrator`);
    }
    for (const version of [V.danaReserved, V.danaSent, V.priyaFailed, V.patReserved]) {
      expect(`v${version}:${entry(version).actor}`).toBe(`v${version}:subagent executor`);
    }
  });

  test("timestamps and rationale extras come straight off the record", () => {
    const records = folded().records;
    for (const row of TIMELINE) {
      const record = records[row.version];
      expect(row.observedAt).toBe(record?.observed_at ?? "");
      expect(row.occurredAt).toBe(record?.occurred_at ?? "");
      expect(row.ops).toHaveLength(record?.ops.length ?? -1);
    }
    // Nothing in this pursuit was committed in reply to an inbound event, and none of the
    // rationales carried the two optional halves. Absent, not empty-string, not "unknown".
    expect(TIMELINE.map((row) => row.trigger)).toEqual(
      Array<null>(V.patReserved + 1).fill(null),
    );
    expect(entry(V.samRefers).expectedEffect).toBeNull();
    expect(entry(V.samRefers).alternativesRejected).toEqual([]);
  });
});

describe("op details — the wording is the product", () => {
  test("the roster version: an edge reads as what the TARGET requires", () => {
    // `{from: confirm-roster-availability, to: ask-dana-to-play-in-goal}` means the ask
    // requires the roster check. The row hangs off the ask, and names the roster check.
    // It reads the roster and addresses nobody: invariant 3(b) rejects "a recipient
    // existing only in the proposing batch", so the record naming these people has to be
    // committed before any node may email one of them.
    expect(opRows(V.roster)).toEqual([
      ["add_node", "confirm-roster-availability", "added task"],
      ["add_node", "escalate-no-goalie-found", "added task"],
      ["record_output", "confirm-roster-availability", "output availability"],
      ["set_status", "confirm-roster-availability", "-> done"],
    ]);
  });

  test("a conditional edge names the resolution it fires on", () => {
    const converging = opRows(V.plan).filter(([kind]) => kind === "add_edge");
    expect(converging).toEqual([
      ["add_edge", "ask-dana-to-play-in-goal", "requires confirm-roster-availability"],
      ["add_edge", "wait-for-dana", "requires ask-dana-to-play-in-goal"],
      ["add_edge", "wait-for-sam", "requires ask-sam-to-play-in-goal"],
      ["add_edge", "wait-for-priya", "requires ask-priya-to-play-in-goal"],
      ["add_edge", "goalie-confirmed", "requires wait-for-dana on satisfied"],
      ["add_edge", "goalie-confirmed", "requires wait-for-sam on satisfied"],
      ["add_edge", "goalie-confirmed", "requires wait-for-priya on satisfied"],
    ]);
  });

  test("an output names what was produced, never the value", () => {
    // The roster is a list of real people; the timeline says one was produced and leaves
    // the reading of it to somebody who opened the node.
    expect(opRows(V.roster).filter(([kind]) => kind === "record_output")).toEqual([
      ["record_output", "confirm-roster-availability", "output availability"],
    ]);
  });

  test("a send reads as two transitions, and the first is not terminal", () => {
    // The whole of §6.6, as two timeline rows. Nobody watching a pursuit has to be told what
    // the outbox is; they can see the node sit in `sending` and then move.
    expect(opRows(V.danaReserved)).toEqual([
      ["set_status", "ask-dana-to-play-in-goal", "-> sending"],
    ]);
    expect(opRows(V.danaSent)).toEqual([["set_status", "ask-dana-to-play-in-goal", "-> done"]]);
    // And the one that never got its second row until four versions later.
    expect(opRows(V.priyaReserved)).toEqual([
      ["set_status", "ask-priya-to-play-in-goal", "-> sending"],
    ]);
    expect(opRows(V.priyaFailed)).toEqual([
      ["set_status", "ask-priya-to-play-in-goal", "-> failed"],
    ]);
  });

  test("an outcome leads with the verdict and keeps the attrs a quorum counts on", () => {
    expect(opRows(V.danaDeclines)).toEqual([
      ["record_outcome", "wait-for-dana", "declined · role=goalie · reason=away that week"],
      ["set_status", "wait-for-dana", "-> done"],
    ]);
  });

  test("the supersede names its replacement", () => {
    expect(opRows(V.rosterSuperseded)).toEqual([
      ["add_node", "confirm-roster-availability-and-eligibility", "added task"],
      [
        "supersede_node",
        "confirm-roster-availability",
        "superseded by confirm-roster-availability-and-eligibility",
      ],
    ]);
  });

  test("a supersede with no replacement says so, rather than naming nothing", () => {
    // Priya's address bounced 550. Her wait is retired outright — `by` is absent, so
    // `superseded_by` stays null and the store drops the node instead.
    expect(opRows(V.patPlanned)).toEqual([
      [
        "record_outcome",
        "wait-for-priya",
        "bounced · role=goalie · smtp=550 5.1.1 user unknown",
      ],
      ["supersede_node", "wait-for-priya", "superseded"],
      ["add_node", "ask-pat-to-play-in-goal", "added task"],
      ["add_node", "wait-for-pat", "added wait"],
      ["add_edge", "wait-for-pat", "requires ask-pat-to-play-in-goal"],
      ["add_edge", "goalie-confirmed", "requires wait-for-pat on satisfied"],
    ]);

    // Pat's reservation is a version of its own, after the plan that created his node. It
    // has to be: `kona effect reserve` is the only thing that issues a slot, and it appends.
    expect(opRows(V.patReserved)).toEqual([
      ["set_status", "ask-pat-to-play-in-goal", "-> sending"],
    ]);
  });

  test("genesis has no ops at all", () => {
    expect(entry(V.genesis).ops).toEqual([]);
  });
});

describe("each entry carries what its version did to the shape", () => {
  test("genesis has nothing to compare against, and the ticks are the sends", () => {
    expect(entry(V.genesis).diff).toBeNull();
    const stable = TIMELINE.filter((row) => row.diff?.topologyStable === true).map(
      (row) => row.version,
    );
    expect(stable.toSorted((a, b) => a - b)).toEqual([
      V.danaReserved,
      V.danaSent,
      V.samReserved,
      V.samSent,
      V.priyaReserved,
      V.danaDeclines,
      V.priyaFailed,
      V.patReserved,
    ]);
  });

  test("the supersede's diff names the supersede and its target", () => {
    const diff = entry(V.rosterSuperseded).diff;
    expect(diff?.fromVersion).toBe(V.rosterSuperseded - 1);
    expect(diff?.toVersion).toBe(V.rosterSuperseded);
    expect(diff?.addedNodes).toEqual(["confirm-roster-availability-and-eligibility"]);
    expect(diff?.addedEdges).toEqual([]);
    expect(diff?.superseded).toEqual([
      {
        id: "confirm-roster-availability",
        by: "confirm-roster-availability-and-eligibility",
      },
    ]);
  });

  test("Dana's refusal moves a status and an outcome and nothing else", () => {
    const diff = entry(V.danaDeclines).diff;
    expect(diff?.addedNodes).toEqual([]);
    expect(diff?.addedEdges).toEqual([]);
    expect(diff?.statusChanged).toEqual([{ id: "wait-for-dana", from: "active", to: "done" }]);
    expect(diff?.outcomeAdded).toEqual(["wait-for-dana"]);
  });

  test("the incremental fold agrees with folding the log once per version", () => {
    // The shortcut this module takes, held to the answer it replaces. A quadratic re-fold is
    // what makes a viewer stall on a long log; being fast is only worth anything if it is also
    // right, and this is where that is checked.
    for (let version = 1; version <= V.patReserved; version += 1) {
      expect(entry(version).diff).toEqual(
        diffGraphs(folded(version - 1).graph, folded(version).graph),
      );
    }
  });
});

describe("the rest of the rationale, which this pursuit never filled in", () => {
  test("expected_effect and alternatives_rejected reach the row when a record carries them", () => {
    // §6.3 makes `why` and `reason_code` impossible to omit and leaves these two optional, so
    // most real records look like the fixture's. The ones that do carry them are the
    // interesting ones — a mutation that says what it expected to happen is a mutation whose
    // `outcome` can later be scored against it, which is the difference §6.3 draws between a
    // changelog and training data. Dropping them on the floor here would lose that silently.
    const effect = "Marcus's ruling closes the quorum without a fourth ask.";
    const rejected = ["ask a fourth goalie", "play a skater in goal"];
    const fold = withRecord(5, (record) => {
      const rationale = record["rationale"] as Record<string, unknown>;
      rationale["expected_effect"] = effect;
      rationale["alternatives_rejected"] = rejected;
    });
    expect(fold.damaged).toEqual([]);

    const timeline = buildTimeline(fold.records);
    const row = rowOf(timeline, 5);
    expect(row.expectedEffect).toBe(effect);
    expect(row.alternativesRejected).toEqual(rejected);

    // The half that was already there is untouched, and so is every other version: an entry
    // that carried the same rationale for all eight rows would pass the two lines above.
    expect(row.why).toBe(entry(5).why);
    expect(row.reasonCode).toBe(entry(5).reasonCode);
    for (const other of timeline.filter((candidate) => candidate.version !== 5)) {
      expect(other.expectedEffect).toBeNull();
      expect(other.alternativesRejected).toEqual([]);
    }
  });

  test("a trigger renders as relation, kind and provenance — and never the body", () => {
    // Rule 9 puts message bodies behind an explicit reveal. The timeline is the one panel
    // that is always on screen, so a counterparty's words landing in this string would put
    // them on the projector with nobody having asked. That is why the assertion is not just
    // on what the line contains.
    const fold = withRecord(7, (record) => {
      record["trigger"] = {
        relation: "Invalidate",
        kind: "bounce",
        from: "mailer-daemon@example.com",
        in_reply_to: "msg:priya-ask",
        body: "550 5.1.1 user unknown — the mailbox does not exist",
      };
    });
    expect(fold.damaged).toEqual([]);

    const row = rowOf(buildTimeline(fold.records), 7);
    expect(row.trigger).toBe(
      "Invalidate · bounce · from mailer-daemon@example.com · in reply to msg:priya-ask",
    );
    expect(row.trigger).not.toContain("550");
    expect(row.trigger).not.toContain("mailbox");
  });

  test("a trigger with nothing optional on it renders its two required halves alone", () => {
    // `from` and `in_reply_to` are optional (§6.3) and a deadline firing has neither. The
    // separator has to disappear with them rather than leaving a dangling ` · `.
    const fold = withRecord(4, (record) => {
      record["trigger"] = { relation: "Timeout", kind: "deadline" };
    });
    expect(fold.damaged).toEqual([]);
    expect(rowOf(buildTimeline(fold.records), 4).trigger).toBe("Timeout · deadline");
  });
});
