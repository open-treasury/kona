/**
 * T2.6 — branch resolution. §6.4: "When a `acceptEvent` resolves, the store marks the target of
 * every untaken out-edge `withdrawn`, transitively."
 *
 * The thing under test is not just the drop set but *where* it is computed. Derivation
 * happens ONCE, at commit, and is expanded into explicit ops in the log; `fold` stays a
 * dumb replay. The determinism suite below is what pins that: a log folded next month, by
 * code with a different drop rule, must still produce the graph the human approved.
 */

import { describe, expect, test } from "bun:test";
import type { AuthoredOp, BehaviourNode, CommittedOp, Graph, Verdict } from "../src/index.ts";
import {
  DERIVED_EVIDENCE_PREFIX,
  applyOps,
  isArmDead,
  emptyGraph,
  isDroppable,
  isEdgeDead,
  isReady,
  parseEffectEvidence,
  projectGraph,
  readyFrontier,
  resolveBranches,
  SCHEMA_VERSION,
} from "../src/index.ts";
import {
  ORCHESTRATOR,
  commit,
  seeded,
  action,
  acceptEvent,
  activityAt,
  resolveSlugs,
  slugOr,
  slugOf,
  nid,
  validateFragment,
} from "./fixtures.ts";

function run(graph: Graph, ops: AuthoredOp[]) {
  const result = validateFragment({
    graph,
    ops: resolveSlugs(graph, ops),
    actor: ORCHESTRATOR,
    version: graph.version + 1,
    prefix: "t",
  });
  if (!result.ok) {
    throw new Error(`rejected: ${result.rejection.reason} ${result.rejection.message}`);
  }
  return result.value;
}

function activityOf(graph: Graph, id: string): BehaviourNode {
  // Narrowed, not asserted: under D6 a control node has no status at all, and every use of
  // this helper is about work. A test reaching for a diamond's status has asked the wrong
  // question and should say so loudly rather than compare two undefineds.
  const activity = activityAt(graph, id);
  if (activity === undefined) throw new Error(`no node ${id}`);
  if (activity.status === undefined)
    throw new Error(`${id} is a ${activity.type}, which carries no status`);
  return activity;
}

function outcome(node: string, verdict: Verdict): AuthoredOp {
  return { op: "record_outcome", node, verdict, evidence_ref: "<m-1>" };
}

function close(node: string, status = "completed"): AuthoredOp {
  return { op: "set_status", node, status, evidence_ref: "<m-1>" } as AuthoredOp;
}

/** `gate` is a acceptEvent with one `accept` arm and one `ignore` arm. */
function gated(): Graph {
  return commit(seeded([action("Accepted"), action("Ignored"), acceptEvent("Gate", {})]), [
    { op: "add_edge", from: "gate", to: "accepted", guard: { on: "accept" } },
    { op: "add_edge", from: "gate", to: "ignored", guard: { on: "ignore" } },
  ]);
}

/**
 * gate --accept--> a1 --> pivot, gate --ignore--> b1 --> pivot, with a shared descendant.
 *
 * The `merge` argument is gone with the field. Convergence is conjunctive now — the
 * disjunction `merge:"any"` expressed is a `merge` NODE, whose own semantics are tested in
 * activity-model.test.ts — so both former cases collapse onto this one shape, which is what
 * the old `merge:"all"` case already was.
 */
function shared(): Graph {
  const seed = seeded([action("A1"), action("B1"), action("Pivot"), acceptEvent("Gate", {})]);
  return commit(seed, [
    { op: "add_edge", from: "gate", to: "a1", guard: { on: "accept" } },
    { op: "add_edge", from: "gate", to: "b1", guard: { on: "ignore" } },
    { op: "add_edge", from: "a1", to: "pivot" },
    { op: "add_edge", from: "b1", to: "pivot" },
  ]);
}

/** The §7 shape: two arms two deep, rejoining at a merge. */
function twoDeep(): Graph {
  const seed = seeded([
    action("A1"),
    action("A2"),
    action("B1"),
    action("B2"),
    action("Join"),
    acceptEvent("Gate", {}),
  ]);
  return commit(seed, [
    { op: "add_edge", from: "gate", to: "a1", guard: { on: "accept" } },
    { op: "add_edge", from: "a1", to: "a2" },
    { op: "add_edge", from: "gate", to: "b1", guard: { on: "ignore" } },
    { op: "add_edge", from: "b1", to: "b2" },
    { op: "add_edge", from: "a2", to: "join" },
    { op: "add_edge", from: "b2", to: "join" },
  ]);
}

/**
 * The CASCADE's own ops, which is what every test in this file is about.
 *
 * `ValidateOutput.derived` is all store-derived ops, and since §6.2.1 that includes the
 * readiness derivation as well as the withdrawals. Both are store-written and both must be in
 * that field — invariant 2's mechanical-closure exemption reads it, and an op missing from it
 * costs a legitimate batch its exemption. So the tests narrow rather than the field.
 */
function withdrawals(ops: readonly CommittedOp[]): CommittedOp[] {
  return ops.filter((op) => op.op === "set_status" && op.status === "withdrawn");
}

describe("isEdgeDead — the trichotomy is satisfied | pending | dead", () => {
  test("an edge whose source is still open is pending, not dead", () => {
    expect(isEdgeDead(gated(), { from: "gate", to: "ignored", guard: { on: "ignore" } })).toBe(
      false,
    );
  });

  test("a resolved gate kills exactly the arms it did not take", () => {
    const graph = commit(gated(), [outcome("gate", "accept"), close("gate")]);
    expect(
      isEdgeDead(graph, {
        from: slugOr(graph, "gate"),
        to: slugOr(graph, "accepted"),
        guard: { on: "accept" },
      }),
    ).toBe(false);
    expect(
      isEdgeDead(graph, {
        from: slugOr(graph, "gate"),
        to: slugOr(graph, "ignored"),
        guard: { on: "ignore" },
      }),
    ).toBe(true);
  });

  /**
   * The old single `dropped` is now two states, and `isEdgeDead` asks only "was this
   * abandoned", so both must kill the edge. Both are pinned, because only one of them is a
   * status an author may write: §6.2.1 refuses authored `withdrawn`, so it is reached the one
   * way it is ever reached in production — the cascade.
   */
  test("an ABANDONED source kills every out-edge, conditioned or not", () => {
    const graph = commit(gated(), [close("ignored", "terminated")]);
    expect(
      isEdgeDead(graph, { from: slugOr(graph, "ignored"), to: slugOr(graph, "accepted") }),
    ).toBe(true);

    const derived = commit(gated(), [outcome("gate", "accept"), close("gate")]);
    expect(activityOf(derived, "ignored").status.state).toBe("withdrawn");
    expect(
      isEdgeDead(derived, { from: slugOr(derived, "ignored"), to: slugOr(derived, "accepted") }),
    ).toBe(true);
  });

  /**
   * §6.2 keeps `failed` and abandoned distinct — "tried, didn't work" vs "we stopped
   * wanting this". A subtree under a visibly failed activity is a human's to look at; deleting
   * it silently is the one thing worse than leaving it stuck.
   */
  test("a FAILED source is not dead, even though it can never satisfy", () => {
    const graph = commit(gated(), [close("ignored", "failed")]);
    expect(
      isEdgeDead(graph, { from: slugOr(graph, "ignored"), to: slugOr(graph, "accepted") }),
    ).toBe(false);
  });

  test("a plain edge out of a completed source is satisfied, never dead", () => {
    const graph = commit(gated(), [outcome("gate", "accept"), close("gate")]);
    expect(isEdgeDead(graph, { from: slugOr(graph, "gate"), to: slugOr(graph, "accepted") })).toBe(
      false,
    );
  });

  test("completed but not yet resolved is pending — the outcome may land in a later commit", () => {
    const graph = commit(gated(), [close("gate")]);
    expect(
      isEdgeDead(graph, {
        from: slugOr(graph, "gate"),
        to: slugOr(graph, "ignored"),
        guard: { on: "ignore" },
      }),
    ).toBe(false);
  });

  test("a tentative outcome does not resolve, so it kills nothing", () => {
    const graph = commit(gated(), [outcome("gate", "tentative"), close("gate")]);
    expect(
      isEdgeDead(graph, {
        from: slugOr(graph, "gate"),
        to: slugOr(graph, "ignored"),
        guard: { on: "ignore" },
      }),
    ).toBe(false);
  });

  test("an edge from an activity that does not exist is never dead", () => {
    expect(isEdgeDead(gated(), { from: "ghost", to: "accepted" })).toBe(false);
  });
});

describe("isDroppable — what the store may rewrite", () => {
  test("an ordinary unclaimed activity is droppable", () => {
    expect(isDroppable(activityOf(gated(), "ignored"))).toBe(true);
  });

  test("an ACTIVE activity is not — §6.6, the world's answer is unknown", () => {
    const graph = gated();
    activityOf(graph, "ignored").status.state = "active";
    expect(isDroppable(activityOf(graph, "ignored"))).toBe(false);
  });

  test("an activity that already moved bytes is not", () => {
    const graph = gated();
    activityOf(graph, "ignored").status.effect_log.push({
      effect_key: "ek_1",
      payload_hash: "h1",
      attempted_at: "2026-08-21T10:00:00.000Z",
      completed_at: "2026-08-21T10:00:01.000Z",
      outcome: "sent",
      message_id: "<m-1>",
    });
    expect(isDroppable(activityOf(graph, "ignored"))).toBe(false);
  });
});

describe("the trigger is an op-delta, never a post-state scan", () => {
  test("resolving a gate derives a drop for the untaken arm", () => {
    const head = gated();
    const {
      ops,
      derived: allDerived,
      graph,
    } = run(head, [outcome("gate", "accept"), close("gate")]);
    const derived = withdrawals(allDerived);
    expect(derived).toHaveLength(1);
    expect(derived[0]).toEqual({
      op: "set_status",
      node: nid(head, "ignored"),
      status: "withdrawn",
      evidence_ref: `${DERIVED_EVIDENCE_PREFIX}:${nid(head, "gate")}`,
    });
    // The authored ops keep their positions; derivation only ever appends. Four now, not
    // three: the two authored ops, the withdrawal, and the §6.2.1 readiness op that lifts
    // `accepted` off `inactive` now that the arm it sits on was taken.
    expect(ops).toHaveLength(4);
    expect(activityOf(graph, "ignored").status.state).toBe("withdrawn");
    expect(activityOf(graph, "accepted").status.state).toBe("ready");
  });

  test("recording the outcome without closing the acceptEvent derives nothing", () => {
    expect(withdrawals(run(gated(), [outcome("gate", "accept")]).derived)).toEqual([]);
  });

  test("closing the acceptEvent without an outcome derives nothing", () => {
    expect(withdrawals(run(gated(), [close("gate")]).derived)).toEqual([]);
  });

  test("out-of-order events still resolve: the drop lands on the commit that completes the pair", () => {
    const closed = commit(gated(), [close("gate")]);
    const derived = withdrawals(run(closed, [outcome("gate", "accept")]).derived);
    expect(derived.map((op) => op.op === "set_status" && slugOf(op.node))).toEqual(["ignored"]);
  });

  /**
   * The mutant this kills is the whole design. As a post-state scan, every later commit
   * would re-derive `set_status(ignored, "withdrawn")` against an activity terminal at head —
   * which invariant 1 refuses — and 422 every unrelated commit forever. That is exactly
   * the bug `validate.test.ts`'s "EXISTING edges into a terminal activity" case pins.
   */
  test("an unrelated later commit derives nothing and is accepted", () => {
    const resolved = commit(gated(), [outcome("gate", "accept"), close("gate")]);
    const later = run(resolved, [action("Unrelated")]);
    expect(withdrawals(later.derived)).toEqual([]);
    expect(withdrawals(run(later.graph, [action("Also unrelated")]).derived)).toEqual([]);
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
  test("an untaken arm two deep drops both activities", () => {
    const { derived: allDerived, graph } = run(twoDeep(), [
      outcome("gate", "accept"),
      close("gate"),
    ]);
    const derived = withdrawals(allDerived);
    expect(derived.map((op) => op.op === "set_status" && slugOf(op.node))).toEqual(["b1", "b2"]);
    expect(activityOf(graph, "b1").status.state).toBe("withdrawn");
    expect(activityOf(graph, "b2").status.state).toBe("withdrawn");
  });

  test("each derived op names its own immediate cause, not the original gate", () => {
    const derived = withdrawals(run(twoDeep(), [outcome("gate", "accept"), close("gate")]).derived);
    // The ref names the activity that caused each drop, so it carries a minted id; translate it
    // back rather than spelling it.
    expect(
      derived.map((op) =>
        op.op === "set_status"
          ? `${DERIVED_EVIDENCE_PREFIX}:${String(slugOf(op.evidence_ref.slice(DERIVED_EVIDENCE_PREFIX.length + 1)))}`
          : "",
      ),
    ).toEqual([`${DERIVED_EVIDENCE_PREFIX}:gate`, `${DERIVED_EVIDENCE_PREFIX}:b1`]);
  });

  test("the taken arm is untouched", () => {
    const { graph } = run(twoDeep(), [outcome("gate", "accept"), close("gate")]);
    // Untouched by the cascade, and each at the depth it has earned: `a1`'s in-edge out of the
    // gate is satisfied, so it is on the frontier; `a2` still blocks on `a1`.
    expect(activityOf(graph, "a1").status.state).toBe("ready");
    expect(activityOf(graph, "a2").status.state).toBe("inactive");
  });

  /** §6.4: "It stops at an activity still held by a live in-edge — a shared descendant." */
  test("a shared descendant with one live in-edge survives", () => {
    const { derived: allDerived, graph } = run(twoDeep(), [
      outcome("gate", "accept"),
      close("gate"),
    ]);
    const derived = withdrawals(allDerived);
    expect(derived.map((op) => op.op === "set_status" && slugOf(op.node))).not.toContain("join");
    // Survives means NOT withdrawn: still blocked behind the live `a2` arm, so `inactive`.
    expect(activityOf(graph, "join").status.state).toBe("inactive");
  });

  test("a root with no in-edges is never withdrawn", () => {
    const seed = commit(gated(), [action("Orphan")]);
    const derived = withdrawals(run(seed, [outcome("gate", "accept"), close("gate")]).derived);
    expect(derived.map((op) => op.op === "set_status" && slugOf(op.node))).toEqual(["ignored"]);
  });

  /**
   * The armed-pivot case. An activity already terminal on a dead arm is NOT rewritten — the past
   * is not edited, and invariant 1 would refuse it anyway — but the arm is still dead, so
   * the cascade must keep walking. Stopping here leaves its successor with a satisfied
   * plain edge out of a `completed` activity, which puts it on the frontier and sends the email.
   */
  test("an activity already completed on a dead arm is not rewritten, but its successors still drop", () => {
    const withDone = commit(twoDeep(), [close("b1")]);
    const { derived: allDerived, graph } = run(withDone, [
      outcome("gate", "accept"),
      close("gate"),
    ]);
    const derived = withdrawals(allDerived);
    expect(derived.map((op) => op.op === "set_status" && slugOf(op.node))).toEqual(["b2"]);
    expect(activityOf(graph, "b1").status.state).toBe("completed");
    expect(readyFrontier(graph).map((n) => slugOf(n.id))).not.toContain("b2");
  });

  test("an ACTIVE activity is withheld rather than withdrawn — and its successors still drop", () => {
    const claimed = twoDeep();
    activityOf(claimed, "b1").status.state = "active";
    const {
      derived: allDerived,
      withheld,
      graph,
    } = run(claimed, [outcome("gate", "accept"), close("gate")]);
    const derived = withdrawals(allDerived);
    expect(withheld.map(slugOf)).toEqual(["b1"]);
    expect(derived.map((op) => op.op === "set_status" && slugOf(op.node))).toEqual(["b2"]);
    expect(activityOf(graph, "b1").status.state).toBe("active");
  });

  test("an activity the same batch set completed is not withdrawn", () => {
    const derived = withdrawals(
      run(twoDeep(), [outcome("gate", "accept"), close("gate"), close("b1")]).derived,
    );
    expect(derived.map((op) => op.op === "set_status" && slugOf(op.node))).toEqual(["b2"]);
  });
});

describe("§7 — untaken arm, two deep", () => {
  test("neither activity appears on the frontier at any point", () => {
    const { graph } = run(twoDeep(), [outcome("gate", "accept"), close("gate")]);
    const frontier = readyFrontier(graph).map((n) => n.id);
    expect(frontier.map(slugOf)).not.toContain("b1");
    expect(frontier.map(slugOf)).not.toContain("b2");
    expect(frontier.map(slugOf)).toEqual(["a1"]);
  });

  test("the merge SATISFIES rather than hanging once the taken arm completes", () => {
    let graph = run(twoDeep(), [outcome("gate", "accept"), close("gate")]).graph;
    graph = commit(graph, [close("a1")]);
    graph = commit(graph, [close("a2")]);
    // `join` still carries a live-looking in-edge from b2, which is dropped. §6.4 excludes
    // it from merge evaluation, so the join is satisfied by the arm that was actually taken.
    expect(isReady(graph, activityOf(graph, "join"))).toBe(true);
    expect(readyFrontier(graph).map((n) => slugOf(n.id))).toContain("join");
  });

  test("a join loses its last live arm and is withdrawn, not left hanging", () => {
    const resolved = run(twoDeep(), [outcome("gate", "accept"), close("gate")]).graph;
    // Abandoning `a1` kills its out-edge too, so the cascade takes `a2` — and `join`, whose
    // every blocking in-edge now originates at an abandoned activity. §6.4's transitive rule
    // reaches the merge itself; it does not stop one hop short and leave it unreachable.
    // Authored as `terminated`: `withdrawn` is the store's to write, never an author's.
    const { derived: allDerived, graph } = run(resolved, [close("a1", "terminated")]);
    const derived = withdrawals(allDerived);
    expect(derived.map((op) => op.op === "set_status" && slugOf(op.node))).toEqual(["a2", "join"]);
    expect(isReady(graph, activityOf(graph, "join"))).toBe(false);
    expect(readyFrontier(graph).map((n) => slugOf(n.id))).not.toContain("join");
  });
});

describe("determinism — the log is the authority, not the code that wrote it", () => {
  test("validating the same batch twice yields byte-identical ops", () => {
    const graph = twoDeep();
    const ops: AuthoredOp[] = [outcome("gate", "accept"), close("gate")];
    expect(JSON.stringify(run(graph, ops).ops)).toBe(JSON.stringify(run(graph, ops).ops));
  });

  test("drops are emitted in activity insertion order, never traversal order", () => {
    // `b2` is inserted before `b1` here, so a discovery-ordered implementation emits
    // b1 then b2 and this fails.
    const seed = seeded([action("B2"), action("B1"), action("Accepted"), acceptEvent("Gate", {})]);
    const wired = commit(seed, [
      { op: "add_edge", from: "gate", to: "accepted", guard: { on: "accept" } },
      { op: "add_edge", from: "gate", to: "b1", guard: { on: "ignore" } },
      { op: "add_edge", from: "b1", to: "b2" },
    ]);
    const derived = withdrawals(run(wired, [outcome("gate", "accept"), close("gate")]).derived);
    expect(derived.map((op) => op.op === "set_status" && slugOf(op.node))).toEqual(["b2", "b1"]);
  });

  /**
   * The property the whole "expand at commit time" decision exists to buy: replaying the
   * committed ops reproduces the graph `validate` previewed, with no derivation involved.
   */
  test("replaying the expanded ops reproduces the graph validate previewed", () => {
    const pre = twoDeep();
    const { ops, graph } = run(pre, [outcome("gate", "accept"), close("gate")]);
    const replayed = applyOps(pre, resolveSlugs(pre, ops) as CommittedOp[], pre.version + 1);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) throw new Error("unreachable");
    expect(JSON.stringify(projectGraph(replayed.value))).toBe(JSON.stringify(projectGraph(graph)));
  });

  test("resolveBranches against an unchanged graph derives nothing", () => {
    const graph = emptyGraph(SCHEMA_VERSION);
    expect(resolveBranches(graph, graph)).toEqual({ drops: [], withheld: [] });
  });
});

/**
 * Mutation-hardening. Each test here exists because a specific mutant survived the first
 * suite; the comment names it. §7 sets the floor on `validateFragment()` at 100 precisely because a
 * surviving mutant in this layer is a bad graph reaching the file.
 */
describe("hardening — mutants the behavioural suite did not kill", () => {
  /**
   * Kills `if (source.status?.state === "failed") return false` -> `if (false)`.
   * The original `failed` test used a PLAIN edge, which returns false one line lower anyway,
   * so removing the clause changed nothing observable. A failed source with a RESOLVING
   * outcome and a non-matching guard is the only shape that separates the two.
   */
  test("a failed source with a resolved, non-matching outcome is still not dead", () => {
    const graph = commit(gated(), [outcome("gate", "accept"), close("gate", "failed")]);
    expect(activityOf(graph, "gate").status.state).toBe("failed");
    expect(activityOf(graph, "gate").status.outcome?.verdict).toBe("accept");
    // Were `failed` treated as dropped, this would be dead and `ignored` would be rewritten.
    expect(
      isEdgeDead(graph, {
        from: slugOr(graph, "gate"),
        to: slugOr(graph, "ignored"),
        guard: { on: "ignore" },
      }),
    ).toBe(false);
  });

  test("a failed source does not drop its arm", () => {
    const derived = withdrawals(
      run(gated(), [outcome("gate", "accept"), close("gate", "failed")]).derived,
    );
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
        name: "Late",
        type: "action",
        spec: {
          instruction: "late",
          inputs: [],
          outputs: [],
          effect_class: "pure",
        },
      },
      { op: "add_edge", from: "gate", to: "late", guard: { on: "ignore" } },
    ];
    const post = applyOps(pre, resolveSlugs(pre, fresh) as CommittedOp[], pre.version + 1);
    expect(post.ok).toBe(true);
    if (!post.ok) throw new Error("unreachable");
    expect(
      isEdgeDead(post.value, {
        from: slugOr(post.value, "gate"),
        to: slugOr(post.value, "late"),
        guard: { on: "ignore" },
      }),
    ).toBe(true);
    // Dead, and still not derived from: it was born dead, so refusing it is the store's
    // answer, not silently dropping the activity the author has just written.
    expect(resolveBranches(pre, post.value).drops).toEqual([]);
  });

  /**
   * Kills `if (deadArm.has(id)) continue` -> `if (false)`, which without the guard revisits a
   * activity forever once a cycle sits on a dead arm. Nothing forbids a cycle: `add_edge` refuses
   * only a self-edge and an exact duplicate.
   */
  test("a cycle on a dead arm terminates", () => {
    const seed = seeded([action("Accepted"), action("X"), action("Y"), acceptEvent("Gate", {})]);
    const wired = commit(seed, [
      { op: "add_edge", from: "gate", to: "accepted", guard: { on: "accept" } },
      { op: "add_edge", from: "gate", to: "x", guard: { on: "ignore" } },
      { op: "add_edge", from: "x", to: "y" },
      { op: "add_edge", from: "y", to: "x" },
    ]);
    const derived = withdrawals(run(wired, [outcome("gate", "accept"), close("gate")]).derived);
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
      action("Accepted"),
      action("B1"),
      action("B2"),
      action("J"),
      acceptEvent("Gate", {}),
    ]);
    const wired = commit(seed, [
      { op: "add_edge", from: "gate", to: "accepted", guard: { on: "accept" } },
      { op: "add_edge", from: "gate", to: "b1", guard: { on: "ignore" } },
      { op: "add_edge", from: "b1", to: "j" },
      { op: "add_edge", from: "gate", to: "b2", guard: { on: "ignore" } },
      { op: "add_edge", from: "b2", to: "j" },
    ]);
    const derived = withdrawals(run(wired, [outcome("gate", "accept"), close("gate")]).derived);
    const causes = Object.fromEntries(
      derived.flatMap((op) =>
        op.op === "set_status"
          ? [
              [
                String(slugOf(op.node)),
                `${DERIVED_EVIDENCE_PREFIX}:${String(slugOf(op.evidence_ref.slice(DERIVED_EVIDENCE_PREFIX.length + 1)))}`,
              ],
            ]
          : [],
      ),
    );
    expect(causes["j"]).toBe(`${DERIVED_EVIDENCE_PREFIX}:b1`);
    expect(causes["b1"]).toBe(`${DERIVED_EVIDENCE_PREFIX}:gate`);
  });

  /**
   * `set_status.evidence_ref` is now a shared channel: the outbox encodes reserve/record
   * transitions through it (§6.6, "there is no seventh op"), and branch resolution stamps
   * its cause through it too. They must not collide — a derived drop that parsed as an
   * outbox transition would materialise a phantom reservation on an activity nobody sent to.
   */
  test("a derived drop's evidence_ref is not mistaken for an outbox transition", () => {
    const { derived: allDerived, graph } = run(gated(), [outcome("gate", "accept"), close("gate")]);
    const derived = withdrawals(allDerived);
    const ref = derived[0]?.op === "set_status" ? derived[0].evidence_ref : "";
    expect(ref.startsWith(DERIVED_EVIDENCE_PREFIX)).toBe(true);
    expect(parseEffectEvidence(ref)).toBeNull();
    expect(activityOf(graph, "ignored").status.effect_log).toEqual([]);
  });

  test("isDroppable gates emission and is read per activity", () => {
    const graph = gated();
    expect(isDroppable(activityOf(graph, "ignored"))).toBe(true);
    expect(isDroppable(activityOf(graph, "accepted"))).toBe(true);
  });
});

describe("hardening — edge identity and the evidence stamp", () => {
  /**
   * `edgeKey` is what makes "existed at head" mean anything. Collapse it — to a constant, or
   * by dropping the guard — and every edge in `post` looks like an edge from `pre`, so a
   * branch the batch just authored would be derived from and its target born dropped.
   */
  test("a NEW edge is not mistaken for a pre-existing one, even beside a similar edge", () => {
    const pre = commit(gated(), [outcome("gate", "accept"), close("gate")]);
    const fresh: CommittedOp[] = [
      {
        op: "add_node",
        id: "late",
        name: "Late",
        type: "action",
        spec: { instruction: "late", inputs: [], outputs: [], effect_class: "pure" },
      },
      { op: "add_edge", from: "gate", to: "late", guard: { on: "ignore" } },
    ];
    const post = applyOps(
      pre,
      resolveSlugs(pre, fresh) as CommittedOp[],
      pre.version + 1,
      "2026-08-21T12:00:00.000Z",
    );
    expect(post.ok).toBe(true);
    if (!post.ok) throw new Error("unreachable");
    // `pre` already holds `gate -> accepted {accept}` and `gate -> ignored {ignore}`, so a
    // key that ignored the endpoints or the guard would match this new edge against one
    // of them and drop `late`.
    expect(resolveBranches(pre, post.value).drops).toEqual([]);
  });

  /**
   * The prefix is a wire format, not an implementation detail: `kona graph --json` and the
   * viewer both separate the store's housekeeping from authored ops by reading it, and §6.6's
   * outbox now shares this same field. Asserted as a literal, so changing the constant fails
   * here rather than silently in whatever greps for it.
   */
  test("the derived evidence_ref is a stable literal", () => {
    const graph = gated();
    const derived = withdrawals(run(graph, [outcome("gate", "accept"), close("gate")]).derived);
    const ref = derived[0]?.op === "set_status" ? derived[0].evidence_ref : "";
    // The ref names the activity that CAUSED the drop, so it carries a minted id. The constant
    // is what this asserts; the id is read back rather than written down.
    expect(ref).toBe(`derived:branch-resolution:${nid(graph, "gate")}`);
  });

  test("and it names the immediate cause at every depth", () => {
    const graph = twoDeep();
    const derived = withdrawals(run(graph, [outcome("gate", "accept"), close("gate")]).derived);
    expect(
      derived.map((op) =>
        op.op === "set_status"
          ? `${String(slugOf(op.node))}=${String(slugOf(op.evidence_ref.split(":").pop()))}`
          : "",
      ),
    ).toEqual(["b1=gate", "b2=b1"]);
  });
});

/**
 * Arm-death — the readiness half of branch resolution.
 *
 * The cascade deliberately does not rewrite an activity that is already terminal, or one that is
 * `active`. Those activities then sit on a dead arm wearing a live-looking status, their plain
 * out-edges read as SATISFIED, and beneath a `merge` one of them alone puts a shared
 * descendant on the frontier — which §6.8 says is what gets it dispatched, pivot send
 * included. Dropping cannot answer this: an `active` activity completing later makes no edge
 * newly dead, so no commit-time derivation ever sees it.
 */
describe("arm-death (§6.4, read side)", () => {
  test("a root blocking on nothing is never arm-dead", () => {
    expect(isArmDead(gated(), "gate")).toBe(false);
  });

  test("nothing is arm-dead while the gate is still open", () => {
    const graph = shared();
    expect(isArmDead(graph, slugOr(graph, "b1"))).toBe(false);
    expect(isArmDead(graph, slugOr(graph, "a1"))).toBe(false);
  });

  test("the untaken arm becomes arm-dead once the gate resolves", () => {
    const graph = run(shared(), [outcome("gate", "accept"), close("gate")]).graph;
    expect(isArmDead(graph, slugOr(graph, "b1"))).toBe(true);
    expect(isArmDead(graph, slugOr(graph, "a1"))).toBe(false);
  });

  /**
   * The reproduction, rewritten for the shape that survives.
   *
   * `b1` is marked `completed` out of band on the arm that will NOT be taken, so the cascade
   * cannot rewrite it — invariant 1 protects a terminal node — and its plain edge into the
   * pivot reads as SATISFIED forever. Under the old `merge: "any"` field that alone put the
   * pivot on the frontier, and the pivot is the step that sends. That specific bug cannot
   * happen now, because the field is gone and convergence is conjunctive.
   *
   * What is still worth pinning is the rule underneath it: an arm-dead in-edge is EXCLUDED
   * from readiness (§6.4), and exclusion must never be mistaken for satisfaction. With only
   * `b1` finished, the pivot must stay off the frontier — `a1` has not run, and `b1`'s arm is
   * over. If exclusion were satisfaction, an untaken branch would dispatch the pivot's send.
   */
  test("an arm-dead in-edge is excluded from readiness, and exclusion is not satisfaction", () => {
    const withDone = commit(shared(), [close("b1")]);
    // Before the gate resolves, nothing is dead and the pivot simply waits on `a1`.
    expect(isReady(withDone, activityOf(withDone, "pivot"))).toBe(false);

    const graph = run(withDone, [outcome("gate", "accept"), close("gate")]).graph;
    // The cascade left `b1` alone — it was already terminal — so its edge still looks satisfied.
    expect(activityOf(graph, "b1").status.state).toBe("completed");
    expect(isArmDead(graph, slugOr(graph, "b1"))).toBe(true);

    // And the pivot is STILL not ready: `a1` is on the taken arm and has not run.
    expect(activityOf(graph, "a1").status.state).toBe("ready");
    expect(isReady(graph, activityOf(graph, "pivot"))).toBe(false);
  });

  /**
   * The outbox path, which commit-time derivation provably cannot catch: `b1` is `active`
   * when the gate resolves, so it is withheld; the send then completes normally, and that
   * batch makes no edge newly dead, so nothing re-seeds.
   */
  test("nor does an ACTIVE activity that later completes", () => {
    const claimed = shared();
    activityOf(claimed, "b1").status.state = "active";
    const resolved = run(claimed, [outcome("gate", "accept"), close("gate")]);
    expect(resolved.withheld.map(slugOf)).toEqual(["b1"]);

    const completed = commit(resolved.graph, [close("b1")]);
    expect(isReady(completed, activityOf(completed, "pivot"))).toBe(false);
    expect(readyFrontier(completed).map((n) => slugOf(n.id))).toEqual(["a1"]);
  });

  test("the taken arm still opens the descendant normally", () => {
    let graph = run(shared(), [outcome("gate", "accept"), close("gate")]).graph;
    graph = commit(graph, [close("a1")]);
    expect(isReady(graph, activityOf(graph, "pivot"))).toBe(true);
  });

  test("conjunctive convergence was never exposed to this, and still is not", () => {
    const withDone = commit(shared(), [close("b1")]);
    const graph = run(withDone, [outcome("gate", "accept"), close("gate")]).graph;
    expect(isReady(graph, activityOf(graph, "pivot"))).toBe(false);
  });

  test("a cycle is mutual dependency, not death — the predicate stays total", () => {
    const seed = seeded([action("Accepted"), action("X"), action("Y"), acceptEvent("Gate", {})]);
    const wired = commit(seed, [
      { op: "add_edge", from: "gate", to: "accepted", guard: { on: "accept" } },
      { op: "add_edge", from: "gate", to: "x", guard: { on: "ignore" } },
      { op: "add_edge", from: "x", to: "y" },
      { op: "add_edge", from: "y", to: "x" },
    ]);
    const graph = run(wired, [outcome("gate", "accept"), close("gate")]).graph;
    expect(isArmDead(graph, slugOr(graph, "x"))).toBe(false);
    expect(isArmDead(graph, slugOr(graph, "y"))).toBe(false);
  });

  test("an activity whose every in-edge comes from a withdrawn source is arm-dead, and not ready", () => {
    const graph = run(twoDeep(), [outcome("gate", "accept"), close("gate")]).graph;
    expect(isArmDead(graph, slugOr(graph, "b2"))).toBe(true);
    expect(readyFrontier(graph).map((n) => slugOf(n.id))).toEqual(["a1"]);
  });
});
