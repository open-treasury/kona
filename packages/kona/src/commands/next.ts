/**
 * `kona next` — the ready frontier (§6.8). **Computed, never stored.**
 *
 * This is the plugin's only source of work, and it is the verb where §6.4's "readiness
 * fails safe" is load-bearing: a node on an untaken branch must never appear here, because
 * appearing here is what gets it dispatched, pivot send included.
 */

import { readyFrontier } from "@kona/core";
import { EXIT_OK, EXIT_REFUSED } from "../exit.ts";
import { openPursuit, reportDamage } from "../pursuit.ts";
import type { Io } from "../io.ts";

export interface NextOptions {
  json: boolean;
}

export async function runNext(io: Io, options: NextOptions): Promise<number> {
  const opened = await openPursuit(io);
  if (!opened.ok) return EXIT_REFUSED;

  const { graph } = opened.folded;
  const frontier = readyFrontier(graph);

  if (options.json) {
    io.out(JSON.stringify({ version: graph.version, nodes: frontier }));
  } else if (frontier.length === 0) {
    io.out(`version ${graph.version} · nothing ready`);
  } else {
    io.out(`version ${graph.version} · ${frontier.length} ready`);
    for (const node of frontier) {
      const effect = node.spec.effect_class === "pure" ? "" : `  [${node.spec.effect_class}]`;
      io.out(`  ${node.type.padEnd(5)} ${node.id}  ${node.label}${effect}`);
    }
  }

  if (reportDamage(io, opened.folded)) return EXIT_REFUSED;
  return EXIT_OK;
}
