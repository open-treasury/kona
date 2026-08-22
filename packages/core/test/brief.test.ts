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
  nodeIdFromCorrelation,
  pursuitConfig,
  waitAddresses,
} from "../src/index.ts";
import { commit, record, rostered, seeded, task, wait } from "./fixtures.ts";

const IDENTITY: Identity = {
  mailbox: "ilya@example.com",
  display_name: "Ilya Vorobiev",
  signature: "— Ilya",
  authority: "You may not commit funds.",
};
const CONFIG: PursuitConfig = { identity: IDENTITY, effect_budget: 12 };

function pivot(label: string, extra: Record<string, unknown> = {}): AuthoredOp {
  return task(label, {
    effect_class: "pivot",
    effect: { channel: "email", recipient_ref: "roster#dana" },
    ...extra,
  });
}

function briefOf(graph: Graph, id: string, config: PursuitConfig = CONFIG) {
  const result = buildBrief(graph, id, config);
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
  return result.brief;
}

function checkNamed(graph: Graph, id: string, name: string, config: PursuitConfig = CONFIG) {
  const check = briefOf(graph, id, config).preconditions_satisfied.checks.find((c) => c.name === name);
  if (check === undefined) throw new Error(`no check '${name}'`);
  return check;
}

describe("correlation derives from the node id (§6.5)", () => {
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
    const arms = ["ask-dana", "ask-sam", "ask-priya"].map(
      (id) => deriveCorrelation("ilya@example.com", id),
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
    // bounce, so the wait behind it would sit armed until its deadline.
    expect(deriveCorrelation("a@b@example.com", "n").ok).toBe(false);
  });

  test("the inverse recovers the node id, and only from a Kona tag", () => {
    expect(nodeIdFromCorrelation("ilya+kona-ask-dana@example.com")).toBe("ask-dana");
    expect(nodeIdFromCorrelation("ilya@example.com")).toBeNull();
    expect(nodeIdFromCorrelation("ilya+newsletter@example.com")).toBeNull();
    expect(nodeIdFromCorrelation("ilya+kona-@example.com")).toBeNull();
  });

  test("it round-trips for every id the store can mint", () => {
    for (const id of ["a", "ask-dana", "ask-dana-2", "0", "x".repeat(48)]) {
      const derived = deriveCorrelation("ilya@example.com", id);
      expect(derived.ok && nodeIdFromCorrelation(derived.correlation.reply_to)).toBe(id);
    }
  });
});

describe("the reply address is the WAIT's, not the sender's (§6.5)", () => {
  /**
   * The bug this pins, which only an end-to-end run could show.
   *
   * `brief` derived the correlation from the SENDING node's id, so an executor was handed
   * `ilya+kona-ask-dana@…`. `waitAddresses` and `matchInbound` derive it from the WAIT's id
   * and look for `ilya+kona-wait-for-dana@…`. Both halves had passing unit tests — each was
   * self-consistent — and every reply in a real run would have arrived correlated to nothing.
   *
   * §6.5 shows the token twice with the same literal, on the effect node and on the wait: one
   * conversation, one token. The wait is the end that has to own it, because `record_outcome`
   * targets the wait and because a send can be superseded while the wait behind it survives —
   * and "a token that changes across executions goes stale in someone's inbox".
   */
  const wired = (extra: AuthoredOp[] = [], edges: AuthoredOp[] = []): Graph =>
    commit(rostered(["dana"], [pivot("Ask Dana"), wait("Wait for Dana"), ...extra]), [
      { op: "add_edge", from: "ask-dana", to: "wait-for-dana" },
      ...edges,
    ] as AuthoredOp[]);

  test("the address brief hands out is the one poll will look for", () => {
    const graph = wired();
    const handed = briefOf(graph, "ask-dana").correlation?.reply_to ?? "";
    const polled = waitAddresses(graph, IDENTITY.mailbox).map((a) => a.address);
    // The whole claim, in one line: what the executor puts in `Reply-To` is what the poller
    // will be watching for.
    expect(polled).toContain(handed);
  });

  test("and a reply to it matches the wait, end to end", () => {
    const graph = wired();
    const replyTo = briefOf(graph, "ask-dana").correlation?.reply_to ?? "";
    const matches = matchInbound(graph, IDENTITY.mailbox, [
      { message_id: "<m-1@mail>", from: "dana@example.com", to: [replyTo] },
    ]);
    expect(matches.map((match) => match.node_id)).toEqual(["wait-for-dana"]);
  });

  test("nothing waiting means no reply address, and that is not a failure", () => {
    // A fire-and-forget send — a follow-up nobody is expected to answer. An address that
    // routes to no wait would be worse than none: a reply would arrive and match nothing.
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
    const graph = wired([wait("Wait again")], [{ op: "add_edge", from: "ask-dana", to: "wait-again" }]);
    const check = checkNamed(graph, "ask-dana", "correlation_expanded");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("wait-for-dana, wait-again");
    expect(briefOf(graph, "ask-dana").correlation).toBeNull();
    // And the brief as a whole refuses, so nothing dispatches on a guess.
    expect(briefOf(graph, "ask-dana").preconditions_satisfied.ok).toBe(false);
  });

  test("a superseded wait does not claim the address its replacement should own", () => {
    const graph = wired([wait("Wait again")], [
      { op: "add_edge", from: "ask-dana", to: "wait-again" },
      { op: "supersede_node", node: "wait-for-dana", by: "wait-again" },
    ]);
    expect(briefOf(graph, "ask-dana").correlation?.reply_to).toBe(
      "ilya+kona-wait-again@example.com",
    );
  });

  test("only an EVENT wait takes mail — a predicate wait has no inbox", () => {
    const graph = commit(
      rostered(["dana"], [
        pivot("Ask Dana"),
        wait("Quorum", {
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
      ]),
      [{ op: "add_edge", from: "ask-dana", to: "quorum" }] as AuthoredOp[],
    );
    expect(briefOf(graph, "ask-dana").correlation).toBeNull();
  });
});

describe("brief refuses rather than guessing (§6.9)", () => {
  test("a node that does not exist", () => {
    const result = buildBrief(seeded([task("A")]), "ghost", CONFIG);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("UNKNOWN_NODE");
  });

  test("a SENDING node with no identity — an executor cannot speak for someone unnamed", () => {
    const graph = rostered(["dana"], [
      task("Ask Dana", {
        effect_class: "pivot",
        effect: { channel: "email", recipient_ref: "roster#dana" },
      }),
    ]);
    const result = buildBrief(graph, "ask-dana", {});
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("NO_IDENTITY");
    // The refusal names the recipient, so the reader knows which send it is standing in front of.
    expect(!result.ok && result.message).toContain("roster#dana");
  });

  test("a PURE node needs none — there is nobody to speak for", () => {
    // Refusing this made effect-free pursuits unusable without inventing a mailbox nobody
    // reads, and §6.2 makes `effect_class: "pure"` first-class rather than degenerate. The
    // correlation check already says the true thing in words.
    const result = buildBrief(seeded([task("A")]), "a", {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.brief.identity).toBeNull();
    expect(result.brief.preconditions_satisfied.ok).toBe(true);
    expect(
      result.brief.preconditions_satisfied.checks.find((c) => c.name === "correlation_expanded")
        ?.detail,
    ).toBe("node sends nothing, so it needs no reply address");
  });
});

describe("preconditions FAIL CLOSED", () => {
  test("a fully ready pure node satisfies everything", () => {
    expect(briefOf(seeded([task("A")]), "a").preconditions_satisfied.ok).toBe(true);
  });

  test("a blocked node fails on its dependency, naming what it waits on", () => {
    const graph = commit(seeded([task("A"), task("B")]), [{ op: "add_edge", from: "a", to: "b" }]);
    const check = checkNamed(graph, "b", "dependencies_satisfied");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("'a'");
  });

  test.each([
    ["in_flight", false],
    ["done", false],
    ["failed", false],
    ["dropped", false],
    ["active", true],
  ])("a node in state '%s' is dispatchable: %s", (state, expected) => {
    const graph = commit(seeded([task("A")]), [
      { op: "set_status", node: "a", status: state, evidence_ref: "e" } as AuthoredOp,
    ]);
    expect(checkNamed(graph, "a", "node_live").ok).toBe(expected);
  });

  test("a superseded node is not dispatchable even while active", () => {
    const graph = commit(seeded([task("A")]), [task("A prime"), { op: "supersede_node", node: "a", by: "$0" }]);
    expect(checkNamed(graph, "a", "node_live").ok).toBe(false);
  });

  test("an input whose producer has not produced yet is UNRESOLVED, not absent", () => {
    // This is the failure the brief probe found: every `inputs[].ref` dangled because no
    // node declared an `output`, and 0 of 8 subagents could execute.
    const graph = commit(seeded([task("Roster")]), [
      task("Ask", { inputs: [{ ref: "roster.reply" }] }),
    ]);
    const check = checkNamed(graph, "ask", "inputs_resolved");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("not produced yet");
  });

  test.each([
    ["a producer that does not exist", "ghost.reply", "no node"],
    ["an output nobody declared", "roster.nope", "declares no"],
    ["a ref that is not <node>.<output>", "roster", "not <node>.<output>"],
    ["a ref starting with a dot", ".reply", "not <node>.<output>"],
  ])("%s is unresolved", (_name, ref, expected) => {
    const graph = commit(seeded([task("Roster")]), [task("Ask", { inputs: [{ ref }] })]);
    expect(checkNamed(graph, "ask", "inputs_resolved").detail).toContain(expected);
  });

  test("a produced input resolves", () => {
    const graph = commit(
      commit(seeded([task("Roster")]), [task("Ask", { inputs: [{ ref: "roster.reply" }] })]),
      [{ op: "record_output", node: "roster", output_name: "reply", value: "dana,sam", evidence_ref: "e" }],
    );
    expect(checkNamed(graph, "ask", "inputs_resolved").ok).toBe(true);
    expect(briefOf(graph, "ask").subgraph.upstream).toEqual([]);
  });

  test("a node that has already sent fails the slot check", () => {
    const key = "ek_1";
    const sent = commit(
      commit(rostered(["dana"], [pivot("Ask Dana")]), [
        { op: "set_status", node: "ask-dana", status: "in_flight", evidence_ref: encodeReserveEvidence(key, "h") },
      ]),
      [{ op: "set_status", node: "ask-dana", status: "done", evidence_ref: encodeRecordEvidence(key, "sent", "<m-1>") }],
    );
    expect(checkNamed(sent, "ask-dana", "effect_slot_unfired").ok).toBe(false);
  });
});

describe("the budget check fails closed on an UNKNOWN cap", () => {
  test("an unconfigured budget blocks an effect node", () => {
    // An unknown cap is not an unlimited one. This is the only thing standing between a
    // mutator and two hundred emails, now that max_reattempts is gone.
    const check = checkNamed(rostered(["dana"], [pivot("Ask Dana")]), "ask-dana", "budget_remaining", {
      identity: IDENTITY,
    });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("unknown cap is not an unlimited one");
  });

  test("but never blocks a node that sends nothing", () => {
    expect(checkNamed(seeded([task("A")]), "a", "budget_remaining", { identity: IDENTITY }).ok).toBe(true);
  });

  test("counts sends across the whole pursuit, not just this node", () => {
    const key = "ek_1";
    const graph = commit(
      commit(rostered(["dana", "sam"], [pivot("Ask Dana"), pivot("Ask Sam")]), [
        { op: "set_status", node: "ask-dana", status: "in_flight", evidence_ref: encodeReserveEvidence(key, "h") },
      ]),
      [{ op: "set_status", node: "ask-dana", status: "done", evidence_ref: encodeRecordEvidence(key, "sent", "<m-1>") }],
    );
    expect(checkNamed(graph, "ask-sam", "budget_remaining", { identity: IDENTITY, effect_budget: 2 }).detail)
      .toBe("1 of 2 irreversible sends used");
  });

  test("a spent budget blocks the next send", () => {
    const key = "ek_1";
    const graph = commit(
      commit(rostered(["dana", "sam"], [pivot("Ask Dana"), pivot("Ask Sam")]), [
        { op: "set_status", node: "ask-dana", status: "in_flight", evidence_ref: encodeReserveEvidence(key, "h") },
      ]),
      [{ op: "set_status", node: "ask-dana", status: "done", evidence_ref: encodeRecordEvidence(key, "sent", "<m-1>") }],
    );
    expect(checkNamed(graph, "ask-sam", "budget_remaining", { identity: IDENTITY, effect_budget: 1 }).ok).toBe(false);
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
    rostered(["dana"], [task("Roster"), pivot("Ask Dana"), wait("Wait for Dana")]),
    [
      { op: "add_edge", from: "roster", to: "ask-dana", condition: { on: "satisfied" } },
      { op: "add_edge", from: "ask-dana", to: "wait-for-dana" },
    ],
  );

  test("the correlation is FULLY EXPANDED — a template variable correlates nothing", () => {
    const brief = briefOf(graph, "ask-dana");
    expect(brief.correlation?.reply_to).toBe("ilya+kona-wait-for-dana@example.com");
    expect(brief.correlation?.reply_to).not.toContain("{");
    expect(brief.correlation?.reply_to).not.toContain("$");
  });

  test("a node that sends nothing gets no reply address", () => {
    expect(briefOf(graph, "roster").correlation).toBeNull();
  });

  test("the immediate neighbourhood, with edge conditions and upstream outputs", () => {
    const brief = briefOf(graph, "ask-dana");
    expect(brief.subgraph.upstream).toEqual([
      { id: "roster", label: "Roster", state: "active", condition: "satisfied", output: null },
    ]);
    expect(briefOf(graph, "roster").subgraph.downstream).toEqual([
      { id: "ask-dana", label: "Ask Dana", condition: "satisfied" },
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
      "on_timeout",
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
   * and every test still passed — which means no test had a node whose in-edge was actually
   * SATISFIED. Every one of them was blocked. And `ok: spent < budget` could be replaced with
   * `ok: false` unnoticed, because nothing asserted an effect node passing its budget check.
   *
   * Both are the same shape of gap, and it is the dangerous shape: a fail-closed gate whose
   * OPEN path nobody exercises is a gate that could be closed forever and look correct. The
   * probes measured that exact failure — an invariant rejecting correct work five times in
   * ten — so "it refuses the bad thing" is only half a test.
   */
  const satisfied = commit(
    rostered(["dana"], [task("Roster"), pivot("Ask Dana"), wait("Wait for Dana")]),
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
      { op: "set_status", node: "roster", status: "done", evidence_ref: "roster.csv#v3" },
    ] as AuthoredOp[],
  );

  test("a satisfied in-edge does not block, and says so", () => {
    const check = checkNamed(satisfied, "ask-dana", "dependencies_satisfied");
    expect(check.ok).toBe(true);
    expect(check.detail).toBe("every blocking in-edge has a terminal-success source");
  });

  test("an effect node with budget left passes the budget check", () => {
    const check = checkNamed(satisfied, "ask-dana", "budget_remaining");
    expect(check.ok).toBe(true);
    expect(check.detail).toBe("0 of 12 irreversible sends used");
  });

  test("and the whole brief is dispatchable — every check green at once", () => {
    // The state an executor is actually handed. Nothing in this suite asserted it existed.
    const brief = briefOf(satisfied, "ask-dana");
    expect(brief.preconditions_satisfied.checks.filter((check) => !check.ok)).toEqual([]);
    expect(brief.preconditions_satisfied.ok).toBe(true);
    expect(brief.correlation?.reply_to).toBe("ilya+kona-wait-for-dana@example.com");
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
    ["node_live", "state 'active'"],
    ["dependencies_satisfied", "every blocking in-edge has a terminal-success source"],
    ["inputs_resolved", "every input resolves to a recorded output"],
    ["effect_slot_unfired", "no send recorded"],
    ["correlation_expanded", "node sends nothing, so it needs no reply address"],
    ["budget_remaining", "node sends nothing"],
  ])("%s on a clean pure node reads '%s'", (name, detail) => {
    expect(checkNamed(seeded([task("A")]), "a", name).detail).toBe(detail);
  });

  test("a sent node says so plainly", () => {
    const key = "ek_1";
    const sent = commit(
      commit(rostered(["dana"], [pivot("Ask Dana")]), [
        { op: "set_status", node: "ask-dana", status: "in_flight", evidence_ref: encodeReserveEvidence(key, "h") },
      ]),
      [{ op: "set_status", node: "ask-dana", status: "done", evidence_ref: encodeRecordEvidence(key, "sent", "<m-1>") }],
    );
    expect(checkNamed(sent, "ask-dana", "effect_slot_unfired").detail).toBe(
      "this node has already moved bytes",
    );
  });

  test("an effect node names the address replies will correlate to, and whose it is", () => {
    const graph = commit(rostered(["dana"], [pivot("Ask Dana"), wait("Wait for Dana")]), [
      { op: "add_edge", from: "ask-dana", to: "wait-for-dana" },
    ]);
    expect(checkNamed(graph, "ask-dana", "correlation_expanded").detail).toBe(
      "replies correlate to ilya+kona-wait-for-dana@example.com — wait-for-dana",
    );
  });

  test("a superseded node is described as superseded, not merely inactive", () => {
    const graph = commit(seeded([task("A")]), [task("A prime"), { op: "supersede_node", node: "a", by: "$0" }]);
    expect(checkNamed(graph, "a", "node_live").detail).toContain("superseded");
  });

  test("TWO unresolved inputs are listed separately, not run together", () => {
    const graph = commit(seeded([task("Roster")]), [
      task("Ask", { inputs: [{ ref: "ghost.a" }, { ref: "roster.b" }] }),
    ]);
    const detail = checkNamed(graph, "ask", "inputs_resolved").detail;
    expect(detail).toContain("; ");
    expect(detail.split("; ")).toHaveLength(2);
  });

  test("a node declaring several outputs resolves a ref to ANY of them", () => {
    // `some`, not `every`: a producer with two declared outputs must satisfy a ref to
    // either one. Reading it as `every` would reject every multi-output node.
    const base = commit(
      seeded([task("Roster", { outputs: [{ name: "a", type: "string" }, { name: "b", type: "string" }] })]),
      [task("Ask", { inputs: [{ ref: "roster.b" }] })],
    );
    const graph = commit(base, [
      { op: "record_output", node: "roster", output_name: "b", value: 1, evidence_ref: "e" },
    ]);
    expect(checkNamed(graph, "ask", "inputs_resolved").ok).toBe(true);
  });

  test("blocked-on details list each blocker", () => {
    const graph = commit(seeded([task("A"), task("B"), task("C")]), [
      { op: "add_edge", from: "a", to: "c" },
      { op: "add_edge", from: "b", to: "c" },
    ]);
    expect(checkNamed(graph, "c", "dependencies_satisfied").detail).toBe(
      "waiting on 'a'; waiting on 'b'",
    );
  });
});
