import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { SCHEMA_VERSION, type MutationRecord } from "@kona/core";
import { konaPaths } from "../src/paths.ts";
import {
  appendRecord,
  dropTornTail,
  loadGraph,
  readLogText,
  serializeRecord,
} from "../src/store.ts";
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

describe("a torn tail is dropped before appending after it", () => {
  test("so one crash cannot corrupt the log permanently", async () => {
    // Appending after a torn line buries it MID-FILE, where it stops being a tolerable
    // tail and becomes damage — and from then on every read and every write refuses.
    const paths = konaPaths(h.dir);
    await appendRecord(paths, stamped(0));
    await Bun.write(paths.log, `${readFileSync(paths.log, "utf8")}{"v":1,"schema_ver`);

    const torn = await loadGraph(paths);
    expect(torn.torn_tail).not.toBeNull();

    await dropTornTail(paths, await readLogText(paths));
    await appendRecord(paths, stamped(1));

    const healed = await loadGraph(paths);
    expect(healed.torn_tail).toBeNull();
    expect(healed.damaged).toEqual([]);
    expect(healed.records.map((r) => r.v)).toEqual([0, 1]);
  });

  test("a log that is nothing but a torn line truncates to empty", async () => {
    const paths = konaPaths(h.dir);
    await Bun.write(paths.log, '{"v":0,"schema_ver');
    await dropTornTail(paths, await readLogText(paths));
    expect(await readLogText(paths)).toBe("");
  });

  test("it truncates by BYTES, not by characters", async () => {
    // Rationales are prose: em dashes, middots, names. Truncating by string length would
    // cut mid-character on any log containing them and corrupt the record before the tear.
    const paths = konaPaths(h.dir);
    const wide = {
      ...stamped(0),
      rationale: {
        why: "Dana declined — away · ünïcode",
        alternatives_rejected: [],
        reason_code: "OTHER" as const,
      },
    };
    await appendRecord(paths, wide);
    const intact = readFileSync(paths.log, "utf8");
    expect(Buffer.byteLength(intact, "utf8")).toBeGreaterThan(intact.length);

    await Bun.write(paths.log, `${intact}{"v":1,"sch`);
    await dropTornTail(paths, await readLogText(paths));
    expect(readFileSync(paths.log, "utf8")).toBe(intact);
    expect((await loadGraph(paths)).records[0]?.rationale.why).toBe(
      "Dana declined — away · ünïcode",
    );
  });

  test("a torn line that ended with a newline is still dropped", async () => {
    const paths = konaPaths(h.dir);
    await appendRecord(paths, stamped(0));
    const intact = readFileSync(paths.log, "utf8");
    await Bun.write(paths.log, `${intact}{"v":1,"sch\n`);
    await dropTornTail(paths, await readLogText(paths));
    expect(readFileSync(paths.log, "utf8")).toBe(intact);
  });

  test("dropping is exact — a complete record before the tear survives byte for byte", async () => {
    const paths = konaPaths(h.dir);
    await appendRecord(paths, stamped(0));
    const intact = readFileSync(paths.log, "utf8");
    await Bun.write(paths.log, `${intact}{"v":1,"sch`);
    await dropTornTail(paths, await readLogText(paths));
    expect(readFileSync(paths.log, "utf8")).toBe(intact);
  });
});
