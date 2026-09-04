import { describe, expect, test } from "bun:test";
import {
  SCHEMA_VERSION,
  type CommittedOp,
  applyOps,
  emptyGraph,
  normalizeBatch,
  orderOps,
  parseBatch,
} from "../src/index.ts";
import {
  commit,
  seeded,
  action,
  acceptEvent,
  workedAt,
  activityAt,
  slugOf,
  resolveSlugs,
  nid,
} from "./fixtures.ts";

function committedOps(ops: Parameters<typeof commit>[1]): CommittedOp[] {
  const result = normalizeBatch(emptyGraph(SCHEMA_VERSION), ops, "t", 1);
  if (!result.ok) throw new Error(result.rejection.message);
  return result.value;
}

function expectRefusal(result: ReturnType<typeof applyOps>, reason: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.rejection.reason).toBe(reason);
}

describe("add_node", () => {
  test("creates a ready activity stamped with the committing version", () => {
    const graph = seeded([action("Ask Dana")]);
    const activity = activityAt(graph, "ask-dana");
    // Born `inactive`; a root blocks on nothing, so the same commit's readiness derivation
    // lifts it to `ready`. What the activity is NOT is claimed — that is `active` now.
    expect(activity?.status?.state).toBe("ready");
    expect(activity?.status?.outcome).toBeNull();
    expect(activity?.status?.output).toBeNull();
    expect(activity?.provenance.created_by_version).toBe(1);
    expect(slugOf(activity?.provenance.supersedes)).toBeNull();
  });

  test("refuses the deleted scope field", () => {
    expect(parseBatch([{ ...action("Other"), scope: "goalies" }]).ok).toBe(false);
  });

  test("refuses a duplicate id", () => {
    const graph = seeded([action("Ask Dana")]);
    const ops: CommittedOp[] = [{ ...(committedOps([action("Ask Dana")])[0] as CommittedOp) }];
    expectRefusal(
      applyOps(graph, resolveSlugs(graph, ops) as CommittedOp[], 2),
      "DUPLICATE_ACTIVITY_ID",
    );
  });
});

describe("add_edge", () => {
  test("records that `to` requires `from`", () => {
    const graph = commit(seeded([action("A"), action("B")]), [
      { op: "add_edge", from: "a", to: "b" },
    ]);
    expect(graph.edges).toEqual([{ from: nid(graph, "a"), to: nid(graph, "b") }]);
  });

  test("keeps the guard when one is given", () => {
    const graph = commit(seeded([action("A"), action("B")]), [
      { op: "add_edge", from: "a", to: "b", guard: { on: "accept" } },
    ]);
    expect(graph.edges[0]?.guard).toEqual({ on: "accept" });
  });

  test("refuses a self-edge — 'B requires B' has no reading", () => {
    const graph = seeded([action("A")]);
    expectRefusal(
      applyOps(
        graph,
        resolveSlugs(graph, [{ op: "add_edge", from: "a", to: "a" }]) as CommittedOp[],
        2,
      ),
      "SELF_EDGE",
    );
  });

  test("refuses an endpoint that does not exist", () => {
    const graph = seeded([action("A")]);
    expectRefusal(
      applyOps(
        graph,
        resolveSlugs(graph, [{ op: "add_edge", from: "a", to: "ghost" }]) as CommittedOp[],
        2,
      ),
      "UNKNOWN_ACTIVITY",
    );
    expectRefusal(
      applyOps(
        graph,
        resolveSlugs(graph, [{ op: "add_edge", from: "ghost", to: "a" }]) as CommittedOp[],
        2,
      ),
      "UNKNOWN_ACTIVITY",
    );
  });

  test("refuses an exact duplicate, but allows two conditions between the same pair", () => {
    const graph = commit(seeded([action("A"), action("B")]), [
      { op: "add_edge", from: "a", to: "b", guard: { on: "accept" } },
    ]);
    const withDecline = commit(graph, [
      { op: "add_edge", from: "a", to: "b", guard: { on: "ignore" } },
    ]);
    expect(withDecline.edges).toHaveLength(2);
    expectRefusal(
      applyOps(
        withDecline,
        resolveSlugs(withDecline, [
          { op: "add_edge", from: "a", to: "b", guard: { on: "accept" } },
        ]) as CommittedOp[],
        3,
      ),
      "DUPLICATE_EDGE",
    );
  });
});

describe("the three observed fields answer three different questions", () => {
  test("set_status writes only where we are", () => {
    const graph = commit(seeded([action("A")]), [
      { op: "set_status", node: "a", status: "active", evidence_ref: "ev-1" },
    ]);
    const activity = activityAt(graph, "a");
    expect(activity?.status?.state).toBe("active");
    expect(activity?.status?.outcome).toBeNull();
    expect(activity?.status?.output).toBeNull();
    expect(activity?.status?.observed_at_version).toBe(2);
  });

  test("record_outcome writes only what was decided", () => {
    const graph = commit(seeded([action("A")]), [
      {
        op: "record_outcome",
        node: "a",
        verdict: "declined",
        evidence_ref: "m-101",
        attrs: { role: "goalie" },
      },
    ]);
    const activity = activityAt(graph, "a");
    expect(activity?.status?.outcome).toEqual({
      verdict: "declined",
      evidence_ref: "m-101",
      attrs: { role: "goalie" },
      at_version: 2,
    });
    expect(activity?.status?.outcomes).toHaveLength(1);
    // Untouched: recording what was decided is not a claim, and not a resolution.
    expect(activity?.status?.state).toBe("ready");
  });

  test("record_output writes only what was produced, keyed by declared name", () => {
    const graph = commit(seeded([action("A")]), [
      { op: "record_output", node: "a", output_name: "reply", value: "yes", evidence_ref: "m-101" },
    ]);
    expect(workedAt(graph, "a").status.output).toEqual({ reply: "yes" });
  });

  test("a second output merges rather than replacing", () => {
    const base = seeded([
      action("A", {
        outputs: [
          { name: "reply", type: "string" },
          { name: "note", type: "string" },
        ],
      }),
    ]);
    const graph = commit(
      commit(base, [
        { op: "record_output", node: "a", output_name: "reply", value: "yes", evidence_ref: "e1" },
      ]),
      [{ op: "record_output", node: "a", output_name: "note", value: "late", evidence_ref: "e2" }],
    );
    expect(workedAt(graph, "a").status.output).toEqual({ reply: "yes", note: "late" });
  });

  test("refuses an output nobody declared — an unreferenceable value is an authoring error", () => {
    const graph = seeded([action("A")]);
    expectRefusal(
      applyOps(
        graph,
        resolveSlugs(graph, [
          { op: "record_output", node: "a", output_name: "ghost", value: 1, evidence_ref: "e" },
        ]) as CommittedOp[],
        2,
      ),
      "UNDECLARED_OUTPUT",
    );
  });

  test("every op refuses an activity that does not exist", () => {
    const graph = seeded([action("A")]);
    for (const op of [
      { op: "set_status", node: "ghost", status: "completed", evidence_ref: "e" },
      { op: "record_outcome", node: "ghost", verdict: "confirmed", evidence_ref: "e" },
      { op: "record_output", node: "ghost", output_name: "reply", value: 1, evidence_ref: "e" },
      { op: "supersede_node", node: "ghost" },
    ] as CommittedOp[]) {
      expectRefusal(
        applyOps(graph, resolveSlugs(graph, [op]) as CommittedOp[], 2),
        "UNKNOWN_ACTIVITY",
      );
    }
  });
});

describe("supersede_node — never delete", () => {
  test("an unclaimed activity stops being work", () => {
    const graph = commit(seeded([action("A")]), [{ op: "supersede_node", node: "a" }]);
    const activity = activityAt(graph, "a");
    expect(activity).toBeDefined();
    expect(activity?.status?.state).toBe("withdrawn");
    expect(activity?.provenance).toMatchObject({ retired: true, superseded_by: null });
  });

  test("an activity that already ran keeps its terminal status — superseding does not un-send", () => {
    const done = commit(seeded([action("A")]), [
      { op: "set_status", node: "a", status: "completed", evidence_ref: "e" },
    ]);
    const graph = commit(done, [{ op: "supersede_node", node: "a" }]);
    expect(workedAt(graph, "a").status.state).toBe("completed");
  });

  test("wires provenance in both directions, replacement compensating the original", () => {
    const base = seeded([action("A")]);
    const graph = commit(base, [action("A prime"), { op: "supersede_node", node: "a", by: "$0" }]);
    expect(activityAt(graph, "a")?.provenance.retired).toBe(true);
    expect(slugOf(activityAt(graph, "a")?.provenance.superseded_by)).toBe("a-prime");
    expect(slugOf(activityAt(graph, "a-prime")?.provenance.supersedes)).toBe("a");
  });

  test("refuses a self-supersede and an unknown replacement", () => {
    const graph = seeded([action("A")]);
    expectRefusal(
      applyOps(
        graph,
        resolveSlugs(graph, [{ op: "supersede_node", node: "a", by: "a" }]) as CommittedOp[],
        2,
      ),
      "SELF_SUPERSEDE",
    );
    expectRefusal(
      applyOps(
        graph,
        resolveSlugs(graph, [{ op: "supersede_node", node: "a", by: "ghost" }]) as CommittedOp[],
        2,
      ),
      "UNKNOWN_ACTIVITY",
    );
  });
});

/**
 * A committed batch is the authored ops plus the ops the store derived (§6.4): readiness
 * writes `inactive` -> `ready` explicitly now, so every batch that adds a root carries a
 * trailing `set_status` per node. Those are ordinary ops to `orderOps` — they are not
 * cancellations, so they sort with the authored ops and keep their positions.
 */
describe("batch ordering", () => {
  test("cancellations run last, whatever order they were authored in", () => {
    const ops = committedOps([action("A"), acceptEvent("W")]);
    const cancel: CommittedOp = { op: "supersede_node", node: "a" };
    const ordered = orderOps([cancel, ...ops]);
    expect(ordered.map((entry) => entry.op.op)).toEqual(["add_node", "add_node", "supersede_node"]);
  });

  test("the authored index survives reordering, so errors name the right op", () => {
    const ops = committedOps([action("A"), acceptEvent("W")]);
    const ordered = orderOps([{ op: "supersede_node", node: "a" }, ...ops]);
    expect(ordered.map((entry) => entry.index)).toEqual([1, 2, 0]);
  });

  test("order within a class is authored order", () => {
    const ordered = orderOps(committedOps([action("A"), action("B"), action("C")]));
    expect(ordered.map((entry) => entry.index)).toEqual([0, 1, 2]);
  });
});

describe("applyOps never mutates its input", () => {
  test("head is untouched, which is what lets invariant 1 compare against it", () => {
    const graph = seeded([action("A")]);
    const before = JSON.stringify([...graph.nodes.values()]);
    const result = applyOps(
      graph,
      resolveSlugs(graph, [
        { op: "set_status", node: "a", status: "completed", evidence_ref: "e" },
      ]) as CommittedOp[],
      2,
    );
    expect(result.ok).toBe(true);
    expect(JSON.stringify([...graph.nodes.values()])).toBe(before);
    expect(graph.version).toBe(1);
  });

  test("edges added to the result do not appear in the input", () => {
    const graph = seeded([action("A"), action("B")]);
    applyOps(
      graph,
      resolveSlugs(graph, [{ op: "add_edge", from: "a", to: "b" }]) as CommittedOp[],
      2,
    );
    expect(graph.edges).toHaveLength(0);
  });
});
