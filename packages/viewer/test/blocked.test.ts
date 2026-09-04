/**
 * Standing and blocked reasons, against the real pursuit.
 *
 * The assertions name fixture activities and fixture names on purpose. A test that restated the
 * implementation ("the first cause has kind `withdrawn`, because we return `withdrawn` first")
 * would survive any drift from `@kona/core`, which is the one drift that matters here: the
 * viewer must call an activity blocked exactly when `kona` refuses to dispatch it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { BehaviourNode, CommittedOp, Edge, Graph, ActivityNode } from "@kona/core";
import {
  applyOps,
  isBehaviourNode,
  foldLog,
  formatRejection,
  inEdges,
  isArmDead,
  isEdgeDead,
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

/** Any node, control included — for the tests that are ABOUT the control nodes. */
function anyNodeOf(graph: Graph, id: string): ActivityNode {
  const activity = graph.nodes.get(id);
  if (activity === undefined) throw new Error(`the fixture has no node ${id} at v${graph.version}`);
  return activity;
}

function nodeOf(graph: Graph, id: string): BehaviourNode {
  // Narrowed: every assertion here is about a status or an outcome, and a control node has
  // neither. Throwing names the mistake rather than letting `?.` compare two undefineds.
  const activity = graph.nodes.get(id);
  if (activity === undefined) throw new Error(`the fixture has no node ${id} at v${graph.version}`);
  if (activity.status === undefined) throw new Error(`${id} is a ${activity.type}: no status`);
  return activity;
}

/** The reason, or a throw — so a test that expected one cannot silently assert on null. */
function reasonOf(graph: Graph, id: string) {
  const activity = nodeOf(graph, id);
  const reason = blockedReason(graph, activity);
  if (reason === null) throw new Error(`${id} is ${readinessOf(activity)}, not blocked`);
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

  test("an unclaimed activity with no in-edges is ready", () => {
    const graph = graphAt();
    for (const id of ["th-vipt", "th-etsk", "th-five"]) {
      const activity = nodeOf(graph, id);
      // Nothing to wait on and nobody has claimed it, so the store recorded it on the
      // frontier: `ready` is a written state now, not something the viewer derives.
      expect(activity.status.state).toBe("ready");
      expect(inEdges(graph, id)).toHaveLength(0);
      expect(readinessOf(activity)).toBe("ready");
      expect(blockedReason(graph, activity)).toBeNull();
    }
  });

  test("superseded outranks the state: the roster step is completed, and reads as replaced", () => {
    const graph = graphAt();
    const activity = nodeOf(graph, "th-ahf6");
    expect(activity.status.state).toBe("completed");
    expect(activity.provenance.superseded_by).toBe("th-five");
    // The one value still derived here, and the only one that can disagree with `status.state`.
    expect(readinessOf(activity)).toBe("superseded");
  });

  test("each terminal state is reported as itself, not flattened into one word", () => {
    // `settled` used to cover all four at once, and the distinction it threw away is the one
    // a reader needs most: "we asked and it did not work" is not "the flow went elsewhere".
    const graph = graphAt();
    expect(nodeOf(graph, "th-es9m").status.state).toBe("completed");
    expect(readinessOf(nodeOf(graph, "th-es9m"))).toBe("completed");
    expect(nodeOf(graph, "th-t2yo").status.state).toBe("failed");
    expect(readinessOf(nodeOf(graph, "th-t2yo"))).toBe("failed");
    expect(nodeOf(graph, "th-1ppl").status.state).toBe("withdrawn");
    expect(readinessOf(nodeOf(graph, "th-1ppl"))).toBe("withdrawn");
  });

  test("a claimed activity reads `active`, which is not terminal — the world's answer is unknown", () => {
    const graph = graphAt();
    const activity = nodeOf(graph, "th-gk0l");
    expect(activity.status.state).toBe("active");
    expect(readinessOf(activity)).toBe("active");
    expect(blockedReason(graph, activity)).toBeNull();
  });

  test("th-ymld is `inactive` at head even though two of its waits fired satisfied", () => {
    const graph = graphAt();
    const activity = nodeOf(graph, "th-ymld");
    expect(inEdges(graph, "th-ymld")).toHaveLength(5);
    expect(resolutionOf(nodeOf(graph, "th-es9m"))).toBe("satisfied");
    expect(resolutionOf(nodeOf(graph, "th-ocwr"))).toBe("satisfied");
    // The predicate is `count{confirmed, role=goalie} >= 1`, but readiness is an edge
    // question, not a predicate one: `isReady` wants every in-edge satisfied — and the
    // commit agreed, which is why the state on the record is `inactive` and not `ready`.
    expect(isReady(graph, activity)).toBe(false);
    expect(activity.status.state).toBe("inactive");
    expect(readinessOf(activity)).toBe("inactive");
  });

  test("readinessOf agrees with readyFrontier at every version of the log", () => {
    for (let version = 1; version <= HEAD; version += 1) {
      const graph = graphAt(version);
      const ready = [...graph.nodes.values()]
        .filter((activity) => readinessOf(activity) === "ready")
        .map((activity) => activity.id);
      expect(ready).toEqual(readyFrontier(graph).map((activity) => activity.id));
    }
  });
});

describe("blockedReason", () => {
  test("null for anything that is not blocked", () => {
    const graph = graphAt();
    for (const activity of graph.nodes.values()) {
      if (readinessOf(activity) === "inactive") continue;
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
    expect(priya.status.state).toBe("withdrawn");
    expect(resolutionOf(priya)).toBe("bounced");
    const reason = reasonOf(graph, "th-ymld");
    expect(reason.causes[0]).toEqual({
      from: "th-1ppl",
      fromLabel: "Wait for Priya",
      wants: "satisfied",
      fired: "bounced",
      kind: "withdrawn",
      text: "Wait for Priya was dropped and can never satisfy this",
    });
  });

  test("dropped outranks the condition even when the condition matches", () => {
    // Priya's address bounced, so her wait resolved `bounced` and was dropped. Point the edge
    // at exactly that resolution: §6.4 still refuses it, because only `completed` satisfies a
    // blocking edge, and the reader must be told the branch is dead rather than mismatched.
    const graph = graphAt();
    const index = edgeIndex(graph, "th-1ppl", "th-ymld");
    withEdge(graph, index, {
      from: "th-1ppl",
      to: "th-ymld",
      guard: { on: "bounced" },
    });
    const edge = graph.edges[index];
    if (edge === undefined) throw new Error("spliced edge vanished");
    expect(isEdgeSatisfied(graph, edge)).toBe(false);
    const cause = reasonOf(graph, "th-ymld").causes[0];
    expect(cause?.kind).toBe("withdrawn");
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
    expect(reason.causes.map((cause) => cause.from)).toEqual(["th-1ppl", "th-9xi1", "th-0s7c"]);
    // Three unmet of five in-edges: Dana's and Sam's declines both fired `satisfied`.
    expect(reason.summary).toBe("3 of 5 dependencies unmet");
  });

  test("a dropped in-edge is a cause, and is excluded from the readiness that judges it", () => {
    const graph = graphAt();
    const reason = reasonOf(graph, "th-ymld");

    // Priya's wait is terminal and did not succeed, so `satisfiesBlockingEdge` refuses her
    // edge for the rest of the log, and the reader is told exactly that.
    const priya = nodeOf(graph, "th-1ppl");
    expect(isTerminal(priya.status.state)).toBe(true);
    expect(satisfiesBlockingEdge(priya)).toBe(false);
    expect(readyFrontier(graph).map((activity) => activity.id)).not.toContain("th-ymld");
    expect(reason.causes.map((cause) => cause.kind)).toEqual([
      "withdrawn",
      "not-finished",
      "not-finished",
    ]);

    // And the quorum is still NOT over — which is the assertion that changed. §6.4 excludes a
    // dropped in-edge from merge evaluation ("it neither satisfies nor blocks") and `isReady`
    // implements the exclusion, so the two live arms coming good is enough. This used to
    // report `unreachable`, which is the opposite of the silent hang the field names: it
    // painted a pursuit `kona` is still driving as one that had already stopped.
    expect(reason.unreachable).toBe(false);
    const answered = applied(graph, [
      { op: "set_status", node: "th-gk0l", status: "completed", evidence_ref: "mail:m-301" },
      { op: "record_outcome", node: "th-0s7c", verdict: "confirmed", evidence_ref: "mail:m-302" },
      { op: "set_status", node: "th-0s7c", status: "completed", evidence_ref: "mail:m-302" },
      { op: "set_status", node: "th-etsk", status: "completed", evidence_ref: "roster.csv#v3" },
      { op: "record_outcome", node: "th-9xi1", verdict: "accept", evidence_ref: "mail:m-303" },
      { op: "set_status", node: "th-9xi1", status: "completed", evidence_ref: "mail:m-303" },
    ]);
    expect(isReady(answered, nodeOf(answered, "th-ymld"))).toBe(true);
  });

  test("a status-only version changes the causes without changing the graph's shape", () => {
    // The step into Dana's refusal adds no activity and no edge; she simply declines.
    const before = graphAt(V.danaDeclines - 1);
    const after = graphAt(V.danaDeclines);
    expect(after.edges).toEqual(before.edges);
    expect([...after.nodes.keys()]).toEqual([...before.nodes.keys()]);

    expect(readinessOf(nodeOf(before, "th-es9m"))).toBe("ready");
    expect(readinessOf(nodeOf(after, "th-es9m"))).toBe("completed");

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
      guard: { on: "accept" },
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
      guard: { on: "accept" },
    });
    const reason = reasonOf(graph, "th-0s7c");
    expect(reason.causes).toHaveLength(1);
    expect(reason.causes[0]?.kind).toBe("wrong-resolution");
    expect(reason.causes[0]?.fired).toBe("satisfied");
    expect(reason.unreachable).toBe(true);
  });

  test("a completed source with no outcome yet is not dead: record_outcome is still legal", () => {
    // Finish Marcus's eligibility check with the store's own `set_status`. It is a task, so
    // it carries no outcome and `resolutionOf` is null — then ask its edge for a resolution
    // it has not fired YET. §6.4 keeps `record_outcome` legal against a terminal activity, so
    // this edge may still come good; calling it dead would report a live pursuit as hung.
    const graph = applied(graphAt(), [
      {
        op: "set_status",
        node: "th-etsk",
        status: "completed",
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
      guard: { on: "satisfied" },
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

  test("a failed source parks the branch, and rule 5 keeps it out of `unreachable`", () => {
    const graph = graphAt();
    // Priya's send failed. Hang Pat's wait off it instead of Pat's own send.
    const index = edgeIndex(graph, "th-gk0l", "th-0s7c");
    withEdge(graph, index, { from: "th-t2yo", to: "th-0s7c" });
    const reason = reasonOf(graph, "th-0s7c");
    expect(reason.causes).toHaveLength(1);
    expect(reason.causes[0]?.kind).toBe("failed");
    // The text is unchanged, and it is the half a reader acts on: this can never satisfy.
    expect(reason.summary).toBe("Ask Priya to play in goal failed and can never satisfy this");

    // `unreachable` is the store's word for a branch it has RESOLVED AWAY, and it deliberately
    // does not resolve this one — §6.4 rule 5, "a `failed` source is not unreachable", so that
    // the subtree stalls loudly under a visibly failed node instead of being deleted under
    // somebody who is about to repair it. Reporting `true` would disagree with `isEdgeDead`,
    // which is the authority the cascade in `branch.ts` withdraws on.
    const edge = graph.edges[index];
    if (edge === undefined) throw new Error("spliced edge vanished");
    expect(isEdgeDead(graph, edge)).toBe(false);
    expect(reason.unreachable).toBe(false);
  });

  test("an edge into an activity that is not there names the id, since there is no name", () => {
    const graph = graphAt();
    graph.nodes.delete("th-gk0l");
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

  test("a superseded activity that is still ready reads as superseded, not as work to do", () => {
    const graph = graphAt();
    const activity = nodeOf(graph, "th-etsk");
    expect(readinessOf(activity)).toBe("ready");
    graph.nodes.set(activity.id, {
      ...activity,
      provenance: { ...activity.provenance, superseded_by: "th-vipt" },
    });
    const replaced = nodeOf(graph, "th-etsk");
    // Not terminal and dispatchable — supersede outranks a live frontier activity.
    expect(replaced.status.state).toBe("ready");
    expect(readinessOf(replaced)).toBe("superseded");
    expect(blockedReason(graph, replaced)).toBeNull();
  });
});

/**
 * The activity model, against `fixtures/goalie.*` — the pursuit in the nine-type vocabulary.
 *
 * These shapes cannot be written in `thursday.*` at all: under §6.2's arity an `action` has
 * exactly one in-edge, so every convergence goes through a `merge` or a `join`, and the
 * immediate source of a blocked node is a control node with no status and no story. The whole
 * point of this block is that none of the answers below name one.
 *
 * The loader is local rather than in `fixture.ts` because that module's subject is the v1
 * pursuit twelve other test files assert against; `goalie.*` is this file's business until the
 * version bump deletes the other one (see `fixtures/README.md`).
 */
const GOALIE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fixtures",
  "goalie.mutations.jsonl",
);

/** v3 plans, v5 supersedes the pitch booking, v9 Dana goes quiet, v12 Pat does too. */
function goalieAt(version?: number): Graph {
  const text = readFileSync(GOALIE, "utf8");
  return foldLog(text, version === undefined ? {} : { upToVersion: version }).graph;
}

describe("blockedReason, through the control nodes", () => {
  test("the blocked action's own in-edge is a join, and no cause names it", () => {
    const graph = goalieAt(11);
    const roster = nodeOf(graph, "gk-2jac");
    const ins = inEdges(graph, "gk-2jac");

    // S7: exactly one in-edge, and it comes from a node that carries no status at all. This is
    // the shape that made the old answer useless — "Goalie and pitch both in has not finished
    // yet" is a sentence about a bar in a diagram.
    expect(ins).toHaveLength(1);
    const above = anyNodeOf(graph, ins[0]?.from ?? "");
    expect(above.type).toBe("join");
    expect(isBehaviourNode(above.type)).toBe(false);

    const reason = reasonOf(graph, "gk-2jac");
    expect(reason.causes.map((cause) => cause.from)).toEqual(["gk-hq6s", "gk-4d8d", "gk-m9pm"]);
    for (const cause of reason.causes) {
      expect(isBehaviourNode(nodeOf(graph, cause.from).type)).toBe(true);
    }
    // Four behaviour dependencies beneath the join — two replies, escalation and the pitch —
    // so the denominator counts what the walk reaches, not the one in-edge it started from.
    expect(reason.summary).toBe("3 of 4 dependencies unmet");
    expect(readinessOf(roster)).toBe("inactive");
  });

  test("a decision's untaken arm is reported against the wait that routed it", () => {
    const graph = goalieAt(9);
    // Dana never answered, so her `accept_event` closed `timed_out` and the decision took its
    // else arm toward escalation. What a reader needs is Dana, the guard the arm wanted, and
    // what she actually said — none of which is on the diamond.
    expect(anyNodeOf(graph, "gk-jkgu").type).toBe("decision");
    const reason = reasonOf(graph, "gk-2jac");
    expect(reason.causes[0]).toEqual({
      from: "gk-hq6s",
      fromLabel: "Dana replies",
      wants: "satisfied",
      fired: "timeout",
      kind: "wrong-resolution",
      text: "Dana replies answered timeout, this edge needs satisfied",
    });
    // Pat is still live two hops up the other arm, and reads as a wait rather than a task.
    expect(reason.causes[1]?.text).toBe("Pat replies has not answered yet");
  });

  test("a superseded arm is neither a cause nor a dependency", () => {
    // v3 supersedes `Book the pitch` with `Confirm the pitch in writing`; the old node keeps
    // its edge into the join, because nothing is ever deleted. Counting it would report a
    // permanently unsatisfiable arm on a join the store considers perfectly live (D5).
    const graph = goalieAt(5);
    const stopped = nodeOf(graph, "gk-13vf");
    expect(stopped.provenance.superseded_by).toBe("gk-0x1a");
    expect(inEdges(graph, "gk-qil6").map((edge) => edge.from)).toContain("gk-13vf");

    const reason = reasonOf(graph, "gk-2jac");
    expect(reason.causes.map((cause) => cause.from)).toEqual([
      "gk-hq6s",
      "gk-4d8d",
      "gk-m9pm",
      "gk-0x1a",
    ]);
    expect(reason.summary).toBe("4 of 4 dependencies unmet");
    expect(reason.unreachable).toBe(false);
  });

  test("the timeout recovery path keeps the roster lock unavailable", () => {
    const graph = goalieAt(12);
    expect(nodeOf(graph, "gk-2jac").status.state).toBe("inactive");
    expect(nodeOf(graph, "gk-m9pm").status.state).toBe("ready");

    const reason = reasonOf(graph, "gk-2jac");
    expect(isArmDead(graph, "gk-2jac")).toBe(false);
    expect(reason.unreachable).toBe(false);
    expect(reason.causes.map((cause) => cause.from)).toEqual(["gk-hq6s", "gk-4d8d", "gk-m9pm"]);
  });

  test("a join under a failed arm is parked, and says so with the failed node named", () => {
    // §6.10 rule 11. The pitch confirmation fails while both goalies are still live: the join
    // is stalled forever by design (§6.4 rule 5), and `2 of 3 dependencies unmet` would be a
    // true sentence that reads exactly like a join which is merely waiting.
    const graph = applied(goalieAt(5), [
      { op: "set_status", node: "gk-0x1a", status: "failed", evidence_ref: "mail:550-bounce" },
    ]);
    const reason = reasonOf(graph, "gk-2jac");
    expect(reason.summary).toBe(
      "Goalie and pitch both in can never complete — " +
        "Confirm the pitch in writing failed and can never satisfy this",
    );
    expect(reason.causes.map((cause) => cause.kind)).toEqual([
      "not-finished",
      "not-finished",
      "not-finished",
      "failed",
    ]);
    // Parked is not unreachable: the store keeps the branch for whoever repairs the send.
    expect(isArmDead(graph, "gk-2jac")).toBe(false);
    expect(reason.unreachable).toBe(false);
  });

  test("an abandoned join input is excluded rather than reported unreachable", () => {
    // The same shape as the parked join, with the one difference §6.2 insists on: "we stopped
    // wanting this" is not "tried, didn't work". `terminated` is abandonment, so the arm is
    // dead, so the join is dead, so the roster is on an arm the cascade would withdraw.
    const graph = applied(goalieAt(5), [
      { op: "set_status", node: "gk-0x1a", status: "terminated", evidence_ref: "local:pulled" },
    ]);
    const reason = reasonOf(graph, "gk-2jac");
    expect(reason.causes.find((cause) => cause.from === "gk-0x1a")).toEqual({
      from: "gk-0x1a",
      fromLabel: "Confirm the pitch in writing",
      wants: null,
      fired: null,
      kind: "withdrawn",
      text: "Confirm the pitch in writing was stopped before it finished and can never satisfy this",
    });
    expect(isArmDead(graph, "gk-2jac")).toBe(false);
    expect(reason.parked).toBe(true);
    expect(reason.unreachable).toBe(false);
  });

  test("the join glyph can be asked the same question, and gives the join's own answer", () => {
    // Rule 4's control clause wants *k of n arms satisfied* on the bar itself. It is the same
    // walk, and the superseded arm is excluded from it exactly as core's `controlSatisfied`
    // excludes it — one of three arms in, two still owed.
    const graph = goalieAt(11);
    const reason = blockedReason(graph, anyNodeOf(graph, "gk-qil6"));
    expect(reason?.causes.map((cause) => cause.from)).toEqual(["gk-hq6s", "gk-4d8d", "gk-m9pm"]);
    expect(reason?.summary).toBe("3 of 4 dependencies unmet");
    expect(reason?.unreachable).toBe(false);
  });

  test("nothing unmet and not yet `ready` is reported as the log fact it is", () => {
    // Readiness is derived at commit (§6.2.1), so `applyOps` alone leaves Dana's wait
    // `inactive` behind a satisfied in-edge. Answering with `0 of 1 dependencies unmet` would
    // read as a bug in the viewer rather than as a statement about the log.
    const graph = applied(goalieAt(7), [
      { op: "set_status", node: "gk-oyp9", status: "completed", evidence_ref: "mail:m-201" },
    ]);
    const reason = reasonOf(graph, "gk-hq6s");
    expect(reason.causes).toEqual([]);
    expect(reason.summary).toBe("no unmet dependency — the store has not lifted this to ready");
    expect(reason.unreachable).toBe(false);
  });
});
