/**
 * The Mailpit implementation of `MailboxProvider` — plan T7.1.
 *
 * Spec §6.11 names Mailpit as the offline fallback behind this port, and
 * Picked over MailHog on evidence: MailHog's last commit to `master`
 * was 2022-08-02 with 255 issues open, while Mailpit shipped v1.30.7 thirteen days before
 * that research. Everything below was verified against a live **v1.31.0**; the shapes are
 * transcribed from what that instance actually returned, not from memory.
 *
 * Zero dependencies — `fetch` and nothing else.
 *
 * ## The five things Mailpit's API does that will bite you
 *
 * 1. **Addresses flip between write and read.** You send `{Email, Name}` and read back
 *    `{Address, Name}`. Same object, different key.
 * 2. **`In-Reply-To` and `References` are not on the message object.** The documented
 *    property set has no threading headers at all, so building a thread means a second call
 *    to `/message/{id}/headers` per message.
 * 3. **Header keys come back Go-canonicalised**, so `Message-ID` reads back as `Message-Id`.
 *    Indexing `headers["Message-ID"]` silently returns nothing.
 * 4. **Angle brackets are inconsistent.** `message.MessageID` strips them; `/headers` keeps
 *    them. Match the two without normalising and every thread link quietly fails to join.
 * 5. **`Reply-To` may not be set through `Headers`** — it is on a case-insensitive
 *    restricted list and returns HTTP 400. The top-level `ReplyTo` field is the only way.
 *
 * ## Why the Message-ID is pinned
 *
 * Left alone, Mailpit mints a random id per message, and a rig whose receipts change every
 * run cannot be the acceptance test §7.2 asks for. `Message-ID` is *not* on the restricted
 * list, so this sets it explicitly and the run reproduces. The same discipline the memory
 * provider gets for free.
 *
 * ## Why there is no webhook here
 *
 * Mailpit's own docs say failed webhook calls "are not retried" and that calls are rate
 * limited to one per second by default — a fan-out burst would be smeared over seconds and
 * a consumer hiccup would drop events permanently. §6.5 already decided this: "Reconciliation
 * is truth; webhooks are a latency optimisation." So this polls.
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
} from "./port.ts";
import { MailboxError, formatMailbox, threadRootOf } from "./port.ts";

const PROVIDER: ProviderName = "mailpit";

/** The HTTP UI and the API share one port. There is no separate API port. */
export const DEFAULT_MAILPIT_URL = "http://localhost:8025";

/**
 * How far back `pollThread` will scan for a cursor before giving up and returning
 * everything it saw.
 *
 * Mailpit prunes the oldest messages once `--max` is exceeded, so a cursor can name a message
 * that no longer exists. Re-delivering is the safe direction under §6.6 — a duplicate inbound
 * is deduped on provider message-id, a skipped one is lost.
 *
 * Deliberately NOT 500. That is Mailpit's default `--max`, and a scan window equal to the
 * retention window means the cursor falls off the end exactly when pruning starts, so every
 * poll after that re-delivers the whole page. Run Mailpit with `--max 0` (see the README) and
 * give the scan room above it.
 */
const MAX_SCAN = 2000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MailpitProviderOptions {
  clock: Clock;
  baseUrl?: string;
  /** Injected so the contract can be tested without a running Mailpit. */
  fetch?: FetchLike;
  idPrefix?: string;
}

export class MailpitProvider implements MailboxProvider {
  readonly name: ProviderName = PROVIDER;
  /** A local sink never reaches the internet. This is the whole reason it is the demo path. */
  readonly sandbox_or_real: Realm = "sandbox";

  readonly #clock: Clock;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #idPrefix: string;
  #idSeq = 0;
  #healthy = false;

  constructor(options: MailpitProviderOptions) {
    this.#clock = options.clock;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_MAILPIT_URL).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#idPrefix = options.idPrefix ?? "kona";
  }

  /**
   * Mailpit is a catch-all — "any address at all is accepted, so a 30-way fan-out costs
   * nothing and provisions nothing". So provisioning is a healthcheck and a promise kept:
   * confirm the server is there, then hand back the address the caller asked for.
   */
  async provision(request: ProvisionRequest): Promise<Mailbox> {
    if (!request.address.includes("@")) {
      throw new MailboxError("ADDRESS_REJECTED", PROVIDER, `not an address: ${request.address}`);
    }
    await this.healthcheck();
    return {
      address: request.address,
      display_name: request.display_name,
      provider: PROVIDER,
      sandbox_or_real: this.sandbox_or_real,
    };
  }

  /** `GET /api/v1/info`. Returns the running version. */
  async healthcheck(): Promise<string> {
    const info = await this.#json<{ Version?: unknown }>("GET", "/api/v1/info");
    const version = info.Version;
    if (typeof version !== "string") {
      throw new MailboxError("PROTOCOL_MISMATCH", PROVIDER, "/api/v1/info has no Version");
    }
    this.#healthy = true;
    return version;
  }

  async send(envelope: Envelope): Promise<SendReceipt> {
    // Pinned rather than left to the server, so the run reproduces. `Message-ID` is absent
    // from Mailpit's restricted-header list; `Reply-To` is on it, which is why the reply
    // address goes in the top-level field below and not in `Headers`.
    const messageId = this.#nextId();
    const headers: Record<string, string> = { "Message-ID": messageId };
    if (envelope.in_reply_to !== undefined) headers["In-Reply-To"] = envelope.in_reply_to;
    if (envelope.references !== undefined && envelope.references.length > 0) {
      headers["References"] = envelope.references.join(" ");
    }
    for (const [key, value] of Object.entries(envelope.headers ?? {})) headers[key] = value;

    const body = {
      // `Email` on the way in. It reads back as `Address` — see the header note above.
      From: { Email: envelope.from.address, Name: envelope.from.display_name },
      To: envelope.to.map((address) => ({ Email: address, Name: "" })),
      Subject: envelope.subject,
      Text: envelope.body_text,
      Headers: headers,
      ...(envelope.reply_to === undefined
        ? {}
        : { ReplyTo: [{ Email: envelope.reply_to, Name: "" }] }),
    };

    const response = await this.#json<{ ID?: unknown }>("POST", "/api/v1/send", body);
    if (typeof response.ID !== "string") {
      throw new MailboxError("PROTOCOL_MISMATCH", PROVIDER, "/api/v1/send returned no ID");
    }

    return {
      // The RFC id we pinned, NOT `response.ID` — that is Mailpit's own database key, and
      // `In-Reply-To` has to reference the RFC one.
      message_id: messageId,
      thread: { kind: "provider_thread", id: threadRootOf({ ...envelope, message_id: messageId }) },
      provider: PROVIDER,
      sandbox_or_real: this.sandbox_or_real,
      accepted_at: this.#clock(),
    };
  }

  /**
   * Everything in the conversation after `cursor`, oldest first.
   *
   * There is no server-side "find replies to X": Mailpit's search index covers only From,
   * Subject, To, Cc, Bcc, Reply-To, Return-Path, the body and attachment filenames, so
   * `In-Reply-To` and `References` are not searchable and `message-id:` matches a message's
   * OWN id rather than what it replies to. Threading is therefore correlated client-side,
   * from the per-message headers.
   */
  async pollThread(request: PollRequest): Promise<ThreadPage> {
    // Always the plain listing, then filter client-side.
    //
    // `GET /api/v1/search?query=to:...` looks like the obvious optimisation and is a trap
    // twice over. Its `cleanString()` strips double quotes, so exact-phrase quoting cannot be
    // relied on; and the index it searches covers Reply-To as well as To — and Kona's OWN
    // `Reply-To` is `ilya+kona-<node_id>@…`, so a search for a correlation address matches the
    // outbound that carried it. Substring semantics over a field set that includes the thing
    // you are searching for is a false positive waiting to happen.
    const fresh = await this.#scanBackTo(request.cursor);

    const messages: InboundMessage[] = [];
    for (const summary of fresh) {
      const message = await this.#hydrate(summary);
      const belongs =
        request.thread.kind === "provider_thread"
          ? threadRootOf(message) === request.thread.id
          : // The whole address, compared as an opaque key. Never split on `+`.
            message.to.includes(request.thread.address);
      if (!belongs) continue;
      messages.push(message);
    }

    // `fresh` is oldest-first, so the newest SCANNED message is the last one.
    const last = fresh.at(-1);
    return {
      // The cursor advances over everything SCANNED, not only over what matched the thread —
      // otherwise a poll that filters out every message would rescan the same page forever.
      messages,
      cursor: last === undefined ? request.cursor : last.ID,
    };
  }

  /** The message object plus the threading headers it does not carry. */
  async #hydrate(summary: MessageSummary): Promise<InboundMessage> {
    const [full, headers] = await Promise.all([
      this.#json<Record<string, unknown>>("GET", `/api/v1/message/${summary.ID}`),
      this.#json<Record<string, unknown>>("GET", `/api/v1/message/${summary.ID}/headers`),
    ]);

    const inReplyTo = firstHeader(headers, "In-Reply-To");
    const references = firstHeader(headers, "References");

    return {
      // Normalised to angle-bracket form. `MessageID` arrives stripped and the headers keep
      // the brackets; comparing the two raw is how a thread silently fails to join.
      message_id: bracket(summary.MessageID),
      in_reply_to: inReplyTo === null ? null : bracket(inReplyTo),
      references:
        references === null ? [] : references.split(/\s+/).filter(Boolean).map(bracket),
      from: formatMailbox(readAddress(full["From"])),
      to: readAddressList(full["To"]).map((entry) => entry.address),
      reply_to: readAddressList(full["ReplyTo"]).map((entry) => entry.address),
      subject: typeof full["Subject"] === "string" ? full["Subject"] : summary.Subject,
      body_text: typeof full["Text"] === "string" ? full["Text"] : "",
      received_at: typeof full["Date"] === "string" ? full["Date"] : summary.Created,
    };
  }

  /**
   * Walk the mailbox newest-first until the cursor is reached, and return what was newer,
   * OLDEST FIRST.
   *
   * The obvious one-shot version — ask for `limit=MAX_SCAN` and stop the scan at MAX_SCAN —
   * is silently lossy, and it fails in exactly the case a demo hits: if more than one window's
   * worth of mail arrives between two polls, the window can never reach back past the cursor,
   * the loop falls off the end, and the cursor then jumps to the newest message. Everything in
   * the gap is skipped and never scanned again on any later poll. Measured against a live
   * v1.31.0: two replies sitting behind 2100 unrelated messages were lost permanently.
   *
   * So it pages, and it distinguishes the two ways the cursor can go missing. If the whole
   * mailbox is exhausted without finding it, the message was pruned — re-delivering is the
   * safe direction, and a duplicate inbound is deduped on provider message-id. If the scan
   * bound is hit while messages remain, the gap is real and unknown, and it throws.
   */
  async #scanBackTo(cursor: Cursor): Promise<MessageSummary[]> {
    const PAGE = 200;
    const fresh: MessageSummary[] = [];
    let start = 0;
    let total = Number.POSITIVE_INFINITY;

    while (start < total && fresh.length < MAX_SCAN) {
      const page = await this.#json<Record<string, unknown>>(
        "GET",
        `/api/v1/messages?start=${start}&limit=${PAGE}`,
      );
      total = readTotal(page);
      const summaries = readSummaries(page);
      if (summaries.length === 0) break;
      for (const summary of summaries) {
        if (summary.ID === cursor) return fresh.toReversed();
        fresh.push(summary);
        if (fresh.length >= MAX_SCAN) break;
      }
      // Newest-first paging over a store that only ever prepends: a message arriving mid-scan
      // shifts the window and can re-show one already seen. Duplicates are the safe direction.
      start += summaries.length;
    }

    if (fresh.length >= MAX_SCAN && start < total) {
      throw new MailboxError(
        "CURSOR_LOST",
        PROVIDER,
        `scanned ${MAX_SCAN} of ${total} messages without reaching cursor ${String(cursor)};` +
          " run mailpit with --max 0 so nothing is pruned, or poll more often",
      );
    }
    return fresh.toReversed();
  }

  async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.#baseUrl}${path}`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw new MailboxError(
        "PROVIDER_UNREACHABLE",
        PROVIDER,
        `${method} ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    if (!response.ok) {
      const text = await response.text();
      // Mailpit reports a refused send as `{"Error": "..."}` with a 4xx.
      throw new MailboxError(
        response.status >= 500 ? "PROVIDER_UNREACHABLE" : "SEND_REJECTED",
        PROVIDER,
        `${method} ${path} → ${response.status}: ${text.trim()}`,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (cause) {
      throw new MailboxError(
        "PROTOCOL_MISMATCH",
        PROVIDER,
        `${method} ${path} did not return JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  #nextId(): string {
    return `<${this.#idPrefix}-${++this.#idSeq}@kona.demo>`;
  }

  /** Whether `healthcheck()` has succeeded at least once on this instance. */
  get healthy(): boolean {
    return this.#healthy;
  }
}

interface MessageSummary {
  /** Mailpit's own database key. Used in URLs and as the cursor. */
  ID: string;
  /** The RFC Message-ID, WITHOUT angle brackets at this endpoint. */
  MessageID: string;
  Subject: string;
  Created: string;
}

interface ParsedAddress {
  name: string;
  address: string;
}

/**
 * How many messages the mailbox holds.
 *
 * `messages_count` rather than `count`: the live response carries both, and `count` is absent
 * from the OpenAPI definition — undocumented, so not something to page against.
 */
function readTotal(page: Record<string, unknown>): number {
  const total = page["messages_count"] ?? page["total"];
  if (typeof total !== "number") {
    throw new MailboxError("PROTOCOL_MISMATCH", PROVIDER, "listing has no `messages_count`");
  }
  return total;
}

function readSummaries(page: Record<string, unknown>): MessageSummary[] {
  const raw = page["messages"];
  if (!Array.isArray(raw)) {
    throw new MailboxError("PROTOCOL_MISMATCH", PROVIDER, "listing has no `messages` array");
  }
  return raw.map((entry) => {
    const record = entry as Record<string, unknown>;
    const id = record["ID"];
    if (typeof id !== "string") {
      throw new MailboxError("PROTOCOL_MISMATCH", PROVIDER, "message summary has no ID");
    }
    return {
      ID: id,
      MessageID: typeof record["MessageID"] === "string" ? record["MessageID"] : "",
      Subject: typeof record["Subject"] === "string" ? record["Subject"] : "",
      Created: typeof record["Created"] === "string" ? record["Created"] : "",
    };
  });
}

/**
 * Read an address object. Mailpit returns `{Name, Address}` on READ — the `{Email, Name}`
 * shape is write-only, and mixing them up is the single easiest mistake against this API.
 */
function readAddress(value: unknown): ParsedAddress {
  if (typeof value !== "object" || value === null) return { name: "", address: "" };
  const record = value as Record<string, unknown>;
  return {
    name: typeof record["Name"] === "string" ? record["Name"] : "",
    address: typeof record["Address"] === "string" ? record["Address"] : "",
  };
}

function readAddressList(value: unknown): ParsedAddress[] {
  if (!Array.isArray(value)) return [];
  return value.map(readAddress);
}

/**
 * Read one header value.
 *
 * Keys arrive Go-canonicalised — first letter and each letter after a hyphen upper, the rest
 * lower — so `Message-ID` becomes `Message-Id`. `In-Reply-To`, `References` and `Reply-To`
 * are already canonical, but the lookup is case-insensitive anyway rather than relying on it.
 */
function firstHeader(headers: Record<string, unknown>, key: string): string | null {
  const wanted = key.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== wanted) continue;
    if (!Array.isArray(value)) continue;
    const first = value[0];
    return typeof first === "string" ? first : null;
  }
  return null;
}

/** One canonical form for an RFC id, so the two endpoints' answers can be compared. */
function bracket(id: string): string {
  const trimmed = id.trim();
  if (trimmed === "") return "";
  return trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
}
