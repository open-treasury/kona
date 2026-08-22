/** `kona init` — create `.kona/`, write the genesis record, refuse on a network filesystem. */

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { SCHEMA_VERSION, type MutationRecord } from "@kona/core";
import { konaPaths } from "../paths.ts";
import { detectNetworkFilesystem } from "../netfs.ts";
import { appendRecord } from "../store.ts";
import { EXIT_OK, EXIT_REFUSED } from "../exit.ts";
import type { Io } from "../io.ts";

export interface InitOptions {
  /** Escape hatch for the §6.1 path heuristic, which is deliberately approximate. */
  force: boolean;
  actorId: string;
  json: boolean;
}

/**
 * Version 0 is a real mutation record with an empty op list, not a header line.
 *
 * Making the first line the same shape as every other line means `fold` has no special
 * case, `--base-version 0` is a true statement about head rather than a magic number, and
 * `schema_version` lives on line 1 as §6.1 requires without inventing a second record type.
 */
export function genesisRecord(now: string, actorId: string): MutationRecord {
  return {
    v: 0,
    schema_version: SCHEMA_VERSION,
    observed_at: now,
    occurred_at: now,
    actor: { kind: "human", id: actorId },
    ops: [],
    rationale: {
      why: "pursuit initialised",
      alternatives_rejected: [],
      reason_code: "OTHER",
    },
    outcome: null,
  };
}

export async function runInit(io: Io, options: InitOptions): Promise<number> {
  const paths = konaPaths(io.cwd);

  if (!options.force) {
    const marker = detectNetworkFilesystem(paths.root);
    if (marker !== null) {
      io.err(
        `REFUSED NETWORK_FILESYSTEM ${paths.root} looks like ${marker.name}; ` +
          `rename and lock semantics corrupt there. Re-run with --force to override.`,
      );
      return EXIT_REFUSED;
    }
  }

  if (existsSync(paths.log)) {
    io.err(`REFUSED ALREADY_INITIALISED ${paths.log} exists; the log is never re-created`);
    return EXIT_REFUSED;
  }

  await mkdir(paths.dir, { recursive: true });
  await appendRecord(paths, genesisRecord(io.now(), options.actorId));

  io.out(
    options.json
      ? JSON.stringify({ ok: true, root: paths.root, log: paths.log, version: 0 })
      : `initialised ${paths.log} at version 0`,
  );
  return EXIT_OK;
}
