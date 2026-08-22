/**
 * The one line that says what a version did.
 *
 * It is a CLAIM about the op list, made so a reader does not have to add four opcodes up
 * themselves — which means it can be wrong in a way the op list cannot, and that is what these
 * assertions are for. Run against the committed fixture, so every phrase here is one the panel
 * actually renders.
 */

import { describe, expect, test } from "bun:test";
import { buildPursuit } from "../src/model/pursuit.ts";
import { changeSummary } from "../src/model/summary.ts";
import type { TimelineEntry } from "../src/model/types.ts";
import { logText } from "./fixture.ts";

const TIMELINE = buildPursuit(logText()).timeline;

function at(version: number): TimelineEntry {
  const entry = TIMELINE.find((candidate) => candidate.version === version);
  if (entry === undefined) throw new Error(`the fixture has no v${String(version)}`);
  return entry;
}

describe("changeSummary", () => {
  test("v0 is the pursuit opening, not an empty diff", () => {
    // `foldLog` gives v0 no diff — there is no version before it to differ from — and "no
    // change to the graph" would be the wrong reading of that.
    expect(at(0).diff).toBeNull();
    expect(changeSummary(at(0))).toBe("opened the pursuit");
  });

  test("every version of the fixture says something", () => {
    // A row that reports nothing reads as a row the viewer failed to render.
    for (const entry of TIMELINE) {
      const summary = changeSummary(entry);
      expect(summary.length).toBeGreaterThan(0);
      expect(summary.trim()).toBe(summary);
    }
  });

  test("a status-only version carries rule 2's evidence", () => {
    // The layout is memoized on the topology signature, so a version that only moves statuses
    // must not re-run dagre — and this line is where a reader can check that claim.
    const stable = TIMELINE.filter((entry) => entry.diff?.topologyStable === true);
    expect(stable.length).toBeGreaterThan(0);
    for (const entry of stable) expect(changeSummary(entry)).toContain("no re-layout");
  });

  test("a topology version never claims 'no re-layout'", () => {
    const moved = TIMELINE.filter((entry) => entry.diff !== null && !entry.diff.topologyStable);
    expect(moved.length).toBeGreaterThan(0);
    for (const entry of moved) expect(changeSummary(entry)).not.toContain("no re-layout");
  });

  test("counts agree with the diff they summarise", () => {
    for (const entry of TIMELINE) {
      const diff = entry.diff;
      if (diff === null || diff.topologyStable) continue;
      const summary = changeSummary(entry);
      if (diff.addedNodes.length > 0) expect(summary).toContain(`${String(diff.addedNodes.length)} node`);
      if (diff.addedEdges.length > 0) expect(summary).toContain(`${String(diff.addedEdges.length)} edge`);
      if (diff.superseded.length > 0) expect(summary).toContain("retired");
    }
  });

  test("plurals are English, including the irregular one", () => {
    const one = { version: 1, diff: { addedNodes: ["a"], addedEdges: [], superseded: [], statusChanged: [], outcomeAdded: [], topologyStable: false, fromVersion: 0, toVersion: 1 } } as unknown as TimelineEntry;
    expect(changeSummary(one)).toBe("added 1 node");

    const many = { version: 2, diff: { addedNodes: ["a", "b"], addedEdges: [{}, {}], superseded: [], statusChanged: [], outcomeAdded: [], topologyStable: false, fromVersion: 1, toVersion: 2 } } as unknown as TimelineEntry;
    expect(changeSummary(many)).toBe("added 2 nodes and 2 edges");

    // `branch` + "s" is the plural a naive implementation writes, and it is wrong.
    const retired = { version: 3, diff: { addedNodes: [], addedEdges: [], superseded: [{ id: "a", by: null }, { id: "b", by: null }], statusChanged: [], outcomeAdded: [], topologyStable: false, fromVersion: 2, toVersion: 3 } } as unknown as TimelineEntry;
    expect(changeSummary(retired)).toBe("retired 2 branches");

    const oneBranch = { version: 4, diff: { addedNodes: [], addedEdges: [], superseded: [{ id: "a", by: null }], statusChanged: [], outcomeAdded: [], topologyStable: false, fromVersion: 3, toVersion: 4 } } as unknown as TimelineEntry;
    expect(changeSummary(oneBranch)).toBe("retired 1 branch");
  });

  test("topology that is neither an add nor a retire does not invent a verb", () => {
    const odd = { version: 5, diff: { addedNodes: [], addedEdges: [], superseded: [], statusChanged: [], outcomeAdded: [], topologyStable: false, fromVersion: 4, toVersion: 5 } } as unknown as TimelineEntry;
    expect(changeSummary(odd)).toBe("changed the shape of the graph");
  });
});
