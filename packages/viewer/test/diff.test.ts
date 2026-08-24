/**
 * The executable form of "never re-layout on a status tick" (§6.10 rules 1 and 2).
 *
 * Every assertion here is a fact about `fixtures/thursday.*`, which the real binary wrote:
 * which versions changed the shape of the graph and which only moved statuses around. The
 * table below IS that record — it was transcribed from an E6 working note that has since
 * been dropped from the repo, and keeping it here is the better home anyway: a table in a
 * document goes stale silently, and this one is executed.
 *
 * If a regen of the fixture changes the story, these tests are supposed to fail rather than
 * quietly follow it. The version numbers come from `fixture.ts`'s `V`, whose names are pinned
 * against the log's own ops by `beats.test.ts` — so a regen that REORDERS the story fails
 * there, in one place, rather than here in thirty with arithmetic errors.
 */

import { describe, expect, test } from "bun:test";
import type { CommittedOp, Edge, Graph } from "@kona/core";
import { applyOps, formatRejection } from "@kona/core";
import { diffGraphs, edgeKey, edgeKeyString } from "../src/model/diff.ts";
import { V, folded, headVersion } from "./fixture.ts";

/** Every version that has a predecessor to be diffed against. */
const VERSIONS = Array.from({ length: headVersion() }, (_, index) => index + 1);

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
  test("eight of the thirteen versions are status ticks", () => {
    // Most of them are the outbox: a send is `effect reserve` then `effect record`, two
    // commits that move one node's status and touch nothing else. That is the single most
    // common thing a live pursuit does, and re-running dagre for each would make the picture
    // jump every time an email goes out.
    const table = Object.fromEntries(VERSIONS.map((v) => [v, step(v).topologyStable]));
    expect(table).toEqual({
      [V.roster]: false, // the roster step and the escalation, before anyone is contacted
      [V.plan]: false, // the fan-out to Dana, Sam and Priya, converging on the predicate
      [V.danaReserved]: true, // active -> sending
      [V.danaSent]: true, // sending -> done
      [V.samReserved]: true,
      [V.samSent]: true,
      [V.priyaReserved]: true, // and it stays sending until v11
      [V.danaDeclines]: true, // one outcome, one status
      [V.samRefers]: false, // the Marcus arm
      [V.rosterSuperseded]: false, // the supersede — adds no edge and still moves the picture
      [V.priyaFailed]: true, // sending -> failed, four versions after the reservation
      [V.patPlanned]: false, // Pat's arm, after Priya's wait is dropped
      [V.patReserved]: true, // active -> sending, and the fixture ends there
    });
  });

  test("a reserve and its record are the pair that proves rule 2", () => {
    // Same shape, different statuses — and the strongest possible form of it, because these
    // two versions are one email. The graph must not move while a send completes.
    const before = folded(V.danaReserved).graph;
    const after = folded(V.danaSent).graph;
    expect([...after.nodes.keys()]).toEqual([...before.nodes.keys()]);
    expect(after.edges).toEqual(before.edges);

    const diff = diffGraphs(before, after);
    expect(diff.topologyStable).toBe(true);
    expect(diff.statusChanged).toEqual([
      { id: "th-nhwd", from: "in_flight", to: "done" },
    ]);
  });

  test("every version carries its own version numbers", () => {
    for (const v of VERSIONS) {
      expect(step(v).fromVersion).toBe(v - 1);
      expect(step(v).toVersion).toBe(v);
    }
  });
});

describe("versions that change the shape", () => {
  test("the roster version reads the roster and emails nobody", () => {
    // Invariant 3(b) shapes this version: §6.7 rejects "a recipient existing only in the
    // proposing batch", so the roster has to land in a commit of its own before anything
    // may address the people in it. v1 adds no edges because it wires nothing yet.
    const diff = step(V.roster);
    expect(diff.addedNodes).toEqual([
      "th-ahf6",
      "th-vipt",
    ]);
    expect(diff.addedEdges).toEqual([]);
    // Nothing CHANGED status: the roster node is added and finished inside one version, so
    // it is an addition, not a transition. There is no earlier state to have moved from.
    expect(diff.statusChanged).toEqual([]);
  });

  test("the plan version is every arm at once, converging on the predicate", () => {
    const diff = step(V.plan);
    expect(diff.addedNodes).toEqual([
      "th-nhwd",
      "th-es9m",
      "th-gyre",
      "th-ocwr",
      "th-t2yo",
      "th-1ppl",
      "th-ymld",
    ]);
    // Three of the seven new edges are conditional, all on `satisfied`, all into the quorum.
    expect(diff.addedEdges.filter((key) => key.to === "th-ymld")).toEqual([
      { from: "th-es9m", to: "th-ymld", on: "satisfied" },
      { from: "th-ocwr", to: "th-ymld", on: "satisfied" },
      { from: "th-1ppl", to: "th-ymld", on: "satisfied" },
    ]);
    expect(diff.statusChanged).toEqual([]);
  });

  test("Sam's refusal grows the Marcus arm", () => {
    const diff = step(V.samRefers);
    expect(diff.addedNodes).toEqual(["th-etsk", "th-9xi1"]);
    expect(diff.addedEdges).toEqual([
      { from: "th-etsk", to: "th-9xi1", on: null },
      // The one `accept` edge in the fixture: a human ruling, not a reply.
      { from: "th-9xi1", to: "th-ymld", on: "accept" },
    ]);
    expect(diff.statusChanged).toEqual([{ id: "th-ocwr", from: "active", to: "done" }]);
    expect(diff.outcomeAdded).toEqual(["th-ocwr"]);
    expect(diff.topologyStable).toBe(false);
  });

  test("the supersede adds no edge, moves no status, and is still not stable", () => {
    const diff = step(V.rosterSuperseded);
    expect(diff.addedNodes).toEqual(["th-five"]);
    expect(diff.addedEdges).toEqual([]);
    // The superseded node was already `done`, so superseding it moved nothing observable.
    // Only `superseded` records what happened — and it alone has to unstick the layout.
    expect(diff.statusChanged).toEqual([]);
    expect(diff.outcomeAdded).toEqual([]);
    expect(diff.superseded).toEqual([
      {
        id: "th-ahf6",
        by: "th-five",
      },
    ]);
    expect(diff.topologyStable).toBe(false);
  });

  test("the bounce is a status tick — the outbox closing the slot it issued", () => {
    // Priya's send and the plan change it causes are TWO versions, and that is the outbox
    // being honest about time: `effect record --outcome failed` closes the reservation the
    // moment the 550 arrives, and what to do about it is a separate decision, made after.
    const diff = step(V.priyaFailed);
    expect(diff.addedNodes).toEqual([]);
    expect(diff.statusChanged).toEqual([
      { id: "th-t2yo", from: "in_flight", to: "failed" },
    ]);
    expect(diff.topologyStable).toBe(true);
  });

  test("Pat's arm is planned once Priya's is written off", () => {
    const diff = step(V.patPlanned);
    expect(diff.addedNodes).toEqual(["th-gk0l", "th-0s7c"]);
    expect(diff.addedEdges).toEqual([
      { from: "th-gk0l", to: "th-0s7c", on: null },
      { from: "th-0s7c", to: "th-ymld", on: "satisfied" },
    ]);
    expect(diff.statusChanged).toEqual([
      { id: "th-1ppl", from: "active", to: "dropped" },
    ]);
    expect(diff.outcomeAdded).toEqual(["th-1ppl"]);
  });

  test("a supersede with no replacement shows up as a drop, not as a supersede", () => {
    // That version supersedes `th-1ppl` with no `by`, so `superseded_by` stays null
    // and the only trace in the graph is the status going `dropped`. Reporting it under
    // `superseded` would mean inventing a replacement that the log does not name.
    const diff = step(V.patPlanned);
    expect(diff.superseded).toEqual([]);
    expect(folded(V.patPlanned).graph.nodes.get("th-1ppl")?.provenance.superseded_by).toBe(
      null,
    );
    expect(diff.statusChanged).toContainEqual({
      id: "th-1ppl",
      from: "active",
      to: "dropped",
    });
  });
});

describe("supersede, on its own", () => {
  test("a supersede alone unsticks the layout, though it adds nothing", () => {
    const before = folded(V.samRefers).graph;
    const retired = before.nodes.get("th-ahf6");
    expect(retired?.status.state).toBe("done");
    expect(retired?.provenance.superseded_by).toBe(null);

    // The supersede version with its own `add_node` taken away: the roster step retired in
    // favour of the eligibility check the version before had just added, which already exists
    // here — so the replacement is real without the batch having to create it.
    const after = applied(before, [
      {
        op: "supersede_node",
        node: "th-ahf6",
        by: "th-etsk",
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
      { id: "th-ahf6", by: "th-etsk" },
    ]);
    // ...so it alone has to re-run dagre. The replacement must be drawn beside the node it
    // replaces with the chain between them, and leaving this stable would lay one on top of
    // the other.
    expect(diff.topologyStable).toBe(false);
  });

  test("a bare supersede retires a branch without moving the picture", () => {
    const before = folded(6).graph;
    expect(before.nodes.get("th-1ppl")?.status.state).toBe("active");

    // No `by` — what v7 does to Priya's wait once her address bounces. §6.4: `superseded_by`
    // stays null because no replacement was named, and the node stops being work instead.
    const after = applied(before, [{ op: "supersede_node", node: "th-1ppl" }]);
    expect(after.nodes.get("th-1ppl")?.provenance.superseded_by).toBe(null);

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
      { id: "th-1ppl", from: "active", to: "dropped" },
    ]);
    expect(diff.topologyStable).toBe(true);
  });
});

describe("status ticks", () => {
  test("a reservation moves one task to `sending` and nothing else", () => {
    const diff = step(V.priyaReserved);
    // `sending` is not terminal: the intent is fsynced and nobody knows the answer yet.
    // Priya's stays exactly here for four versions, which is what makes it renderable.
    expect(diff.statusChanged).toEqual([
      { id: "th-t2yo", from: "active", to: "in_flight" },
    ]);
    expect(diff.addedNodes).toEqual([]);
    expect(diff.addedEdges).toEqual([]);
    expect(diff.superseded).toEqual([]);
    // A reservation is not an answer. An outcome is something a counterparty produced.
    expect(diff.outcomeAdded).toEqual([]);
    expect(diff.topologyStable).toBe(true);
  });

  test("Dana's refusal is recorded against an unchanged shape", () => {
    const diff = step(V.danaDeclines);
    expect(diff.statusChanged).toEqual([{ id: "th-es9m", from: "active", to: "done" }]);
    expect(diff.outcomeAdded).toEqual(["th-es9m"]);
    expect(diff.topologyStable).toBe(true);
    // `declined` closes the wait, so the node is `done`. It did not fail; somebody answered.
    expect(folded(V.danaDeclines).graph.nodes.get("th-es9m")?.status.outcome?.verdict).toBe(
      "declined",
    );
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
    expect(diff.toVersion).toBe(V.patReserved);
    expect(diff.topologyStable).toBe(false);
    // Additions in insertion order (rule 7), so the canvas can pin visual order to it.
    expect(diff.addedNodes[0]).toBe("th-ahf6");
    expect(diff.addedNodes.at(-1)).toBe("th-0s7c");
    // A node that appears for the first time is an addition, never a transition — there is
    // no earlier state for it to have moved from.
    expect(diff.statusChanged).toEqual([]);
    expect(diff.outcomeAdded).toEqual([]);
    expect(diff.superseded).toEqual([]);
  });
});

describe("diffs across more than one version", () => {
  test("the plan against head collapses eleven versions into one animation", () => {
    const diff = diffGraphs(folded(V.plan).graph, folded(V.patReserved).graph);
    expect(diff.fromVersion).toBe(V.plan);
    expect(diff.toVersion).toBe(V.patReserved);
    expect(diff.addedNodes).toEqual([
      "th-etsk",
      "th-9xi1",
      "th-five",
      "th-gk0l",
      "th-0s7c",
    ]);
    expect(diff.addedEdges).toHaveLength(4);
    expect(diff.superseded).toEqual([
      {
        id: "th-ahf6",
        by: "th-five",
      },
    ]);
    // Priya went active -> sending -> failed across three separate versions; the diff
    // reports the endpoints, which is the whole point of collapsing a range.
    expect(diff.statusChanged).toContainEqual({
      id: "th-t2yo",
      from: "active",
      to: "failed",
    });
    // Dana's two commits collapse the same way.
    expect(diff.statusChanged).toContainEqual({
      id: "th-nhwd",
      from: "active",
      to: "done",
    });
    expect(diff.outcomeAdded).toEqual(["th-es9m", "th-ocwr", "th-1ppl"]);
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
    const edge = edgeBetween(folded().graph.edges, "th-nhwd", "th-es9m");
    expect(edgeKey(edge)).toEqual({
      from: "th-nhwd",
      to: "th-es9m",
      on: null,
    });
  });

  test("a conditional edge carries its condition into the key", () => {
    const edges = folded().graph.edges;
    const edge = edgeBetween(edges, "th-9xi1", "th-ymld");
    expect(edge.condition).toEqual({ on: "accept" });
    expect(edgeKey(edge)).toEqual({
      from: "th-9xi1",
      to: "th-ymld",
      on: "accept",
    });
  });

  test("the condition is part of the identity, so the same pair keys differently", () => {
    const pair = { from: "th-es9m", to: "th-ymld" } as const;
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
      .graph.edges.filter((edge) => edge.to === "th-ymld")
      .map((edge) => edgeKeyString(edgeKey(edge)));
    expect(into).toEqual([
      "th-es9m>th-ymld#satisfied",
      "th-ocwr>th-ymld#satisfied",
      "th-1ppl>th-ymld#satisfied",
      "th-9xi1>th-ymld#accept",
      "th-0s7c>th-ymld#satisfied",
    ]);
  });
});
