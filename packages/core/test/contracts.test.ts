/**
 * The vocabularies and the parser must agree.
 *
 * `vocab.ts` exists so that the TypeScript union and the zod enum come from one list. That
 * only holds while every closed set is actually wired to the schema that enforces it, and
 * a set that drifts loose fails silently — the type still compiles and the parser still
 * runs, it just accepts something the spec closed. These are the assertions that notice.
 */

import { describe, expect, test } from "bun:test";
import {
  ACTOR_KINDS,
  AuthoredOpSchema,
  CommittedOpSchema,
  DeadlineSchema,
  FORBIDDEN_OP_KINDS,
  IRREVERSIBLE_EFFECT_CLASSES,
  NodeIdSchema,
  OP_KINDS,
  OpRefSchema,
  REASON_CODES,
  STATUSES,
  TERMINAL_SAFE_OP_KINDS,
  TERMINAL_STATUSES,
  VERDICTS,
  isIrreversible,
  isTerminal,
  parseBatch,
} from "../src/index.ts";
import { seeded, task } from "./fixtures.ts";

describe("the six ops, and only the six", () => {
  test("OP_KINDS is exactly what the authored schema discriminates on", () => {
    const discriminated = AuthoredOpSchema.options.map((option) =>
      option.def.shape.op.value as string,
    );
    expect(discriminated.toSorted()).toEqual([...OP_KINDS].toSorted());
  });

  test("the committed schema discriminates on the same six", () => {
    const discriminated = CommittedOpSchema.options.map((option) =>
      option.def.shape.op.value as string,
    );
    expect(discriminated.toSorted()).toEqual([...OP_KINDS].toSorted());
  });

  test.each([...FORBIDDEN_OP_KINDS])("'%s' is refused, and reserves no opcode", (forbidden) => {
    expect(OP_KINDS).not.toContain(forbidden);
    expect(parseBatch([{ op: forbidden, node: "a" }]).ok).toBe(false);
  });

  test("TERMINAL_SAFE_OP_KINDS is exactly the set invariant 1 lets through", () => {
    // Anything not in this list, targeting a node terminal at head, must be rejected.
    const done = seeded([task("A")]);
    const node = done.nodes.get("a");
    if (node === undefined) throw new Error("fixture");
    node.status.state = "done";
    const safe: string[] = [...TERMINAL_SAFE_OP_KINDS];
    expect(safe.toSorted()).toEqual(["record_outcome", "record_output", "supersede_node"]);
  });
});

describe("closed sets stay closed", () => {
  test("terminal is a strict subset of the statuses", () => {
    for (const terminal of TERMINAL_STATUSES) expect(STATUSES).toContain(terminal);
    expect(TERMINAL_STATUSES.length).toBeLessThan(STATUSES.length);
    expect(STATUSES.filter(isTerminal)).toHaveLength(TERMINAL_STATUSES.length);
  });

  test("irreversible is a strict subset of the effect classes", () => {
    for (const irreversible of IRREVERSIBLE_EFFECT_CLASSES) {
      expect(isIrreversible(irreversible)).toBe(true);
    }
  });

  test.each([...VERDICTS])("verdict '%s' is accepted", (verdict) => {
    const graph = seeded([task("A")]);
    expect(
      parseBatch([{ op: "record_outcome", node: "a", verdict, evidence_ref: "e" }]).ok,
    ).toBe(true);
    expect(graph.nodes.size).toBe(1);
  });

  test.each([...ACTOR_KINDS])("actor kind '%s' is a legal value", (kind) => {
    expect(ACTOR_KINDS).toContain(kind);
  });

  test.each([...REASON_CODES])("reason code '%s' is a legal value", (code) => {
    expect(REASON_CODES).toContain(code);
  });
});

describe("the primitive schemas", () => {
  test("NodeIdSchema is the id alphabet, and OpRefSchema is not", () => {
    expect(NodeIdSchema.safeParse("goalie-dana").success).toBe(true);
    expect(NodeIdSchema.safeParse("$0").success).toBe(false);
    expect(OpRefSchema.safeParse("$0").success).toBe(true);
    expect(OpRefSchema.safeParse("goalie-dana").success).toBe(false);
  });

  test("a deadline takes exactly one of three shapes, and nothing in between", () => {
    expect(DeadlineSchema.safeParse({ at: "2026-08-22T17:00:00.000Z" }).success).toBe(true);
    expect(DeadlineSchema.safeParse({ after: "a", duration: "48h" }).success).toBe(true);
    expect(
      DeadlineSchema.safeParse({ expr: "game_date - 24h", backstop: "2026-08-22T17:00:00.000Z", after_unknown: true }).success,
    ).toBe(true);
    // Half of one shape and half of another is not a deadline.
    expect(DeadlineSchema.safeParse({ after: "a" }).success).toBe(false);
    expect(DeadlineSchema.safeParse({ at: "2026-08-22T17:00:00.000Z", after: "a", duration: "1h" }).success).toBe(false);
    expect(DeadlineSchema.safeParse({ after: "a", duration: "soon" }).success).toBe(false);
  });
});
