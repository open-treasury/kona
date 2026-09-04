/**
 * `kona next` — the ready frontier (§6.8). **Computed, never stored.**
 *
 * This is the plugin's only source of work, and it is the verb where §6.4's "readiness
 * fails safe" is load-bearing: an activity on an untaken branch must never appear here, because
 * appearing here is what gets it dispatched, pivot send included.
 */

import {
  inEdges,
  isEdgeSatisfied,
  isNodeLive,
  outEdges,
  readyFrontier,
  type ActivityNode,
  type Graph,
} from "@kona/core";
import { EXIT_OK, EXIT_REFUSED } from "../exit.ts";
import { openPursuit, reportDamage } from "../pursuit.ts";
import type { Io } from "../io.ts";

export interface NextOptions {
  json: boolean;
}

export type NextNode = ActivityNode & { fork: string | null };

export interface NextProjection {
  version: number;
  complete: boolean;
  nodes: NextNode[];
}

function reachable(graph: Graph, from: string, to: string, seen = new Set<string>()): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return outEdges(graph, from).some((edge) => reachable(graph, edge.to, to, seen));
}

/** The nearest fork whose arms have not converged again before this node. */
function containingFork(graph: Graph, node: ActivityNode): string | null {
  const forks = [...graph.nodes.values()].filter(
    (candidate) =>
      candidate.type === "fork" && isNodeLive(candidate) && reachable(graph, candidate.id, node.id),
  );

  const containing = forks.filter((fork) => {
    const commonDescendants = [...graph.nodes.values()].filter(
      (candidate) =>
        candidate.id !== fork.id &&
        isNodeLive(candidate) &&
        outEdges(graph, fork.id).every((arm) => reachable(graph, arm.to, candidate.id)),
    );
    const convergence = commonDescendants.find((candidate) =>
      commonDescendants.every(
        (other) => other.id === candidate.id || !reachable(graph, other.id, candidate.id),
      ),
    );
    return convergence === undefined || !reachable(graph, convergence.id, node.id);
  });

  const nearest = containing.find((fork) =>
    containing.every((other) => other.id === fork.id || !reachable(graph, fork.id, other.id)),
  );
  return nearest?.id ?? null;
}

function isComplete(graph: Graph): boolean {
  return [...graph.nodes.values()].some(
    (node) =>
      node.type === "final" &&
      isNodeLive(node) &&
      inEdges(graph, node.id).some((edge) => isEdgeSatisfied(graph, edge)),
  );
}

export function projectNext(graph: Graph): NextProjection {
  const nodes: NextNode[] = [];
  for (const node of readyFrontier(graph)) {
    if (node.type === "action") nodes.push({ ...node, fork: containingFork(graph, node) });
  }
  return {
    version: graph.version,
    complete: isComplete(graph),
    nodes,
  };
}

export async function runNext(io: Io, options: NextOptions): Promise<number> {
  const opened = await openPursuit(io);
  if (!opened.ok) return EXIT_REFUSED;

  const { graph } = opened.folded;
  const projection = projectNext(graph);
  const { complete, nodes: frontier } = projection;

  if (options.json) {
    io.out(JSON.stringify(projection));
  } else if (frontier.length === 0) {
    io.out(`version ${graph.version} · nothing ready${complete ? " · complete" : ""}`);
  } else {
    io.out(`version ${graph.version} · ${frontier.length} ready`);
    for (const activity of frontier) {
      const effect =
        activity.spec.effect_class === "pure" ? "" : `  [${activity.spec.effect_class}]`;
      io.out(`  ${activity.type.padEnd(5)} ${activity.id}  ${activity.name}${effect}`);
    }
  }

  if (reportDamage(io, opened.folded)) return EXIT_REFUSED;
  return EXIT_OK;
}
