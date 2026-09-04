/**
 * The activity model, end to end on one graph.
 *
 * Ten nodes, one of every type, committed in a single batch — the smallest thing that proves
 * the four claims it would be most expensive to discover late:
 *
 *   1. readiness routes THROUGH a control node, which has no status to be `completed`;
 *   2. a control node never reaches the frontier;
 *   3. a decision picks exactly one arm, derived from what is already recorded;
 *   4. a fork/join region is expressible in one atomic commit.
 *
 *          ● → ▮fork ┬→ [Ask Dana] → (Dana replies) → ◇ ─accept→ ▮join → [Lock] → ◎
 *                    │                                 └─else───→ ⊗
 *                    └→ [Book the pitch] ───────────────────────────↑
 */

import { describe, expect, test } from "bun:test";
import type { AuthoredOp, Deadline, Graph } from "../src/index.ts";
import {
  BEHAVIOUR_NODE_TYPES,
  CONTROL_NODE_TYPES,
  NODE_TYPES,
  SCHEMA_VERSION,
  applyOps,
  emptyGraph,
  firedGuard,
  isBehaviourNode,
  isControlNode,
  isNodeLive,
  isReady,
  projectGraph,
  readyFrontier,
  validate,
} from "../src/index.ts";
import { ORCHESTRATOR, activityAt, commit, resolveSlugs, seeded } from "./fixtures.ts";

function node(name: string, type: string, spec: Record<string, unknown> = {}): AuthoredOp {
  return { op: "add_node", name, type, spec } as unknown as AuthoredOp;
}

function action(name: string): AuthoredOp {
  return {
    op: "add_node",
    name,
    type: "action",
    spec: {
      instruction: `do: ${name}`,
      inputs: [],
      outputs: [{ name: "reply", type: "string" }],
      effect_class: "pure",
    },
  } as unknown as AuthoredOp;
}

function acceptEvent(
  name: string,
  deadline: Deadline = { at: "2026-08-22T17:00:00.000Z" },
): AuthoredOp {
  return {
    op: "add_node",
    name,
    type: "accept_event",
    spec: {
      instruction: `await: ${name}`,
      inputs: [],
      outputs: [],
      effect_class: "pure",
      deadline,
      match: { kind: "event", conditions: [{ kind: "reply", on: "satisfied" }], memory: true },
    },
  } as unknown as AuthoredOp;
}

function edge(from: string, to: string, on?: string): AuthoredOp {
  return {
    op: "add_edge",
    from,
    to,
    ...(on === undefined ? {} : { guard: on === "else" ? "else" : { on } }),
  } as unknown as AuthoredOp;
}

/** The whole pursuit, in ONE commit — claim 4. */
function pursuit(): Graph {
  return seeded([
    node("Start", "initial"),
    node("Split the asks", "fork"),
    action("Ask Dana"),
    acceptEvent("Dana replies"),
    node("Did Dana accept", "decision"),
    action("Book the pitch"),
    node("Both arms in", "join"),
    action("Lock the roster"),
    node("Done", "final"),
    node("Dana declined", "flow_final"),
    // `$N` — the nodes above do not exist at head yet, so the edges name them by batch index.
    // That is §6.4's intra-batch reference, and it is what makes a fan-out one atomic commit.
    edge("$0", "$1"),
    edge("$1", "$2"),
    edge("$1", "$5"),
    edge("$2", "$3"),
    edge("$3", "$4"),
    edge("$4", "$6", "accept"),
    edge("$4", "$9", "else"),
    edge("$5", "$6"),
    edge("$6", "$7"),
    edge("$7", "$8"),
  ]);
}

function nodeOf(graph: Graph, slug: string) {
  const activity = activityAt(graph, slug);
  if (activity === undefined)
    throw new Error(`the pursuit has no node whose name slugs to "${slug}"`);
  return activity;
}

function idOf(graph: Graph, slug: string): string {
  return nodeOf(graph, slug).id;
}

function frontierSlugs(graph: Graph): string[] {
  return readyFrontier(graph)
    .map((activity) => activity.name)
    .toSorted();
}

function run(graph: Graph, ops: AuthoredOp[]): Graph {
  return commit(graph, resolveSlugs(graph, ops) as AuthoredOp[]);
}

describe("the nine node types", () => {
  test("split into two families that between them cover every type, and overlap in none", () => {
    expect([...NODE_TYPES].toSorted()).toEqual(
      [...BEHAVIOUR_NODE_TYPES, ...CONTROL_NODE_TYPES].toSorted(),
    );
    for (const type of NODE_TYPES) {
      expect(isControlNode(type)).toBe(!isBehaviourNode(type));
    }
  });

  test("a control node carries no instruction, no effect class and no clock", () => {
    const graph = pursuit();
    const result = validate({
      graph,
      ops: [node("Bad diamond", "decision", { instruction: "decide something" })],
      actor: ORCHESTRATOR,
      version: graph.version + 1,
      prefix: "t",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.message).toContain("instruction");
  });

  test("a node that IS worked still requires an instruction and an effect class", () => {
    const graph = pursuit();
    const result = validate({
      graph,
      ops: [node("Bare action", "action")],
      actor: ORCHESTRATOR,
      version: graph.version + 1,
      prefix: "t",
    });
    expect(result.ok).toBe(false);
  });

  test("legacy task and wait node types are rejected", () => {
    for (const type of ["task", "wait"]) {
      const result = attempt([{ ...action("Legacy"), type } as unknown as AuthoredOp]);
      expect(result.ok).toBe(false);
    }
  });

  test("an accept_event refuses an on_timeout, because the decision it feeds carries that route", () => {
    const graph = pursuit();
    const result = validate({
      graph,
      ops: [
        {
          op: "add_node",
          name: "Wrongly routed acceptEvent",
          type: "accept_event",
          spec: {
            instruction: "await",
            inputs: [],
            outputs: [],
            effect_class: "pure",
            deadline: { at: "2026-08-22T17:00:00.000Z" },
            on_timeout: idOf(graph, "done"),
            match: {
              kind: "event",
              conditions: [{ kind: "reply", on: "satisfied" }],
              memory: true,
            },
          },
        } as unknown as AuthoredOp,
      ],
      actor: ORCHESTRATOR,
      version: graph.version + 1,
      prefix: "t",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.message).toContain("on_timeout");
  });

  test("an accept_event deadline cannot anchor to a control node", () => {
    const result = attempt([
      node("Start", "initial"),
      acceptEvent("Await reply", { after: "$0", duration: "1h" }),
      node("Route reply", "decision"),
      node("Timed out", "flow_final"),
      node("Answered", "flow_final"),
      edge("$0", "$1"),
      edge("$1", "$2"),
      edge("$2", "$3", "timeout"),
      edge("$2", "$4", "else"),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.reason).toBe("DEADLINE_ANCHOR");
  });

  test("an accept_event is polled and cannot be claimed", () => {
    const graph = pursuit();
    const result = validate({
      graph,
      ops: [
        {
          op: "set_status",
          node: idOf(graph, "dana-replies"),
          status: "active",
          evidence_ref: "claim",
        },
      ],
      actor: ORCHESTRATOR,
      version: graph.version + 1,
      prefix: "t",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.reason).toBe("ACCEPT_EVENT_NOT_CLAIMABLE");
  });

  test("an inactive action cannot be claimed", () => {
    const graph = pursuit();
    const result = validate({
      graph,
      ops: [
        {
          op: "set_status",
          node: idOf(graph, "lock-the-roster"),
          status: "active",
          evidence_ref: "claim",
        },
      ],
      actor: ORCHESTRATOR,
      version: graph.version + 1,
      prefix: "t",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.reason).toBe("NOT_READY");
  });

  test("a newly added accept_event cannot be claimed in the same batch", () => {
    const result = attempt([
      node("Start", "initial"),
      acceptEvent("Await reply"),
      node("Route", "decision"),
      node("Done", "final"),
      node("Timed out", "flow_final"),
      edge("$0", "$1"),
      edge("$1", "$2"),
      edge("$2", "$3", "satisfied"),
      edge("$2", "$4", "else"),
      { op: "set_status", node: "$1", status: "active", evidence_ref: "claim" },
    ] as AuthoredOp[]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.reason).toBe("ACCEPT_EVENT_NOT_CLAIMABLE");
  });

  test("two claims in one batch cannot bypass exclusivity", () => {
    const graph = pursuit();
    const claim = {
      op: "set_status",
      node: idOf(graph, "ask-dana"),
      status: "active",
      evidence_ref: "claim",
    } as const;
    const result = validate({
      graph,
      ops: [claim, claim],
      actor: ORCHESTRATOR,
      version: graph.version + 1,
      prefix: "t",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.reason).toBe("ALREADY_CLAIMED");
  });

  test("superseding a control without a replacement makes it non-live", () => {
    const graph = pursuit();
    const decision = nodeOf(graph, "did-dana-accept");
    const applied = applyOps(
      graph,
      [{ op: "supersede_node", node: decision.id }],
      graph.version + 1,
    );
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      const retired = applied.value.nodes.get(decision.id);
      expect(retired?.provenance).toMatchObject({ retired: true, superseded_by: null });
      if (retired !== undefined) expect(isNodeLive(retired)).toBe(false);
      expect(
        projectGraph(applied.value).nodes.find((candidate) => candidate.id === decision.id)
          ?.provenance,
      ).toMatchObject({ retired: true, superseded_by: null });
    }
  });

  test("a control tombstone is excluded from validation's live graph", () => {
    const graph = seeded([
      node("Start", "initial"),
      action("First"),
      node("Old end", "final"),
      edge("$0", "$1"),
      edge("$1", "$2"),
    ]);
    const oldEnd = idOf(graph, "old-end");
    const result = validate({
      graph,
      ops: [
        { op: "supersede_node", node: oldEnd },
        action("Second"),
        node("New end", "final"),
        { op: "add_edge", from: idOf(graph, "first"), to: "$1" },
        { op: "add_edge", from: "$1", to: "$2" },
      ],
      actor: ORCHESTRATOR,
      version: graph.version + 1,
      prefix: "t",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const retired = result.value.graph.nodes.get(oldEnd);
      expect(retired?.provenance).toMatchObject({ retired: true, superseded_by: null });
      if (retired !== undefined) expect(isNodeLive(retired)).toBe(false);
    }
  });

  test("validation never skips a missing live initial after genesis", () => {
    let graph = seeded([action("A"), action("B")]);
    graph = commit(graph, [edge("a", "b"), edge("b", "a")]);
    const result = validate({
      graph,
      ops: [
        { op: "record_outcome", node: idOf(graph, "a"), verdict: "confirmed", evidence_ref: "e" },
      ],
      actor: ORCHESTRATOR,
      version: graph.version + 1,
      prefix: "t",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.reason).toBe("INITIAL_NODE");
      expect(result.rejection.invariant).toBeUndefined();
    }
  });
});

describe("readiness across a control node", () => {
  test("the fork's two arms are BOTH on the frontier, from one initial node", () => {
    // Claim 1 and claim 4: nothing upstream of these two is a behaviour node, so an empty
    // frontier here would mean satisfaction never crossed the initial or the fork.
    expect(frontierSlugs(pursuit())).toEqual(["Ask Dana", "Book the pitch"]);
  });

  test("a control node is never on the frontier, whatever the graph does", () => {
    // Claim 2. Asserted over every version this test file produces, not just the first.
    let graph = pursuit();
    for (const step of [
      () =>
        run(graph, [
          {
            op: "set_status",
            node: "ask-dana",
            status: "completed",
            evidence_ref: "e",
          } as unknown as AuthoredOp,
        ]),
      () =>
        run(graph, [
          {
            op: "set_status",
            node: "book-the-pitch",
            status: "completed",
            evidence_ref: "e",
          } as unknown as AuthoredOp,
        ]),
    ]) {
      graph = step();
      for (const activity of readyFrontier(graph)) {
        expect(isControlNode(activity.type)).toBe(false);
      }
    }
  });

  test("the join holds until BOTH arms are done, then releases the step behind it", () => {
    let graph = pursuit();
    const lock = () => nodeOf(graph, "lock-the-roster");

    graph = run(graph, [
      {
        op: "set_status",
        node: "book-the-pitch",
        status: "completed",
        evidence_ref: "e",
      } as unknown as AuthoredOp,
    ]);
    expect(isReady(graph, lock())).toBe(false);

    // Dana's arm: the send finishes, the acceptEvent resolves `satisfied`, the decision takes `accept`.
    graph = run(graph, [
      {
        op: "set_status",
        node: "ask-dana",
        status: "completed",
        evidence_ref: "e",
      } as unknown as AuthoredOp,
    ]);
    expect(isReady(graph, lock())).toBe(false);

    graph = run(graph, [
      {
        op: "record_outcome",
        node: "dana-replies",
        verdict: "accept",
        evidence_ref: "e",
      } as unknown as AuthoredOp,
      {
        op: "set_status",
        node: "dana-replies",
        status: "completed",
        evidence_ref: "e",
      } as unknown as AuthoredOp,
    ]);
    expect(frontierSlugs(graph)).toEqual(["Lock the roster"]);
  });
});

describe("a decision picks exactly one arm", () => {
  test("nothing fires while the acceptEvent is still open", () => {
    const graph = pursuit();
    expect(firedGuard(graph, nodeOf(graph, "did-dana-accept"))).toBeNull();
  });

  test("the guarded arm fires on a matching resolution, and the else arm does not", () => {
    let graph = pursuit();
    graph = run(graph, [
      {
        op: "set_status",
        node: "ask-dana",
        status: "completed",
        evidence_ref: "e",
      } as unknown as AuthoredOp,
      {
        op: "record_outcome",
        node: "dana-replies",
        verdict: "accept",
        evidence_ref: "e",
      } as unknown as AuthoredOp,
      {
        op: "set_status",
        node: "dana-replies",
        status: "completed",
        evidence_ref: "e",
      } as unknown as AuthoredOp,
    ]);
    const fired = firedGuard(graph, nodeOf(graph, "did-dana-accept"));
    expect(fired?.to).toBe(idOf(graph, "both-arms-in"));
    expect(fired?.guard).toEqual({ on: "accept" });
  });

  test("a resolution no guard matches falls to the else arm, so a decision can never fail to route", () => {
    // `ignore` is a real resolution with no guard on this decision — exactly the case the
    // mandatory else arm exists for.
    let graph = pursuit();
    graph = run(graph, [
      {
        op: "set_status",
        node: "ask-dana",
        status: "completed",
        evidence_ref: "e",
      } as unknown as AuthoredOp,
      {
        op: "record_outcome",
        node: "dana-replies",
        verdict: "ignore",
        evidence_ref: "e",
      } as unknown as AuthoredOp,
      {
        op: "set_status",
        node: "dana-replies",
        status: "completed",
        evidence_ref: "e",
      } as unknown as AuthoredOp,
    ]);
    const fired = firedGuard(graph, nodeOf(graph, "did-dana-accept"));
    expect(fired?.to).toBe(idOf(graph, "dana-declined"));

    // And the arm it did NOT take carries nothing: the join stays shut, so the step behind it
    // never reaches the frontier. This is §6.4's fail-safe, which is the whole point.
    expect(isReady(graph, nodeOf(graph, "lock-the-roster"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// S1-S7 — the eight shapes that must be refused, each naming the offending node
// ---------------------------------------------------------------------------

/** Validate a batch against an empty pursuit and hand back whatever came out. */
function attempt(ops: AuthoredOp[]) {
  return validate({
    graph: emptyGraph(SCHEMA_VERSION),
    ops,
    actor: ORCHESTRATOR,
    version: 1,
    prefix: "t",
  });
}

function rejection(ops: AuthoredOp[]) {
  const result = attempt(ops);
  if (result.ok) throw new Error("expected a refusal, and the batch was accepted");
  return result.rejection;
}

/** initial -> action -> final. The smallest legal activity, and the base every shape below bends. */
const LEGAL: AuthoredOp[] = [
  node("Start", "initial"),
  action("Do the thing"),
  node("Done", "final"),
  edge("$0", "$1"),
  edge("$1", "$2"),
];

describe("structure is refused by shape, not by convention", () => {
  test("the base graph really is legal, or every assertion below proves nothing", () => {
    expect(attempt(LEGAL).ok).toBe(true);
  });

  test("two initial nodes (S1)", () => {
    const r = rejection([
      node("Start", "initial"),
      node("Also start", "initial"),
      node("Both in", "merge"),
      action("Do the thing"),
      node("Done", "final"),
      edge("$0", "$2"),
      edge("$1", "$2"),
      edge("$2", "$3"),
      edge("$3", "$4"),
    ]);
    expect(r.code).toBe("INVARIANT_VIOLATION");
    expect(r.reason).toBe("INITIAL_NODE");
  });

  test("an action with two in-edges (S7) — the rule that replaced merge:all|any", () => {
    const r = rejection([
      node("Start", "initial"),
      node("Split", "fork"),
      action("Left"),
      action("Converge here"),
      node("Done", "final"),
      edge("$0", "$1"),
      edge("$1", "$2"),
      edge("$1", "$3"),
      edge("$2", "$3"),
      edge("$3", "$4"),
    ]);
    expect(r.code).toBe("REFUSED");
    expect(r.reason).toBe("ARITY");
    expect(r.message).toContain("in-edge");
  });

  test("a decision with no else arm (S3)", () => {
    const r = rejection([
      node("Start", "initial"),
      acceptEvent("Someone replies"),
      node("Which way", "decision"),
      node("Yes", "flow_final"),
      node("No", "flow_final"),
      edge("$0", "$1"),
      edge("$1", "$2"),
      edge("$2", "$3", "accept"),
      edge("$2", "$4", "ignore"),
    ]);
    expect(r.reason).toBe("NO_ELSE_ARM");
  });

  test("a decision with two else arms (S3)", () => {
    const r = rejection([
      node("Start", "initial"),
      acceptEvent("Someone replies"),
      node("Which way", "decision"),
      node("Yes", "flow_final"),
      node("No", "flow_final"),
      edge("$0", "$1"),
      edge("$1", "$2"),
      edge("$2", "$3", "else"),
      edge("$2", "$4", "else"),
    ]);
    expect(r.reason).toBe("AMBIGUOUS_ELSE");
  });

  test("a acceptEvent wired to anything but a decision (S4) — the pivot-fires-unapproved rule", () => {
    const r = rejection([
      node("Start", "initial"),
      acceptEvent("Someone replies"),
      action("Fire the pivot"),
      node("Done", "final"),
      edge("$0", "$1"),
      edge("$1", "$2"),
      edge("$2", "$3"),
    ]);
    expect(r.reason).toBe("WAIT_MUST_ROUTE");
    expect(r.message).toContain("routed by a guard");
  });

  test("a guard on an edge that does not leave a decision (S5)", () => {
    const r = rejection([
      node("Start", "initial"),
      action("Do the thing"),
      node("Done", "final"),
      edge("$0", "$1"),
      edge("$1", "$2", "accept"),
    ]);
    expect(r.reason).toBe("GUARD_OUTSIDE_DECISION");
  });

  test("a node unreachable from the initial node (S1)", () => {
    // An orphan island must contain a CYCLE to exist at all, and that is a consequence of the
    // arity table rather than a coincidence: every type except `initial` needs at least one
    // in-edge, and there is only ever one initial. So an island has no way to start.
    const r = rejection([
      ...LEGAL,
      action("Orbiting A"),
      action("Orbiting B"),
      edge("$5", "$6"),
      edge("$6", "$5"),
    ]);
    expect(r.code).toBe("INVARIANT_VIOLATION");
    expect(r.reason).toBe("UNREACHABLE_NODE");
  });

  test("a cycle that is reachable AND grounded, so only S6 can catch it", () => {
    // Reachable from the initial node and every node reaches the final, so S1 and S2 both
    // pass. This is the shape that exists to prove S6 is doing work of its own rather than
    // being an accident of the other two.
    const r = rejection([
      node("Start", "initial"),
      node("Back here", "merge"),
      node("Again?", "decision"),
      action("Round we go"),
      node("Done", "final"),
      edge("$0", "$1"),
      edge("$1", "$2"),
      edge("$2", "$3", "accept"),
      edge("$2", "$4", "else"),
      edge("$3", "$1"),
    ]);
    expect(r.code).toBe("INVARIANT_VIOLATION");
    expect(r.reason).toBe("CYCLE");
  });
});

describe("the cascade runs THROUGH a control node", () => {
  test("the untaken arm's work is withdrawn, and no control node is given a status", () => {
    let graph = pursuit();
    graph = run(graph, [
      {
        op: "set_status",
        node: "ask-dana",
        status: "completed",
        evidence_ref: "e",
      } as unknown as AuthoredOp,
      {
        op: "record_outcome",
        node: "dana-replies",
        verdict: "ignore",
        evidence_ref: "e",
      } as unknown as AuthoredOp,
      {
        op: "set_status",
        node: "dana-replies",
        status: "completed",
        evidence_ref: "e",
      } as unknown as AuthoredOp,
    ]);

    // The decision took its else arm, so the join can never complete and the step behind it
    // is on a dead arm. Under S7 a diamond and a bar sit between the acceptEvent and that step, so
    // this only holds if the cascade walked through both.
    const lock = nodeOf(graph, "lock-the-roster");
    expect(lock.status?.state).toBe("inactive");

    // And not one control node acquired a status on the way past.
    for (const activity of graph.nodes.values()) {
      // Not "still inactive" — it has NO status key at all (D6). That is the difference
      // between a convention every writer has to remember and a shape the compiler enforces,
      // and this assertion is the one that would have caught the cascade writing one.
      if (isControlNode(activity.type)) expect(activity.status).toBeUndefined();
    }
  });

  test("a join excludes a dead input and passes its remaining completed arm", () => {
    let graph = pursuit();
    graph = run(graph, [
      { op: "set_status", node: "ask-dana", status: "completed", evidence_ref: "e" },
      {
        op: "record_outcome",
        node: "dana-replies",
        verdict: "ignore",
        evidence_ref: "e",
      },
      {
        op: "set_status",
        node: "dana-replies",
        status: "completed",
        evidence_ref: "e",
      },
      {
        op: "set_status",
        node: "book-the-pitch",
        status: "completed",
        evidence_ref: "e",
      },
    ]);
    expect(frontierSlugs(graph)).toEqual(["Lock the roster"]);
  });
});

describe("a guard reads the verdict, not the resolution projection", () => {
  /**
   * Its own graph, guarded on a VERDICT rather than on a resolution — the shared `pursuit()`
   * fixture guards on `accept` and is used by the tests above, and a decision has exactly one
   * else arm, so there is nowhere to hang a second spelling without changing what those test.
   *
   *   ● → (Someone replies) → ◇ ─confirmed→ ⊗ yes
   *                            └─else──────→ ⊗ no
   */
  function routed(verdict: string) {
    const graph = run(
      seeded([
        node("Start", "initial"),
        acceptEvent("Someone replies"),
        node("Yes or no", "decision"),
        node("They said yes", "flow_final"),
        node("They did not", "flow_final"),
        edge("$0", "$1"),
        edge("$1", "$2"),
        edge("$2", "$3", "confirmed"),
        edge("$2", "$4", "else"),
      ]),
      [
        {
          op: "record_outcome",
          node: "someone-replies",
          verdict,
          evidence_ref: "e",
        } as unknown as AuthoredOp,
        {
          op: "set_status",
          node: "someone-replies",
          status: "completed",
          evidence_ref: "e",
        } as unknown as AuthoredOp,
      ],
    );
    return { graph, fired: firedGuard(graph, nodeOf(graph, "yes-or-no")) };
  }

  test("`confirmed` and `declined` take DIFFERENT arms, which the projection cannot express", () => {
    // This is the whole reason guards read verdicts. `resolutionOf` maps both of these onto
    // `satisfied` — the acceptEvent resolved either way — so a guard spelled against the projection
    // fires identically for yes and for no, which is the single most important routing
    // question the product asks. Found by writing this test and watching the arm not fire.
    const yes = routed("confirmed");
    const no = routed("declined");

    expect(yes.fired?.to).toBe(idOf(yes.graph, "they-said-yes"));
    expect(no.fired?.to).toBe(idOf(no.graph, "they-did-not"));
    expect(yes.fired?.to).not.toBe(no.fired?.to);
  });

  test("and the projection still works for the resolutions written against it", () => {
    // `timed_out` projects to `timeout`, and a guard may name either. Both must reach the same
    // arm, or every acceptEvent authored before this change would silently stop routing.
    const timedOut = routed("timed_out");
    expect(timedOut.fired?.to).toBe(idOf(timedOut.graph, "they-did-not"));
  });
});

describe("predicate guards", () => {
  test("use the same count grammar and traverse the decision's incoming flow", () => {
    let graph = seeded([
      node("Start", "initial"),
      action("Collect answer"),
      node("Enough answers", "decision"),
      node("Enough", "flow_final"),
      node("Not enough", "flow_final"),
      edge("$0", "$1"),
      edge("$1", "$2"),
      {
        op: "add_edge",
        from: "$2",
        to: "$3",
        guard: { count: { verdict: "confirmed" }, op: ">=", n: 1 },
      },
      edge("$2", "$4", "else"),
    ] as AuthoredOp[]);
    graph = run(graph, [
      { op: "record_outcome", node: "collect-answer", verdict: "confirmed", evidence_ref: "e" },
      { op: "set_status", node: "collect-answer", status: "completed", evidence_ref: "e" },
    ] as AuthoredOp[]);
    expect(firedGuard(graph, nodeOf(graph, "enough-answers"))?.to).toBe(idOf(graph, "enough"));
  });
});
