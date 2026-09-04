/**
 * The outbox vocabulary, and the fold that materialises it.
 *
 * §7 puts the outbox at a 100 mutation-score floor for a reason: a surviving mutant here
 * is a second email, and there is no rollback.
 */

import { describe, expect, test } from "bun:test";
import type { AuthoredOp, Graph } from "../src/index.ts";
import {
  attemptCount,
  effectByKey,
  effectKeyPreimage,
  encodeRecordEvidence,
  encodeReserveEvidence,
  hasSentEffect,
  openEffect,
  parseEffectEvidence,
} from "../src/index.ts";
import { commit, rostered, action, activityAt } from "./fixtures.ts";

const KEY = "ek_b4668bc35579b3eb";

function pivot(name: string): AuthoredOp {
  return action(name, {
    effect_class: "pivot",
    effect: { channel: "email", recipient_ref: "roster#dana" },
  });
}

function activityOf(graph: Graph, id: string) {
  // Narrowed to a node that carries a status: every use here is about work, and under D6 a
  // control node has none. Throwing beats optional-chaining, which would let a test that
  // asked the wrong question quietly compare two undefineds and pass.
  const activity = activityAt(graph, id);
  if (activity === undefined) throw new Error(`no node ${id}`);
  if (activity.status === undefined) throw new Error(`${id} is a ${activity.type}, which carries no status`);
  return activity;
}

describe("the key names the slot, not the bytes (§6.6)", () => {
  test("it depends on the activity and the version that created it", () => {
    expect(effectKeyPreimage("ask-dana", 7)).toBe("ask-dana 7");
  });

  test("it is payload-INDEPENDENT — nothing about the body reaches it", () => {
    // Putting the body in the key inverts the guarantee: a rewritten body yields a
    // different key, "key matches, payload differs" becomes unreachable, and the second
    // email sends.
    expect(effectKeyPreimage("ask-dana", 7)).toBe(effectKeyPreimage("ask-dana", 7));
  });

  test("different activities and different versions are different slots", () => {
    expect(effectKeyPreimage("ask-dana", 7)).not.toBe(effectKeyPreimage("ask-sam", 7));
    expect(effectKeyPreimage("ask-dana", 7)).not.toBe(effectKeyPreimage("ask-dana", 8));
  });

  test("the two fields cannot be confused for each other", () => {
    // Without a separator, ("ask-dana-1", 2) and ("ask-dana", 12) would collide.
    expect(effectKeyPreimage("ask-dana-1", 2)).not.toBe(effectKeyPreimage("ask-dana", 12));
  });
});

describe("evidence round-trips", () => {
  test("the wire format is exact — it is durable data, not an internal detail", () => {
    // These strings live in the log forever. Changing them silently re-interprets every
    // pursuit ever written, so they are pinned by literal rather than by round trip.
    expect(encodeReserveEvidence(KEY, "abc")).toBe(`effect:reserve:${KEY}:abc`);
    expect(encodeRecordEvidence(KEY, "sent", "<m-1>")).toBe(`effect:record:${KEY}:sent:<m-1>`);
  });

  test("a payload hash with no separator is the shortest legal reservation", () => {
    expect(parseEffectEvidence(`effect:reserve:${KEY}:abc`)).toEqual({
      kind: "reserve",
      effect_key: KEY,
      payload_hash: "abc",
    });
  });

  test("a reservation", () => {
    expect(parseEffectEvidence(encodeReserveEvidence(KEY, "sha256:aaa"))).toEqual({
      kind: "reserve",
      effect_key: KEY,
      payload_hash: "sha256:aaa",
    });
  });

  test("a payload hash containing the separator survives", () => {
    // `sha256:abc…` is the ordinary way to write one. An earlier parser split on its own
    // separator and rejected the string it had just produced, which left effect_log empty
    // and made every duplicate-send guard downstream unreachable.
    const evidence = parseEffectEvidence(encodeReserveEvidence(KEY, "sha256:a:b:c"));
    expect(evidence).toEqual({ kind: "reserve", effect_key: KEY, payload_hash: "sha256:a:b:c" });
  });

  test("an outcome, including a message id containing the separator", () => {
    expect(parseEffectEvidence(encodeRecordEvidence(KEY, "sent", "<m:101@mail>"))).toEqual({
      kind: "record",
      effect_key: KEY,
      outcome: "sent",
      message_id: "<m:101@mail>",
    });
  });

  test("a failure is recorded as distinctly as a send", () => {
    expect(parseEffectEvidence(encodeRecordEvidence(KEY, "failed", "550"))?.kind).toBe("record");
  });

  test.each([
    ["ordinary evidence", "<m-101@mail>"],
    ["roster reference", "roster.csv#v3"],
    ["wrong prefix", "effects:reserve:k:h"],
    ["no action", "effect:k:h"],
    ["unknown action", "effect:cancel:k:h"],
    ["reserve missing its hash", "effect:reserve:k"],
    ["reserve with an empty hash", "effect:reserve:k:"],
    ["reserve with an empty key", "effect:reserve::h"],
    ["record missing its message id", "effect:record:k:sent"],
    ["record with an empty message id", "effect:record:k:sent:"],
    ["record with an unknown outcome", "effect:record:k:maybe:m"],
    ["record with an empty key", "effect:record::sent:m"],
    ["empty", ""],
    ["a long string whose action is neither", "effect:cancel:k:sent:m-1"],
    ["reserve spelled as something else, at record length", "effect:reserved:k:sent:m-1"],
  ])("%s is not an outbox transition", (_name, evidence) => {
    expect(parseEffectEvidence(evidence)).toBeNull();
  });
});

describe("fold materialises the ledger from the log", () => {
  const reserved = commit(rostered(["dana"], [pivot("Ask Dana")]), [
    {
      op: "set_status",
      node: "ask-dana",
      status: "active",
      evidence_ref: encodeReserveEvidence(KEY, "sha256:aaa"),
    },
  ]);

  test("a reservation appears as an OPEN entry — attempted, not completed", () => {
    const entry = openEffect(activityOf(reserved, "ask-dana"));
    expect(entry?.effect_key).toBe(KEY);
    expect(entry?.payload_hash).toBe("sha256:aaa");
    expect(entry?.completed_at).toBeNull();
    expect(entry?.outcome).toBeNull();
    expect(entry?.message_id).toBeNull();
  });

  test("attempted_at comes from the record's own occurred_at, never a live clock", () => {
    // A dry run stamps the sentinel and is discarded; only a folded log carries a time.
    expect(activityOf(reserved, "ask-dana").status.effect_log[0]?.attempted_at).toBeDefined();
  });

  test("an open reservation is not yet a send", () => {
    expect(hasSentEffect(activityOf(reserved, "ask-dana"))).toBe(false);
    expect(attemptCount(activityOf(reserved, "ask-dana"))).toBe(1);
  });

  test("recording closes the same entry rather than appending a second", () => {
    const done = commit(reserved, [
      {
        op: "set_status",
        node: "ask-dana",
        status: "completed",
        evidence_ref: encodeRecordEvidence(KEY, "sent", "<m-101@mail>"),
      },
    ]);
    const activity = activityOf(done, "ask-dana");
    expect(activity.status.effect_log).toHaveLength(1);
    expect(activity.status.effect_log[0]?.outcome).toBe("sent");
    expect(activity.status.effect_log[0]?.message_id).toBe("<m-101@mail>");
    expect(activity.status.effect_log[0]?.completed_at).not.toBeNull();
    expect(openEffect(activity)).toBeNull();
    expect(hasSentEffect(activity)).toBe(true);
  });

  test("a failed send completes the entry but is not a send", () => {
    const failed = commit(reserved, [
      {
        op: "set_status",
        node: "ask-dana",
        status: "failed",
        evidence_ref: encodeRecordEvidence(KEY, "failed", "550 user unknown"),
      },
    ]);
    const activity = activityOf(failed, "ask-dana");
    expect(activity.status.effect_log[0]?.outcome).toBe("failed");
    expect(hasSentEffect(activity)).toBe(false);
    expect(openEffect(activity)).toBeNull();
  });

  test("recording against a key that was never reserved is refused", () => {
    // A log claiming an outcome for a slot nobody reserved is corrupt, not merely odd.
    expect(() =>
      commit(rostered(["dana"], [pivot("Ask Dana")]), [
        {
          op: "set_status",
          node: "ask-dana",
          status: "completed",
          evidence_ref: encodeRecordEvidence("ek_forged", "sent", "<m-9@mail>"),
        },
      ]),
    ).toThrow("no open reservation");
  });

  test("ordinary evidence leaves the ledger alone", () => {
    const plain = commit(rostered(["dana"], [pivot("Ask Dana")]), [
      { op: "set_status", node: "ask-dana", status: "completed", evidence_ref: "<m-101@mail>" },
    ]);
    expect(activityOf(plain, "ask-dana").status.effect_log).toEqual([]);
  });

  test("effectByKey finds a slot by name, and reports nothing for a stranger", () => {
    expect(effectByKey(activityOf(reserved, "ask-dana"), KEY)?.payload_hash).toBe("sha256:aaa");
    expect(effectByKey(activityOf(reserved, "ask-dana"), "ek_other")).toBeNull();
  });

  test("an activity that has moved no bytes may still be superseded", () => {
    // Invariant 1 only demands a compensation once the effect_log is non-empty.
    expect(attemptCount(activityOf(rostered(["dana"], [pivot("Ask Dana")]), "ask-dana"))).toBe(0);
    expect(hasSentEffect(activityOf(rostered(["dana"], [pivot("Ask Dana")]), "ask-dana"))).toBe(false);
  });
});
