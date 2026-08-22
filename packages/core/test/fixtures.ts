/** Shared builders. Every fixture is a *legal* value; tests break exactly one thing. */

import type { Actor, AuthoredOp, Graph, MutationRecord } from "../src/index.ts";
import { SCHEMA_VERSION, emptyGraph, validate } from "../src/index.ts";

export const ORCHESTRATOR: Actor = { kind: "orchestrator", id: "run-1" };
export const SUBAGENT: Actor = { kind: "subagent", id: "exec-3" };

export function task(label: string, extra: Record<string, unknown> = {}): AuthoredOp {
  return {
    op: "add_node",
    label,
    type: "task",
    spec: {
      instruction: `do: ${label}`,
      inputs: [],
      outputs: [{ name: "reply", type: "string" }],
      effect_class: "pure",
      ...extra,
    },
  } as unknown as AuthoredOp;
}

export function wait(label: string, extra: Record<string, unknown> = {}): AuthoredOp {
  return {
    op: "add_node",
    label,
    type: "wait",
    spec: {
      instruction: `await: ${label}`,
      inputs: [],
      outputs: [],
      effect_class: "pure",
      deadline: { at: "2026-08-22T17:00:00.000Z" },
      on_timeout: "$0",
      match: { kind: "event", conditions: [{ kind: "reply", on: "satisfied" }], memory: true },
      ...extra,
    },
  } as unknown as AuthoredOp;
}

/** Commit a batch and return the resulting graph, failing loudly if it was rejected. */
export function commit(graph: Graph, ops: AuthoredOp[], actor: Actor = ORCHESTRATOR): Graph {
  const result = validate({ graph, ops, actor, version: graph.version + 1 });
  if (!result.ok) throw new Error(`fixture batch was rejected: ${result.rejection.message}`);
  return result.value.graph;
}

export function seeded(ops: AuthoredOp[]): Graph {
  return commit(emptyGraph(SCHEMA_VERSION), ops);
}

export function record(v: number, ops: MutationRecord["ops"]): MutationRecord {
  const stamp = "2026-08-21T12:00:00.000Z";
  return {
    v,
    schema_version: SCHEMA_VERSION,
    observed_at: stamp,
    occurred_at: stamp,
    actor: ORCHESTRATOR,
    ops,
    rationale: { why: "test", alternatives_rejected: [], reason_code: "OTHER" },
    outcome: null,
  };
}

export function logOf(...records: MutationRecord[]): string {
  return records.map((r) => `${JSON.stringify(r)}\n`).join("");
}
