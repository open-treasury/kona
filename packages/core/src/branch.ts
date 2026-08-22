/**
 * T2.6 — branch resolution. §6.4: "When a `wait` resolves, the store marks the target of
 * every untaken out-edge `dropped`, **transitively**." NEVER CUT: without it, v2's dominant
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
import type { Edge, Graph, Node } from "./graph.ts";
import { inEdges, isEdgeDead, isNodeTerminal, outEdges } from "./graph.ts";

/**
 * The `evidence_ref` a derived drop carries. It names the store, not a message, because no
 * counterparty said anything — and it is greppable, so `kona graph --json` can separate the
 * store's housekeeping from what a human or a model authored.
 */
export const DERIVED_EVIDENCE_PREFIX = "derived:branch-resolution";

/**
 * May the store rewrite this node's status? Distinct from "is this arm dead" on purpose —
 * §2 of the cascade below propagates through nodes it may not itself rewrite.
 */
export function isDroppable(node: Node): boolean {
  // §6.6 — `sending` means the real world's answer is UNKNOWN, and `kona resume` reports
  // `sending` unknowns to a human. Dropping erases the marker resume needs.
  if (node.status.state === "sending") return false;
  // §6.6 — a non-empty effect_log means bytes already moved. Cancelling the plan does not
  // un-send the email; that needs a compensation, which only an author can write.
  return node.status.effect_log.length === 0;
}

export interface BranchResolution {
  /** Derived `set_status(…, "dropped")` ops, in node insertion order. */
  drops: CommittedOp[];
  /**
   * Nodes on a dead arm the store refused to rewrite — `sending`, or bytes already moved.
   * Surfaced rather than silently skipped: each one is a human's decision.
   */
  withheld: string[];
}

/**
 * Identity of an edge as a value. `{from, to, condition?}` carries no id of its own.
 *
 * `\u0000` written as an ESCAPE, never as a literal byte: a raw NUL in the source makes git
 * treat this whole file as binary — no diff, no blame, no review. It is still the right
 * separator, because it is the one character a node id (`[a-z0-9][a-z0-9-]*`) and an edge
 * condition can never contain, so two distinct edges can never collide on one key.
 */
function edgeKey(edge: Edge): string {
  return `${edge.from}\u0000${edge.to}\u0000${edge.condition?.on ?? ""}`;
}

/**
 * Which node killed this one. Deterministic: `post.edges` is append order, and the answer is
 * derived from the graph rather than from traversal, so discovery order never reaches the log.
 *
 * The first in-edge IS the cause, with no search needed: a node is only ever dropped once
 * *every* one of its in-edges is dead or on a dead arm, so searching for "the dead one"
 * always returns the first. And a node reaches the worklist only as some edge's target, so
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
 * nodes terminal at head, which invariant 1 refuses — 422ing every unrelated commit forever.
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

  /** Every node whose arm is dead — including ones the store may not rewrite. */
  const deadArm = new Set<string>();
  const dropped = new Set<string>();
  const withheld = new Set<string>();

  // `for..of` over a growing array: the array iterator re-reads `length` each step, so
  // pushes are visited. Each node pushes its out-edges only on being marked, so total pushes
  // are bounded by |E| and the loop terminates. A node held by a live in-edge is skipped
  // without being marked, and is re-examined when a later predecessor is marked — which is
  // what makes this a least fixpoint rather than a single sweep.
  const work: string[] = seeds.map((edge) => edge.to);
  for (const id of work) {
    if (deadArm.has(id)) continue;
    const node = post.nodes.get(id);
    if (node === undefined) continue;
    const ins = inEdges(post, id);
    // §6.4 — "It stops at a node still held by a live in-edge — a shared descendant, which
    // survives." Applied uniformly at every depth, including the wait's immediate targets:
    // that is the only reading under which a node targeted by both a taken and an untaken
    // arm survives, which the same sentence requires.
    if (!ins.every((edge) => isEdgeDead(post, edge) || deadArm.has(edge.from))) continue;
    deadArm.add(id);

    if (isNodeTerminal(node)) {
      // The past is not rewritten — and invariant 1 would refuse it. But the ARM is still
      // dead, so the walk continues: a `done` node on an all-dead arm was never legitimately
      // ready, and its successors' plain edges out of it ARE satisfied. Stopping here puts
      // them on the frontier and fires the pivot the branch existed to avoid.
    } else if (isDroppable(node)) {
      dropped.add(id);
    } else {
      // Same reasoning: withhold this node, keep walking. A `sending` node completing later
      // makes no edge newly dead, so the op-delta could never re-seed from it.
      withheld.add(id);
    }

    for (const edge of outEdges(post, id)) work.push(edge.to);
  }

  // Emission order is node insertion order — never discovery order — so the bytes written to
  // the log do not depend on how the traversal happened to run.
  const order = [...post.nodes.keys()];
  return {
    drops: order
      .filter((id) => dropped.has(id))
      .map((id): CommittedOp => ({
        op: "set_status",
        node: id,
        status: "dropped",
        evidence_ref: `${DERIVED_EVIDENCE_PREFIX}:${dropCause(post, id)}`,
      })),
    withheld: order.filter((id) => withheld.has(id)),
  };
}
