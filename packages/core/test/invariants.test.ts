/**
 * Invariant 2, invariant 3(b)'s grammar, and the two parser-class refusals §6.7 files under
 * "the parser first, free" but that zod cannot express.
 *
 * §7: "one test per invariant asserting **rejection with the right reason**." Each block
 * below names the mutant it kills, because `validate()` carries a mutation-score floor of 100.
 */

import { describe, expect, test } from "bun:test";
import type { AuthoredOp, Graph, Node, Result, Verdict } from "../src/index.ts";
import {
  checkInvariant2,
  countPredicate,
  isReady,
  parseCountPredicate,
  parseRecipientRef,
  readyFrontier,
  validate,
} from "../src/index.ts";
import { ORCHESTRATOR, SUBAGENT, commit, rostered, seeded, task, wait } from "./fixtures.ts";

function attempt(graph: Graph, ops: AuthoredOp[], actor = ORCHESTRATOR) {
  return validate({ graph, ops, actor, version: graph.version + 1 });
}

function rejection<T>(result: Result<T>) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  return result.rejection;
}

function accepted<T>(result: Result<T>) {
  if (!result.ok) throw new Error(`unexpectedly rejected: ${result.rejection.message}`);
  return result.value;
}

function nodeOf(graph: Graph, id: string): Node {
  const node = graph.nodes.get(id);
  if (node === undefined) throw new Error(`no node ${id}`);
  return node;
}

function outcome(node: string, verdict: Verdict, attrs?: Record<string, unknown>): AuthoredOp {
  return {
    op: "record_outcome",
    node,
    verdict,
    evidence_ref: "<m-1>",
    ...(attrs === undefined ? {} : { attrs }),
  };
}

function close(node: string, status = "done"): AuthoredOp {
  return { op: "set_status", node, status, evidence_ref: "<m-1>" } as AuthoredOp;
}

const ONE_CONFIRMED = { count: { verdict: "confirmed" }, op: ">=", n: 1 };

function pivot(recipient: string): AuthoredOp {
  return task("Ask Marcus", {
    effect_class: "pivot",
    effect: { channel: "email", recipient_ref: recipient },
  });
}

/** A wait with one `accept` arm already wired, and an `ignored` task not yet wired to it. */
function gate(): Graph {
  return commit(seeded([task("Accepted"), task("Ignored"), wait("Gate", { on_timeout: "$0" })]), [
    { op: "add_edge", from: "gate", to: "accepted", condition: { on: "accept" } },
  ]);
}

function predicateWait(
  label: string,
  predicate: unknown = ONE_CONFIRMED,
  onTimeout = "$0",
): AuthoredOp {
  return wait(label, {
    on_timeout: onTimeout,
    match: {
      kind: "predicate",
      conditions: [{ kind: "count", on: "satisfied", predicate }],
      memory: true,
    },
  });
}

/**
 * A quorum with two members: `dana` behind an `accept` arm of `gate`, and `sam`, who has
 * already declined. Resolving the gate the other way drops `dana` — but `sam`'s edge is not
 * dead, so the quorum stays OPEN and genuinely becomes unsatisfiable, rather than being
 * closed by the same cascade.
 */
function gatedQuorum(): Graph {
  const wired = commit(
    seeded([
      task("Escalate"),
      task("Dana"),
      task("Sam"),
      predicateWait("Quorum"),
      wait("Gate", { on_timeout: "$0" }),
    ]),
    [
      { op: "add_edge", from: "gate", to: "dana", condition: { on: "accept" } },
      { op: "add_edge", from: "dana", to: "quorum" },
      { op: "add_edge", from: "sam", to: "quorum" },
    ],
  );
  return commit(wired, [outcome("sam", "declined")], SUBAGENT);
}

/** One member, one quorum needing a single `confirmed`. The premise-break shape from §7. */
function quorum(): Graph {
  return commit(seeded([task("Escalate"), task("Dana"), predicateWait("Quorum")]), [
    { op: "add_edge", from: "dana", to: "quorum" },
  ]);
}

describe("the predicate grammar is closed (§6.7)", () => {
  test("the spec's own form parses", () => {
    expect(
      parseCountPredicate({
        count: { verdict: "confirmed", attrs: { role: "goalie" } },
        op: ">=",
        n: 1,
      }),
    ).toEqual({ count: { verdict: "confirmed", attrs: { role: "goalie" } }, op: ">=", n: 1 });
  });

  test("attrs is optional", () => {
    expect(parseCountPredicate(ONE_CONFIRMED)).toEqual({
      count: { verdict: "confirmed" },
      op: ">=",
      n: 1,
    });
  });

  const BAD: [string, unknown][] = [
    ["a non-object", "confirmed"],
    ["null", null],
    ["an array", []],
    ["a comparison other than >=", { count: { verdict: "confirmed" }, op: ">", n: 1 }],
    ["n below 1", { count: { verdict: "confirmed" }, op: ">=", n: 0 }],
    ["a fractional n", { count: { verdict: "confirmed" }, op: ">=", n: 1.5 }],
    ["a non-resolving verdict", { count: { verdict: "tentative" }, op: ">=", n: 1 }],
    ["a verdict that is not one", { count: { verdict: "maybe" }, op: ">=", n: 1 }],
    ["a nested attrs matcher", { count: { verdict: "confirmed", attrs: { a: { b: 1 } } }, op: ">=", n: 1 }],
    ["a null attr", { count: { verdict: "confirmed", attrs: { role: null } }, op: ">=", n: 1 }],
    ["a stray top-level key", { count: { verdict: "confirmed" }, op: ">=", n: 1, extra: 1 }],
    ["a stray key inside count", { count: { verdict: "confirmed", who: "x" }, op: ">=", n: 1 }],
    ["a missing count", { op: ">=", n: 1 }],
  ];

  test.each(BAD)("rejects %s", (_name, value) => {
    expect(parseCountPredicate(value)).toBeNull();
  });

  test("a malformed predicate is refused at commit, not silently unscrutinised", () => {
    const r = rejection(
      attempt(seeded([task("A")]), [
        predicateWait("Quorum", { count: { verdict: "confirmed" }, op: ">", n: 1 }, "a"),
      ]),
    );
    expect(r.code).toBe("REFUSED");
    expect(r.reason).toBe("MALFORMED_PREDICATE");
    expect(r.node).toBe("quorum");
  });

  test("a wait with no predicate arm is untouched by the grammar check", () => {
    expect(attempt(seeded([task("A")]), [wait("Plain", { on_timeout: "a" })]).ok).toBe(true);
  });
});

describe("countPredicate — the three counts (§6.7)", () => {
  const arm = { count: { verdict: "confirmed" as Verdict }, op: ">=" as const, n: 1 };

  function counted(graph: Graph) {
    return countPredicate(graph, nodeOf(graph, "quorum"), arm);
  }

  test("an unresolved member is still live", () => {
    expect(counted(quorum())).toMatchObject({ population: 1, matching_confirmed: 0, still_live: 1, satisfiable: true });
  });

  test("a matching verdict counts as confirmed, and is read from the projection", () => {
    const graph = commit(quorum(), [outcome("dana", "confirmed")]);
    expect(counted(graph)).toMatchObject({ matching_confirmed: 1, still_live: 0, satisfiable: true });
  });

  test("a member resolved but not yet terminal still counts — state is never read", () => {
    const graph = commit(quorum(), [outcome("dana", "confirmed")]);
    expect(nodeOf(graph, "dana").status.state).toBe("active");
    expect(counted(graph).matching_confirmed).toBe(1);
  });

  test("a declining member is neither matching nor live", () => {
    // Committed as a subagent: invariant 2 exempts an actor that cannot author the repair,
    // which is exactly what lets this fixture reach the state under test.
    const graph = commit(quorum(), [outcome("dana", "declined")], SUBAGENT);
    expect(counted(graph)).toMatchObject({ matching_confirmed: 0, still_live: 0, satisfiable: false });
  });

  test("a DROPPED member is excluded — it neither satisfies nor blocks", () => {
    const two = commit(quorum(), [task("Sam"), { op: "add_edge", from: "$0", to: "quorum" }]);
    const graph = commit(two, [close("dana", "dropped")]);
    expect(counted(graph)).toMatchObject({
      population: 2,
      excluded: 1,
      still_live: 1,
      satisfiable: true,
    });
  });

  test("a FAILED member is not live — nothing further will arrive", () => {
    const graph = commit(quorum(), [close("dana", "failed")]);
    expect(counted(graph)).toMatchObject({ excluded: 0, still_live: 0, satisfiable: false });
  });

  test("done-without-a-verdict is still live — the outcome may land next commit", () => {
    const graph = commit(quorum(), [close("dana")]);
    expect(counted(graph).still_live).toBe(1);
  });

  test("sending is live — the world's answer is unknown, not absent", () => {
    const graph = commit(quorum(), [close("dana", "in_flight")]);
    expect(counted(graph).still_live).toBe(1);
  });

  test("a tentative-only member is live — tentative records without resolving", () => {
    const graph = commit(quorum(), [outcome("dana", "tentative")]);
    expect(counted(graph)).toMatchObject({ matching_confirmed: 0, still_live: 1 });
  });

  test("a member wired both bare and conditioned counts once", () => {
    const graph = commit(quorum(), [
      { op: "add_edge", from: "dana", to: "quorum", condition: { on: "satisfied" } },
    ]);
    expect(graph.edges.filter((e) => e.to === "quorum")).toHaveLength(2);
    expect(counted(graph).population).toBe(1);
  });

  test("attrs match as a subset — the outcome may carry more than the predicate asks", () => {
    const withAttrs = { count: { verdict: "confirmed" as Verdict, attrs: { role: "goalie" } }, op: ">=" as const, n: 1 };
    const yes = commit(quorum(), [outcome("dana", "confirmed", { role: "goalie", kit: "green" })]);
    const no = commit(quorum(), [outcome("dana", "confirmed", { role: "striker" })]);
    expect(countPredicate(yes, nodeOf(yes, "quorum"), withAttrs).matching_confirmed).toBe(1);
    expect(countPredicate(no, nodeOf(no, "quorum"), withAttrs).matching_confirmed).toBe(0);
  });

  test("a missing attr does not match", () => {
    const withAttrs = { count: { verdict: "confirmed" as Verdict, attrs: { role: "goalie" } }, op: ">=" as const, n: 1 };
    const graph = commit(quorum(), [outcome("dana", "confirmed")]);
    expect(countPredicate(graph, nodeOf(graph, "quorum"), withAttrs).matching_confirmed).toBe(0);
  });

  test("the threshold is >= and not >", () => {
    const graph = commit(quorum(), [outcome("dana", "confirmed")]);
    expect(countPredicate(graph, nodeOf(graph, "quorum"), { ...arm, n: 1 }).satisfiable).toBe(true);
    expect(countPredicate(graph, nodeOf(graph, "quorum"), { ...arm, n: 2 }).satisfiable).toBe(false);
  });
});

describe("invariant 2 — predicate-waits stay satisfiable", () => {
  /** §7's premise break: the only goalie declines. */
  test("the last live member declining is REFUSED, naming the wait", () => {
    const r = rejection(attempt(quorum(), [outcome("dana", "declined")]));
    expect(r.code).toBe("INVARIANT_VIOLATION");
    expect(r.invariant).toBe(2);
    expect(r.reason).toBe("PREDICATE_UNSATISFIABLE");
    expect(r.node).toBe("quorum");
    // A post-state predicate cannot honestly name an op; guessing one would mislead.
    expect(r.op_index).toBeUndefined();
  });

  test("the same batch carrying a wired replacement is ACCEPTED", () => {
    expect(
      attempt(quorum(), [
        outcome("dana", "declined"),
        task("Marcus"),
        { op: "add_edge", from: "$1", to: "quorum" },
      ]).ok,
    ).toBe(true);
  });

  test("the same batch superseding the wait is ACCEPTED", () => {
    expect(attempt(quorum(), [outcome("dana", "declined"), { op: "supersede_node", node: "quorum" }]).ok).toBe(true);
  });

  test("closing the wait as timed_out is ACCEPTED", () => {
    expect(attempt(quorum(), [outcome("dana", "declined"), outcome("quorum", "timed_out")]).ok).toBe(true);
  });

  /**
   * The mutant that matters most. Read as a plain state predicate, invariant 2 would refuse
   * EVERY later commit once a wait went unsatisfiable — the pursuit would have no legal move
   * left, which is a worse wedge than the bad graph the invariant exists to prevent.
   */
  test("a wait already unsatisfiable at head does not block unrelated commits", () => {
    const broken = commit(quorum(), [outcome("dana", "declined"), { op: "supersede_node", node: "quorum" }]);
    // Re-break it without the supersede, by hand, so head carries an unsatisfiable open wait.
    const stuck = commit(seeded([task("Escalate"), task("Dana"), predicateWait("Quorum")]), [
      { op: "add_edge", from: "dana", to: "quorum" },
    ]);
    const wedged = commit(stuck, [close("dana", "failed")], ORCHESTRATOR);
    expect(attempt(wedged, [task("Unrelated")]).ok).toBe(true);
    expect(attempt(broken, [task("Unrelated")]).ok).toBe(true);
  });

  test("a batch that does not break anything is ACCEPTED", () => {
    expect(attempt(quorum(), [outcome("dana", "confirmed")]).ok).toBe(true);
  });

  test("breaking one of two members leaves it satisfiable", () => {
    const two = commit(quorum(), [task("Sam"), { op: "add_edge", from: "$0", to: "quorum" }]);
    expect(attempt(two, [outcome("dana", "declined")]).ok).toBe(true);
  });

  /** Q2 — every remedy the message names is a topology op, and a subagent may write none. */
  test("a subagent recording a decline is ACCEPTED — it cannot author the repair", () => {
    expect(attempt(quorum(), [outcome("dana", "declined")], SUBAGENT).ok).toBe(true);
  });

  test("a mechanically-determined closure is ACCEPTED — resume has no model to re-plan with", () => {
    expect(attempt(quorum(), [outcome("dana", "timed_out")]).ok).toBe(true);
    expect(attempt(quorum(), [outcome("dana", "bounced")]).ok).toBe(true);
    expect(attempt(quorum(), [close("dana", "failed")]).ok).toBe(true);
  });

  test("but a decline riding along with a timeout is still REFUSED", () => {
    const two = commit(quorum(), [task("Sam"), { op: "add_edge", from: "$0", to: "quorum" }]);
    const r = rejection(attempt(two, [outcome("dana", "timed_out"), outcome("sam", "declined")]));
    expect(r.reason).toBe("PREDICATE_UNSATISFIABLE");
  });

  test("a non-predicate wait is never judged", () => {
    const plain = commit(seeded([task("Escalate"), task("Dana"), wait("Plain", { on_timeout: "$0" })]), [
      { op: "add_edge", from: "dana", to: "plain" },
    ]);
    expect(attempt(plain, [outcome("dana", "declined")]).ok).toBe(true);
  });

  test("checkInvariant2 is happy with an empty batch", () => {
    const graph = quorum();
    expect(checkInvariant2(graph, graph, ORCHESTRATOR, []).ok).toBe(true);
  });

  test("the message names the counts and the remedy", () => {
    const r = rejection(attempt(quorum(), [outcome("dana", "declined")]));
    expect(r.message).toContain("0 matching + 0 still live of 1 blocking in-edges");
    expect(r.message).toContain("supersede the wait");
  });

  /** Branch resolution's own drops are ops in the log; exempting them hides the cause. */
  test("a derived drop that breaks a quorum is named in the rejection", () => {
    const r = rejection(attempt(gatedQuorum(), [outcome("gate", "ignore"), close("gate")]));
    expect(r.reason).toBe("PREDICATE_UNSATISFIABLE");
    expect(r.message).toContain("branch resolution dropped dana");
  });

  /**
   * The counterpart. When the cascade drops the WAIT itself, the wait is closed, not broken —
   * refusing there would leave `kona resume` no legal batch, since its own housekeeping would
   * be the thing demanding a repair it cannot author.
   */
  test("a wait the cascade itself dropped is closed, not broken", () => {
    const soleMember = commit(
      seeded([task("Escalate"), task("Dana"), predicateWait("Quorum"), wait("Gate", { on_timeout: "$0" })]),
      [
        { op: "add_edge", from: "gate", to: "dana", condition: { on: "accept" } },
        { op: "add_edge", from: "dana", to: "quorum" },
      ],
    );
    const value = accepted(attempt(soleMember, [outcome("gate", "ignore"), close("gate")]));
    expect(value.derived.map((op) => op.op === "set_status" && op.node)).toEqual(["dana", "quorum"]);
  });
});

describe("invariant 3(b) — recipient refs are refs, not addresses (§6.2)", () => {
  const GOOD = ["roster.contacts#dana", "roster#dana", "a.b.c#x-9", "roster_2.contacts#sam"];
  test.each(GOOD)("'%s' parses", (raw) => {
    expect(parseRecipientRef(raw)).not.toBeNull();
  });

  // The shapes the mutator actually produced at n=60.
  const BAD = ["person:club-reserve/goalie-1", "roster.bench[0..5]", "a#b#c", "dana", "#dana", "roster#", "Roster#Dana"];
  test.each(BAD)("'%s' does not", (raw) => {
    expect(parseRecipientRef(raw)).toBeNull();
  });

  test("a fabricated recipient is refused, naming the node", () => {
    const r = rejection(attempt(seeded([task("A")]), [pivot("person:club-reserve/goalie-1")]));
    expect(r.code).toBe("REFUSED");
    expect(r.reason).toBe("MALFORMED_RECIPIENT_REF");
    expect(r.node).toBe("ask-marcus");
    expect(r.op_index).toBe(0);
  });

  /**
   * A literal address is the one malformed shape that would otherwise WORK, so it gets its
   * own reason. Neither shares a token with UNEVIDENCED_RECIPIENT: §6.9's human gate keys on
   * that alone, and "route this to a human" must never mean "the model wrote a bad string".
   */
  test("a literal address gets its own reason", () => {
    const r = rejection(attempt(seeded([task("A")]), [pivot("marcus@club.org")]));
    expect(r.reason).toBe("LITERAL_RECIPIENT_ADDRESS");
    expect(r.message).toContain("literal address");
  });

  test("a well-formed ref to somebody the graph HAS heard of passes", () => {
    expect(attempt(rostered(["dana"]), [pivot("roster.contacts#dana")]).ok).toBe(true);
  });

  test("a well-formed ref to somebody it has NOT is the one human gate", () => {
    // This test used to assert the opposite, and was right to: only the grammar half had
    // shipped, so spelling `roster.contacts#dana` correctly was the whole check. The
    // resolution half is what §6.7 actually writes — "resolves to an entity already in the
    // graph carrying an evidence_ref" — and it is what stops a mutator that has spelled an
    // invented person correctly.
    const r = rejection(attempt(seeded([task("A")]), [pivot("roster.contacts#dana")]));
    expect(r.reason).toBe("UNEVIDENCED_RECIPIENT");
    expect(r.message).toContain("nothing in the graph attests to 'dana'");
  });

  test("the scope is not part of the match — filing is the author's choice", () => {
    // `roster.contacts#dana` and `players#dana` name one person. Refusing on the scope
    // would reject a correct recipient for being filed differently.
    expect(attempt(rostered(["dana"]), [pivot("players#dana")]).ok).toBe(true);
  });

  test("a counterparty's referral is evidence — that is what makes a chain work", () => {
    // Sam cannot play and names Marcus, in a message with an id. Marcus becomes contactable
    // because SAM said so, not because the model thought of him.
    const referred = commit(rostered(["sam"]), [
      { op: "record_outcome", node: "confirm-roster", verdict: "declined",
        evidence_ref: "<m-202@mail>", attrs: { referral: "marcus" } },
    ]);
    expect(attempt(referred, [pivot("roster.contacts#marcus")]).ok).toBe(true);
  });

  test("evidence must predate the batch — a self-vouching commit is refused", () => {
    // §6.7: "a recipient existing only in the proposing batch is rejected". Resolving
    // against post-commit state would let the same mutator that invented Marcus also
    // invent the record that vouches for him.
    const r = rejection(
      attempt(seeded([task("Roster", { outputs: [{ name: "list", type: "string[]" }] })]), [
        { op: "record_output", node: "roster", output_name: "list", value: ["marcus"],
          evidence_ref: "made-up" },
        pivot("roster.contacts#marcus"),
      ]),
    );
    expect(r.reason).toBe("UNEVIDENCED_RECIPIENT");
  });

  test("a pure node carries no effect and is never checked", () => {
    expect(attempt(seeded([task("A")]), [task("Plain")]).ok).toBe(true);
  });
});

describe("parser-class refusals zod cannot express (§6.7)", () => {
  test("an unconditioned out-edge of a wait is refused", () => {
    const r = rejection(attempt(gate(), [{ op: "add_edge", from: "gate", to: "ignored" }]));
    expect(r.code).toBe("REFUSED");
    expect(r.reason).toBe("UNCONDITIONED_WAIT_EDGE");
    expect(r.node).toBe("gate");
    expect(r.message).toContain("fire the branch unapproved");
  });

  test("including when the wait is created by an earlier op of the same batch", () => {
    const r = rejection(
      attempt(seeded([task("A")]), [
        wait("Fresh", { on_timeout: "a" }),
        task("Downstream"),
        { op: "add_edge", from: "$0", to: "$1" },
      ]),
    );
    expect(r.reason).toBe("UNCONDITIONED_WAIT_EDGE");
    expect(r.node).toBe("fresh");
  });

  test("an unconditioned edge INTO a wait is fine — the rule is about out-edges", () => {
    expect(attempt(gate(), [{ op: "add_edge", from: "accepted", to: "gate" }]).ok).toBe(true);
  });

  test("an unconditioned edge between two tasks is fine", () => {
    expect(attempt(gate(), [{ op: "add_edge", from: "accepted", to: "ignored" }]).ok).toBe(true);
  });

  test("an edge born dead against an already-resolved wait is refused", () => {
    const resolved = commit(gate(), [outcome("gate", "accept"), close("gate")]);
    const r = rejection(
      attempt(resolved, [{ op: "add_edge", from: "gate", to: "ignored", condition: { on: "ignore" } }]),
    );
    expect(r.code).toBe("REFUSED");
    expect(r.reason).toBe("DEAD_ON_ARRIVAL_EDGE");
    expect(r.node).toBe("ignored");
    expect(r.message).toContain("can never fire");
  });

  /**
   * The commit-boundary regression. Authored as one batch or two, the same ops must produce
   * the same outcome — otherwise the graph is a function of when someone pressed commit.
   */
  test("and refused identically when the killing ops are in the SAME batch", () => {
    const r = rejection(
      attempt(gate(), [
        outcome("gate", "accept"),
        close("gate"),
        { op: "add_edge", from: "gate", to: "ignored", condition: { on: "ignore" } },
      ]),
    );
    expect(r.reason).toBe("DEAD_ON_ARRIVAL_EDGE");
  });

  test("an edge out of a dropped node is refused", () => {
    const dropped = commit(gate(), [close("ignored", "dropped")]);
    const r = rejection(attempt(dropped, [task("Later"), { op: "add_edge", from: "ignored", to: "$0" }]));
    expect(r.reason).toBe("DEAD_ON_ARRIVAL_EDGE");
    expect(r.message).toContain("which is dropped");
  });

  test("an edge on the arm that WAS taken is fine", () => {
    const resolved = commit(gate(), [outcome("gate", "accept"), close("gate")]);
    expect(
      attempt(resolved, [task("More"), { op: "add_edge", from: "gate", to: "$0", condition: { on: "accept" } }]).ok,
    ).toBe(true);
  });
});

describe("invariant 1 still reads the authored ops, not the derived ones", () => {
  test("a batch that resolves a gate AND violates invariant 1 names the authored op", () => {
    const graph = commit(
      seeded([task("Accepted"), task("Ignored"), wait("Gate", { on_timeout: "$0" })]),
      [
        { op: "add_edge", from: "gate", to: "accepted", condition: { on: "accept" } },
        { op: "add_edge", from: "gate", to: "ignored", condition: { on: "ignore" } },
        { op: "set_status", node: "accepted", status: "done", evidence_ref: "e" },
      ],
    );
    const r = rejection(
      attempt(graph, [
        outcome("gate", "accept"),
        close("gate"),
        { op: "set_status", node: "accepted", status: "active", evidence_ref: "e" },
      ]),
    );
    expect(r.invariant).toBe(1);
    expect(r.reason).toBe("TERMINAL_NODE_PROTECTED");
    expect(r.op_index).toBe(2);
  });

  test("the derived drops themselves never trip invariant 1", () => {
    const graph = commit(
      seeded([task("Accepted"), task("Ignored"), wait("Gate", { on_timeout: "$0" })]),
      [
        { op: "add_edge", from: "gate", to: "accepted", condition: { on: "accept" } },
        { op: "add_edge", from: "gate", to: "ignored", condition: { on: "ignore" } },
      ],
    );
    const value = accepted(attempt(graph, [outcome("gate", "accept"), close("gate")]));
    expect(value.derived).toHaveLength(1);
    expect(value.ops).toHaveLength(3);
  });
});

/**
 * Mutation-hardening. Each block exists because a specific mutant survived the behavioural
 * suite; the comment names it. §7 puts the floor on `validate()` at 100 because a surviving
 * mutant here is a bad graph reaching the file.
 */
describe("hardening — the recipient grammar's boundaries", () => {
  test("a ref longer than 128 characters is refused", () => {
    expect(parseRecipientRef(`roster.contacts#${"d".repeat(120)}`)).toBeNull();
  });

  test("a key longer than a node id is refused — a key becomes a correlation address", () => {
    expect(parseRecipientRef(`roster#${"d".repeat(48)}`)).not.toBeNull();
    expect(parseRecipientRef(`roster#${"d".repeat(49)}`)).toBeNull();
  });

  test("zero '#' and two '#' are both refused, for the same reason", () => {
    expect(parseRecipientRef("rosterdana")).toBeNull();
    expect(parseRecipientRef("roster#contacts#dana")).toBeNull();
  });

  test("a scope with a leading dot or a doubled dot is refused", () => {
    expect(parseRecipientRef(".roster#dana")).toBeNull();
    expect(parseRecipientRef("roster..contacts#dana")).toBeNull();
    expect(parseRecipientRef("roster.#dana")).toBeNull();
  });

  test("the parsed halves come back, so a caller can resolve the key later", () => {
    expect(parseRecipientRef("roster.contacts#dana")).toEqual({
      scope: "roster.contacts",
      key: "dana",
    });
  });

  test("a compensatable node's recipient is checked too, not just a pivot's", () => {
    const r = rejection(
      attempt(seeded([task("A")]), [
        task("Retract", {
          effect_class: "compensatable",
          effect: { channel: "email", recipient_ref: "nope" },
        }),
      ]),
    );
    expect(r.reason).toBe("MALFORMED_RECIPIENT_REF");
  });
});

describe("hardening — the predicate grammar's boundaries", () => {
  test("an array is not a predicate, and neither is an array of attrs", () => {
    expect(parseCountPredicate([])).toBeNull();
    expect(
      parseCountPredicate({ count: { verdict: "confirmed", attrs: [] }, op: ">=", n: 1 }),
    ).toBeNull();
  });

  test("count must be an object", () => {
    expect(parseCountPredicate({ count: "confirmed", op: ">=", n: 1 })).toBeNull();
    expect(parseCountPredicate({ count: null, op: ">=", n: 1 })).toBeNull();
  });

  test("n must be a number, not a numeric string", () => {
    expect(parseCountPredicate({ count: { verdict: "confirmed" }, op: ">=", n: "1" })).toBeNull();
  });

  test("n of exactly 1 is the floor and is accepted", () => {
    expect(parseCountPredicate({ count: { verdict: "confirmed" }, op: ">=", n: 1 })).not.toBeNull();
    expect(parseCountPredicate({ count: { verdict: "confirmed" }, op: ">=", n: 2 })).not.toBeNull();
  });

  test("every decision verdict is countable, since a human wait returns them", () => {
    for (const verdict of ["accept", "edit", "respond", "ignore"]) {
      expect(parseCountPredicate({ count: { verdict }, op: ">=", n: 1 })).not.toBeNull();
    }
  });

  test("attrs accepts the three primitives and nothing else", () => {
    expect(
      parseCountPredicate({
        count: { verdict: "confirmed", attrs: { a: "x", b: 2, c: true } },
        op: ">=",
        n: 1,
      }),
    ).not.toBeNull();
  });

  test("a non-predicate wait's arms are never parsed", () => {
    // An `event` wait may legally carry whatever its match kind defines; the count grammar
    // is not imposed on it.
    expect(
      attempt(seeded([task("A")]), [
        wait("Evented", {
          on_timeout: "a",
          match: {
            kind: "event",
            conditions: [{ kind: "reply", on: "satisfied", predicate: { nonsense: true } }],
            memory: true,
          },
        }),
      ]).ok,
    ).toBe(true);
  });
});

describe("hardening — invariant 2's skip conditions are each load-bearing", () => {
  function brokenBatch(): AuthoredOp[] {
    return [outcome("dana", "declined")];
  }

  test("a wait that is already terminal is not judged", () => {
    const closed = commit(quorum(), [close("quorum", "failed")]);
    expect(attempt(closed, brokenBatch()).ok).toBe(true);
  });

  test("a wait that already has a resolving outcome is not judged", () => {
    const resolved = commit(quorum(), [outcome("quorum", "confirmed")]);
    expect(attempt(resolved, brokenBatch()).ok).toBe(true);
  });

  test("a superseded wait is not judged", () => {
    const superseded = commit(quorum(), [
      predicateWait("Quorum two", ONE_CONFIRMED, "escalate"),
      { op: "supersede_node", node: "quorum", by: "$0" },
    ]);
    expect(attempt(superseded, brokenBatch()).ok).toBe(true);
  });

  /** Kills `.some` -> `.every` in satisfiableAt: an or-group survives on ANY live arm. */
  test("an or-group stays alive while any one arm is satisfiable", () => {
    const twoArm = commit(
      seeded([
        task("Escalate"),
        task("Dana"),
        wait("Quorum", {
          on_timeout: "$0",
          match: {
            kind: "predicate",
            conditions: [
              { kind: "count", on: "satisfied", predicate: { count: { verdict: "confirmed" }, op: ">=", n: 1 } },
              { kind: "count", on: "satisfied", predicate: { count: { verdict: "declined" }, op: ">=", n: 1 } },
            ],
            memory: true,
          },
        }),
      ]),
      [{ op: "add_edge", from: "dana", to: "quorum" }],
    );
    // At head BOTH arms are satisfiable, so the already-broken carve-out cannot apply. The
    // decline kills arm one and satisfies arm two, and only reading the group as an OR
    // (§6.5 first-wins) accepts the batch — `every` here would refuse a live wait.
    expect(attempt(twoArm, [outcome("dana", "declined")]).ok).toBe(true);
  });

  /** Kills the isMechanicalClosure branches individually. */
  test("record_output is not a mechanical closure, so it does not buy an exemption", () => {
    const two = commit(quorum(), [task("Sam"), { op: "add_edge", from: "$0", to: "quorum" }]);
    const r = rejection(
      attempt(two, [
        outcome("dana", "declined"),
        outcome("sam", "declined"),
        { op: "record_output", node: "dana", output_name: "reply", value: "no", evidence_ref: "e" },
      ]),
    );
    expect(r.reason).toBe("PREDICATE_UNSATISFIABLE");
  });

  test("set_status to something other than failed is not a mechanical closure", () => {
    const r = rejection(attempt(quorum(), [outcome("dana", "declined"), close("dana", "done")]));
    expect(r.reason).toBe("PREDICATE_UNSATISFIABLE");
  });

  test("the store's own drops do not launder a break the author caused", () => {
    // The derived drop alone would be exempt housekeeping, but the batch also carries the
    // author's own ops — so the exemption must not apply, or arranging for branch resolution
    // to kill a quorum becomes a way to break one for free.
    expect(rejection(attempt(gatedQuorum(), [outcome("gate", "ignore"), close("gate")])).invariant).toBe(2);
  });

  /**
   * The forgery. `set_status.evidence_ref` is author-controlled free text, so recognising the
   * store's own drops by their string prefix would hand a mutator the whole-batch exemption
   * for the price of typing it. Identity is by reference to the ops the store actually
   * derived, so an authored drop wearing the marker is treated exactly like a bare one.
   */
  test("a forged derived evidence_ref buys nothing", () => {
    const declined = commit(
      commit(quorum(), [task("Sam"), { op: "add_edge", from: "$0", to: "quorum" }]),
      [outcome("sam", "declined")],
      SUBAGENT,
    );
    const bare = attempt(declined, [close("dana", "dropped")]);
    const forged = attempt(declined, [
      {
        op: "set_status",
        node: "dana",
        status: "dropped",
        evidence_ref: "derived:branch-resolution:made-up",
      },
    ]);
    expect(rejection(bare).reason).toBe("PREDICATE_UNSATISFIABLE");
    expect(rejection(forged).reason).toBe("PREDICATE_UNSATISFIABLE");
  });

  test("superseding an UNRELATED node does not exempt the batch", () => {
    const r = rejection(
      attempt(quorum(), [outcome("dana", "declined"), { op: "supersede_node", node: "escalate" }]),
    );
    expect(r.reason).toBe("PREDICATE_UNSATISFIABLE");
  });

  test("recording a satisfying verdict on the wait ITSELF does not exempt the batch", () => {
    // Open-ness is read from `pre`, so a batch cannot hand-close the wait it just broke.
    const r = rejection(
      attempt(quorum(), [outcome("dana", "declined"), outcome("quorum", "confirmed")]),
    );
    expect(r.reason).toBe("PREDICATE_UNSATISFIABLE");
  });

  test("a human actor is judged, like an orchestrator", () => {
    const r = rejection(attempt(quorum(), [outcome("dana", "declined")], { kind: "human", id: "ilya" }));
    expect(r.reason).toBe("PREDICATE_UNSATISFIABLE");
  });
});

describe("hardening — countPredicate reads the projection, never the raw history", () => {
  const arm = { count: { verdict: "confirmed" as Verdict }, op: ">=" as const, n: 1 };

  test("a late contradicting reply cannot un-count a confirmed member", () => {
    const graph = commit(
      commit(quorum(), [outcome("dana", "confirmed")]),
      [outcome("dana", "declined"), outcome("dana", "late")],
    );
    expect(nodeOf(graph, "dana").status.outcomes).toHaveLength(3);
    expect(countPredicate(graph, nodeOf(graph, "quorum"), arm).matching_confirmed).toBe(1);
  });

  test("a tentative FIRST entry does not become the projection", () => {
    const graph = commit(
      commit(quorum(), [outcome("dana", "tentative")]),
      [outcome("dana", "confirmed")],
    );
    expect(countPredicate(graph, nodeOf(graph, "quorum"), arm).matching_confirmed).toBe(1);
  });

  test("a wait with no in-edges has an empty population and cannot be satisfied", () => {
    const lonely = commit(seeded([task("Escalate"), predicateWait("Quorum")]), [task("Idle")]);
    const counted = countPredicate(lonely, nodeOf(lonely, "quorum"), arm);
    expect(counted).toMatchObject({ population: 0, still_live: 0, satisfiable: false });
  });
});

describe("hardening — the wait-out-edge rule resolves the source's type correctly", () => {
  test("an add_node earlier in the batch that is NOT the edge source does not confuse it", () => {
    // Kills the `op.id === id` mutant in nodeTypeOf: with the comparison gone, the first
    // add_node in the batch answers for every id, so this task would be read as a wait.
    expect(
      attempt(seeded([task("A")]), [
        wait("Gate", { on_timeout: "a" }),
        task("Plain"),
        task("Downstream"),
        { op: "add_edge", from: "$1", to: "$2" },
      ]).ok,
    ).toBe(true);
  });

  test("and the wait in that same batch is still caught", () => {
    const r = rejection(
      attempt(seeded([task("A")]), [
        wait("Gate", { on_timeout: "a" }),
        task("Plain"),
        task("Downstream"),
        { op: "add_edge", from: "$0", to: "$2" },
      ]),
    );
    expect(r.reason).toBe("UNCONDITIONED_WAIT_EDGE");
    expect(r.node).toBe("gate");
  });

  test("an unknown source is not a wait, and is left to the apply stage to reject", () => {
    const r = rejection(attempt(seeded([task("A")]), [{ op: "add_edge", from: "ghost", to: "a" }]));
    expect(r.reason).toBe("UNKNOWN_NODE");
  });
});

describe("hardening — the recipient length boundary is inclusive", () => {
  test("exactly the maximum is accepted and one more is not", () => {
    const key = "d".repeat(40);
    const scope = "s".repeat(128 - 1 - key.length);
    const atLimit = `${scope}#${key}`;
    expect(atLimit).toHaveLength(128);
    expect(parseRecipientRef(atLimit)).not.toBeNull();
    expect(parseRecipientRef(`x${atLimit}`)).toBeNull();
  });
});

/**
 * Regressions from the adversarial review. Every one of these reproduced against the first
 * implementation; each test is the scenario that reproduced it.
 */
describe("review regressions", () => {
  /**
   * A `merge: "any"` node with NO in-edges was permanently unready: `some` over an empty
   * array is `false`, where the `every` it replaced was `true`. A root could never run, and
   * no op could repair it.
   */
  test("a merge:'any' root with no in-edges is ready", () => {
    const graph = seeded([task("Root any", { merge: "any" })]);
    expect(isReady(graph, nodeOf(graph, "root-any"))).toBe(true);
    expect(readyFrontier(graph).map((n) => n.id)).toEqual(["root-any"]);
  });

  test("and merge:'all' with no in-edges is ready too", () => {
    const graph = seeded([task("Root all", { merge: "all" })]);
    expect(isReady(graph, nodeOf(graph, "root-all"))).toBe(true);
  });

  /**
   * What `kona resume` actually writes when a deadline passes: the verdict AND the status,
   * in one batch, because a wait must be terminal for its `on_timeout` arm to fire. Treating
   * only `failed` as a mechanical closure refused exactly this batch — and resume has no
   * model in the loop to author the repair the message demanded.
   */
  test("resume's paired timeout batch is accepted", () => {
    expect(
      attempt(quorum(), [
        outcome("dana", "timed_out"),
        { op: "set_status", node: "dana", status: "done", evidence_ref: "deadline" },
      ]).ok,
    ).toBe(true);
  });

  test("a bounce closed the same way is accepted", () => {
    expect(
      attempt(quorum(), [
        outcome("dana", "bounced"),
        { op: "set_status", node: "dana", status: "done", evidence_ref: "bounce" },
      ]).ok,
    ).toBe(true);
  });

  /**
   * A `kind: "predicate"` wait carrying no predicate at all committed cleanly, yielded zero
   * arms, and was therefore treated as satisfiable forever — permanently exempt from the
   * invariant that exists to watch it.
   */
  test("a predicate wait with no predicate is refused", () => {
    const r = rejection(
      attempt(seeded([task("A")]), [
        wait("Quorum", {
          on_timeout: "a",
          match: { kind: "predicate", conditions: [{ kind: "count", on: "satisfied" }], memory: true },
        }),
      ]),
    );
    expect(r.code).toBe("REFUSED");
    expect(r.reason).toBe("MISSING_PREDICATE");
    expect(r.node).toBe("quorum");
  });

  test("one parseable arm is enough — the other conditions may be plain", () => {
    expect(
      attempt(seeded([task("A")]), [
        wait("Quorum", {
          on_timeout: "a",
          match: {
            kind: "predicate",
            conditions: [
              { kind: "deadline", on: "timeout" },
              { kind: "count", on: "satisfied", predicate: ONE_CONFIRMED },
            ],
            memory: true,
          },
        }),
      ]).ok,
    ).toBe(true);
  });

  /** An attrs key of `__proto__` must be stored and compared, not swallowed by the setter. */
  test("__proto__ survives as an ordinary attrs key", () => {
    // Built with JSON.parse, which is how a predicate actually reaches the counter — it
    // comes off the log. An object LITERAL written `{ __proto__: "x" }` sets the prototype
    // instead of creating the key, so it could not express the case under test.
    const parsed = parseCountPredicate(
      JSON.parse('{"count":{"verdict":"confirmed","attrs":{"__proto__":"x"}},"op":">=","n":1}'),
    );
    expect(parsed?.count.attrs?.["__proto__"]).toBe("x");
  });
});

/**
 * The message text, asserted in full.
 *
 * §6.8 makes every non-zero exit one greppable stderr line, and §6.9 makes one of these the
 * only human gate in the system — so what the line SAYS is contract, not decoration. An
 * operator who cannot act on it has to read the source, and a reason token that drifts
 * silently breaks whatever greps for it.
 */
describe("rejection messages are contract", () => {
  function messageOf(result: ReturnType<typeof attempt>): string {
    return rejection(result).message;
  }

  test("UNCONDITIONED_WAIT_EDGE names both ends and the harm", () => {
    expect(messageOf(attempt(gate(), [{ op: "add_edge", from: "gate", to: "ignored" }]))).toBe(
      "edge 'gate' -> 'ignored' leaves a wait without a condition; an ignored or timed-out " +
        "wait would clear it and fire the branch unapproved (§6.2)",
    );
  });

  test("DEAD_ON_ARRIVAL_EDGE distinguishes a resolved source from a dropped one", () => {
    const resolved = commit(gate(), [outcome("gate", "accept"), close("gate")]);
    expect(
      messageOf(
        attempt(resolved, [
          { op: "add_edge", from: "gate", to: "ignored", condition: { on: "ignore" } },
        ]),
      ),
    ).toBe(
      "edge 'gate' -> 'ignored' is conditioned on 'ignore', but 'gate' has already resolved " +
        "otherwise; it can never fire",
    );

    const dropped = commit(gate(), [close("ignored", "dropped")]);
    expect(
      messageOf(attempt(dropped, [task("Later"), { op: "add_edge", from: "ignored", to: "$0" }])),
    ).toBe("edge 'ignored' -> 'later' originates at 'ignored', which is dropped; it can never fire");
  });

  test("MALFORMED_RECIPIENT_REF teaches the grammar and gives an example", () => {
    expect(messageOf(attempt(seeded([task("A")]), [pivot("person:club/goalie-1")]))).toBe(
      "recipient_ref 'person:club/goalie-1' is not a '<scope>#<key>' reference: expected " +
        "exactly one '#', a dotted lowercase scope, and a key matching [a-z0-9][a-z0-9-]* of " +
        "at most 48 characters (§6.2, e.g. 'roster.contacts#dana')",
    );
  });

  test("LITERAL_RECIPIENT_ADDRESS says why a ref rather than an address", () => {
    expect(messageOf(attempt(seeded([task("A")]), [pivot("marcus@club.org")]))).toBe(
      "recipient_ref 'marcus@club.org' is a literal address; §6.2 requires a ref — " +
        "'<scope>#<key>' — so the store can check who is being emailed against what the " +
        "graph was told",
    );
  });

  test("MISSING_PREDICATE says what it would have been for", () => {
    expect(
      messageOf(
        attempt(seeded([task("A")]), [
          wait("Quorum", {
            on_timeout: "a",
            match: { kind: "predicate", conditions: [{ kind: "count", on: "satisfied" }], memory: true },
          }),
        ]),
      ),
    ).toBe(
      "'quorum' declares match.kind 'predicate' but carries no predicate; nothing would ever " +
        "count against it, and invariant 2 could never judge it (§6.7)",
    );
  });

  test("MALFORMED_PREDICATE prints the form it wanted", () => {
    expect(
      messageOf(
        attempt(seeded([task("A")]), [
          predicateWait("Quorum", { count: { verdict: "confirmed" }, op: ">", n: 1 }, "a"),
        ]),
      ),
    ).toBe(
      'predicate on \'quorum\' is not the §6.7 form {"count":{"verdict":…,"attrs":…},' +
        '"op":">=","n":…}: \'op\' must be \'>=\', \'n\' an integer of at least 1, \'verdict\' a ' +
        "resolving verdict, and 'attrs' flat primitives",
    );
  });

  test("PREDICATE_UNSATISFIABLE shows the arithmetic and both remedies", () => {
    expect(messageOf(attempt(quorum(), [outcome("dana", "declined")]))).toBe(
      "'quorum' can no longer reach 1 'confirmed': 0 matching + 0 still live of 1 blocking " +
        "in-edges (0 dropped); add a live member in this batch, or supersede the wait",
    );
  });

  test("and names the derived drops when branch resolution is what broke it", () => {
    expect(messageOf(attempt(gatedQuorum(), [outcome("gate", "ignore"), close("gate")]))).toBe(
      "'quorum' can no longer reach 1 'confirmed': 0 matching + 0 still live of 2 blocking " +
        "in-edges (1 dropped); branch resolution dropped dana; add a live member in this " +
        "batch, or supersede the wait",
    );
  });
});

describe("hardening — the remaining branches of invariant 2's plumbing", () => {
  const arm = { count: { verdict: "confirmed" as Verdict }, op: ">=" as const, n: 1 };

  test("a non-wait node has no predicate arms", () => {
    const graph = quorum();
    expect(countPredicate(graph, nodeOf(graph, "quorum"), arm).population).toBe(1);
    // A task never carries a match block, so it contributes no arms and is never judged.
    expect(attempt(graph, [{ op: "record_output", node: "dana", output_name: "reply", value: "x", evidence_ref: "e" }]).ok).toBe(true);
  });

  test("a wait whose match kind is not 'predicate' is never judged", () => {
    const evented = commit(
      seeded([task("Escalate"), task("Dana"), wait("Evented", { on_timeout: "$0" })]),
      [{ op: "add_edge", from: "dana", to: "evented" }],
    );
    expect(attempt(evented, [outcome("dana", "declined")]).ok).toBe(true);
  });

  test("a member that is not a node at all counts for nothing", () => {
    // `add_edge` refuses an unknown endpoint, so this is only reachable by construction —
    // but the guard has to hold, or a dangling edge would throw instead of being ignored.
    const graph = quorum();
    graph.edges.push({ from: "ghost", to: "quorum" });
    expect(countPredicate(graph, nodeOf(graph, "quorum"), arm).population).toBe(1);
  });

  test("failed and done are both mechanical closures, and dropped is not", () => {
    const two = commit(quorum(), [task("Sam"), { op: "add_edge", from: "$0", to: "quorum" }]);
    const broken = commit(two, [outcome("sam", "declined")], SUBAGENT);
    expect(attempt(broken, [close("dana", "failed")]).ok).toBe(true);
    expect(attempt(broken, [close("dana", "done")]).ok).toBe(true);
    expect(rejection(attempt(broken, [close("dana", "dropped")])).reason).toBe(
      "PREDICATE_UNSATISFIABLE",
    );
  });

  test("record_outcome bounced closes the wait as legitimately as timed_out", () => {
    expect(attempt(quorum(), [outcome("dana", "declined"), outcome("quorum", "bounced")]).ok).toBe(true);
  });

  test("an unrelated record_outcome on the wait does not close it", () => {
    expect(rejection(attempt(quorum(), [outcome("dana", "declined"), outcome("quorum", "late")])).reason).toBe(
      "PREDICATE_UNSATISFIABLE",
    );
  });
});

describe("a claim is exclusive, not advice", () => {
  // CAS is not the guard here, and that is the whole point of the rule. CAS rejects a commit
  // written against a STALE head; a second agent reading AFTER the first claim lands sees a
  // current head and sails through. Measured before the check existed: two claims, both
  // exit 0, and a graph that could not say who held the node.
  const claimed = commit(seeded([task("Read the schemas", { effect_class: "pure" })]), [
    { op: "set_status", node: "read-the-schemas", status: "in_flight", evidence_ref: "claim:A" },
  ]);

  test("a second claim on a claimed node is refused by name", () => {
    const r = rejection(
      attempt(claimed, [
        { op: "set_status", node: "read-the-schemas", status: "in_flight", evidence_ref: "claim:B" },
      ]),
    );
    expect(r.reason).toBe("ALREADY_CLAIMED");
    expect(r.node).toBe("read-the-schemas");
  });

  test("claiming an ACTIVE node is exactly what the rule permits", () => {
    const graph = seeded([task("Read the schemas", { effect_class: "pure" })]);
    accepted(
      attempt(graph, [
        { op: "set_status", node: "read-the-schemas", status: "in_flight", evidence_ref: "claim:A" },
      ]),
    );
  });

  test("the holder can still finish — every other exit from in_flight stays legal", () => {
    // The rule bites on in_flight -> in_flight and nothing else. If it caught the exits too,
    // a claimed node could never be released by anybody, including resume.
    accepted(
      attempt(claimed, [
        { op: "set_status", node: "read-the-schemas", status: "done", evidence_ref: "log#1" },
      ]),
    );
    accepted(
      attempt(claimed, [
        { op: "set_status", node: "read-the-schemas", status: "active", evidence_ref: "resume:stale-claim" },
      ]),
    );
  });
});
