/**
 * Opening a pursuit: find it, read it, fold it. Every read verb starts here, so the
 * "there is no snapshot" claim has exactly one implementation to be true in.
 */

import type { FoldOptions, FoldResult } from "@kona/core";
import { foldLog } from "@kona/core";
import { type KonaPaths, findPursuitRoot, konaPaths } from "./paths.ts";
import { readLogText } from "./store.ts";
import type { Io } from "./io.ts";

export type OpenPursuit = { ok: true; paths: KonaPaths; folded: FoldResult } | { ok: false };

export async function openPursuit(io: Io, options: FoldOptions = {}): Promise<OpenPursuit> {
  const root = findPursuitRoot(io.cwd);
  if (root === null) {
    io.err(`REFUSED NO_PURSUIT no .kona/ found at or above ${io.cwd}`);
    return { ok: false };
  }
  const paths = konaPaths(root);
  return { ok: true, paths, folded: foldLog(await readLogText(paths), options) };
}

/** Damaged lines are reported one per line, symbolic reason first (§6.8). */
export function reportDamage(io: Io, folded: FoldResult): boolean {
  for (const entry of folded.damaged) {
    io.err(`REFUSED ${entry.reason} line=${entry.line} ${entry.detail}`);
  }
  return folded.damaged.length > 0;
}
