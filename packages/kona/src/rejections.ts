/**
 * `.kona/rejections.jsonl` — §8: "**Rejected mutations are logged** — a refused mutation is
 * procedural memory too."
 *
 * ## Why this is a third file, when §6.1 says two
 *
 * A rejection cannot go in `mutations.jsonl`. `fold` requires versions to increment by one,
 * and a refused batch changed nothing — writing it there would either break contiguity or
 * make "the graph is a fold over the log" false.
 *
 * The two-file rule exists to stop a SECOND SYSTEM OF RECORD and a derived snapshot that
 * can go stale against it. This is neither: nothing folds it, nothing reads it to decide
 * anything, and deleting it loses memory rather than state. The graph is still exactly
 * `fold(mutations.jsonl)`.
 *
 * ## Why it is worth having at all
 *
 * §6.3 draws the line: "Rationale without outcome is a changelog; rationale with outcome is
 * training data." A rejection carries BOTH — what the mutator meant to do, in its own
 * words, and what the store said about it. That is the highest-signal record the system
 * produces.
 *
 * It is also the only way to see a specific failure the probes measured. At n=60 the retry
 * loop "converted 19 loud rejections into 19 silent commits": the mutator was refused,
 * quietly adjusted, and got something through. From `mutations.jsonl` alone that history is
 * invisible — you see nineteen clean commits.
 *
 * ## Best effort, and loudly so
 *
 * A refusal must not become a crash because the memory of it could not be written. If the
 * append fails, the refusal still stands and one line says the note was lost.
 *
 * ## What is NOT logged
 *
 * A stale base version. That is contention, not a defect in the batch — the ops may be
 * perfectly good and simply late. What this file is for is the other thing: a batch the
 * store judged WRONG, which is what the probe measured and what a later reader can learn
 * from.
 */

import { open } from "node:fs/promises";
import type { Actor, Rejection } from "@kona/core";
import type { KonaPaths } from "./paths.ts";

export interface RejectionRecord {
  /** Engine-stamped, like every other timestamp here. */
  at: string;
  actor: Actor;
  /** What head was when the store said no. */
  head_version: number;
  /** What the author thought head was. Differs from `head_version` on a CAS failure. */
  base_version: number | null;
  /** The batch AS AUTHORED — `$N` refs and all, since it never got normalised. */
  ops: unknown;
  /** The author's own words. Present even when the ops were malformed. */
  rationale: { why: string; reason_code: string } | null;
  rejection: Rejection;
}

function serializeRejection(record: RejectionRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Append one rejection. Never throws.
 *
 * No fsync: unlike `mutations.jsonl`, nothing is sequenced after this and nothing depends
 * on it having landed. Paying a disk flush to remember a refusal would slow the one path
 * that is already telling somebody they were wrong.
 */
export async function appendRejection(
  paths: KonaPaths,
  record: RejectionRecord,
  onError: (message: string) => void,
): Promise<void> {
  try {
    const handle = await open(paths.rejections, "a");
    try {
      await handle.writeFile(serializeRejection(record));
    } finally {
      await handle.close();
    }
  } catch (cause) {
    onError(
      `NOTE REJECTION_NOT_LOGGED could not append to ${paths.rejections}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

export interface ParsedRejections {
  records: RejectionRecord[];
  /** Lines that could not be read back. Reported, never guessed at. */
  damaged: number;
}

/** Read the log back. Tolerant: this is memory, and half of it beats none of it. */
export function parseRejections(text: string): ParsedRejections {
  const records: RejectionRecord[] = [];
  let damaged = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/\r$/, "").trim();
    if (trimmed.length === 0) continue;
    try {
      records.push(JSON.parse(trimmed) as RejectionRecord);
    } catch {
      damaged += 1;
    }
  }
  return { records, damaged };
}
