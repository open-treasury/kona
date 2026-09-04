/**
 * The shape instrument. R1's "watch it in the eval rig" had no instrument until this existed,
 * which meant the claim the whole redesign rests on — that naming concurrency makes the model
 * express it — could not be falsified.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shapeOf } from "../analyze/shape.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "fixtures");
const read = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

describe("chain ratio", () => {
  test("counts CONTROL nodes, or a legal v2 graph always scores a perfect chain", () => {
    // The flaw this pins is not hypothetical — it was the first version of this file. S7
    // requires every action to have exactly one in-edge and one out-edge, so a linearity
    // measure over worked nodes alone is 1.00 by construction on any graph the store accepts.
    // All the branching lives in the diamonds and the bars.
    const goalie = shapeOf("goalie", read("goalie.mutations.jsonl"));
    expect(goalie.control).toBeGreaterThan(0);
    expect(goalie.chainRatio).toBeLessThan(1);
  });

  test("a graph with no branching scores higher than one with a fork and two decisions", () => {
    // The comparison, not the absolute number, is what the rig reports. An absolute threshold
    // would be a number nobody could defend; a SIGN is falsifiable.
    const goalie = shapeOf("goalie", read("goalie.mutations.jsonl"));
    const thursday = shapeOf("thursday", read("thursday.mutations.jsonl"));
    expect(thursday.chainRatio).toBeGreaterThan(goalie.chainRatio);
  });

  test("an empty log is not a chain — it is nothing", () => {
    expect(shapeOf("empty", "").chainRatio).toBe(0);
  });

  test("a torn tail is the log's business, not this report's", () => {
    const torn = `${read("goalie.mutations.jsonl").trimEnd()}\n{"v":99,"ops":[`;
    expect(shapeOf("torn", torn).worked).toBe(shapeOf("goalie", read("goalie.mutations.jsonl")).worked);
  });
});

describe("what the model expressed", () => {
  test("the activity-model fixture expresses both branching and concurrency", () => {
    const goalie = shapeOf("goalie", read("goalie.mutations.jsonl"));
    expect(goalie.expressedBranching).toBe(true);
    expect(goalie.expressedConcurrency).toBe(true);
    expect(goalie.widestFan).toBeGreaterThan(1);
  });

  test("and the pre-redesign fixture expresses neither, because it could not", () => {
    // `thursday.*` is v1-shaped: there is no fork and no decision in that vocabulary, so this
    // is the baseline the redesign is measured against rather than a criticism of the fixture.
    const thursday = shapeOf("thursday", read("thursday.mutations.jsonl"));
    expect(thursday.expressedBranching).toBe(false);
    expect(thursday.expressedConcurrency).toBe(false);
  });
});
