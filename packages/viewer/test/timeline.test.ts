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
import { folded, logText } from "./fixture.ts";

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
 * it. This is the only way to pose a rationale the eight-version fixture does not contain.
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

describe("A6 — eight versions, newest first, every one explained", () => {
  test("v7 is at index 0 and v0 is last", () => {
    expect(TIMELINE).toHaveLength(8);
    expect(TIMELINE[0]?.version).toBe(7);
    expect(TIMELINE.map((row) => row.version)).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
  });

  test("every entry carries a non-empty why and a real reason code", () => {
    for (const row of TIMELINE) {
      expect(row.why.length).toBeGreaterThan(0);
      expect(REASON_CODES as readonly string[]).toContain(row.reasonCode);
    }
    expect(entry(4).reasonCode).toBe("COUNTERPARTY_DECLINED");
    expect(entry(4).why).toBe("Dana is away that week. Her arm cannot satisfy the quorum.");
    expect(entry(7).reasonCode).toBe("CONTRADICTION");
  });

  test("actors render as kind, or kind plus id when the id says something new", () => {
    expect(entry(0).actor).toBe("human ilya");
    for (const version of [1, 2, 3, 4, 5, 6, 7]) {
      expect(entry(version).actor).toBe("orchestrator");
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
    expect(TIMELINE.map((row) => row.trigger)).toEqual(Array<null>(8).fill(null));
    expect(entry(5).expectedEffect).toBeNull();
    expect(entry(5).alternativesRejected).toEqual([]);
  });
});

describe("op details — the wording is the product", () => {
  test("v1: an edge reads as what the TARGET requires", () => {
    // `{from: confirm-roster-availability, to: ask-dana-to-play-in-goal}` means the ask
    // requires the roster check. The row hangs off the ask, and names the roster check.
    expect(opRows(1)).toEqual([
      ["add_node", "confirm-roster-availability", "added task"],
      ["add_node", "escalate-no-goalie-found", "added task"],
      ["add_node", "ask-dana-to-play-in-goal", "added task"],
      ["add_node", "wait-for-dana", "added wait"],
      ["add_edge", "ask-dana-to-play-in-goal", "requires confirm-roster-availability"],
      ["add_edge", "wait-for-dana", "requires ask-dana-to-play-in-goal"],
    ]);
  });

  test("a conditional edge names the resolution it fires on", () => {
    const converging = opRows(2).filter(([kind]) => kind === "add_edge");
    expect(converging).toEqual([
      ["add_edge", "wait-for-sam", "requires ask-sam-to-play-in-goal"],
      ["add_edge", "wait-for-priya", "requires ask-priya-to-play-in-goal"],
      ["add_edge", "goalie-confirmed", "requires wait-for-dana on satisfied"],
      ["add_edge", "goalie-confirmed", "requires wait-for-sam on satisfied"],
      ["add_edge", "goalie-confirmed", "requires wait-for-priya on satisfied"],
    ]);
  });

  test("v2: an output names what was produced, never the value", () => {
    expect(opRows(2).slice(0, 2)).toEqual([
      ["record_output", "confirm-roster-availability", "output availability"],
      ["set_status", "confirm-roster-availability", "-> done"],
    ]);
  });

  test("v3: statuses read as transitions, including the one that is not terminal", () => {
    expect(opRows(3)).toEqual([
      ["set_status", "ask-dana-to-play-in-goal", "-> done"],
      ["record_output", "ask-dana-to-play-in-goal", "output sent_message_id"],
      ["set_status", "ask-sam-to-play-in-goal", "-> done"],
      ["record_output", "ask-sam-to-play-in-goal", "output sent_message_id"],
      ["set_status", "ask-priya-to-play-in-goal", "-> sending"],
    ]);
  });

  test("v4: an outcome leads with the verdict and keeps the attrs a quorum counts on", () => {
    expect(opRows(4)).toEqual([
      ["record_outcome", "wait-for-dana", "declined · role=goalie · reason=away that week"],
      ["set_status", "wait-for-dana", "-> done"],
    ]);
  });

  test("v6: the supersede names its replacement", () => {
    expect(opRows(6)).toEqual([
      ["add_node", "confirm-roster-availability-and-eligibility", "added task"],
      [
        "supersede_node",
        "confirm-roster-availability",
        "superseded by confirm-roster-availability-and-eligibility",
      ],
    ]);
  });

  test("v7: a supersede with no replacement says so, rather than naming nothing", () => {
    // Priya's address bounced 550. Her wait is retired outright — `by` is absent, so
    // `superseded_by` stays null and the store drops the node instead.
    expect(opRows(7)).toEqual([
      ["set_status", "ask-priya-to-play-in-goal", "-> failed"],
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
      ["set_status", "ask-pat-to-play-in-goal", "-> sending"],
    ]);
  });

  test("genesis has no ops at all", () => {
    expect(entry(0).ops).toEqual([]);
  });
});

describe("each entry carries what its version did to the shape", () => {
  test("only v3 and v4 are status ticks; v0 has nothing to compare against", () => {
    expect(entry(0).diff).toBeNull();
    const table = Object.fromEntries(
      [1, 2, 3, 4, 5, 6, 7].map((v) => [v, entry(v).diff?.topologyStable]),
    );
    expect(table).toEqual({
      1: false,
      2: false,
      3: true, // dispatches: statuses and outputs only
      4: true, // Dana declines: one outcome, one status
      5: false,
      6: false, // a supersede adds no edge and still moves the picture
      7: false,
    });
  });

  test("v6's diff names the supersede and its target", () => {
    const diff = entry(6).diff;
    expect(diff?.fromVersion).toBe(5);
    expect(diff?.toVersion).toBe(6);
    expect(diff?.addedNodes).toEqual(["confirm-roster-availability-and-eligibility"]);
    expect(diff?.addedEdges).toEqual([]);
    expect(diff?.superseded).toEqual([
      {
        id: "confirm-roster-availability",
        by: "confirm-roster-availability-and-eligibility",
      },
    ]);
  });

  test("v4's diff moves a status and an outcome and nothing else", () => {
    const diff = entry(4).diff;
    expect(diff?.addedNodes).toEqual([]);
    expect(diff?.addedEdges).toEqual([]);
    expect(diff?.statusChanged).toEqual([{ id: "wait-for-dana", from: "active", to: "done" }]);
    expect(diff?.outcomeAdded).toEqual(["wait-for-dana"]);
  });

  test("the incremental fold agrees with folding the log once per version", () => {
    // The shortcut this module takes, held to the answer it replaces. A quadratic re-fold is
    // what makes a viewer stall on a long log; being fast is only worth anything if it is also
    // right, and this is where that is checked.
    for (const version of [1, 2, 3, 4, 5, 6, 7]) {
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
