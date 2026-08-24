/**
 * A2 — the read contract, mechanized.
 *
 * D1 lets the viewer fold `.kona/mutations.jsonl` itself rather than shell out to
 * `kona graph --json`, because the timeline panel, read-only time travel and a
 * `{after, duration}` deadline all need `v` / `ops` / `rationale`, which the projection does
 * not carry. That shortcut is safe for exactly one reason: the viewer folds with core's own
 * `foldLog` / `projectGraph` — the same two functions the binary calls. This file is the proof.
 * It folds the committed log and demands the result be, byte for byte, the file the binary
 * wrote. Without it the viewer's read path could drift from the store's by a field, a default
 * or an ordering, and nobody would notice until the canvas quietly disagreed with the CLI.
 *
 * Everything here asserts against `fixtures/thursday.*` — real bytes from the real binary —
 * and against core's own frozen vocabularies, never against a restatement of either.
 */

import { describe, expect, test } from "bun:test";
import type { MutationRecord, Activity } from "@kona/core";
import {
  MATCH_KINDS,
  ACTIVITY_TYPES,
  REASON_CODES,
  STATUSES,
  foldLog,
  projectGraph,
} from "@kona/core";
import { V, folded, graphJson, headVersion, logText } from "./fixture.ts";

/**
 * `torn_tail` and `damaged` are the loader's report, not the graph — `kona graph --json`
 * appends them to the projection. Dropping them by rebuilding the object preserves key order,
 * which a spread or a `delete` would also do but less obviously; the point is that the
 * comparison below is about ordering as much as about values.
 */
function withoutLoaderReport(value: object): Record<string, unknown> {
  const trimmed: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "torn_tail" || key === "damaged") continue;
    trimmed[key] = entry;
  }
  return trimmed;
}

function nodesOf(projection: Record<string, unknown>): Record<string, unknown>[] {
  const activities = projection["activities"];
  if (!Array.isArray(activities)) throw new Error("projection carries no `activities` array");
  return activities as Record<string, unknown>[];
}

function firstNodeOf(projection: Record<string, unknown>): Record<string, unknown> {
  const first = nodesOf(projection)[0];
  if (first === undefined) throw new Error("projection carries no activities");
  return first;
}

/** What the viewer computes, round-tripped through JSON exactly as D1 describes it. */
function foldedProjection(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(projectGraph(foldLog(logText()).graph))) as Record<
    string,
    unknown
  >;
}

describe("A2 — folding the log reproduces `kona graph --json`", () => {
  test("the fixture on disk really does carry the two loader keys we trim", () => {
    // If the projection shape ever changed, the trim would become a no-op and the comparison
    // below would silently start asserting something weaker. So assert the premise.
    const disk = graphJson();
    expect(Object.keys(disk)).toContain("torn_tail");
    expect(Object.keys(disk)).toContain("damaged");
    expect(disk.torn_tail).toBe(false);
    expect(disk.damaged).toEqual([]);
  });

  test("the folded projection deep-equals the bytes the binary wrote", () => {
    const disk = withoutLoaderReport(graphJson());
    expect(foldedProjection()).toEqual(disk);
  });

  test("key order matches too — §6.1 says two folds stringify identically", () => {
    // Values equal but keys reordered would pass `toEqual` and still break the one claim the
    // determinism check rests on, so order is asserted at the top level and inside an activity.
    const mine = foldedProjection();
    const disk = withoutLoaderReport(graphJson());

    expect(Object.keys(mine)).toEqual(Object.keys(disk));
    expect(nodesOf(mine).length).toBeGreaterThan(0);
    expect(Object.keys(firstNodeOf(mine))).toEqual(Object.keys(firstNodeOf(disk)));
    expect(JSON.stringify(mine)).toBe(JSON.stringify(disk));
  });

  test("the loader found nothing damaged and no torn tail", () => {
    const result = folded();
    expect(result.torn_tail).toBeNull();
    expect(result.damaged).toEqual([]);
  });
});

describe("A2 — determinism and read-only time travel", () => {
  test("folding to head twice, and folding to head by ceiling, all stringify identically", () => {
    // Activity order is Map insertion order and edge order is append order (core/graph.ts), so
    // this is a property of the containers rather than of a sort applied afterwards. The
    // third form exercises the `upToVersion` path against the default one.
    const text = logText();
    const once = JSON.stringify(projectGraph(foldLog(text).graph));
    const twice = JSON.stringify(projectGraph(foldLog(text).graph));
    const byCeiling = JSON.stringify(
      projectGraph(foldLog(text, { upToVersion: headVersion() }).graph),
    );

    expect(twice).toBe(once);
    expect(byCeiling).toBe(once);
    expect(once).toBe(JSON.stringify(withoutLoaderReport(graphJson())));
  });

  test("every prefix folds to its own version and never loses an activity", () => {
    // Rule 6: time travel is read-only. A prefix is a shorter history, not an undone one, so
    // the activity count can only ever grow as v advances — a fold that dropped activities would be a
    // revert, which is the one thing the scrubber must never look like.
    const text = logText();
    const head = headVersion();
    let previous = -1;

    for (let v = 0; v <= head; v += 1) {
      const at = foldLog(text, { upToVersion: v });
      expect(at.graph.version).toBe(v);
      expect(at.records.length).toBe(v + 1);
      expect(at.records.at(-1)?.v).toBe(v);
      expect(at.graph.activities.size).toBeGreaterThanOrEqual(previous);
      previous = at.graph.activities.size;
    }

    expect(previous).toBe(graphJson().activities.length);
  });
});

describe("the fixture is the pursuit context.md describes", () => {
  const records: readonly MutationRecord[] = folded().records;
  const activities: Activity[] = [...folded().graph.activities.values()];

  test("fourteen records, v0..v13, contiguous", () => {
    // Contiguity is the property, not the count: `fold` requires versions to increment by
    // one, so a gap here would mean the fixture cannot be folded at all.
    expect(records.map((record) => record.v)).toEqual(
      Array.from({ length: V.patReserved + 1 }, (_, index) => index),
    );
  });

  test("every record carries a non-empty why and a reason code", () => {
    // §6.3's differentiator. The timeline panel has nothing to render without these, so the
    // fixture failing here would make A6 untestable rather than merely wrong.
    for (const record of records) {
      expect(record.rationale.why.trim().length).toBeGreaterThan(0);
      expect(REASON_CODES).toContain(record.rationale.reason_code);
    }
  });

  test("head carries 14 activities and 11 edges", () => {
    expect(activities.length).toBe(14);
    expect(folded().graph.edges.length).toBe(11);
  });

  test("all five statuses are present at head", () => {
    // Compared against core's frozen vocabulary rather than a list retyped here, so a status
    // added upstream fails this test instead of slipping past it.
    const present = [...new Set(activities.map((activity) => activity.status.state))].toSorted();
    expect(present).toEqual([...STATUSES].toSorted());
  });

  test("both activity types and all three match kinds are exercised", () => {
    const types = [...new Set(activities.map((activity) => activity.type))].toSorted();
    expect(types).toEqual([...ACTIVITY_TYPES].toSorted());

    const kinds = activities
      .map((activity) => activity.spec.match?.kind)
      .filter((kind) => kind !== undefined);
    expect([...new Set(kinds)].toSorted()).toEqual([...MATCH_KINDS].toSorted());
  });

  test("three groups: setup, goalies, marcus", () => {
    const groups = [...new Set(activities.map((activity) => activity.provenance.group ?? "(ungrouped)"))];
    expect(groups.toSorted()).toEqual(["goalies", "marcus", "setup"]);
  });
});
