/**
 * The assembled view, asserted against the pursuit the real binary wrote.
 *
 * Every number below is a fact about `fixtures/thursday.*` rather than a restatement of
 * `buildGraphView`: the readiness spread is what the store's own `isReady` says about those
 * fourteen nodes, the deadlines are arithmetic on timestamps in the log, and the time-travel
 * counts come from folding fewer lines of the same file. If a regen of the fixture changes the
 * story these are meant to fail loudly rather than follow it quietly.
 *
 * The tests build the view the way the app does — `buildPursuit` once on the file, then
 * `buildGraphView` on the clock — because the split is the thing that keeps a ticking
 * countdown from re-folding the whole log every second, and a test that composed the two
 * halves some other way would stop guarding the path that actually runs.
 *
 * The corners this file is here for: a node superseded WITHOUT a replacement (Priya's wait,
 * after her address bounced 550), a deadline anchored to a node that has not finished, two
 * deadlines already blown at `NOW`, a `sending` node that is neither finished nor available,
 * a `done` node that reads as replaced rather than as done — and the three shapes of log that
 * are not the happy one: torn in the tail, corrupt in the middle, and empty.
 */

import { describe, expect, test } from "bun:test";
import { isReady, isTerminal, readyFrontier, satisfiesBlockingEdge } from "@kona/core";
import { buildGraphView } from "../src/model/view.ts";
import { buildPursuit, completionTimeOf } from "../src/model/pursuit.ts";
import { waitStateOf } from "../src/model/waitState.ts";
import type { GraphView, Instant, NodeView, PursuitView, Readiness } from "../src/model/types.ts";
import { NOW, V, folded, headVersion, logText } from "./fixture.ts";

/** Head, folded once — the memoized half. */
const HEAD = buildPursuit(logText());

/** The clock-dependent half, built off the memoized one exactly as the app builds it. */
function viewOf(pursuit: PursuitView, now: Instant = NOW): GraphView {
  return buildGraphView(pursuit.graph, pursuit.completionTime, now);
}

function headView(): GraphView {
  return viewOf(HEAD);
}

function at(view: { byId: Map<string, NodeView> }, id: string): NodeView {
  const found = view.byId.get(id);
  if (found === undefined) throw new Error(`fixture has no node '${id}'`);
  return found;
}

const HOURS_48 = 48 * 3_600_000;

/**
 * One more committed record on the end of the real log.
 *
 * Hand-built graphs are banned in this suite for good reason, but a hand-built *record* is a
 * different animal: it goes through `MutationRecordSchema` and `applyOps` like every other
 * line, so a shape the schema would reject cannot sneak into a test. This is the only way to
 * pose a fact the nine-version fixture does not contain.
 */
function mutation(v: number, observedAt: string, ops: unknown[]): string {
  return `${JSON.stringify({
    v,
    schema_version: 1,
    observed_at: observedAt,
    occurred_at: observedAt,
    actor: { kind: "orchestrator", id: "orchestrator" },
    ops,
    rationale: {
      why: "appended by a test to pose a corner the fixture cannot",
      alternatives_rejected: [],
      reason_code: "OTHER",
    },
    outcome: null,
  })}\n`;
}

describe("the head view covers every node exactly once", () => {
  const view = headView();

  test("fourteen nodes, in the log's insertion order", () => {
    expect(view.nodes).toHaveLength(14);
    expect(view.version).toBe(V.patReserved);
    expect(view.nodes.map((entry) => entry.node.id)).toEqual([...folded().graph.nodes.keys()]);
  });

  test("byId and order agree with that same order", () => {
    expect(view.byId.size).toBe(14);
    for (const [index, entry] of view.nodes.entries()) {
      expect(view.byId.get(entry.node.id)).toBe(entry);
      expect(view.order.get(entry.node.id)).toBe(index);
    }
  });

  test("three scopes, and nothing falls through to ungrouped", () => {
    // Every node in this fixture was authored with a `scope`, so the "ungrouped" default is
    // not exercised here — what is asserted is that the real groups arrive intact.
    const groups = new Map(view.nodes.map((entry) => [entry.node.id, entry.group]));
    expect(new Set(groups.values())).toEqual(new Set(["setup", "goalies", "marcus"]));
    expect(groups.get("check-marcus-is-eligible")).toBe("marcus");
    expect(groups.get("goalie-confirmed")).toBe("setup");
  });
});

describe("readiness, as the store sees it", () => {
  const view = headView();

  test("the spread at head", () => {
    const spread = Object.fromEntries(
      view.nodes.map((entry) => [entry.node.id, entry.readiness]),
    );
    expect(spread).toEqual({
      // `done`, and superseded at v6 — replaced outranks finished, because the replacement is
      // the thing the reader has to follow.
      "confirm-roster-availability": "superseded",
      "escalate-no-goalie-found": "ready",
      "ask-dana-to-play-in-goal": "settled",
      "wait-for-dana": "settled",
      "ask-sam-to-play-in-goal": "settled",
      "wait-for-sam": "settled",
      "ask-priya-to-play-in-goal": "settled", // failed: terminal, and not a success
      "wait-for-priya": "settled", // dropped by a supersede that named no replacement
      "goalie-confirmed": "blocked",
      "check-marcus-is-eligible": "ready",
      "wait-for-eligibility-ruling": "blocked",
      "confirm-roster-availability-and-eligibility": "ready",
      "ask-pat-to-play-in-goal": "running", // `sending` is not terminal (§6.2)
      "wait-for-pat": "blocked",
    });
  });

  test("the frontier is core's, in insertion order", () => {
    expect(view.frontier).toEqual([
      "escalate-no-goalie-found",
      "check-marcus-is-eligible",
      "confirm-roster-availability-and-eligibility",
    ]);
    expect(view.frontier).toEqual(readyFrontier(folded().graph).map((node) => node.id));
  });

  test("`ready` in the view means `isReady` in the store, node for node", () => {
    // A3 in miniature: the two must not be able to disagree, because the CLI dispatches off
    // the second one and the canvas is claiming to show it.
    const graph = folded().graph;
    for (const entry of view.nodes) {
      expect(entry.readiness === "ready").toBe(isReady(graph, entry.node));
    }
  });

  test("only a blocked node carries a reason, and every blocked one does", () => {
    for (const entry of view.nodes) {
      expect(entry.blocked === null).toBe(entry.readiness !== "blocked");
    }
  });
});

describe("the reason a node is blocked, in words", () => {
  const view = headView();

  test("the quorum wait names all three unmet dependencies and not the two met ones", () => {
    const blocked = at(view, "goalie-confirmed").blocked;
    expect(blocked).not.toBeNull();
    expect(blocked?.summary).toBe("3 of 5 dependencies unmet");
    expect(blocked?.causes.map((cause) => [cause.from, cause.kind])).toEqual([
      // Dana and Sam both declined, and `declined` fires `satisfied` — those two edges are MET.
      ["wait-for-priya", "dropped"],
      ["wait-for-eligibility-ruling", "not-finished"],
      ["wait-for-pat", "not-finished"],
    ]);
  });

  test("a dropped source never satisfies readiness, and says so", () => {
    const cause = at(view, "goalie-confirmed").blocked?.causes[0];
    expect(cause?.wants).toBe("satisfied");
    expect(cause?.text).toBe("Wait for Priya was dropped and can never satisfy this");
  });

  test("one permanently dead in-edge makes the quorum unreachable, not merely stalled", () => {
    // The fixture's quiet catastrophe, and the reason `unreachable` is a field. `isReady`
    // asks for EVERY in-edge, so Priya's dropped wait has already ended this node — Marcus's
    // ruling and Pat's reply can both arrive and it still never reaches the frontier. Nothing
    // else on the canvas would say so: the node is `active`, two of its blockers are live,
    // and it looks exactly like a step that is waiting its turn.
    const graph = folded().graph;
    const goalie = at(view, "goalie-confirmed");
    const priya = at(view, "wait-for-priya").node;

    expect(isTerminal(priya.status.state)).toBe(true);
    expect(satisfiesBlockingEdge(priya)).toBe(false);
    expect(goalie.blocked?.causes.some((c) => c.from === "wait-for-priya")).toBe(true);
    expect(goalie.blocked?.unreachable).toBe(true);
    expect(isReady(graph, goalie.node)).toBe(false);
  });

  test("a wait behind a node that is still sending is blocked, not ready", () => {
    const blocked = at(view, "wait-for-pat").blocked;
    expect(blocked?.causes).toHaveLength(1);
    expect(blocked?.summary).toBe("Ask Pat to play in goal is still sending");
    expect(blocked?.unreachable).toBe(false);
  });
});

describe("waits carry their own clock", () => {
  const view = headView();

  test("a task has no wait state at all", () => {
    expect(at(view, "ask-dana-to-play-in-goal").wait).toBeNull();
    expect(at(view, "confirm-roster-availability").wait).toBeNull();
  });

  test("both absolute deadlines are already blown at NOW", () => {
    for (const id of ["goalie-confirmed", "wait-for-eligibility-ruling"]) {
      const wait = at(view, id).wait;
      expect(wait?.phase).toBe("blown");
      expect(wait?.remainingMs).toBeLessThan(0);
      expect(wait?.onTimeout).toBe("escalate-no-goalie-found");
    }
    expect(at(view, "goalie-confirmed").wait?.deadlineAt).toBe(
      Date.parse("2026-08-21T17:00:00.000Z"),
    );
  });

  test("a relative deadline is unarmed while its anchor is still in flight", () => {
    // `48h after ask-pat-to-play-in-goal`, and Pat's send is `sending` at head. There is no
    // instant to count down to yet, and inventing one would paint the node the wrong colour.
    const wait = at(view, "wait-for-pat").wait;
    expect(wait?.phase).toBe("unarmed");
    expect(wait?.deadlineAt).toBeNull();
    expect(wait?.remainingMs).toBeNull();
    expect(wait?.deadlineLabel).toBe("48h after ask-pat-to-play-in-goal");
    expect(wait?.unresolvedReason).toContain("still sending");
  });

  test("a relative deadline arms off the log, not off the graph", () => {
    // Dana's ask went `done` when `effect record` closed her slot, so the clock started at
    // THAT record's `observed_at` — a timestamp that exists nowhere in `kona graph --json`.
    // This is D1's reason for folding the log. Note it is the record, not the reserve one
    // version earlier: `sending` is not finished, and a wait behind it has not started.
    const sent = folded().records[V.danaSent];
    expect(sent?.v).toBe(V.danaSent);
    const wait = at(view, "wait-for-dana").wait;
    expect(wait?.deadlineAt).toBe(Date.parse(sent?.observed_at ?? "") + HOURS_48);
    // Answered, so the clock is moot: a wait that closed is resolved, never blown.
    expect(wait?.phase).toBe("resolved");
  });

  test("a wait dropped by a supersede reads as dropped, whatever it answered", () => {
    // The plan change superseded Priya's wait with no replacement, so `superseded_by` stays null and the
    // store dropped it instead. It also carries a `bounced` outcome — the drop is the fact
    // that decides what happens next, so it wins.
    const priya = at(view, "wait-for-priya");
    expect(priya.node.provenance.superseded_by).toBeNull();
    expect(priya.node.status.state).toBe("dropped");
    expect(priya.node.status.outcome?.verdict).toBe("bounced");
    expect(priya.readiness).toBe("settled");
    expect(priya.wait?.phase).toBe("dropped");
  });

  test("the quorum counter counts outcomes, not fired edges", () => {
    const predicate = at(view, "goalie-confirmed").wait?.predicate;
    // Dana and Sam both `declined`, which fires `satisfied` on their edges and counts for
    // nothing here: the whole point of the counter is to tell a refusal from a confirmation.
    expect(predicate?.have).toBe(0);
    expect(predicate?.need).toBe(1);
    expect(predicate?.op).toBe(">=");
    expect(predicate?.met).toBe(false);
    expect(predicate?.contributors).toEqual([]);
    // Marcus's ruling and Pat's reply are the two answers that could still arrive.
    expect(predicate?.live).toBe(2);
    expect(predicate?.label).toBe("confirmed · role=goalie");
  });
});

describe("irreversibility is read off the effect class", () => {
  test("exactly the four pivot sends are irreversible", () => {
    const view = headView();
    const marked = view.nodes.filter((entry) => entry.irreversible).map((entry) => entry.node.id);
    expect(marked).toEqual([
      "ask-dana-to-play-in-goal",
      "ask-sam-to-play-in-goal",
      "ask-priya-to-play-in-goal",
      "ask-pat-to-play-in-goal",
    ]);
    for (const entry of view.nodes) {
      expect(entry.irreversible).toBe(entry.node.spec.effect_class === "pivot");
    }
  });

  test("the two versions on a node answer different questions", () => {
    const view = headView();
    const roster = at(view, "confirm-roster-availability");
    expect(roster.createdAtVersion).toBe(1); // decided on when the pursuit opened
    expect(roster.observedAtVersion).toBe(1); // and read in the same version, before anyone
                                              // could be addressed from it (invariant 3(b))
  });
});

describe("completionTime — the moment a node actually finished", () => {
  test("a node has one exactly when it reached `done`", () => {
    // Terminal is not the same question: Priya's ask `failed` and her wait was `dropped`, and
    // neither of those started anybody's clock — the same rule `satisfiesBlockingEdge` applies.
    for (const entry of headView().nodes) {
      expect(HEAD.completionTime.has(entry.node.id)).toBe(entry.node.status.state === "done");
    }
    expect(HEAD.completionTime.has("ask-priya-to-play-in-goal")).toBe(false);
    expect(HEAD.completionTime.has("wait-for-priya")).toBe(false);
    expect(HEAD.completionTime.has("ask-pat-to-play-in-goal")).toBe(false);
  });

  test("the instant is the record's, at the version whose op said `done`", () => {
    const records = HEAD.records;
    // Each ask finished when the outbox RECORDED it, not when it reserved the slot — two
    // adjacent versions with different timestamps, and taking the wrong one would arm every
    // downstream deadline early.
    expect(HEAD.completionTime.get("ask-dana-to-play-in-goal")).toBe(
      Date.parse(records[V.danaSent]?.observed_at ?? ""),
    );
    expect(HEAD.completionTime.get("ask-sam-to-play-in-goal")).toBe(
      Date.parse(records[V.samSent]?.observed_at ?? ""),
    );
    expect(HEAD.completionTime.get("wait-for-sam")).toBe(
      Date.parse(records[V.samRefers]?.observed_at ?? ""),
    );
  });

  test("it is a function of the records folded, so time travel carries it", () => {
    const past = buildPursuit(logText(), V.danaDeclines - 1);
    expect(past.completionTime).toEqual(completionTimeOf(past.records));
    for (const node of past.graph.nodes.values()) {
      expect(past.completionTime.has(node.id)).toBe(node.status.state === "done");
    }
    // Dana's wait only closes when she declines, so one version earlier there is no instant
    // for it — and inventing one from head would be the scrubber quietly showing the reader a
    // fact from their future.
    expect(past.completionTime.has("wait-for-dana")).toBe(false);
    expect(HEAD.completionTime.has("wait-for-dana")).toBe(true);
  });

  test("a second `done` on the same node does not move its clock", () => {
    // `foldLog` does not enforce §6.4's invariant 1 — that is the commit path's job — so the
    // viewer can be handed a log the current binary would not have written: an older writer, a
    // hand-edit, a bad merge. First-wins is the only rule that cannot slide a deadline
    // forward, so it is the rule even for a log that should not exist.
    const first = "2026-08-22T01:00:00.000Z";
    const again = "2026-08-23T00:00:00.000Z";
    const pursuit = buildPursuit(
      logText() +
        mutation(V.patReserved + 1, first, [
          {
            op: "set_status",
            node: "ask-pat-to-play-in-goal",
            status: "done",
            evidence_ref: "msg:pat-outbound",
          },
        ]) +
        mutation(V.patReserved + 2, again, [
          {
            op: "set_status",
            node: "ask-pat-to-play-in-goal",
            status: "done",
            evidence_ref: "msg:pat-outbound-reobserved",
          },
        ]),
    );
    expect(pursuit.records).toHaveLength(V.patReserved + 3);
    expect(pursuit.completionTime.get("ask-pat-to-play-in-goal")).toBe(Date.parse(first));
    expect(completionTimeOf(pursuit.records)).toEqual(pursuit.completionTime);
  });

  test("a receipt arriving after the send does not move the send's clock", () => {
    // The whole reason this map exists instead of `versionTime.get(observed_at_version)`.
    // Pat's send finishes; the next version records the delivery receipt a day later, which §6.4 allows
    // against a terminal node and which bumps `observed_at_version` with it. Anchoring the
    // deadline there would push it 24h into the future and un-blow a wait the store has
    // already timed out — the one failure mode that silently keeps a dead branch alive.
    const sentAt = "2026-08-22T01:00:00.000Z";
    const receiptAt = "2026-08-23T00:00:00.000Z";
    const pursuit = buildPursuit(
      logText() +
        mutation(V.patReserved + 1, sentAt, [
          {
            op: "set_status",
            node: "ask-pat-to-play-in-goal",
            status: "done",
            evidence_ref: "msg:pat-outbound",
          },
        ]) +
        mutation(V.patReserved + 2, receiptAt, [
          // `late` is the verdict for a fact that arrived after the graph had moved on, which
          // is exactly what a delivery receipt is. §6.4 lets it land on a terminal node; being
          // non-resolving, it changes no projection — but it is still a touch, and a touch is
          // what bumps `observed_at_version`.
          {
            op: "record_outcome",
            node: "ask-pat-to-play-in-goal",
            verdict: "late",
            evidence_ref: "smtp:250-queued",
          },
        ]),
    );
    expect(pursuit.damaged).toEqual([]);
    expect(pursuit.graph.version).toBe(V.patReserved + 2);

    const view = viewOf(pursuit, Date.parse("2026-08-24T12:00:00.000Z"));
    const pat = at(view, "ask-pat-to-play-in-goal");
    // The receipt is the last thing we learned.
    expect(pat.observedAtVersion).toBe(V.patReserved + 2);
    expect(HEAD.completionTime.has("ask-pat-to-play-in-goal")).toBe(false);
    expect(pursuit.completionTime.get("ask-pat-to-play-in-goal")).toBe(Date.parse(sentAt));

    const wait = at(view, "wait-for-pat").wait;
    expect(wait?.deadlineAt).toBe(Date.parse(sentAt) + HOURS_48);
    expect(wait?.phase).toBe("blown");
    // Spelled out: the version-time answer is still in the future at that clock, which is
    // exactly how a blown wait would come back to life.
    expect((pursuit.versionTime.get(V.patReserved + 2) ?? Number.NaN) + HOURS_48).toBeGreaterThan(
      Date.parse("2026-08-24T12:00:00.000Z"),
    );
  });
});

describe("buildPursuit — the entry point", () => {
  test("head builds without throwing and surfaces a clean fold", () => {
    expect(viewOf(HEAD).nodes).toHaveLength(14);
    expect(HEAD.graph.version).toBe(V.patReserved);
    expect(HEAD.records).toHaveLength(V.patReserved + 1);
    expect(HEAD.timeline).toHaveLength(V.patReserved + 1);
    expect(HEAD.tornTail).toBe(false);
    expect(HEAD.damaged).toEqual([]);
    // One entry per record, and `{after}` deadlines are computed off the completion map.
    expect([...HEAD.versionTime.keys()]).toEqual(
      Array.from({ length: V.patReserved + 1 }, (_, index) => index),
    );
  });

  test("time travel to v2 is read-only: fewer lines folded, nothing written", () => {
    const before = logText();
    const past = buildPursuit(before, 2);

    expect(viewOf(past).nodes).toHaveLength(9);
    expect(past.graph.version).toBe(2);
    expect(past.records).toHaveLength(3);
    expect(past.timeline.map((entry) => entry.version)).toEqual([2, 1, 0]);

    // The file is untouched and head is still head — rule 6's scrubber is not undo.
    expect(logText()).toBe(before);
    expect(viewOf(buildPursuit(before)).nodes).toHaveLength(14);
  });

  test("the past is the past: the roster step had not been superseded at v2", () => {
    const view = viewOf(buildPursuit(logText(), 2));
    const roster = at(view, "confirm-roster-availability");
    expect(roster.readiness).toBe("settled");
    expect(roster.node.provenance.superseded_by).toBeNull();
    // Marcus does not exist yet; the referral that created him arrives at v5.
    expect(view.byId.has("check-marcus-is-eligible")).toBe(false);
  });

  test("v2's frontier is the three asks the fan-out just unblocked", () => {
    const view = viewOf(buildPursuit(logText(), 2));
    const spread = new Map<string, Readiness>(
      view.nodes.map((entry) => [entry.node.id, entry.readiness]),
    );
    expect(view.frontier).toEqual([
      "escalate-no-goalie-found",
      "ask-dana-to-play-in-goal",
      "ask-sam-to-play-in-goal",
      "ask-priya-to-play-in-goal",
    ]);
    expect(spread.get("goalie-confirmed")).toBe("blocked");
    expect(spread.get("wait-for-dana")).toBe("blocked");
  });

  test("a deadline anchored past the ceiling stays unarmed while travelling", () => {
    // Dana's ask only goes `done` at v3, so at v2 there is no clock — the same wait that is
    // `resolved` at head, seen honestly from the version the reader chose.
    const past = buildPursuit(logText(), 2);
    expect(past.completionTime.has("ask-dana-to-play-in-goal")).toBe(false);
    const wait = at(viewOf(past), "wait-for-dana").wait;
    expect(wait?.phase).toBe("unarmed");
    expect(wait?.deadlineAt).toBeNull();
    expect(wait?.unresolvedReason).toContain("still active");
  });
});

describe("a log that is not the happy one", () => {
  test("a torn final line is surfaced, and the graph behind it is whole", () => {
    // Append-then-fsync can damage nothing but the tail, so this is the expected shape of a
    // crash: head folded cleanly, the version after it never finished being written. The
    // banner exists so nobody reads a graph that is one mutation behind the file as if it
    // were head.
    const torn = `{"v":${V.patReserved + 1},"schema_version":1,"observ`;
    const pursuit = buildPursuit(`${logText()}\n${torn}`);
    expect(pursuit.tornTail).toBe(true);
    expect(pursuit.damaged).toEqual([]);
    expect(pursuit.graph.version).toBe(V.patReserved);
    expect(pursuit.records).toHaveLength(V.patReserved + 1);
    expect(viewOf(pursuit).nodes).toHaveLength(14);
  });

  test("a corrupt record mid-log leaves a stale graph that looks perfectly healthy", () => {
    // The worst state an operator can be in. Line 4 is v3, the dispatch batch, and truncating
    // it in the middle of the file is corruption rather than a torn tail — every version after
    // it is then discontinuous, so the fold stops at v2 and the picture is four versions
    // behind reality with nothing on the canvas to say so. `damaged` is the only signal.
    const lines = logText().split("\n");
    lines[3] = (lines[3] ?? "").slice(0, 40);
    const pursuit = buildPursuit(lines.join("\n"));

    expect(pursuit.tornTail).toBe(false);
    expect(pursuit.damaged[0]?.line).toBe(4);
    expect(pursuit.damaged[0]?.reason).toBe("UNPARSEABLE_RECORD");
    expect(pursuit.damaged.map((entry) => entry.reason)).toEqual([
      "UNPARSEABLE_RECORD",
      // v4 through head can no longer be applied: each one's `v` skips the version that died.
      ...Array<string>(headVersion() - 3).fill("VERSION_DISCONTINUITY"),
    ]);

    const view = viewOf(pursuit);
    expect(pursuit.graph.version).toBe(2);
    expect(view.version).toBe(2);
    expect(view.nodes).toHaveLength(9);
    expect(pursuit.timeline).toHaveLength(3);
  });

  test("an empty file is a pursuit with nothing in it, not an error", () => {
    const pursuit = buildPursuit("");
    expect(pursuit.records).toEqual([]);
    expect(pursuit.timeline).toEqual([]);
    expect(pursuit.versionTime.size).toBe(0);
    expect(pursuit.completionTime.size).toBe(0);
    expect(pursuit.tornTail).toBe(false);
    expect(pursuit.damaged).toEqual([]);

    const view = viewOf(pursuit);
    expect(view.version).toBe(0);
    expect(view.nodes).toEqual([]);
    expect(view.frontier).toEqual([]);
    expect(view.order.size).toBe(0);
  });

  test("genesis alone: a pursuit that exists and has done nothing yet", () => {
    // `kona init` writes exactly this, and it is the first thing the viewer will ever be
    // pointed at. An empty canvas with one timeline row is the correct rendering of it.
    const pursuit = buildPursuit(logText().split("\n")[0] ?? "");
    expect(pursuit.records).toHaveLength(1);
    expect(pursuit.timeline.map((entry) => entry.version)).toEqual([0]);
    expect(pursuit.timeline[0]?.ops).toEqual([]);
    expect(pursuit.timeline[0]?.diff).toBeNull(); // nothing to compare genesis against
    expect([...pursuit.versionTime.keys()]).toEqual([0]);
    expect(pursuit.completionTime.size).toBe(0);
    expect(pursuit.tornTail).toBe(false);
    expect(pursuit.damaged).toEqual([]);

    const view = viewOf(pursuit);
    expect(view.version).toBe(0);
    expect(view.nodes).toEqual([]);
    expect(view.frontier).toEqual([]);
  });
});

/**
 * Building the view at an earlier version — the pairing that has to come out of ONE fold.
 *
 * The UI that used to reach for this is gone: the timeline is read, not operated, and the
 * canvas shows head. The property survives it, because it is a property of the model. A
 * `PursuitView` carries a graph AND the two time indexes that graph must be read against, and
 * the bug these assertions exist for was pairing them from different folds — an earlier graph
 * read against HEAD's completion index, so `wait-for-dana` counted down from a clock that
 * `ask-dana-to-play-in-goal` does not start until v3. Typecheck, lint, knip and 589 tests all
 * passed with that in, because **nothing in this package tests a `.tsx` file**: there is no
 * jsdom, no testing-library, no component test, and `bun test --coverage` does not so much as
 * list the React tree. Judgment left in a component is judgment no mutant can reach, which is
 * why the composition lives in `model/` and why these are here.
 */
describe("buildPursuit at an earlier version", () => {
  const head = buildPursuit(logText());

  test("a version beyond head folds to head, not to an empty canvas", () => {
    expect(buildPursuit(logText(), head.graph.version + 5).graph.version).toBe(
      head.graph.version,
    );
  });

  test("an earlier version carries its OWN completion index, never head's", () => {
    // The bug, named. `ask-dana-to-play-in-goal` goes `done` at v3, so at v2 there is no clock
    // for `wait-for-dana` to count down — and reading head's index would invent one.
    const at2 = buildPursuit(logText(), 2);
    expect(at2.graph.version).toBe(2);
    expect(head.completionTime.has("ask-dana-to-play-in-goal")).toBe(true);
    expect(at2.completionTime.has("ask-dana-to-play-in-goal")).toBe(false);

    const wait = at2.graph.nodes.get("wait-for-dana");
    if (wait === undefined) throw new Error("the fixture has no wait-for-dana at v2");
    const state = waitStateOf(at2.graph, wait, at2.completionTime, NOW);
    expect(state?.phase).toBe("unarmed");
    expect(state?.deadlineAt).toBeNull();
    expect(state?.unresolvedReason).toContain("still active");
  });

  test("every version of the fixture builds without throwing, and folds to itself", () => {
    for (let v = 0; v <= head.graph.version; v++) {
      const built = buildPursuit(logText(), v);
      expect(built.graph.version).toBe(v);
      // The two indexes must come from the same fold: nothing in `completionTime` may name a
      // node the graph at that version does not have.
      for (const id of built.completionTime.keys())
        expect(built.graph.nodes.has(id)).toBe(true);
    }
  });
});
