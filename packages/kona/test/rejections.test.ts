/**
 * `.kona/rejections.jsonl` — §8: "Rejected mutations are logged."
 *
 * The property that makes a third file defensible: **the graph is still exactly
 * `fold(mutations.jsonl)`**. Nothing folds this, nothing decides anything from it, and
 * deleting it loses memory rather than state.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { type RejectionRecord, parseRejections } from "../src/rejections.ts";
import { konaPaths } from "../src/paths.ts";
import { harness, type Harness } from "./harness.ts";

let h: Harness;

const NODE = [
  {
    op: "add_node",
    label: "Ask Dana",
    type: "task",
    spec: { instruction: "Email Dana.", effect_class: "pure" },
  },
];
const FINISH = [{ op: "set_status", node: "ask-dana", status: "done", evidence_ref: "e" }];

async function mutate(ops: unknown[], base: number, why: string, ...extra: string[]): Promise<number> {
  h.reset();
  const path = h.writeOps(`ops-${Math.abs(base)}-${why.length}.json`, ops);
  return await run(
    ["mutate", "--ops", path, "--base-version", String(base), "--why", why, "--reason-code", "OTHER", ...extra],
    h.io,
  );
}

function rejectionsPath(): string {
  return konaPaths(h.dir).rejections;
}

function refusals(): RejectionRecord[] {
  if (!existsSync(rejectionsPath())) return [];
  return parseRejections(readFileSync(rejectionsPath(), "utf8")).records;
}

beforeEach(async () => {
  h = harness();
  expect(await run(["init"], h.io)).toBe(0);
  expect(await mutate(NODE, 0, "ask her")).toBe(0);
  expect(await mutate(FINISH, 1, "she answered")).toBe(0);
});
afterEach(() => h.cleanup());

describe("what gets remembered", () => {
  test("nothing, until something is refused", () => {
    expect(existsSync(rejectionsPath())).toBe(false);
  });

  test("an invariant violation is written whole", async () => {
    expect(await mutate(FINISH, 2, "reopen it, I want another go")).toBe(4);
    const [record] = refusals();
    expect(record?.rejection.reason).toBe("TERMINAL_NODE_PROTECTED");
    expect(record?.rejection.invariant).toBe(1);
    expect(record?.rejection.node).toBe("ask-dana");
    expect(record?.head_version).toBe(2);
    expect(record?.base_version).toBe(2);
  });

  test("the author's own words survive verbatim — that is the point", async () => {
    // §6.3: rationale without outcome is a changelog; rationale WITH outcome is training
    // data. A rejection is the only record in the system that carries both.
    await mutate(FINISH, 2, "reopen it, I want another go");
    expect(refusals()[0]?.rationale?.why).toBe("reopen it, I want another go");
    expect(refusals()[0]?.rationale?.reason_code).toBe("OTHER");
  });

  test("the batch is kept AS AUTHORED, refs and all — it never got normalised", async () => {
    const authored = [
      { op: "add_edge", from: "$0", to: "ask-dana" },
      ...NODE,
    ];
    expect(await mutate(authored, 2, "wire it backwards")).toBe(1);
    expect(JSON.stringify(refusals()[0]?.ops)).toContain("$0");
  });

  test("a malformed batch is remembered too, even though it never reached the graph", async () => {
    expect(await mutate([{ op: "delete_node", node: "ask-dana" }], 2, "just remove it")).toBe(1);
    expect(refusals()[0]?.rejection.reason).toBe("MALFORMED_OPS");
    expect(refusals()[0]?.rationale?.why).toBe("just remove it");
  });

  test("an unauthorised actor is remembered with its identity", async () => {
    expect(await mutate(NODE, 2, "sneak one in", "--actor-kind", "subagent", "--actor-id", "exec-1")).toBe(1);
    expect(refusals()[0]?.rejection.reason).toBe("UNAUTHORIZED_ACTOR");
    expect(refusals()[0]?.actor).toEqual({ kind: "subagent", id: "exec-1" });
  });

  test("refusals accumulate, oldest first", async () => {
    await mutate(FINISH, 2, "first try");
    await mutate(FINISH, 2, "second try");
    expect(refusals().map((r) => r.rationale?.why)).toEqual(["first try", "second try"]);
  });
});

describe("what is deliberately NOT remembered", () => {
  test("a successful commit writes nothing here", async () => {
    expect(await mutate([{ op: "record_output", node: "ask-dana", output_name: "x", value: 1, evidence_ref: "e" }], 2, "ok")).not.toBe(0);
    const afterFailure = refusals().length;
    expect(await mutate(NODE, 2, "another node")).toBe(0);
    expect(refusals()).toHaveLength(afterFailure);
  });

  test("a stale base version is contention, not a defect", async () => {
    // The ops may be perfectly good and simply late. What this file is for is a batch the
    // store judged WRONG.
    expect(await mutate(NODE, 0, "late to the party")).toBe(3);
    expect(refusals()).toEqual([]);
  });
});

describe("the graph is still exactly fold(mutations.jsonl)", () => {
  test("a refusal changes no version and no node", async () => {
    h.reset();
    expect(await run(["graph", "--json"], h.io)).toBe(0);
    const before = h.out[0];

    await mutate(FINISH, 2, "reopen it");
    expect(refusals()).toHaveLength(1);

    h.reset();
    expect(await run(["graph", "--json"], h.io)).toBe(0);
    expect(h.out[0]).toBe(before);
  });

  test("deleting the file loses memory, not state", async () => {
    await mutate(FINISH, 2, "reopen it");
    writeFileSync(rejectionsPath(), "");
    h.reset();
    expect(await run(["graph", "--json"], h.io)).toBe(0);
    expect(JSON.parse(h.out[0] ?? "{}").version).toBe(2);
  });
});

describe("reading them back", () => {
  test("--rejections lists them with the reason and the rationale", async () => {
    await mutate(FINISH, 2, "reopen it, I want another go");
    h.reset();
    expect(await run(["graph", "--rejections"], h.io)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("1 refusal(s)");
    expect(text).toContain("TERMINAL_NODE_PROTECTED");
    expect(text).toContain("wanted: reopen it, I want another go");
  });

  test("a pursuit that has refused nothing says so", async () => {
    h.reset();
    expect(await run(["graph", "--rejections"], h.io)).toBe(0);
    expect(h.out[0]).toContain("nothing has been refused");
  });

  test("--json carries them alongside the graph, and omits them otherwise", async () => {
    await mutate(FINISH, 2, "reopen it");
    h.reset();
    expect(await run(["graph", "--json", "--rejections"], h.io)).toBe(0);
    const withThem = JSON.parse(h.out[0] ?? "{}") as { rejections: RejectionRecord[] };
    expect(withThem.rejections).toHaveLength(1);

    h.reset();
    expect(await run(["graph", "--json"], h.io)).toBe(0);
    expect(Object.keys(JSON.parse(h.out[0] ?? "{}"))).not.toContain("rejections");
  });
});

describe("it is memory, so it fails soft", () => {
  test("parsing tolerates damage — half of it beats none of it", () => {
    const good = '{"at":"x","rejection":{"code":"REFUSED","reason":"R","message":"m"}}';
    const parsed = parseRejections(`${good}\n{not json\n\n${good}\r\n`);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.damaged).toBe(1);
  });

  test("an unwritable log does not turn a refusal into a crash", async () => {
    // The refusal still stands, and one line says the note was lost.
    const dir = join(h.dir, ".kona");
    mkdirSync(join(dir, "rejections.jsonl"), { recursive: true });
    expect(await mutate(FINISH, 2, "reopen it")).toBe(4);
    expect(h.err.some((line) => line.includes("REJECTION_NOT_LOGGED"))).toBe(true);
    expect(h.err[0]).toContain("TERMINAL_NODE_PROTECTED");
  });

  test("an unreadable log does not break the read verb", async () => {
    writeFileSync(rejectionsPath(), "{not json\n");
    h.reset();
    expect(await run(["graph", "--rejections"], h.io)).toBe(0);
    expect(h.out.join("\n")).toContain("1 unreadable line(s)");
  });
});
