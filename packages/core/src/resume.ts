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
import { named } from "./named.ts";
import { INITIAL_STATUS } from "./vocab.ts";
import { type Graph, type ActivityNode, readyFrontier } from "./graph.ts";
import { openEffect } from "./effect.ts";
import { type WaitStatus, armedWaits, overdueWaits, waitStatus } from "./deadline.ts";

/**
 * An activity whose send was reserved and never resolved.
 *
 * §6.6's crash table calls window 2 "safe to retry" and window 3 "must ask a human", but
 * they leave IDENTICAL bytes — an `active` activity with `completed_at: null`. Nothing in the
 * log distinguishes "fsynced but never sent" from "sent but never recorded", so resume
 * reports every one of them and repairs none. Guessing here sends a second email.
 */
export interface UnknownSend {
  activity_id: string;
  name: string;
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
    activity_id: string;
    name: string;
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
  for (const activity of graph.nodes.values()) {
    // Control nodes are absent from the count on purpose: `kona resume` reports what a human
    // may have to act on, and a diamond never is.
    const state = activity.status?.state;
    if (state === undefined) continue;
    counts[state] = (counts[state] ?? 0) + 1;
  }
  return counts;
}

/**
 * A claim nobody is holding any more.
 *
 * `active` covers two different facts, and the difference is the whole reason resume can
 * repair one and must not touch the other. An activity with an OPEN EFFECT is an unknown send:
 * bytes may have left, the log cannot say, and a human decides — that is `unknownSends`.
 * An activity in `active` with NO open effect is a *pure* activity an agent claimed and never came
 * back to, and nothing left the machine, so the honest repair is to put it back on the
 * frontier for whoever picks the pursuit up next.
 *
 * Keyed on the open effect rather than on `effect_class`, because the reservation is the fact
 * that matters: a `pure` activity cannot have one, and an activity that *declares* an effect but never
 * reserved it never moved a byte either.
 */
function staleClaims(graph: Graph): ActivityNode[] {
  return [...graph.nodes.values()].filter(
    (activity) => activity.status?.state === "active" && openEffect(activity) === null,
  );
}

function unknownSends(graph: Graph): UnknownSend[] {
  return [...graph.nodes.values()].flatMap((activity) => {
    const open = openEffect(activity);
    if (open === null) return [];
    return [
      {
        activity_id: activity.id,
        name: activity.name,
        effect_key: open.effect_key,
        payload_hash: open.payload_hash,
        attempted_at: open.attempted_at,
        recipient_ref: activity.spec.effect?.recipient_ref,
      },
    ];
  });
}

/**
 * Firing a timeout resolves the accept-event. Its existing decision successor routes the
 * `timeout` guard; resume never mutates topology.
 */
function timeoutRepair(activity: ActivityNode, at: string): AuthoredOp[] {
  const evidence = `deadline:${at}`;
  return [
    { op: "record_outcome", node: activity.id, verdict: "timed_out", evidence_ref: evidence },
    { op: "set_status", node: activity.id, status: "completed", evidence_ref: evidence },
  ];
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
    ...overdue.flatMap(({ activity, deadline }) => timeoutRepair(activity, deadline.at ?? now)),
    // Release the claim to `inactive` and let the SAME commit's readiness derivation lift it
    // back to `ready` if its dependencies still hold. Writing `ready` here would assert a fact
    // this function has not checked, and the graph may well have moved while the claim was
    // held — which is the exact situation resume exists for.
    ...stale.map((activity): AuthoredOp => ({
      op: "set_status",
      node: activity.id,
      status: INITIAL_STATUS,
      evidence_ref: "resume:stale-claim",
    })),
  ];

  const waits: ResumeReport["waits"] = armedWaits(graph)
    .map((activity) => waitStatus(records, activity, now))
    .map(({ activity, deadline, overdue: isOverdue }: WaitStatus) => ({
      activity_id: activity.id,
      name: activity.name,
      deadline: deadline.at,
      basis: deadline.basis,
      overdue: isOverdue,
    }));

  // A resume rationale is read by whoever picks the pursuit up, so it names the waits rather
  // than addressing them: an id alone says nothing about which step timed out.
  const names = overdue.map(({ activity }) => named(activity));
  const claimed = stale.map((activity) => named(activity));
  const timeoutText =
    names.length === 1
      ? `deadline passed on ${names[0]}; resolving it as timed out so its escape route can run`
      : `deadlines passed on ${names.length} waits (${names.join(", ")}); resolving them as timed out`;
  const claimText =
    claimed.length === 1
      ? `${claimed[0]} was claimed and never finished; returning it to the frontier`
      : `${claimed.length} claimed activities (${claimed.join(", ")}) never finished; returning them to the frontier`;
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
      frontier: readyFrontier(graph).map((activity) => activity.id),
      waits,
      unknown_sends: unknownSends(graph),
      damaged,
    },
    repairs,
    rationale,
  };
}
