/**
 * Verb dispatch and exit codes.
 *
 * `run` takes its argv and its whole world as arguments and returns a number. Nothing here
 * touches `process`, which is what lets an integration test drive a real verb against a
 * temp directory and assert on exact stdout bytes and the exact exit code.
 */

import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  ACTOR_KINDS,
  REASON_CODES,
  type ActorKind,
  type EffectOutcome,
  type ReasonCode,
} from "@kona/core";
import type { Io } from "./io.ts";
import { EXIT_OK, EXIT_REFUSED } from "./exit.ts";
import { runInit } from "./commands/init.ts";
import { runGraph } from "./commands/graph.ts";
import { runNext } from "./commands/next.ts";
import { runBrief } from "./commands/brief.ts";
import { runResume } from "./commands/resume.ts";
import { DEFAULT_VIEW_PORT, runView } from "./commands/view.ts";
import { runMutate } from "./commands/mutate.ts";
import { runRecord, runReserve } from "./commands/effect.ts";

/**
 * §6.8's nine verbs. Listing the unbuilt ones is deliberate: a verb that is absent from
 * `--help` gets reinvented, and a verb that reports "not built yet" cannot be mistaken
 * for one that silently did nothing.
 */
const VERBS: { name: string; summary: string; built: boolean }[] = [
  { name: "init", summary: "create .kona/, refuse on a network filesystem", built: true },
  { name: "mutate", summary: "the only write path: validate, lock, CAS, append, fsync", built: true },
  { name: "graph", summary: "the only read contract", built: true },
  { name: "next", summary: "the ready frontier, computed never stored", built: true },
  { name: "brief", summary: "a node's subgraph plus identity, correlation, preconditions", built: true },
  { name: "poll", summary: "scan each armed wait's cursor", built: false },
  { name: "resume", summary: "reconcile-then-repair", built: true },
  { name: "effect", summary: "reserve | record — the outbox, the only verbs that touch the world", built: true },
  { name: "view", summary: "start the localhost viewer — user-run, never plugin-spawned", built: true },
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
    config: { type: "string" },
  },
  graph: { ...COMMON, version: { type: "string" }, history: { type: "boolean", default: false } },
  next: { ...COMMON },
  brief: { ...COMMON },
  resume: { ...COMMON, "dry-run": { type: "boolean", default: false } },
  view: { ...COMMON, port: { type: "string" } },
  effect: {
    ...COMMON,
    "payload-hash": { type: "string" },
    key: { type: "string" },
    outcome: { type: "string" },
    "message-id": { type: "string" },
    why: { type: "string" },
    "reason-code": { type: "string", default: "OTHER" },
    "actor-id": { type: "string", default: "executor" },
  },
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

const EFFECT_OUTCOMES = ["sent", "failed"] as const;

/**
 * `kona effect reserve|record <node>`. Both are mutating verbs, so §8's `--why` applies.
 * `--reason-code` defaults to OTHER on purpose: the closed vocabulary describes why a PLAN
 * changed (COUNTERPARTY_DECLINED, MISSING_STEP...), and none of it describes "I sent the
 * message I was told to send". Forcing a wrong code is worse than defaulting to OTHER.
 */
async function runEffect(
  values: Record<string, unknown>,
  positionals: readonly string[],
  io: Io,
): Promise<number> {
  const [action, node] = positionals;
  if (action !== "reserve" && action !== "record") {
    io.err(`REFUSED BAD_SUBCOMMAND kona effect takes 'reserve' or 'record', got '${action ?? "nothing"}'`);
    return EXIT_REFUSED;
  }
  if (node === undefined || node.length === 0) {
    io.err(`REFUSED MISSING_NODE kona effect ${action} needs a node id`);
    return EXIT_REFUSED;
  }

  const why = requireString(values, "why", io);
  if (why === null) return EXIT_REFUSED;
  const reasonCode = requireMember<ReasonCode>(values, "reason-code", REASON_CODES, io);
  if (reasonCode === null) return EXIT_REFUSED;

  const rationale = { why, reasonCode };
  const json = values["json"] === true;
  const actorId = String(values["actor-id"]);

  if (action === "reserve") {
    const payloadHash = requireString(values, "payload-hash", io);
    if (payloadHash === null) return EXIT_REFUSED;
    return await runReserve(io, { node, payloadHash, rationale, actorId, json });
  }

  const key = requireString(values, "key", io);
  if (key === null) return EXIT_REFUSED;
  const outcome = requireMember<EffectOutcome>(values, "outcome", EFFECT_OUTCOMES, io);
  if (outcome === null) return EXIT_REFUSED;
  const messageId = requireString(values, "message-id", io);
  if (messageId === null) return EXIT_REFUSED;

  return await runRecord(io, { node, key, outcome, messageId, rationale, actorId, json });
}

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
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...rest],
      options: VERB_OPTIONS[verb],
      // Only `effect` takes positionals — its subcommand and its node.
      allowPositionals: verb === "effect" || verb === "brief",
      strict: true,
    }));
  } catch (cause) {
    io.err(`REFUSED BAD_FLAG ${cause instanceof Error ? cause.message : String(cause)}`);
    return EXIT_REFUSED;
  }

  const json = values["json"] === true;

  if (verb === "init") {
    const configFile = values["config"];
    return await runInit(io, {
      force: values["force"] === true,
      actorId: String(values["actor-id"]),
      ...(typeof configFile === "string" ? { configFile } : {}),
      json,
    });
  }

  if (verb === "brief") {
    const [node] = positionals;
    if (node === undefined || node.length === 0) {
      io.err("REFUSED MISSING_NODE kona brief needs a node id");
      return EXIT_REFUSED;
    }
    return await runBrief(io, { node, json });
  }

  if (verb === "effect") {
    return await runEffect(values, positionals, io);
  }

  if (verb === "view") {
    if (values["port"] === undefined) return await runView(io, { json, port: DEFAULT_VIEW_PORT });
    const port = requireInteger(values, "port", io);
    if (port === null) return EXIT_REFUSED;
    return await runView(io, { json, port });
  }

  if (verb === "resume") {
    return await runResume(io, { json, dryRun: values["dry-run"] === true });
  }

  if (verb === "next") {
    return await runNext(io, { json });
  }

  if (verb === "graph") {
    const history = values["history"] === true;
    if (values["version"] !== undefined) {
      const version = requireInteger(values, "version", io);
      if (version === null) return EXIT_REFUSED;
      return await runGraph(io, { json, version, history });
    }
    return await runGraph(io, { json, history });
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
