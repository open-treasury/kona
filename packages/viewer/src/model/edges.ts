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

function timeoutTargetOf(node: Node): string | null {
  if (node.type !== "wait") return null;
  return node.spec.on_timeout ?? null;
}

export function viewEdges(graph: Graph): ViewEdge[] {
  const out: ViewEdge[] = [];

  // Dependencies first, in append order — §6.1 makes that the one stable order in the system.
  for (const edge of graph.edges) {
    const on = edge.condition?.on ?? null;
    out.push({
      id: edgeId("requires", edge.from, edge.to, on),
      from: edge.from,
      to: edge.to,
      kind: "requires",
      condition: on,
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
        satisfied: false,
        dead: false,
      });
    }
  }

  return out;
}
