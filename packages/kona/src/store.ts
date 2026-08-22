/**
 * The write path. §6.1: **append -> fsync -> then take the side effect. Never the reverse.**
 *
 * This is the only module in the repo that appends to the log, and `kona` is the only
 * package that writes bytes at all (§6.12). The dependency graph, not a comment, is what
 * enforces that: `core` has no `node:fs` import to make.
 */

import { open, readFile, truncate } from "node:fs/promises";
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
 * Drop a torn final line before appending after it.
 *
 * A crash between append and fsync leaves a partial last line, which `fold` correctly
 * tolerates (§6.1). But appending *after* it buries the tear in the MIDDLE of the file,
 * where it stops being a tolerable tail and becomes damage — and from then on every read
 * and every write refuses. One crash would permanently corrupt the pursuit.
 *
 * Truncating is not a rewrite of durable data: a torn line is by definition a record whose
 * fsync never returned, so nothing was ever promised about it and nothing can depend on it.
 * Only the last line can be torn, so exactly one line is dropped.
 */
export async function dropTornTail(paths: KonaPaths, text: string): Promise<void> {
  const withoutFinalNewline = text.replace(/\n$/, "");
  // `lastIndexOf` returns -1 when there is no earlier line, and `slice(0, 0)` is "" — so
  // the whole-file case needs no branch of its own.
  const kept = withoutFinalNewline.slice(0, withoutFinalNewline.lastIndexOf("\n") + 1);
  // BYTES, not characters. Rationales carry em dashes and accented names, and truncating
  // by string length would cut mid-character and corrupt the record before the tear.
  await truncate(paths.log, Buffer.byteLength(kept, "utf8"));
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
