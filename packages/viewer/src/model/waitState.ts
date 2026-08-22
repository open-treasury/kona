/**
 * What a `wait` node is actually waiting for, and whether its clock has run out.
 *
 * Rule 8 gives a wait three colours — fulfilled, awaiting-within-deadline, deadline-blown —
 * and rule 4 says the node renders its own deadline countdown and predicate counter inline.
 * Both need one answer, computed once. Without this module every component that draws a wait
 * would re-derive "is it blown", and the two that disagreed would be a bug nobody could see:
 * a wait rendered as counting down when the store considers it timed out.
 *
 * The hard part is §6.2's second deadline shape. `{after: node, duration: "48h"}` has no
 * absolute instant in it at all — the instant is the anchor node's completion, which lives in
 * the mutation log's `observed_at` and not in the graph projection. So this takes a
 * completion index (D1's reason for folding the log rather than shelling out to
 * `kona graph --json`), and when the anchor has not succeeded the honest answer is `unarmed`
 * with the reason in words, never a countdown from a guessed zero.
 *
 * The index is node id → completion instant, and emphatically NOT version → instant looked up
 * by `observed_at_version`: that field is the last version to *touch* the node, and §6.4 lets
 * a delivery receipt land on a node that is already terminal. Anchoring to it would let a
 * receipt slide a deadline forward and turn a blown wait back into a running one.
 *
 * `now` is a parameter. A pure module that read the clock would produce a different view for
 * the same log, and the snapshot tests could not pin a blown deadline at all.
 */

import type { Graph, Node } from "@kona/core";
import { isTerminal, satisfiesBlockingEdge } from "@kona/core";
import { formatInstant } from "../format.ts";
import { predicateCount, predicateMatchLabel } from "./predicate.ts";
import type { Instant, WaitPhase, WaitState } from "./types.ts";

const DURATION = /^(\d+)([smhd])$/;

/** §6.2's grammar, and only §6.2's grammar. An unrecognised unit is reported, not guessed. */
function durationMs(text: string): number | null {
  const parts = DURATION.exec(text);
  if (parts === null) return null;
  const count = Number.parseInt(parts[1] ?? "", 10);
  if (!Number.isFinite(count)) return null;
  switch (parts[2]) {
    case "s":
      return count * 1_000;
    case "m":
      return count * 60_000;
    case "h":
      return count * 3_600_000;
    case "d":
      return count * 86_400_000;
    default:
      return null;
  }
}

interface ResolvedDeadline {
  at: Instant | null;
  label: string;
  unresolvedReason: string | null;
}

/**
 * Why an anchored wait has no clock yet. Three different facts, and which one it is decides
 * what the reader should do about it: wait for the anchor, give up on this branch, or scroll
 * forward to a version where the anchor had finished.
 *
 * The middle case is D2, and it is `satisfiesBlockingEdge` rather than a second reading of
 * `status.state` on purpose. Only a terminal SUCCESS starts a clock, for exactly the reason
 * `isEdgeSatisfied` asks the same question: a send that bounced never went out, so counting
 * 48 hours from the bounce would put a deadline on a message nobody ever received.
 */
function noClockYet(id: string, anchor: Node): string {
  if (!isTerminal(anchor.status.state)) {
    return (
      `anchored to '${id}', which is still ${anchor.status.state} — ` +
      "the clock starts when it finishes"
    );
  }
  if (!satisfiesBlockingEdge(anchor)) {
    return (
      `anchored to '${id}', which is ${anchor.status.state} — it never succeeded, ` +
      "so no clock ever started"
    );
  }
  // Succeeded, but not in the log we folded: read-only time travel to a version before the
  // completion, or a record whose `observed_at` would not parse. Either way the instant is
  // one nobody recorded, and inventing it is how a wait gets painted blown in 1970.
  return (
    `anchored to '${id}', which is done, but the folded log carries no completion time ` +
    "for it — no clock yet"
  );
}

function resolveDeadline(
  graph: Graph,
  node: Node,
  completionTime: ReadonlyMap<string, Instant>,
): ResolvedDeadline {
  const deadline = node.spec.deadline;

  // §6.2 requires a deadline on every wait and the schema enforces it, so this branch means
  // the log carried something the schema would have rejected. Say so rather than crash.
  if (deadline === undefined) {
    return {
      at: null,
      label: "no deadline",
      unresolvedReason: "this wait carries no deadline, so nothing can time it out",
    };
  }

  if ("at" in deadline) {
    const at = Date.parse(deadline.at);
    if (Number.isNaN(at)) {
      return {
        at: null,
        label: `due ${deadline.at}`,
        unresolvedReason: `deadline '${deadline.at}' is not a parseable timestamp`,
      };
    }
    return { at, label: `due ${formatInstant(at)}`, unresolvedReason: null };
  }

  if ("after" in deadline) {
    const label = `${deadline.duration} after ${deadline.after}`;
    const span = durationMs(deadline.duration);
    if (span === null) {
      return {
        at: null,
        label,
        unresolvedReason: `duration '${deadline.duration}' is not a whole number of s/m/h/d`,
      };
    }
    const anchor = graph.nodes.get(deadline.after);
    if (anchor === undefined) {
      return {
        at: null,
        label,
        unresolvedReason: `anchored to '${deadline.after}', which is not in the graph`,
      };
    }
    // The index holds successes and nothing else, so D2 needs no test here: a `failed` or
    // `dropped` anchor is simply absent, and the wait stays unarmed. `noClockYet` says which
    // of the three reasons it is, and asks `satisfiesBlockingEdge` to do it, so the words and
    // the arithmetic can never drift apart.
    const startedAt = completionTime.get(deadline.after);
    if (startedAt === undefined) {
      return { at: null, label, unresolvedReason: noClockYet(deadline.after, anchor) };
    }
    return { at: startedAt + span, label, unresolvedReason: null };
  }

  // `{expr, backstop, after_unknown}`. Evaluating the expression is the store's job and the
  // viewer has no evaluator; presenting a computed date would be a fabrication. The backstop
  // is the one instant §6.2 guarantees, so it is what the countdown runs to — labelled as
  // such, so nobody reads it as the real deadline.
  const backstop = Date.parse(deadline.backstop);
  const unknown = deadline.after_unknown ? "; its anchor time is unknown" : "";
  const reason =
    `deadline is the expression '${deadline.expr}', which the viewer cannot evaluate` +
    `${unknown} — counting down to the backstop instead`;
  if (Number.isNaN(backstop)) {
    return { at: null, label: `backstop ${deadline.backstop} (expr)`, unresolvedReason: reason };
  }
  return { at: backstop, label: `backstop ${formatInstant(backstop)} (expr)`, unresolvedReason: reason };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** One line for what would close this wait, read off `match.conditions` and nothing else. */
function matchLabelOf(node: Node): string {
  const match = node.spec.match;
  if (match === undefined) return "no match block — nothing can close this wait";

  const kinds = unique(match.conditions.map((c) => c.kind));
  const ons = unique(match.conditions.map((c) => c.on));

  switch (match.kind) {
    case "human":
      // The four decisions §6.2 names are the `on` values; the kind is how they arrive. The
      // "human" prefix earns its place: it says a person, not an event, has to act.
      return `human ${kinds.join("/")}: ${ons.join(" | ")}`;
    case "predicate":
      return predicateMatchLabel(node) ?? `predicate: ${ons.join(" | ")}`;
    default:
      // `event` and anything W2 adds: the condition kinds are already the plain-English list
      // of the ways it can close. Never switch exhaustively on them (D5).
      return kinds.join(", or ");
  }
}

/**
 * Null for a task. Tasks have no deadline, no match and no timeout route, and returning an
 * empty `WaitState` for one would invite the canvas to draw a wait chip on it.
 *
 * `completionTime` is `PursuitView.completionTime`: node id → the instant that node
 * SUCCEEDED, for the nodes that have. A node absent from it has not succeeded — it is still
 * in flight, it failed, or the reader has travelled to a version before it finished — and all
 * three of those mean the same thing here: there is no clock.
 */
export function waitStateOf(
  graph: Graph,
  node: Node,
  completionTime: ReadonlyMap<string, Instant>,
  now: Instant,
): WaitState | null {
  if (node.type !== "wait") return null;

  const deadline = resolveDeadline(graph, node, completionTime);
  const match = node.spec.match;
  const predicate = predicateCount(graph, node);

  /**
   * The order is the point.
   *
   * `dropped` first because a dropped wait can also carry a resolving outcome — the fixture's
   * `wait-for-priya` bounced and was then dropped — and the drop is the fact that decides what
   * happens next: §6.4 says a dropped source never satisfies readiness, whatever it answered.
   * Reporting it as `resolved` would show a branch as alive that the store has abandoned.
   *
   * Then the rest of terminal, split into the two things terminal can mean. `resolved` is
   * rule 8's *fulfilled* colour and has to be earned twice over: the wait succeeded
   * (`satisfiesBlockingEdge`, the store's own test, not a second reading of `state`) AND
   * something actually answered it. A `failed` wait, or a `done` one that closed without a
   * resolving outcome, fires no out-edge and unblocks nothing — painting it the success green
   * would contradict the blocked reason rendered on the very next card.
   *
   * A wait that is still open but already carries its resolving answer is `resolved` too: a
   * wait that answered an hour after its deadline was answered, not timed out, and the
   * timeout route was never taken.
   *
   * `unarmed` before `blown` because with no computable deadline there is nothing to compare
   * `now` against, and `null >= now` is a comparison JavaScript would happily answer wrongly.
   */
  const phase = ((): WaitPhase => {
    if (node.status.state === "dropped") return "dropped";
    if (isTerminal(node.status.state)) {
      const fulfilled = satisfiesBlockingEdge(node) && node.status.outcome !== null;
      return fulfilled ? "resolved" : "failed";
    }
    if (node.status.outcome !== null) return "resolved";
    if (deadline.at === null) return "unarmed";
    if (now >= deadline.at) return "blown";
    return "awaiting";
  })();

  return {
    phase,
    deadlineAt: deadline.at,
    remainingMs: deadline.at === null ? null : deadline.at - now,
    deadlineLabel: deadline.label,
    unresolvedReason: deadline.unresolvedReason,
    matchKind: match?.kind ?? null,
    matchLabel: matchLabelOf(node),
    predicate,
    onTimeout: node.spec.on_timeout ?? null,
  };
}
