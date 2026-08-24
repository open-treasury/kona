import { describe, expect, test } from "bun:test";
import type { AuthoredOp, Graph, Result } from "../src/index.ts";
import { checkAuthority, checkInvariant1, formatRejection, validate } from "../src/index.ts";
import { ORCHESTRATOR, SUBAGENT, commit, seeded, task, nodeAt, resolveSlugs, nid } from "./fixtures.ts";

function run(graph: Graph, ops: AuthoredOp[], actor = ORCHESTRATOR) {
  return validate({ graph, ops: resolveSlugs(graph, ops), actor, version: graph.version + 1, prefix: "t" });
}

function rejection<T>(result: Result<T>) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  return result.rejection;
}

/** A node that is `done` at head, and one that has already moved bytes. */
function withTerminal(): Graph {
  return commit(seeded([task("A"), task("B")]), [
    { op: "set_status", node: "a", status: "done", evidence_ref: "ev" },
  ]);
}

describe("stage order", () => {
  test("shape is rejected before graph logic — a malformed batch never reaches minting", () => {
    const r = rejection(run(seeded([task("A")]), [{ op: "add_node" } as never]));
    expect(r.reason).toBe("MALFORMED_OPS");
  });

  test("a legal batch returns both the committed ops and the post-commit graph", () => {
    const result = run(seeded([task("A")]), [task("B"), { op: "add_edge", from: "a", to: "$0" }]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.ops).toHaveLength(2);
    expect(result.value.graph.version).toBe(2);
    expect(result.value.graph.nodes.has(nid(result.value.graph, "b"))).toBe(true);
  });
});

describe("role-scoped write authority (§6.7)", () => {
  test("a subagent may write status, outcome and output", () => {
    for (const op of [
      { op: "set_status", node: "a", status: "done", evidence_ref: "e" },
      { op: "record_outcome", node: "a", verdict: "confirmed", evidence_ref: "e" },
      { op: "record_output", node: "a", output_name: "reply", value: "yes", evidence_ref: "e" },
    ] as AuthoredOp[]) {
      expect(checkAuthority(SUBAGENT, [op]).ok).toBe(true);
    }
  });

  const TOPOLOGY_ATTEMPTS: [string, AuthoredOp][] = [
    ["add_node", task("B")],
    ["add_edge", { op: "add_edge", from: "a", to: "a" }],
    ["supersede_node", { op: "supersede_node", node: "a" }],
  ];

  test.each(TOPOLOGY_ATTEMPTS)("a subagent attempting %s is refused", (_name, op) => {
    const r = rejection(checkAuthority(SUBAGENT, [op]));
    expect(r.reason).toBe("UNAUTHORIZED_ACTOR");
  });

  test("names the offending op, not just the batch", () => {
    const ops: AuthoredOp[] = [
      { op: "set_status", node: "a", status: "done", evidence_ref: "e" },
      { op: "supersede_node", node: "a" },
    ];
    expect(rejection(checkAuthority(SUBAGENT, ops)).op_index).toBe(1);
  });

  test("the orchestrator and a human may do anything the invariants allow", () => {
    expect(checkAuthority(ORCHESTRATOR, [task("B")]).ok).toBe(true);
    expect(checkAuthority({ kind: "human", id: "ilya" }, [task("B")]).ok).toBe(true);
  });
});

describe("invariant 1 — terminal & effect protection", () => {
  test("refuses a NEW blocking edge into a terminal node", () => {
    const r = rejection(run(withTerminal(), [{ op: "add_edge", from: "b", to: "a" }]));
    expect(r.code).toBe("INVARIANT_VIOLATION");
    expect(r.invariant).toBe(1);
    expect(r.reason).toBe("TERMINAL_NODE_PROTECTED");
    expect(r.message).toContain("'A'");
  });

  test("refuses set_status against a terminal node", () => {
    const r = rejection(run(withTerminal(), [
      { op: "set_status", node: "a", status: "active", evidence_ref: "e" },
    ]));
    expect(r.reason).toBe("TERMINAL_NODE_PROTECTED");
  });

  test("record_outcome, record_output and supersede_node are still allowed", () => {
    const graph = withTerminal();
    expect(run(graph, [{ op: "record_outcome", node: "a", verdict: "late", evidence_ref: "m-9" }]).ok).toBe(true);
    expect(run(graph, [{ op: "record_output", node: "a", output_name: "reply", value: "y", evidence_ref: "e" }]).ok).toBe(true);
    expect(run(graph, [{ op: "supersede_node", node: "a" }]).ok).toBe(true);
  });

  test("an edge OUT of a terminal node is fine — it is how the next node becomes reachable", () => {
    expect(run(withTerminal(), [task("C"), { op: "add_edge", from: "a", to: "$0" }]).ok).toBe(true);
  });

  /**
   * The blocker the review caught. `{from, to}` means "to requires from", so a completed
   * node's dependency edges point INTO it and never disappear. Read as a post-state
   * predicate, "no blocking edge into a terminal node" 422s every commit from the first
   * completed node onward.
   */
  test("EXISTING edges into a terminal node do not block unrelated commits", () => {
    const wired = commit(seeded([task("A"), task("B")]), [{ op: "add_edge", from: "a", to: "b" }]);
    const finished = commit(wired, [{ op: "set_status", node: "b", status: "done", evidence_ref: "e" }]);
    expect(finished.edges).toEqual([{ from: nid(finished, "a"), to: nid(finished, "b") }]);
    // b is terminal and still carries an in-edge. An unrelated commit must succeed.
    expect(run(finished, [task("C")]).ok).toBe(true);
  });

  test("a node that goes terminal WITHIN the batch is not protected from the same batch", () => {
    const graph = seeded([task("A"), task("B")]);
    expect(
      run(graph, [
        { op: "set_status", node: "a", status: "done", evidence_ref: "e" },
        { op: "add_edge", from: "b", to: "a" },
      ]).ok,
    ).toBe(true);
  });
});

/** A node that has already put an email on the wire. */
function withEffect(): Graph {
  const graph = seeded([task("Send invite")]);
  const node = nodeAt(graph, "send-invite");
  if (node === undefined) throw new Error("fixture");
  node.status.effect_log.push({
    effect_key: "ek_1",
    payload_hash: "h1",
    attempted_at: "2026-08-21T10:00:00.000Z",
    completed_at: "2026-08-21T10:00:01.000Z",
    outcome: "sent",
    message_id: "<m-1>",
  });
  return graph;
}

describe("invariant 1 — superseding a node that already moved bytes", () => {
  test("refuses a bare supersede — the email is already gone", () => {
    const r = rejection(run(withEffect(), [{ op: "supersede_node", node: "send-invite" }]));
    expect(r.invariant).toBe(1);
    expect(r.reason).toBe("UNCOMPENSATED_SUPERSEDE");
    expect(r.message).toContain("'Send invite'");
  });

  test("allows it when the same batch carries the compensation", () => {
    const result = run(withEffect(), [
      task("Retract invite", { compensates: "send-invite" }),
      { op: "supersede_node", node: "send-invite", by: "$0" },
    ]);
    expect(result.ok).toBe(true);
  });

  test("the direction matters: the NEW node compensates the OLD one, never the reverse", () => {
    // Wiring `compensates` backwards records the executed node as compensating its own
    // compensation, and must not satisfy the invariant.
    const graph = withEffect();
    const r = rejection(run(graph, [
      task("Retract invite"),
      { op: "supersede_node", node: "send-invite", by: "$0" },
    ]));
    expect(r.reason).toBe("UNCOMPENSATED_SUPERSEDE");
  });

  test("a node with no effect_log needs no compensation", () => {
    expect(run(seeded([task("A")]), [{ op: "supersede_node", node: "a" }]).ok).toBe(true);
  });

  test("checkInvariant1 is happy with an empty batch", () => {
    expect(checkInvariant1(withTerminal(), []).ok).toBe(true);
  });
});

describe("rejections are one greppable line", () => {
  test("symbolic reason first, then invariant, node and op", () => {
    const graph = withTerminal();
    const r = rejection(run(graph, [{ op: "add_edge", from: "b", to: "a" }]));
    const line = formatRejection(r);
    expect(line.startsWith("TERMINAL_NODE_PROTECTED ")).toBe(true);
    expect(line).toContain("invariant=1");
    expect(line).toContain(`node=${nid(graph, "a")}`);
    expect(line).toContain("op=0");
  });

  test("omits the fields that do not apply", () => {
    const line = formatRejection({ code: "REFUSED", reason: "NO_PURSUIT", message: "nothing here" });
    expect(line).toBe("NO_PURSUIT nothing here");
  });
});
