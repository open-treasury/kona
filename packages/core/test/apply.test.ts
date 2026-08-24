import { describe, expect, test } from "bun:test";
import {
  SCHEMA_VERSION,
  type CommittedOp,
  applyOps,
  emptyGraph,
  orderOps,
  validate,
} from "../src/index.ts";
import { ORCHESTRATOR, commit, seeded, task, wait, activityAt, slugOf, resolveSlugs, nid } from "./fixtures.ts";

function committedOps(ops: Parameters<typeof commit>[1]): CommittedOp[] {
  const result = validate({
    graph: emptyGraph(SCHEMA_VERSION),
    ops,
    actor: ORCHESTRATOR,
    prefix: "t",
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

describe("add_activity", () => {
  test("creates an active activity stamped with the committing version", () => {
    const graph = seeded([task("Ask Dana")]);
    const activity = activityAt(graph, "ask-dana");
    expect(activity?.status.state).toBe("active");
    expect(activity?.status.outcome).toBeNull();
    expect(activity?.status.output).toBeNull();
    expect(activity?.provenance.created_by_version).toBe(1);
    expect(slugOf(activity?.provenance.supersedes)).toBeNull();
  });

  test("carries scope through to provenance.group", () => {
    const graph = seeded([{ ...task("Ask Dana"), scope: "goalies" } as never]);
    expect(activityAt(graph, "ask-dana")?.provenance.group).toBe("goalies");
  });

  test("refuses a duplicate id", () => {
    const graph = seeded([task("Ask Dana")]);
    const ops: CommittedOp[] = [
      { ...(committedOps([task("Ask Dana")])[0] as CommittedOp) },
    ];
    expectRefusal(applyOps(graph, resolveSlugs(graph, ops) as CommittedOp[], 2), "DUPLICATE_ACTIVITY_ID");
  });
});

describe("add_edge", () => {
  test("records that `to` requires `from`", () => {
    const graph = commit(seeded([task("A"), task("B")]), [
      { op: "add_edge", from: "a", to: "b" },
    ]);
    expect(graph.edges).toEqual([{ from: nid(graph, "a"), to: nid(graph, "b") }]);
  });

  test("keeps the condition when one is given", () => {
    const graph = commit(seeded([task("A"), task("B")]), [
      { op: "add_edge", from: "a", to: "b", condition: { on: "accept" } },
    ]);
    expect(graph.edges[0]?.condition).toEqual({ on: "accept" });
  });

  test("refuses a self-edge — 'B requires B' has no reading", () => {
    const graph = seeded([task("A")]);
    expectRefusal(applyOps(graph, resolveSlugs(graph, [{ op: "add_edge", from: "a", to: "a" }]) as CommittedOp[], 2), "SELF_EDGE");
  });

  test("refuses an endpoint that does not exist", () => {
    const graph = seeded([task("A")]);
    expectRefusal(applyOps(graph, resolveSlugs(graph, [{ op: "add_edge", from: "a", to: "ghost" }]) as CommittedOp[], 2), "UNKNOWN_ACTIVITY");
    expectRefusal(applyOps(graph, resolveSlugs(graph, [{ op: "add_edge", from: "ghost", to: "a" }]) as CommittedOp[], 2), "UNKNOWN_ACTIVITY");
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
      applyOps(withDecline, resolveSlugs(withDecline, [{ op: "add_edge", from: "a", to: "b", condition: { on: "accept" } }]) as CommittedOp[], 3),
      "DUPLICATE_EDGE",
    );
  });
});

describe("the three observed fields answer three different questions", () => {
  test("set_status writes only where we are", () => {
    const graph = commit(seeded([task("A")]), [
      { op: "set_status", activity: "a", status: "in_flight", evidence_ref: "ev-1" },
    ]);
    const activity = activityAt(graph, "a");
    expect(activity?.status.state).toBe("in_flight");
    expect(activity?.status.outcome).toBeNull();
    expect(activity?.status.output).toBeNull();
    expect(activity?.status.observed_at_version).toBe(2);
  });

  test("record_outcome writes only what was decided", () => {
    const graph = commit(seeded([task("A")]), [
      { op: "record_outcome", activity: "a", verdict: "declined", evidence_ref: "m-101", attrs: { role: "goalie" } },
    ]);
    const activity = activityAt(graph, "a");
    expect(activity?.status.outcome).toEqual({
      verdict: "declined",
      evidence_ref: "m-101",
      attrs: { role: "goalie" },
      at_version: 2,
    });
    expect(activity?.status.outcomes).toHaveLength(1);
    expect(activity?.status.state).toBe("active");
  });

  test("record_output writes only what was produced, keyed by declared name", () => {
    const graph = commit(seeded([task("A")]), [
      { op: "record_output", activity: "a", output_name: "reply", value: "yes", evidence_ref: "m-101" },
    ]);
    expect(activityAt(graph, "a")?.status.output).toEqual({ reply: "yes" });
  });

  test("a second output merges rather than replacing", () => {
    const base = seeded([task("A", { outputs: [{ name: "reply", type: "string" }, { name: "note", type: "string" }] })]);
    const graph = commit(
      commit(base, [{ op: "record_output", activity: "a", output_name: "reply", value: "yes", evidence_ref: "e1" }]),
      [{ op: "record_output", activity: "a", output_name: "note", value: "late", evidence_ref: "e2" }],
    );
    expect(activityAt(graph, "a")?.status.output).toEqual({ reply: "yes", note: "late" });
  });

  test("refuses an output nobody declared — an unreferenceable value is an authoring error", () => {
    const graph = seeded([task("A")]);
    expectRefusal(
      applyOps(graph, resolveSlugs(graph, [{ op: "record_output", activity: "a", output_name: "ghost", value: 1, evidence_ref: "e" }]) as CommittedOp[], 2),
      "UNDECLARED_OUTPUT",
    );
  });

  test("every op refuses an activity that does not exist", () => {
    const graph = seeded([task("A")]);
    for (const op of [
      { op: "set_status", activity: "ghost", status: "done", evidence_ref: "e" },
      { op: "record_outcome", activity: "ghost", verdict: "confirmed", evidence_ref: "e" },
      { op: "record_output", activity: "ghost", output_name: "reply", value: 1, evidence_ref: "e" },
      { op: "supersede_activity", activity: "ghost" },
    ] as CommittedOp[]) {
      expectRefusal(applyOps(graph, resolveSlugs(graph, [op]) as CommittedOp[], 2), "UNKNOWN_ACTIVITY");
    }
  });
});

describe("supersede_activity — never delete", () => {
  test("an in-flight activity stops being work", () => {
    const graph = commit(seeded([task("A")]), [{ op: "supersede_activity", activity: "a" }]);
    const activity = activityAt(graph, "a");
    expect(activity).toBeDefined();
    expect(activity?.status.state).toBe("dropped");
    expect(slugOf(activity?.provenance.superseded_by)).toBeNull();
  });

  test("an activity that already ran keeps its terminal status — superseding does not un-send", () => {
    const done = commit(seeded([task("A")]), [
      { op: "set_status", activity: "a", status: "done", evidence_ref: "e" },
    ]);
    const graph = commit(done, [{ op: "supersede_activity", activity: "a" }]);
    expect(activityAt(graph, "a")?.status.state).toBe("done");
  });

  test("wires provenance in both directions, replacement compensating the original", () => {
    const base = seeded([task("A")]);
    const graph = commit(base, [task("A prime"), { op: "supersede_activity", activity: "a", by: "$0" }]);
    expect(slugOf(activityAt(graph, "a")?.provenance.superseded_by)).toBe("a-prime");
    expect(slugOf(activityAt(graph, "a-prime")?.provenance.supersedes)).toBe("a");
  });

  test("refuses a self-supersede and an unknown replacement", () => {
    const graph = seeded([task("A")]);
    expectRefusal(applyOps(graph, resolveSlugs(graph, [{ op: "supersede_activity", activity: "a", by: "a" }]) as CommittedOp[], 2), "SELF_SUPERSEDE");
    expectRefusal(applyOps(graph, resolveSlugs(graph, [{ op: "supersede_activity", activity: "a", by: "ghost" }]) as CommittedOp[], 2), "UNKNOWN_ACTIVITY");
  });
});

describe("batch ordering", () => {
  test("cancellations run last, whatever order they were authored in", () => {
    const ops = committedOps([task("A"), wait("W")]);
    const cancel: CommittedOp = { op: "supersede_activity", activity: "a" };
    const ordered = orderOps([cancel, ...ops]);
    expect(ordered.map((entry) => entry.op.op)).toEqual(["add_activity", "add_activity", "supersede_activity"]);
  });

  test("the authored index survives reordering, so errors name the right op", () => {
    const ops = committedOps([task("A"), wait("W")]);
    const ordered = orderOps([{ op: "supersede_activity", activity: "a" }, ...ops]);
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
    const before = JSON.stringify([...graph.activities.values()]);
    const result = applyOps(graph, resolveSlugs(graph, [{ op: "set_status", activity: "a", status: "done", evidence_ref: "e" }]) as CommittedOp[], 2);
    expect(result.ok).toBe(true);
    expect(JSON.stringify([...graph.activities.values()])).toBe(before);
    expect(graph.version).toBe(1);
  });

  test("edges added to the result do not appear in the input", () => {
    const graph = seeded([task("A"), task("B")]);
    applyOps(graph, resolveSlugs(graph, [{ op: "add_edge", from: "a", to: "b" }]) as CommittedOp[], 2);
    expect(graph.edges).toHaveLength(0);
  });
});
