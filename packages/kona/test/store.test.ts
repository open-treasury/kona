import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { SCHEMA_VERSION, type MutationRecord } from "@kona/core";
import { konaPaths } from "../src/paths.ts";
import { appendRecord, loadGraph, readLogText, serializeRecord } from "../src/store.ts";
import { systemClock } from "../src/clock.ts";
import { harness, type Harness } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = harness();
  await mkdir(konaPaths(h.dir).dir, { recursive: true });
});
afterEach(() => h.cleanup());

function stamped(v: number): MutationRecord {
  const at = "2026-08-21T12:00:00.000Z";
  return {
    v,
    schema_version: SCHEMA_VERSION,
    observed_at: at,
    occurred_at: at,
    actor: { kind: "orchestrator", id: "run-1" },
    ops: [],
    rationale: { why: `v${v}`, alternatives_rejected: [], reason_code: "OTHER" },
    outcome: null,
  };
}

describe("serialisation", () => {
  test("one record, one line, always newline-terminated", () => {
    const line = serializeRecord(stamped(0));
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().includes("\n")).toBe(false);
  });

  test("no pretty-printing — a record must not span lines", () => {
    expect(serializeRecord(stamped(0))).not.toContain("\n  ");
  });
});

describe("append is append-only", () => {
  test("records accumulate in order and nothing is rewritten", async () => {
    const paths = konaPaths(h.dir);
    for (const v of [0, 1, 2]) await appendRecord(paths, stamped(v));
    const lines = readFileSync(paths.log, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l).v)).toEqual([0, 1, 2]);
  });

  test("readLogText returns exactly what was written", async () => {
    const paths = konaPaths(h.dir);
    await appendRecord(paths, stamped(0));
    expect(await readLogText(paths)).toBe(serializeRecord(stamped(0)));
  });

  test("loadGraph folds what is on disk", async () => {
    const paths = konaPaths(h.dir);
    await appendRecord(paths, stamped(0));
    await appendRecord(paths, stamped(1));
    const folded = await loadGraph(paths);
    expect(folded.graph.version).toBe(1);
    expect(folded.damaged).toEqual([]);
  });
});

describe("the clock", () => {
  test("systemClock yields a parseable ISO-8601 instant", () => {
    const now = systemClock();
    expect(Number.isNaN(Date.parse(now))).toBe(false);
    expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("it is the only moving part: two reads may differ, a fixed clock never does", () => {
    expect(h.io.now()).toBe(h.io.now());
  });
});
