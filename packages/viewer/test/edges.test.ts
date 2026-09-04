/**
 * What the canvas draws a line for.
 *
 * The property that matters most is the one a reader noticed before any test did: an activity the
 * pursuit is genuinely wired to must not look stranded. Two relations carry that and neither
 * lives in `graph.edges` — `spec.on_timeout` and `provenance.superseded_by` — so the assertions
 * below are about them, and about the thing they must NOT do: change readiness.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Graph } from "@kona/core";
import { foldLog, isReady, readyFrontier } from "@kona/core";
import { flowTerminals, viewEdges } from "../src/model/edges.ts";
import { guardValue } from "../src/model/guard.ts";
import { folded, headVersion } from "./fixture.ts";

const FOLD = folded();
const GRAPH = FOLD.graph;

function kinds(graph: Graph = GRAPH) {
  return viewEdges(graph).reduce<Record<string, number>>((counts, edge) => {
    counts[edge.kind] = (counts[edge.kind] ?? 0) + 1;
    return counts;
  }, {});
}

describe("viewEdges", () => {
  test("every dependency is drawn, in append order, and nothing is invented", () => {
    const requires = viewEdges(GRAPH).filter((e) => e.kind === "requires");
    expect(requires).toHaveLength(GRAPH.edges.length);
    expect(requires.map((e) => `${e.from}>${e.to}`)).toEqual(
      GRAPH.edges.map((e) => `${e.from}>${e.to}`),
    );
  });

  test("a supersede chain is drawn link by link", () => {
    const superseded = [...GRAPH.nodes.values()].filter(
      (node) => node.provenance.superseded_by !== null && node.provenance.superseded_by !== node.id,
    );
    expect(superseded.length).toBeGreaterThan(0);
    const links = viewEdges(GRAPH).filter((e) => e.kind === "supersedes");
    expect(links).toHaveLength(superseded.length);
    for (const activity of superseded) {
      expect(
        links.some((e) => e.from === activity.id && e.to === activity.provenance.superseded_by),
      ).toBe(true);
    }
  });

  test("drawing these does NOT change readiness — the whole point of the split", () => {
    // `viewEdges` never touches `Graph`, so this is a guard against someone later deciding it
    // would be tidier to push the timeout arcs into `graph.edges`. That would make every wait
    // a blocker of the escalation, and the escalation would leave the frontier.
    const before = readyFrontier(GRAPH).map((n) => n.id);
    viewEdges(GRAPH);
    expect(readyFrontier(GRAPH).map((n) => n.id)).toEqual(before);
    const escalation = GRAPH.nodes.get("th-vipt");
    if (escalation === undefined) throw new Error("the fixture has no escalation activity");
    expect(isReady(GRAPH, escalation)).toBe(true);
  });

  test("ids are unique, so React and the tween cannot lose an edge", () => {
    const ids = viewEdges(GRAPH).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("only dependencies carry satisfaction; lineage never gates anything", () => {
    for (const edge of viewEdges(GRAPH)) {
      if (edge.kind === "requires") continue;
      expect(edge.satisfied).toBe(false);
      expect(edge.dead).toBe(false);
      expect(edge.guard).toBeNull();
    }
  });

  test("time travel draws fewer lines, and never one to an activity that is not there", () => {
    for (let v = 0; v <= headVersion(); v++) {
      const graph = folded(v).graph;
      for (const edge of viewEdges(graph)) {
        expect(graph.nodes.has(edge.from)).toBe(true);
        expect(graph.nodes.has(edge.to)).toBe(true);
      }
    }
  });

  test("the fixture's edge kinds are all present", () => {
    expect(kinds()).toMatchObject({
      requires: expect.any(Number),
      supersedes: expect.any(Number),
    });
  });
});

/**
 * Labels — the one thing on a line that is words rather than paint.
 *
 * A condition is only worth printing when the source can fire something ELSE. Measured on the
 * poker pursuit before this rule: 17 labels drawn, **16 of them the word `satisfied`**, and 5
 * of those 16 on grey lines — `satisfied` is a condition and green is a state, so a line that
 * said `satisfied` while not being satisfied contradicted itself in two words.
 */
describe("viewEdges — labels", () => {
  const edges = viewEdges(GRAPH);
  const requires = edges.filter((edge) => edge.kind === "requires");

  /** Rebuilt from the graph, so these are an independent check of the rule, not a restatement. */
  const conditionsBySource = new Map<string, Set<string | null>>();
  for (const edge of GRAPH.edges) {
    const set = conditionsBySource.get(edge.from) ?? new Set<string | null>();
    set.add(guardValue(edge));
    conditionsBySource.set(edge.from, set);
  }
  const forks = (from: string): boolean => (conditionsBySource.get(from)?.size ?? 0) >= 2;

  test("only a dependency is ever labelled", () => {
    for (const edge of edges) {
      if (edge.kind !== "requires") expect(edge.label).toBeNull();
    }
  });

  test("an unconditional edge is never labelled", () => {
    for (const edge of requires) {
      if (edge.guard === null) expect(edge.label).toBeNull();
    }
  });

  test("`satisfied` alone is the default outcome and says nothing", () => {
    // 16 of the fixture's 17 labels used to be this word, five of them on grey lines.
    const plain = requires.filter((edge) => edge.guard === "satisfied" && !forks(edge.from));
    expect(plain.length).toBeGreaterThan(0);
    for (const edge of plain) expect(edge.label).toBeNull();
  });

  test("a condition that is not the default IS labelled, even as an only child", () => {
    // The rule this replaced keyed on sibling count and dropped exactly the label worth having:
    // `ruling-on-inviting-a-stranger` has ONE out-edge, conditioned `accept`, and everything
    // downstream happens only if a person says yes.
    const forked = requires.filter((edge) => edge.guard !== null && edge.guard !== "satisfied");
    expect(forked.length).toBeGreaterThan(0);
    for (const edge of forked) expect(edge.label).toBe(`on ${edge.guard}`);
  });

  test("on a forking source even the default is worth printing", () => {
    for (const edge of requires) {
      if (edge.guard !== null && forks(edge.from)) {
        expect(edge.label).toBe(`on ${edge.guard}`);
      }
    }
  });

  test("the label reads as a condition, not as a state", () => {
    for (const edge of requires) {
      if (edge.label !== null) expect(edge.label.startsWith("on ")).toBe(true);
    }
  });

  test("the fixture keeps the fork and drops the noise", () => {
    const labelled = requires.filter((edge) => edge.label !== null);
    expect(labelled.length).toBeGreaterThan(0);
    expect(labelled.length).toBeLessThan(requires.length);
    // The bare word is gone; what survives says what it is.
    expect(labelled.map((edge) => edge.label)).not.toContain("satisfied");
  });
});

describe("flowTerminals", () => {
  test("a start has nothing before it", () => {
    const { starts } = flowTerminals(GRAPH);
    expect(starts.size).toBeGreaterThan(0);
    for (const id of starts) {
      expect(GRAPH.edges.some((e) => e.to === id)).toBe(false);
    }
  });

  test("a superseded activity is neither — it was replaced, not reached", () => {
    const { starts, ends } = flowTerminals(GRAPH);
    const retired = [...GRAPH.nodes.values()].filter((n) => n.provenance.superseded_by !== null);
    expect(retired.length).toBeGreaterThan(0);
    for (const activity of retired) {
      expect(starts.has(activity.id)).toBe(false);
      expect(ends.has(activity.id)).toBe(false);
    }
  });

  test("the supersede chain does not count as flow", () => {
    // The REPLACEMENT has a supersede arc pointing at it and no dependency in-edge, so
    // counting lineage as flow would stop it being a start.
    const replacement = [...GRAPH.nodes.values()].find(
      (n) => n.provenance.supersedes !== null && n.provenance.superseded_by === null,
    );
    if (replacement === undefined) throw new Error("the fixture lost its supersede chain");
    expect(GRAPH.edges.some((e) => e.to === replacement.id)).toBe(false);
    expect(flowTerminals(GRAPH).starts.has(replacement.id)).toBe(true);
  });

  test("every version has at least one start — a pursuit has to begin somewhere", () => {
    for (let v = 1; v <= headVersion(); v++) {
      expect(flowTerminals(folded(v).graph).starts.size).toBeGreaterThan(0);
    }
  });
});

describe("synthetic terminals stand down for a graph that has its own", () => {
  test("an activity-model pursuit gets none — its initial and final nodes ARE the notation", () => {
    // Drawn beside the real thing they put two filled discs at the left edge and two rings at
    // the right, which reads as two pursuits rather than as one drawn twice. Caught on screen,
    // not in a test: nothing here renders, so nothing here could have seen it.
    const v2 = foldLog(
      readFileSync(
        join(import.meta.dir, "..", "..", "..", "fixtures", "goalie.mutations.jsonl"),
        "utf8",
      ),
    ).graph;
    const hasInitial = [...v2.nodes.values()].some((node) => node.type === "initial");
    expect(hasInitial).toBe(true);

    const terminals = flowTerminals(v2);
    expect([...terminals.starts]).toEqual([]);
    expect([...terminals.ends]).toEqual([]);
  });

  test("and a v1-shaped pursuit still gets them, because it has no terminators of its own", () => {
    const v1 = folded().graph;
    expect([...v1.nodes.values()].some((node) => node.type === "initial")).toBe(false);
    expect(flowTerminals(v1).starts.size).toBeGreaterThan(0);
  });
});
