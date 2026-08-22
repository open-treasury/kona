/**
 * Outcomes, resolutions and readiness — the three things §6.5's "states the contract must
 * name" turn on, and the semantics invariant 2 and branch resolution both read.
 */

import { describe, expect, test } from "bun:test";
import type { AuthoredOp, EdgeCondition, Graph, Verdict } from "../src/index.ts";
import {
  DECISION_VERDICTS,
  NON_RESOLVING_VERDICTS,
  REPLY_VERDICTS,
  VERDICTS,
  isEdgeSatisfied,
  isReady,
  isResolvingVerdict,
  readyFrontier,
  resolutionOf,
  resolvingOutcome,
} from "../src/index.ts";
import { commit, seeded, task, wait } from "./fixtures.ts";

function outcome(node: string, verdict: Verdict, evidence: string): AuthoredOp {
  return { op: "record_outcome", node, verdict, evidence_ref: evidence };
}

function nodeOf(graph: Graph, id: string) {
  const node = graph.nodes.get(id);
  if (node === undefined) throw new Error(`no node ${id}`);
  return node;
}

describe("outcomes are append-only (§6.7)", () => {
  test("a second outcome appends rather than replacing", () => {
    const graph = commit(
      commit(seeded([task("A")]), [outcome("a", "confirmed", "<m-1>")]),
      [outcome("a", "late", "<m-2>")],
    );
    expect(nodeOf(graph, "a").status.outcomes.map((o) => o.verdict)).toEqual([
      "confirmed",
      "late",
    ]);
  });

  test("a late reply NEVER replaces the verdict the graph acted on", () => {
    // §6.5: recorded, and it never reopens the wait. Under overwrite semantics the
    // evidence for an email already sent would vanish behind a straggler.
    const graph = commit(
      commit(seeded([task("A")]), [outcome("a", "confirmed", "<m-1>")]),
      [outcome("a", "declined", "<m-2>"), outcome("a", "late", "<m-3>")],
    );
    const resolved = nodeOf(graph, "a").status.outcome;
    expect(resolved?.verdict).toBe("confirmed");
    expect(resolved?.evidence_ref).toBe("<m-1>");
    expect(nodeOf(graph, "a").status.outcomes).toHaveLength(3);
  });

  test("a tentative reply records without resolving", () => {
    const graph = commit(seeded([task("A")]), [outcome("a", "tentative", "<m-1>")]);
    expect(nodeOf(graph, "a").status.outcomes).toHaveLength(1);
    expect(nodeOf(graph, "a").status.outcome).toBeNull();
  });

  test("and a later firm reply is what resolves it", () => {
    const graph = commit(
      commit(seeded([task("A")]), [outcome("a", "tentative", "<m-1>")]),
      [outcome("a", "confirmed", "<m-2>")],
    );
    expect(nodeOf(graph, "a").status.outcome?.evidence_ref).toBe("<m-2>");
  });

  test("each entry records the version that wrote it", () => {
    const graph = commit(
      commit(seeded([task("A")]), [outcome("a", "tentative", "<m-1>")]),
      [outcome("a", "confirmed", "<m-2>")],
    );
    expect(nodeOf(graph, "a").status.outcomes.map((o) => o.at_version)).toEqual([2, 3]);
  });

  test("resolvingOutcome is null for an empty or wholly non-resolving history", () => {
    expect(resolvingOutcome([])).toBeNull();
    expect(
      resolvingOutcome([
        { verdict: "tentative", evidence_ref: "a", at_version: 1 },
        { verdict: "late", evidence_ref: "b", at_version: 2 },
      ]),
    ).toBeNull();
  });

  test("exactly two verdicts are non-resolving, and they are the two §6.5 names", () => {
    expect(VERDICTS.filter((v) => !isResolvingVerdict(v)).toSorted()).toEqual(
      [...NON_RESOLVING_VERDICTS].toSorted(),
    );
  });

  test("the vocabulary is the two families and nothing else", () => {
    expect(VERDICTS).toEqual([...REPLY_VERDICTS, ...DECISION_VERDICTS]);
    expect(new Set(VERDICTS).size).toBe(VERDICTS.length);
  });
});

describe("the resolution is derived, never stored (§6.2)", () => {
  function resolutionAfter(verdict: Verdict) {
    return resolutionOf(nodeOf(commit(seeded([task("A")]), [outcome("a", verdict, "e")]), "a"));
  }

  test.each([...DECISION_VERDICTS])("a human decision '%s' is its own condition", (verdict) => {
    expect(resolutionAfter(verdict)).toBe(verdict);
  });

  test.each([
    ["timed_out", "timeout"],
    ["bounced", "bounced"],
    ["confirmed", "satisfied"],
    ["declined", "satisfied"],
  ] as [Verdict, EdgeCondition][])("'%s' resolves as '%s'", (verdict, expected) => {
    expect(resolutionAfter(verdict)).toBe(expected);
  });

  test("declined resolves as satisfied — somebody DID answer", () => {
    // What they said is the verdict, and that is what a predicate counts. Conflating the
    // two would make a refusal indistinguishable from silence.
    expect(resolutionAfter("declined")).toBe("satisfied");
    expect(resolutionAfter("confirmed")).toBe("satisfied");
  });

  test("an unresolved node has no resolution", () => {
    expect(resolutionOf(nodeOf(seeded([task("A")]), "a"))).toBeNull();
    expect(resolutionAfter("tentative")).toBeNull();
    expect(resolutionAfter("late")).toBeNull();
  });

  test("every resolving verdict projects onto some edge condition", () => {
    for (const verdict of VERDICTS.filter(isResolvingVerdict)) {
      expect(resolutionAfter(verdict)).not.toBeNull();
    }
  });
});

/** a -> b, plus an unconnected c. */
function chain(): Graph {
  return commit(seeded([task("A"), task("B"), task("C")]), [
    { op: "add_edge", from: "a", to: "b" },
  ]);
}

describe("readiness fails safe (§6.4)", () => {
  test("a node with no blocking in-edges is ready", () => {
    expect(isReady(chain(), nodeOf(chain(), "c"))).toBe(true);
  });

  test("a node whose blocker is still active is not", () => {
    expect(isReady(chain(), nodeOf(chain(), "b"))).toBe(false);
  });

  test("only a terminal SUCCESS unblocks it", () => {
    for (const [state, ready] of [
      ["done", true],
      ["failed", false],
      ["dropped", false],
      ["in_flight", false],
      ["active", false],
    ] as [string, boolean][]) {
      const graph = commit(chain(), [
        { op: "set_status", node: "a", status: state, evidence_ref: "e" } as AuthoredOp,
      ]);
      expect(isEdgeSatisfied(graph, { from: "a", to: "b" })).toBe(ready);
      expect(isReady(graph, nodeOf(graph, "b"))).toBe(ready);
    }
  });

  test("a DROPPED source never satisfies readiness, even though merge excludes it", () => {
    // Otherwise the second node on an untaken branch has no blocker, lands on the
    // frontier, and gets dispatched — pivot send included.
    const graph = commit(chain(), [
      { op: "set_status", node: "a", status: "dropped", evidence_ref: "e" },
    ]);
    expect(isReady(graph, nodeOf(graph, "b"))).toBe(false);
    expect(readyFrontier(graph).map((n) => n.id)).not.toContain("b");
  });

  test("a dropped or superseded node is never itself ready", () => {
    const dropped = commit(chain(), [
      { op: "set_status", node: "c", status: "dropped", evidence_ref: "e" },
    ]);
    expect(isReady(dropped, nodeOf(dropped, "c"))).toBe(false);

    const superseded = commit(chain(), [task("C prime"), { op: "supersede_node", node: "c", by: "$0" }]);
    expect(isReady(superseded, nodeOf(superseded, "c"))).toBe(false);
  });

  test("an edge pointing at a node that does not exist is never satisfied", () => {
    expect(isEdgeSatisfied(chain(), { from: "ghost", to: "b" })).toBe(false);
  });
});

describe("conditional edges fire only on their own resolution", () => {
  function branched(verdict: Verdict): Graph {
    const base = commit(seeded([task("Accepted"), task("Ignored"), wait("Gate", { on_timeout: "$0" })]), [
      { op: "add_edge", from: "gate", to: "accepted", condition: { on: "accept" } },
      { op: "add_edge", from: "gate", to: "ignored", condition: { on: "ignore" } },
    ]);
    return commit(base, [
      outcome("gate", verdict, "<m-1>"),
      { op: "set_status", node: "gate", status: "done", evidence_ref: "<m-1>" },
    ]);
  }

  test("an accepted gate opens only the accept arm", () => {
    const graph = branched("accept");
    expect(readyFrontier(graph).map((n) => n.id)).toEqual(["accepted"]);
  });

  test("an ignored gate opens only the ignore arm", () => {
    const graph = branched("ignore");
    expect(readyFrontier(graph).map((n) => n.id)).toEqual(["ignored"]);
  });

  test("a resolution matching neither opens nothing — a pivot never fires unapproved", () => {
    const graph = branched("edit");
    expect(readyFrontier(graph).map((n) => n.id)).toEqual([]);
  });

  test("the frontier comes back in insertion order, so the viewer is stable", () => {
    expect(readyFrontier(seeded([task("A"), task("B"), task("C")])).map((n) => n.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});
