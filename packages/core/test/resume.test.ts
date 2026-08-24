/**
 * Deadline evaluation and the resume plan (§6.2, §6.5, §6.7).
 *
 * The property that matters throughout is that **failure is safe**. A deadline that cannot
 * be computed is not an expired one, and an open reservation is never repaired — because
 * the wrong call in either direction fires a branch, or sends a second email, against a
 * world nobody has checked.
 */

import { describe, expect, test } from "bun:test";
import type { Graph, MutationRecord } from "../src/index.ts";
import {
  armedWaits,
  effectiveDeadline,
  encodeReserveEvidence,
  overdueWaits,
  parseDuration,
  planResume,
  settledAt,
  waitStatus,
} from "../src/index.ts";
import { commit, record, rostered, seeded, task, wait, activityAt, slugOf, slugOps, nid } from "./fixtures.ts";

const T0 = "2026-08-21T12:00:00.000Z";
const LATER = "2026-08-25T12:00:00.000Z";

function activityOf(graph: Graph, id: string) {
  const activity = activityAt(graph, id);
  if (activity === undefined) throw new Error(`no activity ${id}`);
  return activity;
}

/** `escalate` (task) then `gate` (wait) pointing its timeout at it. */
function gated(deadline: unknown): Graph {
  return seeded([
    task("Escalate"),
    wait("Gate", { on_timeout: "$0", deadline }),
  ]);
}

function stampedRecord(v: number, ops: MutationRecord["ops"], at: string): MutationRecord {
  return { ...record(v, ops), occurred_at: at, observed_at: at };
}

describe("durations", () => {
  test.each([
    ["30s", 30_000],
    ["5m", 300_000],
    ["48h", 172_800_000],
    ["2d", 172_800_000],
  ])("%s is %i ms", (duration, expected) => {
    expect(parseDuration(duration)).toBe(expected);
  });

  test.each(["", "48", "h", "48hours", "-1h", "1.5h", "48H", "48w"])(
    "'%s' is not a duration",
    (duration) => {
      expect(parseDuration(duration)).toBeNull();
    },
  );
});

describe("settledAt reads the time from the log, not the graph", () => {
  test("returns the occurred_at of the record that made an activity terminal", () => {
    const records = [
      stampedRecord(0, [], T0),
      stampedRecord(1, [{ op: "set_status", activity: "a", status: "done", evidence_ref: "e" }], LATER),
    ];
    expect(settledAt(records, "a")).toBe(LATER);
  });

  test("a non-terminal status does not count as settling", () => {
    const records = [
      stampedRecord(1, [{ op: "set_status", activity: "a", status: "in_flight", evidence_ref: "e" }], LATER),
    ];
    expect(settledAt(records, "a")).toBeNull();
  });

  test("the LAST terminal transition wins", () => {
    const records = [
      stampedRecord(1, [{ op: "set_status", activity: "a", status: "failed", evidence_ref: "e" }], T0),
      stampedRecord(2, [{ op: "set_status", activity: "a", status: "dropped", evidence_ref: "e" }], LATER),
    ];
    expect(settledAt(records, "a")).toBe(LATER);
  });

  test("an activity that never settled has no time", () => {
    expect(settledAt([stampedRecord(0, [], T0)], "a")).toBeNull();
  });
});

describe("the three deadline shapes (§6.2)", () => {
  test("{at} is the instant itself", () => {
    expect(effectiveDeadline([], { at: LATER })).toEqual({ at: LATER, basis: "fixed instant" });
  });

  test("{after, duration} is measured from when the anchor settled", () => {
    const records = [
      stampedRecord(1, [{ op: "set_status", activity: "invite", status: "done", evidence_ref: "e" }], T0),
    ];
    const deadline = effectiveDeadline(records, { after: "invite", duration: "48h" });
    expect(deadline.at).toBe("2026-08-23T12:00:00.000Z");
    expect(deadline.basis).toContain("48h after 'invite'");
  });

  test("and is UNKNOWN while the anchor is still running", () => {
    const deadline = effectiveDeadline([], { after: "invite", duration: "48h" });
    expect(deadline.at).toBeNull();
    expect(deadline.basis).toContain("waiting for 'invite'");
  });

  test("a malformed duration yields unknown rather than a wrong instant", () => {
    const records = [
      stampedRecord(1, [{ op: "set_status", activity: "invite", status: "done", evidence_ref: "e" }], T0),
    ];
    expect(effectiveDeadline(records, { after: "invite", duration: "soon" }).at).toBeNull();
  });

  test("{expr} is NOT evaluated — its backstop is the deadline", () => {
    // §6.8 hardcodes its queries and says "no query language". Shipping an expression
    // evaluator here would be exactly the thing that decision refused; the backstop is
    // what the shape carries a backstop FOR.
    const deadline = effectiveDeadline([], {
      expr: "game_date - 24h",
      backstop: LATER,
      after_unknown: true,
    });
    expect(deadline.at).toBe(LATER);
    expect(deadline.basis).toContain("not evaluated");
  });
});

describe("overdue detection fails SAFE", () => {
  test("a wait past its instant is overdue", () => {
    const graph = gated({ at: T0 });
    expect(waitStatus([], activityOf(graph, "gate"), LATER).overdue).toBe(true);
  });

  test("a wait exactly at its instant is overdue", () => {
    expect(waitStatus([], activityOf(gated({ at: T0 }), "gate"), T0).overdue).toBe(true);
  });

  test("a wait one millisecond early is not", () => {
    const graph = gated({ at: LATER });
    const justBefore = new Date(Date.parse(LATER) - 1).toISOString();
    expect(waitStatus([], activityOf(graph, "gate"), justBefore).overdue).toBe(false);
  });

  test("an UNCOMPUTABLE deadline is not an expired one", () => {
    // Treating "cannot tell" as "expired" would fire a timeout branch — and possibly a
    // pivot — on a wait whose anchor simply has not run yet.
    // `$0` and not `escalate`: within one batch an activity is addressed by its op index,
    // because the id has not been minted yet at the moment the ref is resolved.
    const graph = gated({ after: "$0", duration: "48h" });
    const status = waitStatus([], activityOf(graph, "gate"), LATER);
    expect(status.deadline.at).toBeNull();
    expect(status.overdue).toBe(false);
  });
});

describe("armed waits are live waits only", () => {
  const graph = gated({ at: T0 });

  test("a task is never an armed wait, however overdue anything is", () => {
    expect(armedWaits(graph).map((n) => slugOf(n.id))).toEqual(["gate"]);
  });

  test.each(["done", "failed", "dropped", "in_flight"])("a '%s' wait is not armed", (state) => {
    const resolved = commit(graph, [
      { op: "set_status", activity: "gate", status: state, evidence_ref: "e" },
    ]);
    expect(armedWaits(resolved)).toEqual([]);
  });

  test("a superseded wait is not armed", () => {
    const superseded = commit(graph, [
      wait("Gate prime", { on_timeout: "escalate", deadline: { at: T0 } }),
      { op: "supersede_activity", activity: "gate", by: "$0" },
    ]);
    expect(activityAt(superseded, "gate")?.status.state).toBe("dropped");
    expect(armedWaits(superseded).map((n) => slugOf(n.id))).toEqual(["gate-prime"]);
  });

  test("overdueWaits is armed AND expired", () => {
    expect(overdueWaits([], graph, LATER).map((s) => slugOf(s.activity.id))).toEqual(["gate"]);
    expect(overdueWaits([], graph, "2020-01-01T00:00:00.000Z")).toEqual([]);
  });
});

describe("the resume plan", () => {
  test("reports state counts, the frontier and armed waits", () => {
    const graph = gated({ at: LATER });
    const plan = planResume([], graph, T0);
    expect(plan.report.counts).toEqual({ active: 2 });
    expect(plan.report.frontier.map(slugOf)).toEqual(["escalate", "gate"]);
    expect(plan.report.waits).toEqual([
      { activity_id: nid(graph, "gate"), name: "Gate", deadline: LATER, basis: "fixed instant", overdue: false },
    ]);
  });

  test("plans nothing when nothing is overdue", () => {
    expect(planResume([], gated({ at: LATER }), T0).repairs).toEqual([]);
  });

  test("firing a timeout resolves the wait AND materialises its escape route", () => {
    // `on_timeout` is a declaration, not an edge. Without the edge, a timed-out wait
    // resolves into nothing and §6.2's reason for demanding on_timeout evaporates.
    const plan = planResume([], gated({ at: T0 }), LATER);
    expect(plan.repairs.map(slugOps)).toEqual([
      { op: "add_edge", from: "gate", to: "escalate", condition: { on: "timeout" } },
      { op: "record_outcome", activity: "gate", verdict: "timed_out", evidence_ref: `deadline:${T0}` },
      { op: "set_status", activity: "gate", status: "done", evidence_ref: `deadline:${T0}` },
    ]);
  });

  test("the escape edge is not added twice", () => {
    const graph = commit(gated({ at: T0 }), [
      { op: "add_edge", from: "gate", to: "escalate", condition: { on: "timeout" } },
    ]);
    expect(planResume([], graph, LATER).repairs.map((op) => op.op)).toEqual([
      "record_outcome",
      "set_status",
    ]);
  });

  test("the repairs actually apply, and leave the escape route ready", () => {
    const plan = planResume([], gated({ at: T0 }), LATER);
    const repaired = commit(gated({ at: T0 }), plan.repairs);
    expect(activityAt(repaired, "gate")?.status.state).toBe("done");
    expect(activityAt(repaired, "gate")?.status.outcome?.verdict).toBe("timed_out");
    expect(planResume([], repaired, LATER).repairs).toEqual([]);
  });

  test("the rationale names the waits, singular and plural", () => {
    expect(planResume([], gated({ at: T0 }), LATER).rationale).toContain("'Gate'");
    const two = commit(gated({ at: T0 }), [
      wait("Second gate", { on_timeout: "escalate", deadline: { at: T0 } }),
    ]);
    expect(planResume([], two, LATER).rationale).toContain("2 waits");
  });
});

describe("a claimed PURE activity is returned to the frontier", () => {
  // The other half of `in_flight`. An agent claims a pure activity, dies, and nothing left the
  // machine — so unlike an open reservation there is nothing for a human to adjudicate, and
  // leaving it claimed would strand work no `kona next` would ever offer again.
  const claimed = commit(seeded([task("Read the schemas", { effect_class: "pure" })]), [
    {
      op: "set_status",
      activity: "read-the-schemas",
      status: "in_flight",
      evidence_ref: "claim:agent-1",
    },
  ]);

  test("it is repaired to active, and is NOT reported as an unknown send", () => {
    const plan = planResume([], claimed, LATER);
    expect(plan.repairs.map(slugOps)).toEqual([
      {
        op: "set_status",
        activity: "read-the-schemas",
        status: "active",
        evidence_ref: "resume:stale-claim",
      },
    ]);
    expect(plan.report.unknown_sends).toEqual([]);
    expect(plan.rationale).toContain("claimed and never finished");
  });

  test("the activity is off the frontier while claimed — that is the point of claiming it", () => {
    expect(planResume([], claimed, LATER).report.frontier).toEqual([]);
  });
});

describe("resume NEVER repairs an open reservation", () => {
  const reserved = commit(
    rostered(["dana"], [
      task("Ask Dana", {
        effect_class: "pivot",
        effect: { channel: "email", recipient_ref: "roster#dana" },
      }),
    ]),
    [
      {
        op: "set_status",
        activity: "ask-dana",
        status: "in_flight",
        evidence_ref: encodeReserveEvidence("ek_1", "sha256:aaa"),
      },
    ],
  );

  test("it surfaces it for a human instead", () => {
    // Crash windows 2 and 3 leave identical bytes. Guessing which one happened sends a
    // second email; §6.5 makes the mailbox, not the log, the thing that can tell them apart.
    const plan = planResume([], reserved, LATER);
    expect(plan.repairs.map(slugOps)).toEqual([]);
    expect(plan.report.unknown_sends).toEqual([
      {
        activity_id: nid(reserved, "ask-dana"),
        name: "Ask Dana",
        effect_key: "ek_1",
        payload_hash: "sha256:aaa",
        attempted_at: "",
        recipient_ref: "roster#dana",
      },
    ]);
  });

  test("a completed send is not an unknown", () => {
    expect(planResume([], seeded([task("A")]), LATER).report.unknown_sends).toEqual([]);
  });

  test("damaged records are counted, so a partial graph says it is partial", () => {
    expect(planResume([], seeded([task("A")]), LATER, 3).report.damaged).toBe(3);
  });
});

describe("the escape route must still be runnable", () => {
  test("no edge is added when the timeout target has already completed", () => {
    // Invariant 1 forbids a new blocking edge into a terminal activity. Insisting on the edge
    // would make the entire repair 422, so a wait whose escalation already ran simply
    // resolves — there is nothing left to route to.
    const graph = commit(gated({ at: T0 }), [
      { op: "set_status", activity: "escalate", status: "done", evidence_ref: "e" },
    ]);
    expect(planResume([], graph, LATER).repairs.map((op) => op.op)).toEqual([
      "record_outcome",
      "set_status",
    ]);
  });

  test("and the repair still applies cleanly", () => {
    const graph = commit(gated({ at: T0 }), [
      { op: "set_status", activity: "escalate", status: "done", evidence_ref: "e" },
    ]);
    const repaired = commit(graph, planResume([], graph, LATER).repairs);
    expect(activityAt(repaired, "gate")?.status.outcome?.verdict).toBe("timed_out");
  });

  test("a timeout target that does not exist is skipped rather than invented", () => {
    // Unreachable through the op path — a ref must resolve at commit time and activities are
    // never deleted — so this is a defensive branch, constructed by hand. It matters
    // because the alternative is an add_edge that fails the whole repair.
    const orphan = gated({ at: T0 });
    const gate = activityOf(orphan, "gate");
    gate.spec.on_timeout = "never-existed";
    expect(planResume([], orphan, LATER).repairs.map((op) => op.op)).toEqual([
      "record_outcome",
      "set_status",
    ]);
  });
});

describe("settledAt looks at the right activity", () => {
  test("another activity going terminal does not count", () => {
    const records = [
      stampedRecord(1, [{ op: "set_status", activity: "other", status: "done", evidence_ref: "e" }], T0),
    ];
    expect(settledAt(records, "invite")).toBeNull();
  });

  test("it finds the target among several transitions in one record", () => {
    const records = [
      stampedRecord(
        1,
        [
          { op: "set_status", activity: "other", status: "done", evidence_ref: "e" },
          { op: "set_status", activity: "invite", status: "done", evidence_ref: "e" },
        ],
        LATER,
      ),
    ];
    expect(settledAt(records, "invite")).toBe(LATER);
  });

  test("a non-status op for the right activity does not count either", () => {
    const records = [
      stampedRecord(1, [{ op: "record_outcome", activity: "invite", verdict: "confirmed", evidence_ref: "e" }], T0),
    ];
    expect(settledAt(records, "invite")).toBeNull();
  });
});
