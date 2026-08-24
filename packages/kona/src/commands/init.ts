/** `kona init` — create `.kona/`, write the genesis record, refuse on a network filesystem. */

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  PREFIX_PATTERN,
  PursuitConfigSchema,
  SCHEMA_VERSION,
  isValidPrefix,
  type MutationRecord,
  type PursuitConfig,
} from "@kona/core";
import { readFile } from "node:fs/promises";
import { konaPaths } from "../paths.ts";
import { detectNetworkFilesystem } from "../netfs.ts";
import { appendRecord } from "../store.ts";
import { EXIT_OK, EXIT_REFUSED } from "../exit.ts";
import type { Io } from "../io.ts";

export interface InitOptions {
  /** Escape hatch for the §6.1 path heuristic, which is deliberately approximate. */
  force: boolean;
  actorId: string;
  /** Pursuit-wide config — identity and effect budget — written onto the genesis record. */
  configFile?: string;
  /**
   * `--prefix`: the string every node id in this pursuit opens with. Settable only here,
   * because ids already minted cannot be re-minted — a prefix that could change would leave
   * the log carrying two shapes with neither of them wrong.
   */
  prefix?: string;
  json: boolean;
}

/**
 * Version 0 is a real mutation record with an empty op list, not a header line.
 *
 * Making the first line the same shape as every other line means `fold` has no special
 * case, `--base-version 0` is a true statement about head rather than a magic number, and
 * `schema_version` lives on line 1 as §6.1 requires without inventing a second record type.
 */
export function genesisRecord(
  now: string,
  actorId: string,
  config?: PursuitConfig,
): MutationRecord {
  return {
    v: 0,
    schema_version: SCHEMA_VERSION,
    observed_at: now,
    occurred_at: now,
    actor: { kind: "human", id: actorId },
    ops: [],
    ...(config === undefined ? {} : { config }),
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

  let config: PursuitConfig | undefined;
  if (options.configFile !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(options.configFile, "utf8"));
    } catch (cause) {
      io.err(
        `REFUSED UNREADABLE_CONFIG ${options.configFile}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return EXIT_REFUSED;
    }
    const parsed = PursuitConfigSchema.safeParse(raw);
    if (!parsed.success) {
      io.err(
        `REFUSED MALFORMED_CONFIG ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
      );
      return EXIT_REFUSED;
    }
    config = parsed.data;
  }

  // Required, not defaulted. A default would be a second way to create a pursuit — one
  // where nobody chose the prefix — and the prefix cannot be changed afterwards, because the
  // ids it produced are already in the log.
  if (options.prefix === undefined && config?.prefix === undefined) {
    io.err(
      "REFUSED MISSING_FLAG --prefix is required: every node id opens with it, and it is " +
        "fixed for the life of the pursuit",
    );
    return EXIT_REFUSED;
  }

  // `--prefix` beats the config file, since it is the more immediate statement of intent,
  // and it is the only way to set the prefix without authoring a config file at all.
  if (options.prefix !== undefined) {
    if (!isValidPrefix(options.prefix)) {
      io.err(
        `REFUSED BAD_PREFIX '${options.prefix}' must be 1-8 characters matching ` +
          `${PREFIX_PATTERN.source} — a letter, then letters or digits, and no '-' because ` +
          `the dash separates the prefix from the hash`,
      );
      return EXIT_REFUSED;
    }
    config = { ...config, prefix: options.prefix };
  }

  await mkdir(paths.dir, { recursive: true });
  await appendRecord(paths, genesisRecord(io.now(), options.actorId, config));

  io.out(
    options.json
      ? JSON.stringify({ ok: true, root: paths.root, log: paths.log, version: 0 })
      : `initialised ${paths.log} at version 0 · ids look like ${config?.prefix}-a1b2`,
  );
  return EXIT_OK;
}
