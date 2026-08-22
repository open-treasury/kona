/**
 * The graph. §6.1: there is no snapshot — this value only ever exists as the result of
 * folding the log, and nothing persists it.
 *
 * Node order is insertion order and edge order is append order, so two folds of the same
 * log produce structurally identical values and `JSON.stringify` of the projection is
 * byte-identical. That is the §8 determinism check, and it is a property of these two
 * container choices rather than of a sort applied afterwards.
 */

import type { MutationRecord, ParsedNodeSpec } from "./schema.ts";
import type { EdgeCondition, NodeType, Status, Verdict } from "./vocab.ts";
import { TERMINAL_SUCCESS_STATUS, isTerminal } from "./vocab.ts";

export interface EffectRecord {
  effect_key: string;
  payload_hash: string;
  attempted_at: string;
  completed_at: string | null;
  message_id: string | null;
}

export interface NodeCondition {
  type: string;
  status: string;
  reason: string;
  at: string;
}

/** The AUTHORED half. Changed only by a mutation op (§6.2). */
export type NodeSpec = ParsedNodeSpec;

/**
 * The OBSERVED half. §6.2 keeps three fields answering three different questions;
 * conflating any two is how the worst probe bugs happened.
 */
export interface NodeStatus {
  /** WHERE we are. Written by `set_status`. */
  state: Status;
  /** WHAT was decided. Written by `record_outcome`. */
  outcome: { verdict: Verdict; evidence_ref: string; attrs?: Record<string, unknown> } | null;
  /** WHAT was produced. Written by `record_output`, keyed by declared output name. */
  output: Record<string, unknown> | null;
  conditions: NodeCondition[];
  effect_log: EffectRecord[];
  observed_at_version: number;
}

export interface Provenance {
  created_by_version: number;
  group?: string;
  supersedes: string | null;
  superseded_by: string | null;
}

export interface Node {
  id: string;
  type: NodeType;
  label: string;
  spec: NodeSpec;
  status: NodeStatus;
  provenance: Provenance;
}

/** §6.2 — one edge kind, no identity. `{from: A, to: B}` means **B requires A**. */
export interface Edge {
  from: string;
  to: string;
  condition?: { on: EdgeCondition };
}

export interface Graph {
  schema_version: number;
  /** Head version: the `v` of the last record folded. */
  version: number;
  nodes: Map<string, Node>;
  edges: Edge[];
}

export function emptyGraph(schemaVersion: number): Graph {
  return { schema_version: schemaVersion, version: 0, nodes: new Map(), edges: [] };
}

export function nodeIds(graph: Graph): Set<string> {
  return new Set(graph.nodes.keys());
}

/** In-edges of `to`. With one edge kind every in-edge is a blocking edge (§6.2). */
export function inEdges(graph: Graph, to: string): Edge[] {
  return graph.edges.filter((e) => e.to === to);
}

export function outEdges(graph: Graph, from: string): Edge[] {
  return graph.edges.filter((e) => e.from === from);
}

export function isNodeTerminal(node: Node): boolean {
  return isTerminal(node.status.state);
}

/**
 * §6.4 — "A dropped source never satisfies readiness." Only a terminal *success*
 * satisfies a blocking edge; `failed` and `dropped` do not.
 */
export function satisfiesBlockingEdge(node: Node): boolean {
  return node.status.state === TERMINAL_SUCCESS_STATUS;
}

/**
 * The `--json` read contract (§6.8). Ordered and plain, so that folding twice and
 * stringifying twice yields identical bytes.
 */
export interface GraphProjection {
  schema_version: number;
  version: number;
  nodes: Node[];
  edges: Edge[];
}

export function projectGraph(graph: Graph): GraphProjection {
  return {
    schema_version: graph.schema_version,
    version: graph.version,
    nodes: [...graph.nodes.values()],
    edges: graph.edges,
  };
}

/** Convenience for callers that hold records rather than a folded graph. */
export function headVersion(records: readonly MutationRecord[]): number {
  return records[records.length - 1]?.v ?? 0;
}
