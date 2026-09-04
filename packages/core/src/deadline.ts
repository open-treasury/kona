/**
 * Deadline evaluation (§6.2, §6.5). Pure: the clock is an argument, never a call.
 *
 * §6.2 makes a `deadline` mandatory on every accept-event, and calls it "the
 * schema rule that most directly prevents a silent multi-day hang". This is the half that
 * makes the rule mean something: a message sitting in someone's spam folder is *sent* —
 * no bounce, no reply, no error — so the only thing that ever ends that wait is the clock.
 */

import type { Deadline, MutationRecord } from "./schema.ts";
import { isNodeLive, type AcceptEventNode, type ActivityNode, type Graph } from "./graph.ts";
import { isTerminal } from "./vocab.ts";

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
type Unit = keyof typeof UNIT_MS;

const DURATION = /^(\d+)([smhd])$/;

export function parseDuration(duration: string): number | null {
  const match = DURATION.exec(duration);
  // The pattern already restricts the unit to the four keys, so there is no unknown-unit
  // branch to get wrong — and no unreachable one to pretend is a check.
  return match === null ? null : Number(match[1]) * UNIT_MS[match[2] as Unit];
}

/**
 * When an activity reached a terminal state, taken from the log rather than from the graph.
 *
 * The graph keeps `observed_at_version`, not a timestamp — deliberately, since a fold must
 * not invent times. The record that moved it is where the time lives.
 */
export function settledAt(records: readonly MutationRecord[], nodeId: string): string | null {
  for (const record of records.toReversed()) {
    for (const op of record.ops) {
      if (op.op === "set_status" && op.node === nodeId && isTerminal(op.status)) {
        return record.occurred_at;
      }
    }
  }
  return null;
}

export interface EffectiveDeadline {
  /** The instant this wait expires, or null when it cannot yet be computed. */
  at: string | null;
  /** How it was arrived at, so a report can say why a wait is or is not overdue. */
  basis: string;
}

/**
 * Resolve one of §6.2's three deadline shapes to an instant.
 *
 * The `{expr}` shape is NOT evaluated. §6.8 hardcodes its queries and says "no query
 * language", so shipping an expression evaluator would be exactly the thing that decision
 * refused. Its `backstop` is what it is for: the date past which the wait expires however
 * the expression would have resolved.
 */
export function effectiveDeadline(
  records: readonly MutationRecord[],
  deadline: Deadline,
): EffectiveDeadline {
  if ("at" in deadline) {
    return { at: deadline.at, basis: "fixed instant" };
  }

  if ("after" in deadline) {
    const anchor = settledAt(records, deadline.after);
    if (anchor === null) {
      return { at: null, basis: `waiting for '${deadline.after}' to settle` };
    }
    const span = parseDuration(deadline.duration);
    if (span === null) {
      return { at: null, basis: `'${deadline.duration}' is not a duration` };
    }
    return {
      at: new Date(Date.parse(anchor) + span).toISOString(),
      basis: `${deadline.duration} after '${deadline.after}' settled`,
    };
  }

  return {
    at: deadline.backstop,
    basis: `backstop for '${deadline.expr}' (expressions are not evaluated)`,
  };
}

/** A wait that is still armed: live, unresolved, and holding something up. */
export function armedWaits(graph: Graph): AcceptEventNode[] {
  return [...graph.nodes.values()].filter(
    (activity): activity is AcceptEventNode =>
      activity.type === "accept_event" &&
      // An armed wait is one in `ready`: its dependencies are met and nothing may claim it,
      // because D2 keeps an accept_event out of the dispatch list entirely. Under the old
      // vocabulary this read `active`, which ALSO matched a claimed node — so claiming a wait
      // silently disarmed it and its deadline never fired.
      activity.status.state === "ready" &&
      isNodeLive(activity),
  );
}

export interface WaitStatus {
  activity: ActivityNode;
  deadline: EffectiveDeadline;
  overdue: boolean;
}

export function waitStatus(
  records: readonly MutationRecord[],
  activity: ActivityNode,
  now: string,
): WaitStatus {
  if (activity.type !== "accept_event") {
    return { activity, deadline: { at: null, basis: "no deadline" }, overdue: false };
  }
  const deadline = effectiveDeadline(records, activity.spec.deadline);
  // Fail SAFE: an unresolvable deadline is not an expired one. Treating "cannot tell"
  // as "expired" would fire a timeout branch — and possibly a pivot — on a wait whose
  // anchor simply has not run yet.
  const overdue = deadline.at !== null && Date.parse(now) >= Date.parse(deadline.at);
  return { activity, deadline, overdue };
}

export function overdueWaits(
  records: readonly MutationRecord[],
  graph: Graph,
  now: string,
): WaitStatus[] {
  return armedWaits(graph)
    .map((activity) => waitStatus(records, activity, now))
    .filter((status) => status.overdue);
}
