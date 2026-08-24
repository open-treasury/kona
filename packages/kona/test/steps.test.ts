/**
 * `--steps` — sugar for the commonest batch there is.
 *
 * It exists because of a measurement, not a preference: in `eval/`, the smallest possible
 * first commit was 668 characters across two shell commands while the `printf` banner the
 * model used instead was 27 across one, and models under a clock declined the graph on cost.
 *
 * So the thing worth testing is that it is *only* sugar. It must reach the same validator,
 * the same CAS, the same append — and it must not become a second way to write, or a way to
 * write something `--ops` could not.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MutationRecord } from "@kona/core";
import { opsFromSteps } from "../src/commands/mutate.ts";
import { run } from "../src/cli.ts";
import { harness, type Harness } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = harness();
  expect(await run(["init", "--prefix", "t"], h.io)).toBe(0);
});
afterEach(() => h.cleanup());

function records(): MutationRecord[] {
  return readFileSync(join(h.dir, ".kona", "mutations.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as MutationRecord);
}

async function steps(...labels: string[]): Promise<number> {
  return await run(
    [
      "mutate",
      ...labels.flatMap((label) => ["--steps", label]),
      "--base-version",
      "0",
      "--why",
      "Read the failure before changing anything.",
      "--reason-code",
      "MISSING_STEP",
    ],
    h.io,
  );
}

describe("--steps", () => {
  test("commits a chain: each step depends on the one before it", async () => {
    expect(await steps("Read the failing test", "Fix the parser")).toBe(0);

    const committed = records().at(-1)?.ops ?? [];
    expect(committed).toHaveLength(3);
    expect(committed.filter((op) => op.op === "add_node")).toHaveLength(2);

    const edges = committed.filter((op) => op.op === "add_edge");
    expect(edges).toHaveLength(1);
    // `from A to B` means B depends on A, so the chain reads in the order it was typed.
    expect(edges[0]).toMatchObject({
      from: h.id("read-the-failing-test"),
      to: h.id("fix-the-parser"),
    });
  });

  test("only the head of the chain is ready", async () => {
    expect(await steps("First", "Second", "Third")).toBe(0);
    h.reset();
    expect(await run(["next", "--json"], h.io)).toBe(0);

    const frontier = JSON.parse(h.out.join("\n")) as { nodes: { id: string }[] };
    expect(frontier.nodes.map((node) => node.id)).toEqual([h.id("first")]);
  });

  test("a single step commits, with no edge to draw", async () => {
    expect(await steps("Just the one")).toBe(0);
    const committed = records().at(-1)?.ops ?? [];
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({ op: "add_node", label: "Just the one" });
  });

  test("the rationale is still required — sugar does not buy an exemption", async () => {
    const code = await run(
      ["mutate", "--steps", "Something", "--base-version", "0", "--reason-code", "OTHER"],
      h.io,
    );
    expect(code).not.toBe(0);
    expect(h.err.join("\n")).toContain("why");
  });

  test("CAS still applies — a stale base version is refused", async () => {
    expect(await steps("First")).toBe(0);
    h.reset();
    // Head is v1 now; re-submitting against 0 must exit 3, exactly as --ops would.
    expect(await steps("Second")).toBe(3);
    expect(h.err.join("\n")).toContain("STALE_BASE_VERSION");
  });

  test("--ops and --steps together are refused rather than silently ranked", async () => {
    const opsFile = h.writeOps("ops.json", []);
    const code = await run(
      [
        "mutate",
        "--ops",
        opsFile,
        "--steps",
        "Something",
        "--base-version",
        "0",
        "--why",
        "both at once",
        "--reason-code",
        "OTHER",
      ],
      h.io,
    );
    expect(code).toBe(1);
    expect(h.err.join("\n")).toContain("AMBIGUOUS_OPS");
  });

  test("neither --ops nor --steps is refused, not treated as an empty batch", async () => {
    const code = await run(
      ["mutate", "--base-version", "0", "--why", "nothing", "--reason-code", "OTHER"],
      h.io,
    );
    expect(code).toBe(1);
  });
});

describe("opsFromSteps", () => {
  test("emits n nodes and n-1 edges", () => {
    expect(opsFromSteps(["a", "b", "c", "d"])).toHaveLength(7);
  });

  test("emits nothing for no steps, rather than an empty-batch commit", () => {
    expect(opsFromSteps([])).toEqual([]);
  });

  test("the label is the instruction — no words are invented for the author", () => {
    const [node] = opsFromSteps(["Read the failing test"]);
    expect(node).toMatchObject({
      op: "add_node",
      label: "Read the failing test",
      type: "task",
      spec: { instruction: "Read the failing test", effect_class: "pure" },
    });
  });

  test("every node is pure — sugar can never author an effect", () => {
    // The whole point of the one-line path is that it cannot reach the world. Anything that
    // sends is a deliberate act through --ops, where the invariants have something to check.
    const ops = opsFromSteps(["a", "b", "c"]) as { op: string; spec?: { effect_class: string } }[];
    for (const op of ops.filter((candidate) => candidate.op === "add_node")) {
      expect(op.spec?.effect_class).toBe("pure");
    }
  });
});
