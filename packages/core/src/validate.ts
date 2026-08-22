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
 *   6.  invariant 1  op-delta against **pre-commit head**, over the expanded array
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
import {
  type Edge,
  type Graph,
  type Node,
  inEdges,
  isEdgeDead,
  isNodeTerminal,
} from "./graph.ts";
import { applyOps } from "./apply.ts";
import { normalizeBatch } from "./normalize.ts";
import { resolveBranches } from "./branch.ts";
import { evidencedKeys, isEvidencedRecipient } from "./evidence.ts";
import { MAX_NODE_ID_LENGTH, NODE_ID_PATTERN } from "./ids.ts";
import { type Verdict, VERDICTS, isResolvingVerdict } from "./vocab.ts";
import { type Result, ok, refuse, violate } from "./result.ts";

/** §6.7 — only the orchestrator may change the shape of the graph. */
const TOPOLOGY_OPS = new Set(["add_node", "add_edge", "supersede_node"]);

export function parseBatch(raw: unknown): Result<AuthoredOp[]> {
  const parsed = AuthoredBatchSchema.safeParse(raw);
  if (parsed.success) return ok(parsed.data);
  const first = parsed.error.issues[0];
  return refuse(
    "MALFORMED_OPS",
    parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; "),
    first?.path[0] !== undefined && typeof first.path[0] === "number"
      ? { op_index: first.path[0] }
      : {},
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
 * An **op-delta** predicate: each op is tested against **pre-commit head**, never against
 * post-commit state. The difference is the whole invariant. `{from: A, to: B}` means "B
 * requires A", so B's dependency edges point *into* B and survive B completing — a
 * post-state reading of "no blocking edge into a terminal node" would reject every commit
 * from the first completed node onward. Existing edges into terminal nodes are untouched;
 * they record how the node became reachable.
 */
export function checkInvariant1(pre: Graph, ops: readonly CommittedOp[]): Result<null> {
  const terminalAtHead = new Set(
    [...pre.nodes.values()].filter(isNodeTerminal).map((node) => node.id),
  );

  // A compensation is an added node declaring which executed node it offsets. The
  // direction matters: the NEW node compensates the OLD one, never the reverse.
  const compensatedInBatch = new Set(
    ops.flatMap((op) =>
      op.op === "add_node" && typeof op.spec.compensates === "string"
        ? [op.spec.compensates]
        : [],
    ),
  );

  for (const [index, op] of ops.entries()) {
    if (op.op === "add_edge" && terminalAtHead.has(op.to)) {
      return violate(
        1,
        "TERMINAL_NODE_PROTECTED",
        `cannot add a blocking edge into '${op.to}', which is already terminal`,
        { node: op.to, op_index: index },
      );
    }

    if (op.op === "set_status" && terminalAtHead.has(op.node)) {
      return violate(
        1,
        "TERMINAL_NODE_PROTECTED",
        `'${op.node}' is terminal; only supersede_node, record_outcome and record_output may target it`,
        { node: op.node, op_index: index },
      );
    }

    if (op.op === "supersede_node") {
      const node = pre.nodes.get(op.node);
      if (
        node !== undefined &&
        node.status.effect_log.length > 0 &&
        !compensatedInBatch.has(op.node)
      ) {
        return violate(
          1,
          "UNCOMPENSATED_SUPERSEDE",
          `'${op.node}' has already moved bytes; superseding it requires a compensation in the same batch`,
          { node: op.node, op_index: index },
        );
      }
    }
  }

  return ok(null);
}

// ---------------------------------------------------------------------------
// Parser-class refusals that zod cannot express (§6.7 "the parser first, free")
// ---------------------------------------------------------------------------

/** The declared type of a node this batch can see: from head, or from an earlier op. */
function nodeTypeOf(pre: Graph, ops: readonly CommittedOp[], id: string): string | null {
  const existing = pre.nodes.get(id);
  if (existing !== undefined) return existing.type;
  for (const op of ops) {
    if (op.op === "add_node" && op.id === id) return op.type;
  }
  return null;
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
function checkWaitEdgeConditions(
  pre: Graph,
  ops: readonly CommittedOp[],
): Result<null> {
  for (const [index, op] of ops.entries()) {
    if (op.op !== "add_edge" || op.condition !== undefined) continue;
    if (nodeTypeOf(pre, ops, op.from) !== "wait") continue;
    return refuse(
      "UNCONDITIONED_WAIT_EDGE",
      `edge '${op.from}' -> '${op.to}' leaves a wait without a condition; an ignored or ` +
        `timed-out wait would clear it and fire the branch unapproved (§6.2)`,
      { node: op.from, op_index: index },
    );
  }
  return ok(null);
}

/**
 * An edge this batch adds that is already dead against post-authored state.
 *
 * The complement of the seed restriction in `resolveBranches`: derivation reads only edges
 * that existed at head, so an edge born dead is never derived from and must be refused
 * instead. Refusing it here makes the outcome identical whether the killing ops arrived in
 * this batch or an earlier one — otherwise the same authored ops would produce a dropped
 * node when committed together and a permanently unreachable one when split in two.
 *
 * It cannot become invariant 1's old state-predicate bug: it looks only at edges this batch
 * adds, so an unrelated later commit has nothing to test.
 */
function checkDeadOnArrivalEdge(
  interim: Graph,
  ops: readonly CommittedOp[],
): Result<null> {
  for (const [index, op] of ops.entries()) {
    if (op.op !== "add_edge") continue;
    const edge: Edge = {
      from: op.from,
      to: op.to,
      ...(op.condition === undefined ? {} : { condition: op.condition }),
    };
    if (!isEdgeDead(interim, edge)) continue;
    const source = interim.nodes.get(op.from);
    const because =
      source?.status.state === "dropped"
        ? `originates at '${op.from}', which is dropped`
        : `is conditioned on '${op.condition?.on}', but '${op.from}' has already resolved otherwise`;
    return refuse(
      "DEAD_ON_ARRIVAL_EDGE",
      `edge '${op.from}' -> '${op.to}' ${because}; it can never fire`,
      { node: op.to, op_index: index },
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
  if (key.length > MAX_NODE_ID_LENGTH || !NODE_ID_PATTERN.test(key)) return null;
  return { scope, key };
}

function checkRecipientRefs(pre: Graph, ops: readonly CommittedOp[]): Result<null> {
  // Built once, lazily: most batches add no effect node at all, and walking every node's
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
        { node: op.id, op_index: index },
      );
    }
    // A literal address gets its own reason. It is the one malformed shape that would
    // otherwise *work*, so telling the author "that is not a ref" beats "that is not valid".
    if (raw.includes("@")) {
      return refuse(
        "LITERAL_RECIPIENT_ADDRESS",
        `recipient_ref '${raw}' is a literal address; §6.2 requires a ref — '<scope>#<key>' ` +
          `— so the store can check who is being emailed against what the graph was told`,
        { node: op.id, op_index: index },
      );
    }
    return refuse(
      "MALFORMED_RECIPIENT_REF",
      `recipient_ref '${raw}' is not a '<scope>#<key>' reference: expected exactly one '#', ` +
        `a dotted lowercase scope, and a key matching [a-z0-9][a-z0-9-]* of at most ` +
        `${MAX_NODE_ID_LENGTH} characters (§6.2, e.g. 'roster.contacts#dana')`,
      { node: op.id, op_index: index },
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

export interface CountPredicate {
  count: { verdict: Verdict; attrs?: PredicateAttrs };
  op: ">=";
  n: number;
}

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
  if (countKeys.length > 2 || countKeys[0] !== "attrs" && countKeys[0] !== "verdict") return null;
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
function predicateArms(node: Node): CountPredicate[] {
  if (node.type !== "wait" || node.spec.match?.kind !== "predicate") return [];
  return node.spec.match.conditions.flatMap((condition) => {
    const parsed = parseCountPredicate(condition.predicate);
    return parsed === null ? [] : [parsed];
  });
}

function checkPredicateGrammar(ops: readonly CommittedOp[]): Result<null> {
  for (const [index, op] of ops.entries()) {
    if (op.op !== "add_node" || op.type !== "wait") continue;
    if (op.spec.match?.kind !== "predicate") continue;
    if (!op.spec.match.conditions.some((condition) => condition.predicate !== undefined)) {
      return refuse(
        "MISSING_PREDICATE",
        `'${op.id}' declares match.kind 'predicate' but carries no predicate; nothing would ` +
          `ever count against it, and invariant 2 could never judge it (§6.7)`,
        { node: op.id, op_index: index },
      );
    }
    for (const condition of op.spec.match.conditions) {
      if (condition.predicate === undefined) continue;
      if (parseCountPredicate(condition.predicate) !== null) continue;
      return refuse(
        "MALFORMED_PREDICATE",
        `predicate on '${op.id}' is not the §6.7 form ` +
          `{"count":{"verdict":…,"attrs":…},"op":">=","n":…}: 'op' must be '>=', 'n' an ` +
          `integer of at least 1, 'verdict' a resolving verdict, and 'attrs' flat primitives`,
        { node: op.id, op_index: index },
      );
    }
  }
  return ok(null);
}

export interface PredicateCount {
  /** Distinct sources of the wait's blocking in-edges (§6.7). */
  population: number;
  /** Of those, dropped — §6.4 excludes them: they neither satisfy nor block. */
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
  wait: Node,
  predicate: CountPredicate,
): PredicateCount {
  // Deduped by source: `add_edge` refuses only an identical {from,to,condition} triple, so
  // one member wired both bare and conditioned is two legal edges and one member.
  const members = [...new Set(inEdges(graph, wait.id).map((edge) => edge.from))].flatMap(
    (id) => {
      const node = graph.nodes.get(id);
      return node === undefined ? [] : [node];
    },
  );

  let excluded = 0;
  let matching = 0;
  let live = 0;
  for (const member of members) {
    if (member.status.state === "dropped") {
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
    // Unresolved. `active` and `sending` are live (§6.2: the world's answer is unknown, not
    // absent), and so is `done`-without-a-verdict, because `set_status` then `record_outcome`
    // across two commits is legal and that window must not be a rejection window. `failed`
    // is not: it tried and did not work, and nothing further will arrive.
    if (!isNodeTerminal(member) || member.status.state === "done") live += 1;
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
  const node = graph.nodes.get(waitId);
  if (node === undefined) return true;
  const arms = predicateArms(node);
  // Nothing parseable to judge, or an or-group with one satisfiable arm (§6.5 first-wins).
  return arms.length === 0 || arms.some((arm) => countPredicate(graph, node, arm).satisfiable);
}

/**
 * A batch nobody chose: `kona resume` firing an overdue timeout, or a bounce landing. Its
 * author is the store, which has no model to re-plan with, so refusing it would demand a
 * repair nothing in the loop can write.
 *
 * `set_status` to `done` counts, and it has to: resume writes the verdict and the status in
 * ONE batch — `record_outcome(timed_out)` plus `set_status(done)` — because a wait must be
 * terminal for its `on_timeout` arm to fire. It is also safe by construction, since `done`
 * cannot reduce satisfiability: a `done` member with no outcome is still live, and one with
 * an outcome was already counted by that outcome. `dropped` is deliberately absent — an
 * author dropping a member is a choice, and the store's own drops are matched structurally.
 */
function isMechanicalClosure(op: CommittedOp, derived: ReadonlySet<CommittedOp>): boolean {
  if (derived.has(op)) return true;
  if (op.op === "record_outcome") return op.verdict === "timed_out" || op.verdict === "bounced";
  if (op.op === "set_status") return op.status === "failed" || op.status === "done";
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
    if (isNodeTerminal(wait)) continue;
    // Terminal by the END of this batch — including when the store's own cascade dropped it.
    // A closed wait is not a broken one, and demanding a repair for it would leave `resume`
    // no legal batch at all.
    const after = post.nodes.get(wait.id);
    if (after !== undefined && isNodeTerminal(after)) continue;
    if (wait.status.outcome !== null) continue;
    if (wait.provenance.superseded_by !== null) continue;
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
      `'${wait.id}' can no longer reach ${arm.n} '${arm.count.verdict}': ` +
        `${counted.matching_confirmed} matching + ${counted.still_live} still live of ` +
        `${counted.population} blocking in-edges (${counted.excluded} dropped)` +
        (killed.length > 0 ? `; branch resolution dropped ${killed.join(", ")}` : "") +
        `; add a live member in this batch, or supersede the wait`,
      { node: wait.id },
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
   * Nodes on an untaken branch the store refused to rewrite — `sending`, or bytes already
   * moved. Not a rejection: the commit stands and each of these is a human's decision.
   */
  withheld: string[];
}

export function validate(input: ValidateInput): Result<ValidateOutput> {
  const parsed = parseBatch(input.ops);
  if (!parsed.ok) return parsed;

  const authorized = checkAuthority(input.actor, parsed.value);
  if (!authorized.ok) return authorized;

  const normalized = normalizeBatch(input.graph, parsed.value);
  if (!normalized.ok) return normalized;

  // Parser-class, but graph-dependent, so it cannot live in zod: `add_edge` carries `from`
  // as an id and never the source's type, which is in head or in an earlier op of this batch.
  const conditioned = checkWaitEdgeConditions(input.graph, normalized.value);
  if (!conditioned.ok) return conditioned;

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

  // §6.4 — derive ONCE, here, and expand into explicit ops. `fold` stays a dumb replay.
  const resolution = resolveBranches(input.graph, interim.value);
  const ops = [...normalized.value, ...resolution.drops];

  // Over the EXPANDED array. Derived ops are `set_status` against nodes non-terminal in the
  // interim graph, so they cannot trip the terminal clause themselves; and because authored
  // ops keep indices 0..n-1 and the loop returns the first violation, a reported `op_index`
  // still points at something the author actually wrote.
  const invariant1 = checkInvariant1(input.graph, ops);
  if (!invariant1.ok) return invariant1;

  // The graph the log will fold to: byte-for-byte the call `fold` will make on this record.
  const applied = applyOps(input.graph, ops, input.version);
  if (!applied.ok) return applied;

  const invariant2 = checkInvariant2(
    input.graph,
    applied.value,
    input.actor,
    ops,
    resolution.drops,
  );
  if (!invariant2.ok) return invariant2;

  return ok({
    ops,
    graph: applied.value,
    derived: resolution.drops,
    withheld: resolution.withheld,
  });
}
