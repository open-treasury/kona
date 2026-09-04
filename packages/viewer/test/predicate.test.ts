/**
 * The quorum counter's POPULATION, on the activity model.
 *
 * `waitState.test.ts` covers the counter itself — parsing, attrs, operators, liveness — against
 * `fixtures/thursday.*`, where five behaviour nodes fan straight into one wait. That shape is the
 * scaffold's, and §6.2's arity has ended it: an `accept_event` has exactly ONE in-edge, so every
 * convergence now goes through an explicit `merge` or `join` and the sole in-edge of a quorum
 * wait comes from a node that has no status and can never answer anything. A counter that reads
 * `inEdges` and stops there renders `0 of N` forever, on a wait five people have replied to.
 *
 * So these tests are about the walk THROUGH the control nodes, and they are posed on
 * `fixtures/goalie.*` — the activity-model pursuit the real binary emitted — rather than on a
 * hand-built graph. The quorum region is appended to that log as one more committed record, which
 * goes through `MutationRecordSchema` and `applyOps` like every other line: a shape the schema
 * would reject cannot sneak in, and the fold reports it as damaged if it tries. The region is
 * arity-correct on purpose (S7), because a population walked over a graph the store would refuse
 * proves nothing about the graphs it actually writes.
 *
 * The region is the fixture's own idiom, one arm per goalie:
 *
 *   ▮fork ┬→ [Ask Robin] → (Robin replies) → ◇ ─confirmed→ ┐
 *         │                                  └─else──→ ⊗   ├ merge|join → (a goalie is confirmed) → ⊗
 *         └→ [Ask Kim]   → (Kim replies)   → ◇ ─confirmed→ ┘
 *                                            └─else──→ ⊗
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import type { ActivityNode, FoldResult, Graph } from "@kona/core";
import { SCHEMA_VERSION, firedGuard, foldLog, inEdges, isControlNode } from "@kona/core";
import { predicateCount } from "../src/model/predicate.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOALIE_LOG = join(HERE, "..", "..", "..", "fixtures", "goalie.mutations.jsonl");

/** The ids the appended record mints. `[a-z0-9][a-z0-9-]*` under the pursuit's own prefix. */
const ROBIN_ASK = "gk-roba";
const ROBIN_REPLY = "gk-robr";
const ROBIN_OUT = "gk-robx";
const ROBIN_DECIDE = "gk-robd";
const KIM_ASK = "gk-kima";
const KIM_REPLY = "gk-kimr";
const KIM_OUT = "gk-kimx";
const KIM_DECIDE = "gk-kimd";
const CONVERGENCE = "gk-conv";
const QUORUM = "gk-quor";
const COVERED = "gk-covd";
/** The fork the shipped fixture already fans out from; its out-arity is unbounded (§6.2). */
const FORK = "gk-7mco";

type Op = Record<string, unknown>;

function action(id: string, name: string, instruction: string): Op {
  return {
    op: "add_node",
    name,
    type: "action",
    spec: {
      instruction,
      inputs: [],
      outputs: [{ name: "sent", type: "string" }],
      effect_class: "pure",
    },
    id,
  };
}

/**
 * An `accept_event` carries no `on_timeout` (D3): it routes a blown deadline through the
 * `timeout` guard on the decision it feeds, which is why every arm below ends in one.
 */
function acceptEvent(id: string, name: string, match: Op): Op {
  return {
    op: "add_node",
    name,
    type: "accept_event",
    spec: {
      instruction: `Wait for ${name}.`,
      inputs: [],
      outputs: [],
      effect_class: "pure",
      deadline: { at: "2026-08-22T17:00:00.000Z" },
      match,
    },
    id,
  };
}

/** A control node is not work: an empty spec is all §6.2 lets it carry. */
function control(id: string, name: string, type: string): Op {
  return { op: "add_node", name, type, spec: {}, id };
}

function edge(from: string, to: string, on?: string): Op {
  const decision = from === ROBIN_DECIDE || from === KIM_DECIDE;
  return {
    op: "add_edge",
    from,
    to,
    ...(on === undefined ? (decision ? { guard: "else" } : {}) : { guard: { on } }),
  };
}

const EVENT_MATCH: Op = {
  kind: "event",
  conditions: [
    { kind: "reply", on: "satisfied" },
    { kind: "deadline", on: "timeout" },
  ],
};

/** The quorum §6.7 spells `{count:{verdict,attrs}, op, n}` — one confirmed goalie is enough. */
const PREDICATE_MATCH: Op = {
  kind: "predicate",
  conditions: [
    {
      kind: "predicate",
      on: "satisfied",
      predicate: {
        count: { verdict: "confirmed", attrs: { role: "goalie" } },
        op: ">=",
        n: 1,
      },
    },
  ],
};

/**
 * The region, as ops. `convergence` is the whole experiment: the same eleven nodes wired
 * through a `merge` in one test and a `join` in the next, so the only thing that can move a
 * number between them is the rule the counter applies to that one node.
 */
function region(convergence: "merge" | "join"): Op[] {
  return [
    action(ROBIN_ASK, "Ask Robin to play in goal", "Email Robin and ask her to keep Thursday."),
    acceptEvent(ROBIN_REPLY, "Robin replies", EVENT_MATCH),
    control(ROBIN_DECIDE, "Did Robin keep the slot", "decision"),
    control(ROBIN_OUT, "Robin is out", "flow_final"),
    action(KIM_ASK, "Ask Kim to play in goal", "Email Kim and ask him to keep Thursday."),
    acceptEvent(KIM_REPLY, "Kim replies", EVENT_MATCH),
    control(KIM_DECIDE, "Did Kim keep the slot", "decision"),
    control(KIM_OUT, "Kim is out", "flow_final"),
    control(CONVERGENCE, "Either goalie will do", convergence),
    acceptEvent(QUORUM, "A goalie is confirmed", PREDICATE_MATCH),
    control(COVERED, "The goal is covered", "flow_final"),

    edge(FORK, ROBIN_ASK),
    edge(ROBIN_ASK, ROBIN_REPLY),
    edge(ROBIN_REPLY, ROBIN_DECIDE),
    edge(ROBIN_DECIDE, CONVERGENCE, "confirmed"),
    edge(ROBIN_DECIDE, ROBIN_OUT),
    edge(FORK, KIM_ASK),
    edge(KIM_ASK, KIM_REPLY),
    edge(KIM_REPLY, KIM_DECIDE),
    edge(KIM_DECIDE, CONVERGENCE, "confirmed"),
    edge(KIM_DECIDE, KIM_OUT),
    edge(CONVERGENCE, QUORUM),
    edge(QUORUM, COVERED),
  ];
}

/** What a goalie said, as the two ops the store writes for one reply (§6.4 keeps them apart). */
function replied(node: string, verdict: string, attrs?: Record<string, string>): Op[] {
  return [
    {
      op: "record_outcome",
      node,
      verdict,
      evidence_ref: `mail:${node}`,
      ...(attrs === undefined ? {} : { attrs }),
    },
    { op: "set_status", node, status: "completed", evidence_ref: `mail:${node}` },
  ];
}

const BASE = readFileSync(GOALIE_LOG, "utf8");

/**
 * The goalie log with one more real record on the end.
 *
 * Hand-built *records* are the sanctioned way to pose a fact a fixture does not contain — the
 * line is parsed and applied by core, so the graph under test is one the store could have
 * written. Hand-built *graphs* are not, and this file contains none.
 */
function withRegion(ops: Op[]): FoldResult {
  const head = foldLog(BASE).graph.version;
  const record = {
    v: head + 1,
    schema_version: SCHEMA_VERSION,
    observed_at: "2026-08-28T09:00:00.000Z",
    occurred_at: "2026-08-28T09:00:00.000Z",
    actor: { kind: "orchestrator", id: "orchestrator" },
    ops,
    rationale: {
      why: "Two more goalies asked at once, merging on a quorum.",
      alternatives_rejected: [],
      reason_code: "OTHER",
    },
    outcome: null,
  };
  const folded = foldLog(`${BASE}${JSON.stringify(record)}\n`);
  // A silently damaged line would fold to the graph WITHOUT the region, and every assertion
  // below would then be made about a quorum that does not exist.
  expect(folded.damaged).toEqual([]);
  expect(folded.torn_tail).toBeNull();
  return folded;
}

function graphWith(convergence: "merge" | "join", ...replies: Op[][]): Graph {
  return withRegion([...region(convergence), ...replies.flat()]).graph;
}

/** Any node, control included — for the tests that are ABOUT the control nodes. */
function anyNodeOf(graph: Graph, id: string) {
  const node = graph.nodes.get(id);
  if (node === undefined) throw new Error(`the fixture has no node ${id}`);
  return node;
}

function nodeOf(graph: Graph, id: string): ActivityNode {
  const found = graph.nodes.get(id);
  if (found === undefined) throw new Error(`the graph has no node '${id}'`);
  return found;
}

function count(graph: Graph) {
  const counted = predicateCount(graph, nodeOf(graph, QUORUM));
  if (counted === null) throw new Error(`'${QUORUM}' carries no predicate count`);
  return counted;
}

/** Robin says yes as a goalie; Kim says no, and his decision routes him out. */
const ROBIN_CONFIRMED = replied(ROBIN_REPLY, "confirmed", { role: "goalie" });
const KIM_DECLINED = replied(KIM_REPLY, "declined", { role: "goalie" });

describe("the population is walked through the control nodes", () => {
  test("the quorum's one in-edge is a control node that can never answer", () => {
    // The premise of every test below, and the reason the old population was wrong. S7 leaves
    // an `accept_event` exactly one in-edge, so `inEdges` alone yields a single diamond: no
    // status to be `completed`, no outcome to carry a verdict, and — before the fix — one more
    // answer `live` claimed was still to come.
    const graph = graphWith("merge", ROBIN_CONFIRMED);
    const ins = inEdges(graph, QUORUM);
    expect(ins.map((e) => e.from)).toEqual([CONVERGENCE]);

    const only = anyNodeOf(graph, CONVERGENCE);
    expect(isControlNode(only.type)).toBe(true);
    // Not "its outcome is null" — it has no STATUS at all. That is the point the test is
    // making: the quorum's one in-edge comes from a node that cannot hold an answer, which is
    // why the population has to be walked THROUGH it rather than read off it.
    expect(only.status).toBeUndefined();
  });

  test("an answer underneath a merge is counted, and the merge itself is not an answer", () => {
    const graph = graphWith("merge", ROBIN_CONFIRMED);
    const counted = count(graph);
    expect(counted.have).toBe(1);
    expect(counted.contributors).toEqual([ROBIN_REPLY]);
    expect(counted.need).toBe(1);
    expect(counted.met).toBe(true);
    // Kim, and only Kim. Not the merge and not the two decisions, none of which can answer.
    expect(counted.live).toBe(1);
  });

  test("with nobody answered, live is the two goalies — not the diamonds between", () => {
    const graph = graphWith("merge");
    const counted = count(graph);
    expect(counted.have).toBe(0);
    expect(counted.met).toBe(false);
    // Reading `inEdges` gave 1 here (the merge, unresolved and therefore "live"), which is the
    // same number as one outstanding goalie and tells the reader the wrong thing twice over.
    expect(counted.live).toBe(2);
  });

  test("a decision that has not fired yet still carries the arm behind it", () => {
    // An arm that merely has not been DECIDED is not a dead one. Kim's decision has taken
    // nothing while he is silent, so he is still an answer that can arrive; once he declines it
    // routes him out and he is not. Robin is seen through the walk in both, which is what says
    // the difference is the decision rather than the traversal giving up.
    const undecided = count(graphWith("merge", ROBIN_CONFIRMED));
    const decided = count(graphWith("merge", ROBIN_CONFIRMED, KIM_DECLINED));
    expect(nodeOf(graphWith("merge", ROBIN_CONFIRMED), KIM_REPLY).status?.outcome).toBeNull();
    expect(undecided.contributors).toEqual([ROBIN_REPLY]);
    expect(decided.contributors).toEqual([ROBIN_REPLY]);
    expect(undecided.live).toBe(1);
    expect(decided.live).toBe(0);
  });

  test("the attrs filter still judges a member the walk had to go and find", () => {
    // Robin said yes to the wrong thing and Kim said yes to this one. Walking to a member is
    // not the same as counting it: the verdict and the `role` filter are asked of each one
    // exactly as they were when the sources sat one edge away.
    const counted = count(
      graphWith(
        "merge",
        replied(ROBIN_REPLY, "confirmed", { role: "striker" }),
        replied(KIM_REPLY, "confirmed", { role: "goalie" }),
      ),
    );
    expect(counted.have).toBe(1);
    expect(counted.contributors).toEqual([KIM_REPLY]);
    expect(counted.met).toBe(true);
    // Both have spoken, and §6.7 makes a resolving answer first-wins and final.
    expect(counted.live).toBe(0);
  });
});

describe("a merge is disjunctive and a join is conjunctive", () => {
  /**
   * The same story told twice: Robin confirmed, Kim declined and his decision routed him to
   * "Kim is out". The only difference is the node the two arms converge on.
   *
   * Under a MERGE, any one arm is enough — Kim's dead arm takes Kim out of the population and
   * leaves Robin's confirmation standing, which is what closes the wait.
   *
   * Under a JOIN, every arm is needed, so one dead arm means nothing will ever come through it
   * at all. Robin's confirmation is real and it is stranded: rendering `1/1 met` on a wait the
   * store will never make ready is the quorum chip contradicting the blocked reason on the very
   * next card. These are core's own rules, carried across the control node by `isEdgeDead`.
   */
  test("Kim's decline routes his arm away from the convergence", () => {
    // The premise the next two tests differ over, asserted with the store's own function rather
    // than assumed: `confirmed` guards the arm into the convergence, so a decline fires the
    // else arm and nothing will ever come down Kim's side again.
    const graph = graphWith("merge", ROBIN_CONFIRMED, KIM_DECLINED);
    expect(nodeOf(graph, KIM_REPLY).status?.outcome?.verdict).toBe("declined");
    expect(firedGuard(graph, nodeOf(graph, KIM_DECIDE))?.to).toBe(KIM_OUT);
    expect(firedGuard(graph, nodeOf(graph, ROBIN_DECIDE))?.to).toBe(CONVERGENCE);
  });

  test("a merge keeps the arm that lived", () => {
    const counted = count(graphWith("merge", ROBIN_CONFIRMED, KIM_DECLINED));
    expect(counted.have).toBe(1);
    expect(counted.contributors).toEqual([ROBIN_REPLY]);
    expect(counted.met).toBe(true);
    expect(counted.live).toBe(0);
  });

  test("a join excludes a routed-away arm and carries the remaining answer", () => {
    const counted = count(graphWith("join", ROBIN_CONFIRMED, KIM_DECLINED));
    expect(counted.have).toBe(1);
    expect(counted.contributors).toEqual([ROBIN_REPLY]);
    expect(counted.met).toBe(true);
    expect(counted.live).toBe(0);
  });

  test("a join whose arms are all still open carries both of them", () => {
    // Conjunctive is not the same as pessimistic: nothing has died here, so both goalies are
    // still answers that can arrive, exactly as under a merge.
    const open = count(graphWith("join"));
    expect(open.live).toBe(2);
    expect(open.have).toBe(0);
    expect(count(graphWith("join", ROBIN_CONFIRMED)).have).toBe(1);
  });
});
