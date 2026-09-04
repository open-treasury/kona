import type { Edge, Graph, Status } from "@kona/core";
import { isEdgeDead, isEdgeSatisfied } from "@kona/core";
import { guardKey } from "./guard.ts";

export interface CollapsedEdgeState {
  satisfied: boolean;
  dead: boolean;
}

export interface CollapsedRegion {
  forkId: string;
  members: ReadonlySet<string>;
  counts: ReadonlyMap<Status, number>;
}

export interface CollapsedGraph {
  graph: Graph;
  regions: ReadonlyMap<string, CollapsedRegion>;
  ownerByNode: ReadonlyMap<string, string>;
  edgeStates: ReadonlyMap<string, CollapsedEdgeState>;
}

function intersect(sets: readonly ReadonlySet<string>[]): Set<string> {
  const [first, ...rest] = sets;
  if (first === undefined) return new Set();
  return new Set([...first].filter((value) => rest.every((set) => set.has(value))));
}

function adjacency(graph: Graph): {
  incoming: Map<string, string[]>;
  outgoing: Map<string, string[]>;
} {
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const id of graph.nodes.keys()) {
    incoming.set(id, []);
    outgoing.set(id, []);
  }
  for (const edge of graph.edges) {
    if (!graph.nodes.has(edge.from) || !graph.nodes.has(edge.to)) continue;
    incoming.get(edge.to)?.push(edge.from);
    outgoing.get(edge.from)?.push(edge.to);
  }
  return { incoming, outgoing };
}

/** Nodes dominated by a fork, ending at its nearest common post-dominator when one exists. */
export function forkRegion(graph: Graph, forkId: string): Set<string> {
  if (graph.nodes.get(forkId)?.type !== "fork") return new Set();
  const ids = [...graph.nodes.keys()];
  const all = new Set(ids);
  const { incoming, outgoing } = adjacency(graph);
  const starts = new Set(ids.filter((id) => (incoming.get(id)?.length ?? 0) === 0));
  const ends = new Set(ids.filter((id) => (outgoing.get(id)?.length ?? 0) === 0));

  const dominators = new Map<string, Set<string>>(
    ids.map((id) => [id, starts.has(id) ? new Set([id]) : new Set(all)]),
  );
  const postDominators = new Map<string, Set<string>>(
    ids.map((id) => [id, ends.has(id) ? new Set([id]) : new Set(all)]),
  );

  let changed = true;
  while (changed) {
    changed = false;
    for (const id of ids) {
      if (!starts.has(id)) {
        const next = intersect(
          (incoming.get(id) ?? []).map((parent) => dominators.get(parent) ?? all),
        );
        next.add(id);
        if (!same(next, dominators.get(id))) {
          dominators.set(id, next);
          changed = true;
        }
      }
      if (!ends.has(id)) {
        const next = intersect(
          (outgoing.get(id) ?? []).map((child) => postDominators.get(child) ?? all),
        );
        next.add(id);
        if (!same(next, postDominators.get(id))) {
          postDominators.set(id, next);
          changed = true;
        }
      }
    }
  }

  const reachable = distances(outgoing, forkId);
  const common = [...(postDominators.get(forkId) ?? [])].filter((id) => id !== forkId);
  const boundary = common.toSorted(
    (a, b) => (reachable.get(a) ?? Infinity) - (reachable.get(b) ?? Infinity),
  )[0];
  const region = new Set<string>([forkId]);
  for (const id of reachable.keys()) {
    if (dominators.get(id)?.has(forkId) !== true) continue;
    if (boundary !== undefined && id !== boundary && !canReach(outgoing, id, boundary)) continue;
    region.add(id);
  }
  return region;
}

function distances(
  outgoing: ReadonlyMap<string, readonly string[]>,
  start: string,
): Map<string, number> {
  const result = new Map([[start, 0]]);
  const queue = [start];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    if (id === undefined) continue;
    for (const next of outgoing.get(id) ?? []) {
      if (result.has(next)) continue;
      result.set(next, (result.get(id) ?? 0) + 1);
      queue.push(next);
    }
  }
  return result;
}

function canReach(
  outgoing: ReadonlyMap<string, readonly string[]>,
  from: string,
  to: string,
): boolean {
  return distances(outgoing, from).has(to);
}

function same(left: ReadonlySet<string>, right: ReadonlySet<string> | undefined): boolean {
  return (
    right !== undefined && left.size === right.size && [...left].every((value) => right.has(value))
  );
}

function statusCounts(graph: Graph, members: ReadonlySet<string>): Map<Status, number> {
  const counts = new Map<Status, number>();
  for (const id of members) {
    const node = graph.nodes.get(id);
    if (node?.provenance.superseded_by !== null) continue;
    const status = node.status?.state;
    if (status !== undefined) counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return counts;
}

export function collapsedStatusSummary(region: CollapsedRegion): string {
  const total = [...region.counts.values()].reduce((sum, count) => sum + count, 0);
  const parts = [`${String(total)} ${total === 1 ? "activity" : "activities"}`];
  for (const status of [
    "completed",
    "failed",
    "withdrawn",
    "terminated",
    "ready",
    "active",
    "inactive",
  ] as const) {
    const count = region.counts.get(status) ?? 0;
    if (count > 0) parts.push(`${String(count)} ${status}`);
  }
  return parts.join(" · ");
}

export function reconcileSelection(
  selected: string | null,
  collapsed: CollapsedGraph,
): string | null {
  if (selected === null || collapsed.graph.nodes.has(selected)) return selected;
  return collapsed.ownerByNode.get(selected) ?? null;
}

export function collapsedEdgeKey(edge: Pick<Edge, "from" | "to" | "guard">): string {
  return `${edge.from}>${edge.to}#${guardKey(edge)}`;
}

/** A presentation graph only: the folded graph remains untouched and authoritative. */
export function collapseForks(graph: Graph, expanded: ReadonlySet<string>): CollapsedGraph {
  const owner = new Map<string, string>();
  const regions = new Map<string, CollapsedRegion>();
  for (const node of graph.nodes.values()) {
    if (node.type !== "fork" || expanded.has(node.id) || owner.has(node.id)) continue;
    const members = forkRegion(graph, node.id);
    if (members.size <= 1) continue;
    regions.set(node.id, { forkId: node.id, members, counts: statusCounts(graph, members) });
    for (const id of members) if (id !== node.id) owner.set(id, node.id);
  }

  if (regions.size === 0) return { graph, regions, ownerByNode: owner, edgeStates: new Map() };

  const nodes = new Map([...graph.nodes].filter(([id]) => !owner.has(id)));
  const edges: Edge[] = [];
  const edgeStates = new Map<string, CollapsedEdgeState>();
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    const from = owner.get(edge.from) ?? edge.from;
    const to = owner.get(edge.to) ?? edge.to;
    if (from === to || !nodes.has(from) || !nodes.has(to)) continue;
    const rewritten = { ...edge, from, to };
    const key = collapsedEdgeKey(rewritten);
    const state = { satisfied: isEdgeSatisfied(graph, edge), dead: isEdgeDead(graph, edge) };
    const previous = edgeStates.get(key);
    edgeStates.set(key, {
      satisfied: (previous?.satisfied ?? false) || state.satisfied,
      dead: previous === undefined ? state.dead : previous.dead && state.dead,
    });
    if (!seen.has(key)) {
      seen.add(key);
      edges.push(rewritten);
    }
  }

  return { graph: { ...graph, nodes, edges }, regions, ownerByNode: owner, edgeStates };
}
