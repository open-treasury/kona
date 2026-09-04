/**
 * The assembled view, asserted against the migrated historical pursuit the real binary folds.
 *
 * Every number below is a fact about `fixtures/thursday.*` rather than a restatement of
 * `buildGraphView`: the readiness spread is the §6.2.1 state the store RECORDED for each of
 * those fourteen activities, the deadlines are arithmetic on timestamps in the log, and the
 * time-travel counts come from folding fewer lines of the same file. If a regen of the fixture changes the
 * story these are meant to fail loudly rather than follow it quietly.
 *
 * The tests build the view the way the app does — `buildPursuit` once on the file, then
 * `buildGraphView` on the clock — because the split is the thing that keeps a ticking
 * countdown from re-folding the whole log every second, and a test that composed the two
 * halves some other way would stop guarding the path that actually runs.
 *
 * The corners this file is here for: an activity superseded WITHOUT a replacement (Priya's wait,
 * after her address bounced 550), a deadline anchored to an activity that has not finished, two
 * deadlines already blown at `NOW`, an `active` activity that is neither finished nor available,
 * a `completed` activity that reads as replaced rather than as completed — and the three shapes of log that
 * are not the happy one: torn in the tail, corrupt in the middle, and empty.
 */

import { describe, expect, test } from "bun:test";
import { isReady, isTerminal, readyFrontier, satisfiesBlockingEdge } from "@kona/core";
import { buildGraphView } from "../src/model/view.ts";
import { buildPursuit, completionTimeOf } from "../src/model/pursuit.ts";
import { waitStateOf } from "../src/model/waitState.ts";
import type {
  GraphView,
  Instant,
  ActivityView,
  PursuitView,
  Standing,
} from "../src/model/types.ts";
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

function at(view: { byId: Map<string, ActivityView> }, id: string): ActivityView {
  const found = view.byId.get(id);
  if (found === undefined) throw new Error(`fixture has no activity '${id}'`);
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

describe("the head view covers every activity exactly once", () => {
  const view = headView();

  test("fourteen activities, in the log's insertion order", () => {
    expect(view.nodes).toHaveLength(14);
    expect(view.version).toBe(V.patReserved);
    expect(view.nodes.map((entry) => entry.activity.id)).toEqual([...folded().graph.nodes.keys()]);
  });

  test("byId and order agree with that same order", () => {
    expect(view.byId.size).toBe(14);
    for (const [index, entry] of view.nodes.entries()) {
      expect(view.byId.get(entry.activity.id)).toBe(entry);
      expect(view.order.get(entry.activity.id)).toBe(index);
    }
  });

  test("nodes without a provenance group fall through to ungrouped", () => {
    const groups = new Map(view.nodes.map((entry) => [entry.activity.id, entry.group]));
    expect(new Set(groups.values())).toEqual(new Set(["ungrouped"]));
  });
});

describe("readiness, as the store sees it", () => {
  const view = headView();

  test("the spread at head", () => {
    const spread = Object.fromEntries(
      view.nodes.map((entry) => [entry.activity.id, entry.readiness]),
    );
    expect(spread).toEqual({
      // `completed`, and superseded — replaced outranks finished, because the replacement is
      // the thing the reader has to follow. The one entry here that is not `status.state`.
      "th-ahf6": "superseded",
      "th-vipt": "ready",
      "th-nhwd": "completed",
      "th-es9m": "completed",
      "th-gyre": "completed",
      "th-ocwr": "completed",
      "th-t2yo": "failed", // terminal, and not a success — it satisfies no edge
      "th-1ppl": "withdrawn", // retired without a replacement
      "th-ymld": "inactive",
      "th-etsk": "ready",
      "th-9xi1": "inactive",
      "th-five": "ready",
      "th-gk0l": "active", // claimed, and `active` is deliberately not terminal (§6.2.1)
      "th-0s7c": "inactive",
    });
  });

  test("the frontier is core's, in insertion order", () => {
    expect(view.frontier).toEqual(["th-vipt", "th-etsk", "th-five"]);
    expect(view.frontier).toEqual(readyFrontier(folded().graph).map((activity) => activity.id));
  });

  test("`ready` in the view means `isReady` in the store, activity for activity", () => {
    // A3 in miniature: the two must not be able to disagree, because the CLI dispatches off
    // the second one and the canvas is claiming to show it.
    const graph = folded().graph;
    for (const entry of view.nodes) {
      expect(entry.readiness === "ready").toBe(isReady(graph, entry.activity));
    }
  });

  test("only an `inactive` activity carries a reason, and every one of them does", () => {
    for (const entry of view.nodes) {
      expect(entry.blocked === null).toBe(entry.readiness !== "inactive");
    }
  });
});

describe("the reason an activity is blocked, in words", () => {
  const view = headView();

  test("the quorum wait names all three unmet dependencies and not the two met ones", () => {
    const blocked = at(view, "th-ymld").blocked;
    expect(blocked).not.toBeNull();
    expect(blocked?.summary).toBe("3 of 5 dependencies unmet");
    expect(blocked?.causes.map((cause) => [cause.from, cause.kind])).toEqual([
      // Dana and Sam both declined, and `declined` fires `satisfied` — those two edges are MET.
      ["th-1ppl", "withdrawn"],
      ["th-9xi1", "not-finished"],
      ["th-0s7c", "not-finished"],
    ]);
  });

  test("a dropped source never satisfies readiness, and says so", () => {
    const cause = at(view, "th-ymld").blocked?.causes[0];
    expect(cause?.wants).toBe("satisfied");
    expect(cause?.text).toBe("Wait for Priya was dropped and can never satisfy this");
  });

  test("an abandoned in-edge is a cause, and is EXCLUDED from the readiness that judges it", () => {
    // This test used to claim the opposite — that Priya's abandoned wait had already ended the
    // quorum — and it was wrong about the store rather than about the viewer. §6.4 is explicit:
    // "an in-edge whose source is dropped is excluded from merge evaluation: it neither
    // satisfies nor blocks." So the arm is reported as a CAUSE (a reader wants to know it is
    // there and over) and is not counted against reachability.
    //
    // The distinction is worth the words. `unreachable` means "this can never happen"; if an
    // abandoned arm set it, every fan-out that lost one counterparty would paint its shared
    // descendant dead while the store still intended to run it.
    const graph = folded().graph;
    const goalie = at(view, "th-ymld");
    const priya = at(view, "th-1ppl").activity;

    if (priya.status === undefined)
      throw new Error("Priya's wait should be work, not a control node");
    expect(isTerminal(priya.status.state)).toBe(true);
    expect(satisfiesBlockingEdge(priya)).toBe(false);
    expect(goalie.blocked?.causes.some((c) => c.from === "th-1ppl")).toBe(true);
    expect(goalie.blocked?.unreachable).toBe(false);

    // Still blocked, though — by the arms that CAN still answer, which is the honest reason.
    expect(isReady(graph, goalie.activity)).toBe(false);
  });

  test("a wait behind an activity that is still in flight is blocked, not ready", () => {
    const blocked = at(view, "th-0s7c").blocked;
    expect(blocked?.causes).toHaveLength(1);
    expect(blocked?.summary).toBe("Ask Pat to play in goal is still in flight");
    expect(blocked?.unreachable).toBe(false);
  });
});

describe("waits carry their own clock", () => {
  const view = headView();

  test("a task has no wait state at all", () => {
    expect(at(view, "th-nhwd").wait).toBeNull();
    expect(at(view, "th-ahf6").wait).toBeNull();
  });

  test("both absolute deadlines are already blown at NOW", () => {
    for (const id of ["th-ymld", "th-9xi1"]) {
      const wait = at(view, id).wait;
      expect(wait?.phase).toBe("blown");
      expect(wait?.remainingMs).toBeLessThan(0);
      expect(wait?.timeoutTarget).toBeNull();
    }
    expect(at(view, "th-ymld").wait?.deadlineAt).toBe(Date.parse("2026-08-21T17:00:00.000Z"));
  });

  test("a relative deadline is unarmed while its anchor is still in flight", () => {
    // `48h after th-gk0l`, and Pat's send is `active` at head. There is no
    // instant to count down to yet, and inventing one would paint the activity the wrong colour.
    const wait = at(view, "th-0s7c").wait;
    expect(wait?.phase).toBe("unarmed");
    expect(wait?.deadlineAt).toBeNull();
    expect(wait?.remainingMs).toBeNull();
    expect(wait?.deadlineLabel).toBe("48h after th-gk0l");
    expect(wait?.unresolvedReason).toContain("still in flight");
  });

  test("a relative deadline arms off the log, not off the graph", () => {
    // Dana's ask went `completed` when `effect record` closed her slot, so the clock started at
    // THAT record's `observed_at` — a timestamp that exists nowhere in `kona graph --json`.
    // This is D1's reason for folding the log. Note it is the record, not the reserve one
    // version earlier: `active` is not finished, and a wait behind it has not started.
    const sent = folded().records[V.danaSent];
    expect(sent?.v).toBe(V.danaSent);
    const wait = at(view, "th-es9m").wait;
    expect(wait?.deadlineAt).toBe(Date.parse(sent?.observed_at ?? "") + HOURS_48);
    // Answered, so the clock is moot: a wait that closed is resolved, never blown.
    expect(wait?.phase).toBe("resolved");
  });

  test("a wait retired without a replacement reads as withdrawn, whatever it answered", () => {
    const priya = at(view, "th-1ppl");
    expect(priya.activity.provenance.superseded_by).toBeNull();
    expect(priya.activity.status?.state).toBe("withdrawn");
    expect(priya.activity.status?.outcome?.verdict).toBe("bounced");
    expect(priya.readiness).toBe("withdrawn");
    expect(priya.wait?.phase).toBe("withdrawn");
  });

  test("the quorum counter counts outcomes, not fired edges", () => {
    const predicate = at(view, "th-ymld").wait?.predicate;
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
    const marked = view.nodes
      .filter((entry) => entry.irreversible)
      .map((entry) => entry.activity.id);
    expect(marked).toEqual(["th-nhwd", "th-gyre", "th-t2yo", "th-gk0l"]);
    for (const entry of view.nodes) {
      expect(entry.irreversible).toBe(entry.activity.spec.effect_class === "pivot");
    }
  });

  test("the two versions on an activity answer different questions", () => {
    const view = headView();
    const roster = at(view, "th-ahf6");
    expect(roster.createdAtVersion).toBe(1); // decided on when the pursuit opened
    expect(roster.observedAtVersion).toBe(1); // and read in the same version, before anyone
    // could be addressed from it (invariant 3(b))
  });
});

describe("completionTime — the moment an activity actually finished", () => {
  test("an activity has one exactly when it reached `completed`", () => {
    // Terminal is not the same question: Priya's ask `failed` and her wait was `withdrawn`, and
    // neither of those started anybody's clock — the same rule `satisfiesBlockingEdge` applies.
    for (const entry of headView().nodes) {
      expect(HEAD.completionTime.has(entry.activity.id)).toBe(
        entry.activity.status?.state === "completed",
      );
    }
    expect(HEAD.completionTime.has("th-t2yo")).toBe(false);
    expect(HEAD.completionTime.has("th-1ppl")).toBe(false);
    expect(HEAD.completionTime.has("th-gk0l")).toBe(false);
  });

  test("the instant is the record's, at the version whose op said `completed`", () => {
    const records = HEAD.records;
    // Each ask finished when the outbox RECORDED it, not when it reserved the slot — two
    // adjacent versions with different timestamps, and taking the wrong one would arm every
    // downstream deadline early.
    expect(HEAD.completionTime.get("th-nhwd")).toBe(
      Date.parse(records[V.danaSent]?.observed_at ?? ""),
    );
    expect(HEAD.completionTime.get("th-gyre")).toBe(
      Date.parse(records[V.samSent]?.observed_at ?? ""),
    );
    expect(HEAD.completionTime.get("th-ocwr")).toBe(
      Date.parse(records[V.samRefers]?.observed_at ?? ""),
    );
  });

  test("it is a function of the records folded, so time travel carries it", () => {
    const past = buildPursuit(logText(), V.danaDeclines - 1);
    expect(past.completionTime).toEqual(completionTimeOf(past.records));
    for (const activity of past.graph.nodes.values()) {
      expect(past.completionTime.has(activity.id)).toBe(activity.status?.state === "completed");
    }
    // Dana's wait only closes when she declines, so one version earlier there is no instant
    // for it — and inventing one from head would be the scrubber quietly showing the reader a
    // fact from their future.
    expect(past.completionTime.has("th-es9m")).toBe(false);
    expect(HEAD.completionTime.has("th-es9m")).toBe(true);
  });

  test("a second `completed` on the same activity does not move its clock", () => {
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
            node: "th-gk0l",
            status: "completed",
            evidence_ref: "msg:pat-outbound",
          },
        ]) +
        mutation(V.patReserved + 2, again, [
          {
            op: "set_status",
            node: "th-gk0l",
            status: "completed",
            evidence_ref: "msg:pat-outbound-reobserved",
          },
        ]),
    );
    expect(pursuit.records).toHaveLength(V.patReserved + 3);
    expect(pursuit.completionTime.get("th-gk0l")).toBe(Date.parse(first));
    expect(completionTimeOf(pursuit.records)).toEqual(pursuit.completionTime);
  });

  test("a receipt arriving after the send does not move the send's clock", () => {
    // The whole reason this map exists instead of `versionTime.get(observed_at_version)`.
    // Pat's send finishes; the next version records the delivery receipt a day later, which §6.4 allows
    // against a terminal activity and which bumps `observed_at_version` with it. Anchoring the
    // deadline there would push it 24h into the future and un-blow a wait the store has
    // already timed out — the one failure mode that silently keeps a dead branch alive.
    const sentAt = "2026-08-22T01:00:00.000Z";
    const receiptAt = "2026-08-23T00:00:00.000Z";
    const pursuit = buildPursuit(
      logText() +
        mutation(V.patReserved + 1, sentAt, [
          {
            op: "set_status",
            node: "th-gk0l",
            status: "completed",
            evidence_ref: "msg:pat-outbound",
          },
        ]) +
        mutation(V.patReserved + 2, receiptAt, [
          // `late` is the verdict for a fact that arrived after the graph had moved on, which
          // is exactly what a delivery receipt is. §6.4 lets it land on a terminal activity; being
          // non-resolving, it changes no projection — but it is still a touch, and a touch is
          // what bumps `observed_at_version`.
          {
            op: "record_outcome",
            node: "th-gk0l",
            verdict: "late",
            evidence_ref: "smtp:250-queued",
          },
        ]),
    );
    expect(pursuit.damaged).toEqual([]);
    expect(pursuit.graph.version).toBe(V.patReserved + 2);

    const view = viewOf(pursuit, Date.parse("2026-08-24T12:00:00.000Z"));
    const pat = at(view, "th-gk0l");
    // The receipt is the last thing we learned.
    expect(pat.observedAtVersion).toBe(V.patReserved + 2);
    expect(HEAD.completionTime.has("th-gk0l")).toBe(false);
    expect(pursuit.completionTime.get("th-gk0l")).toBe(Date.parse(sentAt));

    const wait = at(view, "th-0s7c").wait;
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
    const roster = at(view, "th-ahf6");
    expect(roster.readiness).toBe("completed");
    expect(roster.activity.provenance.superseded_by).toBeNull();
    // Marcus does not exist yet; the referral that created him arrives at v5.
    expect(view.byId.has("th-etsk")).toBe(false);
  });

  test("v2's frontier is the three asks the fan-out just unblocked", () => {
    const view = viewOf(buildPursuit(logText(), 2));
    const spread = new Map<string, Standing | null>(
      view.nodes.map((entry) => [entry.activity.id, entry.readiness]),
    );
    expect(view.frontier).toEqual(["th-vipt", "th-nhwd", "th-gyre", "th-t2yo"]);
    expect(spread.get("th-ymld")).toBe("inactive");
    expect(spread.get("th-es9m")).toBe("inactive");
  });

  test("a deadline anchored past the ceiling stays unarmed while travelling", () => {
    // Dana's ask only goes `completed` at v3, so at v2 there is no clock — the same wait that is
    // `resolved` at head, seen honestly from the version the reader chose.
    const past = buildPursuit(logText(), 2);
    expect(past.completionTime.has("th-nhwd")).toBe(false);
    const wait = at(viewOf(past), "th-es9m").wait;
    expect(wait?.phase).toBe("unarmed");
    expect(wait?.deadlineAt).toBeNull();
    expect(wait?.unresolvedReason).toContain("still ready");
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
 * read against HEAD's completion index, so `th-es9m` counted down from a clock that
 * `th-nhwd` does not start until v3. Typecheck, lint, knip and 589 tests all
 * passed with that in, because **nothing in this package tests a `.tsx` file**: there is no
 * jsdom, no testing-library, no component test, and `bun test --coverage` does not so much as
 * list the React tree. Judgment left in a component is judgment no mutant can reach, which is
 * why the composition lives in `model/` and why these are here.
 */
describe("buildPursuit at an earlier version", () => {
  const head = buildPursuit(logText());

  test("a version beyond head folds to head, not to an empty canvas", () => {
    expect(buildPursuit(logText(), head.graph.version + 5).graph.version).toBe(head.graph.version);
  });

  test("an earlier version carries its OWN completion index, never head's", () => {
    // The bug, named. `th-nhwd` goes `completed` at v3, so at v2 there is no clock
    // for `th-es9m` to count down — and reading head's index would invent one.
    const at2 = buildPursuit(logText(), 2);
    expect(at2.graph.version).toBe(2);
    expect(head.completionTime.has("th-nhwd")).toBe(true);
    expect(at2.completionTime.has("th-nhwd")).toBe(false);

    const wait = at2.graph.nodes.get("th-es9m");
    if (wait === undefined) throw new Error("the fixture has no th-es9m at v2");
    const state = waitStateOf(at2.graph, wait, at2.completionTime, NOW);
    expect(state?.phase).toBe("unarmed");
    expect(state?.deadlineAt).toBeNull();
    expect(state?.unresolvedReason).toContain("still ready");
  });

  test("every version of the fixture builds without throwing, and folds to itself", () => {
    for (let v = 0; v <= head.graph.version; v++) {
      const built = buildPursuit(logText(), v);
      expect(built.graph.version).toBe(v);
      // The two indexes must come from the same fold: nothing in `completionTime` may name a
      // activity the graph at that version does not have.
      for (const id of built.completionTime.keys()) expect(built.graph.nodes.has(id)).toBe(true);
    }
  });
});
