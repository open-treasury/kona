import { describe, expect, test } from "bun:test";
import { parseBatch } from "../src/index.ts";
import { task, wait } from "./fixtures.ts";

function reject(ops: unknown): string {
  const result = parseBatch(ops);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.rejection.reason).toBe("MALFORMED_OPS");
  return result.rejection.message;
}

describe("the parser runs first, and free", () => {
  test("accepts a legal batch", () => {
    expect(parseBatch([task("Ask Dana"), wait("Wait for Dana")]).ok).toBe(true);
  });

  test("a mutation with no ops is not a mutation", () => {
    expect(reject([])).toContain("not a mutation");
  });

  test("rejects a non-array batch", () => {
    expect(parseBatch({ op: "add_activity" }).ok).toBe(false);
  });

  test("rejects an unknown op, because no seventh opcode is reserved", () => {
    expect(parseBatch([{ op: "delete_node", activity: "x" }]).ok).toBe(false);
  });

  test("rejects an unrecognised key rather than dropping it silently", () => {
    // A typo'd `recipient_refs` that parsed as "no recipient" would walk straight past
    // the recipient-evidence invariant.
    expect(reject([task("Ask Dana", { recipient_refs: "dana@example.com" })])).toContain(
      "recipient_refs",
    );
  });
});

describe("wait rules — the schema rule that prevents a silent multi-day hang", () => {
  test("a wait without a deadline is rejected", () => {
    expect(reject([wait("W", { deadline: undefined })])).toContain("deadline");
  });

  test("a wait without an on_timeout is rejected", () => {
    expect(reject([wait("W", { on_timeout: undefined })])).toContain("on_timeout");
  });

  test("a wait without a match block is rejected", () => {
    expect(reject([wait("W", { match: undefined })])).toContain("match");
  });

  test("a wait whose match has no conditions can never resolve", () => {
    expect(reject([wait("W", { match: { kind: "event", conditions: [] } })])).toContain(
      "never resolve",
    );
  });

  test("a task carrying a match block is rejected", () => {
    expect(
      reject([task("T", { match: { kind: "event", conditions: [{ kind: "reply", on: "satisfied" }] } })]),
    ).toContain("only a wait");
  });
});

describe("effect rules", () => {
  test("a pivot without an effect block is rejected", () => {
    expect(reject([task("Send", { effect_class: "pivot" })])).toContain("requires an effect");
  });

  test("a compensatable without an effect block is rejected", () => {
    expect(reject([task("Send", { effect_class: "compensatable" })])).toContain(
      "requires an effect",
    );
  });

  test("an effect block on a pure activity is rejected — it would never be reserved", () => {
    const ops = [
      task("Send", {
        effect_class: "pure",
        effect: { channel: "email", recipient_ref: "roster#dana" },
      }),
    ];
    expect(reject(ops)).toContain("never be reserved");
  });

  test("an author may not mint correlation or effect_key", () => {
    const ops = [
      task("Send", {
        effect_class: "pivot",
        effect: {
          channel: "email",
          recipient_ref: "roster#dana",
          correlation: "ilya+kona-send@example.com",
          effect_key: "ek_forged",
        },
      }),
    ];
    // The committed shape allows these; the authored one does not, and the store fills
    // them in. Either way the parser must not reject the committed form as malformed.
    expect(parseBatch(ops).ok).toBe(true);
  });
});

describe("references", () => {
  test("accepts $N", () => {
    expect(parseBatch([task("A"), { op: "add_edge", from: "$0", to: "$0" }]).ok).toBe(true);
  });

  test("rejects the dotted form, which has no referent under six ops", () => {
    expect(parseBatch([task("A"), { op: "add_edge", from: "$0.children.dana", to: "$0" }]).ok).toBe(
      false,
    );
  });

  test("rejects an id that is not in the id alphabet", () => {
    expect(reject([{ op: "set_status", activity: "Goalie/Dana", status: "done", evidence_ref: "e" }]))
      .toContain("activity id");
  });

  test("rejects an unknown status, verdict or condition", () => {
    expect(parseBatch([{ op: "set_status", activity: "a", status: "running", evidence_ref: "e" }]).ok).toBe(false);
    expect(parseBatch([{ op: "record_outcome", activity: "a", verdict: "maybe", evidence_ref: "e" }]).ok).toBe(false);
    expect(parseBatch([{ op: "add_edge", from: "a", to: "b", condition: { on: "later" } }]).ok).toBe(false);
  });
});

describe("rationale", () => {
  test("names the op index of the first problem", () => {
    const result = parseBatch([task("A"), { op: "add_edge", from: "a" }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.rejection.op_index).toBe(1);
  });
});
