/**
 * A4: a status-only mutation must not re-run dagre.
 *
 * The fixture is the whole point of these tests. v3 and v4 are real mutations the binary wrote
 * — statuses, outcomes, two outputs — and they bump `graph.version` without touching a node,
 * an edge or a supersession. Anything keyed on the version would re-lay-out there, which is
 * the one moment §6.10 rule 2 forbids.
 */

import { describe, expect, test } from "bun:test";
import type { Graph, Node } from "@kona/core";
import type { Layout, NodeBox } from "../src/layout/dagre.ts";
import {
  NODE_SIZE,
  createLayoutCache,
  layoutGraph,
  topologySignature,
} from "../src/layout/dagre.ts";
import { folded, headVersion } from "./fixture.ts";

function nodeOf(graph: Graph, id: string): Node {
  const node = graph.nodes.get(id);
  if (node === undefined) throw new Error(`the fixture has no node ${id}`);
  return node;
}

function boxOf(layout: Layout, id: string): NodeBox {
  const box = layout.boxes.get(id);
  if (box === undefined) throw new Error(`the layout has no box for ${id}`);
  return box;
}

function states(version: number): string[] {
  return [...folded(version).graph.nodes.values()].map((n) => `${n.id}=${n.status.state}`);
}

/**
 * The first node the fixture has both an edge into and an edge out of, so deleting it strands
 * one of each. Derived rather than named, because a regenerated fixture is free to rename its
 * nodes and a hardcoded id would strand the test instead.
 */
function nodeWithEdgesBothWays(graph: Graph): string {
  const targets = new Set(graph.edges.map((edge) => edge.to));
  const id = graph.edges.find((edge) => targets.has(edge.from))?.from;
  if (id === undefined) throw new Error("the fixture has no node with an in-edge and an out-edge");
  return id;
}

/**
 * The versions whose ops changed the shape of the graph — the table in `context.md`. v3 and v4
 * are the pure status ticks: v3 sets three statuses and records two outputs, v4 records an
 * outcome and a status. Both leave the same nine nodes and seven edges v2 left.
 */
const SHAPE_CHANGING_VERSIONS = new Set([1, 2, 5, 6, 7]);

describe("topologySignature", () => {
  test("v2, v3 and v4 are one shape, and the fixture really does move between them", () => {
    const signatures = [2, 3, 4].map((v) => topologySignature(folded(v).graph));

    // Guard the premise: if a regenerated fixture made v3 or v4 a no-op, the run of equal
    // signatures below would pass for the wrong reason.
    expect(folded(4).graph.version).toBe(4);
    expect(states(3)).not.toEqual(states(2));
    expect(states(4)).not.toEqual(states(3));

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

    const node = nodeOf(graph, "ask-pat-to-play-in-goal");
    node.status.state = "dropped";
    node.status.output = { transcript_ref: "msg-999" };
    node.status.observed_at_version = 99;
    node.status.effect_log.push({
      effect_key: "resend",
      payload_hash: "deadbeef",
      attempted_at: "2026-08-22T02:00:00.000Z",
      completed_at: null,
      message_id: null,
    });
    nodeOf(graph, "goalie-confirmed").status.outcomes.push({
      verdict: "confirmed",
      evidence_ref: "msg-998",
      at_version: 99,
    });

    expect(topologySignature(graph)).toBe(before);
  });

  test("a supersede changes it even when no node or edge is added", () => {
    const graph = folded().graph;
    const before = topologySignature(graph);
    // `escalate-no-goalie-found` is already in the fixture, so this is a supersession and
    // nothing else — no new node, no new edge.
    nodeOf(graph, "ask-pat-to-play-in-goal").provenance.superseded_by = "escalate-no-goalie-found";
    expect(topologySignature(graph)).not.toBe(before);
  });

  test("an edge condition is part of the shape", () => {
    const graph = folded().graph;
    const before = topologySignature(graph);
    // `wait-for-eligibility-ruling -> goalie-confirmed` fires on `accept`; the three goalie
    // waits fire on `satisfied`. Flipping one is a different graph, same node set.
    const edge = graph.edges.find((e) => e.condition?.on === "accept");
    if (edge?.condition === undefined) throw new Error("the fixture lost its `accept` edge");
    edge.condition.on = "satisfied";
    expect(topologySignature(graph)).not.toBe(before);
  });

  test("insertion order is part of the shape (rule 7 pins visual order to it)", () => {
    const graph = folded().graph;
    const reversed: Graph = { ...graph, nodes: new Map([...graph.nodes].toReversed()) };
    expect(topologySignature(reversed)).not.toBe(topologySignature(graph));
  });
});

describe("layoutGraph", () => {
  test("places all 14 head nodes, at the size their type asks for", () => {
    const graph = folded().graph;
    const layout = layoutGraph(graph);

    expect(graph.nodes.size).toBe(14);
    expect(layout.boxes.size).toBe(graph.nodes.size);
    for (const node of graph.nodes.values()) {
      const box = boxOf(layout, node.id);
      expect(box.width).toBe(NODE_SIZE[node.type].width);
      expect(box.height).toBe(NODE_SIZE[node.type].height);
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
    const boxes = [...layout.boxes.values()];
    const left = Math.min(...boxes.map((b) => b.x));
    const right = Math.max(...boxes.map((b) => b.x + b.width));
    const top = Math.min(...boxes.map((b) => b.y));
    const bottom = Math.max(...boxes.map((b) => b.y + b.height));

    // dagre translates its result so the bounding box of the nodes sits inside an equal margin
    // on both sides: `left === marginx` and `right === width - marginx`, hence `left + right
    // === width`. That identity holds only for corners. Left as centres, both extremes would
    // be half a box out and the sums would exceed the reported size by a node's width.
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
    const task = boxOf(layout, "ask-dana-to-play-in-goal");
    const wait = boxOf(layout, "wait-for-dana");

    expect(task.height).not.toBe(wait.height);
    expect(task.y + task.height / 2).toBe(wait.y + wait.height / 2);
    expect(task.y).not.toBe(wait.y);
  });

  test("an edge to a node that is gone is skipped, not minted as a phantom", () => {
    // `setEdge` mints any endpoint it does not already know, and a minted node has no size, so
    // dagre ranks and separates a zero-sized phantom in the middle of the graph and shoves the
    // real boxes around it. A dangling edge is a shape the model already names
    // (`BlockedCause.kind === "missing"`), so the layout has to ignore it rather than draw it.
    // `folded()` re-reads the log, so each graph below is its own copy of head.
    const stranded = nodeWithEdgesBothWays(folded().graph);

    const dangling = folded().graph;
    dangling.nodes.delete(stranded); // the node goes, its edges stay — that is the hazard

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
  test("v3 → v4 hands back the identical object, not an equal one", () => {
    const layoutOf = createLayoutCache();
    const first = layoutOf(folded(3).graph);
    const second = layoutOf(folded(4).graph);

    // `toBe`, deliberately: React re-renders on identity, so an equal-but-fresh object would
    // move every node's props and defeat the memo at the only layer where it pays. Identity is
    // also the invocation count — a layout that ran would have built a new `Map`.
    expect(second).toBe(first);
    expect(second.boxes).toBe(first.boxes);
  });

  test("a topology change gets a fresh layout", () => {
    const layoutOf = createLayoutCache();
    const four = layoutOf(folded(4).graph);
    const five = layoutOf(folded(5).graph);

    expect(five).not.toBe(four);
    expect(five.signature).not.toBe(four.signature);
    expect(five.boxes.size).toBe(folded(5).graph.nodes.size);
  });

  test("walking the whole log lays out once per shape change and no more", () => {
    const layoutOf = createLayoutCache();
    const produced = new Set<Layout>();
    for (let v = 0; v <= headVersion(); v++) produced.add(layoutOf(folded(v).graph));

    // One distinct object per dagre run: a cache hit returns the previous one. Eight graphs,
    // v0…v7; v3 and v4 repeat v2's shape and cost nothing, and the `+ 1` is v0 itself, the
    // cold start.
    expect(produced.size).toBe(SHAPE_CHANGING_VERSIONS.size + 1);
  });
});
