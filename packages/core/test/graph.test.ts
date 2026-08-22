import { describe, expect, test } from "bun:test";
import {
  STATUSES,
  TERMINAL_STATUSES,
  headVersion,
  inEdges,
  isIrreversible,
  isNodeTerminal,
  isTerminal,
  nodeIds,
  outEdges,
  projectGraph,
  satisfiesBlockingEdge,
} from "../src/index.ts";
import { commit, record, seeded, task } from "./fixtures.ts";

const WIRED = commit(seeded([task("A"), task("B"), task("C")]), [
  { op: "add_edge", from: "a", to: "b" },
  { op: "add_edge", from: "a", to: "c" },
  { op: "add_edge", from: "b", to: "c" },
]);

describe("status vocabulary", () => {
  test("terminal means done, failed or dropped — and sending is not terminal", () => {
    // `sending` means the real world's answer is unknown, not that the node resolved.
    expect(STATUSES.filter(isTerminal).toSorted()).toEqual(TERMINAL_STATUSES.toSorted());
    expect(isTerminal("in_flight")).toBe(false);
    expect(isTerminal("active")).toBe(false);
  });

  test("only `done` satisfies a blocking edge — readiness fails safe", () => {
    // A dropped source never satisfies readiness; otherwise the second node on an untaken
    // branch has no blocker, lands on the frontier, and gets dispatched — pivot send included.
    const satisfying = STATUSES.filter((state) =>
      satisfiesBlockingEdge({ status: { state } } as never),
    );
    expect(satisfying).toEqual(["done"]);
  });

  test("compensatable and pivot are the classes that move bytes we cannot take back", () => {
    expect(isIrreversible("pivot")).toBe(true);
    expect(isIrreversible("compensatable")).toBe(true);
    expect(isIrreversible("pure")).toBe(false);
    expect(isIrreversible("reversible")).toBe(false);
  });

  test("isNodeTerminal reads the node's own state", () => {
    const done = commit(WIRED, [{ op: "set_status", node: "a", status: "done", evidence_ref: "e" }]);
    expect(isNodeTerminal(done.nodes.get("a") as never)).toBe(true);
    expect(isNodeTerminal(done.nodes.get("b") as never)).toBe(false);
  });
});

describe("edge projections", () => {
  test("in-edges are the blocking dependencies — with one edge kind, all of them", () => {
    expect(inEdges(WIRED, "c")).toEqual([
      { from: "a", to: "c" },
      { from: "b", to: "c" },
    ]);
    expect(inEdges(WIRED, "a")).toEqual([]);
  });

  test("out-edges are what this node unblocks", () => {
    expect(outEdges(WIRED, "a")).toEqual([
      { from: "a", to: "b" },
      { from: "a", to: "c" },
    ]);
    expect(outEdges(WIRED, "c")).toEqual([]);
  });

  test("nodeIds is the set of committed ids", () => {
    expect([...nodeIds(WIRED)]).toEqual(["a", "b", "c"]);
  });
});

describe("the read contract", () => {
  test("projection is ordered and plain, so two stringifies match", () => {
    const projection = projectGraph(WIRED);
    expect(projection.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(JSON.stringify(projectGraph(WIRED))).toBe(JSON.stringify(projection));
  });

  test("headVersion reads the last record, and 0 for an empty log", () => {
    expect(headVersion([])).toBe(0);
    expect(headVersion([record(0, []), record(1, []), record(2, [])])).toBe(2);
  });
});
