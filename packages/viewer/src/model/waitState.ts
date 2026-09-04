/**
 * What a `wait` activity is actually waiting for, and whether its clock has run out.
 *
 * Rule 8 gives a wait three colours — fulfilled, awaiting-within-deadline, deadline-blown —
 * and rule 4 says the activity renders its own deadline countdown and predicate counter inline.
 * Both need one answer, computed once. Without this module every component that draws a wait
 * would re-derive "is it blown", and the two that disagreed would be a bug nobody could see:
 * a wait rendered as counting down when the store considers it timed out.
 *
 * The hard part is §6.2's second deadline shape. `{after: activity, duration: "48h"}` has no
 * absolute instant in it at all — the instant is the anchor activity's completion, which lives in
 * the mutation log's `observed_at` and not in the graph projection. So this takes a
 * completion index (D1's reason for folding the log rather than shelling out to
 * `kona graph --json`), and when the anchor has not succeeded the honest answer is `unarmed`
 * with the reason in words, never a countdown from a guessed zero.
 *
 * The index is activity id → completion instant, and emphatically NOT version → instant looked up
 * by `observed_at_version`: that field is the last version to *touch* the activity, and §6.4 lets
 * a delivery receipt land on an activity that is already terminal. Anchoring to it would let a
 * receipt slide a deadline forward and turn a blown wait back into a running one.
 *
 * `now` is a parameter. A pure module that read the clock would produce a different view for
 * the same log, and the snapshot tests could not pin a blown deadline at all.
 */

import type { Graph, ActivityNode } from "@kona/core";
import { isTerminal, outEdges, satisfiesBlockingEdge } from "@kona/core";
import { formatInstant, statusInWords } from "../format.ts";
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
function noClockYet(id: string, anchor: ActivityNode): string {
  // A control node never finishes, so a deadline anchored to one can never start — which is
  // why §6.2 refuses that shape at commit. Reported rather than crashed: an older log may
  // carry one, and a viewer that throws tells the reader nothing.
  if (anchor.status === undefined) {
    return `anchored to '${id}', which is a ${anchor.type} and never completes — the clock can never start`;
  }
  if (!isTerminal(anchor.status.state)) {
    return (
      `anchored to '${id}', which is still ${statusInWords(anchor.status.state)} — ` +
      "the clock starts when it finishes"
    );
  }
  if (!satisfiesBlockingEdge(anchor)) {
    return (
      `anchored to '${id}', which is ${anchor.status?.state} — it never succeeded, ` +
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
  activity: ActivityNode,
  completionTime: ReadonlyMap<string, Instant>,
): ResolvedDeadline {
  if (activity.type !== "accept_event") {
    return { at: null, label: "no deadline", unresolvedReason: "not an accept event" };
  }
  const deadline = activity.spec.deadline;

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
    // abandoned anchor is simply absent, and the wait stays unarmed. `noClockYet` says which
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
  return {
    at: backstop,
    label: `backstop ${formatInstant(backstop)} (expr)`,
    unresolvedReason: reason,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** One line for what would close this wait, read off `match.conditions` and nothing else. */
function matchLabelOf(activity: ActivityNode): string {
  if (activity.type !== "accept_event") return "not an accept event";
  const match = activity.spec.match;
  if (match === undefined) return "no match block — nothing can close this wait";

  const kinds = unique(match.conditions.map((c) => c.kind));
  const ons = unique(match.conditions.map((c) => c.on));

  switch (match.kind) {
    case "human":
      // The four decisions §6.2 names are the `on` values; the kind is how they arrive. The
      // "human" prefix earns its place: it says a person, not an event, has to act.
      return `human ${kinds.join("/")}: ${ons.join(" | ")}`;
    case "predicate":
      return predicateMatchLabel(activity) ?? `predicate: ${ons.join(" | ")}`;
    default:
      // `event` and anything W2 adds: the condition kinds are already the plain-English list
      // of the ways it can close. Never switch exhaustively on them (D5).
      return kinds.join(", or ");
  }
}

/**
 * Null unless this is an `accept_event`. Actions have no deadline or match, and returning an
 * empty `WaitState` for one would invite the canvas to draw a wait chip on it.
 *
 * `completionTime` is `PursuitView.completionTime`: activity id → the instant that activity
 * SUCCEEDED, for the activities that have. An activity absent from it has not succeeded — it is still
 * in flight, it failed, or the reader has travelled to a version before it finished — and all
 * three of those mean the same thing here: there is no clock.
 */
export function waitStateOf(
  graph: Graph,
  activity: ActivityNode,
  completionTime: ReadonlyMap<string, Instant>,
  now: Instant,
): WaitState | null {
  if (activity.type !== "accept_event") return null;

  const deadline = resolveDeadline(graph, activity, completionTime);
  const match = activity.spec.match;
  const predicate = predicateCount(graph, activity);

  /**
   * The order is the point.
   *
   * `withdrawn` first because a withdrawn wait can also carry a resolving outcome — the fixture's
   * `wait-for-priya` bounced and was then withdrawn — and the drop is the fact that decides what
   * happens next: §6.4 says an abandoned source never satisfies readiness, whatever it answered.
   * Reporting it as `resolved` would show a branch as alive that the store has abandoned.
   *
   * Then the rest of terminal, split into the two things terminal can mean, and split on
   * `satisfiesBlockingEdge` — the store's own test — rather than on a second reading of
   * `state`. That predicate is exactly "does this activity release what depends on it", which is
   * what rule 8's *fulfilled* colour claims. A `failed` wait does not; a `completed` one does.
   *
   * It deliberately does NOT also demand a resolving outcome. It used to, and that was wrong
   * in a way the fixture cannot show: `isEdgeSatisfied` returns true for an *unconditional*
   * edge out of any `completed` source, so a `completed` wait with no outcome can and does put its
   * successor on the frontier — and painting it the not-fulfilled red while the activity beneath
   * it went ready is the same contradiction in the other direction. When the out-edge IS
   * conditional and no outcome has landed, the honest place to say so is the target's blocked
   * reason ("finished without a resolution, this edge needs satisfied"), which is where
   * `blocked.ts` already says it.
   *
   * Nothing about an OPEN wait is decided by its outcome either. `record_outcome` and
   * `set_status` are separate ops (§6.4), so a batch can record a verdict without closing the
   * accept event — and until the store closes it, it is open: the deadline can still blow, the
   * decision's timeout arm can still fire, and every activity downstream is still blocked. Reading the outcome as
   * "resolved" there would paint the success green on a wait the CLI still considers running,
   * which is the one disagreement this module exists to prevent.
   *
   * `unarmed` before `blown` because with no computable deadline there is nothing to compare
   * `now` against, and `null >= now` is a comparison JavaScript would happily answer wrongly.
   */
  const phase = ((): WaitPhase => {
    if (activity.status?.state === "withdrawn") return "withdrawn";
    if (isTerminal(activity.status?.state)) {
      return satisfiesBlockingEdge(activity) ? "resolved" : "failed";
    }
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
    matchLabel: matchLabelOf(activity),
    predicate,
    timeoutTarget: timeoutTargetOf(graph, activity),
  };
}

/** S4: an accept_event feeds one decision; that decision owns the guarded timeout arm. */
function timeoutTargetOf(graph: Graph, activity: ActivityNode): string | null {
  const decisionEdge = outEdges(graph, activity.id)[0];
  if (decisionEdge === undefined) return null;
  const decision = graph.nodes.get(decisionEdge.to);
  if (decision?.type !== "decision") return null;
  const routes = outEdges(graph, decision.id);
  const explicit = routes.find(
    (edge) =>
      typeof edge.guard === "object" &&
      "on" in edge.guard &&
      (edge.guard.on === "timeout" || edge.guard.on === "timed_out"),
  );
  return explicit?.to ?? routes.find((edge) => edge.guard === "else")?.to ?? null;
}
