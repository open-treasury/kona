/** Shared builders. Every fixture is a *legal* value; tests break exactly one thing. */

import type {
  Actor,
  AuthoredOp,
  BehaviourNode,
  Graph,
  MutationRecord,
  ActivityNode,
  Result,
  ValidateInput,
  ValidateOutput,
} from "../src/index.ts";
import {
  SCHEMA_VERSION,
  applyOps,
  checkAuthority,
  checkInvariant1,
  checkInvariant2,
  deriveReadiness,
  emptyGraph,
  normalizeBatch,
  parseBatch,
  resolveBranches,
  slugify,
  validate,
} from "../src/index.ts";

export const ORCHESTRATOR: Actor = { kind: "orchestrator", id: "run-1" };
export const SUBAGENT: Actor = { kind: "subagent", id: "exec-3" };

export function action(name: string, extra: Record<string, unknown> = {}): AuthoredOp {
  return {
    op: "add_node",
    name,
    type: "action",
    spec: {
      instruction: `do: ${name}`,
      inputs: [],
      outputs: [{ name: "reply", type: "string" }],
      effect_class: "pure",
      ...extra,
    },
  } as unknown as AuthoredOp;
}

export function acceptEvent(name: string, extra: Record<string, unknown> = {}): AuthoredOp {
  return {
    op: "add_node",
    name,
    type: "accept_event",
    spec: {
      instruction: `await: ${name}`,
      inputs: [],
      outputs: [],
      effect_class: "pure",
      deadline: { at: "2026-08-22T17:00:00.000Z" },
      match: { kind: "event", conditions: [{ kind: "reply", on: "satisfied" }], memory: true },
      ...extra,
    },
  } as unknown as AuthoredOp;
}

/**
 * Ids are hashes now, and a test that named one literally would be asserting a magic string.
 *
 * Every fixture still builds activities from names, so the name is the stable handle — and the
 * id a name *used* to mint is exactly `slugify(name)`. These two functions translate that
 * old slug into whatever the store actually minted, which keeps the tests reading in the
 * vocabulary they were written in: `activityAt(graph, "a")`, not `graph.nodes.get("t-9x4k")`.
 */
export function nid(graph: Graph, slug: string): string {
  for (const [id, activity] of graph.nodes) if (slugify(activity.name) === slug) return id;
  throw new Error(`no activity in the graph whose name slugs to "${slug}"`);
}

/**
 * `nid`, but returns the input unchanged when nothing matches.
 *
 * Tests that probe the not-found path pass a deliberately absent id ("ghost"), and those have
 * to reach the code under test rather than die in the fixture.
 */
export function slugOr(graph: Graph, slug: string): string {
  for (const [id, activity] of graph.nodes) if (slugify(activity.name) === slug) return id;
  return slug;
}

/** Drop-in for `graph.nodes.get(slug)`, including its `undefined` for an absent activity. */
/**
 * The node a test means, narrowed to one that carries a status.
 *
 * Almost every assertion in this suite is about work — a status, an outcome, an output — and
 * under the discriminated union (D6) a bare `ActivityNode` has none of those until the family
 * is settled. Throwing here rather than optional-chaining is deliberate: a test that reaches
 * for a status on a control node has asked the wrong question, and `?.` would let it quietly
 * assert `undefined === undefined` and pass.
 */
export function workedAt(graph: Graph, slug: string): BehaviourNode {
  const node = activityAt(graph, slug);
  if (node === undefined) throw new Error(`no node in the graph whose name slugs to "${slug}"`);
  if (node.status === undefined) {
    throw new Error(`"${slug}" is a ${node.type}: a control node carries no status`);
  }
  return node;
}

export function activityAt(graph: Graph, slug: string): ActivityNode | undefined {
  for (const [, activity] of graph.nodes) if (slugify(activity.name) === slug) return activity;
  return undefined;
}

/**
 * Rewrite the slug references in a batch into the ids the store minted.
 *
 * Fixtures name activities the way the tests do — `{op:"set_status", node:"a"}` — and with slug ids
 * that string WAS the id. It no longer is. Resolving here rather than at 168 call sites keeps
 * the change to the id format out of tests that are not about ids, and leaves each test saying
 * what it meant: "the activity named A".
 *
 * `$N` refs are left alone; they are batch-local and the normalizer owns them. A string that
 * is already a real id is left alone too, so a test that deliberately passes a minted id — or
 * a deliberately unresolvable one, checking the refusal — still does exactly that.
 */
export function resolveSlugs(graph: Graph, ops: unknown): unknown {
  // Malformed batches are the parser's business, not this helper's.
  if (!Array.isArray(ops)) return ops;
  const resolve = (value: unknown): unknown => {
    if (typeof value !== "string" || value.startsWith("$") || graph.nodes.has(value)) return value;
    for (const [id, activity] of graph.nodes) if (slugify(activity.name) === value) return id;
    return value;
  };
  // An activity's spec carries ids too — the timeout arm, what it compensates, the acceptEvent an
  // obviation watches, and the `activity.output` on the left of every input ref.
  const resolveSpec = (spec: unknown): unknown => {
    if (spec === null || typeof spec !== "object") return spec;
    const draft: Record<string, unknown> = { ...(spec as Record<string, unknown>) };
    for (const field of ["compensates"]) {
      if (field in draft) draft[field] = resolve(draft[field]);
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
    for (const field of ["node", "from", "to", "by"]) {
      if (field in draft) draft[field] = resolve(draft[field]);
    }
    if ("spec" in draft) draft["spec"] = resolveSpec(draft["spec"]);
    out.push(draft as AuthoredOp);
  }
  return out;
}

/**
 * Every id the fixtures have ever minted, mapped back to its name's slug.
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
  for (const field of ["node", "from", "to", "by"]) {
    if (field in draft) draft[field] = slugOf(draft[field] as string);
  }
  return draft;
}

function remember(graph: Graph): Graph {
  for (const [id, activity] of graph.nodes) MINTED.set(id, slugify(activity.name));
  return graph;
}

/** Commit a batch and return the resulting graph, failing loudly if it was rejected. */
export function commit(graph: Graph, ops: AuthoredOp[], actor: Actor = ORCHESTRATOR): Graph {
  const result = validateFragment({
    graph,
    ops: resolveSlugs(graph, ops),
    actor,
    version: graph.version + 1,
    prefix: "t",
  });
  if (!result.ok) throw new Error(`fixture batch was rejected: ${result.rejection.message}`);
  return remember(result.value.graph);
}

/** Keep old focused unit fragments out of production validation without weakening `validate`. */
export function validateFragment(input: ValidateInput): Result<ValidateOutput> {
  const checked = validate(input);
  if (
    checked.ok ||
    ![
      "ARITY",
      "INITIAL_NODE",
      "UNREACHABLE_NODE",
      "DEAD_END",
      "CYCLE",
      "WAIT_MUST_ROUTE",
      "NO_ELSE_ARM",
      "AMBIGUOUS_ELSE",
      "GUARD_OUTSIDE_DECISION",
    ].includes(checked.rejection.reason)
  )
    return checked;

  const parsed = parseBatch(input.ops);
  if (!parsed.ok) return parsed;
  const authority = checkAuthority(input.actor, parsed.value);
  if (!authority.ok) return authority;
  const normalized = normalizeBatch(input.graph, parsed.value, input.prefix, input.version);
  if (!normalized.ok) return normalized;
  const interim = applyOps(input.graph, normalized.value, input.version);
  if (!interim.ok) return interim;
  const resolution = resolveBranches(input.graph, interim.value);
  const routed = [...normalized.value, ...resolution.drops];
  const withdrawn = applyOps(input.graph, routed, input.version);
  if (!withdrawn.ok) return withdrawn;
  const readiness = deriveReadiness(withdrawn.value);
  const ops = [...routed, ...readiness];
  const invariant1 = checkInvariant1(input.graph, ops);
  if (!invariant1.ok) return invariant1;
  const applied = applyOps(input.graph, ops, input.version);
  if (!applied.ok) return applied;
  const derived = [...resolution.drops, ...readiness];
  const invariant2 = checkInvariant2(input.graph, applied.value, input.actor, ops, derived);
  if (!invariant2.ok) return invariant2;
  return { ok: true, value: { ops, graph: applied.value, derived, withheld: resolution.withheld } };
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
    action("Confirm roster", { outputs: [{ name: "availability", type: "string[]" }] }),
  ]);
  const evidenced = commit(planned, [
    {
      op: "record_output",
      node: "confirm-roster",
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
