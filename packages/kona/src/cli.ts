/**
 * Verb dispatch and exit codes.
 *
 * `run` takes its argv and its whole world as arguments and returns a number. Nothing here
 * touches `process`, which is what lets an integration test drive a real verb against a
 * temp directory and assert on exact stdout bytes and the exact exit code.
 */

import { parseArgs, type ParseArgsConfig } from "node:util";
import { ACTOR_KINDS, REASON_CODES, type ActorKind, type ReasonCode } from "@kona/core";
import type { Io } from "./io.ts";
import { EXIT_OK, EXIT_REFUSED } from "./exit.ts";
import { runInit } from "./commands/init.ts";
import { runGraph } from "./commands/graph.ts";
import { runMutate } from "./commands/mutate.ts";

/**
 * §6.8's nine verbs. Listing the unbuilt ones is deliberate: a verb that is absent from
 * `--help` gets reinvented, and a verb that reports "not built yet" cannot be mistaken
 * for one that silently did nothing.
 */
const VERBS: { name: string; summary: string; built: boolean }[] = [
  { name: "init", summary: "create .kona/, refuse on a network filesystem", built: true },
  { name: "mutate", summary: "the only write path: validate, lock, CAS, append, fsync", built: true },
  { name: "graph", summary: "the only read contract", built: true },
  { name: "next", summary: "the ready frontier, computed never stored", built: false },
  { name: "brief", summary: "a node's subgraph plus identity, correlation, preconditions", built: false },
  { name: "poll", summary: "scan each armed wait's cursor", built: false },
  { name: "resume", summary: "reconcile-then-repair", built: false },
  { name: "effect", summary: "reserve | record — the outbox", built: false },
  { name: "view", summary: "start the localhost viewer", built: false },
];

function usage(): string {
  const lines = [
    "kona — a deterministic CLI over an append-only mutation log.",
    "",
    "  The kona binary never calls a language model. Every verb is a pure function of",
    "  .kona/mutations.jsonl + the clock + the mailbox cursor.",
    "",
    "Verbs:",
    ...VERBS.map((v) => `  ${v.built ? " " : "·"} ${v.name.padEnd(7)} ${v.summary}`),
    "",
    "  · not built yet",
    "",
    "Exit: 0 ok · 1 refused · 3 stale base version · 4 invariant violation",
  ];
  return lines.join("\n");
}

function requireString(
  values: Record<string, unknown>,
  flag: string,
  io: Io,
): string | null {
  const value = values[flag];
  if (typeof value === "string" && value.length > 0) return value;
  // Absent and empty are different mistakes, and "--why is required" is a confusing thing
  // to read when you did pass --why, with nothing after it.
  if (value === undefined) {
    io.err(`REFUSED MISSING_FLAG --${flag} is required`);
  } else {
    io.err(`REFUSED BAD_FLAG --${flag} was given an empty value`);
  }
  return null;
}

function requireInteger(
  values: Record<string, unknown>,
  flag: string,
  io: Io,
): number | null {
  const raw = requireString(values, flag, io);
  if (raw === null) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    io.err(`REFUSED BAD_FLAG --${flag} must be a non-negative integer, got '${raw}'`);
    return null;
  }
  return parsed;
}

function requireMember<T extends string>(
  values: Record<string, unknown>,
  flag: string,
  allowed: readonly T[],
  io: Io,
): T | null {
  const raw = requireString(values, flag, io);
  if (raw === null) return null;
  if (!(allowed as readonly string[]).includes(raw)) {
    io.err(`REFUSED BAD_FLAG --${flag} must be one of ${allowed.join("|")}, got '${raw}'`);
    return null;
  }
  return raw as T;
}

type Options = NonNullable<ParseArgsConfig["options"]>;

const COMMON: Options = { json: { type: "boolean", default: false } };

const VERB_OPTIONS: Record<string, Options> = {
  init: {
    ...COMMON,
    force: { type: "boolean", default: false },
    "actor-id": { type: "string", default: "operator" },
  },
  graph: { ...COMMON, version: { type: "string" } },
  mutate: {
    ...COMMON,
    ops: { type: "string" },
    "base-version": { type: "string" },
    why: { type: "string" },
    "reason-code": { type: "string" },
    "expected-effect": { type: "string" },
    alternative: { type: "string", multiple: true, default: [] },
    "actor-kind": { type: "string", default: "orchestrator" },
    "actor-id": { type: "string", default: "orchestrator" },
  },
};

export async function run(argv: readonly string[], io: Io): Promise<number> {
  const [verb, ...rest] = argv;

  if (verb === undefined || verb === "--help" || verb === "-h" || verb === "help") {
    io.out(usage());
    return EXIT_OK;
  }

  const known = VERBS.find((v) => v.name === verb);
  if (known === undefined) {
    io.err(`REFUSED UNKNOWN_VERB '${verb}' is not a kona verb; try --help`);
    return EXIT_REFUSED;
  }
  if (!known.built) {
    io.err(`REFUSED NOT_IMPLEMENTED '${verb}' is specified but not built yet`);
    return EXIT_REFUSED;
  }

  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: VERB_OPTIONS[verb],
      allowPositionals: false,
      strict: true,
    }) as { values: Record<string, unknown> });
  } catch (cause) {
    io.err(`REFUSED BAD_FLAG ${cause instanceof Error ? cause.message : String(cause)}`);
    return EXIT_REFUSED;
  }

  const json = values["json"] === true;

  if (verb === "init") {
    return await runInit(io, {
      force: values["force"] === true,
      actorId: String(values["actor-id"]),
      json,
    });
  }

  if (verb === "graph") {
    const raw = values["version"];
    if (raw !== undefined) {
      const version = requireInteger(values, "version", io);
      if (version === null) return EXIT_REFUSED;
      return await runGraph(io, { json, version });
    }
    return await runGraph(io, { json });
  }

  const opsFile = requireString(values, "ops", io);
  if (opsFile === null) return EXIT_REFUSED;
  const baseVersion = requireInteger(values, "base-version", io);
  if (baseVersion === null) return EXIT_REFUSED;
  // §8: --why is required on every mutating verb. Not defaulted, not inferred.
  const why = requireString(values, "why", io);
  if (why === null) return EXIT_REFUSED;
  // Nor is reason_code defaulted to OTHER. A field that is free to omit is omitted, and
  // §6.3 wants the machine-readable half of the rationale to actually carry signal.
  const reasonCode = requireMember<ReasonCode>(values, "reason-code", REASON_CODES, io);
  if (reasonCode === null) return EXIT_REFUSED;
  const actorKind = requireMember<ActorKind>(values, "actor-kind", ACTOR_KINDS, io);
  if (actorKind === null) return EXIT_REFUSED;

  const expectedEffect = values["expected-effect"];

  return await runMutate(io, {
    opsFile,
    baseVersion,
    why,
    reasonCode,
    ...(typeof expectedEffect === "string" ? { expectedEffect } : {}),
    alternativesRejected: (values["alternative"] as string[] | undefined) ?? [],
    actor: { kind: actorKind, id: String(values["actor-id"]) },
    json,
  });
}
