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
import { foldLog, inEdges, isEdgeSatisfied, isTerminal, satisfiesBlockingEdge } from "@kona/core";
import { predicateCount } from "../src/model/predicate.ts";
import { completionTimeOf, versionTimeOf } from "../src/model/pursuit.ts";
import type { Instant, WaitState } from "../src/model/types.ts";
import { waitStateOf } from "../src/model/waitState.ts";
import { NOW, folded, logText } from "./fixture.ts";

const FOLD = folded();
const GRAPH = FOLD.graph;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

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

  /**
   * §6.2's duration grammar is `\d+[smhd]`, and this pursuit only ever says `48h`. Three of
   * the four units are therefore unexercised by the story itself, and a unit that returned
   * the wrong multiple would not look wrong: a `2d` wait scaled as hours paints itself blown
   * forty-six hours before its deadline, on a countdown that reads perfectly plausibly, and
   * `on_timeout` routes the pursuit to the escalation while the counterparty is still well
   * inside the window they were given. The multipliers here are the calendar's, not the
   * module's — a day is twenty-four of the hour the fixture already pins.
   */
  const DURATIONS: [text: string, span: number][] = [
    ["30s", 30 * SECOND],
    ["15m", 15 * MINUTE],
    ["6h", 6 * HOUR],
    ["2d", 2 * DAY],
    ["48h", 48 * HOUR],
  ];

  test.each(DURATIONS)("a %s deadline runs from the anchor's completion", (text, span) => {
    const graph = variant((g) => {
      const deadline = node("wait-for-dana", g).spec.deadline;
      if (deadline === undefined || !("after" in deadline)) throw new Error("shape changed");
      deadline.duration = text;
    });
    const state = wait("wait-for-dana", NOW, graph);
    expect(state.deadlineAt).toBe(succeededAt("ask-dana-to-play-in-goal") + span);
    expect(state.remainingMs).toBe((state.deadlineAt ?? 0) - NOW);
    expect(state.deadlineLabel).toBe(`${text} after ask-dana-to-play-in-goal`);
    expect(state.unresolvedReason).toBeNull();
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

  describe("{after, duration} whose anchor is not in the graph at all", () => {
    /**
     * The third way an anchored deadline can fail to arm, and the only one the eight versions
     * cannot show: the anchor is not a node yet. `add_node` takes a plain id and neither the
     * schema nor the fold refuses one the graph has not seen, so a forward reference is a
     * legal log — and rule 6's read-only time travel manufactures one out of any ordinary log
     * the moment the reader scrolls back to a version before the anchor landed.
     *
     * D5 is what is at stake: the honest answer is the reason in words, and anything that
     * throws here throws out of `waitStateOf` and takes the whole canvas down with it, at the
     * exact moment the reader is scrubbing back to ask what happened. The sibling reasons —
     * an unparseable duration, and an anchor that is present but unfinished — are the two
     * tests above; the reader is told which of the three it is, because what to do about it
     * differs: fix the spec, wait, or scroll forward.
     */
    const QUINN_WAIT = "wait-for-quinn";
    const QUINN_ASK = "ask-quinn-to-play-in-goal";

    const forwardRef =
      logText() +
      mutation(
        8,
        "2026-08-22T02:00:00.000Z",
        [
          {
            op: "add_node",
            id: QUINN_WAIT,
            label: "Wait for Quinn",
            type: "wait",
            spec: {
              instruction: "Wait for Quinn's reply about playing in goal.",
              effect_class: "pure",
              deadline: { after: QUINN_ASK, duration: "48h" },
              on_timeout: "escalate-no-goalie-found",
              match: { kind: "event", conditions: [{ kind: "reply", on: "satisfied" }] },
            },
          },
        ],
        "Quinn's wait goes in ahead of the ask it is anchored to.",
      ) +
      mutation(
        9,
        "2026-08-22T03:00:00.000Z",
        [
          {
            op: "add_node",
            id: QUINN_ASK,
            label: "Ask Quinn to play in goal",
            type: "task",
            spec: { instruction: "Ask Quinn to play in goal on Thursday.", effect_class: "pure" },
          },
        ],
        "And now the ask itself.",
      );

    const before = foldLog(forwardRef, { upToVersion: 8 });
    const after = foldLog(forwardRef);

    test("a forward reference is a log the store accepts, not a shape we invented", () => {
      expect(before.damaged).toEqual([]);
      expect(after.damaged).toEqual([]);
      expect(before.graph.nodes.has(QUINN_WAIT)).toBe(true);
      expect(before.graph.nodes.has(QUINN_ASK)).toBe(false);
      expect(after.graph.nodes.has(QUINN_ASK)).toBe(true);
    });

    test("the wait names the missing node instead of throwing", () => {
      const state = wait(QUINN_WAIT, NOW, before.graph, completionTimeOf(before.records));
      expect(state.phase).toBe("unarmed");
      expect(state.deadlineAt).toBeNull();
      expect(state.remainingMs).toBeNull();
      expect(state.unresolvedReason).toContain(QUINN_ASK);
      expect(state.unresolvedReason).toContain("not in the graph");
      // The spec still renders, so the reader can see what the wait was *meant* to run from.
      expect(state.deadlineLabel).toBe(`48h after ${QUINN_ASK}`);
    });

    test("one version on, the same wait gives the other reason", () => {
      // The anchor exists now and has not finished — a different fact about the same wait,
      // and a different thing for the reader to do about it.
      const state = wait(QUINN_WAIT, NOW, after.graph, completionTimeOf(after.records));
      expect(node(QUINN_ASK, after.graph).status.state).toBe("active");
      expect(state.phase).toBe("unarmed");
      expect(state.deadlineAt).toBeNull();
      expect(state.unresolvedReason).toContain("still active");
      expect(state.unresolvedReason).not.toContain("not in the graph");
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

    test("an {at} that is not a timestamp leaves the wait unarmed, never NaN", () => {
      // The schema wants ISO-8601 and gets it today, but `{at}` is a string on the wire and
      // the viewer folds whatever the file holds — an older build's stamp, or a line someone
      // edited during an incident. `Date.parse` answers NaN, and NaN is the worst possible
      // deadline: `now >= NaN` is false at every clock, so the wait would count down forever
      // as `awaiting` while its counterparty is long past due, and the very first render of
      // the chip would put `formatInstant(NaN)` on screen — a RangeError thrown out of the
      // canvas, which is precisely what D5 forbids. The reason belongs in words.
      const graph = variant((g) => {
        node("goalie-confirmed", g).spec.deadline = { at: "next Thursday" };
      });
      const state = wait("goalie-confirmed", NOW, graph);
      expect(state.phase).toBe("unarmed");
      expect(state.deadlineAt).toBeNull();
      expect(state.remainingMs).toBeNull();
      // The label repeats what the log said rather than a formatted date it cannot compute.
      expect(state.deadlineLabel).toBe("due next Thursday");
      expect(state.unresolvedReason).toContain("next Thursday");
      expect(state.unresolvedReason).toContain("not a parseable timestamp");
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

    test("a done wait with no answer yet is still resolved — it unblocks an unconditional edge", () => {
      // The tempting rule is "resolved needs an outcome too", and it is wrong in a way the
      // fixture cannot show: `isEdgeSatisfied` is true for an UNCONDITIONAL edge out of any
      // `done` source, so this wait really does put its successor on the frontier. Painting it
      // the not-fulfilled red while the node beneath it went ready is the same contradiction
      // as the one this describe block exists to prevent, pointing the other way.
      const graph = variant((g) => {
        node("wait-for-eligibility-ruling", g).status.state = "done";
        g.edges.push({ from: "wait-for-eligibility-ruling", to: "escalate-no-goalie-found" });
      });
      const closed = node("wait-for-eligibility-ruling", graph);
      expect(satisfiesBlockingEdge(closed)).toBe(true);
      expect(closed.status.outcome).toBeNull();
      expect(
        isEdgeSatisfied(graph, {
          from: "wait-for-eligibility-ruling",
          to: "escalate-no-goalie-found",
        }),
      ).toBe(true);
      expect(wait("wait-for-eligibility-ruling", NOW, graph).phase).toBe("resolved");
    });

    test("a terminal wait that ANSWERED but did not succeed is still failed", () => {
      // The one that pins `satisfiesBlockingEdge` on its own: an outcome is present, so a rule
      // that only asked "did anything answer" would paint this the success green. It bounced.
      const graph = variant((g) => {
        node("wait-for-priya", g).status.state = "failed";
      });
      const bounced = node("wait-for-priya", graph);
      expect(bounced.status.outcome?.verdict).toBe("bounced");
      expect(satisfiesBlockingEdge(bounced)).toBe(false);
      expect(wait("wait-for-priya", NOW, graph).phase).toBe("failed");
    });

    test("an OPEN wait that has already answered keeps counting down", () => {
      // `record_outcome` and `set_status` are separate ops (§6.4), so a batch can record a
      // verdict without closing the wait. Until the store closes it, it is open: the deadline
      // can still blow, `on_timeout` can still fire, and everything downstream is still
      // blocked. Reading the outcome as "resolved" would paint the success green on a wait the
      // CLI still considers running.
      const graph = variant((g) => {
        const ruling = node("wait-for-eligibility-ruling", g);
        const answer = { verdict: "accept" as const, evidence_ref: "<m-9@mail>", at_version: 9 };
        ruling.status.outcomes = [answer];
        ruling.status.outcome = answer;
      });
      const open = node("wait-for-eligibility-ruling", graph);
      expect(open.status.state).toBe("active");
      expect(satisfiesBlockingEdge(open)).toBe(false);
      const state = wait("wait-for-eligibility-ruling", NOW, graph);
      expect(state.phase).toBe("blown");
      expect(state.remainingMs).toBeLessThan(0);
    });

    test("a done wait with a resolving answer is resolved", () => {
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
  function answers(verdict: string, role?: string, graph: Graph = GRAPH): string[] {
    return inEdges(graph, "goalie-confirmed")
      .map((edge) => node(edge.from, graph))
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

  describe("an answer recorded without closing the wait is still an answer", () => {
    /**
     * §6.4 makes `record_outcome` and `set_status` separate ops, so a batch may record a
     * verdict and leave the wait open — the fixture's own v4 and v5 do both in one breath,
     * but nothing obliges a store to. §6.7 then makes the resolving outcome first-wins and
     * final: that source has answered, whether or not anyone has got round to closing it.
     *
     * So the outcome question has to be asked of every source, not only of the terminal ones.
     * Asking terminality first counts a source that has already spoken as one more answer
     * still to come, and `live` is the number rule 4 puts on the node under `0/1` — the
     * reader is told the quorum has two more chances at it when it has one, and leaves an
     * escalation unfired on the strength of it.
     */
    const answered = foldLog(
      logText() +
        mutation(
          8,
          "2026-08-22T02:00:00.000Z",
          [
            {
              op: "record_outcome",
              node: "wait-for-eligibility-ruling",
              verdict: "ignore",
              evidence_ref: "<m-301@mail>",
            },
          ],
          "Marcus's committee let the ruling lapse; nobody has closed the wait yet.",
        ),
    );

    /** In-edge sources of the quorum that have not yet given a resolving answer. */
    function unanswered(graph: Graph): string[] {
      return inEdges(graph, "goalie-confirmed")
        .map((edge) => node(edge.from, graph))
        .filter((source) => source.status.outcome === null)
        .map((source) => source.id);
    }

    test("the appended record is real, and it leaves the wait open", () => {
      expect(answered.damaged).toEqual([]);
      expect(answered.torn_tail).toBeNull();
      const ruling = node("wait-for-eligibility-ruling", answered.graph);
      expect(ruling.status.outcome?.verdict).toBe("ignore");
      expect(ruling.status.state).toBe("active");
      expect(isTerminal(ruling.status.state)).toBe(false);
    });

    test("live drops by one — an open source that answered cannot answer again", () => {
      expect(unanswered(GRAPH)).toEqual(["wait-for-eligibility-ruling", "wait-for-pat"]);
      expect(unanswered(answered.graph)).toEqual(["wait-for-pat"]);

      const before = predicateCount(GRAPH, node("goalie-confirmed"));
      const after = predicateCount(answered.graph, node("goalie-confirmed", answered.graph));
      expect(before?.live).toBe(unanswered(GRAPH).length);
      expect(after?.live).toBe(unanswered(answered.graph).length);
      expect(after?.live).toBe((before?.live ?? 0) - 1);
    });

    test("and `have` does not move — `ignore` is not the verdict the quorum counts", () => {
      const after = predicateCount(answered.graph, node("goalie-confirmed", answered.graph));
      expect(after?.have).toBe(answers("confirmed", "goalie", answered.graph).length);
      expect(after?.have).toBe(0);
      expect(after?.met).toBe(false);
    });
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

  test("a confirmation that carried no attrs at all is not a confirmation of this role", () => {
    // The absent-attrs case, which is not the wrong-value case above: nothing contradicts the
    // filter here, there is simply nothing to check it against. A counterparty who said yes
    // without saying to what has not answered the question the quorum asked, and counting
    // them renders `1/1 met` on `goalie-confirmed` — the roster locked, the escalation never
    // fired — on the strength of a reply that never mentioned the goal.
    const graph = variant((g) => {
      const outcome = node("wait-for-dana", g).status.outcome;
      if (outcome === null) throw new Error("dana has no outcome");
      outcome.verdict = "confirmed";
      delete outcome.attrs;
    });
    const dana = node("wait-for-dana", graph);
    expect(dana.status.outcome?.verdict).toBe("confirmed"); // the verdict alone would match
    expect(dana.status.outcome?.attrs).toBeUndefined();
    expect(satisfiesBlockingEdge(dana)).toBe(true); // and the source is otherwise countable

    const count = predicateCount(graph, node("goalie-confirmed", graph));
    expect(count?.have).toBe(answers("confirmed", "goalie", graph).length);
    expect(count?.have).toBe(0);
    expect(count?.contributors).toEqual([]);
    expect(count?.met).toBe(false);
  });

  test("attrs that answer a different question do not answer this one", () => {
    // Attrs are present and say something true — Dana was happy to — but never name a role.
    // Every key the filter asks for has to be THERE, not merely un-contradicted, or the
    // quorum counts an answer that never claimed the role it is counting.
    const graph = variant((g) => {
      const outcome = node("wait-for-dana", g).status.outcome;
      if (outcome === null) throw new Error("dana has no outcome");
      outcome.verdict = "confirmed";
      outcome.attrs = { reason: "happy to" };
    });
    expect(node("wait-for-dana", graph).status.outcome?.attrs?.["role"]).toBeUndefined();

    const count = predicateCount(graph, node("goalie-confirmed", graph));
    expect(count?.have).toBe(answers("confirmed", "goalie", graph).length);
    expect(count?.have).toBe(0);
    expect(count?.contributors).toEqual([]);
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

  test("a healthy predicate renders the quorum inline, never the fallback", () => {
    // Rule 4's line on the node: what would close this wait, in one phrase. The `??` behind
    // it says only `predicate: satisfied`, which is true of every predicate wait ever written
    // and tells the reader nothing about the threshold they are watching — it is the
    // malformed case below and nothing else. Only this line names the verdict, the role and
    // the number.
    const state = wait("goalie-confirmed");
    const count = state.predicate;
    if (count === null) throw new Error("goalie-confirmed carries no predicate count");
    expect(state.matchKind).toBe("predicate");
    expect(state.matchLabel).toBe("count confirmed role=goalie >= 1");
    // And it is the same quorum the counter beneath it parsed, said once. The chip reading
    // `0/1` and a line naming a different threshold would be the node disagreeing with itself.
    expect(state.matchLabel).toBe(
      ["count", ...count.label.split(" · "), count.op, count.need].join(" "),
    );
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
