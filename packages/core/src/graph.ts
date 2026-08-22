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
import { TERMINAL_SUCCESS_STATUS, isResolvingVerdict, isTerminal } from "./vocab.ts";

export interface EffectRecord {
  effect_key: string;
  payload_hash: string;
  /** When the intent was durably appended. Always set. */
  attempted_at: string;
  /**
   * When the world's answer came back. `null` means the answer is UNKNOWN, not that
   * nothing happened — §6.6 keeps these two fields distinct so that state is nameable.
   */
  completed_at: string | null;
  outcome: "sent" | "failed" | null;
  message_id: string | null;
}

/** One recorded decision. §6.7: judgment-bearing fields are append-only. */
export interface OutcomeRecord {
  verdict: Verdict;
  evidence_ref: string;
  attrs?: Record<string, unknown>;
  /** The version that recorded it, so the history is orderable without a timestamp. */
  at_version: number;
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
  /**
   * WHAT was decided, in full. Append-only (§6.7): `record_outcome` never overwrites.
   *
   * The alternative loses data outright. §6.5 requires that a reply arriving after its
   * wait resolved be recorded as `verdict:"late"` and **never reopen** it — under
   * overwrite semantics that late reply silently replaces the verdict the graph actually
   * acted on, and the evidence for a sent email disappears behind a straggler.
   */
  outcomes: OutcomeRecord[];
  /**
   * The one that CLOSED it — a projection of `outcomes`, materialised so consumers do not
   * each re-derive it. The first entry with a resolving verdict wins: `tentative` records
   * without resolving and `late` is after the fact, so neither can become this.
   */
  outcome: OutcomeRecord | null;
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

/** §6.5 — the first resolving outcome, or null while the node is still open. */
export function resolvingOutcome(outcomes: readonly OutcomeRecord[]): OutcomeRecord | null {
  return outcomes.find((entry) => isResolvingVerdict(entry.verdict)) ?? null;
}

/**
 * §6.2 — "the store fires the out-edge whose condition matches the resolution".
 *
 * The resolution is DERIVED, never stored, which is what keeps readiness computed rather
 * than materialised (§6.8). The seven edge conditions are exactly two families: the four
 * decisions a human wait returns, which are verdicts already, and the three ways any wait
 * can close.
 *
 * `declined` maps to `satisfied` on purpose: the wait *was* satisfied — somebody answered.
 * What they said is the verdict, and that is what a predicate counts. Conflating the two
 * would make a refusal indistinguishable from silence.
 */
export function resolutionOf(node: Node): EdgeCondition | null {
  const outcome = node.status.outcome;
  if (outcome === null) return null;
  switch (outcome.verdict) {
    case "accept":
    case "edit":
    case "respond":
    case "ignore":
      return outcome.verdict;
    case "timed_out":
      return "timeout";
    case "bounced":
      return "bounced";
    case "confirmed":
    case "declined":
      return "satisfied";
    default:
      return null;
  }
}

/**
 * §6.4 — "Readiness fails safe." A node is ready iff it is not dropped and every blocking
 * in-edge has a terminal-SUCCESS source whose condition is true.
 *
 * It deliberately does NOT inherit the merge exclusion that drops give: a dropped source
 * never satisfies readiness. Otherwise the second node on an untaken branch has no
 * blocker, lands on the frontier, and gets dispatched — pivot send included.
 */
export function isEdgeSatisfied(graph: Graph, edge: Edge): boolean {
  const source = graph.nodes.get(edge.from);
  if (source === undefined) return false;
  if (!satisfiesBlockingEdge(source)) return false;
  if (edge.condition === undefined) return true;
  return resolutionOf(source) === edge.condition.on;
}

export function isReady(graph: Graph, node: Node): boolean {
  if (node.status.state !== "active") return false;
  if (node.provenance.superseded_by !== null) return false;
  return inEdges(graph, node.id).every((edge) => isEdgeSatisfied(graph, edge));
}

/** §6.8 — the ready frontier. Computed, never stored. */
export function readyFrontier(graph: Graph): Node[] {
  return [...graph.nodes.values()].filter((node) => isReady(graph, node));
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
