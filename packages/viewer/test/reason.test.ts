/**
 * The reason code, put into words — and the two directions that can go wrong.
 *
 * Forwards: every code the store can actually write has a gloss. That assertion imports
 * `REASON_CODES` from `@kona/core` on purpose, so adding a ninth code upstream fails HERE with
 * a message naming it, rather than shipping a tag whose tooltip says nothing.
 *
 * Backwards: a code this build has never heard of still renders. Those two are not in tension —
 * the runtime is additive (D5) and the test is the reminder.
 */

import { describe, expect, test } from "bun:test";
import { REASON_CODES } from "@kona/core";
import { reasonGloss, reasonLabel } from "../src/model/reason.ts";

describe("reasonLabel", () => {
  test("the underscore is what makes it read as a constant", () => {
    expect(reasonLabel("MISSING_STEP")).toBe("missing step");
    expect(reasonLabel("COUNTERPARTY_DECLINED")).toBe("counterparty declined");
  });

  test("a single word is left alone", () => {
    expect(reasonLabel("WITHDRAWN")).toBe("withdrawn");
  });

  test("a code from a newer store still becomes words", () => {
    // D5: render additively. This is what a code added upstream looks like on the day it lands.
    expect(reasonLabel("BUDGET_EXCEEDED")).toBe("budget exceeded");
  });

  test("never returns an empty tag, whatever it is handed", () => {
    for (const code of [...REASON_CODES, "SOMETHING_NEW", "X"])
      expect(reasonLabel(code).length).toBeGreaterThan(0);
  });
});

describe("reasonGloss", () => {
  test("every code the schema permits has one", () => {
    const missing = REASON_CODES.filter((code) => reasonGloss(code) === null);
    // Named rather than counted: the failure should say which code needs a sentence written.
    expect(missing).toEqual([]);
  });

  test("the gloss explains the CATEGORY, so it never repeats the row's own sentence", () => {
    // `why` is per-commit and written by a human; this is per-code and written once. If a gloss
    // ever quoted a fixture's `why`, that would be the tell that it had drifted into narration.
    for (const code of REASON_CODES) {
      const gloss = reasonGloss(code);
      expect(gloss).not.toBeNull();
      expect(gloss?.length ?? 0).toBeGreaterThan(10);
    }
  });

  test("an unknown code admits it rather than guessing", () => {
    expect(reasonGloss("BUDGET_EXCEEDED")).toBeNull();
  });
});
