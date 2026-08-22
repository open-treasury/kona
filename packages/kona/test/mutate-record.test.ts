/**
 * What actually lands on the line.
 *
 * 6.3 calls the mutation record the differentiator, and 8 makes a commit without a
 * rationale impossible. Both claims are about bytes in the file, so these assert the bytes
 * — not that the command exited zero.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MutationRecord } from "@kona/core";
import { run } from "../src/cli.ts";
import { ASK_DANA, harness, seedRoster, type Harness } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = harness();
  expect(await run(["init"], h.io)).toBe(0);
  // ASK_DANA emails Dana, so the graph must already attest to her. Head lands at v2.
  await seedRoster(h, ["dana"]);
});
afterEach(() => h.cleanup());

const T0 = "2026-08-21T12:00:00.000Z";

function records(): MutationRecord[] {
  return readFileSync(join(h.dir, ".kona", "mutations.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as MutationRecord);
}

async function mutate(...extra: string[]): Promise<number> {
  const ops = h.writeOps("ops.json", ASK_DANA);
  return await run(
    ["mutate", "--ops", ops, "--base-version", "2", "--why", "Dana is the only goalie", "--reason-code", "MISSING_STEP", ...extra],
    h.io,
  );
}

describe("the rationale is carried through verbatim", () => {
  test("why and reason_code land on the record", async () => {
    expect(await mutate()).toBe(0);
    const rationale = records().at(-1)?.rationale;
    expect(rationale?.why).toBe("Dana is the only goalie");
    expect(rationale?.reason_code).toBe("MISSING_STEP");
  });

  test("--expected-effect is recorded when given", async () => {
    expect(await mutate("--expected-effect", "quorum(goalie) satisfiable by Fri")).toBe(0);
    expect(records().at(-1)?.rationale.expected_effect).toBe("quorum(goalie) satisfiable by Fri");
  });

  test("and the key is absent — not null, not empty — when it is not", async () => {
    expect(await mutate()).toBe(0);
    expect(Object.keys(records().at(-1)?.rationale ?? {})).toEqual([
      "why",
      "alternatives_rejected",
      "reason_code",
    ]);
  });

  test("--alternative may be repeated, and order is preserved", async () => {
    expect(await mutate("--alternative", "cancel the game", "--alternative", "play short")).toBe(0);
    expect(records().at(-1)?.rationale.alternatives_rejected).toEqual(["cancel the game", "play short"]);
  });

  test("with no alternatives it is an empty list, so the field always exists", async () => {
    expect(await mutate()).toBe(0);
    expect(records().at(-1)?.rationale.alternatives_rejected).toEqual([]);
  });
});

describe("engine-stamped fields", () => {
  test("both timestamps come from the clock, never from the caller", async () => {
    expect(await mutate()).toBe(0);
    const record = records()[1];
    expect(record?.observed_at).toBe(T0);
    expect(record?.occurred_at).toBe(T0);
  });

  test("outcome starts null — it is written later, on evidence", async () => {
    expect(await mutate()).toBe(0);
    expect(records().at(-1)?.outcome).toBeNull();
  });

  test("the actor is recorded, defaulting to the orchestrator", async () => {
    expect(await mutate()).toBe(0);
    expect(records().at(-1)?.actor).toEqual({ kind: "orchestrator", id: "orchestrator" });
  });

  test("a named actor is carried through", async () => {
    expect(await mutate("--actor-id", "run-7")).toBe(0);
    expect(records().at(-1)?.actor).toEqual({ kind: "orchestrator", id: "run-7" });
  });

  test("versions increment by exactly one", async () => {
    expect(await mutate()).toBe(0);
    const ops = h.writeOps("done.json", [
      { op: "set_status", node: "ask-dana-to-play-thursday", status: "done", evidence_ref: "e" },
    ]);
    expect(
      await run(["mutate", "--ops", ops, "--base-version", "3", "--why", "sent", "--reason-code", "OTHER"], h.io),
    ).toBe(0);
    expect(records().map((r) => r.v)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("what mutate reports", () => {
  test("--json reports the version, the minted ids and the op count", async () => {
    expect(await mutate("--json")).toBe(0);
    expect(JSON.parse(h.out[0] ?? "{}")).toEqual({
      ok: true,
      version: 3,
      minted_ids: ["ask-dana-to-play-thursday", "wait-for-dana"],
      ops: 3,
    });
  });

  test("a batch that mints nothing says so by omission, not by an empty list", async () => {
    await mutate();
    h.reset();
    const ops = h.writeOps("done.json", [
      { op: "set_status", node: "ask-dana-to-play-thursday", status: "done", evidence_ref: "e" },
    ]);
    expect(
      await run(["mutate", "--ops", ops, "--base-version", "3", "--why", "sent", "--reason-code", "OTHER"], h.io),
    ).toBe(0);
    expect(h.out[0]).toBe("committed v4 · 1 ops");
  });

  test("the human line names the version, the count and the ids", async () => {
    expect(await mutate()).toBe(0);
    expect(h.out[0]).toBe(
      "committed v3 · 3 ops · minted ask-dana-to-play-thursday, wait-for-dana",
    );
  });

  test("--json on a mint-free batch still reports an empty list", async () => {
    await mutate();
    h.reset();
    const ops = h.writeOps("done.json", [
      { op: "set_status", node: "wait-for-dana", status: "done", evidence_ref: "e" },
    ]);
    expect(
      await run(["mutate", "--ops", ops, "--base-version", "3", "--why", "x", "--reason-code", "OTHER", "--json"], h.io),
    ).toBe(0);
    expect(JSON.parse(h.out[0] ?? "{}").minted_ids).toEqual([]);
  });
});

describe("refusals say enough to act on", () => {
  test("a stale base version tells you head and what to do instead", async () => {
    await mutate();
    h.reset();
    expect(await mutate()).toBe(3);
    expect(h.err[0]).toBe(
      "STALE_BASE_VERSION head=3 base=2 re-read the graph and re-decide; a blind merge is never correct here",
    );
  });

  test("a corrupt log names the line, the reason and the detail", async () => {
    await mutate();
    const log = join(h.dir, ".kona", "mutations.jsonl");
    const lines = readFileSync(log, "utf8").trim().split("\n");
    await Bun.write(log, `${lines[0]}\n{"v":1,"broken":true}\n${lines[1]}\n`);
    h.reset();
    const ops = h.writeOps("more.json", ASK_DANA);
    expect(await run(["mutate", "--ops", ops, "--base-version", "3", "--why", "x", "--reason-code", "OTHER"], h.io)).toBe(1);
    expect(h.err[0]).toStartWith("REFUSED CORRUPT_LOG line=2 UNPARSEABLE_RECORD ");
    expect(h.err[0]).toContain("schema_version");
  });
});
