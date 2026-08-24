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
  /** Exactly one of `opsFile` / `steps` — the CLI refuses both and neither. */
  opsFile?: string;
  /** `--steps "a" "b"`: sugar for the commonest batch there is. See `opsFromSteps`. */
  steps?: string[];
  baseVersion: number;
  /** §8: a commit without a rationale is impossible, not discouraged. */
  why: string;
  reasonCode: ReasonCode;
  expectedEffect?: string;
  alternativesRejected: string[];
  actor: Actor;
  json: boolean;
}

/**
 * `--steps "read the failing test" "fix the parser"` -> a chain of `task` activities, each
 * depending on the one before it.
 *
 * This is sugar and nothing more: it emits the same authored ops a hand-written file would,
 * and they go through the same validate -> lock -> CAS -> append path. There is no second
 * write path, and `--steps` can express nothing `--ops` cannot.
 *
 * It exists because of a measurement. In `eval/`, the smallest possible first commit was
 * 668 characters across two shell commands, while the banner the model reached for instead
 * was 27 across one — and models under a clock declined the graph, correctly, on cost. A
 * plan you can start in one short command is a plan that gets started.
 *
 * The chain is the default because "steps" are read as a sequence. Anything else — a fan-out,
 * a join, an effect, outputs worth recording — is what `--ops` is for.
 */
export function opsFromSteps(names: string[]): unknown[] {
  const ops: unknown[] = names.map((name) => ({
    op: "add_activity",
    name,
    type: "task",
    // The name is the instruction. A one-line step does not have a second sentence in it,
    // and inventing one would put words in the author's mouth.
    spec: { instruction: name, effect_class: "pure" },
  }));
  // `from A to B` means B depends on A (§6.4), so this reads in the order it was typed.
  for (let index = 1; index < names.length; index += 1) {
    ops.push({ op: "add_edge", from: `$${index - 1}`, to: `$${index}` });
  }
  return ops;
}

export async function runMutate(io: Io, options: MutateOptions): Promise<number> {
  let rawOps: unknown;
  if (options.steps !== undefined) {
    rawOps = opsFromSteps(options.steps);
  } else if (options.opsFile !== undefined) {
    try {
      rawOps = JSON.parse(await readFile(options.opsFile, "utf8"));
    } catch (cause) {
      io.err(
        `REFUSED UNREADABLE_OPS ${options.opsFile}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return EXIT_REFUSED;
    }
  } else {
    io.err("REFUSED MISSING_OPS pass --ops <file> or --steps <label>...");
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
