/**
 * Readiness and blocked reasons, against the real pursuit.
 *
 * The assertions name fixture activities and fixture labels on purpose. A test that restated the
 * implementation ("the first cause has kind `dropped`, because we return `dropped` first")
 * would survive any drift from `@kona/core`, which is the one drift that matters here: the
 * viewer must call an activity blocked exactly when `kona` refuses to dispatch it.
 */

import { describe, expect, test } from "bun:test";
import type { CommittedOp, Edge, Graph, Activity } from "@kona/core";
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

function nodeOf(graph: Graph, id: string): Activity {
  const activity = graph.activities.get(id);
  if (activity === undefined) throw new Error(`the fixture has no activity ${id} at v${graph.version}`);
  return activity;
}

/** The reason, or a throw — so a test that expected one cannot silently assert on null. */
function reasonOf(graph: Graph, id: string) {
  const activity = nodeOf(graph, id);
  const reason = blockedReason(graph, activity);
  if (reason === null) throw new Error(`${id} is ${readinessOf(graph, activity)}, not blocked`);
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
 * Move the graph on with the store's own ops rather than by writing an activity literal, so the
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

  test("an active activity with no in-edges is ready", () => {
    const graph = graphAt();
    for (const id of [
      "th-vipt",
      "th-etsk",
      "th-five",
    ]) {
      const activity = nodeOf(graph, id);
      expect(activity.status.state).toBe("active");
      expect(inEdges(graph, id)).toHaveLength(0);
      expect(readinessOf(graph, activity)).toBe("ready");
      expect(blockedReason(graph, activity)).toBeNull();
    }
  });

  test("superseded outranks settled: the roster step is done, and reads as replaced", () => {
    const graph = graphAt();
    const activity = nodeOf(graph, "th-ahf6");
    expect(activity.status.state).toBe("done");
    expect(activity.provenance.superseded_by).toBe("th-five");
    expect(readinessOf(graph, activity)).toBe("superseded");
  });

  test("every terminal status settles, including the two that never satisfy anything", () => {
    const graph = graphAt();
    expect(readinessOf(graph, nodeOf(graph, "th-es9m"))).toBe("settled");
    expect(nodeOf(graph, "th-t2yo").status.state).toBe("failed");
    expect(readinessOf(graph, nodeOf(graph, "th-t2yo"))).toBe("settled");
    expect(nodeOf(graph, "th-1ppl").status.state).toBe("dropped");
    expect(readinessOf(graph, nodeOf(graph, "th-1ppl"))).toBe("settled");
  });

  test("sending is running, not settled — the world's answer is unknown", () => {
    const graph = graphAt();
    const activity = nodeOf(graph, "th-gk0l");
    expect(activity.status.state).toBe("in_flight");
    expect(readinessOf(graph, activity)).toBe("running");
    expect(blockedReason(graph, activity)).toBeNull();
  });

  test("th-ymld is blocked at head even though two of its waits fired satisfied", () => {
    const graph = graphAt();
    const activity = nodeOf(graph, "th-ymld");
    expect(activity.status.state).toBe("active");
    expect(inEdges(graph, "th-ymld")).toHaveLength(5);
    expect(resolutionOf(nodeOf(graph, "th-es9m"))).toBe("satisfied");
    expect(resolutionOf(nodeOf(graph, "th-ocwr"))).toBe("satisfied");
    // The predicate is `count{confirmed, role=goalie} >= 1`, but readiness is an edge
    // question, not a predicate one: `isReady` wants every in-edge satisfied.
    expect(isReady(graph, activity)).toBe(false);
    expect(readinessOf(graph, activity)).toBe("blocked");
  });

  test("readinessOf agrees with readyFrontier at every version of the log", () => {
    for (let version = 1; version <= HEAD; version += 1) {
      const graph = graphAt(version);
      const ready = [...graph.activities.values()]
        .filter((activity) => readinessOf(graph, activity) === "ready")
        .map((activity) => activity.id);
      expect(ready).toEqual(readyFrontier(graph).map((activity) => activity.id));
    }
  });
});

describe("blockedReason", () => {
  test("null for anything that is not blocked", () => {
    const graph = graphAt();
    for (const activity of graph.activities.values()) {
      if (readinessOf(graph, activity) === "blocked") continue;
      expect(blockedReason(graph, activity)).toBeNull();
    }
  });

  test("a source still in flight: th-0s7c behind Pat's open reservation", () => {
    // The fixture's ending, and the state rule 8's third colour exists for: the slot is
    // fsynced, the bytes may or may not have moved, and nothing downstream may proceed.
    const graph = graphAt(V.patReserved);
    const reason = reasonOf(graph, "th-0s7c");
    expect(reason.causes).toHaveLength(1);
    expect(reason.causes[0]).toEqual({
      from: "th-gk0l",
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
    const ruling = reasonOf(graph, "th-9xi1");
    expect(ruling.causes[0]?.text).toBe("Check Marcus is eligible has not finished yet");
    const goalie = reasonOf(graph, "th-ymld");
    const texts = goalie.causes.map((cause) => cause.text);
    expect(texts).toContain("Wait for Pat has not answered yet");
    expect(texts).toContain("Wait for eligibility ruling has not answered yet");
  });

  test("a dropped source is named as dropped and never as a mismatch (§6.4)", () => {
    const graph = graphAt();
    const priya = nodeOf(graph, "th-1ppl");
    expect(priya.status.state).toBe("dropped");
    expect(resolutionOf(priya)).toBe("bounced");
    const reason = reasonOf(graph, "th-ymld");
    expect(reason.causes[0]).toEqual({
      from: "th-1ppl",
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
    const index = edgeIndex(graph, "th-1ppl", "th-ymld");
    withEdge(graph, index, {
      from: "th-1ppl",
      to: "th-ymld",
      condition: { on: "bounced" },
    });
    const edge = graph.edges[index];
    if (edge === undefined) throw new Error("spliced edge vanished");
    expect(isEdgeSatisfied(graph, edge)).toBe(false);
    const cause = reasonOf(graph, "th-ymld").causes[0];
    expect(cause?.kind).toBe("dropped");
    expect(cause?.wants).toBe("bounced");
    expect(cause?.fired).toBe("bounced");
  });

  test("causes come in edge order and count against every in-edge", () => {
    const graph = graphAt();
    const reason = reasonOf(graph, "th-ymld");
    const unsatisfied = inEdges(graph, "th-ymld")
      .filter((edge) => !isEdgeSatisfied(graph, edge))
      .map((edge) => edge.from);
    expect(reason.causes.map((cause) => cause.from)).toEqual(unsatisfied);
    expect(reason.causes.map((cause) => cause.from)).toEqual([
      "th-1ppl",
      "th-9xi1",
      "th-0s7c",
    ]);
    // Three unmet of five in-edges: Dana's and Sam's declines both fired `satisfied`.
    expect(reason.summary).toBe("3 of 5 dependencies unmet");
  });

  test("one dead in-edge is already fatal: the quorum can never reach the frontier", () => {
    const graph = graphAt();
    const reason = reasonOf(graph, "th-ymld");

    // Priya's wait is terminal and did not succeed, so `satisfiesBlockingEdge` refuses her
    // edge for the rest of the log — and `isReady` wants ALL five in-edges, so Pat and the
    // ruling coming good later cannot rescue it. `kona next` will never list this activity.
    const priya = nodeOf(graph, "th-1ppl");
    expect(isTerminal(priya.status.state)).toBe(true);
    expect(satisfiesBlockingEdge(priya)).toBe(false);
    expect(readyFrontier(graph).map((activity) => activity.id)).not.toContain("th-ymld");

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
    // The step into Dana's refusal adds no activity and no edge; she simply declines.
    const before = graphAt(V.danaDeclines - 1);
    const after = graphAt(V.danaDeclines);
    expect(after.edges).toEqual(before.edges);
    expect([...after.activities.keys()]).toEqual([...before.activities.keys()]);

    expect(readinessOf(before, nodeOf(before, "th-es9m"))).toBe("ready");
    expect(readinessOf(after, nodeOf(after, "th-es9m"))).toBe("settled");

    expect(reasonOf(before, "th-ymld").causes.map((cause) => cause.from)).toEqual([
      "th-es9m",
      "th-ocwr",
      "th-1ppl",
    ]);
    // Dana declined, and `declined` maps to the resolution `satisfied` — the wait *was*
    // answered — so her edge drops out of the reason entirely.
    expect(reasonOf(after, "th-ymld").causes.map((cause) => cause.from)).toEqual([
      "th-ocwr",
      "th-1ppl",
    ]);
    expect(reasonOf(after, "th-ymld").summary).toBe("2 of 3 dependencies unmet");
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
    const index = edgeIndex(graph, "th-es9m", "th-ymld");
    withEdge(graph, index, {
      from: "th-es9m",
      to: "th-ymld",
      condition: { on: "accept" },
    });
    const reason = reasonOf(graph, "th-ymld");
    const cause = reason.causes.find((entry) => entry.from === "th-es9m");
    expect(cause).toEqual({
      from: "th-es9m",
      fromLabel: "Wait for Dana",
      wants: "accept",
      fired: "satisfied",
      kind: "wrong-resolution",
      text: "Wait for Dana answered satisfied, this edge needs accept",
    });
    expect(reason.summary).toBe("4 of 5 dependencies unmet");
    // §6.7 makes the resolving outcome first-wins, so Dana can never be traded for the
    // `accept` this edge now asks for: a second dead edge beside Priya's. Either one alone
    // strands the activity, because readiness wants every in-edge.
    expect(reason.unreachable).toBe(true);
  });

  test("a mismatch strands the activity even when it is the only unmet edge", () => {
    // Isolate the mismatch: hang Pat's wait off Dana's, which answered `satisfied`, and ask
    // that edge for `accept`. Nothing else is unmet, so `unreachable` is this cause alone.
    const graph = graphAt();
    const index = edgeIndex(graph, "th-gk0l", "th-0s7c");
    withEdge(graph, index, {
      from: "th-es9m",
      to: "th-0s7c",
      condition: { on: "accept" },
    });
    const reason = reasonOf(graph, "th-0s7c");
    expect(reason.causes).toHaveLength(1);
    expect(reason.causes[0]?.kind).toBe("wrong-resolution");
    expect(reason.causes[0]?.fired).toBe("satisfied");
    expect(reason.unreachable).toBe(true);
  });

  test("a done source with no outcome yet is not dead: record_outcome is still legal", () => {
    // Finish Marcus's eligibility check with the store's own `set_status`. It is a task, so
    // it carries no outcome and `resolutionOf` is null — then ask its edge for a resolution
    // it has not fired YET. §6.4 keeps `record_outcome` legal against a terminal activity, so
    // this edge may still come good; calling it dead would report a live pursuit as hung.
    const graph = applied(graphAt(), [
      {
        op: "set_status",
        activity: "th-etsk",
        status: "done",
        evidence_ref: "roster.csv#v3",
      },
    ]);
    const source = nodeOf(graph, "th-etsk");
    expect(source.status.outcomes).toEqual([]);
    expect(resolutionOf(source)).toBeNull();

    const index = edgeIndex(graph, "th-etsk", "th-9xi1");
    withEdge(graph, index, {
      from: "th-etsk",
      to: "th-9xi1",
      condition: { on: "satisfied" },
    });

    const reason = reasonOf(graph, "th-9xi1");
    expect(reason.causes).toEqual([
      {
        from: "th-etsk",
        fromLabel: "Check Marcus is eligible",
        wants: "satisfied",
        fired: null,
        kind: "wrong-resolution",
        text: "Check Marcus is eligible finished without a resolution, this edge needs satisfied",
      },
    ]);
    expect(reason.unreachable).toBe(false);
  });

  test("a failed source is the whole reason, and the activity is unreachable", () => {
    const graph = graphAt();
    // Priya's send failed. Hang Pat's wait off it instead of Pat's own send.
    const index = edgeIndex(graph, "th-gk0l", "th-0s7c");
    withEdge(graph, index, { from: "th-t2yo", to: "th-0s7c" });
    const reason = reasonOf(graph, "th-0s7c");
    expect(reason.causes).toHaveLength(1);
    expect(reason.causes[0]?.kind).toBe("failed");
    expect(reason.summary).toBe("Ask Priya to play in goal failed and can never satisfy this");
    expect(reason.unreachable).toBe(true);
  });

  test("an edge into an activity that is not there names the id, since there is no label", () => {
    const graph = graphAt();
    graph.activities.delete("th-gk0l");
    const reason = reasonOf(graph, "th-0s7c");
    expect(reason.causes[0]).toEqual({
      from: "th-gk0l",
      fromLabel: "th-gk0l",
      wants: null,
      fired: null,
      kind: "missing",
      text: "th-gk0l is missing from the graph",
    });
    expect(reason.unreachable).toBe(true);
  });

  test("a superseded activity that is still active reads as superseded, not as work to do", () => {
    const graph = graphAt();
    const activity = nodeOf(graph, "th-etsk");
    expect(readinessOf(graph, activity)).toBe("ready");
    graph.activities.set(activity.id, {
      ...activity,
      provenance: { ...activity.provenance, superseded_by: "th-vipt" },
    });
    const replaced = nodeOf(graph, "th-etsk");
    expect(replaced.status.state).toBe("active");
    expect(readinessOf(graph, replaced)).toBe("superseded");
    expect(blockedReason(graph, replaced)).toBeNull();
  });
});
