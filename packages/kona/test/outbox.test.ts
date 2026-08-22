/**
 * `kona effect reserve|record` through the real verb, against a real log (6.6, 7).
 *
 * The spec's crash table has three rows, and two of them leave IDENTICAL bytes on disk —
 * a `sending` node with `completed_at: null`. Nothing in the log distinguishes "fsynced
 * but never sent" from "sent but never recorded", which is why the safe behaviour is that
 * re-reserving the same payload is a no-op rather than a send, and why resume must hand
 * the state to a human rather than retry it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphProjection, Node } from "@kona/core";
import { run } from "../src/cli.ts";
import { effectKey } from "../src/hash.ts";
import { harness, seedRoster, type Harness } from "./harness.ts";

let h: Harness;

const PIVOT = [
  {
    op: "add_node",
    label: "Ask Dana",
    type: "task",
    spec: {
      instruction: "Email Dana.",
      outputs: [{ name: "sent", type: "string" }],
      effect_class: "pivot",
      effect: { channel: "email", recipient_ref: "roster#dana" },
    },
  },
  {
    op: "add_node",
    label: "Confirm roster",
    type: "task",
    spec: { instruction: "Read the roster.", effect_class: "pure" },
  },
];

/** The key for `ask-dana`, created at v1. Computed the same way the CLI computes it. */
/** `ask-dana` is created at v3 now: the roster seed takes v1 and v2. */
const KEY = effectKey("ask-dana", 3);

/** Invariant 3(a) fails closed on an unconfigured cap, so a pursuit that sends needs one. */
const CONFIG = {
  identity: {
    mailbox: "ilya@example.com",
    display_name: "Ilya Vorobiev",
    signature: "— Ilya",
    authority: "You may not commit funds.",
  },
  effect_budget: 5,
};

beforeEach(async () => {
  h = harness();
  const config = join(h.dir, "config.json");
  writeFileSync(config, JSON.stringify(CONFIG));
  expect(await run(["init", "--config", config], h.io)).toBe(0);
  await seedRoster(h, ["dana"]);
  const ops = h.writeOps("ops.json", PIVOT);
  expect(
    await run(["mutate", "--ops", ops, "--base-version", "2", "--why", "ask", "--reason-code", "MISSING_STEP"], h.io),
  ).toBe(0);
  h.reset();
});
afterEach(() => h.cleanup());

async function nodeOf(id: string): Promise<Node> {
  h.reset();
  expect(await run(["graph", "--json"], h.io)).toBe(0);
  const projection = JSON.parse(h.out[0] ?? "{}") as GraphProjection;
  const node = projection.nodes.find((n) => n.id === id);
  if (node === undefined) throw new Error(`no node ${id}`);
  return node;
}

function logLineCount(): number {
  return readFileSync(join(h.dir, ".kona", "mutations.jsonl"), "utf8").trim().split("\n").length;
}

async function reserve(payloadHash: string, node = "ask-dana"): Promise<number> {
  h.reset();
  return await run(
    ["effect", "reserve", node, "--payload-hash", payloadHash, "--why", "sending the invite"],
    h.io,
  );
}

async function record(key: string, outcome: string, messageId: string): Promise<number> {
  h.reset();
  return await run(
    ["effect", "record", "ask-dana", "--key", key, "--outcome", outcome, "--message-id", messageId, "--why", "provider replied"],
    h.io,
  );
}

describe("reserve", () => {
  test("appends the intent, moves the node to sending, and fsyncs before anything is sent", async () => {
    expect(await reserve("sha256:aaa")).toBe(0);
    const node = await nodeOf("ask-dana");
    expect(node.status.state).toBe("in_flight");
    expect(node.status.effect_log).toHaveLength(1);
    expect(node.status.effect_log[0]?.effect_key).toBe(KEY);
    expect(node.status.effect_log[0]?.payload_hash).toBe("sha256:aaa");
    expect(node.status.effect_log[0]?.completed_at).toBeNull();
  });

  test("the key is payload-independent — the same slot for a different body", async () => {
    expect(await reserve("sha256:aaa")).toBe(0);
    const first = (await nodeOf("ask-dana")).status.effect_log[0]?.effect_key;
    expect(first).toBe(effectKey("ask-dana", 3));
    // Nothing about the payload participates: the key is a function of node and version.
    expect(first).not.toContain("aaa");
  });

  test("refuses a node that moves no bytes", async () => {
    expect(await reserve("sha256:aaa", "confirm-roster")).toBe(1);
    expect(h.err[0]).toContain("NOT_AN_EFFECT_NODE");
  });

  test("refuses a node that does not exist", async () => {
    expect(await reserve("sha256:aaa", "ghost")).toBe(1);
    expect(h.err[0]).toContain("UNKNOWN_NODE");
  });

  test("--payload-hash is required — the hash is what proves the bytes were approved", async () => {
    h.reset();
    expect(await run(["effect", "reserve", "ask-dana", "--why", "x"], h.io)).toBe(1);
    expect(h.err[0]).toContain("--payload-hash");
  });

  test("--why is required, exactly as on every other mutating verb", async () => {
    h.reset();
    expect(await run(["effect", "reserve", "ask-dana", "--payload-hash", "h"], h.io)).toBe(1);
    expect(h.err[0]).toContain("--why");
  });

  test("the reservation is a real mutation carrying a real rationale", async () => {
    expect(await reserve("sha256:aaa")).toBe(0);
    const lines = readFileSync(join(h.dir, ".kona", "mutations.jsonl"), "utf8").trim().split("\n");
    const reservation = JSON.parse(lines.at(-1) ?? "");
    expect(reservation.rationale.why).toBe("sending the invite");
    expect(reservation.actor.kind).toBe("subagent");
    expect(reservation.outcome).toBeNull();
    // The field always exists, even where the verb offers no way to supply it.
    expect(reservation.rationale.alternatives_rejected).toEqual([]);
    expect(reservation.rationale.reason_code).toBe("OTHER");
  });
});

describe("the three crash windows (6.6)", () => {
  test("window 1 — crash between append and fsync: nothing happened", async () => {
    // Nothing is written until fsync returns, so the node is still dispatchable.
    expect((await nodeOf("ask-dana")).status.state).toBe("active");
    expect((await nodeOf("ask-dana")).status.effect_log).toEqual([]);
  });

  test("window 2 — crash between fsync and send: re-reserving the SAME payload is a no-op", async () => {
    expect(await reserve("sha256:aaa")).toBe(0);
    expect(await reserve("sha256:aaa")).toBe(0);
    expect(h.out[0]).toContain("already reserved");
    // One entry: the retry moved nothing and sent nothing.
    expect((await nodeOf("ask-dana")).status.effect_log).toHaveLength(1);
  });

  test("window 2 — the retry does not append a version", async () => {
    expect(await reserve("sha256:aaa")).toBe(0);
    const before = logLineCount();
    expect(await reserve("sha256:aaa")).toBe(0);
    expect(logLineCount()).toBe(before);
  });

  test("window 3 — sent but not recorded leaves the same bytes as window 2, and stays sending", async () => {
    expect(await reserve("sha256:aaa")).toBe(0);
    const node = await nodeOf("ask-dana");
    // This is genuinely indistinguishable from window 2 in the log. `sending` means the
    // world's answer is unknown — not that nothing happened.
    expect(node.status.state).toBe("in_flight");
    expect(node.status.effect_log[0]?.completed_at).toBeNull();
    expect(node.status.effect_log[0]?.outcome).toBeNull();
  });
});

describe("a rewritten body is a loud error, never a second send", () => {
  test("same key, different payload_hash is refused", async () => {
    expect(await reserve("sha256:aaa")).toBe(0);
    expect(await reserve("sha256:bbb")).toBe(1);
    expect(h.err[0]).toContain("EFFECT_PAYLOAD_MISMATCH");
    expect(h.err[0]).toContain("sha256:aaa");
    expect(h.err[0]).toContain("sha256:bbb");
  });

  test("the check is REACHABLE, which is the whole point of a payload-independent key", async () => {
    // A key derived from the body would yield a different key for a different body, so
    // this branch could never be entered and the second email would send.
    expect(await reserve("sha256:aaa")).toBe(0);
    await reserve("sha256:bbb");
    expect((await nodeOf("ask-dana")).status.effect_log).toHaveLength(1);
  });

  test("and it is never a silent no-op", async () => {
    expect(await reserve("sha256:aaa")).toBe(0);
    expect(await reserve("sha256:bbb")).not.toBe(0);
  });
});

describe("record", () => {
  test("closes the reservation and completes the node", async () => {
    expect(await reserve("sha256:aaa")).toBe(0);
    expect(await record(KEY, "sent", "<m-101@mail>")).toBe(0);
    const node = await nodeOf("ask-dana");
    expect(node.status.state).toBe("done");
    expect(node.status.effect_log[0]?.outcome).toBe("sent");
    expect(node.status.effect_log[0]?.message_id).toBe("<m-101@mail>");
    expect(node.status.effect_log[0]?.completed_at).not.toBeNull();
  });

  test("attempted_at and completed_at are distinct fields with distinct meanings", async () => {
    expect(await reserve("sha256:aaa")).toBe(0);
    h.setClock("2026-08-21T12:05:00.000Z");
    expect(await record(KEY, "sent", "<m-101@mail>")).toBe(0);
    const entry = (await nodeOf("ask-dana")).status.effect_log[0];
    expect(entry?.attempted_at).toBe("2026-08-21T12:00:00.000Z");
    expect(entry?.completed_at).toBe("2026-08-21T12:05:00.000Z");
  });

  test("a message id containing a colon survives the round trip", async () => {
    expect(await reserve("sha256:aaa")).toBe(0);
    expect(await record(KEY, "sent", "<m:101:x@mail>")).toBe(0);
    expect((await nodeOf("ask-dana")).status.effect_log[0]?.message_id).toBe("<m:101:x@mail>");
  });

  test("a failure marks the node failed and is NOT a send", async () => {
    expect(await reserve("sha256:aaa")).toBe(0);
    expect(await record(KEY, "failed", "550 user unknown")).toBe(0);
    const node = await nodeOf("ask-dana");
    expect(node.status.state).toBe("failed");
    expect(node.status.effect_log[0]?.outcome).toBe("failed");
  });

  test("refuses when nothing is open — you cannot record a send you never reserved", async () => {
    expect(await record(KEY, "sent", "<m-101@mail>")).toBe(1);
    expect(h.err[0]).toContain("NO_OPEN_EFFECT");
  });

  test("refuses a key that is not the open one", async () => {
    expect(await reserve("sha256:aaa")).toBe(0);
    expect(await record("ek_forged", "sent", "<m-101@mail>")).toBe(1);
    expect(h.err[0]).toContain("EFFECT_KEY_MISMATCH");
    expect(h.err[0]).toContain(KEY);
  });

  test("refuses an outcome outside the closed set", async () => {
    expect(await reserve("sha256:aaa")).toBe(0);
    expect(await record(KEY, "maybe", "<m-101@mail>")).toBe(1);
    expect(h.err[0]).toContain("BAD_FLAG");
  });

  test("recording twice is refused — the slot is closed", async () => {
    expect(await reserve("sha256:aaa")).toBe(0);
    expect(await record(KEY, "sent", "<m-101@mail>")).toBe(0);
    expect(await record(KEY, "sent", "<m-102@mail>")).toBe(1);
    expect(h.err[0]).toContain("NO_OPEN_EFFECT");
  });
});

describe("a node that has moved bytes is never re-executed", () => {
  test("reserving after a successful send is refused", async () => {
    expect(await reserve("sha256:aaa")).toBe(0);
    expect(await record(KEY, "sent", "<m-101@mail>")).toBe(0);
    expect(await reserve("sha256:aaa")).toBe(1);
    expect(h.err[0]).toContain("EFFECT_ALREADY_SENT");
  });

  test("even with a different payload", async () => {
    expect(await reserve("sha256:aaa")).toBe(0);
    expect(await record(KEY, "sent", "<m-101@mail>")).toBe(0);
    expect(await reserve("sha256:zzz")).toBe(1);
    expect(h.err[0]).toContain("EFFECT_ALREADY_SENT");
  });

  test("a node that is not active cannot be dispatched", async () => {
    expect(await reserve("sha256:aaa")).toBe(0);
    expect(await record(KEY, "failed", "550")).toBe(0);
    // `failed` is terminal; the retry path is supersede-with-a-replacement, which mints a
    // new node and therefore a new slot. Nothing re-opens a closed one.
    expect(await reserve("sha256:aaa")).toBe(1);
    expect(h.err[0]).toContain("NOT_DISPATCHABLE");
  });
});

describe("the effect key", () => {
  test("is a readable, fixed-width slot name", () => {
    expect(KEY).toMatch(/^ek_[0-9a-f]{16}$/);
  });

  test("names the slot, and two slots are never the same name", () => {
    expect(effectKey("ask-dana", 1)).not.toBe(effectKey("ask-dana", 2));
    expect(effectKey("ask-dana", 1)).not.toBe(effectKey("ask-sam", 1));
    expect(effectKey("ask-dana", 1)).toBe(effectKey("ask-dana", 1));
  });
});

describe("--json says exactly what happened", () => {
  async function reserveJson(payloadHash: string): Promise<Record<string, unknown>> {
    h.reset();
    expect(
      await run(
        ["effect", "reserve", "ask-dana", "--payload-hash", payloadHash, "--why", "send", "--json"],
        h.io,
      ),
    ).toBe(0);
    return JSON.parse(h.out[0] ?? "{}") as Record<string, unknown>;
  }

  test("a fresh reservation reports the slot and the version it landed at", async () => {
    expect(await reserveJson("sha256:aaa")).toEqual({
      ok: true,
      effect_key: KEY,
      reserved: true,
      idempotent: false,
      version: 4,
    });
  });

  test("a repeat reports the SAME slot, and that it reserved nothing", async () => {
    await reserveJson("sha256:aaa");
    // `reserved: false` with `ok: true` is the whole signal: you already hold this slot,
    // so send it — do not reserve again, and do not treat this as a failure and retry.
    expect(await reserveJson("sha256:aaa")).toEqual({
      ok: true,
      effect_key: KEY,
      reserved: false,
      idempotent: true,
    });
  });

  test("recording reports the outcome and the message id", async () => {
    await reserveJson("sha256:aaa");
    h.reset();
    expect(
      await run(
        ["effect", "record", "ask-dana", "--key", KEY, "--outcome", "sent", "--message-id", "<m-1>", "--why", "ok", "--json"],
        h.io,
      ),
    ).toBe(0);
    expect(JSON.parse(h.out[0] ?? "{}")).toEqual({
      ok: true,
      effect_key: KEY,
      outcome: "sent",
      message_id: "<m-1>",
      version: 5,
    });
  });

  test("the human line names the slot and the version", async () => {
    expect(await reserve("sha256:aaa")).toBe(0);
    expect(h.out[0]).toBe(`reserved ${KEY} at v4 — fsynced, safe to send`);
    expect(await reserve("sha256:aaa")).toBe(0);
    expect(h.out[0]).toBe(`already reserved ${KEY} for this payload — send it, do not re-reserve`);
  });

  test("recording says which slot closed and how", async () => {
    expect(await reserve("sha256:aaa")).toBe(0);
    expect(await record(KEY, "sent", "<m-1>")).toBe(0);
    expect(h.out[0]).toBe(`recorded ${KEY} as sent at v5`);
  });
});

describe("dispatch", () => {
  test("recording against a node that does not exist is refused", async () => {
    h.reset();
    expect(
      await run(
        ["effect", "record", "ghost", "--key", KEY, "--outcome", "sent", "--message-id", "<m-1>", "--why", "x"],
        h.io,
      ),
    ).toBe(1);
    expect(h.err[0]).toContain("UNKNOWN_NODE");
  });

  test("--message-id and --key are both required to record", async () => {
    expect(await reserve("sha256:aaa")).toBe(0);
    h.reset();
    expect(await run(["effect", "record", "ask-dana", "--outcome", "sent", "--message-id", "<m>", "--why", "x"], h.io)).toBe(1);
    expect(h.err[0]).toContain("--key");
    h.reset();
    expect(await run(["effect", "record", "ask-dana", "--key", KEY, "--outcome", "sent", "--why", "x"], h.io)).toBe(1);
    expect(h.err[0]).toContain("--message-id");
  });

  test.each([
    ["no subcommand", ["effect"]],
    ["an unknown subcommand", ["effect", "cancel", "ask-dana"]],
  ])("%s is refused", async (_name, argv) => {
    h.reset();
    expect(await run([...argv, "--why", "x"], h.io)).toBe(1);
    expect(h.err[0]).toContain("BAD_SUBCOMMAND");
  });

  test("a missing node id is refused", async () => {
    h.reset();
    expect(await run(["effect", "reserve", "--why", "x", "--payload-hash", "h"], h.io)).toBe(1);
    expect(h.err[0]).toContain("MISSING_NODE");
  });
});

describe("invariant 3(a): the budget is spent at reserve, not merely advised in brief", () => {
  test("an unconfigured budget refuses the send — an unknown cap is not an unlimited one", async () => {
    const bare = harness();
    try {
      expect(await run(["init"], bare.io)).toBe(0);
      await seedRoster(bare, ["dana"]);
      const ops = bare.writeOps("ops.json", PIVOT);
      expect(
        await run(["mutate", "--ops", ops, "--base-version", "2", "--why", "ask", "--reason-code", "MISSING_STEP"], bare.io),
      ).toBe(0);
      bare.reset();
      expect(
        await run(["effect", "reserve", "ask-dana", "--payload-hash", "h", "--why", "send"], bare.io),
      ).toBe(1);
      expect(bare.err[0]).toContain("NO_EFFECT_BUDGET");
    } finally {
      bare.cleanup();
    }
  });

  test("a spent budget refuses, and says not to raise it", async () => {
    // With max_reattempts deleted, this cap is the ONLY thing bounding a runaway loop.
    const spent = harness();
    try {
      const config = join(spent.dir, "config.json");
      writeFileSync(config, JSON.stringify({ ...CONFIG, effect_budget: 1 }));
      expect(await run(["init", "--config", config], spent.io)).toBe(0);
      await seedRoster(spent, ["dana", "sam"]);
      const ops = spent.writeOps("ops.json", [
        ...PIVOT,
        {
          op: "add_node",
          label: "Ask Sam",
          type: "task",
          spec: {
            instruction: "Email Sam.",
            outputs: [{ name: "sent", type: "string" }],
            effect_class: "pivot",
            effect: { channel: "email", recipient_ref: "roster#sam" },
          },
        },
      ]);
      expect(
        await run(["mutate", "--ops", ops, "--base-version", "2", "--why", "ask", "--reason-code", "MISSING_STEP"], spent.io),
      ).toBe(0);

      spent.reset();
      expect(
        await run(["effect", "reserve", "ask-dana", "--payload-hash", "h", "--why", "send"], spent.io),
      ).toBe(0);

      spent.reset();
      expect(
        await run(["effect", "reserve", "ask-sam", "--payload-hash", "h", "--why", "send"], spent.io),
      ).toBe(1);
      expect(spent.err[0]).toContain("EFFECT_BUDGET_EXHAUSTED");
      expect(spent.err[0]).toContain("1 of 1");
      expect(spent.err[0]).toContain("do not raise the budget");
    } finally {
      spent.cleanup();
    }
  });

  test("an open reservation counts — crashing must not buy a free send", async () => {
    // The two crash windows leave a reservation whose outcome is genuinely unknown, so a
    // budget that only counted CONFIRMED sends would be spendable without limit by crashing.
    expect(await reserve("sha256:aaa")).toBe(0);
    const node = await nodeOf("ask-dana");
    expect(node.status.effect_log).toHaveLength(1);
    expect(node.status.effect_log[0]?.outcome).toBeNull();
  });
});
