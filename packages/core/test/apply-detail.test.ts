/**
 * What `applyOps` refuses, and what it copies.
 *
 * These paths are defensive: reaching `applyOne` with a dangling ref means normalisation
 * already passed, which happens when a log line is corrupt rather than when an author is
 * wrong. `fold` is the caller that hits them, and it reports the reason verbatim — so the
 * reason has to be right even though no authoring path produces it.
 */

import { describe, expect, test } from "bun:test";
import type { CommittedOp, Graph } from "../src/index.ts";
import { applyOps } from "../src/index.ts";
import {
  commit,
  seeded,
  action,
  workedAt,
  activityAt,
  slugOf,
  resolveSlugs,
  nid,
} from "./fixtures.ts";

function refuses(graph: Graph, ops: CommittedOp[], version = graph.version + 1) {
  const result = applyOps(graph, resolveSlugs(graph, ops) as CommittedOp[], version);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a rejection");
  return result.rejection;
}

function applies(graph: Graph, ops: CommittedOp[], version = graph.version + 1): Graph {
  const result = applyOps(graph, resolveSlugs(graph, ops) as CommittedOp[], version);
  if (!result.ok) throw new Error(result.rejection.message);
  return result.value;
}

const PAIR = seeded([action("A"), action("B")]);

describe("refusals name the activity and the op", () => {
  test.each([
    ["set_status", { op: "set_status", node: "ghost", status: "completed", evidence_ref: "e" }],
    [
      "record_outcome",
      { op: "record_outcome", node: "ghost", verdict: "confirmed", evidence_ref: "e" },
    ],
    [
      "record_output",
      { op: "record_output", node: "ghost", output_name: "r", value: 1, evidence_ref: "e" },
    ],
    ["supersede_node", { op: "supersede_node", node: "ghost" }],
  ])("%s against a missing activity", (_name, op) => {
    const r = refuses(PAIR, [op as CommittedOp]);
    expect(r.reason).toBe("UNKNOWN_ACTIVITY");
    expect(r.message).toBe("activity 'ghost' does not exist");
    expect(slugOf(r.activity)).toBe("ghost");
    expect(r.op_index).toBe(0);
  });

  test("an edge endpoint names the endpoint, not the other end", () => {
    expect(refuses(PAIR, [{ op: "add_edge", from: "a", to: "ghost" }]).message).toBe(
      "edge endpoint 'ghost' does not exist",
    );
    expect(refuses(PAIR, [{ op: "add_edge", from: "ghost", to: "a" }]).activity).toBe("ghost");
  });

  test("a self-edge", () => {
    const r = refuses(PAIR, [{ op: "add_edge", from: "a", to: "a" }]);
    expect(r.message).toContain("cannot require itself");
    expect(r.message).toContain("'A'");
  });

  test("a duplicate edge quotes both ends", () => {
    const wired = commit(PAIR, [{ op: "add_edge", from: "a", to: "b" }]);
    expect(refuses(wired, [{ op: "add_edge", from: "a", to: "b" }]).message).toContain(
      "already exists",
    );
  });

  test("a duplicate activity id", () => {
    // A committed op carries its own id, so this one collides with the activity already there.
    const r = refuses(PAIR, [
      {
        op: "add_node",
        id: nid(PAIR, "a"),
        name: "A",
        type: "action",
        spec: { instruction: "x", inputs: [], outputs: [], effect_class: "pure" },
      },
    ]);
    expect(r.message).toContain("already exists");
  });

  test("an undeclared output names both the activity and the output", () => {
    expect(
      refuses(PAIR, [
        { op: "record_output", node: "a", output_name: "ghost", value: 1, evidence_ref: "e" },
      ]).message,
    ).toContain("declares no output named 'ghost'");
  });

  test("a self-supersede and a missing replacement are different errors", () => {
    expect(refuses(PAIR, [{ op: "supersede_node", node: "a", by: "a" }]).message).toContain(
      "cannot supersede itself",
    );
    expect(refuses(PAIR, [{ op: "supersede_node", node: "a", by: "ghost" }]).message).toBe(
      "replacement activity 'ghost' does not exist",
    );
  });

  test("the reported op index is the authored one, even after cancellations are reordered", () => {
    // `supersede_node` runs last, but it was authored first.
    expect(
      refuses(PAIR, [
        { op: "supersede_node", node: "ghost" },
        { op: "add_edge", from: "a", to: "b" },
      ]).op_index,
    ).toBe(0);
  });
});

describe("optional fields are absent, not present-and-undefined", () => {
  test("an edge with no guard has no guard key", () => {
    const graph = applies(PAIR, [{ op: "add_edge", from: "a", to: "b" }]);
    expect(Object.keys(graph.edges[0] ?? {})).toEqual(["from", "to"]);
  });

  test("an outcome with no attrs has no attrs key", () => {
    const graph = applies(PAIR, [
      { op: "record_outcome", node: "a", verdict: "confirmed", evidence_ref: "e" },
    ]);
    expect(Object.keys(workedAt(graph, "a").status.outcome ?? {})).toEqual([
      "verdict",
      "evidence_ref",
      "at_version",
    ]);
  });

  test("an activity with no scope has no group key", () => {
    expect(Object.keys(activityAt(PAIR, "a")?.provenance ?? {})).toEqual([
      "created_by_version",
      "supersedes",
      "superseded_by",
      "retired",
    ]);
  });
});

describe("a new activity starts empty", () => {
  test("no conditions, no effect log, no outcome, no output", () => {
    const activity = activityAt(PAIR, "a");
    expect(activity?.status?.conditions).toEqual([]);
    expect(activity?.status?.effect_log).toEqual([]);
    expect(activity?.status?.outcome).toBeNull();
    expect(activity?.status?.output).toBeNull();
  });
});

/** An activity carrying the two arrays an op must copy rather than share. */
function withHistory(): Graph {
  const graph = seeded([action("Send")]);
  const activity = activityAt(graph, "send");
  if (activity === undefined) throw new Error("fixture");
  activity.status?.conditions.push({
    type: "conflict",
    status: "open",
    reason: "overlaps",
    at: "2026-08-21T10:00:00.000Z",
  });
  activity.status?.effect_log.push({
    effect_key: "ek_1",
    payload_hash: "h1",
    attempted_at: "2026-08-21T10:00:00.000Z",
    completed_at: null,
    outcome: null,
    message_id: null,
  });
  return graph;
}

describe("cloning preserves what an op did not touch", () => {
  test("an unrelated op carries conditions, effect_log and provenance through untouched", () => {
    const before = withHistory();
    const after = applies(
      before,
      [{ op: "set_status", node: "send", status: "completed", evidence_ref: "e" }],
      2,
    );
    const activity = activityAt(after, "send");
    expect(activity?.status?.conditions).toEqual(workedAt(before, "send").status.conditions ?? []);
    expect(activity?.status?.effect_log).toEqual(workedAt(before, "send").status.effect_log ?? []);
    expect(activity?.provenance).toEqual({
      created_by_version: 1,
      supersedes: null,
      superseded_by: null,
      retired: false,
    });
  });

  test("the copies are independent: writing through the result does not reach head", () => {
    const before = withHistory();
    const after = applies(
      before,
      [{ op: "set_status", node: "send", status: "completed", evidence_ref: "e" }],
      2,
    );
    const activity = activityAt(after, "send");
    activity?.status?.effect_log.push({
      effect_key: "ek_2",
      payload_hash: "h2",
      attempted_at: "2026-08-21T11:00:00.000Z",
      completed_at: null,
      outcome: null,
      message_id: null,
    });
    activity?.status?.conditions.push({
      type: "x",
      status: "open",
      reason: "y",
      at: "2026-08-21T11:00:00.000Z",
    });
    if (activity !== undefined) activity.provenance.superseded_by = "someone-else";

    expect(workedAt(before, "send").status.effect_log).toHaveLength(1);
    expect(workedAt(before, "send").status.conditions).toHaveLength(1);
    expect(slugOf(activityAt(before, "send")?.provenance.superseded_by)).toBeNull();
  });

  test("an effect log entry is copied, not shared", () => {
    const before = withHistory();
    const after = applies(
      before,
      [{ op: "set_status", node: "send", status: "completed", evidence_ref: "e" }],
      2,
    );
    const entry = workedAt(after, "send").status.effect_log[0];
    if (entry !== undefined) entry.message_id = "<forged>";
    expect(workedAt(before, "send").status.effect_log[0]?.message_id).toBeNull();
  });
});
