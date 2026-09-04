/**
 * A4: a status-only mutation must not re-run dagre.
 *
 * The fixture is the whole point of these tests. v3 and v4 are real mutations the binary wrote
 * — statuses, outcomes, two outputs — and they bump `graph.version` without touching an activity,
 * an edge or a supersession. Anything keyed on the version would re-lay-out there, which is
 * the one moment §6.10 rule 2 forbids.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Graph, ActivityNode } from "@kona/core";
import { foldLog } from "@kona/core";
import type { Layout, NodeBox } from "../src/layout/dagre.ts";
import {
  ACTIVITY_SIZE,
  createLayoutCache,
  layoutGraph,
  sizeOf,
  topologySignature,
} from "../src/layout/dagre.ts";
import { END_MARKER_ID, START_MARKER_ID, flowTerminals } from "../src/model/edges.ts";
import { barHandles } from "../src/layout/handles.ts";
import { V, folded, headVersion } from "./fixture.ts";

function nodeOf(graph: Graph, id: string): ActivityNode {
  const activity = graph.nodes.get(id);
  if (activity === undefined) throw new Error(`the fixture has no activity ${id}`);
  return activity;
}

function boxOf(layout: Layout, id: string): NodeBox {
  const box = layout.boxes.get(id);
  if (box === undefined) throw new Error(`the layout has no box for ${id}`);
  return box;
}

function states(version: number): string[] {
  return [...folded(version).graph.nodes.values()].map((n) => `${n.id}=${n.status?.state}`);
}

/**
 * The first activity the fixture has both an edge into and an edge out of, so deleting it strands
 * one of each. Derived rather than named, because a regenerated fixture is free to rename its
 * activities and a hardcoded id would strand the test instead.
 */
function nodeWithEdgesBothWays(graph: Graph): string {
  const targets = new Set(graph.edges.map((edge) => edge.to));
  const id = graph.edges.find((edge) => targets.has(edge.from))?.from;
  if (id === undefined)
    throw new Error("the fixture has no activity with an in-edge and an out-edge");
  return id;
}

/**
 * The versions whose ops changed the shape of the graph — the table in `context.md`.
 *
 * Everything NOT here is a status tick, and most of the fixture is: five of the eight ticks
 * are the outbox, since §6.6 makes a send two commits and neither of them touches the
 * picture. That ratio is the case for rule 1. A viewer that re-ran dagre on every version
 * would re-lay-out the whole graph twice per email.
 */
const SHAPE_CHANGING_VERSIONS = new Set([
  V.roster,
  V.plan,
  V.samRefers,
  V.rosterSuperseded,
  V.patPlanned,
]);

describe("topologySignature", () => {
  test("the plan and the two sends after it are one shape, and statuses really do move", () => {
    const run = [V.plan, V.danaReserved, V.danaSent];
    const signatures = run.map((v) => topologySignature(folded(v).graph));

    // Guard the premise: if a regenerated fixture made either send a no-op, the run of equal
    // signatures below would pass for the wrong reason.
    expect(folded(V.danaSent).graph.version).toBe(V.danaSent);
    expect(states(V.danaReserved)).not.toEqual(states(V.plan));
    expect(states(V.danaSent)).not.toEqual(states(V.danaReserved));

    expect(signatures[1]).toBe(signatures[0]);
    expect(signatures[2]).toBe(signatures[1]);
  });

  test("every version that changed the shape changed the signature, and only those", () => {
    const signatures = Array.from({ length: headVersion() + 1 }, (_, v) =>
      topologySignature(folded(v).graph),
    );
    for (let v = 1; v <= headVersion(); v++) {
      if (SHAPE_CHANGING_VERSIONS.has(v)) {
        expect(signatures[v]).not.toBe(signatures[v - 1]);
      } else {
        expect(signatures[v]).toBe(signatures[v - 1]);
      }
    }
  });

  test("status, outcome, output and observed_at_version are all invisible to it", () => {
    const graph = folded().graph;
    const before = topologySignature(graph);

    const activity = nodeOf(graph, "th-gk0l");
    if (activity.status === undefined)
      throw new Error("th-gk0l should be work, not a control node");
    activity.status.state = "withdrawn";
    activity.status.output = { transcript_ref: "msg-999" };
    activity.status.observed_at_version = 99;
    activity.status?.effect_log.push({
      effect_key: "resend",
      payload_hash: "deadbeef",
      attempted_at: "2026-08-22T02:00:00.000Z",
      completed_at: null,
      outcome: null,
      message_id: null,
    });
    (nodeOf(graph, "th-ymld").status?.outcomes ?? []).push({
      verdict: "confirmed",
      evidence_ref: "msg-998",
      at_version: 99,
    });

    expect(topologySignature(graph)).toBe(before);
  });

  test("a supersede changes it even when no activity or edge is added", () => {
    const graph = folded().graph;
    const before = topologySignature(graph);
    // `th-vipt` is already in the fixture, so this is a supersession and
    // nothing else — no new activity, no new edge.
    nodeOf(graph, "th-gk0l").provenance.superseded_by = "th-vipt";
    expect(topologySignature(graph)).not.toBe(before);
  });

  test("an edge condition is part of the shape", () => {
    const graph = folded().graph;
    const before = topologySignature(graph);
    // `th-9xi1 -> th-ymld` fires on `accept`; the three goalie
    // waits fire on `satisfied`. Flipping one is a different graph, same activity set.
    const edge = graph.edges.find(
      (e) => typeof e.guard === "object" && "on" in e.guard && e.guard.on === "accept",
    );
    if (edge?.guard === undefined || edge.guard === "else" || !("on" in edge.guard)) {
      throw new Error("the fixture lost its `accept` edge");
    }
    edge.guard.on = "satisfied";
    expect(topologySignature(graph)).not.toBe(before);
  });

  test("insertion order is part of the shape (rule 7 pins visual order to it)", () => {
    const graph = folded().graph;
    const reversed: Graph = { ...graph, nodes: new Map([...graph.nodes].toReversed()) };
    expect(topologySignature(reversed)).not.toBe(topologySignature(graph));
  });
});

describe("layoutGraph", () => {
  test("places all 14 head activities, at the size their type asks for", () => {
    const graph = folded().graph;
    const layout = layoutGraph(graph);

    expect(graph.nodes.size).toBe(14);
    expect(layout.boxes.size).toBe(graph.nodes.size);
    for (const activity of graph.nodes.values()) {
      const box = boxOf(layout, activity.id);
      expect(box.width).toBe(ACTIVITY_SIZE[activity.type].width);
      expect(box.height).toBe(ACTIVITY_SIZE[activity.type].height);
      expect(Number.isFinite(box.x)).toBe(true);
      expect(Number.isFinite(box.y)).toBe(true);
    }
    expect([...layout.boxes.keys()]).toEqual([...graph.nodes.keys()]);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
    expect(layout.signature).toBe(topologySignature(graph));
  });

  test("rankdir LR puts the target of every edge clear to the right of its source", () => {
    const graph = folded().graph;
    const layout = layoutGraph(graph);

    expect(graph.edges.length).toBe(11);
    for (const edge of graph.edges) {
      const from = boxOf(layout, edge.from);
      const to = boxOf(layout, edge.to);
      expect(to.x).toBeGreaterThan(from.x + from.width);
    }
  });

  test("boxes are top-left corners, not dagre's centres", () => {
    const layout = layoutGraph(folded().graph);
    // Markers included: they are laid out in the same pass, so dagre's reported extent covers
    // them and the identity below is about the whole picture rather than the cards alone.
    const boxes = [...layout.boxes.values(), ...layout.markers.values()];
    const left = Math.min(...boxes.map((b) => b.x));
    const right = Math.max(...boxes.map((b) => b.x + b.width));
    const top = Math.min(...boxes.map((b) => b.y));
    const bottom = Math.max(...boxes.map((b) => b.y + b.height));

    // dagre translates its result so the bounding box of the activities sits inside an equal margin
    // on both sides: `left === marginx` and `right === width - marginx`, hence `left + right
    // === width`. That identity holds only for corners. Left as centres, both extremes would
    // be half a box out and the sums would exceed the reported size by an activity's width.
    expect(left + right).toBe(layout.width);
    expect(top + bottom).toBe(layout.height);
    expect(left).toBeGreaterThan(0);
    expect(top).toBeGreaterThan(0);
  });

  test("a task and a wait on one row share a centre and so cannot share a top edge", () => {
    const layout = layoutGraph(folded().graph);
    // dagre lays this chain out straight, so the two sit on the same row with the same centre
    // — and because a wait is 20px taller, identical `y` values would mean the centre never
    // got converted.
    const task = boxOf(layout, "th-nhwd");
    const wait = boxOf(layout, "th-es9m");

    expect(task.height).not.toBe(wait.height);
    expect(task.y + task.height / 2).toBe(wait.y + wait.height / 2);
    expect(task.y).not.toBe(wait.y);
  });

  test("an edge to an activity that is gone is skipped, not minted as a phantom", () => {
    // `setEdge` mints any endpoint it does not already know, and a minted activity has no size, so
    // dagre ranks and separates a zero-sized phantom in the middle of the graph and shoves the
    // real boxes around it. A dangling edge is a shape the model already names
    // (`BlockedCause.kind === "missing"`), so the layout has to ignore it rather than draw it.
    // `folded()` re-reads the log, so each graph below is its own copy of head.
    const stranded = nodeWithEdgesBothWays(folded().graph);

    const dangling = folded().graph;
    dangling.nodes.delete(stranded); // the activity goes, its edges stay — that is the hazard

    const pruned = folded().graph;
    pruned.nodes.delete(stranded);
    pruned.edges = pruned.edges.filter((e) => e.from !== stranded && e.to !== stranded);

    // Guard the premise: something has to actually dangle, on both sides, or the two layouts
    // below are of the same graph and agreeing proves nothing.
    expect(dangling.edges.some((e) => e.to === stranded)).toBe(true);
    expect(dangling.edges.some((e) => e.from === stranded)).toBe(true);
    expect(dangling.edges.length).toBeGreaterThan(pruned.edges.length);

    const withDangling = layoutGraph(dangling);
    const withoutThem = layoutGraph(pruned);

    expect(withDangling.boxes.size).toBe(folded().graph.nodes.size - 1);
    // The count alone would not catch it — a phantom is never asked for a box. What gives it
    // away is that the survivors move, so the expected picture is the one the pruned graph
    // lays out, compared whole rather than at a coordinate anyone typed in.
    expect([...withDangling.boxes]).toEqual([...withoutThem.boxes]);
    expect(withDangling.width).toBe(withoutThem.width);
    expect(withDangling.height).toBe(withoutThem.height);
  });

  test("v0 is empty and lays out without throwing", () => {
    const layout = layoutGraph(folded(0).graph);
    expect(layout.boxes.size).toBe(0);
    expect(layout.width).toBe(0);
    expect(layout.height).toBe(0);
  });
});

describe("createLayoutCache", () => {
  test("a reserve → record pair hands back the identical object, not an equal one", () => {
    const layoutOf = createLayoutCache();
    const first = layoutOf(folded(V.danaReserved).graph);
    const second = layoutOf(folded(V.danaSent).graph);

    // `toBe`, deliberately: React re-renders on identity, so an equal-but-fresh object would
    // move every activity's props and defeat the memo at the only layer where it pays. Identity is
    // also the invocation count — a layout that ran would have built a new `Map`.
    expect(second).toBe(first);
    expect(second.boxes).toBe(first.boxes);
  });

  test("a topology change gets a fresh layout", () => {
    const layoutOf = createLayoutCache();
    const before = layoutOf(folded(V.danaDeclines).graph);
    const after = layoutOf(folded(V.samRefers).graph);

    expect(after).not.toBe(before);
    expect(after.signature).not.toBe(before.signature);
    expect(after.boxes.size).toBe(folded(V.samRefers).graph.nodes.size);
  });

  test("walking the whole log lays out once per shape change and no more", () => {
    const layoutOf = createLayoutCache();
    const produced = new Set<Layout>();
    for (let v = 0; v <= headVersion(); v++) produced.add(layoutOf(folded(v).graph));

    // One distinct object per dagre run: a cache hit returns the previous one. Fourteen
    // graphs, v0…v13, and only five of them cost a layout — the `+ 1` is v0 itself, the cold
    // start. Eight versions of real work are free.
    expect(produced.size).toBe(SHAPE_CHANGING_VERSIONS.size + 1);
  });
});

describe("the notation markers", () => {
  test("are placed, and kept OUT of the activity boxes", () => {
    const layout = layoutGraph(folded().graph);
    // The separation is the point: anything counting or iterating the pursuit's activities must not
    // pick up two circles that correspond to nothing in the log.
    expect(layout.boxes.has(START_MARKER_ID)).toBe(false);
    expect(layout.boxes.has(END_MARKER_ID)).toBe(false);
    expect(layout.markers.has(START_MARKER_ID)).toBe(true);
    expect(layout.markers.has(END_MARKER_ID)).toBe(true);
    expect(layout.boxes.size).toBe(folded().graph.nodes.size);
  });

  test("the start sits left of every card it points at, and the end right of every one", () => {
    const graph = folded().graph;
    const layout = layoutGraph(graph);
    const { starts, ends } = flowTerminals(graph);
    const start = layout.markers.get(START_MARKER_ID);
    const end = layout.markers.get(END_MARKER_ID);
    if (start === undefined || end === undefined) throw new Error("markers were not placed");

    // Ranked in the same dagre pass, which is what keeps the arrows short. An unranked marker
    // would sit at the origin and its arrow would cross the whole canvas to reach the graph.
    expect(starts.size).toBeGreaterThan(0);
    for (const id of starts) {
      const box = layout.boxes.get(id);
      if (box === undefined) throw new Error(`no box for ${id}`);
      expect(start.x).toBeLessThan(box.x);
    }
    expect(ends.size).toBeGreaterThan(0);
    for (const id of ends) {
      const box = layout.boxes.get(id);
      if (box === undefined) throw new Error(`no box for ${id}`);
      expect(end.x).toBeGreaterThan(box.x);
    }
  });

  test("an empty graph gets no markers at all", () => {
    // v0 is genesis: no activities, so no flow, so nothing to punctuate.
    const layout = layoutGraph(folded(0).graph);
    expect(layout.boxes.size).toBe(0);
    expect(layout.markers.size).toBe(0);
  });
});

describe("a bar is as long as it has arms", () => {
  test("a fork with three arms is longer than the minimum, and a two-arm join is not", () => {
    // Not a measurement: arm count is a property of the GRAPH, known before dagre runs and
    // identical on every machine. The rule this module states — "nothing is measured, ever" —
    // is about never letting geometry depend on RENDER, which is what reintroduces the race
    // that loses every edge. This does not.
    const graph = foldLog(
      readFileSync(
        join(import.meta.dir, "..", "..", "..", "fixtures", "goalie.mutations.jsonl"),
        "utf8",
      ),
    ).graph;
    const nodes = [...graph.nodes.values()];
    // `bar` and `sync`, not `fork`/`join`: `join` is `node:path`'s, imported at the top of this
    // file, and shadowing it here reads as a TDZ error thirty lines from the cause.
    const bar = nodes.find((node) => node.type === "fork");
    const sync = nodes.find((node) => node.type === "join");
    if (bar === undefined || sync === undefined) throw new Error("the fixture has no fork/join");

    const arms = graph.edges.filter((edge) => edge.from === bar.id).length;
    expect(arms).toBeGreaterThan(2);
    expect(sizeOf(graph, bar).height).toBeGreaterThan(sizeOf(graph, sync).height);
  });

  test("and a bar is never shorter than the floor, or it reads as a tick", () => {
    const graph = foldLog(
      readFileSync(
        join(import.meta.dir, "..", "..", "..", "fixtures", "goalie.mutations.jsonl"),
        "utf8",
      ),
    ).graph;
    for (const node of graph.nodes.values()) {
      if (node.type === "fork" || node.type === "join") {
        expect(sizeOf(graph, node).height).toBeGreaterThanOrEqual(44);
      }
    }
  });
});

describe("a bar's handles are spread along it", () => {
  test("three arms leave at three different heights, inside the bar", () => {
    // With one centred handle every arm leaves the same pixel and the bar reads as a decorated
    // dot: the shape is there and the information it exists to carry is not.
    const size = { width: 8, height: 66 };
    const handles = barHandles(size, 1, 3);
    const sources = handles.filter((handle) => handle.type === "source");
    expect(sources).toHaveLength(3);

    const ys = sources.map((handle) => handle.y);
    expect(new Set(ys).size).toBe(3);
    for (const y of ys) {
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(size.height);
    }
  });
});
