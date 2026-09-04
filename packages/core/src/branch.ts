/**
 * T2.6 — branch resolution. §6.4: "When a `wait` resolves, the store marks the target of
 * every untaken out-edge `withdrawn`, **transitively**." NEVER CUT: without it, v2's dominant
 * silent deadlock returns.
 *
 * **Derivation happens once, at commit.** Everything here is called by `validate()`, which
 * appends the resulting `set_status` ops to the batch before it is written. It is never
 * called by `fold` or `applyOps`, and that is the whole design: `fold` replays every record
 * through `applyOps`, so a cascade living there would re-run on every read forever, using
 * whatever the code does *today*. Change the drop rule next month and every historical log
 * would fold to a graph the human never approved — with the log unchanged, so nothing looks
 * wrong. The store decides once and the log records the decision, exactly as for id minting.
 *
 * `isEdgeDead` and `isArmDead` live in `graph.ts`, not here: readiness needs them too, and
 * `graph.ts` cannot import this module without a cycle (`import/no-cycle` is an error). An
 * edge whose source is still open is neither satisfied nor dead — the two predicates are not
 * complements, which is the single easiest thing to get wrong in this file.
 */

import type { CommittedOp } from "./schema.ts";
import type { Edge, Graph, ActivityNode } from "./graph.ts";
import { inEdges, isActivityTerminal, isEdgeDead, isNodeLive, isReady, outEdges } from "./graph.ts";
import { INITIAL_STATUS, isUnclaimed } from "./vocab.ts";

/**
 * The `evidence_ref` a derived drop carries. It names the store, not a message, because no
 * counterparty said anything — and it is greppable, so `kona graph --json` can separate the
 * store's housekeeping from what a human or a model authored.
 */
export const DERIVED_EVIDENCE_PREFIX = "derived:branch-resolution";

/**
 * May the store rewrite this activity's status? Distinct from "is this arm dead" on purpose —
 * §2 of the cascade below propagates through activities it may not itself rewrite.
 */
export function isDroppable(activity: ActivityNode): boolean {
  // A control node is never rewritten by the cascade: it has no status to write. The arm dies
  // THROUGH it — see the walk below — but nothing is recorded on it.
  if (activity.status === undefined) return false;
  // §6.6 — a claim with an open effect means the real world's answer is UNKNOWN, and `kona
  // resume` reports those to a human. Withdrawing it erases the marker resume needs.
  if (activity.status.state === "active") return false;
  // §6.6 — a non-empty effect_log means bytes already moved. Cancelling the plan does not
  // un-send the email; that needs a compensation, which only an author can write.
  return activity.status.effect_log.length === 0;
}

export interface BranchResolution {
  /** Derived `set_status(…, "withdrawn")` ops, in node insertion order. */
  drops: CommittedOp[];
  /**
   * Activities on a dead arm the store refused to rewrite — `active`, or bytes already moved.
   * Surfaced rather than silently skipped: each one is a human's decision.
   */
  withheld: string[];
}

/**
 * Identity of an edge as a value. `{from, to, guard?}` carries no id of its own.
 *
 * `\u0000` written as an ESCAPE, never as a literal byte: a raw NUL in the source makes git
 * treat this whole file as binary — no diff, no blame, no review. It is still the right
 * separator, because it is the one character an activity id (`[a-z0-9][a-z0-9-]*`) and an edge
 * condition can never contain, so two distinct edges can never collide on one key.
 */
function edgeKey(edge: Edge): string {
  return `${edge.from}\u0000${edge.to}\u0000${JSON.stringify(edge.guard)}`;
}

/**
 * Which activity killed this one. Deterministic: `post.edges` is append order, and the answer is
 * derived from the graph rather than from traversal, so discovery order never reaches the log.
 *
 * The first in-edge IS the cause, with no search needed: an activity is only ever dropped once
 * *every* one of its in-edges is dead or on a dead arm, so searching for "the dead one"
 * always returns the first. And an activity reaches the worklist only as some edge's target, so
 * `ins` is never empty here — the fallback is belt-and-braces for a caller that is not
 * `resolveBranches`.
 */
function dropCause(graph: Graph, id: string): string {
  return inEdges(graph, id)[0]?.from ?? id;
}

/**
 * The drop set for one commit. Pure in `(pre, post)`, where `post` is the graph the AUTHORED
 * ops produce — the derived ops are this function's output, not its input.
 *
 * The trigger is an **op-delta**: an edge that this batch killed, and that existed before it.
 * A post-state scan instead would re-derive the same drops on every later commit, against
 * activities terminal at head, which invariant 1 refuses — 422ing every unrelated commit forever.
 * That is the bug invariant 1 itself had before it became an op-delta.
 */
export function resolveBranches(pre: Graph, post: Graph): BranchResolution {
  const preKeys = new Set(pre.edges.map(edgeKey));
  const seeds = post.edges.filter(
    // `preKeys` restricts derivation to edges that existed at head. Without it, an edge the
    // batch both adds and kills would derive a drop when authored in one commit and nothing
    // when split across two — making the graph a function of where the commit boundary fell
    // rather than of the ops. Such an edge is refused by `checkDeadOnArrivalEdge` instead.
    (edge) => preKeys.has(edgeKey(edge)) && isEdgeDead(post, edge) && !isEdgeDead(pre, edge),
  );

  /** Every activity whose arm is dead — including ones the store may not rewrite. */
  const deadArm = new Set<string>();
  const dropped = new Set<string>();
  const withheld = new Set<string>();

  // `for..of` over a growing array: the array iterator re-reads `length` each step, so
  // pushes are visited. Each activity pushes its out-edges only on being marked, so total pushes
  // are bounded by |E| and the loop terminates. An activity held by a live in-edge is skipped
  // without being marked, and is re-examined when a later predecessor is marked — which is
  // what makes this a least fixpoint rather than a single sweep.
  const work: string[] = seeds.map((edge) => edge.to);
  for (const id of work) {
    if (deadArm.has(id)) continue;
    const activity = post.nodes.get(id);
    if (activity === undefined) continue;
    const ins = inEdges(post, id);
    // §6.4 — "It stops at an activity still held by a live in-edge — a shared descendant, which
    // survives." Applied uniformly at every depth, including the wait's immediate targets:
    // that is the only reading under which an activity targeted by both a taken and an untaken
    // arm survives, which the same sentence requires.
    if (!ins.every((edge) => isEdgeDead(post, edge) || deadArm.has(edge.from))) continue;
    deadArm.add(id);

    if (activity.status === undefined) {
      // A control node has no status to rewrite, so it is neither dropped nor withheld — and
      // yet the arm dies THROUGH it, exactly as it dies through a terminal node below. Under
      // S7 a diamond or a bar sits between almost every pair of steps, so stopping here would
      // stop the cascade at the first control node and leave the whole untaken branch live —
      // which is the pivot-fires-unapproved bug, reintroduced by the notation that was meant
      // to make it impossible.
    } else if (isActivityTerminal(activity)) {
      // The past is not rewritten — and invariant 1 would refuse it. But the ARM is still
      // dead, so the walk continues: a `completed` activity on an all-dead arm was never legitimately
      // ready, and its successors' plain edges out of it ARE satisfied. Stopping here puts
      // them on the frontier and fires the pivot the branch existed to avoid.
    } else if (isDroppable(activity)) {
      dropped.add(id);
    } else {
      // Same reasoning: withhold this activity, keep walking. An `active` activity completing later
      // makes no edge newly dead, so the op-delta could never re-seed from it.
      withheld.add(id);
    }

    for (const edge of outEdges(post, id)) work.push(edge.to);
  }

  // Emission order is activity insertion order — never discovery order — so the bytes written to
  // the log do not depend on how the traversal happened to run.
  const order = [...post.nodes.keys()];
  return {
    drops: order
      .filter((id) => dropped.has(id))
      .map((id): CommittedOp => ({
        op: "set_status",
        node: id,
        status: "withdrawn",
        evidence_ref: `${DERIVED_EVIDENCE_PREFIX}:${dropCause(post, id)}`,
      })),
    withheld: order.filter((id) => withheld.has(id)),
  };
}

/**
 * §6.2.1 — the readiness derivation. The cascade's twin, and it MUST run after it.
 *
 * A node on an arm this very commit withdrew must not be lifted to `ready` first and corrected
 * afterwards: both would be real ops in a real log, and the intermediate one says the store
 * offered work on a branch nobody took. §6.4's fail-safe exists precisely so that never
 * happens, and it would be undone here by an ordering mistake rather than by a rule change.
 *
 * Like the cascade, this derives ONCE, at commit, and the log records the decision. A fold
 * next month by code with a different readiness rule still produces the frontier the human
 * approved, because the frontier is in the log rather than in this function.
 */
export function deriveReadiness(post: Graph): CommittedOp[] {
  const ops: CommittedOp[] = [];

  // Node insertion order, never traversal order, so the bytes do not depend on how the walk ran.
  for (const node of post.nodes.values()) {
    if (node.status === undefined) continue;
    if (!isNodeLive(node)) continue;
    // Claimed or over. Neither is the derivation's to touch: a claim is a person's statement
    // and a terminal state is protected by invariant 1.
    if (!isUnclaimed(node.status.state)) continue;

    const want = isReady(post, node) ? "ready" : INITIAL_STATUS;
    if (want === node.status.state) continue;

    ops.push({
      op: "set_status",
      node: node.id,
      status: want,
      evidence_ref: `${DERIVED_EVIDENCE_PREFIX}:readiness`,
    });
  }

  return ops;
}
