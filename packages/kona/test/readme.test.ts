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
  return text.replace(/\s+/g, " ").trim();
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
  test("extraction found every block — an empty test passes silently", () => {
    expect([...heredocs().keys()]).toEqual(["constraints.json", "schedule.json", "notify.json"]);
  });

  test("the documented sequence commits, in the documented order", async () => {
    expect(await run(["init"], h.io)).toBe(0);
    h.reset();

    expect(
      await commit("constraints.json", 0, "Read the calendar first.", "MISSING_STEP"),
    ).toBe(0);
    expect(h.out[0]).toContain("committed v1");
    // The ids the prose promises are minted from labels, not written by hand.
    expect(h.out[0]).toContain("read-the-line-constraints");
    h.reset();

    expect(await commit("schedule.json", 1, "Place the orders.", "NEW_CONSTRAINT")).toBe(0);
    expect(h.out[0]).toContain("committed v2");
    expect(h.out[0]).toContain("schedule-the-work-orders");
  });

  test("`kona next` shows what the README says it shows", async () => {
    await run(["init"], h.io);
    await commit("constraints.json", 0, "Read the calendar first.", "MISSING_STEP");
    await commit("schedule.json", 1, "Place the orders.", "NEW_CONSTRAINT");
    h.reset();

    expect(await run(["next"], h.io)).toBe(0);
    const text = h.out.join("\n");
    // Both are ready: the escalation has no in-edge, and scheduling's one dependency is the
    // reading step, which v1 recorded as done.
    expect(text).toContain("schedule-the-work-orders");
    expect(text).toContain("escalate-no-feasible-slot");
  });

  test("claiming a node takes it off the frontier, as the README says", async () => {
    await run(["init"], h.io);
    await commit("constraints.json", 0, "Read the calendar first.", "MISSING_STEP");
    await commit("schedule.json", 1, "Place the orders.", "NEW_CONSTRAINT");

    // The README writes this one with `printf` rather than a heredoc, so it is inlined here
    // rather than extracted — the assertion that matters is the disappearance, not the shape.
    const claim = join(h.dir, "claim.json");
    writeFileSync(
      claim,
      '[{"op":"set_status","node":"schedule-the-work-orders","status":"in_flight","evidence_ref":"claim"}]',
    );
    expect(
      await run(
        ["mutate", "--ops", claim, "--base-version", "2", "--why", "Starting placement.", "--reason-code", "OTHER"],
        h.io,
      ),
    ).toBe(0);
    h.reset();

    expect(await run(["next"], h.io)).toBe(0);
    expect(h.out.join("\n")).not.toContain("schedule-the-work-orders");
  });

  test("the `# 3` in the last line is the exit code it really produces", async () => {
    await run(["init"], h.io);
    await commit("constraints.json", 0, "Read the calendar first.", "MISSING_STEP");
    await commit("schedule.json", 1, "Place the orders.", "NEW_CONSTRAINT");
    h.reset();

    expect(await commit("schedule.json", 1, "again", "OTHER")).toBe(3);
    expect(h.err[0]).toContain("STALE_BASE_VERSION");
  });

  test("the refusal the README quotes is the refusal the store gives, WORD FOR WORD", async () => {
    // Run `notify.json` FIRST, as the README invites you to, and the store must answer with
    // the paragraph printed underneath it.
    //
    // This compared FRAGMENTS until it let a defect through: the README quoted `op=0` where
    // the binary prints `op=1` — index 0 is the escalation, index 1 is the node actually
    // carrying the `recipient_ref` — and every fragment the test knew about still matched.
    // A quote is not a summary. It is either what the program said or it is wrong, so the
    // whole paragraph is compared, whitespace-normalised because the README wraps it.
    expect(await run(["init"], h.io)).toBe(0);
    h.reset();

    expect(await commit("notify.json", 0, "expedite the shortage", "OTHER")).toBe(1);
    const refusal = flatten(h.err.join(" "));

    // The quote is the fenced block that follows "the store will not have it:".
    // The quote is the LAST fenced block in the refusal section — the one after the heredoc
    // that provokes it, not the heredoc itself.
    const quoted = /kona mutate --ops notify\.json[^`]*```\s*```\n([\s\S]*?)```/.exec(README)?.[1];
    expect(quoted).toBeDefined();
    expect(flatten(quoted ?? "")).toBe(refusal);

    // And it is a real refusal, not an empty string matching an empty string.
    expect(refusal).toContain("UNEVIDENCED_RECIPIENT");
    expect(refusal.length).toBeGreaterThan(200);
  });
});
