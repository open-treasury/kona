/**
 * The six ops, as pure functions over a graph (§6.4).
 *
 * This module is shared by `fold` and by `mutate`'s pre-commit dry run, which is the
 * point: the state a mutation is validated against is produced by the same code that
 * will later reproduce it from the log. There is no second implementation to drift.
 */

import type { CommittedOp } from "./schema.ts";
import { namedIn } from "./named.ts";
import { INITIAL_STATUS, isUnclaimed } from "./vocab.ts";
import { parseEffectEvidence } from "./effect.ts";
import type { BehaviourNode, Edge, Graph, ActivityNode, OutcomeRecord } from "./graph.ts";
import { isActivityTerminal, resolvingOutcome } from "./graph.ts";
import { type Result, ok, refuse } from "./result.ts";

/**
 * §6.4 — "Internal order: additions and rewires before cancellations."
 *
 * A stable partition rather than a sort: order *within* each class is the authored array
 * order, so `ops[1]` still applies before `ops[2]`. What moves is cancellation, which
 * goes last so that a batch superseding an activity and adding its compensation is legal
 * however the author happened to sequence the two.
 */
const CANCELLATION_OPS = new Set(["supersede_node"]);

/** An op paired with the position it held in the authored array, for error reporting. */
export interface PositionedOp {
  op: CommittedOp;
  index: number;
}

export function orderOps(ops: readonly CommittedOp[]): PositionedOp[] {
  const positioned = ops.map((op, index) => ({ op, index }));
  return [
    ...positioned.filter((entry) => !CANCELLATION_OPS.has(entry.op.op)),
    ...positioned.filter((entry) => CANCELLATION_OPS.has(entry.op.op)),
  ];
}

/**
 * `spec` is shared by reference on purpose: §6.2 makes it the AUTHORED half, changed only
 * by an op that replaces the whole activity, never edited in place. Everything an op *does*
 * write — status and provenance — is copied.
 *
 * Hand-written rather than `structuredClone` because `core` declares no ambient runtime:
 * zero deps, no globals, nothing to stub. That is what makes the mutation-score target on
 * this file affordable (§6.12).
 */

/**
 * Look up the node an op targets, and refuse it if the op has no business there.
 *
 * `set_status`, `record_outcome` and `record_output` all write to `status`, and a control node
 * has none. Before D6 that was a convention: nothing refused the op, `applyOps` would have
 * written the field onto a diamond, and the graph would have carried a status on a node whose
 * whole definition is that it has none. The union made it a type error, which is how the
 * missing RULE was found — the compiler asking "which family did you mean" at 129 sites, and
 * three of them having no answer.
 */
function targetBehaviour(
  graph: Graph,
  id: string,
  op: string,
  at: { op_index?: number },
): Result<BehaviourNode> {
  const node = graph.nodes.get(id);
  if (node === undefined) {
    return refuse("UNKNOWN_ACTIVITY", `activity '${id}' does not exist`, { activity: id, ...at });
  }
  if (node.status === undefined) {
    return refuse(
      "CONTROL_NODE_TARGETED",
      `${op} targets ${namedIn(graph, id)}, which is a ${node.type} — control nodes are derived by the store and carry no status`,
      { activity: id, ...at },
    );
  }
  return ok(node);
}

function cloneActivity(activity: ActivityNode): ActivityNode {
  // A control node has no `status` key to deep-copy — not an empty one, none (D6). Spreading
  // `undefined` back in would put the key there with an undefined value, which is exactly the
  // "shared shape with unused fields" the union exists to prevent.
  if (activity.status === undefined) {
    return { ...activity, provenance: { ...activity.provenance } };
  }
  return {
    ...activity,
    status: {
      ...activity.status,
      conditions: [...activity.status.conditions],
      outcomes: activity.status.outcomes.map((entry) => ({ ...entry })),
      effect_log: activity.status.effect_log.map((entry) => ({ ...entry })),
    },
    provenance: { ...activity.provenance },
  };
}

function cloneGraph(graph: Graph): Graph {
  return {
    schema_version: graph.schema_version,
    version: graph.version,
    nodes: new Map([...graph.nodes].map(([id, activity]) => [id, cloneActivity(activity)])),
    edges: graph.edges.map((edge) => ({ ...edge })),
  };
}

function makeNode(op: Extract<CommittedOp, { op: "add_node" }>, version: number): ActivityNode {
  const provenance = {
    created_by_version: version,
    supersedes: null,
    superseded_by: null,
    retired: false,
  };

  // The one place a node is born, and the one place the family decides its shape. A control
  // node is created WITHOUT a status key, so nothing downstream can read one off it by
  // accident — which is the whole of D6, enforced once rather than remembered everywhere.
  if (op.type === "action" || op.type === "accept_event") {
    return {
      id: op.id,
      type: op.type,
      name: op.name,
      spec: op.spec,
      status: {
        state: INITIAL_STATUS,
        outcomes: [],
        outcome: null,
        output: null,
        output_evidence: null,
        conditions: [],
        effect_log: [],
        observed_at_version: version,
      },
      provenance,
    } as ActivityNode;
  }

  return {
    id: op.id,
    type: op.type,
    name: op.name ?? op.type,
    spec: op.spec,
    provenance,
  };
}

function sameEdge(a: Edge, b: Edge): boolean {
  return a.from === b.from && a.to === b.to && JSON.stringify(a.guard) === JSON.stringify(b.guard);
}

/**
 * Apply one op to a graph the caller already owns. Mutates `graph` in place; callers go
 * through `applyOps`, which hands it a clone.
 */
function applyOne(
  graph: Graph,
  op: CommittedOp,
  version: number,
  occurredAt: string,
  opIndex: number,
): Result<null> {
  const at = { op_index: opIndex };

  switch (op.op) {
    case "add_node": {
      if (graph.nodes.has(op.id)) {
        return refuse("DUPLICATE_ACTIVITY_ID", `activity '${op.id}' already exists`, {
          activity: op.id,
          ...at,
        });
      }
      graph.nodes.set(op.id, makeNode(op, version));
      return ok(null);
    }

    case "add_edge": {
      if (op.from === op.to) {
        return refuse("SELF_EDGE", `${namedIn(graph, op.from)} cannot require itself`, {
          activity: op.from,
          ...at,
        });
      }
      for (const endpoint of [op.from, op.to]) {
        if (!graph.nodes.has(endpoint)) {
          return refuse("UNKNOWN_ACTIVITY", `edge endpoint '${endpoint}' does not exist`, {
            activity: endpoint,
            ...at,
          });
        }
      }
      const edge: Edge = {
        from: op.from,
        to: op.to,
        ...(op.guard === undefined ? {} : { guard: op.guard }),
      };
      if (graph.edges.some((existing) => sameEdge(existing, edge))) {
        return refuse(
          "DUPLICATE_EDGE",
          `an identical edge ${namedIn(graph, op.from)} -> ${namedIn(graph, op.to)} already exists`,
          { activity: op.to, ...at },
        );
      }
      graph.edges.push(edge);
      return ok(null);
    }

    case "set_status": {
      const found = targetBehaviour(graph, op.node, op.op, at);
      if (!found.ok) return found;
      const activity = found.value;
      // §6.6 — the outbox rides on `evidence_ref`, because there is no seventh op. This
      // MATERIALISES what the log already says; it decides nothing, so re-folding an old
      // log cannot produce an effect ledger the operator never approved.
      const evidence = parseEffectEvidence(op.evidence_ref);
      if (evidence !== null && evidence.kind === "reserve") {
        activity.status.effect_log.push({
          effect_key: evidence.effect_key,
          payload_hash: evidence.payload_hash,
          attempted_at: occurredAt,
          completed_at: null,
          outcome: null,
          message_id: null,
        });
      } else if (evidence !== null) {
        const reserved = activity.status.effect_log.find(
          (entry) => entry.effect_key === evidence.effect_key && entry.completed_at === null,
        );
        if (reserved === undefined) {
          return refuse(
            "UNRESERVED_EFFECT",
            `no open reservation '${evidence.effect_key}' on '${op.node}' to record against`,
            { activity: op.node, ...at },
          );
        }
        reserved.completed_at = occurredAt;
        reserved.outcome = evidence.outcome;
        reserved.message_id = evidence.message_id;
      }
      activity.status.state = op.status;
      activity.status.observed_at_version = version;
      return ok(null);
    }

    case "record_outcome": {
      const found = targetBehaviour(graph, op.node, op.op, at);
      if (!found.ok) return found;
      const activity = found.value;
      // Append, never overwrite (§6.7). A `late` reply must not be able to replace the
      // verdict the graph already acted on.
      const recorded: OutcomeRecord = {
        verdict: op.verdict,
        evidence_ref: op.evidence_ref,
        ...(op.attrs === undefined ? {} : { attrs: op.attrs }),
        at_version: version,
      };
      activity.status.outcomes.push(recorded);
      activity.status.outcome = resolvingOutcome(activity.status.outcomes);
      activity.status.observed_at_version = version;
      return ok(null);
    }

    case "record_output": {
      const found = targetBehaviour(graph, op.node, op.op, at);
      if (!found.ok) return found;
      const activity = found.value;
      if (activity.type !== "action") {
        return refuse(
          "ACCEPT_EVENT_OUTPUT",
          `record_output targets ${namedIn(graph, op.node)}; only actions produce outputs`,
          { activity: op.node, ...at },
        );
      }
      // §6.2: `outputs` is what makes `inputs[].ref` mean anything. An output nobody
      // declared can never be referenced, so writing one is an authoring error, not data.
      if (!activity.spec.outputs.some((declared) => declared.name === op.output_name)) {
        return refuse(
          "UNDECLARED_OUTPUT",
          `activity ${namedIn(graph, op.node)} declares no output named '${op.output_name}'`,
          { activity: op.node, ...at },
        );
      }
      activity.status.output = { ...activity.status.output, [op.output_name]: op.value };
      activity.status.output_evidence = {
        ...activity.status.output_evidence,
        [op.output_name]: op.evidence_ref,
      };
      activity.status.observed_at_version = version;
      return ok(null);
    }

    case "supersede_node": {
      const activity = graph.nodes.get(op.node);
      if (activity === undefined) {
        return refuse("UNKNOWN_ACTIVITY", `activity '${op.node}' does not exist`, {
          activity: op.node,
          ...at,
        });
      }
      if (op.by !== undefined) {
        const replacement = graph.nodes.get(op.by);
        if (replacement === undefined) {
          return refuse("UNKNOWN_ACTIVITY", `replacement activity '${op.by}' does not exist`, {
            activity: op.by,
            ...at,
          });
        }
        if (op.by === op.node) {
          return refuse("SELF_SUPERSEDE", `'${op.node}' cannot supersede itself`, {
            activity: op.node,
            ...at,
          });
        }
        replacement.provenance.supersedes = op.node;
      }
      activity.provenance.retired = true;
      activity.provenance.superseded_by = op.by ?? null;
      // Derivable housekeeping, so the store does it (§6.4). A node that already ran keeps
      // its terminal status — superseding does not un-send an email — but one that has not
      // stops being work.
      //
      // WHICH kind of stopping is derivable too, and that is why the old single `dropped`
      // became two states: a node nobody had claimed was set aside by the flow going
      // elsewhere, and one that was being worked was stopped mid-work. The store reads which
      // from the state it finds, so an author never chooses and the two can never be mixed
      // up by hand. This site is also the proof that the cascade's guarantee is narrower than
      // it looks: `isDroppable` refuses to touch a claimed node, but supersede reaches one.
      if (activity.status !== undefined && !isActivityTerminal(activity)) {
        activity.status.state = isUnclaimed(activity.status.state) ? "withdrawn" : "terminated";
        activity.status.observed_at_version = version;
      }
      return ok(null);
    }
  }
}

/**
 * Apply a committed batch. Returns a new graph; `graph` is never touched, which is what
 * lets invariant 1 compare pre-commit head against the post-commit result.
 */
/**
 * Stand-in timestamp for a DRY RUN. `validate` applies a batch against a clone purely to
 * test the invariants, and that graph is discarded — `mutate` writes the record and the
 * next read folds it with the record's real `occurred_at`. Nothing stamped with this ever
 * reaches disk.
 */
const DRY_RUN_TIME = "";

export function applyOps(
  graph: Graph,
  ops: readonly CommittedOp[],
  version: number,
  occurredAt: string = DRY_RUN_TIME,
): Result<Graph> {
  const draft = cloneGraph(graph);
  for (const { op, index } of orderOps(ops)) {
    const outcome = applyOne(draft, op, version, occurredAt, index);
    if (!outcome.ok) return outcome;
  }
  draft.version = version;
  return ok(draft);
}
