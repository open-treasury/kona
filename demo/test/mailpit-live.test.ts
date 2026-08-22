/**
 * The Mailpit implementation against a REAL Mailpit — and **skipped, not failed**, when there
 * is none.
 *
 * `demo/test/mailbox.test.ts` pins the API contract against a stub, which is what keeps
 * `bun run check` green everywhere. That is necessary and not sufficient: a stub proves the
 * client parses what the docs say Mailpit returns, not that Mailpit returns it. This file
 * closes that gap when a server happens to be there.
 *
 * Skipping is the deliberate choice, and so is the thing it must NOT do: fall back to the
 * in-process provider. A fallback would make this file pass forever while testing nothing,
 * and the Mailpit path would rot untested behind a green tick.
 *
 * ```bash
 * docker run --rm -p 8025:8025 -p 1025:1025 axllent/mailpit:v1.31.0 --max 0
 * bun test demo/test/mailpit-live.test.ts
 * ```
 */

import { describe, expect, test } from "bun:test";

import { steppingClock } from "../mailbox/clock.ts";
import { DEFAULT_MAILPIT_URL, MailpitProvider } from "../mailbox/mailpit.ts";

const T0 = "2026-08-20T09:00:00.000Z";

/**
 * A live server, or `null`. Probed once at module load.
 *
 * The probe is `GET /api/v1/info`, which is the same healthcheck `provision` uses, and a
 * refused connection to localhost fails in microseconds — so the cost to everyone without
 * Mailpit is nil.
 */
const live: string | null = await (async (): Promise<string | null> => {
  const url = process.env["KONA_MAILPIT_URL"] ?? DEFAULT_MAILPIT_URL;
  try {
    const response = await fetch(`${url}/api/v1/info`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok ? url : null;
  } catch {
    return null;
  }
})();

/** Unique per run, because a Mailpit instance is one global store shared with every other run. */
const RUN_TAG = `live${process.pid}`;

describe("mailpit, live", () => {
  test.skipIf(live === null)("round-trips a send and its reply, with real threading", async () => {
    if (live === null) return;
    const provider = new MailpitProvider({
      clock: steppingClock(T0),
      baseUrl: live,
      idPrefix: RUN_TAG,
    });

    const version = await provider.healthcheck();
    expect(version).toMatch(/^v\d+\./);

    const kona = await provider.provision({
      address: `ilya-${RUN_TAG}@kona.demo`,
      display_name: "Ilya Vorobiev (via Kona)",
    });
    const correlation = `ilya-${RUN_TAG}+kona-ask-dana-to-play-in-goal@kona.demo`;

    const sent = await provider.send({
      from: kona,
      to: [`personas-${RUN_TAG}+dana@kona.demo`],
      subject: `Thursday — can you play? [${RUN_TAG}]`,
      body_text: "can you play?",
      reply_to: correlation,
    });
    // The RFC id this client pinned, not Mailpit's database key.
    expect(sent.message_id).toBe(`<${RUN_TAG}-1@kona.demo>`);

    const dana = await provider.provision({
      address: `personas-${RUN_TAG}+dana@kona.demo`,
      display_name: "Dana Whitfield",
    });
    await provider.send({
      from: dana,
      to: [correlation],
      subject: `Re: Thursday — can you play? [${RUN_TAG}]`,
      body_text: "away that week",
      in_reply_to: sent.message_id,
      references: [sent.message_id],
    });

    const page = await provider.pollThread({ thread: sent.thread, cursor: null });
    const bodies = page.messages.map((message) => message.body_text);
    expect(bodies).toEqual(["can you play?", "away that week"]);

    const reply = page.messages.at(-1);
    // Threading survived a real round trip through a real server: the reply's References
    // names the send, and the plus-tag reached the To line unmangled.
    expect(reply?.in_reply_to).toBe(sent.message_id);
    expect(reply?.references).toEqual([sent.message_id]);
    expect(reply?.to).toEqual([correlation]);
    expect(reply?.from).toBe(`Dana Whitfield <personas-${RUN_TAG}+dana@kona.demo>`);
  });

  test.skipIf(live === null)("a delivered_to poll finds the correlation address", async () => {
    if (live === null) return;
    const provider = new MailpitProvider({
      clock: steppingClock(T0),
      baseUrl: live,
      idPrefix: `${RUN_TAG}b`,
    });
    const correlation = `ilya-${RUN_TAG}b+kona-ask-pat-to-play-in-goal@kona.demo`;
    const pat = await provider.provision({
      address: `personas-${RUN_TAG}b+pat@kona.demo`,
      display_name: "Pat Lindqvist",
    });
    await provider.send({
      from: pat,
      to: [correlation],
      subject: `Re: Thursday [${RUN_TAG}b]`,
      body_text: "eventually",
    });

    const page = await provider.pollThread({
      thread: { kind: "delivered_to", address: correlation },
      cursor: null,
    });
    expect(page.messages.map((message) => message.body_text)).toEqual(["eventually"]);
  });

  test.skipIf(live === null)("a catch-all accepts an address nobody owns", async () => {
    if (live === null) return;
    const provider = new MailpitProvider({ clock: steppingClock(T0), baseUrl: live });
    const from = await provider.provision({
      address: `ilya-${RUN_TAG}c@kona.demo`,
      display_name: "Ilya",
    });
    // The documented reason Priya's 550 cannot be transported on this path. If this ever
    // throws, Mailpit grew a rejection mechanism and the staged bounce could become real.
    const receipt = await provider.send({
      from,
      to: [`nobody-${RUN_TAG}@invalid.invalid`],
      subject: "into the void",
      body_text: "accepted anyway",
    });
    expect(receipt.sandbox_or_real).toBe("sandbox");
  });
});
