/**
 * §6.5 — **correlation derives from the activity id**, never minted per run.
 *
 * A token that changes across executions goes stale in somebody's inbox: the reply comes
 * back addressed to a tag no longer armed, and the wait it was supposed to satisfy hangs
 * until its deadline. Deriving it means a fresh session, a resumed run and a re-sent
 * follow-up all correlate to the same address.
 *
 * §6.11 — one plus-addressed mailbox, N tags. A fan-out needs N tags on ONE inbox, not N
 * inboxes: send-as aliases cap around thirty per user, plus-addressing is uncapped.
 */

const CORRELATION_TAG_PREFIX = "kona-";

export interface Correlation {
  /** The FULLY EXPANDED literal. A template variable that reaches a counterparty is inert. */
  reply_to: string;
  subject_tag: string;
}

export type CorrelationResult =
  | { ok: true; correlation: Correlation }
  | { ok: false; reason: string };

/**
 * `ilya@gmail.com` + `ask-dana` -> `ilya+kona-ask-dana@gmail.com`.
 *
 * An existing `+tag` on the configured mailbox is REPLACED rather than appended to:
 * `ilya+kona@gmail.com` would otherwise become `ilya+kona+kona-ask-dana@…`, which most
 * providers deliver but nothing matches on.
 */
export function deriveCorrelation(mailbox: string, nodeId: string): CorrelationResult {
  const at = mailbox.lastIndexOf("@");
  if (at <= 0 || at === mailbox.length - 1) {
    return { ok: false, reason: `'${mailbox}' is not an address this can plus-tag` };
  }

  const local = mailbox.slice(0, at);
  const domain = mailbox.slice(at + 1);
  const base = local.includes("+") ? local.slice(0, local.indexOf("+")) : local;
  if (base.length === 0) {
    return { ok: false, reason: `'${mailbox}' has no local part to tag` };
  }
  // A second `@` means an unquoted one in the local part. Tagging it would emit a
  // syntactically broken address that a provider drops without a bounce — the worst
  // failure mode available, since the wait would sit armed until its deadline.
  if (base.includes("@")) {
    return { ok: false, reason: `'${mailbox}' has an unquoted '@' in its local part` };
  }

  return {
    ok: true,
    correlation: {
      reply_to: `${base}+${CORRELATION_TAG_PREFIX}${nodeId}@${domain}`,
      subject_tag: `[${CORRELATION_TAG_PREFIX}${nodeId}]`,
    },
  };
}

/**
 * The inverse, for matching an inbound message back to the wait that is expecting it.
 * Returns the activity id, or null if this address carries no Kona tag.
 */
export function activityIdFromCorrelation(address: string): string | null {
  const at = address.lastIndexOf("@");
  const local = at === -1 ? address : address.slice(0, at);
  const plus = local.indexOf("+");
  if (plus === -1) return null;
  const tag = local.slice(plus + 1);
  if (!tag.startsWith(CORRELATION_TAG_PREFIX)) return null;
  const nodeId = tag.slice(CORRELATION_TAG_PREFIX.length);
  return nodeId.length > 0 ? nodeId : null;
}
