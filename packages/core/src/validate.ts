/**
 * `validate()` — the pre-commit gate. §7: "If only one suite gets written, write
 * `validate()`." A surviving mutant here is a bad graph reaching the file.
 *
 * The order is fixed and each stage may only assume the previous one passed:
 *
 *   1.  parse      shape, free, before any graph logic runs (§6.7)
 *   2.  authority  role-scoped write access (§6.7 concurrency #1)
 *   3.  normalize  `$N` resolved, ids minted (§6.4)
 *   3a. parser-class rules zod cannot express, because they need the graph: a condition on
 *       every wait out-edge, a parseable recipient ref, a closed predicate grammar
 *   4.  apply      the AUTHORED batch, against a clone of head -> the interim graph
 *   4a. refuse an edge this batch adds that is already dead
 *   5.  derive     branch resolution, ONCE, expanded into explicit ops (§6.4)
 *   6.  invariant 1  sequential op-delta, seeded from **pre-commit head**, over the expanded array
 *   7.  apply      the EXPANDED batch -> the graph the log will fold to
 *   8.  invariant 2  a transition guard over pre and post
 *
 * Stages 5 and 7 are why derivation lives here and not in `applyOps`: `fold` replays every
 * record through `applyOps`, so a cascade there would re-derive on every read, forever,
 * using whatever the code does that day. Deciding once and writing the decision down is the
 * same rule already settled for id minting.
 *
 * INVARIANT 3 IS NOT A STAGE HERE, and that is where its exit code comes from.
 *
 * Both halves are enforced, and both outside the invariant stages. 3(b) is stage 3a: the
 * recipient grammar AND the resolution against pre-commit head, which is parser-class work
 * — it asks whether a string names somebody the graph already knew, not whether a
 * transition is legal. 3(a) is enforced at `effect reserve`, because a budget is a ledger
 * and this function has never seen one; a check here would be advice the enforcement point
 * ignores, which is what it was until T3.4.
 *
 * So invariants 1 and 2 `violate()` and exit **4**, while invariant 3 `refuse()`s and exits
 * **1** with its own tokens — `UNEVIDENCED_RECIPIENT`, `EFFECT_BUDGET_EXHAUSTED`. §6.8 makes
 * the symbolic reason the API and the numeric code a coarse class, and the plugin's one
 * human gate keys on the token for exactly this reason. A shell that branches on `-eq 4`
 * alone will miss the fabricated-counterparty case, which is the one it most wants.
 */

import type { Actor, AuthoredOp, CommittedOp } from "./schema.ts";
import { AuthoredBatchSchema } from "./schema.ts";
import type { ZodIssue } from "zod";
import {
  type Edge,
  type Graph,
  type ActivityNode,
  inEdges,
  isEdgeDead,
  isActivityTerminal,
  isBehaviour,
  isNodeLive,
} from "./graph.ts";
import { applyOps } from "./apply.ts";
import { named, namedHere, namedIn } from "./named.ts";
import { normalizeBatch } from "./normalize.ts";
import { deriveReadiness, resolveBranches } from "./branch.ts";
import { evidencedKeys, isEvidencedRecipient } from "./evidence.ts";
import { MAX_ACTIVITY_ID_LENGTH, ACTIVITY_ID_PATTERN } from "./ids.ts";
import {
  type Verdict,
  NODE_ARITY,
  VERDICTS,
  DERIVED_STATUSES,
  isAbandoned,
  isDerivedStatus,
  isResolvingVerdict,
  isTerminal,
} from "./vocab.ts";
import { type Result, ok, refuse, violate } from "./result.ts";

/** §6.7 — only the orchestrator may change the shape of the graph. */
const TOPOLOGY_OPS = new Set(["add_node", "add_edge", "supersede_node"]);

function flattenIssues(issues: readonly ZodIssue[]): ZodIssue[] {
  return issues.flatMap((issue) =>
    issue.code === "invalid_union"
      ? issue.errors.flatMap((nested: ZodIssue[]) => flattenIssues(nested))
      : [issue],
  );
}

export function parseBatch(raw: unknown): Result<AuthoredOp[]> {
  const parsed = AuthoredBatchSchema.safeParse(raw);
  if (parsed.success) return ok(parsed.data);
  const issues = flattenIssues(parsed.error.issues);
  const opIndex = parsed.error.issues[0]?.path[0];
  return refuse(
    "MALFORMED_OPS",
    issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "),
    opIndex !== undefined && typeof opIndex === "number" ? { op_index: opIndex } : {},
  );
}

export function checkAuthority(actor: Actor, ops: readonly AuthoredOp[]): Result<null> {
  if (actor.kind !== "subagent") return ok(null);
  const index = ops.findIndex((op) => TOPOLOGY_OPS.has(op.op));
  if (index === -1) return ok(null);
  return refuse(
    "UNAUTHORIZED_ACTOR",
    `a subagent may not mutate topology; op ${index} is '${ops[index]?.op}'`,
    { op_index: index },
  );
}

/**
 * Invariant 1 — terminal & effect protection.
 *
 * A sequential **op-delta** predicate: protection starts with every node terminal at
 * **pre-commit head**, then follows terminal transitions through the batch. It is never a
 * post-state scan. The difference is the whole invariant. `{from: A, to: B}` means "B
 * requires A", so B's dependency edges point *into* B and survive B completing — a
 * post-state reading of "no blocking edge into a terminal activity" would reject every commit
 * from the first completed activity onward. Existing edges into terminal activities are untouched;
 * they record how the activity became reachable.
 */
export function checkInvariant1(pre: Graph, ops: readonly CommittedOp[]): Result<null> {
  // Grow this set in op order so a terminal transition cannot be followed by a reopen or a
  // newly introduced dependency in the same atomic batch.
  const terminal = new Set(
    [...pre.nodes.values()].filter(isActivityTerminal).map((activity) => activity.id),
  );

  // A compensation is an added activity declaring which executed activity it offsets. The
  // direction matters: the NEW activity compensates the OLD one, never the reverse.
  const compensatedInBatch = new Set(
    ops.flatMap((op) =>
      op.op === "add_node" && typeof op.spec.compensates === "string" ? [op.spec.compensates] : [],
    ),
  );

  for (const [index, op] of ops.entries()) {
    if (op.op === "add_edge" && terminal.has(op.to)) {
      return violate(
        1,
        "TERMINAL_ACTIVITY_PROTECTED",
        `cannot add a blocking edge into ${namedIn(pre, op.to)}, which is already terminal`,
        { activity: op.to, op_index: index },
      );
    }

    if (op.op === "set_status" && terminal.has(op.node)) {
      return violate(
        1,
        "TERMINAL_ACTIVITY_PROTECTED",
        `${namedIn(pre, op.node)} is terminal; only supersede_node, record_outcome and record_output may target it`,
        { activity: op.node, op_index: index },
      );
    }

    if (op.op === "supersede_node") {
      const activity = pre.nodes.get(op.node);
      if (
        activity !== undefined &&
        (activity.status?.effect_log.length ?? 0) > 0 &&
        !compensatedInBatch.has(op.node)
      ) {
        return violate(
          1,
          "UNCOMPENSATED_SUPERSEDE",
          `${namedIn(pre, op.node)} has already moved bytes; superseding it requires a compensation in the same batch`,
          { activity: op.node, op_index: index },
        );
      }
    }

    if (op.op === "set_status" && isTerminal(op.status)) terminal.add(op.node);
  }

  return ok(null);
}

// ---------------------------------------------------------------------------
// Parser-class refusals that zod cannot express (§6.7 "the parser first, free")
// ---------------------------------------------------------------------------

/**
 * A claim is exclusive, or it is only advice.
 *
 * `active` takes an activity off the frontier so nobody else picks it up — but CAS does not
 * enforce that, and it is worth being precise about why, because it looks like it should.
 * CAS rejects a commit written against a STALE head. A second agent reading AFTER the first
 * claim commits sees a perfectly current head, and its claim passes: measured, two claims on
 * one activity, both exit 0. The graph then cannot even say who holds it, because `evidence_ref`
 * lives in the op and not in the folded status.
 *
 * So the rule is a transition rule: **an unclaimed -> `active` is legal; `active` ->
 * `active` is not.** It `refuse()`s rather than `violate()`s — this is not a fourth
 * invariant, and the spec's three are three.
 *
 * Deliberately NOT extended to the other transitions out of `active`: recording an
 * outcome, finishing, superseding, and `resume`'s repair back to `inactive` all stay legal, or
 * a claimed activity could never be released by anybody.
 */
function checkClaimExclusivity(pre: Graph, ops: readonly CommittedOp[]): Result<null> {
  const types = new Map([...pre.nodes].map(([id, node]) => [id, node.type]));
  const states = new Map(
    [...pre.nodes].flatMap(([id, node]) =>
      node.status === undefined ? [] : [[id, node.status.state] as const],
    ),
  );

  for (const [index, op] of ops.entries()) {
    if (op.op === "add_node") {
      types.set(op.id, op.type);
      if (op.type === "action" || op.type === "accept_event") states.set(op.id, "inactive");
      continue;
    }
    if (op.op !== "set_status") continue;

    const current = states.get(op.node);
    if (op.status !== "active") {
      states.set(op.node, op.status);
      continue;
    }
    if (types.get(op.node) === "accept_event") {
      return refuse(
        "ACCEPT_EVENT_NOT_CLAIMABLE",
        `${namedHere(pre, ops, op.node)} is polled, not claimed`,
        { activity: op.node, op_index: index },
      );
    }
    if (current !== undefined && isTerminal(current)) continue;
    if (current === "active") {
      return refuse(
        "ALREADY_CLAIMED",
        `${namedHere(pre, ops, op.node)} is already active — somebody else claimed it and has not finished. ` +
          "Take another action from `kona next`, or run `kona resume` if you believe the holder is gone",
        { activity: op.node, op_index: index },
      );
    }
    if (current !== "ready") {
      return refuse(
        "NOT_READY",
        `${namedHere(pre, ops, op.node)} is '${current ?? "unknown"}'; only a ready action may become active`,
        { activity: op.node, op_index: index },
      );
    }
    states.set(op.node, "active");
  }
  return ok(null);
}

/**
 * §6.2 — "Every out-edge of a `wait` must carry a condition — otherwise an ignored or
 * timed-out wait clears a plain edge and a pivot fires unapproved."
 *
 * Asserted in three places and enforced in none until now. It cannot be a zod rule:
 * `add_edge` carries `from` as an id, never the source's type, which lives in head or in an
 * earlier `add_node` of the same batch. Branch resolution depends on it — an unconditioned
 * out-edge of a wait has no resolution to compare against, so it is neither taken nor
 * untaken, and the arm behind it would silently survive its own gate.
 */
/**
 * An edge this batch adds that is already dead against post-authored state.
 *
 * The complement of the seed restriction in `resolveBranches`: derivation reads only edges
 * that existed at head, so an edge born dead is never derived from and must be refused
 * instead. Refusing it here makes the outcome identical whether the killing ops arrived in
 * this batch or an earlier one — otherwise the same authored ops would produce a dropped
 * activity when committed together and a permanently unreachable one when split in two.
 *
 * It cannot become invariant 1's old state-predicate bug: it looks only at edges this batch
 * adds, so an unrelated later commit has nothing to test.
 */
function checkDeadOnArrivalEdge(interim: Graph, ops: readonly CommittedOp[]): Result<null> {
  for (const [index, op] of ops.entries()) {
    if (op.op !== "add_edge") continue;
    const edge: Edge = {
      from: op.from,
      to: op.to,
      ...(op.guard === undefined ? {} : { guard: op.guard }),
    };
    if (!isEdgeDead(interim, edge)) continue;
    const source = interim.nodes.get(op.from);
    const from = namedHere(interim, ops, op.from);
    const because =
      source?.status !== undefined && isAbandoned(source.status.state)
        ? `originates at ${from}, which is dropped`
        : `has a guard that ${from} has already resolved against`;
    return refuse(
      "DEAD_ON_ARRIVAL_EDGE",
      `edge ${from} -> ${namedHere(interim, ops, op.to)} ${because}; it can never fire`,
      { activity: op.to, op_index: index },
    );
  }
  return ok(null);
}

// ---------------------------------------------------------------------------
// Invariant 3(b) — effects are addressed (§6.7)
// ---------------------------------------------------------------------------

/**
 * §6.2 — `recipient_ref` is "a ref, never a literal address", shaped `<scope>#<key>`.
 *
 * Only the grammar ships in this slice. Resolving the ref to an evidenced entity needs an
 * `evidence_ref` the folded graph does not currently carry: `record_output` parses one and
 * `apply` discards it, so the only surviving evidence is an outcome's — which a first send
 * cannot have, because the evidence would be the reply to the send it is gating.
 *
 * The grammar alone is not nothing. At n=60 the mutator's fabrications were
 * `person:club-reserve/goalie-1` and `roster.bench[0..5]`; neither parses, while every
 * recipient in the repo does.
 */
const RECIPIENT_SCOPE = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$/;
const MAX_RECIPIENT_REF_LENGTH = 128;

export interface RecipientRef {
  scope: string;
  key: string;
}

export function parseRecipientRef(raw: string): RecipientRef | null {
  if (raw.length > MAX_RECIPIENT_REF_LENGTH) return null;
  const parts = raw.split("#");
  const [scope, key] = parts;
  if (parts.length !== 2 || scope === undefined || key === undefined) return null;
  if (!RECIPIENT_SCOPE.test(scope)) return null;
  if (key.length > MAX_ACTIVITY_ID_LENGTH || !ACTIVITY_ID_PATTERN.test(key)) return null;
  return { scope, key };
}

function checkRecipientRefs(pre: Graph, ops: readonly CommittedOp[]): Result<null> {
  // Built once, lazily: most batches add no effect activity at all, and walking every activity's
  // outputs and outcomes to prove nothing is the wrong price for the common case.
  let evidenced: Set<string> | null = null;

  for (const [index, op] of ops.entries()) {
    if (op.op !== "add_node" || op.spec.effect === undefined) continue;
    const raw = op.spec.effect.recipient_ref;
    const ref = parseRecipientRef(raw);
    if (ref !== null) {
      evidenced ??= evidencedKeys(pre);
      if (isEvidencedRecipient(ref, evidenced)) continue;
      // §6.9's ONE human gate, and it gets a token of its own. The plugin keys on this
      // alone to decide "route this to a human", so it must never share a reason with
      // "the model wrote a bad string".
      return refuse(
        "UNEVIDENCED_RECIPIENT",
        `nothing in the graph attests to '${ref.key}' (recipient_ref '${raw}'). ` +
          `A recipient must already be named by a recorded output that cited its source, or ` +
          `by an outcome's attrs — evidence that existed BEFORE this batch. At n=60 a mutator ` +
          `that could not satisfy a constraint invented counterparties and queued real email ` +
          `to them, passing every other check. Record where '${ref.key}' came from first, or ` +
          `ask a human.`,
        { activity: op.id, op_index: index },
      );
    }
    // A literal address gets its own reason. It is the one malformed shape that would
    // otherwise *work*, so telling the author "that is not a ref" beats "that is not valid".
    if (raw.includes("@")) {
      return refuse(
        "LITERAL_RECIPIENT_ADDRESS",
        `recipient_ref '${raw}' is a literal address; §6.2 requires a ref — '<scope>#<key>' ` +
          `— so the store can check who is being emailed against what the graph was told`,
        { activity: op.id, op_index: index },
      );
    }
    return refuse(
      "MALFORMED_RECIPIENT_REF",
      `recipient_ref '${raw}' on ${named(op)} is not a '<scope>#<key>' reference: expected ` +
        `exactly one '#', ` +
        `a dotted lowercase scope, and a key matching [a-z0-9][a-z0-9-]* of at most ` +
        `${MAX_ACTIVITY_ID_LENGTH} characters (§6.2, e.g. 'roster.contacts#dana')`,
      { activity: op.id, op_index: index },
    );
  }
  return ok(null);
}

// ---------------------------------------------------------------------------
// Invariant 2 — predicate-waits stay satisfiable (§6.7)
// ---------------------------------------------------------------------------

/**
 * §6.7's closed predicate grammar, one form:
 * `{"count": {"verdict":"confirmed","attrs":{"role":"goalie"}}, "op": ">=", "n": 1}`.
 * "Reads only `outcome.verdict` and `outcome.attrs`; no other names resolve."
 *
 * Parsed here rather than narrowed in `schema.ts` on purpose. `MutationRecordSchema` re-parses
 * every historical line on every fold, so tightening the committed shape is retroactive: a
 * predicate that no longer parses turns its record into `UNPARSEABLE_RECORD`, and because the
 * expected version is computed from the last *successful* record, one damaged mid-log line
 * cascades every following line into `VERSION_DISCONTINUITY` and the log is refused forever.
 */
export type PredicateAttrs = Record<string, string | number | boolean>;

export type { CountPredicate } from "./schema.ts";
import type { CountPredicate } from "./schema.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAttrs(value: unknown): PredicateAttrs | null {
  if (!isPlainObject(value)) return null;
  // `Object.create(null)`: a key of `__proto__` on a plain object literal hits the prototype
  // setter and is silently discarded, which would make the committed predicate stricter than
  // the one the counter actually enforces.
  const attrs: PredicateAttrs = Object.create(null) as PredicateAttrs;
  for (const [key, entry] of Object.entries(value)) {
    // Primitives only. A nested matcher would need a comparison semantics the spec does not
    // give, and widening later is safe where narrowing later is not.
    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
      return null;
    }
    attrs[key] = entry;
  }
  return attrs;
}

export function parseCountPredicate(value: unknown): CountPredicate | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value).toSorted();
  if (JSON.stringify(keys) !== JSON.stringify(["count", "n", "op"])) return null;
  if (value["op"] !== ">=") return null;
  const n = value["n"];
  // `n: 0` is satisfied by the empty population, so it is a wait that resolves nothing.
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return null;

  const count = value["count"];
  if (!isPlainObject(count)) return null;
  const countKeys = Object.keys(count).toSorted();
  if (countKeys.length > 2 || (countKeys[0] !== "attrs" && countKeys[0] !== "verdict")) return null;
  if (countKeys.some((key) => key !== "attrs" && key !== "verdict")) return null;

  const verdict = count["verdict"];
  // Membership first: `isResolvingVerdict` only tests the two-name exclusion list, so it
  // says `true` for any string that is not `tentative` or `late` — including `"maybe"`.
  if (typeof verdict !== "string" || !(VERDICTS as readonly string[]).includes(verdict)) {
    return null;
  }
  // Counting a non-resolving verdict is meaningless: `status.outcome` is by construction the
  // first RESOLVING entry, so `tentative` and `late` can never appear there.
  if (!isResolvingVerdict(verdict as Verdict)) return null;

  if (count["attrs"] === undefined) return { count: { verdict: verdict as Verdict }, op: ">=", n };
  const attrs = parseAttrs(count["attrs"]);
  if (attrs === null) return null;
  return { count: { verdict: verdict as Verdict, attrs }, op: ">=", n };
}

/** The parseable predicate arms of a wait. §6.5's `conditions` is an or-group. */
function predicateArms(activity: ActivityNode): CountPredicate[] {
  if (activity.type !== "accept_event" || activity.spec.match.kind !== "predicate") return [];
  return activity.spec.match.conditions.flatMap((condition) => {
    const parsed = parseCountPredicate(condition.predicate);
    return parsed === null ? [] : [parsed];
  });
}

function checkPredicateGrammar(ops: readonly CommittedOp[]): Result<null> {
  for (const [index, op] of ops.entries()) {
    if (op.op !== "add_node" || op.type !== "accept_event") continue;
    if (op.spec.match?.kind !== "predicate") continue;
    if (!op.spec.match.conditions.some((condition) => condition.predicate !== undefined)) {
      return refuse(
        "MISSING_PREDICATE",
        `${named(op)} declares match.kind 'predicate' but carries no predicate; nothing would ` +
          `ever count against it, and invariant 2 could never judge it (§6.7)`,
        { activity: op.id, op_index: index },
      );
    }
    for (const condition of op.spec.match.conditions) {
      if (condition.predicate === undefined) continue;
      if (parseCountPredicate(condition.predicate) !== null) continue;
      return refuse(
        "MALFORMED_PREDICATE",
        `predicate on ${named(op)} is not the §6.7 form ` +
          `{"count":{"verdict":…,"attrs":…},"op":">=","n":…}: 'op' must be '>=', 'n' an ` +
          `integer of at least 1, 'verdict' a resolving verdict, and 'attrs' flat primitives`,
        { activity: op.id, op_index: index },
      );
    }
  }
  return ok(null);
}

export interface PredicateCount {
  /** Distinct sources of the wait's blocking in-edges (§6.7). */
  population: number;
  /** Of those, abandoned — §6.4 excludes them: they neither satisfy nor block. */
  excluded: number;
  matching_confirmed: number;
  still_live: number;
  n: number;
  satisfiable: boolean;
}

function attrsMatch(recorded: Record<string, unknown> | undefined, want: PredicateAttrs): boolean {
  // Subset match: the recorded outcome may carry more than the predicate asks about.
  return Object.entries(want).every(([key, value]) => recorded?.[key] === value);
}

/**
 * §6.7 — `satisfiable iff matching_confirmed + still_live >= n`.
 *
 * Exported because a rejection is the worst way to learn this: `kona graph --json` and the
 * authoring skill both need to show an author how close a predicate is *before* they commit.
 */
export function countPredicate(
  graph: Graph,
  wait: ActivityNode,
  predicate: CountPredicate,
): PredicateCount {
  // Deduped by source: `add_edge` refuses only an identical {from,to,condition} triple, so
  // one member wired both bare and conditioned is two legal edges and one member.
  const pending = inEdges(graph, wait.id).map((edge) => edge.from);
  const seen = new Set<string>();
  const members = [];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const node = graph.nodes.get(id);
    if (node === undefined) continue;
    if (isBehaviour(node)) members.push(node);
    else pending.push(...inEdges(graph, node.id).map((edge) => edge.from));
  }

  let excluded = 0;
  let matching = 0;
  let live = 0;
  for (const member of members) {
    if (isAbandoned(member.status.state)) {
      excluded += 1;
      continue;
    }
    const outcome = member.status.outcome;
    if (outcome !== null) {
      // Reads `outcome.verdict` and `outcome.attrs` only — never `state`. A member that
      // recorded its verdict at v10 and its status at v11 must not be uncounted in between.
      if (
        outcome.verdict === predicate.count.verdict &&
        attrsMatch(outcome.attrs, predicate.count.attrs ?? {})
      ) {
        matching += 1;
      }
      continue;
    }
    // Unresolved. `ready` and `active` are live (§6.2: the world's answer is unknown, not
    // absent), and so is `completed`-without-a-verdict, because `set_status` then `record_outcome`
    // across two commits is legal and that window must not be a rejection window. `failed`
    // is not: it tried and did not work, and nothing further will arrive.
    if (!isActivityTerminal(member) || member.status.state === "completed") live += 1;
  }

  return {
    population: members.length,
    excluded,
    matching_confirmed: matching,
    still_live: live,
    n: predicate.n,
    satisfiable: matching + live >= predicate.n,
  };
}

function satisfiableAt(graph: Graph, waitId: string): boolean {
  const activity = graph.nodes.get(waitId);
  if (activity === undefined) return true;
  const arms = predicateArms(activity);
  // Nothing parseable to judge, or an or-group with one satisfiable arm (§6.5 first-wins).
  return arms.length === 0 || arms.some((arm) => countPredicate(graph, activity, arm).satisfiable);
}

/**
 * A batch nobody chose: `kona resume` firing an overdue timeout, or a bounce landing. Its
 * author is the store, which has no model to re-plan with, so refusing it would demand a
 * repair nothing in the loop can write.
 *
 * `set_status` to `completed` counts, and it has to: resume writes the verdict and the status
 * in ONE batch — `record_outcome(timed_out)` plus `set_status(completed)` — because an
 * accept-event must be terminal for its decision's timeout arm to fire. It is also safe by construction, since
 * `completed` cannot reduce satisfiability: a `completed` member with no outcome is still live,
 * and one with an outcome was already counted by that outcome. `terminated` is deliberately
 * absent — an author abandoning a member is a choice, and the store's own drops are matched
 * structurally.
 */
function isMechanicalClosure(op: CommittedOp, derived: ReadonlySet<CommittedOp>): boolean {
  if (derived.has(op)) return true;
  if (op.op === "record_outcome") return op.verdict === "timed_out" || op.verdict === "bounced";
  if (op.op === "set_status") return op.status === "failed" || op.status === "completed";
  return false;
}

/**
 * Invariant 2 — predicate-waits stay satisfiable.
 *
 * A **transition guard**, not a state predicate: no single commit may be the thing that
 * breaks a still-open predicate-wait without repairing it in the same commit. A plain state
 * scan would repeat invariant 1's original bug in a worse form — a wait already unsatisfiable
 * at head would refuse every unrelated commit forever, leaving the pursuit no legal move.
 *
 * It never refuses to record a *fact*; it refuses to record a fact **without its
 * consequence**, and only from an actor that can author the consequence. A subagent may not
 * write topology at all, so every remedy the message names is illegal for one — and the store
 * itself, firing a timeout with no model in the loop, is in the same position.
 */
export function checkInvariant2(
  pre: Graph,
  post: Graph,
  actor: Actor,
  ops: readonly CommittedOp[],
  derivedOps: readonly CommittedOp[] = [],
): Result<null> {
  if (actor.kind === "subagent") return ok(null);
  // Identity by REFERENCE, never by reading the evidence_ref: `set_status.evidence_ref` is
  // author-controlled free text, so sniffing the prefix would let a mutator stamp
  // "derived:branch-resolution:..." on its own drop and buy the whole-batch exemption.
  const derived = new Set(derivedOps);
  if (ops.every((op) => isMechanicalClosure(op, derived))) return ok(null);

  for (const wait of pre.nodes.values()) {
    if (isActivityTerminal(wait)) continue;
    // Terminal by the END of this batch — including when the store's own cascade dropped it.
    // A closed wait is not a broken one, and demanding a repair for it would leave `resume`
    // no legal batch at all.
    const after = post.nodes.get(wait.id);
    if (after !== undefined && isActivityTerminal(after)) continue;
    if (wait.status?.outcome != null) continue;
    if (!isNodeLive(wait)) continue;
    const [arm] = predicateArms(wait);
    if (arm === undefined) continue;

    if (satisfiableAt(post, wait.id)) continue;
    // Already broken at head: this batch is not the cause, and refusing it would wedge the
    // pursuit rather than repair anything.
    if (!satisfiableAt(pre, wait.id)) continue;
    // Closing the wait outright is a legitimate answer to "it can no longer be met".
    // Open-ness is read from `pre` deliberately, so a batch cannot exempt itself by
    // hand-recording a satisfying verdict on the wait it just broke.
    if (
      ops.some(
        (op) =>
          (op.op === "supersede_node" && op.node === wait.id) ||
          (op.op === "record_outcome" &&
            op.node === wait.id &&
            (op.verdict === "timed_out" || op.verdict === "bounced")),
      )
    ) {
      continue;
    }

    const counted = countPredicate(post, wait, arm);
    const killed = derivedOps.flatMap((op) => (op.op === "set_status" ? [op.node] : []));
    return violate(
      2,
      "PREDICATE_UNSATISFIABLE",
      `${named(wait)} can no longer reach ${arm.n} '${arm.count.verdict}': ` +
        `${counted.matching_confirmed} matching + ${counted.still_live} still live of ` +
        `${counted.population} blocking in-edges (${counted.excluded} dropped)` +
        (killed.length > 0
          ? `; branch resolution dropped ${killed.map((id) => namedIn(pre, id)).join(", ")}`
          : "") +
        `; add a live member in this batch, or supersede the accept_event`,
      { activity: wait.id },
    );
  }

  return ok(null);
}

export interface ValidateInput {
  /** Pre-commit head. Never mutated. */
  graph: Graph;
  /** Raw authored ops, straight off disk. Unparsed on purpose — stage 1 is the parser. */
  ops: unknown;
  actor: Actor;
  /** The version this batch would commit as. */
  version: number;
  /** The pursuit's id prefix, read off the genesis record. */
  prefix: string;
}

export interface ValidateOutput {
  /**
   * Refs resolved, ids minted, **branch resolution expanded**. This is what gets written to
   * the log — authored ops first, in their authored positions, derived ops appended.
   */
  ops: CommittedOp[];
  /** Post-commit graph, for previewing a mutation without writing it. */
  graph: Graph;
  /** The subset of `ops` the store derived (§6.4). Always a suffix of `ops`. */
  derived: CommittedOp[];
  /**
   * Activities on an untaken branch the store refused to rewrite — `active`, or bytes already
   * moved. Not a rejection: the commit stands and each of these is a human's decision.
   */
  withheld: string[];
}

// ---------------------------------------------------------------------------
// S1-S7 — structure, in two tiers
// ---------------------------------------------------------------------------

/**
 * The LIVE subgraph (D5): superseded nodes, and edges with a superseded endpoint, are
 * invisible to every rule below.
 *
 * This is not tidiness — it is what makes the graph growable. `action` is 1-in/1-out, S2
 * demands every node reach a terminator, and there is no edge-removal op and never will be.
 * So extending a branch that already ends means superseding its terminator, adding the work,
 * and adding a new one. Without this rule that batch is refused and the only way to grow a
 * plan would be a seventh op.
 */
function liveSubgraph(graph: Graph): { nodes: ActivityNode[]; edges: Edge[] } {
  const nodes = [...graph.nodes.values()].filter(isNodeLive);
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, edges: graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
}

/**
 * Tier 2 — local shape. Refuses (exit 1): the author wrote an op wrong.
 *
 * Every rule here is a property of one node or one edge and its immediate neighbours, which is
 * what separates it from the whole-graph tier below. S4 is the one that matters most: it is
 * §6.2's "every out-edge of a wait must carry a condition, otherwise an ignored or timed-out
 * wait clears a plain edge and a pivot fires unapproved" — turned from a rule you can forget
 * to check into a shape the graph cannot hold.
 */
/**
 * §6.2.1 — `ready` and `withdrawn` are the store's to write, and an author may not assert them.
 *
 * Both are statements the GRAPH makes: one says every dependency is satisfied, the other says
 * the flow went elsewhere. An agent asserting either is asserting a fact it has not checked,
 * and the store would then hold two answers to one question — which is the housekeeping
 * problem §6.4 was written to remove, reappearing one vocabulary down.
 *
 * Checked against the AUTHORED batch only. The derived ops are appended after this runs, which
 * is exactly what makes the distinction cheap: provenance is position.
 */
function checkAuthoredStatus(ops: readonly CommittedOp[]): Result<null> {
  for (const [index, op] of ops.entries()) {
    if (op.op !== "set_status" || !isDerivedStatus(op.status)) continue;
    return refuse(
      "DERIVED_STATUS",
      `'${op.status}' is derived by the store and may not be authored — ${DERIVED_STATUSES.join(" and ")} are the store's to write`,
      { activity: op.node, op_index: index },
    );
  }
  return ok(null);
}

function outOfBounds(
  count: number,
  [min, max]: readonly [number, number | null],
  side: string,
): string | null {
  const plural = (n: number) => `${n} ${side}-edge${n === 1 ? "" : "s"}`;
  if (count < min) return `needs at least ${plural(min)}, and has ${count}`;
  if (max !== null && count > max) return `takes at most ${plural(max)}, and has ${count}`;
  return null;
}

function checkStructure(graph: Graph): Result<null> {
  const { nodes, edges } = liveSubgraph(graph);

  for (const node of nodes) {
    const arity = NODE_ARITY[node.type];
    const ins = edges.filter((e) => e.to === node.id).length;
    const outs = edges.filter((e) => e.from === node.id).length;

    const problem = outOfBounds(ins, arity.in, "in") ?? outOfBounds(outs, arity.out, "out");
    if (problem !== null) {
      return refuse("ARITY", `a ${node.type} ${problem} — ${named(node)}`, { activity: node.id });
    }

    // S3 — a decision must be able to route whatever arrives, so every arm is guarded and
    // exactly one is the fallback. Without the fallback a resolution nobody anticipated
    // silently stops the flow, which is the hang this whole model exists to make impossible.
    if (node.type === "decision") {
      const outEdges = edges.filter((e) => e.from === node.id);
      const unguarded = outEdges.filter((e) => e.guard === undefined);
      if (unguarded.length > 0) {
        return refuse(
          "NO_ELSE_ARM",
          `${named(node)} has an unguarded arm — every decision edge must carry a guard (S3)`,
          {
            activity: node.id,
          },
        );
      }
      const elseArms = outEdges.filter((e) => e.guard === "else");
      if (elseArms.length === 0) {
        return refuse("NO_ELSE_ARM", `${named(node)} has no explicit else arm (S3)`, {
          activity: node.id,
        });
      }
      if (elseArms.length > 1) {
        return refuse(
          "AMBIGUOUS_ELSE",
          `${named(node)} has ${elseArms.length} else arms; exactly one is allowed (S3)`,
          { activity: node.id },
        );
      }
    }

    // S4 — a wait may not fire anything directly. Its one out-edge goes to a decision, so the
    // resolution is always routed by a visible guard.
    if (node.type === "accept_event") {
      for (const edge of edges.filter((e) => e.from === node.id)) {
        const target = graph.nodes.get(edge.to);
        if (target?.type !== "decision") {
          return refuse(
            "WAIT_MUST_ROUTE",
            `${named(node)} routes to ${namedIn(graph, edge.to)}, which is not a decision — a wait's resolution must be routed by a guard (S4)`,
            { activity: node.id },
          );
        }
      }
    }
  }

  // S5 — a guard is how a decision chooses. Anywhere else it is a second, invisible branch
  // point, which is the thing §3 says this redesign exists to remove.
  for (const edge of edges) {
    if (edge.guard === undefined) continue;
    const source = graph.nodes.get(edge.from);
    if (source === undefined || source.type === "decision") continue;
    return refuse(
      "GUARD_OUTSIDE_DECISION",
      `the edge from ${named(source)} carries a guard, and only a decision's out-edges may (S5)`,
      { activity: source.id },
    );
  }

  for (const edge of edges) {
    if (edge.guard === undefined || edge.guard === "else" || !("count" in edge.guard)) continue;
    if (parseCountPredicate(edge.guard) !== null) continue;
    return refuse(
      "MALFORMED_PREDICATE",
      `predicate guard from ${namedIn(graph, edge.from)} is invalid`,
      {
        activity: edge.from,
      },
    );
  }

  for (const node of nodes) {
    if (node.type !== "accept_event" || !("after" in node.spec.deadline)) continue;
    const anchor = graph.nodes.get(node.spec.deadline.after);
    if (anchor !== undefined && isBehaviour(anchor)) continue;
    return refuse("DEADLINE_ANCHOR", `${named(node)} anchors its deadline to a control node`, {
      activity: node.id,
    });
  }

  return ok(null);
}

/**
 * Tier 3 — whole-graph shape. Violates (exit 4): the graph this batch would make is unsound.
 *
 * S1 and S2 are what make the orphan and the dead end DECIDABLE, which `prd.md` §15 R4 had to
 * concede was "a logged judgment call". Without an initial node there is no definition of
 * reachable; without a terminator there is none of terminating.
 */
/** Everything walkable from `from` along `next`, `from` included. */
function reach(from: string, next: Map<string, string[]>): Set<string> {
  const seen = new Set<string>([from]);
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) continue;
    for (const to of next.get(id) ?? []) {
      if (!seen.has(to)) {
        seen.add(to);
        stack.push(to);
      }
    }
  }
  return seen;
}

function checkGraphShape(graph: Graph): Result<null> {
  const { nodes, edges } = liveSubgraph(graph);
  const initials = nodes.filter((n) => n.type === "initial");
  if (initials.length !== 1) {
    return violate(
      undefined,
      "INITIAL_NODE",
      `an activity has exactly one initial node, and this one has ${initials.length} (S1)`,
    );
  }

  const out = new Map<string, string[]>();
  const into = new Map<string, string[]>();
  for (const edge of edges) {
    out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to]);
    into.set(edge.to, [...(into.get(edge.to) ?? []), edge.from]);
  }

  const startId = initials[0]?.id ?? "";
  const reachable = reach(startId, out);
  const orphan = nodes.find((n) => !reachable.has(n.id));
  if (orphan !== undefined) {
    return violate(
      undefined,
      "UNREACHABLE_NODE",
      `${named(orphan)} is not reachable from the initial node (S1)`,
      {
        activity: orphan.id,
      },
    );
  }

  const terminators = nodes.filter((n) => n.type === "final" || n.type === "flow_final");
  const grounded = new Set<string>();
  for (const terminator of terminators)
    for (const id of reach(terminator.id, into)) grounded.add(id);
  const deadEnd = nodes.find((n) => !grounded.has(n.id));
  if (deadEnd !== undefined) {
    return violate(undefined, "DEAD_END", `${named(deadEnd)} reaches no final or flow_final (S2)`, {
      activity: deadEnd.id,
    });
  }

  // S6 — the subset is acyclic. Iteration is expressed by ADDING nodes, not by routing
  // backwards: we do not loop, we grow. A cycle would also make S2 vacuously satisfiable.
  const cycle = firstCycle(nodes, out);
  if (cycle !== null) {
    return violate(
      undefined,
      "CYCLE",
      `${namedIn(graph, cycle)} is on a cycle, and the subset is acyclic (S6)`,
      {
        activity: cycle,
      },
    );
  }

  return ok(null);
}

/** The first node found on a cycle, by colouring depth-first. */
function firstCycle(nodes: readonly ActivityNode[], out: Map<string, string[]>): string | null {
  const state = new Map<string, "open" | "closed">();
  const walk = (id: string): string | null => {
    const mark = state.get(id);
    if (mark === "open") return id;
    if (mark === "closed") return null;
    state.set(id, "open");
    for (const to of out.get(id) ?? []) {
      const found = walk(to);
      if (found !== null) return found;
    }
    state.set(id, "closed");
    return null;
  };
  for (const node of nodes) {
    const found = walk(node.id);
    if (found !== null) return found;
  }
  return null;
}

export function validate(input: ValidateInput): Result<ValidateOutput> {
  const parsed = parseBatch(input.ops);
  if (!parsed.ok) return parsed;

  const authorized = checkAuthority(input.actor, parsed.value);
  if (!authorized.ok) return authorized;

  const normalized = normalizeBatch(input.graph, parsed.value, input.prefix, input.version);
  if (!normalized.ok) return normalized;

  // Parser-class, but graph-dependent, so it cannot live in zod: `add_edge` carries `from`
  // as an id and never the source's type, which is in head or in an earlier op of this batch.
  const authoredStatus = checkAuthoredStatus(normalized.value);
  if (!authoredStatus.ok) return authoredStatus;

  const claims = checkClaimExclusivity(input.graph, normalized.value);
  if (!claims.ok) return claims;

  const recipients = checkRecipientRefs(input.graph, normalized.value);
  if (!recipients.ok) return recipients;

  const predicates = checkPredicateGrammar(normalized.value);
  if (!predicates.ok) return predicates;

  // Apply the AUTHORED batch. This interim graph is what makes the resolution visible —
  // a wait resolves inside the batch, so the drop set is not derivable from head alone.
  const interim = applyOps(input.graph, normalized.value, input.version);
  if (!interim.ok) return interim;

  // An edge this batch introduces already dead is refused, never derived from: derivation
  // reads only pre-existing edges, so refusing here is what keeps the outcome the same
  // whether the killing ops arrived in this batch or an earlier one.
  const arrivals = checkDeadOnArrivalEdge(interim.value, normalized.value);
  if (!arrivals.ok) return arrivals;

  // Tier 2 — local shape, against the graph this batch would make. Refuses (exit 1).
  const structure = checkStructure(interim.value);
  if (!structure.ok) return structure;

  // §6.4 — derive ONCE, here, and expand into explicit ops. `fold` stays a dumb replay.
  const resolution = resolveBranches(input.graph, interim.value);
  const routed = [...normalized.value, ...resolution.drops];

  // §6.2.1 — readiness, SECOND. A node on an arm this commit just withdrew must not be lifted
  // to `ready` and corrected after; the intermediate op would say the store offered work on a
  // branch nobody took. So routing settles first, and readiness reads the graph it produced.
  const withdrawn = applyOps(input.graph, routed, input.version);
  if (!withdrawn.ok) return withdrawn;

  // Held in a named binding rather than inlined, because these ops are DERIVED and every
  // consumer that distinguishes authored from derived has to be told so. Inlining them cost
  // exactly that: invariant 2's mechanical-closure exemption asks whether every op in the
  // batch is either a closure or store-derived, and a readiness op that was in `ops` but not
  // in `derived` failed the test — so any mechanical batch that ALSO unblocked a node lost
  // its exemption. `kona resume` then wrote a batch its own validator refused, with a message
  // demanding a repair resume cannot author. There is no model in that loop to notice.
  const readiness = deriveReadiness(withdrawn.value);
  const derived = [...resolution.drops, ...readiness];
  const ops = [...routed, ...readiness];

  // Over the EXPANDED array. Derived ops are `set_status` against activities non-terminal in the
  // interim graph, so they cannot trip the terminal clause themselves; and because authored
  // ops keep indices 0..n-1 and the loop returns the first violation, a reported `op_index`
  // still points at something the author actually wrote.
  const invariant1 = checkInvariant1(input.graph, ops);
  if (!invariant1.ok) return invariant1;

  // The graph the log will fold to: byte-for-byte the call `fold` will make on this record.
  const applied = applyOps(input.graph, ops, input.version);
  if (!applied.ok) return applied;

  const invariant2 = checkInvariant2(input.graph, applied.value, input.actor, ops, derived);
  if (!invariant2.ok) return invariant2;

  // Tier 3 — whole-graph shape, against the graph the log will fold to. Violates (exit 4).
  const shape = checkGraphShape(applied.value);
  if (!shape.ok) return shape;

  return ok({
    ops,
    graph: applied.value,
    derived,
    withheld: resolution.withheld,
  });
}
