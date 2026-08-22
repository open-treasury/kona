/**
 * The executable form of "never re-layout on a status tick" (§6.10 rules 1 and 2).
 *
 * Every assertion here is a fact about `fixtures/thursday.*`, which the real binary wrote:
 * which versions changed the shape of the graph and which only moved statuses around. The
 * table in `plans/active/e6-viewer/context.md` is transcribed below, and if a regen of the
 * fixture changes the story, these tests are supposed to fail rather than quietly follow it.
 */

import { describe, expect, test } from "bun:test";
import type { CommittedOp, Edge, Graph } from "@kona/core";
import { applyOps, formatRejection } from "@kona/core";
import { diffGraphs, edgeKey, edgeKeyString } from "../src/model/diff.ts";
import { folded } from "./fixture.ts";

const VERSIONS = [1, 2, 3, 4, 5, 6, 7] as const;

/** The diff the version `v` produced: fold to `v - 1`, fold to `v`, compare. */
function step(v: number) {
  return diffGraphs(folded(v - 1).graph, folded(v).graph);
}

function edgeBetween(edges: readonly Edge[], from: string, to: string): Edge {
  const found = edges.find((edge) => edge.from === from && edge.to === to);
  if (found === undefined) throw new Error(`fixture has no edge ${from} -> ${to}`);
  return found;
}

/**
 * The next version, produced by the store's own `applyOps` rather than by editing a node in
 * place. Both fixture versions that supersede also add a node, so a supersede on its own is a
 * pair the committed log cannot supply — but it has to be a pair `kona` could have written,
 * and only `apply.ts` knows what a supersede does to status and provenance. It clones, so the
 * `before` graph handed in stays pristine and is safe to diff against.
 */
function applied(graph: Graph, ops: CommittedOp[]): Graph {
  const result = applyOps(graph, ops, graph.version + 1);
  if (!result.ok) throw new Error(`the store refused: ${formatRejection(result.rejection)}`);
  return result.value;
}

describe("the topology table", () => {
  test("only v3 and v4 are status ticks", () => {
    const table = Object.fromEntries(VERSIONS.map((v) => [v, step(v).topologyStable]));
    expect(table).toEqual({
      1: false, // four nodes, two edges — the approved plan
      2: false, // the fan-out to Sam and Priya, converging on the predicate
      3: true, // dispatches: three set_status, two record_output
      4: true, // Dana declines: one outcome, one status
      5: false, // the Marcus arm
      6: false, // the supersede — adds no edge and still moves the picture
      7: false, // Pat's arm, after Priya bounces
    });
  });

  test("v3 -> v4 is the pair that proves rule 2: same shape, different statuses", () => {
    const at3 = folded(3).graph;
    const at4 = folded(4).graph;
    expect([...at4.nodes.keys()]).toEqual([...at3.nodes.keys()]);
    expect(at4.edges).toEqual(at3.edges);

    const diff = diffGraphs(at3, at4);
    expect(diff.topologyStable).toBe(true);
    expect(diff.statusChanged.length).toBeGreaterThan(0);
  });

  test("every version carries its own version numbers", () => {
    for (const v of VERSIONS) {
      expect(step(v).fromVersion).toBe(v - 1);
      expect(step(v).toVersion).toBe(v);
    }
  });
});

describe("versions that change the shape", () => {
  test("v1 reads the roster and emails nobody", () => {
    // Invariant 3(b) shapes this version: §6.7 rejects "a recipient existing only in the
    // proposing batch", so the roster has to land in a commit of its own before anything
    // may address the people in it. v1 adds no edges because it wires nothing yet.
    const diff = step(1);
    expect(diff.addedNodes).toEqual([
      "confirm-roster-availability",
      "escalate-no-goalie-found",
    ]);
    expect(diff.addedEdges).toEqual([]);
    // Nothing CHANGED status: the roster node is added and finished inside one version, so
    // it is an addition, not a transition. There is no earlier state to have moved from.
    expect(diff.statusChanged).toEqual([]);
  });

  test("v2 is the approved plan: every arm at once, converging on the predicate", () => {
    const diff = step(2);
    expect(diff.addedNodes).toEqual([
      "ask-dana-to-play-in-goal",
      "wait-for-dana",
      "ask-sam-to-play-in-goal",
      "wait-for-sam",
      "ask-priya-to-play-in-goal",
      "wait-for-priya",
      "goalie-confirmed",
    ]);
    // Three of the seven new edges are conditional, all on `satisfied`, all into the quorum.
    expect(diff.addedEdges.filter((key) => key.to === "goalie-confirmed")).toEqual([
      { from: "wait-for-dana", to: "goalie-confirmed", on: "satisfied" },
      { from: "wait-for-sam", to: "goalie-confirmed", on: "satisfied" },
      { from: "wait-for-priya", to: "goalie-confirmed", on: "satisfied" },
    ]);
    expect(diff.statusChanged).toEqual([]);
  });

  test("v5 grows the Marcus arm off Sam's refusal", () => {
    const diff = step(5);
    expect(diff.addedNodes).toEqual(["check-marcus-is-eligible", "wait-for-eligibility-ruling"]);
    expect(diff.addedEdges).toEqual([
      { from: "check-marcus-is-eligible", to: "wait-for-eligibility-ruling", on: null },
      // The one `accept` edge in the fixture: a human ruling, not a reply.
      { from: "wait-for-eligibility-ruling", to: "goalie-confirmed", on: "accept" },
    ]);
    expect(diff.statusChanged).toEqual([{ id: "wait-for-sam", from: "active", to: "done" }]);
    expect(diff.outcomeAdded).toEqual(["wait-for-sam"]);
    expect(diff.topologyStable).toBe(false);
  });

  test("v6 is a supersede: no new edge, no status moved, and still not stable", () => {
    const diff = step(6);
    expect(diff.addedNodes).toEqual(["confirm-roster-availability-and-eligibility"]);
    expect(diff.addedEdges).toEqual([]);
    // The superseded node was already `done`, so superseding it moved nothing observable.
    // Only `superseded` records what happened — and it alone has to unstick the layout.
    expect(diff.statusChanged).toEqual([]);
    expect(diff.outcomeAdded).toEqual([]);
    expect(diff.superseded).toEqual([
      {
        id: "confirm-roster-availability",
        by: "confirm-roster-availability-and-eligibility",
      },
    ]);
    expect(diff.topologyStable).toBe(false);
  });

  test("v7 asks Pat after Priya's address bounces", () => {
    const diff = step(7);
    expect(diff.addedNodes).toEqual(["ask-pat-to-play-in-goal", "wait-for-pat"]);
    expect(diff.addedEdges).toEqual([
      { from: "ask-pat-to-play-in-goal", to: "wait-for-pat", on: null },
      { from: "wait-for-pat", to: "goalie-confirmed", on: "satisfied" },
    ]);
    expect(diff.statusChanged).toEqual([
      { id: "ask-priya-to-play-in-goal", from: "sending", to: "failed" },
      { id: "wait-for-priya", from: "active", to: "dropped" },
    ]);
    expect(diff.outcomeAdded).toEqual(["wait-for-priya"]);
  });

  test("a supersede with no replacement shows up as a drop, not as a supersede", () => {
    // v7 supersedes `wait-for-priya` with no `by`, so `superseded_by` stays null and the
    // only trace in the graph is the status going `dropped`. Reporting it under `superseded`
    // would mean inventing a replacement that the log does not name.
    const diff = step(7);
    expect(diff.superseded).toEqual([]);
    expect(folded(7).graph.nodes.get("wait-for-priya")?.provenance.superseded_by).toBe(null);
    expect(diff.statusChanged).toContainEqual({
      id: "wait-for-priya",
      from: "active",
      to: "dropped",
    });
  });
});

describe("supersede, on its own", () => {
  test("a supersede alone unsticks the layout, though it adds nothing", () => {
    const before = folded(5).graph;
    const retired = before.nodes.get("confirm-roster-availability");
    expect(retired?.status.state).toBe("done");
    expect(retired?.provenance.superseded_by).toBe(null);

    // v6's supersede with v6's `add_node` taken away: the roster step retired in favour of
    // the eligibility check that v5 had just added, which is a node that already exists here.
    const after = applied(before, [
      {
        op: "supersede_node",
        node: "confirm-roster-availability",
        by: "check-marcus-is-eligible",
      },
    ]);

    const diff = diffGraphs(before, after);
    expect(diff.addedNodes).toEqual([]);
    expect(diff.addedEdges).toEqual([]);
    // Already `done`, so §6.4 leaves the status alone — superseding does not un-send an
    // email. `superseded` is the only field that carries the change at all...
    expect(diff.statusChanged).toEqual([]);
    expect(diff.outcomeAdded).toEqual([]);
    expect(diff.superseded).toEqual([
      { id: "confirm-roster-availability", by: "check-marcus-is-eligible" },
    ]);
    // ...so it alone has to re-run dagre. The replacement must be drawn beside the node it
    // replaces with the chain between them, and leaving this stable would lay one on top of
    // the other.
    expect(diff.topologyStable).toBe(false);
  });

  test("a bare supersede retires a branch without moving the picture", () => {
    const before = folded(6).graph;
    expect(before.nodes.get("wait-for-priya")?.status.state).toBe("active");

    // No `by` — what v7 does to Priya's wait once her address bounces. §6.4: `superseded_by`
    // stays null because no replacement was named, and the node stops being work instead.
    const after = applied(before, [{ op: "supersede_node", node: "wait-for-priya" }]);
    expect(after.nodes.get("wait-for-priya")?.provenance.superseded_by).toBe(null);

    const diff = diffGraphs(before, after);
    // These two answers are consistent, not contradictory. `superseded` is empty because
    // there is no replacement to name, and `topologyStable` is true because nothing was added
    // and nothing has to be laid out beside anything — re-running dagre here would be exactly
    // the tick rule 2 forbids. The retirement is not lost: `statusChanged` carries it, and
    // that is what lets the timeline say a branch was retired rather than "status only".
    expect(diff.superseded).toEqual([]);
    expect(diff.addedNodes).toEqual([]);
    expect(diff.addedEdges).toEqual([]);
    expect(diff.statusChanged).toEqual([
      { id: "wait-for-priya", from: "active", to: "dropped" },
    ]);
    expect(diff.topologyStable).toBe(true);
  });
});

describe("status ticks", () => {
  test("v3 moves three tasks and nothing else", () => {
    const diff = step(3);
    expect(diff.statusChanged).toEqual([
      { id: "ask-dana-to-play-in-goal", from: "active", to: "done" },
      { id: "ask-sam-to-play-in-goal", from: "active", to: "done" },
      // Reserved and in flight. `sending` is not terminal: nobody knows the answer yet.
      { id: "ask-priya-to-play-in-goal", from: "active", to: "sending" },
    ]);
    expect(diff.addedNodes).toEqual([]);
    expect(diff.addedEdges).toEqual([]);
    expect(diff.superseded).toEqual([]);
    // Two `record_output` ops in the same version. An output is not an outcome.
    expect(diff.outcomeAdded).toEqual([]);
    expect(diff.topologyStable).toBe(true);
  });

  test("v4 records Dana's refusal against an unchanged shape", () => {
    const diff = step(4);
    expect(diff.statusChanged).toEqual([{ id: "wait-for-dana", from: "active", to: "done" }]);
    expect(diff.outcomeAdded).toEqual(["wait-for-dana"]);
    expect(diff.topologyStable).toBe(true);
    // `declined` closes the wait, so the node is `done`. It did not fail; somebody answered.
    expect(folded(4).graph.nodes.get("wait-for-dana")?.status.outcome?.verdict).toBe("declined");
  });
});

describe("the first paint", () => {
  test("v0 against null is empty and therefore stable", () => {
    const diff = diffGraphs(null, folded(0).graph);
    expect(diff).toEqual({
      fromVersion: 0,
      toVersion: 0,
      addedNodes: [],
      addedEdges: [],
      statusChanged: [],
      outcomeAdded: [],
      superseded: [],
      topologyStable: true,
    });
  });

  test("head against null adds all fourteen nodes and eleven edges", () => {
    const head = folded().graph;
    const diff = diffGraphs(null, head);
    expect(diff.addedNodes).toHaveLength(14);
    expect(diff.addedEdges).toHaveLength(11);
    expect(diff.toVersion).toBe(8);
    expect(diff.topologyStable).toBe(false);
    // Additions in insertion order (rule 7), so the canvas can pin visual order to it.
    expect(diff.addedNodes[0]).toBe("confirm-roster-availability");
    expect(diff.addedNodes.at(-1)).toBe("wait-for-pat");
    // A node that appears for the first time is an addition, never a transition — there is
    // no earlier state for it to have moved from.
    expect(diff.statusChanged).toEqual([]);
    expect(diff.outcomeAdded).toEqual([]);
    expect(diff.superseded).toEqual([]);
  });
});

describe("diffs across more than one version", () => {
  test("v2 -> v7 collapses five versions into one animation", () => {
    const diff = diffGraphs(folded(2).graph, folded(7).graph);
    expect(diff.fromVersion).toBe(2);
    expect(diff.toVersion).toBe(7);
    expect(diff.addedNodes).toEqual([
      "check-marcus-is-eligible",
      "wait-for-eligibility-ruling",
      "confirm-roster-availability-and-eligibility",
      "ask-pat-to-play-in-goal",
      "wait-for-pat",
    ]);
    expect(diff.addedEdges).toHaveLength(4);
    expect(diff.superseded).toEqual([
      {
        id: "confirm-roster-availability",
        by: "confirm-roster-availability-and-eligibility",
      },
    ]);
    // Priya went active -> sending -> failed in between; the diff reports the endpoints.
    expect(diff.statusChanged).toContainEqual({
      id: "ask-priya-to-play-in-goal",
      from: "active",
      to: "failed",
    });
    expect(diff.outcomeAdded).toEqual(["wait-for-dana", "wait-for-sam", "wait-for-priya"]);
  });
});

describe("nothing is ever removed", () => {
  test("every id present at a version is still present at head", () => {
    const head = new Set(folded().graph.nodes.keys());
    for (const v of VERSIONS) {
      for (const id of folded(v).graph.nodes.keys()) {
        expect(head.has(id)).toBe(true);
      }
    }
  });

  test("the node and edge counts never go down", () => {
    let nodes = 0;
    let edges = 0;
    for (const v of [0, ...VERSIONS]) {
      const graph = folded(v).graph;
      expect(graph.nodes.size).toBeGreaterThanOrEqual(nodes);
      expect(graph.edges.length).toBeGreaterThanOrEqual(edges);
      nodes = graph.nodes.size;
      edges = graph.edges.length;
    }
    expect(nodes).toBe(14);
    expect(edges).toBe(11);
  });
});

describe("edge keys", () => {
  test("an unconditional edge keys with a null condition", () => {
    const edge = edgeBetween(folded().graph.edges, "ask-dana-to-play-in-goal", "wait-for-dana");
    expect(edgeKey(edge)).toEqual({
      from: "ask-dana-to-play-in-goal",
      to: "wait-for-dana",
      on: null,
    });
  });

  test("a conditional edge carries its condition into the key", () => {
    const edges = folded().graph.edges;
    const edge = edgeBetween(edges, "wait-for-eligibility-ruling", "goalie-confirmed");
    expect(edge.condition).toEqual({ on: "accept" });
    expect(edgeKey(edge)).toEqual({
      from: "wait-for-eligibility-ruling",
      to: "goalie-confirmed",
      on: "accept",
    });
  });

  test("the condition is part of the identity, so the same pair keys differently", () => {
    const pair = { from: "wait-for-dana", to: "goalie-confirmed" } as const;
    expect(edgeKeyString({ ...pair, on: null })).not.toBe(
      edgeKeyString({ ...pair, on: "satisfied" }),
    );
  });

  test("all eleven head edges have distinct key strings", () => {
    const edges = folded().graph.edges;
    const keys = new Set(edges.map((edge) => edgeKeyString(edgeKey(edge))));
    expect(keys.size).toBe(edges.length);
  });

  test("every edge into the quorum is distinguished by source and condition", () => {
    const into = folded()
      .graph.edges.filter((edge) => edge.to === "goalie-confirmed")
      .map((edge) => edgeKeyString(edgeKey(edge)));
    expect(into).toEqual([
      "wait-for-dana>goalie-confirmed#satisfied",
      "wait-for-sam>goalie-confirmed#satisfied",
      "wait-for-priya>goalie-confirmed#satisfied",
      "wait-for-eligibility-ruling>goalie-confirmed#accept",
      "wait-for-pat>goalie-confirmed#satisfied",
    ]);
  });
});
