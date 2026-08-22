import { describe, expect, test } from "bun:test";
import {
  SCHEMA_VERSION,
  type CommittedOp,
  applyOps,
  emptyGraph,
  orderOps,
  validate,
} from "../src/index.ts";
import { ORCHESTRATOR, commit, seeded, task, wait } from "./fixtures.ts";

function committedOps(ops: Parameters<typeof commit>[1]): CommittedOp[] {
  const result = validate({
    graph: emptyGraph(SCHEMA_VERSION),
    ops,
    actor: ORCHESTRATOR,
    version: 1,
  });
  if (!result.ok) throw new Error(result.rejection.message);
  return result.value.ops;
}

function expectRefusal(result: ReturnType<typeof applyOps>, reason: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.rejection.reason).toBe(reason);
}

describe("add_node", () => {
  test("creates an active node stamped with the committing version", () => {
    const graph = seeded([task("Ask Dana")]);
    const node = graph.nodes.get("ask-dana");
    expect(node?.status.state).toBe("active");
    expect(node?.status.outcome).toBeNull();
    expect(node?.status.output).toBeNull();
    expect(node?.provenance.created_by_version).toBe(1);
    expect(node?.provenance.supersedes).toBeNull();
  });

  test("carries scope through to provenance.group", () => {
    const graph = seeded([{ ...task("Ask Dana"), scope: "goalies" } as never]);
    expect(graph.nodes.get("ask-dana")?.provenance.group).toBe("goalies");
  });

  test("refuses a duplicate id", () => {
    const graph = seeded([task("Ask Dana")]);
    const ops: CommittedOp[] = [
      { ...(committedOps([task("Ask Dana")])[0] as CommittedOp) },
    ];
    expectRefusal(applyOps(graph, ops, 2), "DUPLICATE_NODE_ID");
  });
});

describe("add_edge", () => {
  test("records that `to` requires `from`", () => {
    const graph = commit(seeded([task("A"), task("B")]), [
      { op: "add_edge", from: "a", to: "b" },
    ]);
    expect(graph.edges).toEqual([{ from: "a", to: "b" }]);
  });

  test("keeps the condition when one is given", () => {
    const graph = commit(seeded([task("A"), task("B")]), [
      { op: "add_edge", from: "a", to: "b", condition: { on: "accept" } },
    ]);
    expect(graph.edges[0]?.condition).toEqual({ on: "accept" });
  });

  test("refuses a self-edge — 'B requires B' has no reading", () => {
    const graph = seeded([task("A")]);
    expectRefusal(applyOps(graph, [{ op: "add_edge", from: "a", to: "a" }], 2), "SELF_EDGE");
  });

  test("refuses an endpoint that does not exist", () => {
    const graph = seeded([task("A")]);
    expectRefusal(applyOps(graph, [{ op: "add_edge", from: "a", to: "ghost" }], 2), "UNKNOWN_NODE");
    expectRefusal(applyOps(graph, [{ op: "add_edge", from: "ghost", to: "a" }], 2), "UNKNOWN_NODE");
  });

  test("refuses an exact duplicate, but allows two conditions between the same pair", () => {
    const graph = commit(seeded([task("A"), task("B")]), [
      { op: "add_edge", from: "a", to: "b", condition: { on: "accept" } },
    ]);
    const withDecline = commit(graph, [
      { op: "add_edge", from: "a", to: "b", condition: { on: "ignore" } },
    ]);
    expect(withDecline.edges).toHaveLength(2);
    expectRefusal(
      applyOps(withDecline, [{ op: "add_edge", from: "a", to: "b", condition: { on: "accept" } }], 3),
      "DUPLICATE_EDGE",
    );
  });
});

describe("the three observed fields answer three different questions", () => {
  test("set_status writes only where we are", () => {
    const graph = commit(seeded([task("A")]), [
      { op: "set_status", node: "a", status: "sending", evidence_ref: "ev-1" },
    ]);
    const node = graph.nodes.get("a");
    expect(node?.status.state).toBe("sending");
    expect(node?.status.outcome).toBeNull();
    expect(node?.status.output).toBeNull();
    expect(node?.status.observed_at_version).toBe(2);
  });

  test("record_outcome writes only what was decided", () => {
    const graph = commit(seeded([task("A")]), [
      { op: "record_outcome", node: "a", verdict: "declined", evidence_ref: "m-101", attrs: { role: "goalie" } },
    ]);
    const node = graph.nodes.get("a");
    expect(node?.status.outcome).toEqual({
      verdict: "declined",
      evidence_ref: "m-101",
      attrs: { role: "goalie" },
      at_version: 2,
    });
    expect(node?.status.outcomes).toHaveLength(1);
    expect(node?.status.state).toBe("active");
  });

  test("record_output writes only what was produced, keyed by declared name", () => {
    const graph = commit(seeded([task("A")]), [
      { op: "record_output", node: "a", output_name: "reply", value: "yes", evidence_ref: "m-101" },
    ]);
    expect(graph.nodes.get("a")?.status.output).toEqual({ reply: "yes" });
  });

  test("a second output merges rather than replacing", () => {
    const base = seeded([task("A", { outputs: [{ name: "reply", type: "string" }, { name: "note", type: "string" }] })]);
    const graph = commit(
      commit(base, [{ op: "record_output", node: "a", output_name: "reply", value: "yes", evidence_ref: "e1" }]),
      [{ op: "record_output", node: "a", output_name: "note", value: "late", evidence_ref: "e2" }],
    );
    expect(graph.nodes.get("a")?.status.output).toEqual({ reply: "yes", note: "late" });
  });

  test("refuses an output nobody declared — an unreferenceable value is an authoring error", () => {
    const graph = seeded([task("A")]);
    expectRefusal(
      applyOps(graph, [{ op: "record_output", node: "a", output_name: "ghost", value: 1, evidence_ref: "e" }], 2),
      "UNDECLARED_OUTPUT",
    );
  });

  test("every op refuses a node that does not exist", () => {
    const graph = seeded([task("A")]);
    for (const op of [
      { op: "set_status", node: "ghost", status: "done", evidence_ref: "e" },
      { op: "record_outcome", node: "ghost", verdict: "confirmed", evidence_ref: "e" },
      { op: "record_output", node: "ghost", output_name: "reply", value: 1, evidence_ref: "e" },
      { op: "supersede_node", node: "ghost" },
    ] as CommittedOp[]) {
      expectRefusal(applyOps(graph, [op], 2), "UNKNOWN_NODE");
    }
  });
});

describe("supersede_node — never delete", () => {
  test("an in-flight node stops being work", () => {
    const graph = commit(seeded([task("A")]), [{ op: "supersede_node", node: "a" }]);
    const node = graph.nodes.get("a");
    expect(node).toBeDefined();
    expect(node?.status.state).toBe("dropped");
    expect(node?.provenance.superseded_by).toBeNull();
  });

  test("a node that already ran keeps its terminal status — superseding does not un-send", () => {
    const done = commit(seeded([task("A")]), [
      { op: "set_status", node: "a", status: "done", evidence_ref: "e" },
    ]);
    const graph = commit(done, [{ op: "supersede_node", node: "a" }]);
    expect(graph.nodes.get("a")?.status.state).toBe("done");
  });

  test("wires provenance in both directions, replacement compensating the original", () => {
    const base = seeded([task("A")]);
    const graph = commit(base, [task("A prime"), { op: "supersede_node", node: "a", by: "$0" }]);
    expect(graph.nodes.get("a")?.provenance.superseded_by).toBe("a-prime");
    expect(graph.nodes.get("a-prime")?.provenance.supersedes).toBe("a");
  });

  test("refuses a self-supersede and an unknown replacement", () => {
    const graph = seeded([task("A")]);
    expectRefusal(applyOps(graph, [{ op: "supersede_node", node: "a", by: "a" }], 2), "SELF_SUPERSEDE");
    expectRefusal(applyOps(graph, [{ op: "supersede_node", node: "a", by: "ghost" }], 2), "UNKNOWN_NODE");
  });
});

describe("batch ordering", () => {
  test("cancellations run last, whatever order they were authored in", () => {
    const ops = committedOps([task("A"), wait("W")]);
    const cancel: CommittedOp = { op: "supersede_node", node: "a" };
    const ordered = orderOps([cancel, ...ops]);
    expect(ordered.map((entry) => entry.op.op)).toEqual(["add_node", "add_node", "supersede_node"]);
  });

  test("the authored index survives reordering, so errors name the right op", () => {
    const ops = committedOps([task("A"), wait("W")]);
    const ordered = orderOps([{ op: "supersede_node", node: "a" }, ...ops]);
    expect(ordered.map((entry) => entry.index)).toEqual([1, 2, 0]);
  });

  test("order within a class is authored order", () => {
    const ordered = orderOps(committedOps([task("A"), task("B"), task("C")]));
    expect(ordered.map((entry) => entry.index)).toEqual([0, 1, 2]);
  });
});

describe("applyOps never mutates its input", () => {
  test("head is untouched, which is what lets invariant 1 compare against it", () => {
    const graph = seeded([task("A")]);
    const before = JSON.stringify([...graph.nodes.values()]);
    const result = applyOps(graph, [{ op: "set_status", node: "a", status: "done", evidence_ref: "e" }], 2);
    expect(result.ok).toBe(true);
    expect(JSON.stringify([...graph.nodes.values()])).toBe(before);
    expect(graph.version).toBe(1);
  });

  test("edges added to the result do not appear in the input", () => {
    const graph = seeded([task("A"), task("B")]);
    applyOps(graph, [{ op: "add_edge", from: "a", to: "b" }], 2);
    expect(graph.edges).toHaveLength(0);
  });
});
