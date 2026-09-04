/**
 * `kona brief` and the correlation it derives (§6.9, §6.5).
 *
 * The property under test is the DIRECTION of failure. An earlier version of
 * `preconditions_satisfied` failed OPEN, which is the worst possible direction for a check
 * standing in front of an irreversible send: a missing input read as "no objection"
 * rather than "unknown".
 */

import { describe, expect, test } from "bun:test";
import type { AuthoredOp, Graph, Identity, PursuitConfig } from "../src/index.ts";
import {
  DISCLOSURE,
  buildBrief,
  deriveCorrelation,
  encodeRecordEvidence,
  encodeReserveEvidence,
  matchInbound,
  activityIdFromCorrelation,
  pursuitConfig,
  waitAddresses,
} from "../src/index.ts";
import {
  commit,
  record,
  rostered,
  seeded,
  slugOr,
  action,
  acceptEvent,
  nid,
  slugOf,
  workedAt,
} from "./fixtures.ts";

const IDENTITY: Identity = {
  mailbox: "ilya@example.com",
  display_name: "Ilya Vorobiev",
  signature: "— Ilya",
  authority: "You may not commit funds.",
};
const CONFIG: PursuitConfig = { identity: IDENTITY, effect_budget: 12 };

function pivot(name: string, extra: Record<string, unknown> = {}): AuthoredOp {
  return action(name, {
    effect_class: "pivot",
    effect: { channel: "email", recipient_ref: "roster#dana" },
    ...extra,
  });
}

function briefOf(graph: Graph, id: string, config: PursuitConfig = CONFIG) {
  const result = buildBrief(graph, slugOr(graph, id), config);
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return result.brief;
}

function checkNamed(graph: Graph, id: string, name: string, config: PursuitConfig = CONFIG) {
  const check = briefOf(graph, id, config).preconditions_satisfied.checks.find(
    (c) => c.name === name,
  );
  if (check === undefined) throw new Error(`no check '${name}'`);
  return check;
}

/**
 * The send actually going out — the step that sits between the two halves of the round trip
 * below.
 *
 * A acceptEvent is armed only in `ready`, and readiness is DERIVED at commit, so a acceptEvent sits
 * `inactive` until the activity in front of it completes. Under the old vocabulary an
 * unclaimed acceptEvent was `active` from the moment it was authored, so a poll saw it before its
 * send had gone anywhere. A brief is handed out BEFORE the send and a poll happens AFTER it,
 * so the round trip has to cross the send rather than assert both ends against one frozen
 * graph.
 */
function afterTheSend(graph: Graph): Graph {
  const key = "ek_1";
  return commit(
    commit(graph, [
      {
        op: "set_status",
        node: "ask-dana",
        status: "active",
        evidence_ref: encodeReserveEvidence(key, "h"),
      },
    ] as AuthoredOp[]),
    [
      {
        op: "set_status",
        node: "ask-dana",
        status: "completed",
        evidence_ref: encodeRecordEvidence(key, "sent", "<m-1>"),
      },
    ] as AuthoredOp[],
  );
}

/**
 * A graph whose activity `a` sits in `state`.
 *
 * Two of the seven states are the STORE's to write and are refused from an author (§6.2.1),
 * so they have to be reached the way a pursuit reaches them. `ready` is derived at commit for
 * a node nothing blocks, which is why it takes no op at all. `withdrawn` is written by the
 * cascade when the arm a node sat on dies — reaching it by superseding instead would have
 * been one line, and would also have set `superseded_by`, which fails `node_live` for a
 * second reason and would leave that row saying nothing about the state.
 */
function inState(state: string): Graph {
  if (state === "ready") return seeded([action("A")]);
  if (state === "withdrawn") {
    const gated = commit(seeded([action("A"), acceptEvent("Gate")]), [
      { op: "add_edge", from: "gate", to: "a", guard: { on: "accept" } },
    ] as AuthoredOp[]);
    // The gate resolved `ignore`, so `a`'s only in-edge can never fire.
    return commit(gated, [
      { op: "record_outcome", node: "gate", verdict: "ignore", evidence_ref: "e" },
      { op: "set_status", node: "gate", status: "completed", evidence_ref: "e" },
    ] as AuthoredOp[]);
  }
  return commit(seeded([action("A")]), [
    { op: "set_status", node: "a", status: state, evidence_ref: "e" } as AuthoredOp,
  ]);
}

describe("correlation derives from the activity id (§6.5)", () => {
  test("a plain mailbox gains the tag", () => {
    const derived = deriveCorrelation("ilya@example.com", "ask-dana");
    expect(derived.ok && derived.correlation.reply_to).toBe("ilya+kona-ask-dana@example.com");
    expect(derived.ok && derived.correlation.subject_tag).toBe("[kona-ask-dana]");
  });

  test("an existing plus-tag is REPLACED, never appended to", () => {
    // `ilya+kona+kona-ask-dana@…` is delivered by most providers and matched by nothing.
    const derived = deriveCorrelation("ilya+kona@example.com", "ask-dana");
    expect(derived.ok && derived.correlation.reply_to).toBe("ilya+kona-ask-dana@example.com");
  });

  test("it is stable across runs — a token that changes goes stale in someone's inbox", () => {
    expect(deriveCorrelation("ilya@example.com", "ask-dana")).toEqual(
      deriveCorrelation("ilya@example.com", "ask-dana"),
    );
  });

  test("N tags on ONE inbox, which is what makes a fan-out free", () => {
    const arms = ["ask-dana", "ask-sam", "ask-priya"].map((id) =>
      deriveCorrelation("ilya@example.com", id),
    );
    const addresses = arms.map((a) => (a.ok ? a.correlation.reply_to : ""));
    expect(new Set(addresses).size).toBe(3);
    for (const address of addresses) expect(address.endsWith("@example.com")).toBe(true);
  });

  test.each(["", "ilya", "@example.com", "ilya@", "+tag@example.com"])(
    "'%s' cannot be plus-tagged",
    (mailbox) => {
      expect(deriveCorrelation(mailbox, "ask-dana").ok).toBe(false);
    },
  );

  test("a second @ is refused, not tagged into a broken address", () => {
    // `a@b+kona-n@example.com` is syntactically invalid; providers drop it without a
    // bounce, so the acceptEvent behind it would sit armed until its deadline.
    expect(deriveCorrelation("a@b@example.com", "n").ok).toBe(false);
  });

  test("the inverse recovers the activity id, and only from a Kona tag", () => {
    expect(activityIdFromCorrelation("ilya+kona-ask-dana@example.com")).toBe("ask-dana");
    expect(activityIdFromCorrelation("ilya@example.com")).toBeNull();
    expect(activityIdFromCorrelation("ilya+newsletter@example.com")).toBeNull();
    expect(activityIdFromCorrelation("ilya+kona-@example.com")).toBeNull();
  });

  test("it round-trips for every id the store can mint", () => {
    for (const id of ["a", "ask-dana", "ask-dana-2", "0", "x".repeat(48)]) {
      const derived = deriveCorrelation("ilya@example.com", id);
      expect(derived.ok && activityIdFromCorrelation(derived.correlation.reply_to)).toBe(id);
    }
  });
});

describe("the reply address is the WAIT's, not the sender's (§6.5)", () => {
  /**
   * The bug this pins, which only an end-to-end run could show.
   *
   * `brief` derived the correlation from the SENDING activity's id, so an executor was handed
   * `ilya+kona-ask-dana@…`. `waitAddresses` and `matchInbound` derive it from the WAIT's id
   * and look for `ilya+kona-wait-for-dana@…`. Both halves had passing unit tests — each was
   * self-consistent — and every reply in a real run would have arrived correlated to nothing.
   *
   * §6.5 shows the token twice with the same literal, on the effect activity and on the acceptEvent: one
   * conversation, one token. The acceptEvent is the end that has to own it, because `record_outcome`
   * targets the acceptEvent and because a send can be superseded while the acceptEvent behind it survives —
   * and "a token that changes across executions goes stale in someone's inbox".
   */
  const wired = (extra: AuthoredOp[] = [], edges: AuthoredOp[] = []): Graph =>
    commit(rostered(["dana"], [pivot("Ask Dana"), acceptEvent("Wait for Dana"), ...extra]), [
      { op: "add_edge", from: "ask-dana", to: "wait-for-dana" },
      ...edges,
    ] as AuthoredOp[]);

  test("the address brief hands out is the one poll will look for", () => {
    const graph = wired();
    const handed = briefOf(graph, "ask-dana").correlation?.reply_to ?? "";
    const polled = waitAddresses(afterTheSend(graph), IDENTITY.mailbox).map((a) => a.address);
    // The whole claim, in one line: what the executor puts in `Reply-To` is what the poller
    // will be watching for.
    expect(polled).toContain(handed);
  });

  test("and a reply to it matches the acceptEvent, end to end", () => {
    const graph = wired();
    const replyTo = briefOf(graph, "ask-dana").correlation?.reply_to ?? "";
    const matches = matchInbound(afterTheSend(graph), IDENTITY.mailbox, [
      { message_id: "<m-1@mail>", from: "dana@example.com", to: [replyTo] },
    ]);
    expect(matches.map((match) => slugOf(match.activity_id))).toEqual(["wait-for-dana"]);
  });

  test("nothing waiting means no reply address, and that is not a failure", () => {
    // A fire-and-forget send — a follow-up nobody is expected to answer. An address that
    // routes to no acceptEvent would be worse than none: a reply would arrive and match nothing.
    const graph = rostered(["dana"], [pivot("Ask Dana")]);
    const brief = briefOf(graph, "ask-dana");
    expect(brief.correlation).toBeNull();
    expect(checkNamed(graph, "ask-dana", "correlation_expanded")).toEqual({
      name: "correlation_expanded",
      ok: true,
      detail: "nothing waits on this send, so a reply has nowhere to route",
    });
  });

  test("two waits on one send FAILS CLOSED — guessing routes an answer to the wrong arm", () => {
    const graph = wired(
      [acceptEvent("Wait again")],
      [{ op: "add_edge", from: "ask-dana", to: "wait-again" }],
    );
    const check = checkNamed(graph, "ask-dana", "correlation_expanded");
    expect(check.ok).toBe(false);
    // Two waits on one send: the detail names both, by id, because that is what the
    // author has to disambiguate.
    expect(check.detail).toContain(`${nid(graph, "wait-for-dana")}, ${nid(graph, "wait-again")}`);
    expect(briefOf(graph, "ask-dana").correlation).toBeNull();
    // And the brief as a whole refuses, so nothing dispatches on a guess.
    expect(briefOf(graph, "ask-dana").preconditions_satisfied.ok).toBe(false);
  });

  test("a superseded acceptEvent does not claim the address its replacement should own", () => {
    const graph = wired(
      [acceptEvent("Wait again")],
      [
        { op: "add_edge", from: "ask-dana", to: "wait-again" },
        { op: "supersede_node", node: "wait-for-dana", by: "wait-again" },
      ],
    );
    expect(briefOf(graph, "ask-dana").correlation?.reply_to).toBe(
      `ilya+kona-${nid(graph, "wait-again")}@example.com`,
    );
  });

  test("only an EVENT acceptEvent takes mail — a predicate acceptEvent has no inbox", () => {
    const graph = commit(
      rostered(
        ["dana"],
        [
          pivot("Ask Dana"),
          acceptEvent("Quorum", {
            match: {
              kind: "predicate",
              conditions: [
                {
                  kind: "predicate",
                  on: "satisfied",
                  predicate: { count: { verdict: "confirmed" }, op: ">=", n: 1 },
                },
              ],
            },
          }),
        ],
      ),
      [{ op: "add_edge", from: "ask-dana", to: "quorum" }] as AuthoredOp[],
    );
    expect(briefOf(graph, "ask-dana").correlation).toBeNull();
  });
});

describe("brief refuses rather than guessing (§6.9)", () => {
  test("refuses an accept_event without throwing", () => {
    const graph = seeded([acceptEvent("Wait for Dana")]);
    const result = buildBrief(graph, nid(graph, "wait-for-dana"), CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("NOT_BRIEFABLE");
  });

  test("refuses a control node without throwing", () => {
    const graph = seeded([
      { op: "add_node", name: "Start", type: "initial", spec: {} },
      action("Work"),
      { op: "add_node", name: "Done", type: "final", spec: {} },
      { op: "add_edge", from: "$0", to: "$1" },
      { op: "add_edge", from: "$1", to: "$2" },
    ] as AuthoredOp[]);
    const result = buildBrief(graph, nid(graph, "start"), CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("NOT_BRIEFABLE");
  });
  test("an activity that does not exist", () => {
    const result = buildBrief(seeded([action("A")]), "ghost", CONFIG);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("UNKNOWN_ACTIVITY");
  });

  test("an ACTIVE activity with no identity — an executor cannot speak for someone unnamed", () => {
    const graph = rostered(
      ["dana"],
      [
        action("Ask Dana", {
          effect_class: "pivot",
          effect: { channel: "email", recipient_ref: "roster#dana" },
        }),
      ],
    );
    const result = buildBrief(graph, nid(graph, "ask-dana"), {});
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("NO_IDENTITY");
    // The refusal names the recipient, so the reader knows which send it is standing in front of.
    expect(!result.ok && result.message).toContain("roster#dana");
  });

  test("a PURE activity needs none — there is nobody to speak for", () => {
    // Refusing this made effect-free pursuits unusable without inventing a mailbox nobody
    // reads, and §6.2 makes `effect_class: "pure"` first-class rather than degenerate. The
    // correlation check already says the true thing in words.
    const pure = seeded([action("A")]);
    const result = buildBrief(pure, nid(pure, "a"), {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.brief.identity).toBeNull();
    expect(result.brief.preconditions_satisfied.ok).toBe(true);
    expect(
      result.brief.preconditions_satisfied.checks.find((c) => c.name === "correlation_expanded")
        ?.detail,
    ).toBe("activity sends nothing, so it needs no reply address");
  });
});

describe("preconditions FAIL CLOSED", () => {
  test("a fully ready pure activity satisfies everything", () => {
    expect(briefOf(seeded([action("A")]), "a").preconditions_satisfied.ok).toBe(true);
  });

  test("a blocked activity fails on its dependency, naming what it waits on", () => {
    const graph = commit(seeded([action("A"), action("B")]), [
      { op: "add_edge", from: "a", to: "b" },
    ]);
    const check = checkNamed(graph, "b", "dependencies_satisfied");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain(`'${nid(graph, "a")}'`);
  });

  // `active` now means CLAIMED — somebody is already working this — so it is the state that is
  // NOT dispatchable, and `ready` is the frontier an executor may be handed. The two rows are
  // the same two the old vocabulary had, with their answers the other way round. `dropped`
  // likewise became two states, and both are unworkable, so both are listed.
  const DISPATCHABLE: readonly (readonly [string, boolean])[] = [
    ["active", false],
    ["completed", false],
    ["failed", false],
    ["withdrawn", false],
    ["terminated", false],
    ["ready", true],
  ];

  test.each(DISPATCHABLE)("an activity in state '%s' is dispatchable: %s", (state, expected) => {
    expect(checkNamed(inState(state), "a", "node_live").ok).toBe(expected);
  });

  test("a superseded activity is not dispatchable even while ready", () => {
    const graph = commit(seeded([action("A")]), [
      action("A prime"),
      { op: "supersede_node", node: "a", by: "$0" },
    ]);
    expect(checkNamed(graph, "a", "node_live").ok).toBe(false);
  });

  test("an input whose producer has not produced yet is UNRESOLVED, not absent", () => {
    // This is the failure the brief probe found: every `inputs[].ref` dangled because no
    // activity declared an `output`, and 0 of 8 subagents could execute.
    const graph = commit(seeded([action("Roster")]), [
      action("Ask", { inputs: [{ ref: "roster.reply" }] }),
    ]);
    const check = checkNamed(graph, "ask", "inputs_resolved");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("not produced yet");
  });

  test("an input that names a control node fails closed without throwing", () => {
    const graph = seeded([
      { op: "add_node", name: "Start", type: "initial", spec: {} },
      action("Ask"),
      { op: "add_node", name: "Done", type: "final", spec: {} },
      { op: "add_edge", from: "$0", to: "$1" },
      { op: "add_edge", from: "$1", to: "$2" },
    ] as AuthoredOp[]);
    workedAt(graph, "ask").spec.inputs = [{ ref: `${nid(graph, "start")}.reply` }];
    const check = checkNamed(graph, "ask", "inputs_resolved");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("control node and declares no outputs");
  });

  test.each([
    ["a producer that does not exist", "ghost.reply", "no activity"],
    ["an output nobody declared", "roster.nope", "declares no"],
    ["a ref that is not <activity>.<output>", "roster", "not <activity>.<output>"],
    ["a ref starting with a dot", ".reply", "not <activity>.<output>"],
  ])("%s is unresolved", (_name, ref, expected) => {
    const graph = commit(seeded([action("Roster")]), [action("Ask", { inputs: [{ ref }] })]);
    expect(checkNamed(graph, "ask", "inputs_resolved").detail).toContain(expected);
  });

  test("a produced input resolves", () => {
    const graph = commit(
      commit(seeded([action("Roster")]), [action("Ask", { inputs: [{ ref: "roster.reply" }] })]),
      [
        {
          op: "record_output",
          node: "roster",
          output_name: "reply",
          value: "dana,sam",
          evidence_ref: "e",
        },
      ],
    );
    expect(checkNamed(graph, "ask", "inputs_resolved").ok).toBe(true);
    expect(briefOf(graph, "ask").subgraph.upstream).toEqual([]);
  });

  test("an activity that has already sent fails the slot check", () => {
    const key = "ek_1";
    const sent = commit(
      commit(rostered(["dana"], [pivot("Ask Dana")]), [
        {
          op: "set_status",
          node: "ask-dana",
          status: "active",
          evidence_ref: encodeReserveEvidence(key, "h"),
        },
      ]),
      [
        {
          op: "set_status",
          node: "ask-dana",
          status: "completed",
          evidence_ref: encodeRecordEvidence(key, "sent", "<m-1>"),
        },
      ],
    );
    expect(checkNamed(sent, "ask-dana", "effect_slot_unfired").ok).toBe(false);
  });
});

describe("the budget check fails closed on an UNKNOWN cap", () => {
  test("an unconfigured budget blocks an effect activity", () => {
    // An unknown cap is not an unlimited one. This is the only thing standing between a
    // mutator and two hundred emails, now that max_reattempts is gone.
    const check = checkNamed(
      rostered(["dana"], [pivot("Ask Dana")]),
      "ask-dana",
      "budget_remaining",
      {
        identity: IDENTITY,
      },
    );
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("unknown cap is not an unlimited one");
  });

  test("but never blocks an activity that sends nothing", () => {
    expect(
      checkNamed(seeded([action("A")]), "a", "budget_remaining", { identity: IDENTITY }).ok,
    ).toBe(true);
  });

  test("counts sends across the whole pursuit, not just this activity", () => {
    const key = "ek_1";
    const graph = commit(
      commit(rostered(["dana", "sam"], [pivot("Ask Dana"), pivot("Ask Sam")]), [
        {
          op: "set_status",
          node: "ask-dana",
          status: "active",
          evidence_ref: encodeReserveEvidence(key, "h"),
        },
      ]),
      [
        {
          op: "set_status",
          node: "ask-dana",
          status: "completed",
          evidence_ref: encodeRecordEvidence(key, "sent", "<m-1>"),
        },
      ],
    );
    expect(
      checkNamed(graph, "ask-sam", "budget_remaining", { identity: IDENTITY, effect_budget: 2 })
        .detail,
    ).toBe("1 of 2 irreversible sends used");
  });

  test("a spent budget blocks the next send", () => {
    const key = "ek_1";
    const graph = commit(
      commit(rostered(["dana", "sam"], [pivot("Ask Dana"), pivot("Ask Sam")]), [
        {
          op: "set_status",
          node: "ask-dana",
          status: "active",
          evidence_ref: encodeReserveEvidence(key, "h"),
        },
      ]),
      [
        {
          op: "set_status",
          node: "ask-dana",
          status: "completed",
          evidence_ref: encodeRecordEvidence(key, "sent", "<m-1>"),
        },
      ],
    );
    expect(
      checkNamed(graph, "ask-sam", "budget_remaining", { identity: IDENTITY, effect_budget: 1 }).ok,
    ).toBe(false);
  });

  test("a budget of zero forbids the first send", () => {
    expect(
      checkNamed(rostered(["dana"], [pivot("Ask Dana")]), "ask-dana", "budget_remaining", {
        identity: IDENTITY,
        effect_budget: 0,
      }).ok,
    ).toBe(false);
  });
});

describe("what the brief carries", () => {
  const graph = commit(
    rostered(["dana"], [action("Roster"), pivot("Ask Dana"), acceptEvent("Wait for Dana")]),
    [
      { op: "add_edge", from: "roster", to: "ask-dana", guard: { on: "satisfied" } },
      { op: "add_edge", from: "ask-dana", to: "wait-for-dana" },
    ],
  );

  test("the correlation is FULLY EXPANDED — a template variable correlates nothing", () => {
    const brief = briefOf(graph, "ask-dana");
    expect(brief.correlation?.reply_to).toBe(
      `ilya+kona-${nid(graph, "wait-for-dana")}@example.com`,
    );
    expect(brief.correlation?.reply_to).not.toContain("{");
    expect(brief.correlation?.reply_to).not.toContain("$");
  });

  test("an activity that sends nothing gets no reply address", () => {
    expect(briefOf(graph, "roster").correlation).toBeNull();
  });

  test("the immediate neighbourhood, with edge conditions and upstream outputs", () => {
    const brief = briefOf(graph, "ask-dana");
    expect(brief.subgraph.upstream).toEqual([
      {
        id: nid(graph, "roster"),
        name: "Roster",
        state: "ready",
        guard: { on: "satisfied" },
        output: null,
      },
    ]);
    expect(briefOf(graph, "roster").subgraph.downstream).toEqual([
      { id: nid(graph, "ask-dana"), name: "Ask Dana", guard: { on: "satisfied" } },
    ]);
  });

  test("identity travels whole, authority included", () => {
    expect(briefOf(graph, "ask-dana").identity).toEqual(IDENTITY);
  });

  test("the deadline is WITHHELD — an internal timeout is not a promise to anyone", () => {
    // Left disclosable, an agent turns "we time out Thursday" into "I need to hear back by
    // Thursday", which is a commitment the graph never made.
    expect(DISCLOSURE.withheld).toContain("deadline");
    expect(DISCLOSURE.withheld).toContain("rationale");
    expect(DISCLOSURE.withheld).toContain("graph_structure");
    expect(DISCLOSURE.disclosable).toContain("instruction");
  });

  test("nothing is both disclosable and withheld", () => {
    const both = DISCLOSURE.disclosable.filter((field) => DISCLOSURE.withheld.includes(field));
    expect(both).toEqual([]);
  });
});

describe("config lives on the genesis record", () => {
  test("it is read back from v0", () => {
    expect(pursuitConfig([{ ...record(0, []), config: CONFIG }])).toEqual(CONFIG);
  });

  test("an unconfigured pursuit reads as empty, not as a crash", () => {
    expect(pursuitConfig([record(0, [])])).toEqual({});
    expect(pursuitConfig([])).toEqual({});
  });

  test("only v0 carries it — a later record cannot redefine who you are", () => {
    expect(pursuitConfig([record(0, []), { ...record(1, []), config: CONFIG }])).toEqual({});
  });
});

describe("the disclosure contract is exact", () => {
  test("what may be disclosed, in full", () => {
    // Pinned by literal rather than by membership. Silently dropping a field from either
    // list changes what an executor is allowed to put in front of a counterparty, and no
    // "contains" assertion would notice.
    expect(DISCLOSURE.disclosable).toEqual([
      "instruction",
      "inputs",
      "correlation.reply_to",
      "correlation.subject_tag",
      "identity",
    ]);
  });

  test("what may not, in full", () => {
    expect(DISCLOSURE.withheld).toEqual([
      "deadline",
      "graph_structure",
      "rationale",
      "effect_key",
      "sibling_nodes",
      "budget",
    ]);
  });

  test("every entry is a real field name, not an empty slot", () => {
    for (const field of [...DISCLOSURE.disclosable, ...DISCLOSURE.withheld]) {
      expect(field.length).toBeGreaterThan(0);
    }
  });
});

describe("the checks PASS as well as fail, which is the half that was untested", () => {
  /**
   * Mutation testing found both of these by deleting something and watching nothing break.
   *
   * `checkDependencies`'s `.filter(edge => !isEdgeSatisfied(...))` could be removed entirely
   * and every test still passed — which means no test had an activity whose in-edge was actually
   * SATISFIED. Every one of them was blocked. And `ok: spent < budget` could be replaced with
   * `ok: false` unnoticed, because nothing asserted an effect activity passing its budget check.
   *
   * Both are the same shape of gap, and it is the dangerous shape: a fail-closed gate whose
   * OPEN path nobody exercises is a gate that could be closed forever and look correct. The
   * probes measured that exact failure — an invariant rejecting correct work five times in
   * ten — so "it refuses the bad thing" is only half a test.
   */
  const satisfied = commit(
    rostered(["dana"], [action("Roster"), pivot("Ask Dana"), acceptEvent("Wait for Dana")]),
    [
      { op: "add_edge", from: "roster", to: "ask-dana" },
      { op: "add_edge", from: "ask-dana", to: "wait-for-dana" },
      {
        op: "record_output",
        node: "roster",
        output_name: "reply",
        value: "dana",
        evidence_ref: "roster.csv#v3",
      },
      { op: "set_status", node: "roster", status: "completed", evidence_ref: "roster.csv#v3" },
    ] as AuthoredOp[],
  );

  test("a satisfied in-edge does not block, and says so", () => {
    const check = checkNamed(satisfied, "ask-dana", "dependencies_satisfied");
    expect(check.ok).toBe(true);
    expect(check.detail).toBe("every blocking in-edge has a terminal-success source");
  });

  test("an effect activity with budget left passes the budget check", () => {
    const check = checkNamed(satisfied, "ask-dana", "budget_remaining");
    expect(check.ok).toBe(true);
    expect(check.detail).toBe("0 of 12 irreversible sends used");
  });

  test("and the whole brief is dispatchable — every check green at once", () => {
    // The state an executor is actually handed. Nothing in this suite asserted it existed.
    const brief = briefOf(satisfied, "ask-dana");
    expect(brief.preconditions_satisfied.checks.filter((check) => !check.ok)).toEqual([]);
    expect(brief.preconditions_satisfied.ok).toBe(true);
    expect(brief.correlation?.reply_to).toBe(
      `ilya+kona-${nid(satisfied, "wait-for-dana")}@example.com`,
    );
  });

  test("the budget check goes red exactly at the cap, not after it", () => {
    // `spent < budget`, not `<=`. At 1 of 1 the next send is the one over the line, and a
    // cap that lets the last one through is a cap set one higher than anybody approved.
    const oneLeft = checkNamed(satisfied, "ask-dana", "budget_remaining", {
      identity: IDENTITY,
      effect_budget: 1,
    });
    expect(oneLeft.ok).toBe(true);
    const none = checkNamed(satisfied, "ask-dana", "budget_remaining", {
      identity: IDENTITY,
      effect_budget: 0,
    });
    expect(none.ok).toBe(false);
    expect(none.detail).toBe("0 of 0 irreversible sends used");
  });
});

describe("each check says what it looked at, not just whether it passed", () => {
  test.each([
    ["node_live", "state 'ready'"],
    ["dependencies_satisfied", "every blocking in-edge has a terminal-success source"],
    ["inputs_resolved", "every input resolves to a recorded output"],
    ["effect_slot_unfired", "no send recorded"],
    ["correlation_expanded", "activity sends nothing, so it needs no reply address"],
    ["budget_remaining", "activity sends nothing"],
  ])("%s on a clean pure activity reads '%s'", (name, detail) => {
    expect(checkNamed(seeded([action("A")]), "a", name).detail).toBe(detail);
  });

  test("a sent activity says so plainly", () => {
    const key = "ek_1";
    const sent = commit(
      commit(rostered(["dana"], [pivot("Ask Dana")]), [
        {
          op: "set_status",
          node: "ask-dana",
          status: "active",
          evidence_ref: encodeReserveEvidence(key, "h"),
        },
      ]),
      [
        {
          op: "set_status",
          node: "ask-dana",
          status: "completed",
          evidence_ref: encodeRecordEvidence(key, "sent", "<m-1>"),
        },
      ],
    );
    expect(checkNamed(sent, "ask-dana", "effect_slot_unfired").detail).toBe(
      "this activity has already moved bytes",
    );
  });

  test("an effect activity names the address replies will correlate to, and whose it is", () => {
    const graph = commit(rostered(["dana"], [pivot("Ask Dana"), acceptEvent("Wait for Dana")]), [
      { op: "add_edge", from: "ask-dana", to: "wait-for-dana" },
    ]);
    const waitId = nid(graph, "wait-for-dana");
    expect(checkNamed(graph, "ask-dana", "correlation_expanded").detail).toBe(
      `replies correlate to ilya+kona-${waitId}@example.com — ${waitId}`,
    );
  });

  test("a superseded activity is described as superseded, not merely by its state", () => {
    const graph = commit(seeded([action("A")]), [
      action("A prime"),
      { op: "supersede_node", node: "a", by: "$0" },
    ]);
    expect(checkNamed(graph, "a", "node_live").detail).toContain("superseded");
  });

  test("TWO unresolved inputs are listed separately, not run together", () => {
    const graph = commit(seeded([action("Roster")]), [
      action("Ask", { inputs: [{ ref: "ghost.a" }, { ref: "roster.b" }] }),
    ]);
    const detail = checkNamed(graph, "ask", "inputs_resolved").detail;
    expect(detail).toContain("; ");
    expect(detail.split("; ")).toHaveLength(2);
  });

  test("an activity declaring several outputs resolves a ref to ANY of them", () => {
    // `some`, not `every`: a producer with two declared outputs must satisfy a ref to
    // either one. Reading it as `every` would reject every multi-output activity.
    const base = commit(
      seeded([
        action("Roster", {
          outputs: [
            { name: "a", type: "string" },
            { name: "b", type: "string" },
          ],
        }),
      ]),
      [action("Ask", { inputs: [{ ref: "roster.b" }] })],
    );
    const graph = commit(base, [
      { op: "record_output", node: "roster", output_name: "b", value: 1, evidence_ref: "e" },
    ]);
    expect(checkNamed(graph, "ask", "inputs_resolved").ok).toBe(true);
  });

  test("blocked-on details list each blocker", () => {
    const graph = commit(seeded([action("A"), action("B"), action("C")]), [
      { op: "add_edge", from: "a", to: "c" },
      { op: "add_edge", from: "b", to: "c" },
    ]);
    expect(checkNamed(graph, "c", "dependencies_satisfied").detail).toBe(
      `waiting on '${nid(graph, "a")}'; waiting on '${nid(graph, "b")}'`,
    );
  });
});
