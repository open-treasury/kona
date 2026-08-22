/**
 * Waits and the quorum counter, against the pursuit the real binary wrote.
 *
 * The assertions are deliberately grounded in fixture values rather than in constants copied
 * out of the implementation: the `{after, duration}` deadline is checked against the anchor's
 * own mutation record, and `live` against the states of the in-edge sources. A test that
 * restated the code would pass just as happily with the code wrong.
 *
 * The completion index every deadline is anchored to is the one `pursuit.ts` builds, not a
 * copy of it. Rebuilding it here would let the two drift, and the drift is exactly the bug:
 * anchoring a `{after}` deadline to the wrong version of the wrong node is invisible at head
 * on this fixture and only shows up once a receipt lands after the send.
 */

import { describe, expect, test } from "bun:test";
import type { Graph, Node } from "@kona/core";
import { foldLog, inEdges, isTerminal, satisfiesBlockingEdge } from "@kona/core";
import { predicateCount } from "../src/model/predicate.ts";
import { completionTimeOf, versionTimeOf } from "../src/model/pursuit.ts";
import type { Instant, WaitState } from "../src/model/types.ts";
import { waitStateOf } from "../src/model/waitState.ts";
import { NOW, folded, logText } from "./fixture.ts";

const FOLD = folded();
const GRAPH = FOLD.graph;
const HOUR = 3_600_000;

/** Node id → the moment it succeeded, exactly as `PursuitView.completionTime` carries it. */
const DONE: ReadonlyMap<string, Instant> = completionTimeOf(FOLD.records);

/** Version → the moment the store observed it, for the assertions that talk about versions. */
const TIMES: ReadonlyMap<number, Instant> = versionTimeOf(FOLD.records);

function node(id: string, graph: Graph = GRAPH): Node {
  const found = graph.nodes.get(id);
  if (found === undefined) throw new Error(`the fixture has no node '${id}'`);
  return found;
}

function wait(
  id: string,
  now: Instant = NOW,
  graph: Graph = GRAPH,
  completion: ReadonlyMap<string, Instant> = DONE,
): WaitState {
  const state = waitStateOf(graph, node(id, graph), completion, now);
  if (state === null) throw new Error(`'${id}' is not a wait`);
  return state;
}

function observedAt(version: number): Instant {
  const at = TIMES.get(version);
  if (at === undefined) throw new Error(`no record at version ${version}`);
  return at;
}

function succeededAt(id: string): Instant {
  const at = DONE.get(id);
  if (at === undefined) throw new Error(`'${id}' never succeeded in the fixture`);
  return at;
}

/** A deep copy of the fixture graph, so a corner the fixture cannot show can be posed. */
function variant(edit: (graph: Graph) => void): Graph {
  const clone = structuredClone(GRAPH);
  edit(clone);
  return clone;
}

function firstCondition(graph: Graph, id: string): { predicate?: unknown } {
  const condition = node(id, graph).spec.match?.conditions[0];
  if (condition === undefined) throw new Error(`'${id}' has no match conditions`);
  return condition;
}

/**
 * One more committed record on the end of the real log.
 *
 * A hand-built *graph* is banned in this suite, but a hand-built record is a different
 * animal: it goes through `MutationRecordSchema` and `applyOps` like every other line, so a
 * shape the schema would reject cannot sneak in — the fold reports it as damaged and the
 * test fails. It is the only way to pose a fact the eight-version fixture does not contain.
 */
function mutation(v: number, observedAt_: string, ops: unknown[], why: string): string {
  return `${JSON.stringify({
    v,
    schema_version: 1,
    observed_at: observedAt_,
    occurred_at: observedAt_,
    actor: { kind: "orchestrator", id: "orchestrator" },
    ops,
    rationale: { why, alternatives_rejected: [], reason_code: "OTHER" },
    outcome: null,
  })}\n`;
}

describe("waitStateOf", () => {
  test("a task has no wait state at all", () => {
    expect(waitStateOf(GRAPH, node("ask-dana-to-play-in-goal"), DONE, NOW)).toBeNull();
    expect(waitStateOf(GRAPH, node("escalate-no-goalie-found"), DONE, NOW)).toBeNull();
  });

  test("the fixture exercises all three match kinds", () => {
    const kinds = [...GRAPH.nodes.values()]
      .filter((n) => n.type === "wait")
      .map((n) => wait(n.id).matchKind);
    expect(new Set(kinds)).toEqual(new Set(["event", "human", "predicate"]));
  });

  test("every wait names where a blown deadline routes", () => {
    for (const n of [...GRAPH.nodes.values()].filter((it) => it.type === "wait")) {
      expect(wait(n.id).onTimeout).toBe("escalate-no-goalie-found");
    }
  });

  describe("{after, duration} — wait-for-dana", () => {
    const anchor = node("ask-dana-to-play-in-goal");
    const state = wait("wait-for-dana");

    test("the clock starts at the anchor's completion, read from the log", () => {
      expect(anchor.status.state).toBe("done");
      // v3 is where Dana's ask went `done`, and at head nothing has touched it since, so the
      // completion index and `observed_at_version` still agree. The test below is what pins
      // which of the two the deadline actually reads.
      expect(succeededAt(anchor.id)).toBe(observedAt(anchor.status.observed_at_version));
      expect(state.deadlineAt).toBe(succeededAt(anchor.id) + 48 * HOUR);
      expect(state.remainingMs).toBe((state.deadlineAt ?? 0) - NOW);
      expect(state.unresolvedReason).toBeNull();
    });

    test("the chip renders the spec, not the computed date", () => {
      expect(state.deadlineLabel).toBe("48h after ask-dana-to-play-in-goal");
    });

    test("an answered wait is resolved even though its clock never ran out", () => {
      // Dana declined at v4, well inside 48h. `declined` still closes the wait (§6.5).
      expect(node("wait-for-dana").status.outcome?.verdict).toBe("declined");
      expect(state.phase).toBe("resolved");
      expect(state.remainingMs).toBeGreaterThan(0);
    });

    test("the event match reads off its conditions", () => {
      expect(state.matchKind).toBe("event");
      expect(state.matchLabel).toBe("reply, or deadline");
      expect(state.predicate).toBeNull();
    });
  });

  describe("the clock is anchored to the completion, never to the last touch", () => {
    // D1. §6.4 makes `record_output` legal against a terminal node, so the version that last
    // TOUCHED the anchor keeps moving after it finished: a delivery receipt, or a §6.5 `late`
    // reply. Anchoring to `observed_at_version` would slide the deadline forward with it and
    // hand the reader a blown wait repainted as one that is quietly counting down.
    const SENT_AT = "2026-09-01T00:00:00.000Z";
    const RECEIPT_AT = "2026-09-03T06:00:00.000Z";
    /** After the true deadline (SENT_AT + 48h) and before the one the receipt would give. */
    const LOOKING_AT = Date.parse("2026-09-04T00:00:00.000Z");

    const extended = foldLog(
      logText() +
        mutation(
          8,
          SENT_AT,
          [
            {
              op: "set_status",
              node: "ask-pat-to-play-in-goal",
              status: "done",
              evidence_ref: "<sent-pat@mail>",
            },
          ],
          "Pat's mail went out.",
        ) +
        mutation(
          9,
          RECEIPT_AT,
          [
            {
              op: "record_output",
              node: "ask-pat-to-play-in-goal",
              output_name: "sent_message_id",
              value: "<sent-pat@mail>",
              evidence_ref: "<dsn-delivered@mail>",
            },
          ],
          "The delivery receipt came back two days after the send.",
        ),
    );

    test("the appended records are real records, not a shape the schema would reject", () => {
      expect(extended.damaged).toEqual([]);
      expect(extended.torn_tail).toBeNull();
      expect(extended.graph.version).toBe(9);
    });

    test("a receipt landing on a finished node does not move the deadline", () => {
      const anchor = node("ask-pat-to-play-in-goal", extended.graph);
      expect(anchor.status.state).toBe("done");
      // The receipt is the last version to touch it — this is the field that must NOT be read.
      expect(anchor.status.observed_at_version).toBe(9);

      const completion = completionTimeOf(extended.records);
      expect(completion.get(anchor.id)).toBe(Date.parse(SENT_AT));

      const state = wait("wait-for-pat", LOOKING_AT, extended.graph, completion);
      expect(state.deadlineAt).toBe(Date.parse(SENT_AT) + 48 * HOUR);
      expect(state.phase).toBe("blown");

      // What the discarded rule would have said: two days later, and still counting down.
      const lastTouch = versionTimeOf(extended.records).get(anchor.status.observed_at_version);
      expect(lastTouch).toBe(Date.parse(RECEIPT_AT));
      expect(state.deadlineAt).not.toBe((lastTouch ?? 0) + 48 * HOUR);
      expect((lastTouch ?? 0) + 48 * HOUR).toBeGreaterThan(LOOKING_AT);
    });
  });

  describe("{after, duration} with an unfinished anchor — wait-for-pat", () => {
    const state = wait("wait-for-pat");

    test("no clock yet, and the reason says which node we are waiting on", () => {
      expect(node("ask-pat-to-play-in-goal").status.state).toBe("sending");
      expect(state.phase).toBe("unarmed");
      expect(state.deadlineAt).toBeNull();
      expect(state.remainingMs).toBeNull();
      expect(state.unresolvedReason).toContain("ask-pat-to-play-in-goal");
      expect(state.unresolvedReason).toContain("sending");
      expect(state.deadlineLabel).toBe("48h after ask-pat-to-play-in-goal");
    });

    test("an unparseable duration is reported, never guessed", () => {
      const graph = variant((g) => {
        const deadline = node("wait-for-pat", g).spec.deadline;
        if (deadline === undefined || !("after" in deadline)) throw new Error("shape changed");
        deadline.duration = "48x";
      });
      const broken = wait("wait-for-pat", NOW, graph);
      expect(broken.phase).toBe("unarmed");
      expect(broken.deadlineAt).toBeNull();
      expect(broken.unresolvedReason).toContain("48x");
    });

    test("an anchor absent from the completion index leaves the wait unarmed", () => {
      // A `done` anchor whose completion the folded log does not carry: read-only time travel
      // to a version before it finished. Borrowing any other instant would count 48 hours
      // from a moment nobody recorded.
      const graph = variant((g) => {
        node("ask-pat-to-play-in-goal", g).status.state = "done";
      });
      const finished = new Map([["ask-pat-to-play-in-goal", observedAt(7)]]);
      expect(wait("wait-for-pat", NOW, graph, finished).deadlineAt).toBe(
        observedAt(7) + 48 * HOUR,
      );

      const stranded = wait("wait-for-pat", NOW, graph, new Map());
      expect(stranded.phase).toBe("unarmed");
      expect(stranded.deadlineAt).toBeNull();
      expect(stranded.unresolvedReason).toContain("no completion time");
    });
  });

  test("a failed anchor starts no clock at all", () => {
    // D2. Priya's address bounced 550, so `ask-priya-to-play-in-goal` is terminal but never
    // succeeded — the same test `satisfiesBlockingEdge` applies to a blocking edge. A send
    // that never went out cannot start a 48-hour clock on the reply to it.
    const anchor = node("ask-priya-to-play-in-goal");
    expect(anchor.status.state).toBe("failed");
    expect(isTerminal(anchor.status.state)).toBe(true);
    expect(satisfiesBlockingEdge(anchor)).toBe(false);
    expect(DONE.has(anchor.id)).toBe(false);

    const state = wait("wait-for-priya");
    expect(state.deadlineLabel).toBe("48h after ask-priya-to-play-in-goal");
    expect(state.deadlineAt).toBeNull();
    expect(state.remainingMs).toBeNull();
    expect(state.unresolvedReason).toContain("never succeeded");
    // Had it armed, the wait would have been counting against a deadline off the version that
    // recorded the bounce — which is a live clock on a branch nobody is on.
    expect(observedAt(anchor.status.observed_at_version)).toBeGreaterThan(0);
  });

  describe("{at} — the two waits already blown at NOW", () => {
    test("goalie-confirmed", () => {
      const deadline = node("goalie-confirmed").spec.deadline;
      if (deadline === undefined || !("at" in deadline)) throw new Error("shape changed");
      const state = wait("goalie-confirmed");
      expect(state.deadlineAt).toBe(Date.parse(deadline.at));
      expect(state.phase).toBe("blown");
      expect(state.remainingMs).toBeLessThan(0);
      expect(state.deadlineLabel).toBe("due 2026-08-21 17:00Z");
      expect(state.unresolvedReason).toBeNull();
    });

    test("wait-for-eligibility-ruling, and its human match", () => {
      const state = wait("wait-for-eligibility-ruling");
      expect(state.phase).toBe("blown");
      expect(state.deadlineLabel).toBe("due 2026-08-21 12:00Z");
      expect(state.matchKind).toBe("human");
      expect(state.matchLabel).toBe("human decision: accept | ignore");
      expect(state.predicate).toBeNull();
    });

    test("the phase follows the clock the caller passes, and blows on the instant", () => {
      const at = wait("goalie-confirmed").deadlineAt ?? 0;
      expect(wait("goalie-confirmed", at - 1).phase).toBe("awaiting");
      expect(wait("goalie-confirmed", at - 1).remainingMs).toBe(1);
      expect(wait("goalie-confirmed", at).phase).toBe("blown");
    });
  });

  describe("terminal is not one colour", () => {
    // D3. Rule 8's first colour is *fulfilled*, and three different terminal states would all
    // have collapsed into it. Only the one that actually unblocks the graph earns it.
    test("a dropped wait reads as dropped, not as resolved by its bounce", () => {
      // wait-for-priya carries a resolving `bounced` outcome AND was dropped at v7. §6.4 makes
      // the drop the fact that matters: this branch cannot satisfy anything downstream.
      const priya = node("wait-for-priya");
      expect(priya.status.state).toBe("dropped");
      expect(priya.status.outcome?.verdict).toBe("bounced");
      expect(wait("wait-for-priya").phase).toBe("dropped");
    });

    test("a failed wait reads as failed, never as resolved", () => {
      const graph = variant((g) => {
        node("wait-for-eligibility-ruling", g).status.state = "failed";
      });
      const state = wait("wait-for-eligibility-ruling", NOW, graph);
      expect(isTerminal(node("wait-for-eligibility-ruling", graph).status.state)).toBe(true);
      expect(satisfiesBlockingEdge(node("wait-for-eligibility-ruling", graph))).toBe(false);
      expect(state.phase).toBe("failed");
      // The deadline had already blown, and a terminal node is still not counting down.
      expect(state.remainingMs).toBeLessThan(0);
    });

    test("a done wait that closed without an answer is failed, not resolved", () => {
      // `done` satisfies a blocking edge, but with no resolving outcome it fires no condition
      // and answers nothing — the success green would contradict the card next to it.
      const graph = variant((g) => {
        node("wait-for-eligibility-ruling", g).status.state = "done";
      });
      const closed = node("wait-for-eligibility-ruling", graph);
      expect(satisfiesBlockingEdge(closed)).toBe(true);
      expect(closed.status.outcome).toBeNull();
      expect(wait("wait-for-eligibility-ruling", NOW, graph).phase).toBe("failed");
    });

    test("a done wait with a resolving answer is the only one that is resolved", () => {
      const dana = node("wait-for-dana");
      expect(satisfiesBlockingEdge(dana)).toBe(true);
      expect(dana.status.outcome).not.toBeNull();
      expect(wait("wait-for-dana").phase).toBe("resolved");
    });
  });

  test("an expr deadline counts down to its backstop and says why", () => {
    const graph = variant((g) => {
      node("goalie-confirmed", g).spec.deadline = {
        expr: "roster_lock - 24h",
        backstop: "2026-08-21T12:00:00.000Z",
        after_unknown: true,
      };
    });
    const state = wait("goalie-confirmed", NOW, graph);
    expect(state.deadlineAt).toBe(Date.parse("2026-08-21T12:00:00.000Z"));
    expect(state.deadlineLabel).toBe("backstop 2026-08-21 12:00Z (expr)");
    expect(state.unresolvedReason).toContain("roster_lock - 24h");
    expect(state.phase).toBe("blown");
  });
});

describe("predicateCount", () => {
  /**
   * The sources whose answer the quorum can actually count: an in-edge source that finished
   * successfully and carries this verdict, optionally in this role. Derived from the graph
   * rather than listed, so a regenerated fixture moves these numbers instead of stranding them.
   */
  function answers(verdict: string, role?: string): string[] {
    return inEdges(GRAPH, "goalie-confirmed")
      .map((edge) => node(edge.from))
      .filter((source) => {
        if (!satisfiesBlockingEdge(source)) return false;
        const outcome = source.status.outcome;
        if (outcome === null || outcome.verdict !== verdict) return false;
        return role === undefined || outcome.attrs?.["role"] === role;
      })
      .map((source) => source.id);
  }

  test("null unless the wait matches on a predicate", () => {
    expect(predicateCount(GRAPH, node("wait-for-dana"))).toBeNull();
    expect(predicateCount(GRAPH, node("wait-for-eligibility-ruling"))).toBeNull();
    expect(predicateCount(GRAPH, node("ask-dana-to-play-in-goal"))).toBeNull();
  });

  test("goalie-confirmed needs one confirmation and has none", () => {
    const sources = inEdges(GRAPH, "goalie-confirmed").map((edge) => edge.from);
    expect(sources).toEqual([
      "wait-for-dana",
      "wait-for-sam",
      "wait-for-priya",
      "wait-for-eligibility-ruling",
      "wait-for-pat",
    ]);
    // Dana and Sam answered, and both declined; Priya bounced and was dropped.
    expect(node("wait-for-dana").status.outcome?.verdict).toBe("declined");
    expect(node("wait-for-sam").status.outcome?.verdict).toBe("declined");

    const count = predicateCount(GRAPH, node("goalie-confirmed"));
    expect(count).not.toBeNull();
    expect(count?.have).toBe(answers("confirmed", "goalie").length);
    expect(count?.have).toBe(0);
    expect(count?.need).toBe(1);
    expect(count?.op).toBe(">=");
    expect(count?.met).toBe(false);
    expect(count?.contributors).toEqual([]);
    expect(count?.label).toBe("confirmed · role=goalie");
  });

  test("live is exactly the sources that could still answer", () => {
    const sources = inEdges(GRAPH, "goalie-confirmed").map((edge) => node(edge.from));
    // Dana and Sam have given their resolving answer, and §6.7 makes it first-wins and final.
    // Priya bounced and was dropped. Marcus's ruling and Pat's reply are the two outstanding.
    expect(sources.filter((s) => s.status.outcome !== null).map((s) => s.id)).toEqual([
      "wait-for-dana",
      "wait-for-sam",
      "wait-for-priya",
    ]);
    expect(sources.filter((s) => s.status.outcome === null).map((s) => s.id)).toEqual([
      "wait-for-eligibility-ruling",
      "wait-for-pat",
    ]);
    expect(predicateCount(GRAPH, node("goalie-confirmed"))?.live).toBe(2);
  });

  test("a terminal source with no resolving outcome yet is still live", () => {
    // D5. §6.4 makes `record_outcome` legal against a terminal node, so a `done` source that
    // has not answered can still answer. `blocked.ts` reasons the same way about the same
    // node — its `wrong-resolution` cause with a null `fired` is the one it refuses to call
    // permanent — and the two must not contradict each other on one edge.
    const graph = variant((g) => {
      node("wait-for-eligibility-ruling", g).status.state = "done";
    });
    const ruling = node("wait-for-eligibility-ruling", graph);
    expect(isTerminal(ruling.status.state)).toBe(true);
    expect(satisfiesBlockingEdge(ruling)).toBe(true);
    expect(ruling.status.outcome).toBeNull();

    const count = predicateCount(graph, node("goalie-confirmed", graph));
    expect(count?.live).toBe(2);
    expect(count?.have).toBe(0);
  });

  test("a source that finished without succeeding is not live", () => {
    // The other half of D5: `failed` and `dropped` are over, and no op can reopen them.
    const graph = variant((g) => {
      node("wait-for-pat", g).status.state = "failed";
    });
    expect(satisfiesBlockingEdge(node("wait-for-pat", graph))).toBe(false);
    expect(predicateCount(graph, node("goalie-confirmed", graph))?.live).toBe(1);
  });

  test("a matching verdict with matching attrs contributes and meets the quorum", () => {
    const graph = variant((g) => {
      const outcome = node("wait-for-dana", g).status.outcome;
      if (outcome === null) throw new Error("dana has no outcome");
      outcome.verdict = "confirmed";
    });
    const count = predicateCount(graph, node("goalie-confirmed", graph));
    expect(count?.have).toBe(1);
    expect(count?.contributors).toEqual(["wait-for-dana"]);
    expect(count?.met).toBe(true);
    expect(count?.live).toBe(2);
  });

  test("the attrs filter rejects a confirmation for the wrong role", () => {
    const graph = variant((g) => {
      const outcome = node("wait-for-dana", g).status.outcome;
      if (outcome === null) throw new Error("dana has no outcome");
      outcome.verdict = "confirmed";
      outcome.attrs = { role: "striker" };
    });
    const count = predicateCount(graph, node("goalie-confirmed", graph));
    expect(count?.have).toBe(0);
    expect(count?.met).toBe(false);
  });

  test("a predicate with no attrs filter counts every source that gave that verdict", () => {
    // The empty filter matches everything, including an outcome that named a role nobody
    // asked about — the opposite of the absent-attrs case, which matches nothing.
    const graph = variant((g) => {
      firstCondition(g, "goalie-confirmed").predicate = {
        count: { verdict: "declined" },
        op: "==",
        n: 2,
      };
    });
    const count = predicateCount(graph, node("goalie-confirmed", graph));
    expect(count?.have).toBe(answers("declined").length);
    expect(count?.have).toBe(2);
    expect(count?.contributors).toEqual(["wait-for-dana", "wait-for-sam"]);
    expect(count?.met).toBe(true);
    expect(count?.label).toBe("declined");
  });

  test("a dropped source's answer does not count toward the quorum", () => {
    // D4. §6.4: a dropped source never satisfies readiness. Counting the verdict it gave
    // before the store abandoned the branch would render `1/1 met` next to a blocked reason
    // saying that same source can never satisfy anything.
    const graph = variant((g) => {
      const outcome = node("wait-for-priya", g).status.outcome;
      if (outcome === null) throw new Error("priya has no outcome");
      outcome.verdict = "confirmed";
    });
    const priya = node("wait-for-priya", graph);
    expect(priya.status.state).toBe("dropped");
    expect(priya.status.outcome?.attrs?.["role"]).toBe("goalie"); // the filter would match
    expect(satisfiesBlockingEdge(priya)).toBe(false);

    const count = predicateCount(graph, node("goalie-confirmed", graph));
    expect(count?.have).toBe(0);
    expect(count?.contributors).toEqual([]);
    expect(count?.met).toBe(false);
  });

  test("a failed source's answer does not count either", () => {
    const graph = variant((g) => {
      const sam = node("wait-for-sam", g);
      sam.status.state = "failed";
      if (sam.status.outcome === null) throw new Error("sam has no outcome");
      sam.status.outcome.verdict = "confirmed";
    });
    const count = predicateCount(graph, node("goalie-confirmed", graph));
    expect(count?.have).toBe(0);
    expect(count?.met).toBe(false);
  });

  /**
   * Every operator §6.2 names, against two counts this fixture actually produces: nobody has
   * confirmed as a goalie (0), and Dana and Sam both declined as goalies (2). Two counts are
   * needed rather than one — at a single count `>=` and `==` answer identically, and the
   * table would pass with the two bodies swapped.
   */
  const COMPARISONS: [verdict: string, op: string, n: number, met: boolean][] = [
    ["confirmed", ">=", 0, true],
    ["confirmed", ">=", 1, false],
    ["confirmed", ">", 0, false],
    ["confirmed", ">", 1, false],
    ["confirmed", "==", 0, true],
    ["confirmed", "==", 1, false],
    ["confirmed", "<=", 0, true],
    ["confirmed", "<=", 1, true],
    ["confirmed", "<", 0, false],
    ["confirmed", "<", 1, true],
    ["declined", ">=", 1, true],
    ["declined", ">", 2, false],
    ["declined", "==", 1, false],
    ["declined", "<=", 2, true],
    ["declined", "<", 2, false],
  ];

  test.each(COMPARISONS)("count %s role=goalie %s %s is %s", (verdict, op, n, met) => {
    const graph = variant((g) => {
      firstCondition(g, "goalie-confirmed").predicate = {
        count: { verdict, attrs: { role: "goalie" } },
        op,
        n,
      };
    });
    const count = predicateCount(graph, node("goalie-confirmed", graph));
    expect(count?.have).toBe(answers(verdict, "goalie").length);
    expect(count?.need).toBe(n);
    expect(count?.op).toBe(op);
    expect(count?.met).toBe(met);
  });

  test("an operator we do not implement is unmet and says so", () => {
    const graph = variant((g) => {
      firstCondition(g, "goalie-confirmed").predicate = {
        count: { verdict: "declined", attrs: { role: "goalie" } },
        op: "~=",
        n: 1,
      };
    });
    const count = predicateCount(graph, node("goalie-confirmed", graph));
    expect(count?.have).toBe(2); // Dana and Sam both declined as goalies.
    expect(count?.op).toBe("~=");
    expect(count?.met).toBe(false);
    expect(count?.label).toContain("~=");
  });

  test.each([
    ["not an object", 42],
    ["no count block", { op: ">=", n: 1 }],
    ["no verdict", { count: { attrs: {} }, op: ">=", n: 1 }],
    ["no threshold", { count: { verdict: "confirmed" }, op: ">=" }],
    ["null", null],
  ])("a malformed predicate (%s) names the problem instead of throwing", (_name, block) => {
    const graph = variant((g) => {
      firstCondition(g, "goalie-confirmed").predicate = block;
    });
    const count = predicateCount(graph, node("goalie-confirmed", graph));
    expect(count).not.toBeNull();
    expect(count?.need).toBe(0);
    expect(count?.have).toBe(0);
    expect(count?.met).toBe(false);
    expect(count?.label).toContain("unreadable predicate");
    // The population is still knowable even when the question is not.
    expect(count?.live).toBe(2);
  });

  test("a malformed predicate leaves the wait renderable", () => {
    const graph = variant((g) => {
      firstCondition(g, "goalie-confirmed").predicate = { op: ">=", n: 1 };
    });
    const state = wait("goalie-confirmed", NOW, graph);
    expect(state.matchKind).toBe("predicate");
    expect(state.matchLabel).toBe("predicate: satisfied");
    expect(state.predicate?.label).toContain("unreadable predicate");
    expect(state.phase).toBe("blown");
  });
});
