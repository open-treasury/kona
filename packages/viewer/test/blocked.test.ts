/**
 * Readiness and blocked reasons, against the real pursuit.
 *
 * The assertions name fixture nodes and fixture labels on purpose. A test that restated the
 * implementation ("the first cause has kind `dropped`, because we return `dropped` first")
 * would survive any drift from `@kona/core`, which is the one drift that matters here: the
 * viewer must call a node blocked exactly when `kona` refuses to dispatch it.
 */

import { describe, expect, test } from "bun:test";
import type { CommittedOp, Edge, Graph, Node } from "@kona/core";
import {
  applyOps,
  formatRejection,
  inEdges,
  isEdgeSatisfied,
  isReady,
  isTerminal,
  readyFrontier,
  resolutionOf,
  satisfiesBlockingEdge,
} from "@kona/core";
import { blockedReason, readinessOf } from "../src/model/blocked.ts";
import { V, folded, headVersion } from "./fixture.ts";

const HEAD = headVersion();

function graphAt(version?: number): Graph {
  return folded(version).graph;
}

function nodeOf(graph: Graph, id: string): Node {
  const node = graph.nodes.get(id);
  if (node === undefined) throw new Error(`the fixture has no node ${id} at v${graph.version}`);
  return node;
}

/** The reason, or a throw — so a test that expected one cannot silently assert on null. */
function reasonOf(graph: Graph, id: string) {
  const node = nodeOf(graph, id);
  const reason = blockedReason(graph, node);
  if (reason === null) throw new Error(`${id} is ${readinessOf(graph, node)}, not blocked`);
  return reason;
}

function edgeIndex(graph: Graph, from: string, to: string): number {
  const index = graph.edges.findIndex((edge) => edge.from === from && edge.to === to);
  if (index < 0) throw new Error(`the fixture has no edge ${from} -> ${to}`);
  return index;
}

/** Replace one edge in place, preserving append order — the order causes are reported in. */
function withEdge(graph: Graph, index: number, edge: Edge): Graph {
  graph.edges.splice(index, 1, edge);
  return graph;
}

/**
 * Move the graph on with the store's own ops rather than by writing a node literal, so the
 * state under test is one `kona` could actually have committed. `applyOps` clones, so the
 * graph handed in is left alone.
 */
function applied(graph: Graph, ops: CommittedOp[]): Graph {
  const result = applyOps(graph, ops, graph.version + 1);
  if (!result.ok) throw new Error(`the store refused: ${formatRejection(result.rejection)}`);
  return result.value;
}

describe("readinessOf", () => {
  test("the fixture is the fourteen-version pursuit these tests were written against", () => {
    expect(HEAD).toBe(V.patReserved);
  });

  test("an active node with no in-edges is ready", () => {
    const graph = graphAt();
    for (const id of [
      "escalate-no-goalie-found",
      "check-marcus-is-eligible",
      "confirm-roster-availability-and-eligibility",
    ]) {
      const node = nodeOf(graph, id);
      expect(node.status.state).toBe("active");
      expect(inEdges(graph, id)).toHaveLength(0);
      expect(readinessOf(graph, node)).toBe("ready");
      expect(blockedReason(graph, node)).toBeNull();
    }
  });

  test("superseded outranks settled: the roster step is done, and reads as replaced", () => {
    const graph = graphAt();
    const node = nodeOf(graph, "confirm-roster-availability");
    expect(node.status.state).toBe("done");
    expect(node.provenance.superseded_by).toBe("confirm-roster-availability-and-eligibility");
    expect(readinessOf(graph, node)).toBe("superseded");
  });

  test("every terminal status settles, including the two that never satisfy anything", () => {
    const graph = graphAt();
    expect(readinessOf(graph, nodeOf(graph, "wait-for-dana"))).toBe("settled");
    expect(nodeOf(graph, "ask-priya-to-play-in-goal").status.state).toBe("failed");
    expect(readinessOf(graph, nodeOf(graph, "ask-priya-to-play-in-goal"))).toBe("settled");
    expect(nodeOf(graph, "wait-for-priya").status.state).toBe("dropped");
    expect(readinessOf(graph, nodeOf(graph, "wait-for-priya"))).toBe("settled");
  });

  test("sending is running, not settled — the world's answer is unknown", () => {
    const graph = graphAt();
    const node = nodeOf(graph, "ask-pat-to-play-in-goal");
    expect(node.status.state).toBe("in_flight");
    expect(readinessOf(graph, node)).toBe("running");
    expect(blockedReason(graph, node)).toBeNull();
  });

  test("goalie-confirmed is blocked at head even though two of its waits fired satisfied", () => {
    const graph = graphAt();
    const node = nodeOf(graph, "goalie-confirmed");
    expect(node.status.state).toBe("active");
    expect(inEdges(graph, "goalie-confirmed")).toHaveLength(5);
    expect(resolutionOf(nodeOf(graph, "wait-for-dana"))).toBe("satisfied");
    expect(resolutionOf(nodeOf(graph, "wait-for-sam"))).toBe("satisfied");
    // The predicate is `count{confirmed, role=goalie} >= 1`, but readiness is an edge
    // question, not a predicate one: `isReady` wants every in-edge satisfied.
    expect(isReady(graph, node)).toBe(false);
    expect(readinessOf(graph, node)).toBe("blocked");
  });

  test("readinessOf agrees with readyFrontier at every version of the log", () => {
    for (let version = 1; version <= HEAD; version += 1) {
      const graph = graphAt(version);
      const ready = [...graph.nodes.values()]
        .filter((node) => readinessOf(graph, node) === "ready")
        .map((node) => node.id);
      expect(ready).toEqual(readyFrontier(graph).map((node) => node.id));
    }
  });
});

describe("blockedReason", () => {
  test("null for anything that is not blocked", () => {
    const graph = graphAt();
    for (const node of graph.nodes.values()) {
      if (readinessOf(graph, node) === "blocked") continue;
      expect(blockedReason(graph, node)).toBeNull();
    }
  });

  test("a source still in flight: wait-for-pat behind Pat's open reservation", () => {
    // The fixture's ending, and the state rule 8's third colour exists for: the slot is
    // fsynced, the bytes may or may not have moved, and nothing downstream may proceed.
    const graph = graphAt(V.patReserved);
    const reason = reasonOf(graph, "wait-for-pat");
    expect(reason.causes).toHaveLength(1);
    expect(reason.causes[0]).toEqual({
      from: "ask-pat-to-play-in-goal",
      fromLabel: "Ask Pat to play in goal",
      wants: null,
      fired: null,
      kind: "not-finished",
      text: "Ask Pat to play in goal is still in flight",
    });
    // One cause, so the card line is the cause itself.
    expect(reason.summary).toBe("Ask Pat to play in goal is still in flight");
    // Pat may yet reply. Nothing here is over.
    expect(reason.unreachable).toBe(false);
  });

  test("an unfinished task source reads as unfinished, an unanswered wait as unanswered", () => {
    const graph = graphAt();
    const ruling = reasonOf(graph, "wait-for-eligibility-ruling");
    expect(ruling.causes[0]?.text).toBe("Check Marcus is eligible has not finished yet");
    const goalie = reasonOf(graph, "goalie-confirmed");
    const texts = goalie.causes.map((cause) => cause.text);
    expect(texts).toContain("Wait for Pat has not answered yet");
    expect(texts).toContain("Wait for eligibility ruling has not answered yet");
  });

  test("a dropped source is named as dropped and never as a mismatch (§6.4)", () => {
    const graph = graphAt();
    const priya = nodeOf(graph, "wait-for-priya");
    expect(priya.status.state).toBe("dropped");
    expect(resolutionOf(priya)).toBe("bounced");
    const reason = reasonOf(graph, "goalie-confirmed");
    expect(reason.causes[0]).toEqual({
      from: "wait-for-priya",
      fromLabel: "Wait for Priya",
      wants: "satisfied",
      fired: "bounced",
      kind: "dropped",
      text: "Wait for Priya was dropped and can never satisfy this",
    });
  });

  test("dropped outranks the condition even when the condition matches", () => {
    // Priya's address bounced, so her wait resolved `bounced` and was dropped. Point the edge
    // at exactly that resolution: §6.4 still refuses it, because only `done` satisfies a
    // blocking edge, and the reader must be told the branch is dead rather than mismatched.
    const graph = graphAt();
    const index = edgeIndex(graph, "wait-for-priya", "goalie-confirmed");
    withEdge(graph, index, {
      from: "wait-for-priya",
      to: "goalie-confirmed",
      condition: { on: "bounced" },
    });
    const edge = graph.edges[index];
    if (edge === undefined) throw new Error("spliced edge vanished");
    expect(isEdgeSatisfied(graph, edge)).toBe(false);
    const cause = reasonOf(graph, "goalie-confirmed").causes[0];
    expect(cause?.kind).toBe("dropped");
    expect(cause?.wants).toBe("bounced");
    expect(cause?.fired).toBe("bounced");
  });

  test("causes come in edge order and count against every in-edge", () => {
    const graph = graphAt();
    const reason = reasonOf(graph, "goalie-confirmed");
    const unsatisfied = inEdges(graph, "goalie-confirmed")
      .filter((edge) => !isEdgeSatisfied(graph, edge))
      .map((edge) => edge.from);
    expect(reason.causes.map((cause) => cause.from)).toEqual(unsatisfied);
    expect(reason.causes.map((cause) => cause.from)).toEqual([
      "wait-for-priya",
      "wait-for-eligibility-ruling",
      "wait-for-pat",
    ]);
    // Three unmet of five in-edges: Dana's and Sam's declines both fired `satisfied`.
    expect(reason.summary).toBe("3 of 5 dependencies unmet");
  });

  test("one dead in-edge is already fatal: the quorum can never reach the frontier", () => {
    const graph = graphAt();
    const reason = reasonOf(graph, "goalie-confirmed");

    // Priya's wait is terminal and did not succeed, so `satisfiesBlockingEdge` refuses her
    // edge for the rest of the log — and `isReady` wants ALL five in-edges, so Pat and the
    // ruling coming good later cannot rescue it. `kona next` will never list this node.
    const priya = nodeOf(graph, "wait-for-priya");
    expect(isTerminal(priya.status.state)).toBe(true);
    expect(satisfiesBlockingEdge(priya)).toBe(false);
    expect(readyFrontier(graph).map((node) => node.id)).not.toContain("goalie-confirmed");

    // Two of the three blockers are still live, and that is exactly what does NOT matter:
    // reporting `false` here would paint an already-dead branch as merely waiting.
    expect(reason.causes.map((cause) => cause.kind)).toEqual([
      "dropped",
      "not-finished",
      "not-finished",
    ]);
    expect(reason.unreachable).toBe(true);
  });

  test("a status-only version changes the causes without changing the graph's shape", () => {
    // The step into Dana's refusal adds no node and no edge; she simply declines.
    const before = graphAt(V.danaDeclines - 1);
    const after = graphAt(V.danaDeclines);
    expect(after.edges).toEqual(before.edges);
    expect([...after.nodes.keys()]).toEqual([...before.nodes.keys()]);

    expect(readinessOf(before, nodeOf(before, "wait-for-dana"))).toBe("ready");
    expect(readinessOf(after, nodeOf(after, "wait-for-dana"))).toBe("settled");

    expect(reasonOf(before, "goalie-confirmed").causes.map((cause) => cause.from)).toEqual([
      "wait-for-dana",
      "wait-for-sam",
      "wait-for-priya",
    ]);
    // Dana declined, and `declined` maps to the resolution `satisfied` — the wait *was*
    // answered — so her edge drops out of the reason entirely.
    expect(reasonOf(after, "goalie-confirmed").causes.map((cause) => cause.from)).toEqual([
      "wait-for-sam",
      "wait-for-priya",
    ]);
    expect(reasonOf(after, "goalie-confirmed").summary).toBe("2 of 3 dependencies unmet");
  });
});

/**
 * Shapes the fixture cannot reach at head, built by changing exactly one thing about the real
 * folded graph. The wait engine and the outbox are not built yet (see `fixtures/README.md`),
 * so no committed version produces a mismatched resolution or a dangling edge — but the
 * classifier has to be right about them before the day it does, and `unreachable` is the
 * answer that matters most, because it is the one that silently hangs a pursuit.
 */
describe("blockedReason, on shapes the log has not produced yet", () => {
  test("a source that resolved something else is a mismatch, and it is permanent", () => {
    const graph = graphAt();
    const index = edgeIndex(graph, "wait-for-dana", "goalie-confirmed");
    withEdge(graph, index, {
      from: "wait-for-dana",
      to: "goalie-confirmed",
      condition: { on: "accept" },
    });
    const reason = reasonOf(graph, "goalie-confirmed");
    const cause = reason.causes.find((entry) => entry.from === "wait-for-dana");
    expect(cause).toEqual({
      from: "wait-for-dana",
      fromLabel: "Wait for Dana",
      wants: "accept",
      fired: "satisfied",
      kind: "wrong-resolution",
      text: "Wait for Dana answered satisfied, this edge needs accept",
    });
    expect(reason.summary).toBe("4 of 5 dependencies unmet");
    // §6.7 makes the resolving outcome first-wins, so Dana can never be traded for the
    // `accept` this edge now asks for: a second dead edge beside Priya's. Either one alone
    // strands the node, because readiness wants every in-edge.
    expect(reason.unreachable).toBe(true);
  });

  test("a mismatch strands the node even when it is the only unmet edge", () => {
    // Isolate the mismatch: hang Pat's wait off Dana's, which answered `satisfied`, and ask
    // that edge for `accept`. Nothing else is unmet, so `unreachable` is this cause alone.
    const graph = graphAt();
    const index = edgeIndex(graph, "ask-pat-to-play-in-goal", "wait-for-pat");
    withEdge(graph, index, {
      from: "wait-for-dana",
      to: "wait-for-pat",
      condition: { on: "accept" },
    });
    const reason = reasonOf(graph, "wait-for-pat");
    expect(reason.causes).toHaveLength(1);
    expect(reason.causes[0]?.kind).toBe("wrong-resolution");
    expect(reason.causes[0]?.fired).toBe("satisfied");
    expect(reason.unreachable).toBe(true);
  });

  test("a done source with no outcome yet is not dead: record_outcome is still legal", () => {
    // Finish Marcus's eligibility check with the store's own `set_status`. It is a task, so
    // it carries no outcome and `resolutionOf` is null — then ask its edge for a resolution
    // it has not fired YET. §6.4 keeps `record_outcome` legal against a terminal node, so
    // this edge may still come good; calling it dead would report a live pursuit as hung.
    const graph = applied(graphAt(), [
      {
        op: "set_status",
        node: "check-marcus-is-eligible",
        status: "done",
        evidence_ref: "roster.csv#v3",
      },
    ]);
    const source = nodeOf(graph, "check-marcus-is-eligible");
    expect(source.status.outcomes).toEqual([]);
    expect(resolutionOf(source)).toBeNull();

    const index = edgeIndex(graph, "check-marcus-is-eligible", "wait-for-eligibility-ruling");
    withEdge(graph, index, {
      from: "check-marcus-is-eligible",
      to: "wait-for-eligibility-ruling",
      condition: { on: "satisfied" },
    });

    const reason = reasonOf(graph, "wait-for-eligibility-ruling");
    expect(reason.causes).toEqual([
      {
        from: "check-marcus-is-eligible",
        fromLabel: "Check Marcus is eligible",
        wants: "satisfied",
        fired: null,
        kind: "wrong-resolution",
        text: "Check Marcus is eligible finished without a resolution, this edge needs satisfied",
      },
    ]);
    expect(reason.unreachable).toBe(false);
  });

  test("a failed source is the whole reason, and the node is unreachable", () => {
    const graph = graphAt();
    // Priya's send failed. Hang Pat's wait off it instead of Pat's own send.
    const index = edgeIndex(graph, "ask-pat-to-play-in-goal", "wait-for-pat");
    withEdge(graph, index, { from: "ask-priya-to-play-in-goal", to: "wait-for-pat" });
    const reason = reasonOf(graph, "wait-for-pat");
    expect(reason.causes).toHaveLength(1);
    expect(reason.causes[0]?.kind).toBe("failed");
    expect(reason.summary).toBe("Ask Priya to play in goal failed and can never satisfy this");
    expect(reason.unreachable).toBe(true);
  });

  test("an edge into a node that is not there names the id, since there is no label", () => {
    const graph = graphAt();
    graph.nodes.delete("ask-pat-to-play-in-goal");
    const reason = reasonOf(graph, "wait-for-pat");
    expect(reason.causes[0]).toEqual({
      from: "ask-pat-to-play-in-goal",
      fromLabel: "ask-pat-to-play-in-goal",
      wants: null,
      fired: null,
      kind: "missing",
      text: "ask-pat-to-play-in-goal is missing from the graph",
    });
    expect(reason.unreachable).toBe(true);
  });

  test("a superseded node that is still active reads as superseded, not as work to do", () => {
    const graph = graphAt();
    const node = nodeOf(graph, "check-marcus-is-eligible");
    expect(readinessOf(graph, node)).toBe("ready");
    graph.nodes.set(node.id, {
      ...node,
      provenance: { ...node.provenance, superseded_by: "escalate-no-goalie-found" },
    });
    const replaced = nodeOf(graph, "check-marcus-is-eligible");
    expect(replaced.status.state).toBe("active");
    expect(readinessOf(graph, replaced)).toBe("superseded");
    expect(blockedReason(graph, replaced)).toBeNull();
  });
});
