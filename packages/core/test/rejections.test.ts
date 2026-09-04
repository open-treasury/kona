/**
 * Every refusal, asserted whole.
 *
 * The other suites check that a bad batch is rejected. This one checks *what the operator
 * is told* — the symbolic reason, the offending activity, the op index, and the field name in
 * the message. That last part is not decoration: a batch is rejected by a machine and
 * repaired by one too, and "which of the six ref positions was wrong" is the difference
 * between a fix and a guess.
 */

import { describe, expect, test } from "bun:test";
import type { AuthoredOp, Graph, Rejection } from "../src/index.ts";
import { SCHEMA_VERSION, emptyGraph } from "../src/index.ts";
import {
  ORCHESTRATOR,
  SUBAGENT,
  commit,
  seeded,
  action,
  acceptEvent,
  resolveSlugs,
  slugOf,
  validateFragment,
} from "./fixtures.ts";

const EMPTY = emptyGraph(SCHEMA_VERSION);

function refuses(graph: Graph, ops: unknown, actor = ORCHESTRATOR): Rejection {
  const result = validateFragment({
    graph,
    ops: resolveSlugs(graph, ops),
    actor,
    version: graph.version + 1,
    prefix: "t",
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a rejection");
  return result.rejection;
}

function accepts(graph: Graph, ops: AuthoredOp[], actor = ORCHESTRATOR): void {
  const result = validateFragment({
    graph,
    ops: resolveSlugs(graph, ops),
    actor,
    version: graph.version + 1,
    prefix: "t",
  });
  if (!result.ok) throw new Error(`unexpectedly rejected: ${result.rejection.message}`);
}

describe("validate runs its stages in order and stops at the first failure", () => {
  test("a normalize failure propagates out of validate, not just out of normalizeBatch", () => {
    // The stage guard itself: if `validate` failed to return here, a batch with a dangling
    // ref would reach `applyOps` and be diagnosed as something else entirely.
    const r = refuses(EMPTY, [{ op: "add_edge", from: "$1", to: "$0" }, action("A")]);
    expect(r.reason).toBe("FORWARD_REF");
    expect(r.code).toBe("REFUSED");
  });

  test("an apply failure propagates out of validate", () => {
    const graph = commit(seeded([action("A"), action("B")]), [
      { op: "add_edge", from: "a", to: "b" },
    ]);
    const r = refuses(graph, [{ op: "add_edge", from: "a", to: "b" }]);
    expect(r.reason).toBe("DUPLICATE_EDGE");
  });

  test("an authority failure precedes minting: nothing is named in the error but the op", () => {
    const r = refuses(EMPTY, [action("A")], SUBAGENT);
    expect(r.reason).toBe("UNAUTHORIZED_ACTOR");
    expect(r.op_index).toBe(0);
    expect(r.activity).toBeUndefined();
    expect(r.message).toContain("add_node");
    expect(r.message).toContain("subagent");
  });
});

describe("the parser names where it failed", () => {
  test("a root-level problem carries no op index", () => {
    const r = refuses(EMPTY, []);
    expect(r.reason).toBe("MALFORMED_OPS");
    expect(r.op_index).toBeUndefined();
    expect(r.message).toContain("(root)");
  });

  test("an op-level problem carries the op's index", () => {
    expect(refuses(EMPTY, [action("A"), { op: "add_edge", from: "a" }]).op_index).toBe(1);
  });

  test.each([{ deadline: undefined }, { match: undefined }])(
    "an acceptEvent rejects missing required data",
    (broken) => {
      expect(refuses(EMPTY, [acceptEvent("W", broken)]).reason).toBe("MALFORMED_OPS");
    },
  );

  test("an effect problem names spec.effect", () => {
    expect(refuses(EMPTY, [action("T", { effect_class: "pivot" })]).message).toContain(
      "spec.effect:",
    );
  });

  test("an activity id at the length limit is accepted and one over is not", () => {
    const graph = seeded([action("A")]);
    const limit = "a".repeat(48);
    accepts(graph, [{ op: "set_status", node: "a", status: "completed", evidence_ref: "e" }]);
    expect(
      refuses(graph, [
        { op: "set_status", node: `${limit}b`, status: "completed", evidence_ref: "e" },
      ]).reason,
    ).toBe("MALFORMED_OPS");
  });

  test.each(["$", "$a", "$-1", "$1x", "-a", "A", "a/b", "a_b", "a b"])(
    "'%s' is neither a batch ref nor an activity id",
    (ref) => {
      const r = refuses(EMPTY, [{ op: "add_edge", from: ref, to: "b" }]);
      expect(r.reason).toBe("MALFORMED_OPS");
      expect(r.message).toContain("batch ref");
    },
  );
});

describe("every reference position names itself when it dangles", () => {
  const graph = seeded([action("A")]);

  test.each([
    ["from", { op: "add_edge", from: "ghost", to: "a" }],
    ["to", { op: "add_edge", from: "a", to: "ghost" }],
    ["node", { op: "set_status", node: "ghost", status: "completed", evidence_ref: "e" }],
    ["node", { op: "record_outcome", node: "ghost", verdict: "confirmed", evidence_ref: "e" }],
    ["node", { op: "record_output", node: "ghost", output_name: "r", value: 1, evidence_ref: "e" }],
    ["node", { op: "supersede_node", node: "ghost" }],
    ["by", { op: "supersede_node", node: "a", by: "ghost" }],
  ])("%s", (field, op) => {
    const r = refuses(graph, [op]);
    expect(r.reason).toBe("UNKNOWN_ACTIVITY");
    expect(r.message).toStartWith(`${field} references `);
    expect(r.message).toContain("ghost");
    expect(slugOf(r.activity)).toBe("ghost");
    expect(r.op_index).toBe(0);
  });

  test.each([
    ["spec.compensates", action("X", { compensates: "ghost" })],
    ["spec.deadline.after", acceptEvent("X", { deadline: { after: "ghost", duration: "48h" } })],
  ])("%s", (field, op) => {
    expect(refuses(graph, [op]).message).toStartWith(`${field} references `);
  });

  test("a forward ref names the position and the ref", () => {
    const r = refuses(EMPTY, [{ op: "add_edge", from: "$3", to: "$0" }, action("A")]);
    expect(r.message).toStartWith("from references $3");
    expect(r.message).toContain("not an earlier op");
    expect(r.op_index).toBe(0);
  });

  test("a ref to an op that mints nothing says so, distinctly from a forward ref", () => {
    const r = refuses(seeded([action("A")]), [
      { op: "set_status", node: "a", status: "completed", evidence_ref: "e" },
      { op: "add_edge", from: "$0", to: "a" },
    ]);
    expect(r.reason).toBe("UNRESOLVED_REF");
    expect(r.message).toContain("minted no id");
    expect(r.op_index).toBe(1);
  });
});

describe("spec refs are only rewritten where a ref can legally live", () => {
  test("an {at} deadline holds a literal and is left alone", () => {
    const at = "2026-08-22T17:00:00.000Z";
    const graph = seeded([action("A")]);
    const result = validateFragment({
      graph,
      ops: resolveSlugs(graph, [acceptEvent("W", { deadline: { at } })]),
      actor: ORCHESTRATOR,
      version: 2,
      prefix: "t",
    });
    if (!result.ok) throw new Error(result.rejection.message);
    const added = result.value.ops[0];
    expect(
      added?.op === "add_node" && added.type === "accept_event" ? added.spec.deadline : null,
    ).toEqual({ at });
  });

  test("an {expr} deadline is left alone too", () => {
    const deadline = {
      expr: "game_date - 24h",
      backstop: "2026-08-22T17:00:00.000Z",
      after_unknown: true,
    };
    const graph = seeded([action("A")]);
    const result = validateFragment({
      graph,
      ops: resolveSlugs(graph, [acceptEvent("W", { deadline })]),
      actor: ORCHESTRATOR,
      version: 2,
      prefix: "t",
    });
    if (!result.ok) throw new Error(result.rejection.message);
    const added = result.value.ops[0];
    expect(
      added?.op === "add_node" && added.type === "accept_event" ? added.spec.deadline : null,
    ).toEqual(deadline);
  });
});

describe("invariant violations name the invariant and the activity", () => {
  const done = commit(seeded([action("A"), action("B")]), [
    { op: "set_status", node: "a", status: "completed", evidence_ref: "e" },
  ]);

  test("a new edge into a terminal activity", () => {
    const r = refuses(done, [{ op: "add_edge", from: "b", to: "a" }]);
    expect(r.code).toBe("INVARIANT_VIOLATION");
    expect(r.invariant).toBe(1);
    expect(r.message).toContain("'A'");
    expect(r.op_index).toBe(0);
    expect(r.message).toContain("already terminal");
  });

  test("set_status against a terminal activity lists what is still allowed", () => {
    const r = refuses(done, [{ op: "set_status", node: "a", status: "failed", evidence_ref: "e" }]);
    expect(r.message).toContain("supersede_node");
    expect(r.message).toContain("record_outcome");
    expect(r.message).toContain("record_output");
    expect(r.message).toContain("'A'");
  });

  test("the violating op's index is reported, not the first op's", () => {
    const r = refuses(done, [action("C"), { op: "add_edge", from: "b", to: "a" }]);
    expect(r.op_index).toBe(1);
  });
});
