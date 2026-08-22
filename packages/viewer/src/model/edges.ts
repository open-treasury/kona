/**
 * Everything the canvas draws a line for — which is more than `graph.edges` holds.
 *
 * §6.2 gives an edge one kind and no identity: `{from, to, condition?}`, meaning "to requires
 * from". That is the *dependency* graph, and it is what `isReady` walks. But it is not the
 * whole state machine, and a viewer that draws only those leaves nodes looking stranded when
 * they are nothing of the sort. Two more relations are structural, live in the node rather
 * than in the edge list, and were invisible:
 *
 *   **`spec.on_timeout`** — where a blown deadline routes. §6.4 requires one on every wait
 *   precisely so a pursuit can never hang silently, which makes it the most load-bearing arc
 *   in the graph and the one a reader most needs to see. In the poker pursuit eleven waits all
 *   route to one escalation, and that node was drawn floating on its own.
 *
 *   **`provenance.superseded_by`** — the replacement chain. Nothing is ever deleted (§6.3), so
 *   a retired node keeps its place on the canvas; without the link it reads as an orphan
 *   instead of as the first half of "this was replaced by that".
 *
 * **They are drawn, and they are NOT dependencies.** Nothing here touches `Graph`, so readiness
 * is untouched: `isReady` still walks `graph.edges` alone, and a timeout arc has never made a
 * node ready or blocked. The distinction is carried in `kind` and paid off in how each one is
 * painted — a dependency is a solid line, an escape hatch is dashed, a supersede is a dotted
 * aside.
 *
 * One function so that dagre and React Flow cannot disagree about what the picture contains:
 * ranking a set of edges and then drawing a different set is how an edge ends up crossing the
 * whole canvas to reach a node the layout never knew it was attached to.
 */

import type { Edge, EdgeCondition, Graph, Node } from "@kona/core";
import { isEdgeSatisfied, isTerminal } from "@kona/core";

export type EdgeKind = "requires" | "timeout" | "supersedes";

export interface ViewEdge {
  /** Unique across all three kinds — the kind is part of it, because the same pair can be
   *  joined twice (a wait can depend on the node it also escapes to). */
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  /** Only a `requires` edge carries one. */
  condition: EdgeCondition | null;
  /**
   * What to print on the line, or null to print nothing. See `labelOf`: a condition earns a
   * label only when the source can fire something else.
   */
  label: string | null;
  /** This dependency is met. Meaningless for the other two kinds, which never gate anything. */
  satisfied: boolean;
  /** This dependency can never be met: the source is terminal without having succeeded. */
  dead: boolean;
}

function edgeId(kind: EdgeKind, from: string, to: string, on: EdgeCondition | null): string {
  // Node ids are `[a-z0-9][a-z0-9-]*` (§6.2) and the kinds and conditions are lowercase words,
  // so `>` and `#` cannot occur inside any part and the encoding stays injective.
  return on === null ? `${kind}:${from}>${to}` : `${kind}:${from}>${to}#${on}`;
}

/**
 * An edge is dead when its source can never satisfy it: terminal without succeeding, or gone.
 * Drawing that the same as a live dependency is how a reader believes a fan-out still has four
 * arms when two of them are already closed.
 */
function isDead(graph: Graph, edge: Edge): boolean {
  const source = graph.nodes.get(edge.from);
  if (source === undefined) return true;
  return isTerminal(source.status.state) && !isEdgeSatisfied(graph, edge);
}

/**
 * `satisfied` is the DEFAULT outcome — "the source succeeded" — and it is what an
 * unconditional edge already means. Every other condition names one outcome out of several.
 *
 * Naming exactly one value is a switch on an enum §6.2 lets grow, so the fallback is the safe
 * direction: a condition this build has never seen gets labelled. Showing a word we do not
 * recognise is recoverable; hiding a fork is not.
 */
const DEFAULT_CONDITION = "satisfied";

/**
 * The sources that fire more than one thing — where the contrast itself is the information.
 *
 * `null` counts as a value: a source with one `accept` edge and one unconditional edge is
 * forking, because "always" and "only on accept" are different promises. On such a source even
 * `satisfied` is worth printing, because it is being contrasted with something.
 */
function forkingSources(graph: Graph): ReadonlySet<string> {
  const seen = new Map<string, Set<EdgeCondition | null>>();
  for (const edge of graph.edges) {
    const conditions = seen.get(edge.from) ?? new Set<EdgeCondition | null>();
    conditions.add(edge.condition?.on ?? null);
    seen.set(edge.from, conditions);
  }

  const out = new Set<string>();
  for (const [from, conditions] of seen) if (conditions.size >= 2) out.add(from);
  return out;
}

/**
 * Whether the condition tells a reader anything the line's existence does not.
 *
 * Measured on the 31-arm poker pursuit before this: 17 labels drawn and **16 of them said
 * `satisfied`**, which is the default outcome and therefore no news. Five of those sixteen sat
 * on GREY lines, which made them worse than noise — `satisfied` is a condition ("taken when
 * the source fires satisfied") and green is a state ("this dependency is met"), so a grey line
 * reading `satisfied` contradicted itself in one word. Meanwhile the single label that carried
 * real information, `on accept` where a human ruling gates everything downstream, was lost in
 * the crowd.
 *
 * An earlier version of this rule keyed on the sibling count alone and dropped that one too:
 * `ruling-on-inviting-a-stranger` has exactly ONE outgoing edge, conditioned `accept`, because
 * the `ignore` branch is simply not wired. One out-edge, and the condition is the whole point —
 * everything after it happens only if a person says yes.
 *
 * `on accept` rather than `accept`, so the word reads as a condition rather than as a state the
 * edge is in — and so a `timeout` CONDITION on a solid dependency stays distinguishable from
 * the dashed `timeout` ARC, a different relation wearing the same word.
 */
function labelOf(on: EdgeCondition | null, forks: boolean): string | null {
  if (on === null) return null;
  if (on === DEFAULT_CONDITION && !forks) return null;
  return `on ${on}`;
}

function timeoutTargetOf(node: Node): string | null {
  if (node.type !== "wait") return null;
  return node.spec.on_timeout ?? null;
}

export function viewEdges(graph: Graph): ViewEdge[] {
  const out: ViewEdge[] = [];
  const forking = forkingSources(graph);

  // Dependencies first, in append order — §6.1 makes that the one stable order in the system.
  for (const edge of graph.edges) {
    const on = edge.condition?.on ?? null;
    out.push({
      id: edgeId("requires", edge.from, edge.to, on),
      from: edge.from,
      to: edge.to,
      kind: "requires",
      condition: on,
      label: labelOf(on, forking.has(edge.from)),
      satisfied: isEdgeSatisfied(graph, edge),
      dead: isDead(graph, edge),
    });
  }

  for (const node of graph.nodes.values()) {
    const target = timeoutTargetOf(node);
    // A target that is not in the graph is not a broken pursuit: `add_node` permits a forward
    // reference, and read-only time travel to a version before the escalation was created
    // produces exactly this. Skip it rather than mint a phantom.
    if (target !== null && target !== node.id && graph.nodes.has(target)) {
      out.push({
        id: edgeId("timeout", node.id, target, null),
        from: node.id,
        to: target,
        kind: "timeout",
        condition: null,
        label: null,
        satisfied: false,
        dead: false,
      });
    }

    const replacement = node.provenance.superseded_by;
    if (replacement !== null && graph.nodes.has(replacement)) {
      out.push({
        id: edgeId("supersedes", node.id, replacement, null),
        from: node.id,
        to: replacement,
        kind: "supersedes",
        condition: null,
        label: null,
        satisfied: false,
        dead: false,
      });
    }
  }

  return out;
}

/**
 * The activity diagram's initial and final nodes, as ids.
 *
 * They are NOTATION, not pursuit nodes: nothing in the log corresponds to them, they carry no
 * status, they cannot be selected, and they are kept out of `Layout.boxes` so that no count of
 * "how many nodes does this pursuit have" can accidentally include them. A real id must match
 * `[a-z0-9][a-z0-9-]*` (§6.2), so a leading underscore cannot collide with one.
 */
export const START_MARKER_ID = "__start";
export const END_MARKER_ID = "__end";

/**
 * Where the pursuit starts, and where it currently stops.
 *
 * The activity-diagram vocabulary — a filled dot for the initial node, a ringed dot for the
 * final one — maps onto Kona with **one honest exception, and it is the interesting one.**
 * There is no final state. §6.1 makes the graph a fold over an append-only log whose topology
 * changes mid-run, so a node with nothing depending on it today grows children tomorrow; that
 * is the entire claim, not an edge case. `end` therefore means "nothing depends on this **at
 * this version**", and the marker says exactly that rather than "finished".
 *
 * Computed over FLOW, which is dependencies plus timeout routes and NOT the supersede chain:
 *
 *   - a timeout arc is flow. Without it the escalation — the target of every wait in the
 *     pursuit — reads as a *start*, because nothing depends on it, which is the opposite of
 *     what it is.
 *   - a supersede link is lineage, not flow. Counting it would make a retired node look like a
 *     step on the way somewhere.
 *
 * A superseded node is neither. It has been replaced, and calling the thing you stopped doing
 * a "start" is worse than saying nothing about it.
 */
export interface Terminals {
  starts: ReadonlySet<string>;
  ends: ReadonlySet<string>;
}

export function flowTerminals(graph: Graph): Terminals {
  const hasIn = new Set<string>();
  const hasOut = new Set<string>();

  for (const edge of viewEdges(graph)) {
    if (edge.kind === "supersedes") continue;
    hasOut.add(edge.from);
    hasIn.add(edge.to);
  }

  const starts = new Set<string>();
  const ends = new Set<string>();
  for (const node of graph.nodes.values()) {
    if (node.provenance.superseded_by !== null) continue;
    if (!hasIn.has(node.id)) starts.add(node.id);
    if (!hasOut.has(node.id)) ends.add(node.id);
  }
  return { starts, ends };
}
