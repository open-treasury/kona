/**
 * The write path. §6.1: **append -> fsync -> then take the side effect. Never the reverse.**
 *
 * This is the only module in the repo that appends to the log, and `kona` is the only
 * package that writes bytes at all (§6.12). The dependency graph, not a comment, is what
 * enforces that: `core` has no `node:fs` import to make.
 */

import { open, readFile } from "node:fs/promises";
import { type FoldResult, type MutationRecord, foldLog } from "@kona/core";
import type { KonaPaths } from "./paths.ts";

export async function readLogText(paths: KonaPaths): Promise<string> {
  return await readFile(paths.log, "utf8");
}

export async function loadGraph(paths: KonaPaths): Promise<FoldResult> {
  return foldLog(await readLogText(paths));
}

/** One record, one line. No trailing spaces, no pretty-printing, always newline-terminated. */
export function serializeRecord(record: MutationRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Append one record and fsync before returning.
 *
 * The fsync is the entire durability story: until it returns, a crash loses the record,
 * and after it returns, a crash cannot. Every irreversible effect in §6.6 is sequenced
 * after a call to this function precisely so that the log is never behind the world.
 */
export async function appendRecord(paths: KonaPaths, record: MutationRecord): Promise<void> {
  const handle = await open(paths.log, "a");
  try {
    await handle.writeFile(serializeRecord(record));
    await handle.sync();
  } finally {
    await handle.close();
  }
}
