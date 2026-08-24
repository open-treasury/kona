/** Shared builders. Every fixture is a *legal* value; tests break exactly one thing. */

import type { Actor, AuthoredOp, Graph, MutationRecord, Activity } from "../src/index.ts";
import { SCHEMA_VERSION, emptyGraph, slugify, validate } from "../src/index.ts";

export const ORCHESTRATOR: Actor = { kind: "orchestrator", id: "run-1" };
export const SUBAGENT: Actor = { kind: "subagent", id: "exec-3" };

export function task(name: string, extra: Record<string, unknown> = {}): AuthoredOp {
  return {
    op: "add_activity",
    name,
    type: "task",
    spec: {
      instruction: `do: ${name}`,
      inputs: [],
      outputs: [{ name: "reply", type: "string" }],
      effect_class: "pure",
      ...extra,
    },
  } as unknown as AuthoredOp;
}

export function wait(name: string, extra: Record<string, unknown> = {}): AuthoredOp {
  return {
    op: "add_activity",
    name,
    type: "wait",
    spec: {
      instruction: `await: ${name}`,
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

/**
 * Ids are hashes now, and a test that named one literally would be asserting a magic string.
 *
 * Every fixture still builds activities from labels, so the label is the stable handle — and the
 * id a label *used* to mint is exactly `slugify(label)`. These two functions translate that
 * old slug into whatever the store actually minted, which keeps the tests reading in the
 * vocabulary they were written in: `activityAt(graph, "a")`, not `graph.activities.get("t-9x4k")`.
 */
export function nid(graph: Graph, slug: string): string {
  for (const [id, activity] of graph.activities) if (slugify(activity.name) === slug) return id;
  throw new Error(`no activity in the graph whose label slugs to "${slug}"`);
}

/**
 * `nid`, but returns the input unchanged when nothing matches.
 *
 * Tests that probe the not-found path pass a deliberately absent id ("ghost"), and those have
 * to reach the code under test rather than die in the fixture.
 */
export function slugOr(graph: Graph, slug: string): string {
  for (const [id, activity] of graph.activities) if (slugify(activity.name) === slug) return id;
  return slug;
}

/** Drop-in for `graph.activities.get(slug)`, including its `undefined` for an absent activity. */
export function activityAt(graph: Graph, slug: string): Activity | undefined {
  for (const [, activity] of graph.activities) if (slugify(activity.name) === slug) return activity;
  return undefined;
}

/**
 * Rewrite the slug references in a batch into the ids the store minted.
 *
 * Fixtures name activities the way the tests do — `{op:"set_status", node:"a"}` — and with slug ids
 * that string WAS the id. It no longer is. Resolving here rather than at 168 call sites keeps
 * the change to the id format out of tests that are not about ids, and leaves each test saying
 * what it meant: "the activity labelled A".
 *
 * `$N` refs are left alone; they are batch-local and the normalizer owns them. A string that
 * is already a real id is left alone too, so a test that deliberately passes a minted id — or
 * a deliberately unresolvable one, checking the refusal — still does exactly that.
 */
export function resolveSlugs(graph: Graph, ops: unknown): unknown {
  // Malformed batches are the parser's business, not this helper's.
  if (!Array.isArray(ops)) return ops;
  const resolve = (value: unknown): unknown => {
    if (typeof value !== "string" || value.startsWith("$") || graph.activities.has(value)) return value;
    for (const [id, activity] of graph.activities) if (slugify(activity.name) === value) return id;
    return value;
  };
  // An activity's spec carries ids too — the timeout arm, what it compensates, the wait an
  // obviation watches, and the `activity.output` on the left of every input ref.
  const resolveSpec = (spec: unknown): unknown => {
    if (spec === null || typeof spec !== "object") return spec;
    const draft: Record<string, unknown> = { ...(spec as Record<string, unknown>) };
    for (const field of ["on_timeout", "compensates"]) {
      if (field in draft) draft[field] = resolve(draft[field]);
    }
    const obviated = draft["obviated_if"];
    if (obviated !== null && typeof obviated === "object") {
      const o = obviated as Record<string, unknown>;
      draft["obviated_if"] = { ...o, wait: resolve(o["wait"]) };
    }
    const inputs = draft["inputs"];
    if (Array.isArray(inputs)) {
      // A loop rather than `map`: the lint rule against spreading-to-modify inside `map` is
      // right, and this reads more plainly anyway.
      const resolvedInputs: unknown[] = [];
      for (const input of inputs as unknown[]) {
        if (input === null || typeof input !== "object") {
          resolvedInputs.push(input);
          continue;
        }
        const i = input as Record<string, unknown>;
        const ref = i["ref"];
        if (typeof ref !== "string") {
          resolvedInputs.push(input);
          continue;
        }
        // `<activity>.<output>` — only the activity half is an id.
        const dot = ref.indexOf(".");
        if (dot < 0) {
          resolvedInputs.push({ ...i, ref: resolve(ref) });
          continue;
        }
        const head = resolve(ref.slice(0, dot));
        resolvedInputs.push({ ...i, ref: `${String(head)}${ref.slice(dot)}` });
      }
      draft["inputs"] = resolvedInputs;
    }
    const deadline = draft["deadline"];
    if (deadline !== null && typeof deadline === "object" && "after" in deadline) {
      const d = deadline as Record<string, unknown>;
      draft["deadline"] = { ...d, after: resolve(d["after"]) };
    }
    return draft;
  };

  // `for...of` rather than `map`: the lint rule against spreading-to-modify inside `map` is
  // right, and a loop says what this does more plainly anyway.
  const out: AuthoredOp[] = [];
  for (const op of ops as AuthoredOp[]) {
    const draft: Record<string, unknown> = { ...op };
    for (const field of ["activity", "from", "to", "by"]) {
      if (field in draft) draft[field] = resolve(draft[field]);
    }
    if ("spec" in draft) draft["spec"] = resolveSpec(draft["spec"]);
    out.push(draft as AuthoredOp);
  }
  return out;
}

/**
 * Every id the fixtures have ever minted, mapped back to its label's slug.
 *
 * Assertions are the one place the graph is often not in scope: `expect(r.activity).toBe("a")`
 * reads a rejection, not a graph, and threading a graph into it just to translate an id would
 * change what each test looks like it is about. So the fixture remembers what it minted, and
 * `slugOf` turns an id back into the name the test uses.
 *
 * Unknown ids come back unchanged, which is what the not-found tests want: a rejection naming
 * "ghost" still reads as "ghost".
 */
const MINTED = new Map<string, string>();

export function slugOf(id: string | undefined | null): string | undefined | null {
  if (typeof id !== "string") return id;
  return MINTED.get(id) ?? id;
}

/**
 * `slugOf`, over the ids inside an op.
 *
 * Resume plans and derived batches are compared as whole ops, so the translation has to reach
 * the id-valued fields rather than the op itself.
 */
export function slugOps(op: unknown): unknown {
  if (op === null || typeof op !== "object") return op;
  const draft: Record<string, unknown> = { ...(op as Record<string, unknown>) };
  for (const field of ["activity", "from", "to", "by"]) {
    if (field in draft) draft[field] = slugOf(draft[field] as string);
  }
  return draft;
}

function remember(graph: Graph): Graph {
  for (const [id, activity] of graph.activities) MINTED.set(id, slugify(activity.name));
  return graph;
}

/** Commit a batch and return the resulting graph, failing loudly if it was rejected. */
export function commit(graph: Graph, ops: AuthoredOp[], actor: Actor = ORCHESTRATOR): Graph {
  const result = validate({
    graph,
    ops: resolveSlugs(graph, ops),
    actor,
    version: graph.version + 1,
    prefix: "t",
  });
  if (!result.ok) throw new Error(`fixture batch was rejected: ${result.rejection.message}`);
  return remember(result.value.graph);
}

export function seeded(ops: AuthoredOp[]): Graph {
  return commit(emptyGraph(SCHEMA_VERSION), ops);
}

/**
 * A graph whose head ALREADY attests to these people, so an activity addressed to one of them is
 * legal under invariant 3(b).
 *
 * Two commits, and it has to be two: "a recipient existing only in the proposing batch is
 * rejected" (§6.7) is a statement about pre-commit head, so a batch that records a roster
 * and emails it at once is refused. Which is the rule doing its job — you cannot email
 * somebody you have not yet looked up.
 */
export function rostered(names: readonly string[], ops: AuthoredOp[] = []): Graph {
  const planned = commit(emptyGraph(SCHEMA_VERSION), [
    task("Confirm roster", { outputs: [{ name: "availability", type: "string[]" }] }),
  ]);
  const evidenced = commit(planned, [
    {
      op: "record_output",
      activity: "confirm-roster",
      output_name: "availability",
      value: [...names],
      evidence_ref: "roster.csv#v3",
    },
  ]);
  return ops.length === 0 ? evidenced : commit(evidenced, ops);
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
