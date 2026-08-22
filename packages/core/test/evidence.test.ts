/**
 * `evidencedKeys` — invariant 3(b)'s resolution half, tested directly.
 *
 * It had no test of its own. Everything it did was reached through `validate()`'s happy path
 * with one shape of output — a flat array of names — and mutation testing said so in the
 * bluntest way available: **thirteen survivors in fifty lines**, the worst score in the
 * codebase, guarding the highest-stakes decision in it.
 *
 * That decision is whether a counterparty may be contacted at all. At n=60 a mutator unable
 * to satisfy a constraint invented plausible people with plausible addresses and queued real
 * email to them, roughly twenty times, passing every other check. This function is what
 * stands in front of that, so a surviving mutant here is not a coverage statistic.
 */

import { describe, expect, test } from "bun:test";
import type { AuthoredOp, Graph } from "../src/index.ts";
import { evidencedKeys, isEvidencedRecipient } from "../src/index.ts";
import { commit, seeded, task, wait } from "./fixtures.ts";

/** A graph whose one node has recorded `value` as its declared output. */
function output(value: unknown): Graph {
  return commit(seeded([task("A")]), [
    { op: "record_output", node: "a", output_name: "reply", value, evidence_ref: "src#1" },
  ] as AuthoredOp[]);
}

/** A graph whose one wait carries an outcome with these attrs. */
function outcomeAttrs(attrs: Record<string, unknown> | undefined): Graph {
  const ops: AuthoredOp[] = [
    {
      op: "record_outcome",
      node: "w",
      verdict: "declined",
      evidence_ref: "<m-1@mail>",
      ...(attrs === undefined ? {} : { attrs }),
    },
  ] as AuthoredOp[];
  return commit(seeded([task("Escalate"), wait("W")]), ops);
}

describe("what counts as evidence", () => {
  test("a recorded output's strings, lowercased", () => {
    expect(evidencedKeys(output(["Dana", "SAM"]))).toEqual(new Set(["dana", "sam"]));
  });

  test("an outcome's attrs — the half that makes a referral chain work", () => {
    // Sam declines and names Marcus, in a message with an id. Marcus becomes contactable
    // because SAM said so, not because the model thought of him.
    expect(evidencedKeys(outcomeAttrs({ role: "goalie", referral: "Marcus" }))).toEqual(
      new Set(["goalie", "marcus"]),
    );
  });

  test("VALUES vouch for people; field names do not", () => {
    // `{referral: "marcus"}` evidences Marcus, not "referral". Harvesting keys would make
    // `roster.contacts#referral` resolve, and every recipient_ref naming a field name would
    // pass — which is the fabrication this exists to stop, wearing a schema's clothes.
    expect(evidencedKeys(output({ goalie: "dana" }))).toEqual(new Set(["dana"]));
    expect(evidencedKeys(output({ dana: "goalie" }))).toEqual(new Set(["goalie"]));
  });

  test("an outcome with no attrs at all harvests nothing, and does not throw", () => {
    // `attrs` is `undefined` here, and `Object.values(undefined)` throws — so the guard that
    // catches it is load-bearing on the most ordinary record in the log.
    expect(evidencedKeys(outcomeAttrs(undefined))).toEqual(new Set());
  });

  test("a node that has recorded nothing contributes nothing", () => {
    expect(evidencedKeys(seeded([task("A")]))).toEqual(new Set());
  });
});

describe("the shape of an output is not something this may care about", () => {
  /**
   * The v2 probe measured an invariant rejecting correct work five times in ten by being
   * strict about a shape the spec never fixed. `outputs[].value` is `unknown`, so a roster
   * is as likely to be `["dana"]` as `[{name: "dana"}]`, and both have to work.
   */
  test.each([
    ["a bare string", "dana", ["dana"]],
    ["an array", ["dana", "sam"], ["dana", "sam"]],
    ["an object", { goalie: "dana" }, ["dana"]],
    ["objects in an array", [{ name: "dana" }, { name: "sam" }], ["dana", "sam"]],
    ["nested three deep", { roster: { goalies: ["dana"] } }, ["dana"]],
  ])("%s", (_label, value, expected) => {
    expect(evidencedKeys(output(value))).toEqual(new Set(expected));
  });

  test("an empty string is NOT evidence — it would match an empty recipient key", () => {
    expect(evidencedKeys(output(["", "dana"]))).toEqual(new Set(["dana"]));
    expect(evidencedKeys(output(""))).toEqual(new Set());
  });

  test("a null inside an output is skipped rather than thrown on", () => {
    // `Object.values(null)` is a TypeError, and this runs on EVERY commit that carries a
    // `recipient_ref` — so a null in a recorded output would crash the validation path.
    expect(evidencedKeys(output({ goalie: null, backup: "dana" }))).toEqual(new Set(["dana"]));
    expect(evidencedKeys(output(null))).toEqual(new Set());
    expect(evidencedKeys(output([null, "dana"]))).toEqual(new Set(["dana"]));
  });

  test("numbers and booleans vouch for nobody, and are not an error either", () => {
    expect(evidencedKeys(output({ count: 3, ok: true, who: "dana" }))).toEqual(new Set(["dana"]));
    expect(evidencedKeys(output(3))).toEqual(new Set());
  });
});

describe("the guarantee this function relies on instead of re-checking", () => {
  test("a recorded output always carries its evidence — the key sets never disagree", () => {
    // `evidencedKeys` counts every recorded output as evidence, WITHOUT re-testing that its
    // source was cited, because `record_output` cannot be committed without an
    // `evidence_ref` and writes both maps in one statement. This is that guarantee, pinned
    // where it is true. If the schema ever relaxes, this fails — and `evidence.ts` says to
    // come back and add the check it deliberately does not have.
    const graph = commit(
      commit(seeded([task("A", { outputs: [{ name: "reply", type: "string" }, { name: "note", type: "string" }] })]), [
        { op: "record_output", node: "a", output_name: "reply", value: "dana", evidence_ref: "src#1" },
      ] as AuthoredOp[]),
      [
        { op: "record_output", node: "a", output_name: "note", value: "sam", evidence_ref: "src#2" },
      ] as AuthoredOp[],
    );
    for (const node of graph.nodes.values()) {
      const { output: recorded, output_evidence: evidence } = node.status;
      expect(Object.keys(recorded ?? {}).toSorted()).toEqual(Object.keys(evidence ?? {}).toSorted());
    }
    expect(graph.nodes.get("a")?.status.output_evidence).toEqual({ reply: "src#1", note: "src#2" });
  });
});

describe("isEvidencedRecipient matches the PERSON, not the filing", () => {
  const evidenced = new Set(["dana", "marcus"]);

  test("the scope is an author's choice and is ignored", () => {
    // `roster.contacts#dana` and `players#dana` name one person. Refusing on the scope would
    // reject a correct recipient for being filed differently, which is the v2 failure again.
    for (const scope of ["roster.contacts", "players", "x"]) {
      expect(isEvidencedRecipient({ scope, key: "dana" }, evidenced)).toBe(true);
    }
  });

  test("the key is matched case-insensitively", () => {
    expect(isEvidencedRecipient({ scope: "roster", key: "DANA" }, evidenced)).toBe(true);
    expect(isEvidencedRecipient({ scope: "roster", key: "Marcus" }, evidenced)).toBe(true);
  });

  test("somebody nobody named is refused", () => {
    expect(isEvidencedRecipient({ scope: "roster", key: "nobody" }, evidenced)).toBe(false);
    // Not a prefix or substring match either: `dan` is not `dana`, and a rule that let it
    // through would let a near-miss invented name resolve to a real one.
    expect(isEvidencedRecipient({ scope: "roster", key: "dan" }, evidenced)).toBe(false);
    expect(isEvidencedRecipient({ scope: "roster", key: "" }, evidenced)).toBe(false);
  });
});
