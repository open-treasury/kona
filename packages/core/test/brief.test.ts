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
  nodeIdFromCorrelation,
  pursuitConfig,
} from "../src/index.ts";
import { commit, record, seeded, task } from "./fixtures.ts";

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

describe("brief refuses rather than guessing (§6.9)", () => {
  test("a node that does not exist", () => {
    const result = buildBrief(seeded([task("A")]), "ghost", CONFIG);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("UNKNOWN_NODE");
  });

  test("a pursuit with no identity — an executor cannot speak for someone unnamed", () => {
    const result = buildBrief(seeded([task("A")]), "a", {});
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("NO_IDENTITY");
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
    ["sending", false],
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
      commit(seeded([pivot("Ask Dana")]), [
        { op: "set_status", node: "ask-dana", status: "sending", evidence_ref: encodeReserveEvidence(key, "h") },
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
    const check = checkNamed(seeded([pivot("Ask Dana")]), "ask-dana", "budget_remaining", {
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
      commit(seeded([pivot("Ask Dana"), pivot("Ask Sam")]), [
        { op: "set_status", node: "ask-dana", status: "sending", evidence_ref: encodeReserveEvidence(key, "h") },
      ]),
      [{ op: "set_status", node: "ask-dana", status: "done", evidence_ref: encodeRecordEvidence(key, "sent", "<m-1>") }],
    );
    expect(checkNamed(graph, "ask-sam", "budget_remaining", { identity: IDENTITY, effect_budget: 2 }).detail)
      .toBe("1 of 2 irreversible sends used");
  });

  test("a spent budget blocks the next send", () => {
    const key = "ek_1";
    const graph = commit(
      commit(seeded([pivot("Ask Dana"), pivot("Ask Sam")]), [
        { op: "set_status", node: "ask-dana", status: "sending", evidence_ref: encodeReserveEvidence(key, "h") },
      ]),
      [{ op: "set_status", node: "ask-dana", status: "done", evidence_ref: encodeRecordEvidence(key, "sent", "<m-1>") }],
    );
    expect(checkNamed(graph, "ask-sam", "budget_remaining", { identity: IDENTITY, effect_budget: 1 }).ok).toBe(false);
  });

  test("a budget of zero forbids the first send", () => {
    expect(
      checkNamed(seeded([pivot("Ask Dana")]), "ask-dana", "budget_remaining", {
        identity: IDENTITY,
        effect_budget: 0,
      }).ok,
    ).toBe(false);
  });
});

describe("what the brief carries", () => {
  const graph = commit(seeded([task("Roster"), pivot("Ask Dana")]), [
    { op: "add_edge", from: "roster", to: "ask-dana", condition: { on: "satisfied" } },
  ]);

  test("the correlation is FULLY EXPANDED — a template variable correlates nothing", () => {
    const brief = briefOf(graph, "ask-dana");
    expect(brief.correlation?.reply_to).toBe("ilya+kona-ask-dana@example.com");
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
      commit(seeded([pivot("Ask Dana")]), [
        { op: "set_status", node: "ask-dana", status: "sending", evidence_ref: encodeReserveEvidence(key, "h") },
      ]),
      [{ op: "set_status", node: "ask-dana", status: "done", evidence_ref: encodeRecordEvidence(key, "sent", "<m-1>") }],
    );
    expect(checkNamed(sent, "ask-dana", "effect_slot_unfired").detail).toBe(
      "this node has already moved bytes",
    );
  });

  test("an effect node names the address replies will correlate to", () => {
    expect(checkNamed(seeded([pivot("Ask Dana")]), "ask-dana", "correlation_expanded").detail).toBe(
      "replies correlate to ilya+kona-ask-dana@example.com",
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
