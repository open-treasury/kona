/**
 * T2.6 — branch resolution. §6.4: "When a `wait` resolves, the store marks the target of
 * every untaken out-edge `dropped`, transitively."
 *
 * The thing under test is not just the drop set but *where* it is computed. Derivation
 * happens ONCE, at commit, and is expanded into explicit ops in the log; `fold` stays a
 * dumb replay. The determinism suite below is what pins that: a log folded next month, by
 * code with a different drop rule, must still produce the graph the human approved.
 */

import { describe, expect, test } from "bun:test";
import type { AuthoredOp, CommittedOp, Graph, Node, Verdict } from "../src/index.ts";
import {
  DERIVED_EVIDENCE_PREFIX,
  applyOps,
  emptyGraph,
  isDroppable,
  isEdgeDead,
  isReady,
  parseEffectEvidence,
  projectGraph,
  readyFrontier,
  resolveBranches,
  SCHEMA_VERSION,
  validate,
} from "../src/index.ts";
import { ORCHESTRATOR, commit, seeded, task, wait } from "./fixtures.ts";

function run(graph: Graph, ops: AuthoredOp[]) {
  const result = validate({ graph, ops, actor: ORCHESTRATOR, version: graph.version + 1 });
  if (!result.ok) {
    throw new Error(`rejected: ${result.rejection.reason} ${result.rejection.message}`);
  }
  return result.value;
}

function nodeOf(graph: Graph, id: string): Node {
  const node = graph.nodes.get(id);
  if (node === undefined) throw new Error(`no node ${id}`);
  return node;
}

function outcome(node: string, verdict: Verdict): AuthoredOp {
  return { op: "record_outcome", node, verdict, evidence_ref: "<m-1>" };
}

function close(node: string, status = "done"): AuthoredOp {
  return { op: "set_status", node, status, evidence_ref: "<m-1>" } as AuthoredOp;
}

/** `gate` is a wait with one `accept` arm and one `ignore` arm. */
function gated(): Graph {
  return commit(seeded([task("Accepted"), task("Ignored"), wait("Gate", { on_timeout: "$0" })]), [
    { op: "add_edge", from: "gate", to: "accepted", condition: { on: "accept" } },
    { op: "add_edge", from: "gate", to: "ignored", condition: { on: "ignore" } },
  ]);
}

/** The §7 shape: two arms two deep, rejoining at a merge. */
function twoDeep(): Graph {
  const seed = seeded([
    task("A1"),
    task("A2"),
    task("B1"),
    task("B2"),
    task("Join", { merge: "all" }),
    wait("Gate", { on_timeout: "$0" }),
  ]);
  return commit(seed, [
    { op: "add_edge", from: "gate", to: "a1", condition: { on: "accept" } },
    { op: "add_edge", from: "a1", to: "a2" },
    { op: "add_edge", from: "gate", to: "b1", condition: { on: "ignore" } },
    { op: "add_edge", from: "b1", to: "b2" },
    { op: "add_edge", from: "a2", to: "join" },
    { op: "add_edge", from: "b2", to: "join" },
  ]);
}

describe("isEdgeDead — the trichotomy is satisfied | pending | dead", () => {
  test("an edge whose source is still open is pending, not dead", () => {
    expect(isEdgeDead(gated(), { from: "gate", to: "ignored", condition: { on: "ignore" } })).toBe(
      false,
    );
  });

  test("a resolved gate kills exactly the arms it did not take", () => {
    const graph = commit(gated(), [outcome("gate", "accept"), close("gate")]);
    expect(isEdgeDead(graph, { from: "gate", to: "accepted", condition: { on: "accept" } })).toBe(
      false,
    );
    expect(isEdgeDead(graph, { from: "gate", to: "ignored", condition: { on: "ignore" } })).toBe(
      true,
    );
  });

  test("a DROPPED source kills every out-edge, conditioned or not", () => {
    const graph = commit(gated(), [close("ignored", "dropped")]);
    expect(isEdgeDead(graph, { from: "ignored", to: "accepted" })).toBe(true);
  });

  /**
   * §6.2 keeps `failed` and `dropped` distinct — "tried, didn't work" vs "we stopped
   * wanting this". A subtree under a visibly failed node is a human's to look at; deleting
   * it silently is the one thing worse than leaving it stuck.
   */
  test("a FAILED source is not dead, even though it can never satisfy", () => {
    const graph = commit(gated(), [close("ignored", "failed")]);
    expect(isEdgeDead(graph, { from: "ignored", to: "accepted" })).toBe(false);
  });

  test("a plain edge out of a done source is satisfied, never dead", () => {
    const graph = commit(gated(), [outcome("gate", "accept"), close("gate")]);
    expect(isEdgeDead(graph, { from: "gate", to: "accepted" })).toBe(false);
  });

  test("done but not yet resolved is pending — the outcome may land in a later commit", () => {
    const graph = commit(gated(), [close("gate")]);
    expect(isEdgeDead(graph, { from: "gate", to: "ignored", condition: { on: "ignore" } })).toBe(
      false,
    );
  });

  test("a tentative outcome does not resolve, so it kills nothing", () => {
    const graph = commit(gated(), [outcome("gate", "tentative"), close("gate")]);
    expect(isEdgeDead(graph, { from: "gate", to: "ignored", condition: { on: "ignore" } })).toBe(
      false,
    );
  });

  test("an edge from a node that does not exist is never dead", () => {
    expect(isEdgeDead(gated(), { from: "ghost", to: "accepted" })).toBe(false);
  });
});

describe("isDroppable — what the store may rewrite", () => {
  test("an ordinary active node is droppable", () => {
    expect(isDroppable(nodeOf(gated(), "ignored"))).toBe(true);
  });

  test("a SENDING node is not — §6.6, the world's answer is unknown", () => {
    const graph = commit(gated(), [close("ignored", "sending")]);
    expect(isDroppable(nodeOf(graph, "ignored"))).toBe(false);
  });

  test("a node that already moved bytes is not", () => {
    const graph = gated();
    nodeOf(graph, "ignored").status.effect_log.push({
      effect_key: "ek_1",
      payload_hash: "h1",
      attempted_at: "2026-08-21T10:00:00.000Z",
      completed_at: "2026-08-21T10:00:01.000Z",
      outcome: "sent",
      message_id: "<m-1>",
    });
    expect(isDroppable(nodeOf(graph, "ignored"))).toBe(false);
  });
});

describe("the trigger is an op-delta, never a post-state scan", () => {
  test("resolving a gate derives a drop for the untaken arm", () => {
    const { ops, derived, graph } = run(gated(), [outcome("gate", "accept"), close("gate")]);
    expect(derived).toHaveLength(1);
    expect(derived[0]).toEqual({
      op: "set_status",
      node: "ignored",
      status: "dropped",
      evidence_ref: `${DERIVED_EVIDENCE_PREFIX}:gate`,
    });
    // The authored ops keep their positions; derivation only ever appends.
    expect(ops).toHaveLength(3);
    expect(nodeOf(graph, "ignored").status.state).toBe("dropped");
    expect(nodeOf(graph, "accepted").status.state).toBe("active");
  });

  test("recording the outcome without closing the wait derives nothing", () => {
    expect(run(gated(), [outcome("gate", "accept")]).derived).toEqual([]);
  });

  test("closing the wait without an outcome derives nothing", () => {
    expect(run(gated(), [close("gate")]).derived).toEqual([]);
  });

  test("out-of-order events still resolve: the drop lands on the commit that completes the pair", () => {
    const closed = commit(gated(), [close("gate")]);
    const { derived } = run(closed, [outcome("gate", "accept")]);
    expect(derived.map((op) => op.op === "set_status" && op.node)).toEqual(["ignored"]);
  });

  /**
   * The mutant this kills is the whole design. As a post-state scan, every later commit
   * would re-derive `set_status(ignored, "dropped")` against a node terminal at head —
   * which invariant 1 refuses — and 422 every unrelated commit forever. That is exactly
   * the bug `validate.test.ts`'s "EXISTING edges into a terminal node" case pins.
   */
  test("an unrelated later commit derives nothing and is accepted", () => {
    const resolved = commit(gated(), [outcome("gate", "accept"), close("gate")]);
    const later = run(resolved, [task("Unrelated")]);
    expect(later.derived).toEqual([]);
    expect(run(later.graph, [task("Also unrelated")]).derived).toEqual([]);
  });

  test("a batch that both adds an edge and kills it derives nothing — it is refused instead", () => {
    // Covered as a refusal in validate.test.ts; here we pin that derivation never sees it.
    const graph = commit(gated(), [outcome("gate", "accept"), close("gate")]);
    const pre = graph;
    const post = applyOps(pre, [], pre.version + 1);
    expect(post.ok).toBe(true);
    if (!post.ok) throw new Error("unreachable");
    expect(resolveBranches(pre, post.value).drops).toEqual([]);
  });
});

describe("the cascade is transitive, and it stops where the spec says", () => {
  test("an untaken arm two deep drops both nodes", () => {
    const { derived, graph } = run(twoDeep(), [outcome("gate", "accept"), close("gate")]);
    expect(derived.map((op) => op.op === "set_status" && op.node)).toEqual(["b1", "b2"]);
    expect(nodeOf(graph, "b1").status.state).toBe("dropped");
    expect(nodeOf(graph, "b2").status.state).toBe("dropped");
  });

  test("each derived op names its own immediate cause, not the original gate", () => {
    const { derived } = run(twoDeep(), [outcome("gate", "accept"), close("gate")]);
    expect(derived.map((op) => op.op === "set_status" && op.evidence_ref)).toEqual([
      `${DERIVED_EVIDENCE_PREFIX}:gate`,
      `${DERIVED_EVIDENCE_PREFIX}:b1`,
    ]);
  });

  test("the taken arm is untouched", () => {
    const { graph } = run(twoDeep(), [outcome("gate", "accept"), close("gate")]);
    expect(nodeOf(graph, "a1").status.state).toBe("active");
    expect(nodeOf(graph, "a2").status.state).toBe("active");
  });

  /** §6.4: "It stops at a node still held by a live in-edge — a shared descendant." */
  test("a shared descendant with one live in-edge survives", () => {
    const { derived, graph } = run(twoDeep(), [outcome("gate", "accept"), close("gate")]);
    expect(derived.map((op) => op.op === "set_status" && op.node)).not.toContain("join");
    expect(nodeOf(graph, "join").status.state).toBe("active");
  });

  test("a root with no in-edges is never dropped", () => {
    const seed = commit(gated(), [task("Orphan")]);
    const { derived } = run(seed, [outcome("gate", "accept"), close("gate")]);
    expect(derived.map((op) => op.op === "set_status" && op.node)).toEqual(["ignored"]);
  });

  /**
   * The armed-pivot case. A node already terminal on a dead arm is NOT rewritten — the past
   * is not edited, and invariant 1 would refuse it anyway — but the arm is still dead, so
   * the cascade must keep walking. Stopping here leaves its successor with a satisfied
   * plain edge out of a `done` node, which puts it on the frontier and sends the email.
   */
  test("a node already done on a dead arm is not rewritten, but its successors still drop", () => {
    const withDone = commit(twoDeep(), [close("b1")]);
    const { derived, graph } = run(withDone, [outcome("gate", "accept"), close("gate")]);
    expect(derived.map((op) => op.op === "set_status" && op.node)).toEqual(["b2"]);
    expect(nodeOf(graph, "b1").status.state).toBe("done");
    expect(readyFrontier(graph).map((n) => n.id)).not.toContain("b2");
  });

  test("a SENDING node is withheld rather than dropped — and its successors still drop", () => {
    const sending = commit(twoDeep(), [close("b1", "sending")]);
    const { derived, withheld, graph } = run(sending, [outcome("gate", "accept"), close("gate")]);
    expect(withheld).toEqual(["b1"]);
    expect(derived.map((op) => op.op === "set_status" && op.node)).toEqual(["b2"]);
    expect(nodeOf(graph, "b1").status.state).toBe("sending");
  });

  test("a node the same batch set done is not dropped", () => {
    const { derived } = run(twoDeep(), [outcome("gate", "accept"), close("gate"), close("b1")]);
    expect(derived.map((op) => op.op === "set_status" && op.node)).toEqual(["b2"]);
  });
});

describe("§7 — untaken arm, two deep", () => {
  test("neither node appears on the frontier at any point", () => {
    const { graph } = run(twoDeep(), [outcome("gate", "accept"), close("gate")]);
    const frontier = readyFrontier(graph).map((n) => n.id);
    expect(frontier).not.toContain("b1");
    expect(frontier).not.toContain("b2");
    expect(frontier).toEqual(["a1"]);
  });

  test("the merge SATISFIES rather than hanging once the taken arm completes", () => {
    let graph = run(twoDeep(), [outcome("gate", "accept"), close("gate")]).graph;
    graph = commit(graph, [close("a1")]);
    graph = commit(graph, [close("a2")]);
    // `join` still carries a live-looking in-edge from b2, which is dropped. §6.4 excludes
    // it from merge evaluation, so the join is satisfied by the arm that was actually taken.
    expect(isReady(graph, nodeOf(graph, "join"))).toBe(true);
    expect(readyFrontier(graph).map((n) => n.id)).toContain("join");
  });

  test("a join loses its last live arm and is dropped, not left hanging", () => {
    const resolved = run(twoDeep(), [outcome("gate", "accept"), close("gate")]).graph;
    // Dropping `a1` kills its out-edge too, so the cascade takes `a2` — and `join`, whose
    // every blocking in-edge now originates at a dropped node. §6.4's transitive rule
    // reaches the merge itself; it does not stop one hop short and leave it unreachable.
    const { derived, graph } = run(resolved, [close("a1", "dropped")]);
    expect(derived.map((op) => op.op === "set_status" && op.node)).toEqual(["a2", "join"]);
    expect(isReady(graph, nodeOf(graph, "join"))).toBe(false);
    expect(readyFrontier(graph).map((n) => n.id)).not.toContain("join");
  });
});

describe("determinism — the log is the authority, not the code that wrote it", () => {
  test("validating the same batch twice yields byte-identical ops", () => {
    const graph = twoDeep();
    const ops: AuthoredOp[] = [outcome("gate", "accept"), close("gate")];
    expect(JSON.stringify(run(graph, ops).ops)).toBe(JSON.stringify(run(graph, ops).ops));
  });

  test("drops are emitted in node insertion order, never traversal order", () => {
    // `b2` is inserted before `b1` here, so a discovery-ordered implementation emits
    // b1 then b2 and this fails.
    const seed = seeded([
      task("B2"),
      task("B1"),
      task("Accepted"),
      wait("Gate", { on_timeout: "$0" }),
    ]);
    const wired = commit(seed, [
      { op: "add_edge", from: "gate", to: "accepted", condition: { on: "accept" } },
      { op: "add_edge", from: "gate", to: "b1", condition: { on: "ignore" } },
      { op: "add_edge", from: "b1", to: "b2" },
    ]);
    const { derived } = run(wired, [outcome("gate", "accept"), close("gate")]);
    expect(derived.map((op) => op.op === "set_status" && op.node)).toEqual(["b2", "b1"]);
  });

  /**
   * The property the whole "expand at commit time" decision exists to buy: replaying the
   * committed ops reproduces the graph `validate` previewed, with no derivation involved.
   */
  test("replaying the expanded ops reproduces the graph validate previewed", () => {
    const pre = twoDeep();
    const { ops, graph } = run(pre, [outcome("gate", "accept"), close("gate")]);
    const replayed = applyOps(pre, ops, pre.version + 1);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) throw new Error("unreachable");
    expect(JSON.stringify(projectGraph(replayed.value))).toBe(
      JSON.stringify(projectGraph(graph)),
    );
  });

  test("resolveBranches against an unchanged graph derives nothing", () => {
    const graph = emptyGraph(SCHEMA_VERSION);
    expect(resolveBranches(graph, graph)).toEqual({ drops: [], withheld: [] });
  });
});

/**
 * Mutation-hardening. Each test here exists because a specific mutant survived the first
 * suite; the comment names it. §7 sets the floor on `validate()` at 100 precisely because a
 * surviving mutant in this layer is a bad graph reaching the file.
 */
describe("hardening — mutants the behavioural suite did not kill", () => {
  /**
   * Kills `if (source.status.state === "failed") return false` -> `if (false)`.
   * The original `failed` test used a PLAIN edge, which returns false one line lower anyway,
   * so removing the clause changed nothing observable. A failed source with a RESOLVING
   * outcome and a non-matching condition is the only shape that separates the two.
   */
  test("a failed source with a resolved, non-matching outcome is still not dead", () => {
    const graph = commit(gated(), [outcome("gate", "accept"), close("gate", "failed")]);
    expect(nodeOf(graph, "gate").status.state).toBe("failed");
    expect(nodeOf(graph, "gate").status.outcome?.verdict).toBe("accept");
    // Were `failed` treated as dropped, this would be dead and `ignored` would be rewritten.
    expect(isEdgeDead(graph, { from: "gate", to: "ignored", condition: { on: "ignore" } })).toBe(
      false,
    );
  });

  test("a failed source does not drop its arm", () => {
    const { derived } = run(gated(), [outcome("gate", "accept"), close("gate", "failed")]);
    expect(derived).toEqual([]);
  });

  /**
   * Kills the `preKeys.has(edgeKey(edge))` clause and the `edgeKey` collapse mutants.
   * Reached by calling `resolveBranches` directly, because `validate` refuses a born-dead
   * edge at an earlier stage — which is the point: derivation must not act on one even if it
   * somehow arrives.
   */
  test("an edge that did not exist at head is never a seed, however dead it is", () => {
    const pre = commit(gated(), [outcome("gate", "accept"), close("gate")]);
    const fresh: CommittedOp[] = [
      {
        op: "add_node",
        id: "late",
        label: "Late",
        type: "task",
        spec: {
          instruction: "late",
          inputs: [],
          outputs: [],
          effect_class: "pure",
        },
      },
      { op: "add_edge", from: "gate", to: "late", condition: { on: "ignore" } },
    ];
    const post = applyOps(pre, fresh, pre.version + 1);
    expect(post.ok).toBe(true);
    if (!post.ok) throw new Error("unreachable");
    expect(isEdgeDead(post.value, { from: "gate", to: "late", condition: { on: "ignore" } })).toBe(
      true,
    );
    // Dead, and still not derived from: it was born dead, so refusing it is the store's
    // answer, not silently dropping the node the author has just written.
    expect(resolveBranches(pre, post.value).drops).toEqual([]);
  });

  /**
   * Kills `if (deadArm.has(id)) continue` -> `if (false)`, which without the guard revisits a
   * node forever once a cycle sits on a dead arm. Nothing forbids a cycle: `add_edge` refuses
   * only a self-edge and an exact duplicate.
   */
  test("a cycle on a dead arm terminates", () => {
    const seed = seeded([
      task("Accepted"),
      task("X"),
      task("Y"),
      wait("Gate", { on_timeout: "$0" }),
    ]);
    const wired = commit(seed, [
      { op: "add_edge", from: "gate", to: "accepted", condition: { on: "accept" } },
      { op: "add_edge", from: "gate", to: "x", condition: { on: "ignore" } },
      { op: "add_edge", from: "x", to: "y" },
      { op: "add_edge", from: "y", to: "x" },
    ]);
    const { derived } = run(wired, [outcome("gate", "accept"), close("gate")]);
    // `x` is held by a live-looking in-edge from `y`, which is itself reachable only through
    // `x`. The fixpoint is conservative and drops neither, rather than looping.
    expect(derived).toEqual([]);
  });

  /**
   * Kills the `||` -> `&&` mutant in `dropCause`. `j` has two in-edges: one from `b1`, which
   * is on the dead arm but not yet dropped in the interim graph, and one from `b2`, which is
   * dead outright. Only the `||` reading names the first.
   */
  test("the drop cause is the first in-edge that is dead OR on a dead arm", () => {
    const seed = seeded([
      task("Accepted"),
      task("B1"),
      task("B2"),
      task("J"),
      wait("Gate", { on_timeout: "$0" }),
    ]);
    const wired = commit(seed, [
      { op: "add_edge", from: "gate", to: "accepted", condition: { on: "accept" } },
      { op: "add_edge", from: "gate", to: "b1", condition: { on: "ignore" } },
      { op: "add_edge", from: "b1", to: "j" },
      { op: "add_edge", from: "gate", to: "b2", condition: { on: "ignore" } },
      { op: "add_edge", from: "b2", to: "j" },
    ]);
    const { derived } = run(wired, [outcome("gate", "accept"), close("gate")]);
    const causes = Object.fromEntries(
      derived.flatMap((op) => (op.op === "set_status" ? [[op.node, op.evidence_ref]] : [])),
    );
    expect(causes["j"]).toBe(`${DERIVED_EVIDENCE_PREFIX}:b1`);
    expect(causes["b1"]).toBe(`${DERIVED_EVIDENCE_PREFIX}:gate`);
  });

  /**
   * `set_status.evidence_ref` is now a shared channel: the outbox encodes reserve/record
   * transitions through it (§6.6, "there is no seventh op"), and branch resolution stamps
   * its cause through it too. They must not collide — a derived drop that parsed as an
   * outbox transition would materialise a phantom reservation on a node nobody sent to.
   */
  test("a derived drop's evidence_ref is not mistaken for an outbox transition", () => {
    const { derived, graph } = run(gated(), [outcome("gate", "accept"), close("gate")]);
    const ref = derived[0]?.op === "set_status" ? derived[0].evidence_ref : "";
    expect(ref.startsWith(DERIVED_EVIDENCE_PREFIX)).toBe(true);
    expect(parseEffectEvidence(ref)).toBeNull();
    expect(nodeOf(graph, "ignored").status.effect_log).toEqual([]);
  });

  test("isDroppable gates emission and is read per node", () => {
    const graph = gated();
    expect(isDroppable(nodeOf(graph, "ignored"))).toBe(true);
    expect(isDroppable(nodeOf(graph, "accepted"))).toBe(true);
  });
});
