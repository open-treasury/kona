/**
 * An in-process `MailboxProvider`. The offline path, and the reason the rig has no
 * install step.
 *
 * Mailpit is spec §6.11's stated offline fallback, but it is still a binary that has to be
 * on the machine — and on this one it is not. §7.2's divergent-arms assertions are supposed
 * to run as an ordinary test, so the rig needs a substrate that is present by definition.
 * This is it: same three methods, same receipts, no ports, no processes, no network.
 *
 * ## It is a capture sink, because that is what Mailpit is
 *
 * `docs/research/13`: Mailpit and its kind "bind an SMTP listener on localhost, accept and
 * never relay, expose the captured mail over HTTP". So `send` here **captures** — the
 * message becomes readable through `pollThread` immediately, whoever sent it. That is why
 * the persona simulator needs no back door: a persona replying is an ordinary `send` from
 * the persona mailbox, exactly as it is against a running Mailpit.
 *
 * The consequence is Mailpit's consequence too, and worth stating rather than hiding: a
 * catch-all cannot tell "the right recipient got it" from "everything went to the sink".
 * `pollThread` therefore returns a conversation including the caller's own outbound copy,
 * and the caller filters.
 *
 * ## The one thing a sink cannot do
 *
 * Produce a real bounce. `docs/research/13` quotes the sharpest criticism of this whole
 * category — such tools "confirm 'an email was sent' but don't validate the protocol" — so
 * Priya's `550` is scripted through `rejectRecipient()`. It fires at send time, in the same
 * place a real rejection would, and `send` throws `SEND_REJECTED` exactly as Gmail's would.
 * `sandbox_or_real` on the receipt is how a reader tells that it was staged.
 */

import type { Clock } from "./clock.ts";
import type {
  Cursor,
  Envelope,
  InboundMessage,
  Mailbox,
  MailboxProvider,
  PollRequest,
  ProviderName,
  ProvisionRequest,
  Realm,
  SendReceipt,
  ThreadPage,
  ScriptableRejections,
  ThreadRef,
} from "./port.ts";
import { MailboxError, formatMailbox, threadRootOf } from "./port.ts";

const PROVIDER: ProviderName = "memory";

/** A captured message plus the bookkeeping `pollThread` needs and the port does not expose. */
interface Captured {
  seq: number;
  thread_id: string;
  message: InboundMessage;
}

export interface MemoryProviderOptions {
  clock: Clock;
  /** Prefix for generated message ids. Vary it only if two providers share a transcript. */
  idPrefix?: string;
}

export class MemoryMailboxProvider implements MailboxProvider, ScriptableRejections {
  readonly name: ProviderName = PROVIDER;
  readonly sandbox_or_real: Realm = "sandbox";

  readonly #clock: Clock;
  readonly #idPrefix: string;
  readonly #provisioned = new Map<string, Mailbox>();
  readonly #rejections = new Map<string, { code: number; diagnostic: string }>();
  readonly #captured: Captured[] = [];
  /** Every envelope this provider accepted, in order. The rig asserts against it. */
  readonly sent: { envelope: Envelope; receipt: SendReceipt }[] = [];
  /** Message ids. Separate from the capture sequence so neither can perturb the other. */
  #idSeq = 0;
  /** Capture positions, and therefore cursor values. Monotonic, gapless, never reused. */
  #captureSeq = 0;

  constructor(options: MemoryProviderOptions) {
    this.#clock = options.clock;
    this.#idPrefix = options.idPrefix ?? "memory";
  }

  provision(request: ProvisionRequest): Promise<Mailbox> {
    const existing = this.#provisioned.get(request.address);
    // Idempotent by construction: the address is a pure function of the caller's state, so
    // re-provisioning after a crash must return what it returned before, not a second box.
    if (existing !== undefined) return Promise.resolve(existing);
    if (!isAddress(request.address)) {
      throw new MailboxError("ADDRESS_REJECTED", PROVIDER, `not an address: ${request.address}`);
    }
    const mailbox: Mailbox = {
      address: request.address,
      display_name: request.display_name,
      provider: PROVIDER,
      sandbox_or_real: this.sandbox_or_real,
    };
    this.#provisioned.set(request.address, mailbox);
    return Promise.resolve(mailbox);
  }

  send(envelope: Envelope): Promise<SendReceipt> {
    for (const recipient of envelope.to) {
      const rejection = this.#rejections.get(recipient);
      if (rejection !== undefined) {
        // Nothing is captured. A rejected send did not happen, and a rig that recorded it
        // anyway would let the graph believe an email is in flight that never left.
        throw new MailboxError(
          "SEND_REJECTED",
          PROVIDER,
          `${recipient}: ${rejection.diagnostic}`,
          rejection.code,
        );
      }
    }
    const messageId = this.#nextId();
    // A send with no chain opens a thread; a reply joins the ROOT of the one it answers.
    // Ordinary RFC 5322 threading — transport-level, and specifically not Kona correlation:
    // no tag is read off any address to compute it.
    const threadId = threadRootOf({ ...envelope, message_id: messageId });
    const receipt: SendReceipt = {
      message_id: messageId,
      thread: { kind: "provider_thread", id: threadId },
      provider: PROVIDER,
      sandbox_or_real: this.sandbox_or_real,
      accepted_at: this.#clock(),
    };
    this.sent.push({ envelope, receipt });
    this.#capture(envelope, receipt, threadId);
    return Promise.resolve(receipt);
  }

  pollThread(request: PollRequest): Promise<ThreadPage> {
    const after = parseCursor(request.cursor);
    // `#captured` is append-ordered, so it is already sorted by `seq`.
    const matches = this.#captured.filter(
      (entry) => entry.seq > after && belongs(entry, request.thread),
    );
    const last = matches.at(-1);
    return Promise.resolve({
      messages: matches.map((entry) => entry.message),
      // The cursor advances only over messages actually returned, so a consumer that dies
      // before persisting the page re-reads it rather than skipping it.
      cursor: last === undefined ? request.cursor : String(last.seq),
    });
  }

  /** Script a delivery failure for one address, as a real provider would report it. */
  rejectRecipient(address: string, code: number, diagnostic: string): void {
    this.#rejections.set(address, { code, diagnostic });
  }

  /** Everything the sink holds, oldest first. The equivalent of Mailpit's message list. */
  captured(): readonly InboundMessage[] {
    return this.#captured.map((entry) => entry.message);
  }

  #capture(envelope: Envelope, receipt: SendReceipt, threadId: string): void {
    const message: InboundMessage = {
      message_id: receipt.message_id,
      in_reply_to: envelope.in_reply_to ?? null,
      references: envelope.references ?? [],
      from: formatMailbox({ name: envelope.from.display_name, address: envelope.from.address }),
      to: [...envelope.to],
      reply_to: envelope.reply_to === undefined ? [] : [envelope.reply_to],
      subject: envelope.subject,
      body_text: envelope.body_text,
      received_at: receipt.accepted_at,
    };
    this.#captured.push({ seq: ++this.#captureSeq, thread_id: threadId, message });
  }

  #nextId(): string {
    return `<${this.#idPrefix}-${++this.#idSeq}@kona.demo>`;
  }
}

function belongs(entry: Captured, thread: ThreadRef): boolean {
  if (thread.kind === "provider_thread") return entry.thread_id === thread.id;
  // `delivered_to` compares the whole address as an opaque key. It does not split on `+`,
  // and it must not: the tag means something to `kona` and nothing here.
  return entry.message.to.includes(thread.address);
}

function isAddress(value: string): boolean {
  const at = value.indexOf("@");
  return at > 0 && at < value.length - 1 && !value.includes(" ");
}

function parseCursor(cursor: Cursor): number {
  if (cursor === null) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}
