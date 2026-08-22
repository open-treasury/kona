/**
 * `kona mutate` — **the only write path** (§6.8): validate -> lock -> CAS -> append -> fsync.
 *
 * The order below is not the order the spec sentence lists them in, and the difference is
 * deliberate: the lock is taken *first*, and head is re-read inside it. Folding before
 * locking would validate against a head another writer could move before the append, which
 * is exactly the hand-off race CAS exists to reject.
 */

import { readFile } from "node:fs/promises";
import {
  type Actor,
  type MutationRecord,
  type ReasonCode,
  SCHEMA_VERSION,
  foldLog,
  formatRejection,
  validate,
} from "@kona/core";
import { findPursuitRoot, konaPaths } from "../paths.ts";
import { appendRecord, readLogText } from "../store.ts";
import { withLock } from "../lock.ts";
import { EXIT_OK, EXIT_REFUSED, EXIT_STALE_BASE_VERSION, exitCodeFor } from "../exit.ts";
import type { Io } from "../io.ts";

export interface MutateOptions {
  opsFile: string;
  baseVersion: number;
  /** §8: a commit without a rationale is impossible, not discouraged. */
  why: string;
  reasonCode: ReasonCode;
  expectedEffect?: string;
  alternativesRejected: string[];
  actor: Actor;
  json: boolean;
}

export async function runMutate(io: Io, options: MutateOptions): Promise<number> {
  const root = findPursuitRoot(io.cwd);
  if (root === null) {
    io.err(`REFUSED NO_PURSUIT no .kona/ found at or above ${io.cwd}`);
    return EXIT_REFUSED;
  }
  const paths = konaPaths(root);

  let rawOps: unknown;
  try {
    rawOps = JSON.parse(await readFile(options.opsFile, "utf8"));
  } catch (cause) {
    io.err(
      `REFUSED UNREADABLE_OPS ${options.opsFile}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return EXIT_REFUSED;
  }

  const held = await withLock(paths.lock, io.now, io.pid, async () => {
    const folded = foldLog(await readLogText(paths));

    const [firstDamaged] = folded.damaged;
    if (firstDamaged !== undefined) {
      io.err(
        `REFUSED CORRUPT_LOG line=${firstDamaged.line} ${firstDamaged.reason} ${firstDamaged.detail}`,
      );
      return EXIT_REFUSED;
    }

    // CAS against head, inside the lock. Exit 3 -> re-read -> re-decide, never blind-merge
    // (§6.7). The enemy is hand-offs, not races, so the fix is rejection.
    const head = folded.graph.version;
    if (options.baseVersion !== head) {
      io.err(
        `STALE_BASE_VERSION head=${head} base=${options.baseVersion} ` +
          `re-read the graph and re-decide; a blind merge is never correct here`,
      );
      return EXIT_STALE_BASE_VERSION;
    }

    const version = head + 1;
    const validated = validate({
      graph: folded.graph,
      ops: rawOps,
      actor: options.actor,
      version,
    });
    if (!validated.ok) {
      io.err(formatRejection(validated.rejection));
      return exitCodeFor(validated.rejection);
    }

    const stamp = io.now();
    const record: MutationRecord = {
      v: version,
      schema_version: SCHEMA_VERSION,
      observed_at: stamp,
      occurred_at: stamp,
      actor: options.actor,
      ops: validated.value.ops,
      rationale: {
        why: options.why,
        ...(options.expectedEffect === undefined
          ? {}
          : { expected_effect: options.expectedEffect }),
        alternatives_rejected: options.alternativesRejected,
        reason_code: options.reasonCode,
      },
      // §6.3: starts null, written later on evidence. Rationale without outcome is a
      // changelog; rationale with outcome is training data.
      outcome: null,
    };

    await appendRecord(paths, record);

    const minted = validated.value.ops.flatMap((op) => (op.op === "add_node" ? [op.id] : []));
    io.out(
      options.json
        ? JSON.stringify({ ok: true, version, minted_ids: minted, ops: validated.value.ops.length })
        : `committed v${version} · ${validated.value.ops.length} ops${minted.length > 0 ? ` · minted ${minted.join(", ")}` : ""}`,
    );
    return EXIT_OK;
  });

  if (!held.ok) {
    io.err(`REFUSED ${held.reason} ${held.message}`);
    return EXIT_REFUSED;
  }
  return held.value;
}
