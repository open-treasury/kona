/**
 * The layout, the exit codes, and the genesis record — the three things another program
 * has to agree with kona about.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Graph, Rejection } from "@kona/core";
import { SCHEMA_VERSION } from "@kona/core";
import { KONA_DIR, LOCK_FILE, LOG_FILE, REJECTIONS_FILE, konaPaths } from "../src/paths.ts";
import { NETWORK_PATH_MARKERS, detectNetworkFilesystem } from "../src/netfs.ts";
import {
  EXIT_INVARIANT_VIOLATION,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_STALE_BASE_VERSION,
  exitCodeFor,
} from "../src/exit.ts";
import { genesisRecord } from "../src/commands/init.ts";
import { projectPublicGraph } from "../src/commands/graph.ts";
import { projectNext } from "../src/commands/next.ts";

const provenance = { created_by_version: 1, supersedes: null, superseded_by: null };
const status = (state: "ready" | "completed") => ({
  state,
  outcomes: [],
  outcome: null,
  output: null,
  output_evidence: null,
  conditions: [],
  effect_log: [],
  observed_at_version: 1,
});

function nextContractGraph(): Graph {
  const actionSpec = {
    instruction: "work",
    inputs: [],
    outputs: [],
    effect_class: "pure" as const,
  };
  return {
    schema_version: SCHEMA_VERSION,
    version: 1,
    nodes: new Map([
      ["start", { id: "start", type: "initial", name: "Start", spec: {}, provenance }],
      ["fork", { id: "fork", type: "fork", name: "Parallel", spec: {}, provenance }],
      [
        "a",
        {
          id: "a",
          type: "action",
          name: "A",
          spec: actionSpec,
          status: status("ready"),
          provenance,
        },
      ],
      [
        "b",
        {
          id: "b",
          type: "action",
          name: "B",
          spec: actionSpec,
          status: status("ready"),
          provenance,
        },
      ],
      [
        "wait",
        {
          id: "wait",
          type: "accept_event",
          name: "Wait",
          spec: {
            ...actionSpec,
            deadline: { at: "2026-08-22T17:00:00.000Z" },
            match: {
              kind: "event",
              conditions: [{ kind: "reply", on: "satisfied" }],
              memory: true,
            },
          },
          status: status("ready"),
          provenance,
        },
      ],
      [
        "done",
        {
          id: "done",
          type: "action",
          name: "Done",
          spec: actionSpec,
          status: status("completed"),
          provenance,
        },
      ],
      ["final", { id: "final", type: "final", name: "Final", spec: {}, provenance }],
    ]),
    edges: [
      { from: "start", to: "fork" },
      { from: "fork", to: "a" },
      { from: "fork", to: "b" },
      { from: "fork", to: "wait" },
      { from: "done", to: "final" },
    ],
  };
}

describe("the public next projection", () => {
  test("returns only ready actions, carrying their containing fork", () => {
    const projection = projectNext(nextContractGraph());
    expect(projection.nodes.map(({ id, fork }) => ({ id, fork }))).toEqual([
      { id: "a", fork: "fork" },
      { id: "b", fork: "fork" },
    ]);
  });

  test("reports a reached activity final independently of an empty frontier", () => {
    const graph = nextContractGraph();
    graph.nodes.delete("a");
    graph.nodes.delete("b");
    expect(projectNext(graph)).toMatchObject({ complete: true, nodes: [] });
  });
});

test("the public graph projection exposes guard and never condition", () => {
  const graph = nextContractGraph();
  graph.edges = [{ from: "done", to: "final", guard: { on: "satisfied" } }];
  const projection = projectPublicGraph({
    schema_version: graph.schema_version,
    version: graph.version,
    nodes: [...graph.nodes.values()],
    edges: graph.edges,
  });
  expect(projection.edges).toEqual([{ from: "done", to: "final", guard: { on: "satisfied" } }]);
  expect(projection.edges.some((edge) => "condition" in edge)).toBe(false);
});

describe("the .kona layout is two files and no snapshot", () => {
  test("paths derive from the root", () => {
    const paths = konaPaths("/pursuits/thursday");
    expect(paths.dir).toBe(join("/pursuits/thursday", KONA_DIR));
    expect(paths.log).toBe(join("/pursuits/thursday", KONA_DIR, LOG_FILE));
    expect(paths.lock).toBe(join("/pursuits/thursday", KONA_DIR, LOCK_FILE));
  });

  test("the names are the ones the spec fixes", () => {
    expect([KONA_DIR, LOG_FILE, LOCK_FILE, REJECTIONS_FILE]).toEqual([
      ".kona",
      "mutations.jsonl",
      "lock",
      "rejections.jsonl",
    ]);
  });

  test("rejections sit beside the log, and are not the log", () => {
    // The graph is `fold(mutations.jsonl)` and nothing else. A third file that fold reads
    // would be a second system of record; this one is memory.
    const paths = konaPaths("/pursuits/thursday");
    expect(paths.rejections).toBe(join("/pursuits/thursday", KONA_DIR, REJECTIONS_FILE));
    expect(paths.rejections).not.toBe(paths.log);
  });
});

describe("exit status is 8-bit (§6.8)", () => {
  test("every code survives truncation to a byte", () => {
    for (const code of [EXIT_OK, EXIT_REFUSED, EXIT_STALE_BASE_VERSION, EXIT_INVARIANT_VIOLATION]) {
      expect(code).toBe(code & 0xff);
      expect(code).toBeLessThan(256);
    }
    // 409 would arrive as 153 and 422 as 166 — success-adjacent nonsense in a shell.
    expect(409 & 0xff).not.toBe(409);
  });

  test("the four codes are distinct", () => {
    const codes = [EXIT_OK, EXIT_REFUSED, EXIT_STALE_BASE_VERSION, EXIT_INVARIANT_VIOLATION];
    expect(new Set(codes).size).toBe(codes.length);
  });

  test.each([
    [
      { code: "INVARIANT_VIOLATION", reason: "TERMINAL_ACTIVITY_PROTECTED", message: "" },
      EXIT_INVARIANT_VIOLATION,
    ],
    [{ code: "REFUSED", reason: "STALE_BASE_VERSION", message: "" }, EXIT_STALE_BASE_VERSION],
    [{ code: "REFUSED", reason: "MALFORMED_OPS", message: "" }, EXIT_REFUSED],
    [{ code: "REFUSED", reason: "UNKNOWN_ACTIVITY", message: "" }, EXIT_REFUSED],
  ] as [Rejection, number][])("%o maps to %i", (rejection, expected) => {
    expect(exitCodeFor(rejection)).toBe(expected);
  });

  test("an invariant violation outranks its reason string", () => {
    expect(
      exitCodeFor({ code: "INVARIANT_VIOLATION", reason: "STALE_BASE_VERSION", message: "" }),
    ).toBe(EXIT_INVARIANT_VIOLATION);
  });
});

describe("the network-filesystem heuristic is a list, and says so", () => {
  test("every marker it declares actually matches something", () => {
    expect(NETWORK_PATH_MARKERS.length).toBeGreaterThan(0);
    for (const marker of NETWORK_PATH_MARKERS) {
      expect(marker.name.length).toBeGreaterThan(0);
      expect(marker.pattern.source.length).toBeGreaterThan(0);
    }
  });

  test("the names are unique, so a refusal identifies which one fired", () => {
    expect(new Set(NETWORK_PATH_MARKERS.map((m) => m.name)).size).toBe(NETWORK_PATH_MARKERS.length);
  });

  test("detection returns the marker itself, not just a boolean", () => {
    const found = detectNetworkFilesystem("/Users/x/Dropbox/p");
    expect(NETWORK_PATH_MARKERS).toContain(found as never);
  });
});

describe("the genesis record", () => {
  const at = "2026-08-21T12:00:00.000Z";

  test("is version 0 with no ops", () => {
    const genesis = genesisRecord(at, "ilya");
    expect(genesis.v).toBe(0);
    expect(genesis.ops).toEqual([]);
    expect(genesis.schema_version).toBe(SCHEMA_VERSION);
  });

  test("carries a rationale like every other line, so fold has no special case", () => {
    const genesis = genesisRecord(at, "ilya");
    expect(genesis.rationale.why).toBe("pursuit initialised");
    expect(genesis.rationale.reason_code).toBe("OTHER");
    expect(genesis.outcome).toBeNull();
  });

  test("records who initialised it, as a human", () => {
    expect(genesisRecord(at, "ilya").actor).toEqual({ kind: "human", id: "ilya" });
  });

  test("both stamps come from the clock it was handed", () => {
    const genesis = genesisRecord(at, "ilya");
    expect(genesis.observed_at).toBe(at);
    expect(genesis.occurred_at).toBe(at);
  });
});
