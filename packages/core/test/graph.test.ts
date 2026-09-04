import { describe, expect, test } from "bun:test";
import {
  STATUSES,
  TERMINAL_STATUSES,
  headVersion,
  inEdges,
  isIrreversible,
  isActivityTerminal,
  isTerminal,
  activityIds,
  outEdges,
  projectGraph,
  satisfiesBlockingEdge,
} from "../src/index.ts";
import { commit, record, seeded, action, activityAt, slugOr, nid, slugOf } from "./fixtures.ts";

const WIRED = commit(seeded([action("A"), action("B"), action("C")]), [
  { op: "add_edge", from: "a", to: "b" },
  { op: "add_edge", from: "a", to: "c" },
  { op: "add_edge", from: "b", to: "c" },
]);

describe("status vocabulary", () => {
  test("terminal means completed, failed, withdrawn or terminated — and active is not terminal", () => {
    // `active` means the real world's answer is unknown, not that the activity resolved.
    expect(STATUSES.filter(isTerminal).toSorted()).toEqual(TERMINAL_STATUSES.toSorted());
    // Both non-terminal states, and they are non-terminal for DIFFERENT reasons — which is
    // why both are here. `inactive` has not started; `active` is claimed and its answer from
    // the real world is unknown, which is emphatically not "resolved". A blind substitution
    // during the rename collapsed these two lines onto one token and halved the coverage
    // without failing: the assertion was still true, just asked twice.
    expect(isTerminal("inactive")).toBe(false);
    expect(isTerminal("active")).toBe(false);
  });

  test("only `completed` satisfies a blocking edge — readiness fails safe", () => {
    // An abandoned source never satisfies readiness; otherwise the second activity on an untaken
    // branch has no blocker, lands on the frontier, and gets dispatched — pivot send included.
    const satisfying = STATUSES.filter((state) =>
      satisfiesBlockingEdge({ status: { state } } as never),
    );
    expect(satisfying).toEqual(["completed"]);
  });

  test("compensatable and pivot are the classes that move bytes we cannot take back", () => {
    expect(isIrreversible("pivot")).toBe(true);
    expect(isIrreversible("compensatable")).toBe(true);
    expect(isIrreversible("pure")).toBe(false);
    expect(isIrreversible("reversible")).toBe(false);
  });

  test("isActivityTerminal reads the activity's own state", () => {
    const done = commit(WIRED, [{ op: "set_status", node: "a", status: "completed", evidence_ref: "e" }]);
    expect(isActivityTerminal(activityAt(done, "a") as never)).toBe(true);
    expect(isActivityTerminal(activityAt(done, "b") as never)).toBe(false);
  });
});

describe("edge projections", () => {
  test("in-edges are the blocking dependencies — with one edge kind, all of them", () => {
    expect(inEdges(WIRED, slugOr(WIRED, "c"))).toEqual([
      { from: nid(WIRED, "a"), to: nid(WIRED, "c") },
      { from: nid(WIRED, "b"), to: nid(WIRED, "c") },
    ]);
    expect(inEdges(WIRED, slugOr(WIRED, "a"))).toEqual([]);
  });

  test("out-edges are what this activity unblocks", () => {
    expect(outEdges(WIRED, slugOr(WIRED, "a"))).toEqual([
      { from: nid(WIRED, "a"), to: nid(WIRED, "b") },
      { from: nid(WIRED, "a"), to: nid(WIRED, "c") },
    ]);
    expect(outEdges(WIRED, slugOr(WIRED, "c"))).toEqual([]);
  });

  test("activityIds is the set of committed ids", () => {
    expect([...activityIds(WIRED)].map(slugOf)).toEqual(["a", "b", "c"]);
  });
});

describe("the read contract", () => {
  test("projection is ordered and plain, so two stringifies match", () => {
    const projection = projectGraph(WIRED);
    expect(projection.nodes.map((n) => slugOf(n.id))).toEqual(["a", "b", "c"]);
    expect(JSON.stringify(projectGraph(WIRED))).toBe(JSON.stringify(projection));
  });

  test("headVersion reads the last record, and 0 for an empty log", () => {
    expect(headVersion([])).toBe(0);
    expect(headVersion([record(0, []), record(1, []), record(2, [])])).toBe(2);
  });
});
