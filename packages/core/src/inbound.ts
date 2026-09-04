/**
 * Matching inbound mail to armed waits (§6.5, T3.2). Pure: no network, no clock, no model.
 *
 * ## Where the fetching is not
 *
 * `kona` does not fetch. §6.8 makes every verb "a pure function of `mutations.jsonl` + the
 * clock + **the mailbox cursor**" — the mailbox is an INPUT to the function, not something
 * the function reaches out to. So `kona poll` is handed messages somebody else fetched
 * through the §6.11 `MailboxProvider`, and its job is to say what they mean.
 *
 * That is also the only arrangement §6.12 permits: `demo/` is a directory of throwaway
 * scripts, and the package that owns the write path cannot depend on it.
 *
 * ## Where the verdict is not
 *
 * ⚖ The binary never calls a model. Whether Dana said yes is a judgement about prose, so
 * matching stops at "a reply arrived, and it is this one". The orchestrator reads the body,
 * decides the verdict, and commits it with `record_outcome`. This module draws that line.
 *
 * ## Why there is no cursor
 *
 * §6.5 sketches a `cursor: {last_seen, last_checked_at}` on the wait, and nothing here
 * stores one — deliberately. **The dedupe set already exists**: every message the graph has
 * acted on is an `evidence_ref` on that wait's own outcomes. Re-scanning from the start and
 * skipping what is already recorded is idempotent by construction, needs no seventh op to
 * persist a position, and cannot lose mail the way a lost or over-advanced cursor can —
 * which is the failure the port's own `CURSOR_LOST` exists to shout about.
 */

import { isNodeLive, type Graph, type ActivityNode } from "./graph.ts";
import type { WaitCondition } from "./schema.ts";
import type { GuardValue } from "./vocab.ts";
import { armedWaits } from "./deadline.ts";
import { deriveCorrelation } from "./correlation.ts";

/**
 * The subset of a provider message that matching needs.
 *
 * Structural on purpose: `demo/mailbox/port.ts` defines a richer `InboundMessage`, and one
 * is assignable to the other without either package importing the other.
 */
export interface InboundMessage {
  message_id: string;
  from: string;
  to: readonly string[];
  reply_to?: readonly string[];
  in_reply_to?: string | null;
  subject?: string;
  received_at?: string;
}

/** A wait that is waiting on mail, and the address its replies will arrive at. */
export interface WaitAddress {
  activity_id: string;
  name: string;
  /** The FULLY EXPANDED literal to poll (§6.9). */
  address: string;
  /** Armed waits need an answer; resolved ones can still take a late one (§6.5). */
  armed: boolean;
}

export interface InboundMatch {
  activity_id: string;
  message_id: string;
  from: string;
  subject: string | undefined;
  received_at: string | undefined;
  /** The or-group entry that matched, so the orchestrator knows which branch is in play. */
  on: GuardValue;
  /**
   * The wait had already resolved. §6.5: recorded as `verdict:"late"`, and it **never
   * reopens** the wait.
   */
  late: boolean;
}

/**
 * A wait's or-group conditions, or none if it is not a wait.
 *
 * `spec.match` is already precisely typed — `activitySpecSchema` gives it a shape and
 * `MutationRecordSchema` re-parses every historical line on every fold, so a match block that
 * is not an object cannot reach here. This used to re-narrow it by hand against a looser
 * local type, and mutation testing measured the cost: eleven unkillable mutants across two
 * four-line helpers, all of them guards against a shape the parser cannot admit.
 */
function conditionsOf(activity: ActivityNode): readonly WaitCondition[] {
  return activity.type === "accept_event" ? activity.spec.match.conditions : [];
}

function matchKindOf(activity: ActivityNode): string | null {
  return activity.type === "accept_event" ? activity.spec.match.kind : null;
}

/** Every message id this wait has already acted on. The dedupe set, for free. */
function alreadyRecorded(activity: ActivityNode): Set<string> {
  return new Set((activity.status?.outcomes ?? []).map((entry) => entry.evidence_ref));
}

/**
 * A wait is resolved when a resolving verdict has been recorded against it. Its address
 * stays pollable so a straggler can still be recorded — but only as `late`.
 */
function isResolved(activity: ActivityNode): boolean {
  return activity.status?.outcome != null;
}

/**
 * Every event-wait's reply address. `kona poll` prints these so the caller knows what to
 * fetch; the fetching itself is the provider's job.
 */
export function waitAddresses(graph: Graph, mailbox: string): WaitAddress[] {
  const armed = new Set(armedWaits(graph).map((activity) => activity.id));
  return [...graph.nodes.values()].flatMap((activity) => {
    if (activity.type !== "accept_event" || matchKindOf(activity) !== "event") return [];
    if (!isNodeLive(activity)) return [];
    // A resolved wait is still worth polling — §6.5 requires a late reply to be RECORDED.
    if (!armed.has(activity.id) && !isResolved(activity)) return [];
    const derived = deriveCorrelation(mailbox, activity.id);
    if (!derived.ok) return [];
    return [
      {
        activity_id: activity.id,
        name: activity.name,
        address: derived.correlation.reply_to,
        armed: armed.has(activity.id),
      },
    ];
  });
}

function addressedTo(message: InboundMessage, address: string): boolean {
  const lowered = address.toLowerCase();
  return [...message.to, ...(message.reply_to ?? [])].some((candidate) =>
    candidate.toLowerCase().includes(lowered),
  );
}

function conditionMatches(condition: WaitCondition, message: InboundMessage): boolean {
  // Only reply-shaped conditions are decidable from a message. A `deadline` condition is
  // the clock's business and `kona resume` fires it.
  if (condition.kind !== "reply") return false;
  if (condition.from !== undefined && condition.from.toLowerCase() !== message.from.toLowerCase()) {
    return false;
  }
  if (condition.in_reply_to !== undefined && condition.in_reply_to.length > 0) {
    if (message.in_reply_to === null || message.in_reply_to === undefined) return false;
    if (!condition.in_reply_to.includes(message.in_reply_to)) return false;
  }
  return true;
}

export interface MatchOptions {
  /** Our own address. Our outbound copies come back in the same thread; they are not replies. */
  ownMailbox: string;
}

/**
 * Match messages to one wait. **First match wins** (§6.5).
 *
 * Evaluate-all would let a single reply advance two fanned-out waits, which is
 * unrecoverable under no-rollback — so this returns at most ONE match per wait per poll,
 * and the next poll picks up whatever is left.
 */
export function matchWait(
  activity: ActivityNode,
  messages: readonly InboundMessage[],
  address: string,
  options: MatchOptions,
): InboundMatch | null {
  if (activity.type !== "accept_event") return null;
  const seen = alreadyRecorded(activity);
  const conditions = conditionsOf(activity);
  const late = isResolved(activity);
  const own = options.ownMailbox.toLowerCase();

  for (const message of messages) {
    if (seen.has(message.message_id)) continue;
    // A thread contains both halves of the conversation. Our own copies are not replies.
    if (message.from.toLowerCase().includes(own)) continue;
    if (!addressedTo(message, address)) continue;

    for (const condition of conditions) {
      if (!conditionMatches(condition, message)) continue;
      return {
        activity_id: activity.id,
        message_id: message.message_id,
        from: message.from,
        subject: message.subject,
        received_at: message.received_at,
        on: condition.on,
        late,
      };
    }
  }
  return null;
}

/**
 * Match a batch of fetched messages against every pollable wait.
 *
 * A message is consumed by the FIRST wait that claims it, and never offered to a second —
 * the same first-wins rule, applied across waits rather than within one. Two fanned-out
 * arms polling one shared inbox must not both advance on the same reply.
 */
export function matchInbound(
  graph: Graph,
  mailbox: string,
  messages: readonly InboundMessage[],
): InboundMatch[] {
  const claimed = new Set<string>();
  const matches: InboundMatch[] = [];

  for (const target of waitAddresses(graph, mailbox)) {
    const activity = graph.nodes.get(target.activity_id);
    if (activity?.type !== "accept_event") continue;
    const available = messages.filter((message) => !claimed.has(message.message_id));
    const match = matchWait(activity, available, target.address, { ownMailbox: mailbox });
    if (match === null) continue;
    claimed.add(match.message_id);
    matches.push(match);
  }

  return matches;
}
