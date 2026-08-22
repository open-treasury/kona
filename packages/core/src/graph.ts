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
 * Can this edge NEVER fire? The complement of *pending*, not of `isEdgeSatisfied`: an edge
 * whose source is still open is neither satisfied nor dead, and treating the two as
 * complements is how a live branch gets dropped.
 *
 * Deadness is monotone, which is what makes the op-delta trigger in `resolveBranches` exact.
 * Terminality is permanent (invariant 1 refuses `set_status` on a head-terminal node) and a
 * resolution is frozen once non-null (`status.outcome` is the FIRST resolving entry, so a
 * later reply cannot change it).
 */
export function isEdgeDead(graph: Graph, edge: Edge): boolean {
  const source = graph.nodes.get(edge.from);
  if (source === undefined) return false;
  // Still open: it may yet resolve either way.
  if (!isNodeTerminal(source)) return false;
  // §6.4 — "an in-edge whose SOURCE is dropped". The only status the spec names.
  if (source.status.state === "dropped") return true;
  // §6.2 keeps `failed` distinct from `dropped`: "tried, didn't work" is a human's to look
  // at. It can never satisfy, so the subtree stalls — loudly, under a visibly failed node,
  // which is better than the store silently deleting work someone is about to repair.
  if (source.status.state === "failed") return false;
  // A plain edge is cleared by any `done` source (§6.4 readiness), so it is never dead.
  if (edge.condition === undefined) return false;
  const resolution = resolutionOf(source);
  // `done` with no resolving outcome yet: `set_status` at v10 and `record_outcome` at v11 is
  // a legal two-commit sequence, and the window between them must not kill the branch.
  if (resolution === null) return false;
  return resolution !== edge.condition.on;
}

/**
 * Is this node on an arm that can never fire? Every in-edge dead, or from a node that is
 * itself arm-dead — the same least fixpoint the cascade in `branch.ts` walks.
 *
 * Readiness needs this and dropping cannot supply it. The cascade deliberately does NOT
 * rewrite a node that is already terminal, or one that is `sending`, so those nodes sit on a
 * dead arm wearing a live-looking status forever. Their plain out-edges then read as
 * SATISFIED, and under `merge: "any"` one of them alone is enough to put a shared descendant
 * on the frontier — where §6.8 says appearing "is what gets it dispatched, pivot send
 * included". A `sending` node completing later makes no edge newly dead, so no commit-time
 * derivation could ever catch that case; it has to be answered when readiness is computed.
 *
 * A root is never arm-dead: blocking on nothing is not the same as being cut off.
 */
export function isArmDead(graph: Graph, id: string): boolean {
  return armDead(graph, id, new Set());
}

function armDead(graph: Graph, id: string, seen: Set<string>): boolean {
  // A cycle is mutual dependency, not proof of death. Returning false keeps the predicate
  // conservative and, more importantly, keeps it total: `add_edge` refuses only a self-edge
  // and an exact duplicate, so nothing stops a cycle existing.
  if (seen.has(id)) return false;
  const ins = inEdges(graph, id);
  if (ins.length === 0) return false;
  seen.add(id);
  return ins.every((edge) => isEdgeDead(graph, edge) || armDead(graph, edge.from, seen));
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

/**
 * §6.4 — "An in-edge whose SOURCE is dropped is excluded from merge evaluation: it neither
 * satisfies nor blocks." That exclusion and the "readiness does not inherit it" sentence in
 * the next paragraph cannot both hold literally for a node with more than one in-edge, and
 * the shipped fixture is the proof: at head, `goalie-confirmed` carries a `satisfied`-
 * conditioned in-edge from `wait-for-priya`, which `supersede_node` dropped. Nothing can
 * un-drop a terminal node and no op removes an edge, so under the literal reading that join
 * is unreachable **forever** — silently, since `readyFrontier` just omits it.
 *
 * So the exclusion applies, and the guarantee the second sentence exists for is delivered by
 * the zero-live clause instead: a node whose in-edges are ALL dropped is not ready either.
 * The second node on an untaken branch still never lands on the frontier, which is the
 * failure ("pivot send included") that sentence was written to prevent.
 *
 * The exclusion is `state === "dropped"` and nothing else. `failed` is deliberately not
 * excluded (§6.2: "tried, didn't work" ≠ "we stopped wanting this") — a subtree stuck under
 * a visibly failed node is a human's to look at, not the store's to delete.
 */
export function isReady(graph: Graph, node: Node): boolean {
  if (node.status.state !== "active") return false;
  if (node.provenance.superseded_by !== null) return false;
  const ins = inEdges(graph, node.id);
  // A root blocks on nothing and is ready. Tested before the merge branch, because
  // `some` over an empty array is `false` and would strand every `merge: "any"` root.
  if (ins.length === 0) return true;
  // Dropped, or on an arm that can never fire. The second is not redundant: the cascade
  // leaves a terminal or `sending` node on a dead arm exactly as it found it, so `dropped`
  // alone would let one of those satisfy a `merge: "any"` join on a branch nobody took.
  const live = ins.filter(
    (edge) =>
      graph.nodes.get(edge.from)?.status.state !== "dropped" && !isArmDead(graph, edge.from),
  );
  // §6.4 — "one with ZERO live in-edges routes to `on_timeout` and never hangs." Routing is
  // the wait engine's job (T3.1); what readiness owes is to never call it ready.
  if (live.length === 0) return false;
  return node.spec.merge === "any"
    ? live.some((edge) => isEdgeSatisfied(graph, edge))
    : live.every((edge) => isEdgeSatisfied(graph, edge));
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
