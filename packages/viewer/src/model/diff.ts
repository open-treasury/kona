/**
 * What one version did to the shape of the graph (§6.10 rule 1).
 *
 * The viewer's whole claim is that the topology changes mid-run. A canvas that only ever
 * paints the current head proves nothing: the reader sees a diagram and has to take it on
 * faith that it was ever different. This module turns two folded graphs into the handful of
 * ids the canvas can tween and flash, so the change is something you watch happen rather than
 * something you are told about.
 *
 * It also draws rule 2's line. `graph_version` bumps on a status tick as readily as on a
 * fan-out — fixture v3 and v4 move statuses and outcomes only — so `topologyStable` is the
 * signal the layout memo keys off. Without it dagre re-runs every time an email is answered,
 * every activity jumps, and the one moment worth animating is lost among the ones that are not
 * (burr #834).
 *
 * **There are no removals, and there is no code here for them.** The ops vocabulary has six
 * verbs, and `delete_node` and `rollback` are named among the forbidden ones; nothing is ever
 * taken out of a Kona graph. An activity leaves play by becoming `dropped` or by being superseded,
 * and both are facts about its status and its provenance, not about the graph's shape. A
 * `removedNodes` field would be a field that is always empty and a branch that is never
 * taken — dead code standing in for a case the store forbids.
 */

import type { Edge, Graph } from "@kona/core";
import type { EdgeKey, GraphDiff } from "./types.ts";

/**
 * An edge has no identity of its own (§6.2) — `{from, to, condition}` is all there is, and
 * `add_edge` refuses a duplicate of that triple — so the triple *is* the identity. React and
 * the tween both need a stable key, and this is the only honest one.
 */
export function edgeKey(edge: Edge): EdgeKey {
  return { from: edge.from, to: edge.to, on: edge.condition?.on ?? null };
}

/**
 * The key as one string, for a `Set` or a React `key`.
 *
 * `>` and `#` are safe separators because neither can occur in either half: activity ids are
 * `[a-z0-9][a-z0-9-]*` and the seven edge conditions are lowercase words. The encoding is
 * therefore injective, which is what a key has to be — two different edges that stringified
 * alike would make one of them invisible to the diff.
 */
export function edgeKeyString(key: EdgeKey): string {
  return key.on === null ? `${key.from}>${key.to}` : `${key.from}>${key.to}#${key.on}`;
}

/**
 * Diff two folded graphs. `before` is null on the first paint, where every activity and edge is
 * an addition — the same answer as diffing against the empty graph, which is what version 0
 * is, so `fromVersion` is 0 rather than some sentinel.
 *
 * `after` need not be `before`'s immediate successor: folding is cheap and the caller may
 * hand over any two versions.
 */
export function diffGraphs(before: Graph | null, after: Graph): GraphDiff {
  const addedNodes: string[] = [];
  const statusChanged: GraphDiff["statusChanged"] = [];
  const outcomeAdded: string[] = [];
  const superseded: GraphDiff["superseded"] = [];

  // Iterating `after` in map order means every list below comes out in insertion order,
  // which is the order rule 7 pins visual order to. Sorting would unpin it.
  for (const [id, activity] of after.activities) {
    const was = before?.activities.get(id);
    if (was === undefined) {
      addedNodes.push(id);
      continue;
    }
    if (was.status.state !== activity.status.state) {
      statusChanged.push({ id, from: was.status.state, to: activity.status.state });
    }
    // `outcomes` and not `outcome`: the array is append-only (§6.7) and a `tentative` or
    // `late` record lands in it without ever becoming the resolving one. Both are things
    // that happened, and the inspector has to be told so it can show them.
    if (activity.status.outcomes.length > was.status.outcomes.length) {
      outcomeAdded.push(id);
    }
    if (was.provenance.superseded_by !== activity.provenance.superseded_by) {
      superseded.push({ id, by: activity.provenance.superseded_by });
    }
  }

  const seen = new Set((before?.edges ?? []).map((edge) => edgeKeyString(edgeKey(edge))));
  const addedEdges = after.edges
    .filter((edge) => !seen.has(edgeKeyString(edgeKey(edge))))
    .map(edgeKey);

  return {
    fromVersion: before?.version ?? 0,
    toVersion: after.version,
    addedNodes,
    addedEdges,
    statusChanged,
    outcomeAdded,
    superseded,
    // A supersede counts as topology even though it adds nothing. The replacement has to be
    // drawn beside the activity it replaces, with the chain between them, and the superseded activity
    // stops being work — the picture changes, so the layout has to be recomputed. This is the
    // one case where "nothing was added" and "nothing moved" come apart, and filing a
    // supersede under status ticks would leave the replacement laid out on top of the activity it
    // replaced.
    topologyStable:
      addedNodes.length === 0 && addedEdges.length === 0 && superseded.length === 0,
  };
}
