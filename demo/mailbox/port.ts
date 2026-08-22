/**
 * The `MailboxProvider` port — spec §6.11, plan T7.1.
 *
 * Three methods, and deliberately only three: **provision / send / poll-thread.**
 *
 * ## What this file is not allowed to know
 *
 * Correlation. `ilya+kona-<node_id>@gmail.com` is DERIVED FROM THE NODE ID, and the `kona`
 * binary owns that derivation (§6.5: "Correlation derives from the node id, never minted
 * per run"). Nothing here parses a plus-tag, splits on `+`, or maps an address back to a
 * node. Addresses arrive as opaque strings and leave as opaque strings.
 *
 * The test for whether a change belongs here: if it would still make sense for a provider
 * that had never heard of Kona, it belongs. If it needs to know what a node id is, it does
 * not.
 *
 * ## Why the port exists at all
 *
 * `docs/research/13-mailboxes-and-the-demo-rig.md` prices this category four different ways
 * — per-inbox metered, per-identity, per-volume, and free — and concludes that "a thin
 * `MailboxProvider` port (provision / send / poll-thread) keeps this a config value rather
 * than a schema decision". Mailpit is the offline path (T7.1); Gmail plus-addressing drops
 * in behind the same three methods (T7.2, cut-order 6, deliberately not built).
 *
 * ## Provision derives, it does not mint
 *
 * `provision` takes an address the CALLER already computed and makes it real, or confirms
 * that it is. It never returns an address the caller did not ask for. That is the single
 * highest-value idea in the research doc — "derive wins for a graph … it makes fan-out
 * idempotent for free — exactly the property crash-resume needs" — and it is why a
 * crash-resumed run re-provisioning the same address is a no-op rather than a second inbox.
 */

import type { Clock } from "./clock.ts";

/** Which implementation actually handled the call. Recorded on every send (§6.11). */
export const PROVIDER_NAMES = ["mailpit", "memory", "gmail"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/**
 * Whether the bytes reached the real internet. Recorded on every send (§6.11: "Every send
 * records `provider` and `sandbox_or_real`"), because a demo that cannot prove it was
 * contained is a demo nobody can rerun.
 */
export const REALMS = ["sandbox", "real"] as const;
export type Realm = (typeof REALMS)[number];

/** A place mail can be sent from and delivered to. The address is opaque to this layer. */
export interface Mailbox {
  /** The literal address. Computed by the caller; never derived here. */
  address: string;
  display_name: string;
  provider: ProviderName;
  sandbox_or_real: Realm;
}

export interface ProvisionRequest {
  /** The exact address to make real. A pure function of the caller's own state. */
  address: string;
  display_name: string;
}

/**
 * What to send. Every field a counterparty could see is FULLY EXPANDED — §6.9 is explicit
 * that "a template variable that reaches a counterparty can never correlate", so this type
 * accepts literals and offers no templating of any kind.
 */
export interface Envelope {
  from: Mailbox;
  to: readonly string[];
  subject: string;
  body_text: string;
  /**
   * The literal reply-to. This is where the caller's correlation token ends up, and this
   * layer treats it as an ordinary string it copies into a header.
   */
  reply_to?: string;
  /** RFC 5322 threading. TRANSPORT-level, not Kona-level — see the note on `ThreadRef`. */
  in_reply_to?: string;
  references?: readonly string[];
  /** Anything else, verbatim. */
  headers?: Readonly<Record<string, string>>;
}

/**
 * How to ask a provider for a conversation.
 *
 * Both forms are correlation-free from this layer's point of view: `id` is a handle the
 * provider itself minted, and `address` is an opaque key the caller computed. Neither is
 * parsed here. The second form exists because §6.5 makes reconciliation the truth —
 * "Reconciliation is truth; webhooks are a latency optimisation" — and a reply whose client
 * dropped `In-Reply-To` is still delivered to the right address.
 */
export type ThreadRef =
  | { kind: "provider_thread"; id: string }
  | { kind: "delivered_to"; address: string };

/**
 * An opaque, durable, JSON-serialisable position in a conversation.
 *
 * Durable is the operative word: §6.5 stores `cursor: {last_seen, last_checked_at}` on the
 * wait node itself, so a fresh process resumes by re-reading the graph rather than by
 * holding a connection open. `null` means "from the beginning".
 */
export type Cursor = string | null;

export interface SendReceipt {
  /** The provider's message id, in `<...>` form where the provider uses one. */
  message_id: string;
  /** How to poll for replies to this send. */
  thread: ThreadRef;
  provider: ProviderName;
  sandbox_or_real: Realm;
  /** ISO-8601, from the injected clock. */
  accepted_at: string;
}

/**
 * One inbound message, normalised across providers.
 *
 * `to` and `reply_to` keep whatever tags they arrived with, verbatim and unparsed. Reading
 * a tag out of them is the caller's job and specifically not this layer's.
 */
export interface InboundMessage {
  message_id: string;
  in_reply_to: string | null;
  references: readonly string[];
  from: string;
  to: readonly string[];
  reply_to: readonly string[];
  subject: string;
  body_text: string;
  /** ISO-8601. */
  received_at: string;
  /**
   * Delivery failure as reported by the transport, when the provider reports one at all.
   * A local sink cannot produce a real bounce — see `mailpit.ts` — so on the offline path
   * this is scripted, and `sandbox_or_real` is how a reader tells the difference.
   */
  delivery_status?: { code: number; enhanced?: string; diagnostic?: string };
}

export interface ThreadPage {
  /**
   * Everything in the conversation after the cursor, oldest first — **including the
   * caller's own outbound copies.**
   *
   * Both implementations are capture sinks over one store, so a thread contains both halves
   * of it. That is also true of the real Gmail arrangement in §6.11, where Kona and the
   * personas share a mailbox. Filter on `from` if you want only the counterparty.
   */
  messages: readonly InboundMessage[];
  /** Pass back on the next call. Advances only over messages actually returned. */
  cursor: Cursor;
}

export interface PollRequest {
  thread: ThreadRef;
  cursor: Cursor;
}

/**
 * The root of the conversation a message belongs to: the first `References` entry, else what
 * it replies to, else itself.
 *
 * Taking `In-Reply-To` alone is the bug that hides until the third message. A reply to a
 * reply would then report the INTERMEDIATE message as its thread, so one conversation would
 * yield two different `ThreadRef`s and a poll would silently return half of it — which fires
 * the moment the pursuit chases Pat or follows up with Marcus.
 *
 * `References` is the right source because RFC 5322 requires it to accumulate the whole chain
 * with the root first. This is RFC threading, not Kona correlation: it reads headers a mail
 * client writes, and never looks at an address.
 */
export function threadRootOf(message: {
  references?: readonly string[] | undefined;
  in_reply_to?: string | null | undefined;
  message_id: string;
}): string {
  return message.references?.[0] ?? message.in_reply_to ?? message.message_id;
}

/** Symbolic reasons, in the CLI's house style (§6.8: "one stderr line beginning with a symbolic reason"). */
export const MAILBOX_ERROR_REASONS = [
  /** The provider is not running, not reachable, or not what it claimed to be. */
  "PROVIDER_UNREACHABLE",
  /** The provider will not host this address. */
  "ADDRESS_REJECTED",
  /** The provider accepted the connection and refused the message. Carries an SMTP code. */
  "SEND_REJECTED",
  /** The thread ref names nothing the provider knows about. */
  "THREAD_NOT_FOUND",
  /** The provider answered, but not in the shape its documented API promises. */
  "PROTOCOL_MISMATCH",
] as const;
export type MailboxErrorReason = (typeof MAILBOX_ERROR_REASONS)[number];

export class MailboxError extends Error {
  readonly reason: MailboxErrorReason;
  readonly provider: ProviderName;
  /** Present on `SEND_REJECTED` — e.g. `550` for the bounce beat. */
  readonly smtp_code: number | undefined;

  constructor(
    reason: MailboxErrorReason,
    provider: ProviderName,
    detail: string,
    smtp_code?: number,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "MailboxError";
    this.reason = reason;
    this.provider = provider;
    this.smtp_code = smtp_code;
  }
}

/**
 * The port. Three methods. Adding a fourth is a spec change, not a code change.
 *
 * Implementations take their clock by injection rather than reading one — the same discipline
 * §6.8 holds the binary to, applied here by convention rather than by a compiler gate.
 *
 * How far that gets you differs by provider, and the difference is worth stating rather than
 * glossing. `accepted_at` is always the injected clock, so a run's own record reproduces. But
 * `received_at` on an inbound message is whatever the provider stamped it: the in-process
 * provider reproduces exactly, and Mailpit cannot be made to — `Date` is on its restricted
 * header list, so supplying one is a hard 400. **Do not assert on `received_at` in anything
 * that has to pass on both paths.**
 */
export interface MailboxProvider {
  readonly name: ProviderName;
  readonly sandbox_or_real: Realm;

  /** Make `request.address` real, or confirm it already is. Idempotent by construction. */
  provision(request: ProvisionRequest): Promise<Mailbox>;

  /** Hand the bytes to the world. Throws `MailboxError` rather than returning a failure. */
  send(envelope: Envelope): Promise<SendReceipt>;

  /** Everything in the conversation after `cursor`, oldest first. */
  pollThread(request: PollRequest): Promise<ThreadPage>;
}

export interface ProviderOptions {
  clock: Clock;
}

/**
 * An OPTIONAL capability, not a fourth method on the port.
 *
 * Priya's beat is a hard `550` at send time, and a catch-all sink physically cannot produce
 * one — `docs/research/13` quotes the sharpest criticism of this whole category, that such
 * tools "confirm 'an email was sent' but don't validate the protocol". Mailpit accepts every
 * address there is; the in-process provider can be told not to.
 *
 * So the capability is declared separately and probed for. A provider that cannot refuse says
 * so by not implementing it, and the rig narrates the difference rather than pretending the
 * transport bounced. That honesty is the point: `sandbox_or_real` and this probe are the two
 * things letting someone read a transcript and tell staged from real.
 */
export interface ScriptableRejections {
  rejectRecipient(address: string, code: number, diagnostic: string): void;
}

export function canScriptRejections(
  provider: MailboxProvider,
): provider is MailboxProvider & ScriptableRejections {
  return typeof (provider as Partial<ScriptableRejections>).rejectRecipient === "function";
}
