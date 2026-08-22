/**
 * `kona graph --json` — §6.8's **only read contract**. Status, history and the rationale
 * chain are projections of this, which is why pass three deleted the three verbs that
 * wrapped it: a verb wrapping a verb is a shell alias.
 */

import { projectGraph } from "@kona/core";
import { EXIT_OK, EXIT_REFUSED } from "../exit.ts";
import { openPursuit, reportDamage } from "../pursuit.ts";
import type { Io } from "../io.ts";

export interface GraphOptions {
  json: boolean;
  /** Read-only time travel (§6.10 rule 6). Never a revert. */
  version?: number;
}

export async function runGraph(io: Io, options: GraphOptions): Promise<number> {
  const opened = await openPursuit(
    io,
    options.version === undefined ? {} : { upToVersion: options.version },
  );
  if (!opened.ok) return EXIT_REFUSED;
  const folded = opened.folded;
  const projection = projectGraph(folded.graph);

  if (options.json) {
    io.out(
      JSON.stringify({
        ...projection,
        // A torn tail is the expected shape of a crash, not damage: append-then-fsync can
        // only ever truncate the last line. It is reported, and it is not an error.
        torn_tail: folded.torn_tail !== null,
        damaged: folded.damaged,
      }),
    );
  } else {
    io.out(`version ${projection.version} · ${projection.nodes.length} nodes · ${projection.edges.length} edges`);
    for (const node of projection.nodes) {
      io.out(`  ${node.status.state.padEnd(8)} ${node.type.padEnd(5)} ${node.id}  ${node.label}`);
    }
    for (const edge of projection.edges) {
      const on = edge.condition === undefined ? "" : ` [on:${edge.condition.on}]`;
      io.out(`  ${edge.to} requires ${edge.from}${on}`);
    }
  }

  if (reportDamage(io, folded)) return EXIT_REFUSED;
  return EXIT_OK;
}
