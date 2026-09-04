/**
 * The write path, once. §6.8: `kona mutate` is *the only write path* — every other verb
 * that changes anything goes through this function, so "validate, lock, CAS, append,
 * fsync" has exactly one implementation rather than one per verb.
 *
 * The lock is taken FIRST and head is re-read inside it. Folding before locking would
 * validate against a head another writer can move before the append lands, which is
 * precisely the hand-off race CAS exists to reject.
 */

import {
  type Actor,
  type Graph,
  type MutationRecord,
  type ReasonCode,
  SCHEMA_VERSION,
  formatRejection,
  pursuitConfig,
  validate,
} from "@kona/core";
import type { KonaPaths } from "./paths.ts";
import { findPursuitRoot, konaPaths } from "./paths.ts";
import { appendRecord, dropTornTail, readLogText } from "./store.ts";
import { withLock } from "./lock.ts";
import { EXIT_REFUSED, exitCodeFor } from "./exit.ts";
import type { Io } from "./io.ts";
import { appendRejection } from "./rejections.ts";
import { foldLog } from "@kona/core";

export interface Rationale {
  why: string;
  reasonCode: ReasonCode;
  expectedEffect?: string;
  alternativesRejected?: string[];
}

export interface Batch {
  /** Authored ops — `$N` refs allowed. The parser runs on them, not on trust. */
  ops: unknown;
  rationale: Rationale;
  actor: Actor;
}

/**
 * What a caller decides once it can see pre-commit head: either the batch to commit, or
 * an exit code because it has already explained the refusal on stderr.
 */
export type BuildResult =
  | {
      commit: Batch;
      /**
       * What the author believed head was, when they said so. Recorded on a rejection so a
       * CAS failure is distinguishable from a batch that was simply wrong.
       */
      baseVersion?: number;
    }
  | { refused: number };

export interface Committed {
  version: number;
  mintedIds: string[];
  opCount: number;
}

export type CommitOutcome = { ok: true; value: Committed } | { ok: false; code: number };

export async function commitBatch(
  io: Io,
  build: (graph: Graph, records: readonly MutationRecord[]) => BuildResult,
): Promise<CommitOutcome> {
  const root = findPursuitRoot(io.cwd);
  if (root === null) {
    io.err(`REFUSED NO_PURSUIT no .kona/ found at or above ${io.cwd}`);
    return { ok: false, code: EXIT_REFUSED };
  }
  const paths: KonaPaths = konaPaths(root);

  const held = await withLock(paths.lock, io.now, io.pid, async () => {
    const text = await readLogText(paths);
    const folded = foldLog(text);

    const [firstDamaged] = folded.damaged;
    if (firstDamaged !== undefined) {
      io.err(`REFUSED CORRUPT_LOG line=${firstDamaged.line} ${firstDamaged.reason} ${firstDamaged.detail}`);
      return { ok: false as const, code: EXIT_REFUSED };
    }

    const decision = build(folded.graph, folded.records);
    if ("refused" in decision) return { ok: false as const, code: decision.refused };

    // Every v3 pursuit declares its prefix at init, so a missing one means a log this store
    // did not write. Minting under an invented prefix would put two id shapes in one file.
    const { prefix } = pursuitConfig(folded.records);
    if (prefix === undefined) {
      io.err(
        "REFUSED NO_PREFIX the genesis record declares no id prefix; " +
          "this pursuit was not created by `kona init --prefix <p>`",
      );
      return { ok: false as const, code: EXIT_REFUSED };
    }

    const version = folded.graph.version + 1;
    const validated = validate({
      graph: folded.graph,
      ops: decision.commit.ops,
      actor: decision.commit.actor,
      version,
      // Read off the genesis record every time rather than cached: the log is the only
      // system of record, and a prefix held anywhere else would be a second one.
      prefix,
    });
    if (!validated.ok) {
      io.err(formatRejection(validated.rejection));
      // §8: a refused mutation is procedural memory too. Written inside the lock, and
      // best-effort — a refusal must not become a crash because the note about it failed.
      await appendRejection(
        paths,
        {
          at: io.now(),
          actor: decision.commit.actor,
          head_version: folded.graph.version,
          base_version: decision.baseVersion ?? null,
          ops: decision.commit.ops,
          rationale: {
            why: decision.commit.rationale.why,
            reason_code: decision.commit.rationale.reasonCode,
          },
          rejection: validated.rejection,
        },
        io.err,
      );
      return { ok: false as const, code: exitCodeFor(validated.rejection) };
    }

    const stamp = io.now();
    const { rationale } = decision.commit;
    const record: MutationRecord = {
      v: version,
      schema_version: SCHEMA_VERSION,
      observed_at: stamp,
      occurred_at: stamp,
      actor: decision.commit.actor,
      ops: validated.value.ops,
      rationale: {
        why: rationale.why,
        ...(rationale.expectedEffect === undefined
          ? {}
          : { expected_effect: rationale.expectedEffect }),
        alternatives_rejected: rationale.alternativesRejected ?? [],
        reason_code: rationale.reasonCode,
      },
      // §6.3: starts null, written later on evidence. Rationale without outcome is a
      // changelog; rationale with outcome is training data.
      outcome: null,
    };

    // Before appending, remove any torn tail a previous crash left, or this append would
    // bury it mid-file and turn a survivable crash into a corrupt log.
    if (folded.torn_tail !== null) await dropTornTail(paths, text);
    await appendRecord(paths, record);

    return {
      ok: true as const,
      value: {
        version,
        mintedIds: validated.value.ops.flatMap((op) => (op.op === "add_node" ? [op.id] : [])),
        opCount: validated.value.ops.length,
      },
    };
  });

  if (!held.ok) {
    io.err(`REFUSED ${held.reason} ${held.message}`);
    return { ok: false, code: EXIT_REFUSED };
  }
  return held.value;
}

