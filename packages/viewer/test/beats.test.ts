/**
 * `V` names the fixture's beats; this is what keeps the names true.
 *
 * Every other viewer test indexes the fixture by beat rather than by number, which makes a
 * regeneration cheap — but only if something checks that `V.samRefers` is still the version
 * where Sam refers. Without this, a regen that reordered the story would leave thirty tests
 * quietly asserting the wrong things about the right-looking versions.
 *
 * So each name is pinned to the OPS the record actually carries, not to its index. The index
 * is free to move; what it points at is not.
 */

import { describe, expect, test } from "bun:test";
import { V, folded, headVersion, idOfName } from "./fixture.ts";

/**
 * The ops at one version, as `<op>:<activity-or-label>` — enough to identify a beat.
 *
 * Off the FOLDED records rather than off raw JSON, so a fixture that stopped parsing would
 * fail here too rather than being described by a hand-rolled reader that still worked.
 */
function opsAt(version: number): string[] {
  const record = folded().records.find((candidate) => candidate.v === version);
  if (record === undefined) throw new Error(`the fixture has no v${version}`);
  return record.ops.map((op) => {
    const target = "activity" in op ? op.activity : "name" in op ? op.name : "";
    return `${op.op}:${target}`;
  });
}

describe("the fixture's beats are where V says they are", () => {
  test("the genesis record carries the identity and no ops", () => {
    expect(opsAt(V.genesis)).toEqual([]);
  });

  test("the roster is read one version before anyone on it is asked", () => {
    expect(opsAt(V.roster)).toContain("record_output:th-ahf6");
    // The whole reason it is its own commit: invariant 3(b) resolves recipients against
    // PRE-COMMIT head, so a batch that reads the roster and emails Dana is refused.
    expect(opsAt(V.plan)).toContain("add_activity:Ask Dana to play in goal");
    expect(V.roster).toBeLessThan(V.plan);
  });

  test("every send is a reserve and then a record, in that order and never merged", () => {
    for (const [who, reserved, sent] of [
      ["dana", V.danaReserved, V.danaSent],
      ["sam", V.samReserved, V.samSent],
    ] as const) {
      // Ids are hashes, so the activity cannot be spelled from `who`. The label still can be,
      // and the label is what this test is actually about — that each send touches the activity
      // for that person, twice, in order.
      const activity = idOfName(`Ask ${who.charAt(0).toUpperCase()}${who.slice(1)} to play in goal`);
      expect(`${who}:${opsAt(reserved).join()}`).toBe(`${who}:set_status:${activity}`);
      expect(`${who}:${opsAt(sent).join()}`).toBe(`${who}:set_status:${activity}`);
      expect(sent).toBe(reserved + 1);
    }
  });

  test("Priya's slot is opened four versions before it is closed — crash window 2", () => {
    expect(opsAt(V.priyaReserved)).toEqual(["set_status:th-t2yo"]);
    expect(opsAt(V.priyaFailed)).toEqual(["set_status:th-t2yo"]);
    expect(V.priyaFailed - V.priyaReserved).toBe(4);
  });

  test("the three plan changes are where their names say", () => {
    expect(opsAt(V.danaDeclines)).toContain("record_outcome:th-es9m");
    expect(opsAt(V.samRefers)).toContain("add_activity:Check Marcus is eligible");
    expect(opsAt(V.rosterSuperseded)).toContain("supersede_activity:th-ahf6");
    expect(opsAt(V.patPlanned)).toContain("add_activity:Ask Pat to play in goal");
  });

  test("the fixture ends on Pat's OPEN reservation, and that is the head", () => {
    expect(opsAt(V.patReserved)).toEqual(["set_status:th-gk0l"]);
    expect(V.patReserved).toBe(headVersion());
  });

  test("the names are contiguous and cover the whole log", () => {
    // A beat that fell off the list would leave a version nothing in these tests looks at.
    expect([...new Set(Object.values(V))].toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: headVersion() + 1 }, (_, index) => index),
    );
  });
});
