/**
 * `kona poll` through the real verb.
 *
 * Two halves, and the seam between them is the determinism law: poll says WHICH wait a
 * reply belongs to, and stops. What the reply SAYS is a judgement, and the binary does not
 * make judgements.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboundMatch, WaitAddress } from "@kona/core";
import { run } from "../src/cli.ts";
import { harness, type Harness } from "./harness.ts";

let h: Harness;

const CONFIG = {
  identity: {
    mailbox: "ilya@example.com",
    display_name: "Ilya Vorobiev",
    signature: "— Ilya",
    authority: "You may not commit funds.",
  },
  effect_budget: 5,
};

const PLAN = [
  {
    op: "add_activity",
    name: "Escalate",
    type: "task",
    spec: { instruction: "Tell Ilya.", effect_class: "pure" },
  },
  {
    op: "add_activity",
    name: "Await Dana",
    type: "wait",
    spec: {
      instruction: "Await Dana's reply.",
      effect_class: "pure",
      deadline: { at: "2026-08-30T12:00:00.000Z" },
      on_timeout: "$0",
      match: {
        kind: "event",
        conditions: [
          { kind: "reply", on: "satisfied" },
          { kind: "deadline", on: "timeout" },
        ],
      },
    },
  },
];

// Built inside a test: the reply address embeds a minted id, so there is nothing to
// build until a pursuit exists.
const DANA = () => ({
  message_id: "<dana-1@mail>",
  from: "Dana <dana@example.com>",
  to: [`ilya+kona-${h.id("await-dana")}@example.com`],
  subject: "Re: Thursday",
  received_at: "2026-08-22T10:00:00.000Z",
});

async function initWith(config: unknown): Promise<void> {
  h = harness();
  if (config === null) {
    expect(await run(["init", "--prefix", "t"], h.io)).toBe(0);
  } else {
    const path = join(h.dir, "config.json");
    writeFileSync(path, JSON.stringify(config));
    expect(await run(["init", "--config", path, "--prefix", "t"], h.io)).toBe(0);
  }
  const ops = h.writeOps("ops.json", PLAN);
  expect(
    await run(["mutate", "--ops", ops, "--base-version", "0", "--why", "plan", "--reason-code", "MISSING_STEP"], h.io),
  ).toBe(0);
  h.reset();
}

beforeEach(async () => {
  await initWith(CONFIG);
});
afterEach(() => h.cleanup());

function inboundFile(messages: unknown[]): string {
  const path = join(h.dir, "inbound.json");
  writeFileSync(path, JSON.stringify(messages));
  return path;
}

async function pollJson(messages?: unknown[]): Promise<Record<string, unknown>> {
  h.reset();
  const args = messages === undefined ? ["poll", "--json"] : ["poll", "--json", "--inbound", inboundFile(messages)];
  expect(await run(args, h.io)).toBe(0);
  return JSON.parse(h.out[0] ?? "{}") as Record<string, unknown>;
}

describe("with no --inbound, it says what to fetch", () => {
  test("the fully expanded reply address of each pollable wait", async () => {
    const payload = await pollJson();
    expect(payload["poll"]).toEqual([
      {
        activity_id: h.id("await-dana"),
        name: "Await Dana",
        address: `ilya+kona-${h.id("await-dana")}@example.com`,
        armed: true,
      },
    ] as WaitAddress[]);
  });

  test("the human rendering marks armed against resolved", async () => {
    h.reset();
    expect(await run(["poll"], h.io)).toBe(0);
    expect(h.out[0]).toContain("1 address(es) to poll");
    expect(h.out.join("\n")).toContain("armed");
    expect(h.out.join("\n")).toContain(`ilya+kona-${h.id("await-dana")}@example.com`);
  });

  test("a pursuit with nothing awaiting mail says so", async () => {
    const ops = h.writeOps("done.json", [
      { op: "set_status", activity: h.id("await-dana"), status: "dropped", evidence_ref: "e" },
    ]);
    expect(
      await run(["mutate", "--ops", ops, "--base-version", "1", "--why", "stop", "--reason-code", "WITHDRAWN"], h.io),
    ).toBe(0);
    h.reset();
    expect(await run(["poll"], h.io)).toBe(0);
    expect(h.out[0]).toContain("no wait is expecting mail");
  });
});

describe("with --inbound, it says which wait each message is for", () => {
  test("a reply matches its own tag", async () => {
    const payload = await pollJson([DANA()]);
    expect(payload["polled"]).toBe(1);
    expect(payload["matches"]).toEqual([
      {
        activity_id: h.id("await-dana"),
        message_id: "<dana-1@mail>",
        from: "Dana <dana@example.com>",
        subject: "Re: Thursday",
        received_at: "2026-08-22T10:00:00.000Z",
        on: "satisfied",
        late: false,
      },
    ] as InboundMatch[]);
  });

  test("our own outbound copy in the same thread is not a reply", async () => {
    const own = { ...DANA(), message_id: "<own@mail>", from: "Ilya <ilya@example.com>" };
    expect(await pollJson([own])).toMatchObject({ matches: [] });
  });

  test("mail to the untagged mailbox matches nothing", async () => {
    expect(await pollJson([{ ...DANA(), to: ["ilya@example.com"] }])).toMatchObject({ matches: [] });
  });

  test("it stops at WHICH wait — it never reports a verdict", async () => {
    // ⚖ Whether Dana said yes is a judgement about prose, and the binary makes none.
    const payload = await pollJson([DANA()]);
    const [match] = payload["matches"] as InboundMatch[];
    expect(Object.keys(match ?? {})).not.toContain("verdict");
    expect(JSON.stringify(payload)).not.toContain("confirmed");
  });

  test("the human rendering says so out loud", async () => {
    h.reset();
    expect(await run(["poll", "--inbound", inboundFile([DANA()])], h.io)).toBe(0);
    expect(h.out.join("\n")).toContain("What the reply SAYS is a");
    expect(h.out.join("\n")).toContain("record the verdict with kona mutate");
  });

  test("nothing is written — poll is a read verb", async () => {
    const before = (await Bun.file(join(h.dir, ".kona", "mutations.jsonl")).text()).length;
    await pollJson([DANA()]);
    expect((await Bun.file(join(h.dir, ".kona", "mutations.jsonl")).text()).length).toBe(before);
  });

  test("once the orchestrator records it, the same inbox matches nothing", async () => {
    await pollJson([DANA()]);
    const ops = h.writeOps("resolve.json", [
      { op: "record_outcome", activity: h.id("await-dana"), verdict: "confirmed", evidence_ref: "<dana-1@mail>" },
      { op: "set_status", activity: h.id("await-dana"), status: "done", evidence_ref: "<dana-1@mail>" },
    ]);
    expect(
      await run(["mutate", "--ops", ops, "--base-version", "1", "--why", "Dana is in", "--reason-code", "QUORUM_MET"], h.io),
    ).toBe(0);
    expect(await pollJson([DANA()])).toMatchObject({ matches: [] });
  });

  test("but a NEW straggler on a resolved wait is matched and flagged late", async () => {
    const ops = h.writeOps("resolve.json", [
      { op: "record_outcome", activity: h.id("await-dana"), verdict: "confirmed", evidence_ref: "<dana-1@mail>" },
      { op: "set_status", activity: h.id("await-dana"), status: "done", evidence_ref: "<dana-1@mail>" },
    ]);
    expect(
      await run(["mutate", "--ops", ops, "--base-version", "1", "--why", "in", "--reason-code", "QUORUM_MET"], h.io),
    ).toBe(0);
    const payload = await pollJson([{ ...DANA(), message_id: "<dana-2@mail>" }]);
    expect((payload["matches"] as InboundMatch[])[0]?.late).toBe(true);
  });
});

describe("it refuses rather than guessing", () => {
  test("a pursuit with no identity has no address to derive", async () => {
    h.cleanup();
    await initWith(null);
    h.reset();
    expect(await run(["poll"], h.io)).toBe(1);
    expect(h.err[0]).toContain("NO_IDENTITY");
  });

  test("an unreadable inbound file", async () => {
    const path = join(h.dir, "bad.json");
    writeFileSync(path, "{not json");
    h.reset();
    expect(await run(["poll", "--inbound", path], h.io)).toBe(1);
    expect(h.err[0]).toContain("UNREADABLE_INBOUND");
  });

  test.each([
    ["not an array", { message_id: "<a>" }],
    ["a message with no id", [{ from: "a@b", to: [] }]],
    ["a message with no sender", [{ message_id: "<a>", to: [] }]],
    ["a message with no recipients", [{ message_id: "<a>", from: "a@b" }]],
  ])("%s", async (_name, body) => {
    const path = join(h.dir, "bad.json");
    writeFileSync(path, JSON.stringify(body));
    h.reset();
    expect(await run(["poll", "--inbound", path], h.io)).toBe(1);
    expect(h.err[0]).toContain("MALFORMED_INBOUND");
  });

  test("outside a pursuit", async () => {
    const outside = harness();
    try {
      expect(await run(["poll"], outside.io)).toBe(1);
      expect(outside.err[0]).toContain("NO_PURSUIT");
    } finally {
      outside.cleanup();
    }
  });
});
