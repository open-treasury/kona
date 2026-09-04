/**
 * `kona graph --json` — §6.8's **only read contract**. Status, history and the rationale
 * chain are projections of this, which is why pass three deleted the three verbs that
 * wrapped it: a verb wrapping a verb is a shell alias.
 */

import { projectGraph, type GraphProjection } from "@kona/core";
import { readFile } from "node:fs/promises";
import { parseRejections } from "../rejections.ts";
import { EXIT_OK, EXIT_REFUSED } from "../exit.ts";
import { openPursuit, reportDamage } from "../pursuit.ts";
import type { Io } from "../io.ts";

export interface GraphOptions {
  json: boolean;
  /** Read-only time travel (§6.10 rule 6). Never a revert. */
  version?: number;
  /**
   * Include the mutation records. §6.8 makes status, history and the rationale chain
   * PROJECTIONS of this one contract rather than verbs of their own — and §6.10 rule 5
   * makes the timeline panel, not the canvas, the differentiator.
   */
  history?: boolean;
  /**
   * The refusals this pursuit has accumulated (§8). Never folded, and not part of the
   * graph — but §8 also says nothing outside the CLI reads `.kona/`, so this is how a
   * reader gets at them.
   */
  rejections?: boolean;
}

/** Absent is the normal case: a pursuit that has refused nothing has no file. */
async function readRejections(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export function projectPublicGraph(projection: GraphProjection) {
  return projection;
}

export async function runGraph(io: Io, options: GraphOptions): Promise<number> {
  const opened = await openPursuit(
    io,
    options.version === undefined ? {} : { upToVersion: options.version },
  );
  if (!opened.ok) return EXIT_REFUSED;
  const folded = opened.folded;
  const projection = projectPublicGraph(projectGraph(folded.graph));

  const refusals =
    options.rejections === true
      ? parseRejections(await readRejections(opened.paths.rejections))
      : null;

  if (options.json) {
    io.out(
      JSON.stringify({
        ...projection,
        ...(options.history === true ? { history: folded.records } : {}),
        ...(refusals === null ? {} : { rejections: refusals.records }),
        // A torn tail is the expected shape of a crash, not damage: append-then-fsync can
        // only ever truncate the last line. It is reported, and it is not an error.
        torn_tail: folded.torn_tail !== null,
        damaged: folded.damaged,
      }),
    );
  } else if (refusals !== null) {
    io.out(
      refusals.records.length === 0
        ? `version ${projection.version} · nothing has been refused`
        : `version ${projection.version} · ${refusals.records.length} refusal(s)`,
    );
    for (const record of refusals.records) {
      io.out(`  ${record.at}  ${record.rejection.reason}  ${record.rejection.message}`);
      io.out(`    wanted: ${record.rationale?.why ?? "(no rationale)"}`);
    }
    if (refusals.damaged > 0) io.out(`  ${refusals.damaged} unreadable line(s)`);
  } else {
    io.out(
      `version ${projection.version} · ${projection.nodes.length} activities · ${projection.edges.length} edges`,
    );
    for (const activity of projection.nodes) {
      // A control node has no status, and the column says so rather than printing a blank:
      // an empty cell reads as "we do not know", and the store knows exactly.
      const state = activity.status?.state ?? "—";
      io.out(`  ${state.padEnd(10)} ${activity.type.padEnd(12)} ${activity.id}  ${activity.name}`);
    }
    for (const edge of projection.edges) {
      const on =
        edge.guard === undefined
          ? ""
          : typeof edge.guard === "object" && "on" in edge.guard
            ? ` [on:${edge.guard.on}]`
            : ` [guard:${typeof edge.guard === "string" ? edge.guard : JSON.stringify(edge.guard)}]`;
      io.out(`  ${edge.to} requires ${edge.from}${on}`);
    }
  }

  if (reportDamage(io, folded)) return EXIT_REFUSED;
  return EXIT_OK;
}
