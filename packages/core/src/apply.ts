/**
 * The six ops, as pure functions over a graph (§6.4).
 *
 * This module is shared by `fold` and by `mutate`'s pre-commit dry run, which is the
 * point: the state a mutation is validated against is produced by the same code that
 * will later reproduce it from the log. There is no second implementation to drift.
 */

import type { CommittedOp } from "./schema.ts";
import type { Edge, Graph, Node, NodeSpec, OutcomeRecord } from "./graph.ts";
import { isNodeTerminal, resolvingOutcome } from "./graph.ts";
import { type Result, ok, refuse } from "./result.ts";

/**
 * §6.4 — "Internal order: additions and rewires before cancellations."
 *
 * A stable partition rather than a sort: order *within* each class is the authored array
 * order, so `ops[1]` still applies before `ops[2]`. What moves is cancellation, which
 * goes last so that a batch superseding a node and adding its compensation is legal
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
 * by an op that replaces the whole node, never edited in place. Everything an op *does*
 * write — status and provenance — is copied.
 *
 * Hand-written rather than `structuredClone` because `core` declares no ambient runtime:
 * zero deps, no globals, nothing to stub. That is what makes the mutation-score target on
 * this file affordable (§6.12).
 */
function cloneNode(node: Node): Node {
  return {
    ...node,
    status: {
      ...node.status,
      conditions: [...node.status.conditions],
      outcomes: node.status.outcomes.map((entry) => ({ ...entry })),
      effect_log: node.status.effect_log.map((entry) => ({ ...entry })),
    },
    provenance: { ...node.provenance },
  };
}

function cloneGraph(graph: Graph): Graph {
  return {
    schema_version: graph.schema_version,
    version: graph.version,
    nodes: new Map([...graph.nodes].map(([id, node]) => [id, cloneNode(node)])),
    edges: graph.edges.map((edge) => ({ ...edge })),
  };
}

function makeNode(
  id: string,
  label: string,
  type: Node["type"],
  spec: NodeSpec,
  scope: string | undefined,
  version: number,
): Node {
  return {
    id,
    type,
    label,
    spec,
    status: {
      state: "active",
      outcomes: [],
      outcome: null,
      output: null,
      conditions: [],
      effect_log: [],
      observed_at_version: version,
    },
    provenance: {
      created_by_version: version,
      ...(scope === undefined ? {} : { group: scope }),
      supersedes: null,
      superseded_by: null,
    },
  };
}

function sameEdge(a: Edge, b: Edge): boolean {
  return a.from === b.from && a.to === b.to && a.condition?.on === b.condition?.on;
}

/**
 * Apply one op to a graph the caller already owns. Mutates `graph` in place; callers go
 * through `applyOps`, which hands it a clone.
 */
function applyOne(
  graph: Graph,
  op: CommittedOp,
  version: number,
  opIndex: number,
): Result<null> {
  const at = { op_index: opIndex };

  switch (op.op) {
    case "add_node": {
      if (graph.nodes.has(op.id)) {
        return refuse("DUPLICATE_NODE_ID", `node '${op.id}' already exists`, {
          node: op.id,
          ...at,
        });
      }
      graph.nodes.set(
        op.id,
        makeNode(op.id, op.label, op.type, op.spec, op.scope, version),
      );
      return ok(null);
    }

    case "add_edge": {
      if (op.from === op.to) {
        return refuse("SELF_EDGE", `'${op.from}' cannot require itself`, {
          node: op.from,
          ...at,
        });
      }
      for (const endpoint of [op.from, op.to]) {
        if (!graph.nodes.has(endpoint)) {
          return refuse("UNKNOWN_NODE", `edge endpoint '${endpoint}' does not exist`, {
            node: endpoint,
            ...at,
          });
        }
      }
      const edge: Edge = {
        from: op.from,
        to: op.to,
        ...(op.condition === undefined ? {} : { condition: op.condition }),
      };
      if (graph.edges.some((existing) => sameEdge(existing, edge))) {
        return refuse(
          "DUPLICATE_EDGE",
          `an identical edge '${op.from}' -> '${op.to}' already exists`,
          { node: op.to, ...at },
        );
      }
      graph.edges.push(edge);
      return ok(null);
    }

    case "set_status": {
      const node = graph.nodes.get(op.node);
      if (node === undefined) {
        return refuse("UNKNOWN_NODE", `node '${op.node}' does not exist`, {
          node: op.node,
          ...at,
        });
      }
      node.status.state = op.status;
      node.status.observed_at_version = version;
      return ok(null);
    }

    case "record_outcome": {
      const node = graph.nodes.get(op.node);
      if (node === undefined) {
        return refuse("UNKNOWN_NODE", `node '${op.node}' does not exist`, {
          node: op.node,
          ...at,
        });
      }
      // Append, never overwrite (§6.7). A `late` reply must not be able to replace the
      // verdict the graph already acted on.
      const recorded: OutcomeRecord = {
        verdict: op.verdict,
        evidence_ref: op.evidence_ref,
        ...(op.attrs === undefined ? {} : { attrs: op.attrs }),
        at_version: version,
      };
      node.status.outcomes.push(recorded);
      node.status.outcome = resolvingOutcome(node.status.outcomes);
      node.status.observed_at_version = version;
      return ok(null);
    }

    case "record_output": {
      const node = graph.nodes.get(op.node);
      if (node === undefined) {
        return refuse("UNKNOWN_NODE", `node '${op.node}' does not exist`, {
          node: op.node,
          ...at,
        });
      }
      // §6.2: `outputs` is what makes `inputs[].ref` mean anything. An output nobody
      // declared can never be referenced, so writing one is an authoring error, not data.
      if (!node.spec.outputs.some((declared) => declared.name === op.output_name)) {
        return refuse(
          "UNDECLARED_OUTPUT",
          `node '${op.node}' declares no output named '${op.output_name}'`,
          { node: op.node, ...at },
        );
      }
      node.status.output = { ...node.status.output, [op.output_name]: op.value };
      node.status.observed_at_version = version;
      return ok(null);
    }

    case "supersede_node": {
      const node = graph.nodes.get(op.node);
      if (node === undefined) {
        return refuse("UNKNOWN_NODE", `node '${op.node}' does not exist`, {
          node: op.node,
          ...at,
        });
      }
      if (op.by !== undefined) {
        const replacement = graph.nodes.get(op.by);
        if (replacement === undefined) {
          return refuse("UNKNOWN_NODE", `replacement node '${op.by}' does not exist`, {
            node: op.by,
            ...at,
          });
        }
        if (op.by === op.node) {
          return refuse("SELF_SUPERSEDE", `'${op.node}' cannot supersede itself`, {
            node: op.node,
            ...at,
          });
        }
        replacement.provenance.supersedes = op.node;
      }
      node.provenance.superseded_by = op.by ?? null;
      // Derivable housekeeping, so the store does it (§6.4). A node that already ran
      // keeps its terminal status — superseding does not un-send an email — but one still
      // in flight stops being work: `dropped` is "we stopped wanting this".
      if (!isNodeTerminal(node)) {
        node.status.state = "dropped";
        node.status.observed_at_version = version;
      }
      return ok(null);
    }
  }
}

/**
 * Apply a committed batch. Returns a new graph; `graph` is never touched, which is what
 * lets invariant 1 compare pre-commit head against the post-commit result.
 */
export function applyOps(
  graph: Graph,
  ops: readonly CommittedOp[],
  version: number,
): Result<Graph> {
  const draft = cloneGraph(graph);
  for (const { op, index } of orderOps(ops)) {
    const outcome = applyOne(draft, op, version, index);
    if (!outcome.ok) return outcome;
  }
  draft.version = version;
  return ok(draft);
}
