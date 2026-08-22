/**
 * The view model: everything the canvas and the panels render, derived from a folded log and
 * nothing else.
 *
 * It exists so that the React tree holds no judgment. Every question that has a right answer
 * — is this ready, has this deadline blown, how many confirmations does the predicate have —
 * is answered here, in a pure function, against `@kona/core`'s own semantics, and unit-tested
 * off `fixtures/thursday.*`. A component that computed one of these itself would be a second
 * opinion, and the store's is the only one that counts.
 */

import type { EdgeCondition, Graph, MutationRecord, Node, OpKind } from "@kona/core";

/** Milliseconds since the epoch. Passed in, never read from the clock inside a pure module. */
export type Instant = number;

// ---------------------------------------------------------------------------
// Waits (§6.10 rules 4 and 8)
// ---------------------------------------------------------------------------

/**
 * Rule 8's three colours, plus the three states a wait can be in that are not about waiting.
 *
 * `unarmed` is the honest answer for a wait whose deadline is anchored to a node that has not
 * finished: there is no countdown to show yet, and showing `awaiting` would imply a clock is
 * running.
 *
 * `resolved` and `failed` are split because rule 8's first colour is *fulfilled*, and only a
 * `done` wait is that. A wait that is terminal without succeeding — `failed`, or `done` with
 * no resolving outcome — satisfies no downstream edge (`satisfiesBlockingEdge`), so painting
 * it the success green would contradict the blocked reason rendered on the very next card.
 */
export type WaitPhase =
  | "unarmed"
  | "awaiting"
  | "blown"
  | "resolved"
  | "failed"
  | "dropped";

export interface WaitState {
  phase: WaitPhase;
  /** Absolute deadline once it can be computed. Null while `unarmed`, or on an `expr` we
   *  cannot evaluate — in which case `backstop` carries the one date we can trust. */
  deadlineAt: Instant | null;
  /** `deadlineAt - now`, negative once blown. Null when there is nothing to count down to. */
  remainingMs: number | null;
  /** Rendered form of the deadline spec, e.g. `48h after ask-dana-to-play-in-goal`. */
  deadlineLabel: string;
  /** Why the deadline is not computable, when it is not. Shown as text, never swallowed. */
  unresolvedReason: string | null;
  /** Which of the three match kinds, and a one-line rendering of what it is waiting for. */
  matchKind: "event" | "human" | "predicate" | null;
  matchLabel: string;
  /** Non-null only for `match.kind === "predicate"`. */
  predicate: PredicateCount | null;
  /** Where a blown deadline routes. Rendered so a reader can see the escape hatch exists. */
  onTimeout: string | null;
}

/** §6.2's `{count:{verdict,attrs},op,n}` — the quorum counter, evaluated against the graph. */
export interface PredicateCount {
  /** How many contributing sources already carry a matching outcome. */
  have: number;
  /** The threshold. */
  need: number;
  op: string;
  /** How many sources could still contribute — everything not yet terminal-or-dropped. */
  live: number;
  /** `have op need` is already true. */
  met: boolean;
  /** `confirmed`, plus any `attrs` filter, rendered for a chip: `confirmed · role=goalie`. */
  label: string;
  /** Ids of the sources that contributed, so the inspector can name them. */
  contributors: string[];
}

// ---------------------------------------------------------------------------
// Blocked reason (§6.10 rule 4 — "for a blocked node the reason as text")
// ---------------------------------------------------------------------------

export type Readiness = "ready" | "blocked" | "running" | "settled" | "superseded";

export interface BlockedReason {
  /** One line, the thing a reader needs: "waiting on Wait for Pat". */
  summary: string;
  /** One entry per unsatisfied in-edge, in edge order. */
  causes: BlockedCause[];
  /**
   * True when no unsatisfied in-edge can ever be satisfied — every blocker is terminal and
   * none of them succeeded. This is the state that silently hangs a pursuit, so it is named.
   */
  unreachable: boolean;
}

export interface BlockedCause {
  from: string;
  fromLabel: string;
  /** Present when the edge is conditional. */
  wants: EdgeCondition | null;
  /** What the source actually fired, when it has resolved. */
  fired: EdgeCondition | null;
  /** Machine-readable shape of the problem, so the text has one place to live. */
  kind:
    | "not-finished" // source is still active or sending
    | "wrong-resolution" // source resolved, but fired a different condition
    | "failed" // source is `failed`
    | "dropped" // source is `dropped` — never satisfies readiness (§6.4)
    | "missing"; // edge points at a node that is not in the graph
  text: string;
}

// ---------------------------------------------------------------------------
// The per-node view
// ---------------------------------------------------------------------------

export interface NodeView {
  node: Node;
  readiness: Readiness;
  /** Null unless `readiness === "blocked"`. */
  blocked: BlockedReason | null;
  /** Null for a task. */
  wait: WaitState | null;
  /** `provenance.group`, defaulted so grouping never has to handle undefined. */
  group: string;
  /** The version that created it, and the version that last observed it. */
  createdAtVersion: number;
  observedAtVersion: number;
  /** Set on a node whose effect moves bytes we cannot take back (§6.6). */
  irreversible: boolean;
}

export interface GraphView {
  version: number;
  nodes: NodeView[];
  byId: Map<string, NodeView>;
  /** Ids on the ready frontier, insertion order — straight from `readyFrontier`. */
  frontier: string[];
  /** Insertion-order index, so visual order can be pinned by it (rule 7). */
  order: Map<string, number>;
}

// ---------------------------------------------------------------------------
// Diff (§6.10 rule 1)
// ---------------------------------------------------------------------------

export interface EdgeKey {
  from: string;
  to: string;
  on: EdgeCondition | null;
}

export interface GraphDiff {
  fromVersion: number;
  toVersion: number;
  addedNodes: string[];
  addedEdges: EdgeKey[];
  /** Nodes whose `status.state` changed. */
  statusChanged: { id: string; from: string; to: string }[];
  /** Nodes that gained an outcome. */
  outcomeAdded: string[];
  /** Nodes that became superseded, and by what. */
  superseded: { id: string; by: string | null }[];
  /** True when nothing about the shape of the graph changed — rule 2's "status tick". */
  topologyStable: boolean;
}

// ---------------------------------------------------------------------------
// Timeline (§6.10 rule 5 — the differentiator)
// ---------------------------------------------------------------------------

export interface TimelineOp {
  kind: OpKind;
  /** The node the op is about; for `add_edge`, `to`. */
  node: string;
  /** Human phrasing: "added", "→ done", "declined", "superseded by …". */
  detail: string;
}

export interface TimelineEntry {
  version: number;
  observedAt: string;
  occurredAt: string;
  actor: string;
  why: string;
  reasonCode: string;
  expectedEffect: string | null;
  alternativesRejected: string[];
  trigger: string | null;
  ops: TimelineOp[];
  /** What this version did to the shape of the graph. Null for v0. */
  diff: GraphDiff | null;
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

/**
 * Everything derived from the log that does NOT depend on the wall clock.
 *
 * The split is deliberate and is the reason `GraphView` is not a member. Structure changes
 * only when the file does; a countdown ticks every second. Folding a whole log once a second
 * to move a countdown would be this viewer's own version of Burr #834 — the right answer at
 * the wrong cost — so the caller memoizes this on the log text and rebuilds only the view on
 * the clock.
 */
export interface PursuitView {
  graph: Graph;
  records: readonly MutationRecord[];
  timeline: TimelineEntry[];
  /** Version → the moment the store observed it. */
  versionTime: Map<number, Instant>;
  /**
   * Node id → the moment it *succeeded*, for the nodes that have.
   *
   * This is what a `{after: node, duration}` deadline is anchored to, and it is emphatically
   * not `versionTime.get(node.status.observed_at_version)`: `observed_at_version` is the LAST
   * version to touch the node, and §6.4 makes `record_outcome` and `record_output` legal
   * against a terminal node. A delivery receipt or a §6.5 `late` reply landing afterwards
   * would slide the deadline forward and turn a blown wait back into a running one.
   *
   * Only a terminal *success* counts, for the same reason `satisfiesBlockingEdge` does: a send
   * that bounced never started anybody's clock.
   */
  completionTime: Map<string, Instant>;
  /** A truncated final line is the expected shape of a crash, not damage. Surfaced, not fatal. */
  tornTail: boolean;
  damaged: { line: number; reason: string; detail: string }[];
}
