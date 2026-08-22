/**
 * `kona mutate` — the general write verb (§6.8). Reads an authored batch off disk,
 * compare-and-swaps against head, and commits it through the shared write path.
 */

import { readFile } from "node:fs/promises";
import type { Actor, ReasonCode } from "@kona/core";
import { type BuildResult, commitBatch } from "../commit.ts";
import { EXIT_OK, EXIT_REFUSED, EXIT_STALE_BASE_VERSION } from "../exit.ts";
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
  let rawOps: unknown;
  try {
    rawOps = JSON.parse(await readFile(options.opsFile, "utf8"));
  } catch (cause) {
    io.err(
      `REFUSED UNREADABLE_OPS ${options.opsFile}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return EXIT_REFUSED;
  }

  const outcome = await commitBatch(io, (graph): BuildResult => {
    // CAS against head, inside the lock. Exit 3 -> re-read -> re-decide, never
    // blind-merge (§6.7). The enemy is hand-offs, not races, so the fix is rejection.
    if (options.baseVersion !== graph.version) {
      io.err(
        `STALE_BASE_VERSION head=${graph.version} base=${options.baseVersion} ` +
          `re-read the graph and re-decide; a blind merge is never correct here`,
      );
      return { refused: EXIT_STALE_BASE_VERSION };
    }
    return {
      baseVersion: options.baseVersion,
      commit: {
        ops: rawOps,
        rationale: {
          why: options.why,
          reasonCode: options.reasonCode,
          ...(options.expectedEffect === undefined
            ? {}
            : { expectedEffect: options.expectedEffect }),
          alternativesRejected: options.alternativesRejected,
        },
        actor: options.actor,
      },
    };
  });

  if (!outcome.ok) return outcome.code;

  const { version, mintedIds, opCount } = outcome.value;
  io.out(
    options.json
      ? JSON.stringify({ ok: true, version, minted_ids: mintedIds, ops: opCount })
      : `committed v${version} · ${opCount} ops${mintedIds.length > 0 ? ` · minted ${mintedIds.join(", ")}` : ""}`,
  );
  return EXIT_OK;
}
