/**
 * `kona resume` — reconcile-then-repair (§6.7), planned as a pure function.
 *
 * Everything the operator needs is derivable from the file alone (§6.7's list), which is
 * what makes D1 a guarantee rather than a hope: a fresh terminal with no session state
 * reads `.kona/mutations.jsonl` and knows exactly where the pursuit stands.
 *
 * The repair half is planned here and committed by the CLI, so that **each repair is
 * itself a logged mutation with a rationale**. A resume that silently fixed things would
 * leave the next agent reading a graph nobody explains.
 */

import type { AuthoredOp, MutationRecord } from "./schema.ts";
import { type Graph, type Node, isNodeTerminal, outEdges, readyFrontier } from "./graph.ts";
import { openEffect } from "./effect.ts";
import { type WaitStatus, armedWaits, overdueWaits, waitStatus } from "./deadline.ts";

/**
 * A node whose send was reserved and never resolved.
 *
 * §6.6's crash table calls window 2 "safe to retry" and window 3 "must ask a human", but
 * they leave IDENTICAL bytes — a `sending` node with `completed_at: null`. Nothing in the
 * log distinguishes "fsynced but never sent" from "sent but never recorded", so resume
 * reports every one of them and repairs none. Guessing here sends a second email.
 */
export interface UnknownSend {
  node_id: string;
  label: string;
  effect_key: string;
  payload_hash: string;
  attempted_at: string;
  recipient_ref: string | undefined;
}

export interface ResumeReport {
  version: number;
  counts: Record<string, number>;
  /** Computed, never stored (§6.8). */
  frontier: string[];
  waits: {
    node_id: string;
    label: string;
    deadline: string | null;
    basis: string;
    overdue: boolean;
  }[];
  unknown_sends: UnknownSend[];
  damaged: number;
}

export interface ResumePlan {
  report: ResumeReport;
  /** Empty when there is nothing to repair. The CLI commits these as one mutation. */
  repairs: AuthoredOp[];
  rationale: string;
}

function countByState(graph: Graph): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of graph.nodes.values()) {
    counts[node.status.state] = (counts[node.status.state] ?? 0) + 1;
  }
  return counts;
}

/**
 * A claim nobody is holding any more.
 *
 * `in_flight` covers two different facts, and the difference is the whole reason resume can
 * repair one and must not touch the other. A node with an OPEN EFFECT is an unknown send:
 * bytes may have left, the log cannot say, and a human decides — that is `unknownSends`.
 * A node in `in_flight` with NO open effect is a *pure* node an agent claimed and never came
 * back to, and nothing left the machine, so the honest repair is to put it back on the
 * frontier for whoever picks the pursuit up next.
 *
 * Keyed on the open effect rather than on `effect_class`, because the reservation is the fact
 * that matters: a `pure` node cannot have one, and a node that *declares* an effect but never
 * reserved it never moved a byte either.
 */
function staleClaims(graph: Graph): Node[] {
  return [...graph.nodes.values()].filter(
    (node) => node.status.state === "in_flight" && openEffect(node) === null,
  );
}

function unknownSends(graph: Graph): UnknownSend[] {
  return [...graph.nodes.values()].flatMap((node) => {
    const open = openEffect(node);
    if (open === null) return [];
    return [
      {
        node_id: node.id,
        label: node.label,
        effect_key: open.effect_key,
        payload_hash: open.payload_hash,
        attempted_at: open.attempted_at,
        recipient_ref: node.spec.effect?.recipient_ref,
      },
    ];
  });
}

/**
 * Firing a timeout resolves the wait AND makes its escape route reachable.
 *
 * `on_timeout` is a declaration, not an edge, so the store materialises the edge when the
 * timeout actually fires — the same "when the housekeeping is derivable, the store does
 * it" rule that governs branch drops. Without it a timed-out wait resolves into nothing
 * and §6.2's whole reason for demanding `on_timeout` evaporates.
 */
function timeoutRepair(graph: Graph, node: Node, at: string): AuthoredOp[] {
  const evidence = `deadline:${at}`;
  const ops: AuthoredOp[] = [];

  // Only route to an escape that can still run. Invariant 1 forbids a new blocking edge
  // into a terminal node, and rightly: if the escalation has already happened, there is
  // nothing to route to, and insisting on the edge would make the whole repair 422.
  const escape = node.spec.on_timeout;
  const target = escape === undefined ? undefined : graph.nodes.get(escape);
  if (escape !== undefined && target !== undefined && !isNodeTerminal(target)) {
    const alreadyRouted = outEdges(graph, node.id).some(
      (edge) => edge.to === escape && edge.condition?.on === "timeout",
    );
    if (!alreadyRouted) {
      ops.push({ op: "add_edge", from: node.id, to: escape, condition: { on: "timeout" } });
    }
  }

  ops.push({ op: "record_outcome", node: node.id, verdict: "timed_out", evidence_ref: evidence });
  ops.push({ op: "set_status", node: node.id, status: "done", evidence_ref: evidence });
  return ops;
}

export function planResume(
  records: readonly MutationRecord[],
  graph: Graph,
  now: string,
  damaged = 0,
): ResumePlan {
  const overdue = overdueWaits(records, graph, now);
  const stale = staleClaims(graph);
  const repairs = [
    ...overdue.flatMap(({ node, deadline }) => timeoutRepair(graph, node, deadline.at ?? now)),
    ...stale.map(
      (node): AuthoredOp => ({
        op: "set_status",
        node: node.id,
        status: "active",
        evidence_ref: "resume:stale-claim",
      }),
    ),
  ];

  const waits: ResumeReport["waits"] = armedWaits(graph)
    .map((node) => waitStatus(records, node, now))
    .map(({ node, deadline, overdue: isOverdue }: WaitStatus) => ({
      node_id: node.id,
      label: node.label,
      deadline: deadline.at,
      basis: deadline.basis,
      overdue: isOverdue,
    }));

  const names = overdue.map(({ node }) => node.id);
  const claimed = stale.map((node) => node.id);
  const timeoutText =
    names.length === 1
      ? `deadline passed on '${names[0]}'; resolving it as timed out so its escape route can run`
      : `deadlines passed on ${names.length} waits (${names.join(", ")}); resolving them as timed out`;
  const claimText =
    claimed.length === 1
      ? `'${claimed[0]}' was claimed and never finished; returning it to the frontier`
      : `${claimed.length} claimed nodes (${claimed.join(", ")}) never finished; returning them to the frontier`;
  const rationale =
    names.length > 0 && claimed.length > 0
      ? `${timeoutText}. Also: ${claimText}`
      : claimed.length > 0
        ? claimText
        : timeoutText;

  return {
    report: {
      version: graph.version,
      counts: countByState(graph),
      frontier: readyFrontier(graph).map((node) => node.id),
      waits,
      unknown_sends: unknownSends(graph),
      damaged,
    },
    repairs,
    rationale,
  };
}
