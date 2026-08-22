/**
 * The README's "Try it" block, run.
 *
 * It was broken. The example authored a node addressed to `roster.contacts#dana` as its very
 * first commit, and invariant 3(b) refuses a recipient the graph has never heard of — so the
 * first thing a visitor does was the one thing the store will not do. Nothing caught it,
 * because a code fence is not code.
 *
 * `plugin-catalogue.test.ts` solved the same problem for the skill files: extract the JSON and
 * run it through the real parser. This does the same for the front door, and one step further
 * — the ops are not merely parsed, they are COMMITTED, in the documented order, with the
 * documented `--base-version`s, and the outcomes the README claims are asserted.
 *
 * So the README cannot drift into being wrong in the two ways that matter: an example the
 * store refuses, and an example that no longer produces what the surrounding prose says.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { harness, type Harness } from "./harness.ts";

const README = readFileSync(join(import.meta.dir, "..", "..", "..", "README.md"), "utf8");

/**
 * Every `cat > name.json <<'EOF' … EOF` heredoc in the README, by filename.
 *
 * Matched on the shape the README actually uses rather than on fenced blocks generally: the
 * point is to run what a reader would paste, and what they paste is the heredoc.
 */
function heredocs(): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of README.matchAll(/cat > ([\w.-]+\.json) <<'EOF'\n([\s\S]*?)\nEOF/g)) {
    found.set(match[1] ?? "", match[2] ?? "");
  }
  return found;
}

/**
 * Whitespace-insensitive comparison, both sides.
 *
 * The README wraps the quoted refusal to fit its column, so a literal `toContain` would fail
 * on a line break rather than on the meaning — which is the wrong thing for this test to be
 * sensitive to. Rewrapping the paragraph must be free; changing what the store says must not.
 */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ");
}

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

/** Write a README heredoc to disk exactly as its `cat` line would. */
function paste(name: string): string {
  const body = heredocs().get(name);
  if (body === undefined) throw new Error(`the README no longer has a heredoc for ${name}`);
  const path = join(h.dir, name);
  writeFileSync(path, `${body}\n`);
  return path;
}

async function commit(name: string, base: number, why: string, code: string): Promise<number> {
  return run(
    ["mutate", "--ops", paste(name), "--base-version", String(base), "--why", why, "--reason-code", code],
    h.io,
  );
}

describe("the README's example is code, not decoration", () => {
  test("extraction found both blocks — an empty test passes silently", () => {
    expect([...heredocs().keys()]).toEqual(["roster.json", "ask.json"]);
  });

  test("the documented sequence commits, in the documented order", async () => {
    expect(await run(["init"], h.io)).toBe(0);
    h.reset();

    expect(await commit("roster.json", 0, "Read the roster first.", "MISSING_STEP")).toBe(0);
    expect(h.out[0]).toContain("committed v1");
    // The ids the prose promises are minted from labels, not written by hand.
    expect(h.out[0]).toContain("confirm-roster-availability");
    h.reset();

    expect(await commit("ask.json", 1, "The roster names Dana; ask her.", "NEW_CONSTRAINT")).toBe(0);
    expect(h.out[0]).toContain("committed v2");
    expect(h.out[0]).toContain("ask-dana-to-play-thursday");
  });

  test("`kona next` shows what the README says it shows", async () => {
    await run(["init"], h.io);
    await commit("roster.json", 0, "Read the roster first.", "MISSING_STEP");
    await commit("ask.json", 1, "Ask Dana.", "NEW_CONSTRAINT");
    h.reset();

    expect(await run(["next"], h.io)).toBe(0);
    const text = h.out.join("\n");
    // The ask is ready and marked pivot; the wait behind it is not, because a wait is
    // something the world has to do.
    expect(text).toContain("ask-dana-to-play-thursday");
    expect(text).toContain("[pivot]");
    expect(text).not.toContain("wait-for-dana");
  });

  test("the `# 3` in the last line is the exit code it really produces", async () => {
    await run(["init"], h.io);
    await commit("roster.json", 0, "Read the roster first.", "MISSING_STEP");
    await commit("ask.json", 1, "Ask Dana.", "NEW_CONSTRAINT");
    h.reset();

    expect(await commit("ask.json", 1, "again", "OTHER")).toBe(3);
    expect(h.err[0]).toContain("STALE_BASE_VERSION");
  });

  test("the refusal the README quotes is the refusal the store gives", async () => {
    // Run `ask.json` FIRST, as the README says to try, and the store must answer with the
    // message printed underneath it. Asserted on the parts that carry meaning rather than on
    // the whole paragraph, so rewording the prose does not fail this — but changing what the
    // store actually refuses, or why, does.
    expect(await run(["init"], h.io)).toBe(0);
    h.reset();

    // Exit 1, not 4. Invariant 3 is parser-class and refuses rather than violating — see
    // §6.8: the reason token is the API and the number is a coarse class.
    expect(await commit("ask.json", 0, "email a stranger", "OTHER")).toBe(1);
    const refusal = flatten(h.err.join(" "));
    const quoted = flatten(README);
    for (const fragment of [
      "UNEVIDENCED_RECIPIENT",
      "ask-dana-to-play-thursday",
      "nothing in the graph attests to 'dana'",
      "evidence that existed BEFORE this batch",
      // The measurement that makes the rule worth having, not just a rule.
      "At n=60 a mutator that could not satisfy a constraint invented counterparties",
    ]) {
      expect(refusal).toContain(fragment);
      // And the README quotes it, so the two cannot drift apart.
      expect(quoted).toContain(fragment);
    }
  });
});
