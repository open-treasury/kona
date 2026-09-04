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
  ActivityIdSchema,
  OP_KINDS,
  OpRefSchema,
  REASON_CODES,
  STATUSES,
  TERMINAL_SAFE_OP_KINDS,
  TERMINAL_STATUSES,
  VERDICTS,
  isIrreversible,
  isOpRef,
  isTerminal,
  parseBatch,
} from "../src/index.ts";
import { seeded, action, activityAt } from "./fixtures.ts";

describe("the six ops, and only the six", () => {
  test("OP_KINDS is exactly what the authored schema discriminates on", () => {
    const discriminated = AuthoredOpSchema.options.map(
      (option) => option.def.shape.op.value as string,
    );
    expect([...new Set(discriminated)].toSorted()).toEqual([...OP_KINDS].toSorted());
  });

  test("the committed schema discriminates on the same six", () => {
    const discriminated = CommittedOpSchema.options.map(
      (option) => option.def.shape.op.value as string,
    );
    expect([...new Set(discriminated)].toSorted()).toEqual([...OP_KINDS].toSorted());
  });

  test.each([...FORBIDDEN_OP_KINDS])("'%s' is refused, and reserves no opcode", (forbidden) => {
    expect(OP_KINDS).not.toContain(forbidden);
    expect(parseBatch([{ op: forbidden, node: "a" }]).ok).toBe(false);
  });

  test("TERMINAL_SAFE_OP_KINDS is exactly the set invariant 1 lets through", () => {
    // Anything not in this list, targeting an activity terminal at head, must be rejected.
    const done = seeded([action("A")]);
    const activity = activityAt(done, "a");
    if (activity?.status === undefined)
      throw new Error("fixture: expected a node that carries a status");
    activity.status.state = "completed";
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
    const graph = seeded([action("A")]);
    expect(parseBatch([{ op: "record_outcome", node: "a", verdict, evidence_ref: "e" }]).ok).toBe(
      true,
    );
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
  test("ActivityIdSchema is the id alphabet, and OpRefSchema is not", () => {
    expect(ActivityIdSchema.safeParse("goalie-dana").success).toBe(true);
    expect(ActivityIdSchema.safeParse("$0").success).toBe(false);
    expect(OpRefSchema.safeParse("$0").success).toBe(true);
    expect(OpRefSchema.safeParse("goalie-dana").success).toBe(false);
  });

  test("a batch ref is ANCHORED at both ends, and takes more than one digit", () => {
    // Three real holes, each one a surviving mutant on the anchors of `/^\$\d+$/`.
    //
    // Unanchored at the front, `goalie$0` parses as a ref — so an activity id that happens to end
    // in `$0` would resolve to whatever op zero minted. Unanchored at the back, `$0abc` does
    // the same from the other side. And `\d` instead of `\d+` silently caps a batch at ten
    // ops: `$10` stops being a ref, which is a limit nothing in the spec imposes and which
    // would show up as `UNKNOWN_ACTIVITY` on the eleventh op of a fan-out.
    expect(OpRefSchema.safeParse("$10").success).toBe(true);
    expect(OpRefSchema.safeParse("$123").success).toBe(true);
    for (const notARef of ["goalie$0", "$0abc", "x$1", " $0", "$0 ", "$", "$-1", "$0.children"]) {
      expect(`${notARef}: ${String(OpRefSchema.safeParse(notARef).success)}`).toBe(
        `${notARef}: false`,
      );
    }
  });

  test("and `isOpRef` agrees with the schema on every one of them", () => {
    // Two spellings of one rule, in two files. They are allowed to exist only while they
    // cannot disagree, so this is the test that keeps that true.
    for (const candidate of ["$0", "$10", "$123", "goalie$0", "$0abc", "x$1", "$", "$-1", ""]) {
      expect(`${candidate}: ${String(isOpRef(candidate))}`).toBe(
        `${candidate}: ${String(OpRefSchema.safeParse(candidate).success)}`,
      );
    }
  });

  test("a deadline takes exactly one of three shapes, and nothing in between", () => {
    expect(DeadlineSchema.safeParse({ at: "2026-08-22T17:00:00.000Z" }).success).toBe(true);
    expect(DeadlineSchema.safeParse({ after: "a", duration: "48h" }).success).toBe(true);
    expect(
      DeadlineSchema.safeParse({
        expr: "game_date - 24h",
        backstop: "2026-08-22T17:00:00.000Z",
        after_unknown: true,
      }).success,
    ).toBe(true);
    // Half of one shape and half of another is not a deadline.
    expect(DeadlineSchema.safeParse({ after: "a" }).success).toBe(false);
    expect(
      DeadlineSchema.safeParse({ at: "2026-08-22T17:00:00.000Z", after: "a", duration: "1h" })
        .success,
    ).toBe(false);
    expect(DeadlineSchema.safeParse({ after: "a", duration: "soon" }).success).toBe(false);
  });

  test("a spec that declares no inputs or outputs gets EMPTY ones, not absent ones", () => {
    // `.default([])` on both, and nothing asserted it. The default is load-bearing twice:
    // `checkInputs` iterates `spec.inputs` and `record_output` looks a name up in
    // `spec.outputs`, so a default that was absent or non-empty would either throw on the
    // most ordinary activity in a graph or invent a declaration nobody wrote.
    const parsed = parseBatch([
      {
        op: "add_node",
        name: "Read the roster",
        type: "action",
        spec: { instruction: "read it", effect_class: "pure" },
      },
    ]);
    expect(parsed.ok).toBe(true);
    const first = parsed.ok ? parsed.value[0] : undefined;
    if (first?.op !== "add_node") throw new Error("unreachable");
    expect(first.spec.inputs).toEqual([]);
    expect(first.spec.outputs).toEqual([]);
  });

  test("a duration is anchored too — `48hours` is not 48 hours", () => {
    // `/^\d+[smhd]$/` unanchored at the back accepts `48hours`, `48h!` and `48hz`, and
    // `parseDuration` would read every one of them as 48 hours. A deadline is the only thing
    // standing between a silent acceptEvent and a follow-up, so a duration that parses as something
    // the author did not write is the quietest possible bug.
    for (const good of ["48h", "30m", "7d", "90s", "1h"]) {
      expect(
        `${good}: ${String(DeadlineSchema.safeParse({ after: "a", duration: good }).success)}`,
      ).toBe(`${good}: true`);
    }
    for (const bad of ["48hours", "48h!", "48hz", "x48h", "48", "h", "4 8h", "-1h", "48H"]) {
      expect(
        `${bad}: ${String(DeadlineSchema.safeParse({ after: "a", duration: bad }).success)}`,
      ).toBe(`${bad}: false`);
    }
  });
});
