/** §6.1 — the `.kona/` layout. Two files, and neither is a snapshot. */

import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";

export const KONA_DIR = ".kona";
export const LOG_FILE = "mutations.jsonl";
export const LOCK_FILE = "lock";
export const REJECTIONS_FILE = "rejections.jsonl";

export interface KonaPaths {
  /** The pursuit root — the directory containing `.kona/`. */
  root: string;
  dir: string;
  /** THE FILE. Append-only, fsync'd, never compacted, never GC'd. */
  log: string;
  /** Held only during a write. */
  lock: string;
  /**
   * §8's procedural memory. Append-only, NEVER folded, and not a system of record — the
   * graph is still exactly `fold(mutations.jsonl)`. Deleting this loses memory, not state.
   */
  rejections: string;
}

export function konaPaths(root: string): KonaPaths {
  const dir = join(root, KONA_DIR);
  return {
    root,
    dir,
    log: join(dir, LOG_FILE),
    lock: join(dir, LOCK_FILE),
    rejections: join(dir, REJECTIONS_FILE),
  };
}

/**
 * Walk up from `cwd` looking for `.kona/`, the way git finds `.git`. Returns null rather
 * than throwing, so the caller owns the error message.
 */
export function findPursuitRoot(cwd: string): string | null {
  let current = resolve(cwd);
  for (;;) {
    if (existsSync(join(current, KONA_DIR, LOG_FILE))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
