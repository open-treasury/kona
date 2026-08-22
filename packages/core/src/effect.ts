/**
 * The outbox vocabulary (§6.6). Pure: this module decides *what the key is* and *how an
 * intent is written down*, and nothing here hashes, sends, or touches a clock.
 *
 * There is no seventh op. `effect reserve` and `effect record` express themselves through
 * `set_status` with a STRUCTURED `evidence_ref`, which is exactly what that field is for:
 * what evidence supports this state change. `fold` then materialises `status.effect_log`
 * from those transitions — a projection of what the log already says, never a decision
 * re-made at read time.
 */

import type { EffectRecord, Node } from "./graph.ts";

/**
 * §6.6 — **payload-independent by design.** The key names the SLOT; `payload_hash` proves
 * the bytes were the ones approved.
 *
 * Putting the body in the key inverts the guarantee it exists for: a rewritten body would
 * yield a different key, so "key matches, payload differs" becomes unreachable and the
 * second email sends. This function is the preimage only; `kona` does the hashing, because
 * `core` has no crypto and wants none.
 */
export function effectKeyPreimage(nodeId: string, createdByVersion: number): string {
  return `${nodeId} ${createdByVersion}`;
}

const EFFECT_EVIDENCE_PREFIX = "effect";

export type EffectOutcome = "sent" | "failed";

export interface ReserveEvidence {
  kind: "reserve";
  effect_key: string;
  payload_hash: string;
}

export interface RecordEvidence {
  kind: "record";
  effect_key: string;
  outcome: EffectOutcome;
  message_id: string;
}

export type EffectEvidence = ReserveEvidence | RecordEvidence;

export function encodeReserveEvidence(effectKey: string, payloadHash: string): string {
  return `${EFFECT_EVIDENCE_PREFIX}:reserve:${effectKey}:${payloadHash}`;
}

export function encodeRecordEvidence(
  effectKey: string,
  outcome: EffectOutcome,
  messageId: string,
): string {
  return `${EFFECT_EVIDENCE_PREFIX}:record:${effectKey}:${outcome}:${messageId}`;
}

/**
 * Parse an evidence_ref, or null if it is ordinary evidence rather than an outbox
 * transition. The message id is taken as the remainder, so a provider id containing a
 * colon survives the round trip.
 */
export function parseEffectEvidence(evidenceRef: string): EffectEvidence | null {
  const parts = evidenceRef.split(":");
  if (parts[0] !== EFFECT_EVIDENCE_PREFIX) return null;

  if (parts[1] === "reserve" && parts.length >= 4) {
    const effectKey = parts[2];
    // The remainder, not the next field: a payload hash is very often written
    // `sha256:abc…`, and splitting on its own separator made this parser reject the
    // string this module had just encoded — leaving effect_log empty and every
    // downstream duplicate-send guard unreachable.
    const payloadHash = parts.slice(3).join(":");
    if (effectKey === undefined || effectKey.length === 0) return null;
    if (payloadHash.length === 0) return null;
    return { kind: "reserve", effect_key: effectKey, payload_hash: payloadHash };
  }

  if (parts[1] === "record" && parts.length >= 5) {
    const effectKey = parts[2];
    const outcome = parts[3];
    const messageId = parts.slice(4).join(":");
    if (effectKey === undefined || effectKey.length === 0) return null;
    if (outcome !== "sent" && outcome !== "failed") return null;
    if (messageId.length === 0) return null;
    return { kind: "record", effect_key: effectKey, outcome, message_id: messageId };
  }

  return null;
}

/**
 * The reservation that has been made but not resolved — the one the world may or may not
 * have acted on. §6.6 keeps `attempted_at` distinct from `completed_at` precisely so this
 * state is nameable, and an attempt without a completion is human adjudication, not retry.
 */
export function openEffect(node: Node): EffectRecord | null {
  return node.status.effect_log.find((entry) => entry.completed_at === null) ?? null;
}

/**
 * §6.6 — "A node with a non-empty `effect_log` is **never re-executed**", read precisely:
 * what is unrepeatable is a SEND, not an attempt. A bounce carries a message id too, so
 * testing for one would treat `550 user unknown` as bytes that reached somebody and close
 * the node against the very retry the restart budget exists to allow.
 */
export function hasSentEffect(node: Node): boolean {
  return node.status.effect_log.some((entry) => entry.outcome === "sent");
}

export function effectByKey(node: Node, effectKey: string): EffectRecord | null {
  return node.status.effect_log.find((entry) => entry.effect_key === effectKey) ?? null;
}

/** §6.6 restart budget: attempts in a window, then escalate — never loop. */
export function attemptCount(node: Node): number {
  return node.status.effect_log.length;
}
