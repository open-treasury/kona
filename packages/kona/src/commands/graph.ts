/**
 * `kona graph --json` — §6.8's **only read contract**. Status, history and the rationale
 * chain are projections of this, which is why pass three deleted the three verbs that
 * wrapped it: a verb wrapping a verb is a shell alias.
 */

import { foldLog, projectGraph } from "@kona/core";
import { findPursuitRoot, konaPaths } from "../paths.ts";
import { readLogText } from "../store.ts";
import { EXIT_OK, EXIT_REFUSED } from "../exit.ts";
import type { Io } from "../io.ts";

export interface GraphOptions {
  json: boolean;
  /** Read-only time travel (§6.10 rule 6). Never a revert. */
  version?: number;
}

export async function runGraph(io: Io, options: GraphOptions): Promise<number> {
  const root = findPursuitRoot(io.cwd);
  if (root === null) {
    io.err(`REFUSED NO_PURSUIT no .kona/ found at or above ${io.cwd}`);
    return EXIT_REFUSED;
  }

  const paths = konaPaths(root);
  const folded = foldLog(
    await readLogText(paths),
    options.version === undefined ? {} : { upToVersion: options.version },
  );
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

  if (folded.damaged.length > 0) {
    for (const entry of folded.damaged) {
      io.err(`REFUSED ${entry.reason} line=${entry.line} ${entry.detail}`);
    }
    return EXIT_REFUSED;
  }
  return EXIT_OK;
}
