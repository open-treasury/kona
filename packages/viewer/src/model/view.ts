/**
 * The whole graph, node by node, answered once.
 *
 * `waitState`, `blocked` and `predicate` each answer one question about one node. This module
 * is where those answers are assembled into the value the canvas actually renders, and its
 * reason for existing is that the assembly has to happen in exactly one place. A component
 * that called `readinessOf` for its border colour and `blockedReason` for its tooltip would be
 * asking the same question twice per frame and — worse — could be handed two graphs a render
 * apart and paint a node whose ring and whose text disagreed.
 *
 * Everything here is insertion order, and that is load-bearing rather than incidental. §6.1
 * makes node order the fold's append order, rule 7 pins visual order to it, and `order` hands
 * that index to anything that needs to break a tie deterministically. A sort — by group, by
 * status, by readiness — would reshuffle the canvas every time a reply landed, which is the
 * animation rule 1 wants spent on topology and nothing else.
 *
 * `now` is a parameter for the same reason it is one everywhere else in `model/`: a view built
 * from the clock is a view no test can pin, and the blown-deadline colour is precisely what
 * has to be pinned. It is also why this is the half of the model that gets rebuilt on a tick
 * while `buildPursuit` is memoized on the log text — the countdown moves every second, the
 * shape of the graph does not.
 */

import type { Graph } from "@kona/core";
import { isIrreversible, readyFrontier } from "@kona/core";
import { blockedReason, readinessOf } from "./blocked.ts";
import { flowTerminals } from "./edges.ts";
import { waitStateOf } from "./waitState.ts";
import type { GraphView, Instant, NodeView } from "./types.ts";

/**
 * `provenance.group` comes from `add_node`'s optional `scope`, so a node authored without one
 * has no group at all. Defaulting here rather than at each call site means grouping code never
 * has to decide what `undefined` renders as, and every node lands in exactly one bucket —
 * including the nodes nobody scoped, which are the ones most likely to be overlooked.
 */
const UNGROUPED = "ungrouped";

/**
 * `completionTime` is `PursuitView.completionTime` — node id → the moment it first went
 * `done` — and it is passed straight through to `waitStateOf`, which is the only thing in the
 * view that needs the log at all. Handing the whole version→time map down instead would give
 * the wait layer the freedom to anchor a `{after, duration}` deadline to any version that
 * happened to touch the node, which is the mistake the map exists to make impossible.
 */
export function buildGraphView(
  graph: Graph,
  completionTime: ReadonlyMap<string, Instant>,
  now: Instant,
): GraphView {
  const nodes: NodeView[] = [];
  const byId = new Map<string, NodeView>();
  const order = new Map<string, number>();
  // Once for the whole graph rather than per node: the answer for one card depends on every
  // edge in the pursuit, so asking it thirty-one times would be thirty-one full sweeps.
  const terminals = flowTerminals(graph);

  for (const node of graph.nodes.values()) {
    const view: NodeView = {
      node,
      readiness: readinessOf(graph, node),
      // Already null unless the node is blocked — `blockedReason` owns that test, so asking
      // `readinessOf` a second time here would be the duplicated judgment this module exists
      // to prevent.
      blocked: blockedReason(graph, node),
      wait: waitStateOf(graph, node, completionTime, now),
      group: node.provenance.group ?? UNGROUPED,
      // The two versions answer different questions — when this step was decided on, and when
      // the store last learned something about it — and §6.2 keeps them apart for that reason.
      createdAtVersion: node.provenance.created_by_version,
      observedAtVersion: node.status.observed_at_version,
      irreversible: isIrreversible(node.spec.effect_class),
      isStart: terminals.starts.has(node.id),
      isEnd: terminals.ends.has(node.id),
    };

    order.set(node.id, nodes.length);
    nodes.push(view);
    byId.set(node.id, view);
  }

  return {
    version: graph.version,
    nodes,
    byId,
    // Core's frontier, not a filter over `readiness === "ready"`. The two agree because
    // `readinessOf` delegates to `isReady`, and taking this list from the store's own function
    // is what keeps them agreeing when readiness grows a case.
    frontier: readyFrontier(graph).map((node) => node.id),
    order,
  };
}
