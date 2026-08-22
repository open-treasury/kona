/**
 * The `MailboxProvider` contract, run against both implementations.
 *
 * The Mailpit half is driven by a stub `fetch` replaying the **verbatim** shapes a live
 * v1.31.0 returned — the address-key flip, the missing threading headers, the Go-canonicalised
 * header keys, the inconsistent angle brackets. So these tests pin the API contract without a
 * running Mailpit, which is what keeps `bun run check` green on a machine that has none.
 *
 * If Mailpit changes one of those shapes, the right failure is this file going red rather than
 * the demo going quietly wrong on stage.
 */

import { describe, expect, test } from "bun:test";

import { steppingClock } from "../mailbox/clock.ts";
import { MemoryMailboxProvider } from "../mailbox/memory.ts";
import { MailpitProvider } from "../mailbox/mailpit.ts";
import type { FetchLike } from "../mailbox/mailpit.ts";
import type { Mailbox, MailboxProvider } from "../mailbox/port.ts";
import { MailboxError, canScriptRejections, threadRootOf } from "../mailbox/port.ts";

const T0 = "2026-08-20T09:00:00.000Z";

function memory(): MemoryMailboxProvider {
  return new MemoryMailboxProvider({ clock: steppingClock(T0) });
}

async function konaBox(provider: MailboxProvider): Promise<Mailbox> {
  return provider.provision({ address: "ilya@kona.demo", display_name: "Ilya" });
}

describe("threadRootOf", () => {
  test("prefers the References root over the message it directly replies to", () => {
    // The one-level-deep version of this is the bug that only appears at the third message:
    // a reply to a reply would name the INTERMEDIATE message and split one thread in two.
    expect(
      threadRootOf({
        references: ["<root@x>", "<middle@x>"],
        in_reply_to: "<middle@x>",
        message_id: "<leaf@x>",
      }),
    ).toBe("<root@x>");
  });

  test("falls back to in_reply_to, then to itself", () => {
    expect(threadRootOf({ in_reply_to: "<parent@x>", message_id: "<leaf@x>" })).toBe("<parent@x>");
    expect(threadRootOf({ message_id: "<alone@x>" })).toBe("<alone@x>");
  });
});

describe("memory provider", () => {
  test("provision is idempotent — the same address twice is the same mailbox", async () => {
    const provider = memory();
    const first = await konaBox(provider);
    const second = await konaBox(provider);
    expect(second).toEqual(first);
  });

  test("every send records provider and realm", async () => {
    const provider = memory();
    const from = await konaBox(provider);
    const receipt = await provider.send({
      from,
      to: ["personas+dana@kona.demo"],
      subject: "Thursday",
      body_text: "can you play?",
      reply_to: "ilya+kona-ask-dana-to-play-in-goal@kona.demo",
    });
    expect(receipt.provider).toBe("memory");
    expect(receipt.sandbox_or_real).toBe("sandbox");
    expect(receipt.accepted_at).toBe(T0);
  });

  test("a reply is pollable on the thread its send opened", async () => {
    const provider = memory();
    const from = await konaBox(provider);
    const sent = await provider.send({
      from,
      to: ["personas+dana@kona.demo"],
      subject: "Thursday",
      body_text: "can you play?",
      reply_to: "ilya+kona-ask-dana-to-play-in-goal@kona.demo",
    });

    const dana = await provider.provision({
      address: "personas+dana@kona.demo",
      display_name: "Dana Whitfield",
    });
    await provider.send({
      from: dana,
      to: ["ilya+kona-ask-dana-to-play-in-goal@kona.demo"],
      subject: "Re: Thursday",
      body_text: "away that week",
      in_reply_to: sent.message_id,
      references: [sent.message_id],
    });

    const page = await provider.pollThread({ thread: sent.thread, cursor: null });
    const bodies = page.messages.map((message) => message.body_text);
    // Both halves: a capture sink holds the outbound copy too, which is what a shared mailbox
    // genuinely looks like. The caller filters on `from`.
    expect(bodies).toEqual(["can you play?", "away that week"]);
  });

  test("the cursor does not re-deliver, and does not skip", async () => {
    const provider = memory();
    const from = await konaBox(provider);
    const sent = await provider.send({
      from,
      to: ["personas+pat@kona.demo"],
      subject: "Thursday",
      body_text: "first",
    });

    const first = await provider.pollThread({ thread: sent.thread, cursor: null });
    expect(first.messages).toHaveLength(1);

    const second = await provider.pollThread({ thread: sent.thread, cursor: first.cursor });
    expect(second.messages).toHaveLength(0);
    expect(second.cursor).toBe(first.cursor);

    await provider.send({
      from,
      to: ["personas+pat@kona.demo"],
      subject: "Re: Thursday",
      body_text: "second",
      in_reply_to: sent.message_id,
      references: [sent.message_id],
    });
    const third = await provider.pollThread({ thread: sent.thread, cursor: second.cursor });
    expect(third.messages.map((message) => message.body_text)).toEqual(["second"]);
  });

  test("a scripted rejection throws SEND_REJECTED and captures nothing", async () => {
    const provider = memory();
    const from = await konaBox(provider);
    provider.rejectRecipient("personas+priya@kona.demo", 550, "550 5.1.1 user unknown");

    expect(canScriptRejections(provider)).toBe(true);
    let thrown: unknown;
    try {
      await provider.send({
        from,
        to: ["personas+priya@kona.demo"],
        subject: "Thursday",
        body_text: "can you play?",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MailboxError);
    expect((thrown as MailboxError).reason).toBe("SEND_REJECTED");
    expect((thrown as MailboxError).smtp_code).toBe(550);
    // A refused send did not happen. Recording one would let the graph believe an email is in
    // flight that never left.
    expect(provider.sent).toHaveLength(0);
    expect(provider.captured()).toHaveLength(0);
  });

  test("a run reproduces: the same script twice yields the same message ids", async () => {
    const ids = async (): Promise<string[]> => {
      const provider = memory();
      const from = await konaBox(provider);
      const one = await provider.send({ from, to: ["a@kona.demo"], subject: "s", body_text: "b" });
      const two = await provider.send({ from, to: ["b@kona.demo"], subject: "s", body_text: "b" });
      return [one.message_id, two.message_id, one.accepted_at, two.accepted_at];
    };
    expect(await ids()).toEqual(await ids());
  });
});

/* ── the Mailpit contract, replayed from a live v1.31.0 ──────────────────────────────── */

/** Verbatim from a live instance: `Address` on read, and NO threading headers here. */
const MESSAGE_BODY = {
  ID: "7dAlowI14BzsqtLOcdQ2tn",
  MessageID: "kona-1@kona.demo",
  From: { Name: "Dana Whitfield", Address: "personas+dana@kona.demo" },
  To: [{ Name: "", Address: "ilya+kona-ask-dana-to-play-in-goal@kona.demo" }],
  ReplyTo: [],
  Subject: "Re: Thursday — can you play?",
  Date: "2026-08-22T01:04:47Z",
  Text: "away that week",
  Size: 828,
};

/** Verbatim: keys Go-canonicalised, values are ARRAYS, angle brackets KEPT. */
const MESSAGE_HEADERS = {
  Date: ["Sat, 22 Aug 2026 01:04:47 +0000"],
  From: ['"Dana Whitfield" <personas+dana@kona.demo>'],
  "In-Reply-To": ["<kona-root@kona.demo>"],
  "Message-Id": ["<kona-1@kona.demo>"],
  References: ["<kona-root@kona.demo>"],
  Subject: ["Re: Thursday — can you play?"],
  To: ['<ilya+kona-ask-dana-to-play-in-goal@kona.demo>'],
};

function json(value: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

interface StubCall {
  method: string;
  path: string;
  body: unknown;
}

function stubMailpit(calls: StubCall[]): FetchLike {
  return (input, init) => {
    const path = input.replace("http://localhost:8025", "");
    const method = init?.method ?? "GET";
    const raw = init?.body;
    calls.push({ method, path, body: typeof raw === "string" ? JSON.parse(raw) : undefined });

    if (path === "/api/v1/info") return json({ Version: "v1.31.0", Messages: 1 });
    if (path === "/api/v1/send") return json({ ID: "7dAlowI14BzsqtLOcdQ2tn" });
    if (path.startsWith("/api/v1/messages")) {
      return json({
        total: 1,
        messages_count: 1,
        start: 0,
        messages: [
          {
            ID: MESSAGE_BODY.ID,
            MessageID: MESSAGE_BODY.MessageID,
            Subject: MESSAGE_BODY.Subject,
            Created: "2026-08-22T01:04:47.593Z",
          },
        ],
      });
    }
    if (path.endsWith("/headers")) return json(MESSAGE_HEADERS);
    if (path.startsWith("/api/v1/message/")) return json(MESSAGE_BODY);
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
}

describe("mailpit provider", () => {
  test("sends `Email` keys, pins the Message-ID, and never puts Reply-To in Headers", async () => {
    const calls: StubCall[] = [];
    const provider = new MailpitProvider({ clock: steppingClock(T0), fetch: stubMailpit(calls) });
    const from = await provider.provision({ address: "ilya@kona.demo", display_name: "Ilya" });
    const receipt = await provider.send({
      from,
      to: ["personas+dana@kona.demo"],
      subject: "Thursday — can you play?",
      body_text: "can you play?",
      reply_to: "ilya+kona-ask-dana-to-play-in-goal@kona.demo",
    });

    const send = calls.find((call) => call.path === "/api/v1/send");
    const body = send?.body as Record<string, unknown>;
    expect(body["From"]).toEqual({ Email: "ilya@kona.demo", Name: "Ilya" });
    expect(body["To"]).toEqual([{ Email: "personas+dana@kona.demo", Name: "" }]);
    // Reply-To is on Mailpit's case-insensitive restricted list; via Headers it is a hard 400.
    expect(body["ReplyTo"]).toEqual([
      { Email: "ilya+kona-ask-dana-to-play-in-goal@kona.demo", Name: "" },
    ]);
    const headers = body["Headers"] as Record<string, string>;
    expect(headers["Reply-To"]).toBeUndefined();
    expect(headers["Message-ID"]).toBe("<kona-1@kona.demo>");

    // The receipt carries the RFC id we pinned, NOT Mailpit's database key.
    expect(receipt.message_id).toBe("<kona-1@kona.demo>");
    expect(receipt.message_id).not.toBe("7dAlowI14BzsqtLOcdQ2tn");
    expect(receipt.provider).toBe("mailpit");
    expect(receipt.sandbox_or_real).toBe("sandbox");
  });

  test("reads addresses from `Address`, and threading from the separate headers endpoint", async () => {
    const calls: StubCall[] = [];
    const provider = new MailpitProvider({ clock: steppingClock(T0), fetch: stubMailpit(calls) });
    const page = await provider.pollThread({
      thread: { kind: "provider_thread", id: "<kona-root@kona.demo>" },
      cursor: null,
    });

    expect(page.messages).toHaveLength(1);
    const message = page.messages[0];
    expect(message?.from).toBe("Dana Whitfield <personas+dana@kona.demo>");
    // Round-tripped through the write-side `Email` / read-side `Address` flip.
    expect(message?.to).toEqual(["ilya+kona-ask-dana-to-play-in-goal@kona.demo"]);
    // Normalised to bracket form: the summary strips them and /headers keeps them.
    expect(message?.message_id).toBe("<kona-1@kona.demo>");
    expect(message?.in_reply_to).toBe("<kona-root@kona.demo>");
    expect(message?.references).toEqual(["<kona-root@kona.demo>"]);
    expect(calls.some((call) => call.path.endsWith("/headers"))).toBe(true);
  });

  test("polls by listing and filtering, never by the search endpoint", async () => {
    const calls: StubCall[] = [];
    const provider = new MailpitProvider({ clock: steppingClock(T0), fetch: stubMailpit(calls) });
    await provider.pollThread({
      thread: { kind: "delivered_to", address: "ilya+kona-ask-dana-to-play-in-goal@kona.demo" },
      cursor: null,
    });
    // `?query=to:...` is a trap twice over: quoting is unreliable, and the index it searches
    // includes Reply-To — which is where Kona's own correlation address lives.
    expect(calls.some((call) => call.path.startsWith("/api/v1/search"))).toBe(false);
    expect(calls.some((call) => call.path.startsWith("/api/v1/messages"))).toBe(true);
  });

  test("a message addressed elsewhere is not returned by a delivered_to poll", async () => {
    const provider = new MailpitProvider({
      clock: steppingClock(T0),
      fetch: stubMailpit([]),
    });
    const page = await provider.pollThread({
      thread: { kind: "delivered_to", address: "ilya+kona-ask-pat-to-play-in-goal@kona.demo" },
      cursor: null,
    });
    expect(page.messages).toHaveLength(0);
    // The cursor still advances over what was SCANNED, or a poll that matches nothing would
    // rescan the same page forever.
    expect(page.cursor).toBe(MESSAGE_BODY.ID);
  });

  test("an unreachable server is PROVIDER_UNREACHABLE, not a stack trace", async () => {
    const provider = new MailpitProvider({
      clock: steppingClock(T0),
      fetch: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:8025")),
    });
    let thrown: unknown;
    try {
      await provider.healthcheck();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MailboxError);
    expect((thrown as MailboxError).reason).toBe("PROVIDER_UNREACHABLE");
  });

  test("pages back to a cursor rather than losing everything behind one window", async () => {
    // The regression guard on a measured data-loss bug. The first version asked for
    // `limit=MAX_SCAN` and also stopped the scan at MAX_SCAN, so the window could never reach
    // back past the cursor: once more than one window's worth of mail arrived between two
    // polls, the loop fell off the end and the cursor jumped to the NEWEST message. Against a
    // live v1.31.0, two replies sitting behind 2100 unrelated messages were lost permanently.
    //
    // 900 messages here with a 200-message page means at least five pages must be walked.
    const TOTAL = 900;
    const store = Array.from({ length: TOTAL }, (_, index) => ({
      ID: `db-${TOTAL - index}`,
      MessageID: `msg-${TOTAL - index}@kona.demo`,
      Subject: "s",
      Created: "2026-08-22T01:04:47.593Z",
    })); // newest first, as Mailpit returns them

    let pages = 0;
    const provider = new MailpitProvider({
      clock: steppingClock(T0),
      fetch: (input) => {
        const url = new URL(input);
        if (url.pathname === "/api/v1/info") return json({ Version: "v1.31.0" });
        if (url.pathname === "/api/v1/messages") {
          pages += 1;
          const start = Number(url.searchParams.get("start") ?? "0");
          const limit = Number(url.searchParams.get("limit") ?? "50");
          return json({
            messages_count: TOTAL,
            total: TOTAL,
            start,
            messages: store.slice(start, start + limit),
          });
        }
        if (url.pathname.endsWith("/headers")) return json({});
        return json({ ID: "x", MessageID: url.pathname.split("/")[4] ?? "", To: [], From: {} });
      },
    });

    // Cursor at db-100 — 800 newer messages sit above it, four windows deep.
    const page = await provider.pollThread({
      thread: { kind: "delivered_to", address: "nobody@kona.demo" },
      cursor: "db-100",
    });
    expect(pages).toBeGreaterThan(4);
    // Nothing matched the address, but the cursor still advanced over everything SCANNED —
    // and crucially it advanced to the newest scanned message, having actually reached back
    // to the cursor rather than giving up.
    expect(page.cursor).toBe("db-900");
  });

  test("refuses to advance past a gap it cannot see across", async () => {
    // The other half. If the scan bound is hit while messages remain, the gap is real and
    // unknown — and silently advancing the cursor over it is exactly the data loss above.
    const TOTAL = 50_000;
    const provider = new MailpitProvider({
      clock: steppingClock(T0),
      fetch: (input) => {
        const url = new URL(input);
        if (url.pathname === "/api/v1/info") return json({ Version: "v1.31.0" });
        const start = Number(url.searchParams.get("start") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "50");
        return json({
          messages_count: TOTAL,
          total: TOTAL,
          start,
          messages: Array.from({ length: limit }, (_, index) => ({
            ID: `db-${start + index}`,
            MessageID: `msg-${start + index}@kona.demo`,
            Subject: "s",
            Created: "2026-08-22T01:04:47.593Z",
          })),
        });
      },
    });

    let thrown: unknown;
    try {
      await provider.pollThread({
        thread: { kind: "delivered_to", address: "nobody@kona.demo" },
        // A cursor far beyond the scan bound, as a pruned or long-unpolled one would be.
        cursor: "db-49999",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MailboxError);
    expect((thrown as MailboxError).reason).toBe("CURSOR_LOST");
  });

  test("both providers render `from` identically for a mailbox with no display name", async () => {
    // `InboundMessage.from` exists to be normalised, and `ThreadPage` tells callers to filter
    // on it. Two implementations disagreeing here — `" <anon@x>"` versus `"anon@x"` — would
    // make that filter classify every message the wrong way round on one of them.
    const memoryProvider = memory();
    const anon = await memoryProvider.provision({ address: "anon@kona.demo", display_name: "" });
    const sent = await memoryProvider.send({
      from: anon,
      to: ["someone@kona.demo"],
      subject: "s",
      body_text: "b",
    });
    const fromMemory = (
      await memoryProvider.pollThread({ thread: sent.thread, cursor: null })
    ).messages[0]?.from;

    const mailpitProvider = new MailpitProvider({
      clock: steppingClock(T0),
      fetch: (input) => {
        const url = new URL(input);
        if (url.pathname === "/api/v1/info") return json({ Version: "v1.31.0" });
        if (url.pathname === "/api/v1/messages") {
          return json({
            messages_count: 1,
            total: 1,
            start: 0,
            messages: [{ ID: "db-1", MessageID: "m-1@kona.demo", Subject: "s", Created: "" }],
          });
        }
        if (url.pathname.endsWith("/headers")) return json({});
        return json({
          MessageID: "m-1@kona.demo",
          From: { Name: "", Address: "anon@kona.demo" },
          To: [{ Name: "", Address: "someone@kona.demo" }],
          Text: "b",
        });
      },
    });
    const fromMailpit = (
      await mailpitProvider.pollThread({
        thread: { kind: "delivered_to", address: "someone@kona.demo" },
        cursor: null,
      })
    ).messages[0]?.from;

    expect(fromMemory).toBe("anon@kona.demo");
    expect(fromMailpit).toBe(fromMemory);
  });

  test("a catch-all cannot be scripted to refuse, and says so", () => {
    const provider = new MailpitProvider({ clock: steppingClock(T0), fetch: stubMailpit([]) });
    // This is why Priya's 550 is narrated as staged on the Mailpit path.
    expect(canScriptRejections(provider)).toBe(false);
  });
});
