/**
 * What the canvas draws a line for.
 *
 * The property that matters most is the one a reader noticed before any test did: an activity the
 * pursuit is genuinely wired to must not look stranded. Two relations carry that and neither
 * lives in `graph.edges` — `spec.on_timeout` and `provenance.superseded_by` — so the assertions
 * below are about them, and about the thing they must NOT do: change readiness.
 */

import { describe, expect, test } from "bun:test";
import type { Graph } from "@kona/core";
import { isReady, readyFrontier } from "@kona/core";
import { flowTerminals, viewEdges } from "../src/model/edges.ts";
import { folded, headVersion } from "./fixture.ts";

const FOLD = folded();
const GRAPH = FOLD.graph;

function kinds(graph: Graph = GRAPH) {
  return viewEdges(graph).reduce<Record<string, number>>((counts, edge) => {
    counts[edge.kind] = (counts[edge.kind] ?? 0) + 1;
    return counts;
  }, {});
}

function variant(edit: (graph: Graph) => void): Graph {
  const clone = structuredClone(GRAPH);
  edit(clone);
  return clone;
}

describe("viewEdges", () => {
  test("every dependency is drawn, in append order, and nothing is invented", () => {
    const requires = viewEdges(GRAPH).filter((e) => e.kind === "requires");
    expect(requires).toHaveLength(GRAPH.edges.length);
    expect(requires.map((e) => `${e.from}>${e.to}`)).toEqual(
      GRAPH.edges.map((e) => `${e.from}>${e.to}`),
    );
  });

  test("every wait's on_timeout is drawn — §6.4 requires one on every wait", () => {
    const waits = [...GRAPH.activities.values()].filter((n) => n.type === "wait");
    expect(waits.length).toBeGreaterThan(0);
    const timeouts = viewEdges(GRAPH).filter((e) => e.kind === "timeout");
    // Every wait in the fixture routes somewhere real, so the counts must agree exactly. A
    // wait whose target were missing would be skipped, and that is asserted separately below.
    expect(timeouts).toHaveLength(waits.length);
    for (const wait of waits) {
      expect(timeouts.some((e) => e.from === wait.id && e.to === wait.spec.on_timeout)).toBe(true);
    }
  });

  test("the escalation is reachable on the canvas, not stranded", () => {
    // The bug this file exists for: `th-vipt` has no in-edge and no out-edge
    // in `graph.edges`, and was drawn floating while every wait in the pursuit pointed at it.
    const escalation = "th-vipt";
    expect(GRAPH.edges.some((e) => e.from === escalation || e.to === escalation)).toBe(false);
    expect(viewEdges(GRAPH).some((e) => e.to === escalation)).toBe(true);
  });

  test("a supersede chain is drawn link by link", () => {
    const superseded = [...GRAPH.activities.values()].filter(
      (n) => n.provenance.superseded_by !== null,
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
    const escalation = GRAPH.activities.get("th-vipt");
    if (escalation === undefined) throw new Error("the fixture has no escalation activity");
    expect(isReady(GRAPH, escalation)).toBe(true);
  });

  test("ids are unique, so React and the tween cannot lose an edge", () => {
    const ids = viewEdges(GRAPH).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a timeout target that is not in the graph is skipped, not minted", () => {
    // `add_activity` permits a forward reference, and time travel to a version before the target
    // landed produces exactly this. Minting it would hand dagre a zero-size phantom.
    const graph = variant((g) => {
      const wait = g.activities.get("th-es9m");
      if (wait === undefined) throw new Error("no th-es9m");
      wait.spec.on_timeout = "a-activity-added-later";
    });
    const arcs = viewEdges(graph).filter((e) => e.kind === "timeout");
    expect(arcs.some((e) => e.from === "th-es9m")).toBe(false);
    expect(arcs.every((e) => graph.activities.has(e.to))).toBe(true);
  });

  test("a wait whose timeout is itself is not drawn as a self-loop", () => {
    const graph = variant((g) => {
      const wait = g.activities.get("th-es9m");
      if (wait === undefined) throw new Error("no th-es9m");
      wait.spec.on_timeout = "th-es9m";
    });
    expect(viewEdges(graph).some((e) => e.from === e.to)).toBe(false);
  });

  test("only a dependency carries satisfaction; the other two never gate anything", () => {
    for (const edge of viewEdges(GRAPH)) {
      if (edge.kind === "requires") continue;
      expect(edge.satisfied).toBe(false);
      expect(edge.dead).toBe(false);
      expect(edge.condition).toBeNull();
    }
  });

  test("time travel draws fewer lines, and never one to an activity that is not there", () => {
    for (let v = 0; v <= headVersion(); v++) {
      const graph = folded(v).graph;
      for (const edge of viewEdges(graph)) {
        expect(graph.activities.has(edge.from)).toBe(true);
        expect(graph.activities.has(edge.to)).toBe(true);
      }
    }
  });

  test("the fixture's three kinds are all present", () => {
    expect(kinds()).toMatchObject({
      requires: expect.any(Number),
      timeout: expect.any(Number),
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
    set.add(edge.condition?.on ?? null);
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
      if (edge.condition === null) expect(edge.label).toBeNull();
    }
  });

  test("`satisfied` alone is the default outcome and says nothing", () => {
    // 16 of the fixture's 17 labels used to be this word, five of them on grey lines.
    const plain = requires.filter((edge) => edge.condition === "satisfied" && !forks(edge.from));
    expect(plain.length).toBeGreaterThan(0);
    for (const edge of plain) expect(edge.label).toBeNull();
  });

  test("a condition that is not the default IS labelled, even as an only child", () => {
    // The rule this replaced keyed on sibling count and dropped exactly the label worth having:
    // `ruling-on-inviting-a-stranger` has ONE out-edge, conditioned `accept`, and everything
    // downstream happens only if a person says yes.
    const forked = requires.filter(
      (edge) => edge.condition !== null && edge.condition !== "satisfied",
    );
    expect(forked.length).toBeGreaterThan(0);
    for (const edge of forked) expect(edge.label).toBe(`on ${edge.condition}`);
  });

  test("on a forking source even the default is worth printing", () => {
    for (const edge of requires) {
      if (edge.condition !== null && forks(edge.from)) {
        expect(edge.label).toBe(`on ${edge.condition}`);
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

  test("the escalation is an END, not a start — the timeout arcs are what make it one", () => {
    // Without counting timeout routes as flow it has no in-edge at all and would read as the
    // place the pursuit begins, which is the exact opposite of what it is.
    const { starts, ends } = flowTerminals(GRAPH);
    expect(GRAPH.edges.some((e) => e.to === "th-vipt")).toBe(false);
    expect(starts.has("th-vipt")).toBe(false);
    expect(ends.has("th-vipt")).toBe(true);
  });

  test("no wait is ever an end — §6.4 gives every one of them somewhere to go", () => {
    const { ends } = flowTerminals(GRAPH);
    for (const activity of GRAPH.activities.values()) {
      if (activity.type !== "wait") continue;
      if (activity.provenance.superseded_by !== null) continue;
      expect(ends.has(activity.id)).toBe(false);
    }
  });

  test("a superseded activity is neither — it was replaced, not reached", () => {
    const { starts, ends } = flowTerminals(GRAPH);
    const retired = [...GRAPH.activities.values()].filter((n) => n.provenance.superseded_by !== null);
    expect(retired.length).toBeGreaterThan(0);
    for (const activity of retired) {
      expect(starts.has(activity.id)).toBe(false);
      expect(ends.has(activity.id)).toBe(false);
    }
  });

  test("the supersede chain does not count as flow", () => {
    // The REPLACEMENT has a supersede arc pointing at it and no dependency in-edge, so
    // counting lineage as flow would stop it being a start.
    const replacement = [...GRAPH.activities.values()].find(
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
