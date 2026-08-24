/**
 * Turn an authored batch into a committed one: every `$N` resolved, every id minted (§6.4).
 *
 * The log stores the *committed* form, so `fold` never mints and a replay cannot drift
 * from the commit that produced it. Minting happens exactly once, here, at commit time —
 * which is also why §6.4 can forbid client-assigned ids without forbidding fan-out.
 */

import type { AuthoredOp, CommittedOp } from "./schema.ts";
import { isOpRef } from "./schema.ts";
import type { Graph } from "./graph.ts";
import { mintActivityId } from "./ids.ts";
import { type Result, ok, refuse } from "./result.ts";

interface RefScope {
  /** Ids that exist in pre-commit head. */
  committed: ReadonlySet<string>;
  /** `$N` -> minted id, for ops already processed in this batch. */
  minted: Map<string, string>;
  /** Every id spoken for, so minting cannot collide with a sibling in the same batch. */
  taken: Set<string>;
}

/** Narrow by testing, not by asserting: the parser has run, but the draft is a bag. */
function hasStringField<K extends string>(
  value: unknown,
  key: K,
): value is Record<K, string> & Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    key in value &&
    typeof (value as Record<string, unknown>)[key] === "string"
  );
}

function resolveRef(
  raw: string,
  scope: RefScope,
  opIndex: number,
  field: string,
): Result<string> {
  if (!isOpRef(raw)) {
    if (!scope.committed.has(raw)) {
      return refuse("UNKNOWN_ACTIVITY", `${field} references '${raw}', which does not exist`, {
        activity: raw,
        op_index: opIndex,
      });
    }
    return ok(raw);
  }

  const target = Number(raw.slice(1));
  if (target >= opIndex) {
    // Forward and self references are rejected rather than deferred: a batch that can
    // point at its own future has no evaluation order that is obviously right.
    return refuse(
      "FORWARD_REF",
      `${field} references ${raw}, which is not an earlier op in this batch`,
      { op_index: opIndex },
    );
  }
  const resolved = scope.minted.get(raw);
  if (resolved === undefined) {
    return refuse("UNRESOLVED_REF", `${field} references ${raw}, which minted no id`, {
      op_index: opIndex,
    });
  }
  return ok(resolved);
}

/** Every position in an activity spec that may hold a reference. Listed, not traversed. */
function normalizeSpec<S extends object>(
  spec: S,
  scope: RefScope,
  opIndex: number,
): Result<S> {
  const draft: Record<string, unknown> = { ...(spec as Record<string, unknown>) };

  const simpleRefs: [string, string][] = [
    ["compensates", "spec.compensates"],
    ["on_timeout", "spec.on_timeout"],
  ];
  for (const [key, field] of simpleRefs) {
    const raw = draft[key];
    if (typeof raw !== "string") continue;
    const resolved = resolveRef(raw, scope, opIndex, field);
    if (!resolved.ok) return resolved;
    draft[key] = resolved.value;
  }

  const obviated = draft["obviated_if"];
  if (hasStringField(obviated, "wait")) {
    const resolved = resolveRef(obviated.wait, scope, opIndex, "spec.obviated_if.wait");
    if (!resolved.ok) return resolved;
    draft["obviated_if"] = { ...obviated, wait: resolved.value };
  }

  // Only the `{after, duration}` deadline shape carries a reference; `{at}` and `{expr}`
  // hold literals and pass through untouched.
  const deadline = draft["deadline"];
  if (hasStringField(deadline, "after")) {
    const resolved = resolveRef(deadline.after, scope, opIndex, "spec.deadline.after");
    if (!resolved.ok) return resolved;
    draft["deadline"] = { ...deadline, after: resolved.value };
  }

  return ok(draft as unknown as S);
}

export function normalizeBatch(
  graph: Graph,
  ops: readonly AuthoredOp[],
  /** The pursuit's id prefix, from the genesis config. Every minted id opens with it. */
  prefix: string,
  /** The version this batch commits as — part of the mint seed, so ids do not repeat. */
  version: number,
): Result<CommittedOp[]> {
  const scope: RefScope = {
    committed: new Set(graph.activities.keys()),
    minted: new Map(),
    taken: new Set(graph.activities.keys()),
  };
  const committed: CommittedOp[] = [];

  for (const [opIndex, op] of ops.entries()) {
    switch (op.op) {
      case "add_activity": {
        const spec = normalizeSpec(op.spec, scope, opIndex);
        if (!spec.ok) return spec;
        const id = mintActivityId(prefix, op.name, version, opIndex, scope.taken);
        scope.taken.add(id);
        scope.minted.set(`$${opIndex}`, id);
        committed.push({ ...op, id, spec: spec.value });
        break;
      }
      case "add_edge": {
        const from = resolveRef(op.from, scope, opIndex, "from");
        if (!from.ok) return from;
        const to = resolveRef(op.to, scope, opIndex, "to");
        if (!to.ok) return to;
        committed.push({ ...op, from: from.value, to: to.value });
        break;
      }
      case "supersede_activity": {
        const activity = resolveRef(op.activity, scope, opIndex, "activity");
        if (!activity.ok) return activity;
        if (op.by === undefined) {
          committed.push({ ...op, activity: activity.value });
          break;
        }
        const by = resolveRef(op.by, scope, opIndex, "by");
        if (!by.ok) return by;
        committed.push({ ...op, activity: activity.value, by: by.value });
        break;
      }
      default: {
        const activity = resolveRef(op.activity, scope, opIndex, "activity");
        if (!activity.ok) return activity;
        committed.push({ ...op, activity: activity.value });
        break;
      }
    }
  }

  return ok(committed);
}
