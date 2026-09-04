/**
 * The graph. §6.1: there is no snapshot — this value only ever exists as the result of
 * folding the log, and nothing persists it.
 *
 * ActivityNode order is insertion order and edge order is append order, so two folds of the same
 * log produce structurally identical values and `JSON.stringify` of the projection is
 * byte-identical. That is the §8 determinism check, and it is a property of these two
 * container choices rather than of a sort applied afterwards.
 */

import type {
  AcceptEventSpec,
  ActionSpec,
  ControlSpec,
  CountPredicate,
  MutationRecord,
  ParsedNodeSpec,
} from "./schema.ts";
import type { BehaviourNodeType, ControlNodeType, GuardValue, Status, Verdict } from "./vocab.ts";
import {
  TERMINAL_SUCCESS_STATUS,
  isAbandoned,
  isResolvingVerdict,
  isTerminal,
  isUnclaimed,
} from "./vocab.ts";

export interface EffectRecord {
  effect_key: string;
  payload_hash: string;
  /** When the intent was durably appended. Always set. */
  attempted_at: string;
  /**
   * When the world's answer came back. `null` means the answer is UNKNOWN, not that
   * nothing happened — §6.6 keeps these two fields distinct so that state is nameable.
   */
  completed_at: string | null;
  outcome: "sent" | "failed" | null;
  message_id: string | null;
}

/** One recorded decision. §6.7: judgment-bearing fields are append-only. */
export interface OutcomeRecord {
  verdict: Verdict;
  evidence_ref: string;
  attrs?: Record<string, unknown>;
  /** The version that recorded it, so the history is orderable without a timestamp. */
  at_version: number;
}

export interface NodeCondition {
  type: string;
  status: string;
  reason: string;
  at: string;
}

/** The AUTHORED half. Changed only by a mutation op (§6.2). */
export type ActivitySpec = ParsedNodeSpec;

/**
 * The OBSERVED half. §6.2 keeps three fields answering three different questions;
 * conflating any two is how the worst probe bugs happened.
 */
export interface NodeStatus {
  /** WHERE we are. Written by `set_status`. */
  state: Status;
  /**
   * WHAT was decided, in full. Append-only (§6.7): `record_outcome` never overwrites.
   *
   * The alternative loses data outright. §6.5 requires that a reply arriving after its
   * wait resolved be recorded as `verdict:"late"` and **never reopen** it — under
   * overwrite semantics that late reply silently replaces the verdict the graph actually
   * acted on, and the evidence for a sent email disappears behind a straggler.
   */
  outcomes: OutcomeRecord[];
  /**
   * The one that CLOSED it — a projection of `outcomes`, materialised so consumers do not
   * each re-derive it. The first entry with a resolving verdict wins: `tentative` records
   * without resolving and `late` is after the fact, so neither can become this.
   */
  outcome: OutcomeRecord | null;
  /** WHAT was produced. Written by `record_output`, keyed by declared output name. */
  output: Record<string, unknown> | null;
  /**
   * Where each output CAME FROM, keyed the same way.
   *
   * `record_output` always carried an `evidence_ref` and `applyOne` discarded it, which
   * left invariant 3(b) nothing to resolve a `recipient_ref` against — the clause says a
   * recipient must "resolve to an entity already in the graph carrying an `evidence_ref`",
   * and the folded graph materialised exactly one of those, on an outcome. Retaining it
   * here is what makes "evidenced" mean *recorded under an output that cited something*
   * rather than *spelled correctly*.
   */
  output_evidence: Record<string, string> | null;
  conditions: NodeCondition[];
  effect_log: EffectRecord[];
  observed_at_version: number;
}

export interface Provenance {
  created_by_version: number;
  group?: string;
  supersedes: string | null;
  superseded_by: string | null;
  /** True once `supersede_node` retires this node, even when there is no replacement. */
  retired?: boolean;
}

/**
 * A node, as a discriminated union on family (D6).
 *
 * A control node has **no `status` key at all** — not an empty one, not a defaulted one. The
 * difference is the whole point: with a shared shape, "a control node never acquires a status"
 * is a convention that holds because every writer remembers, and it is checked by a property
 * test that exists precisely because nothing else could check it. As a union it is a compile
 * error, in all three packages, forever.
 *
 * `status` is therefore reached through `isBehaviour(node)` or a `type` narrowing. That is not
 * friction; it is the reader being asked, at each site, which family it meant.
 * Several bugs in this migration were exactly that question going unasked: readiness gating on
 * `status.state` and letting a diamond through, the cascade giving one a `withdrawn`, the
 * Inspector printing three rows about a node that has none of them.
 */
export type ActivityNode = BehaviourNode | ControlNode;

interface NodeIdentity<T extends BehaviourNodeType | ControlNodeType, S extends ActivitySpec> {
  id: string;
  type: T;
  name: string;
  spec: S;
  provenance: Provenance;
}

export interface ActionNode extends NodeIdentity<"action", ActionSpec> {
  status: NodeStatus;
}

export interface AcceptEventNode extends NodeIdentity<"accept_event", AcceptEventSpec> {
  status: NodeStatus;
}

export type BehaviourNode = ActionNode | AcceptEventNode;

export type ControlNode = {
  [T in ControlNodeType]: NodeIdentity<T, ControlSpec> & { status?: never };
}[ControlNodeType];

/** §6.2 — one edge kind, no identity. `{from: A, to: B}` means **B requires A**. */
export interface Edge {
  from: string;
  to: string;
  guard?: "else" | { on: GuardValue } | CountPredicate;
}

export interface Graph {
  schema_version: number;
  /** Head version: the `v` of the last record folded. */
  version: number;
  nodes: Map<string, ActivityNode>;
  edges: Edge[];
}

export function emptyGraph(schemaVersion: number): Graph {
  return { schema_version: schemaVersion, version: 0, nodes: new Map(), edges: [] };
}

/**
 * Does this node carry a status? A type predicate, so an existing runtime guard NARROWS.
 *
 * This predicate lets runtime family checks narrow the discriminated union for the compiler.
 */
export function isBehaviour(node: ActivityNode): node is BehaviourNode {
  return node.status !== undefined;
}

/** Whether this node participates in the live graph. */
export function isNodeLive(node: ActivityNode): boolean {
  return node.provenance.retired !== true && node.provenance.superseded_by === null;
}

export function activityIds(graph: Graph): Set<string> {
  return new Set(graph.nodes.keys());
}

/** In-edges of `to`. With one edge kind every in-edge is a blocking edge (§6.2). */
export function inEdges(graph: Graph, to: string): Edge[] {
  return graph.edges.filter((e) => e.to === to);
}

export function outEdges(graph: Graph, from: string): Edge[] {
  return graph.edges.filter((e) => e.from === from);
}

export function isActivityTerminal(activity: ActivityNode): boolean {
  // A control node is never terminal, because it never STARTED — it is not work. The union
  // makes the question askable; before it, this read a status that was there by convention.
  if (activity.status === undefined) return false;
  return isTerminal(activity.status.state);
}

/**
 * §6.4 — "An abandoned source never satisfies readiness." Only a terminal *success*
 * satisfies a blocking edge; `failed`, `withdrawn` and `terminated` do not.
 */
export function satisfiesBlockingEdge(activity: BehaviourNode): boolean {
  return activity.status.state === TERMINAL_SUCCESS_STATUS;
}

/** §6.5 — the first resolving outcome, or null while the activity is still open. */
export function resolvingOutcome(outcomes: readonly OutcomeRecord[]): OutcomeRecord | null {
  return outcomes.find((entry) => isResolvingVerdict(entry.verdict)) ?? null;
}

/**
 * §6.2 — "the store fires the out-edge whose condition matches the resolution".
 *
 * The resolution is DERIVED, never stored, which is what keeps readiness computed rather
 * than materialised (§6.8). The seven edge conditions are exactly two families: the four
 * decisions a human wait returns, which are verdicts already, and the three ways any wait
 * can close.
 *
 * `declined` maps to `satisfied` on purpose: the wait *was* satisfied — somebody answered.
 * What they said is the verdict, and that is what a predicate counts. Conflating the two
 * would make a refusal indistinguishable from silence.
 */
export function resolutionOf(activity: ActivityNode): GuardValue | null {
  if (activity.status === undefined) return null;
  const outcome = activity.status.outcome;
  if (outcome === null) return null;
  switch (outcome.verdict) {
    case "accept":
    case "edit":
    case "respond":
    case "ignore":
      return outcome.verdict;
    case "timed_out":
      return "timeout";
    case "bounced":
      return "bounced";
    case "confirmed":
    case "declined":
      return "satisfied";
    default:
      return null;
  }
}

/**
 * Can this edge NEVER fire? The complement of *pending*, not of `isEdgeSatisfied`: an edge
 * whose source is still open is neither satisfied nor dead, and treating the two as
 * complements is how a live branch gets dropped.
 *
 * Deadness is monotone, which is what makes the op-delta trigger in `resolveBranches` exact.
 * Terminality is permanent (invariant 1 refuses `set_status` on a head-terminal activity) and a
 * resolution is frozen once non-null (`status.outcome` is the FIRST resolving entry, so a
 * later reply cannot change it).
 */
export function isEdgeDead(graph: Graph, edge: Edge): boolean {
  return edgeDead(graph, edge, new Set());
}

/**
 * Deadness, carried ACROSS a control node — the mirror of `edgeSatisfied`, and needed for the
 * same reason.
 *
 * The cascade seeds itself from edges this commit killed, and a decision's untaken arm is the
 * commonest killed edge there is. Without this the source of that edge is a diamond with no
 * status, `isActivityTerminal` is false, and the edge reads as merely open — so the cascade
 * never starts, the whole untaken branch stays live, and the second step on it reaches the
 * frontier and gets dispatched. That is the pivot-fires-unapproved bug, reintroduced by the
 * notation that exists to prevent it.
 *
 * `isEdgeDead` and `isEdgeSatisfied` are deliberately NOT complements: an edge whose source is
 * still open is neither. That is the single easiest thing to get wrong here, and it is why
 * each control type gets its own rule rather than a negation of the other function's.
 */
function edgeDead(graph: Graph, edge: Edge, seen: Set<string>): boolean {
  const source = graph.nodes.get(edge.from);
  if (source === undefined) return false;

  if (!isBehaviour(source)) {
    if (seen.has(source.id)) return false;
    seen.add(source.id);
    return controlDead(graph, source, edge, seen);
  }

  // Past the control branch above, the source carries a status by construction. Narrowing
  // here rather than optional-chaining four times keeps the reason in one place.
  // Still open: it may yet resolve either way.
  if (!isActivityTerminal(source)) return false;
  // §6.4 — "an in-edge whose SOURCE is abandoned". The two states the spec names.
  if (isAbandoned(source.status.state)) return true;
  // §6.2 keeps `failed` distinct from abandoned: "tried, didn't work" is a human's to look
  // at. It can never satisfy, so the subtree stalls — loudly, under a visibly failed activity,
  // which is better than the store silently deleting work someone is about to repair.
  if (source.status.state === "failed") return false;
  // A plain edge is cleared by any `completed` source (§6.4 readiness), so it is never dead.
  if (edge.guard === undefined || edge.guard === "else" || !("on" in edge.guard)) return false;
  const resolution = resolutionOf(source);
  // `completed` with no resolving outcome yet: `set_status` at v10 and `record_outcome` at v11 is
  // a legal two-commit sequence, and the window between them must not kill the branch.
  if (resolution === null) return false;
  return !guardMatches(source, edge.guard);
}

/** The per-type deadness rule for a control node, evaluated over its own LIVE in-edges (D5). */
function controlDead(graph: Graph, source: ActivityNode, out: Edge, seen: Set<string>): boolean {
  const ins = liveIn(graph, source.id);

  switch (source.type) {
    case "initial":
      // Where the flow starts. Nothing upstream can have killed it.
      return false;
    case "decision": {
      // Exactly one arm fires, so every OTHER arm is dead the moment one does — and none is
      // dead before that, because an unresolved decision has taken nothing.
      const fired = firedGuard(graph, source);
      return fired !== null && fired !== out;
    }
    case "fork":
      // A fork carries its one in-edge to every arm, so it dies exactly when that edge does.
      return ins.length > 0 && ins.every((edge) => edgeDead(graph, edge, seen));
    case "join":
      // Dead inputs are excluded. The join itself is dead only when no reachable arm remains.
      return ins.length > 0 && ins.every((edge) => edgeDead(graph, edge, new Set(seen)));
    case "merge":
      // Disjunctive: dead only once every alternative is.
      return ins.length > 0 && ins.every((edge) => edgeDead(graph, edge, seen));
    default:
      return false;
  }
}

/**
 * Is this activity on an arm that can never fire? Every in-edge dead, or from an activity that is
 * itself arm-dead — the same least fixpoint the cascade in `branch.ts` walks.
 *
 * Readiness needs this and dropping cannot supply it. The cascade deliberately does NOT
 * rewrite an activity that is already terminal, or one that is `active`, so those activities sit on a
 * dead arm wearing a live-looking status forever. Their plain out-edges then read as
 * SATISFIED, and beneath a `merge` one of them alone is enough to put a shared descendant
 * on the frontier — where §6.8 says appearing "is what gets it dispatched, pivot send
 * included". An `active` activity completing later makes no edge newly dead, so no commit-time
 * derivation could ever catch that case; it has to be answered when readiness is computed.
 *
 * A root is never arm-dead: blocking on nothing is not the same as being cut off.
 */
export function isArmDead(graph: Graph, id: string): boolean {
  return armDead(graph, id, new Set());
}

function armDead(graph: Graph, id: string, seen: Set<string>): boolean {
  // A cycle is mutual dependency, not proof of death. Returning false keeps the predicate
  // conservative and, more importantly, keeps it total: `add_edge` refuses only a self-edge
  // and an exact duplicate, so nothing stops a cycle existing.
  if (seen.has(id)) return false;
  const ins = inEdges(graph, id);
  if (ins.length === 0) return false;
  seen.add(id);
  return ins.every((edge) => isEdgeDead(graph, edge) || armDead(graph, edge.from, seen));
}

/**
 * §6.4 — "Readiness fails safe." An activity is ready iff it is not abandoned and every blocking
 * in-edge has a terminal-SUCCESS source whose condition is true.
 *
 * It deliberately does NOT inherit the merge exclusion that abandonment gives: an abandoned
 * source never satisfies readiness. Otherwise the second activity on an untaken branch has no
 * blocker, lands on the frontier, and gets dispatched — pivot send included.
 */
export function isEdgeSatisfied(graph: Graph, edge: Edge): boolean {
  return edgeSatisfied(graph, edge, new Set());
}

/**
 * Satisfaction, carried ACROSS a control node.
 *
 * A control node has no status — there is nothing on it to be `completed` — so the question
 * "is this edge satisfied" has to be answered by walking back to the behaviour nodes beneath
 * it and applying that control node's own rule. Without this, every v2 graph returns an empty
 * frontier: under S7 an `action`'s single in-edge comes from the `initial` node, and a bare
 * status check against a node that has no status is the difference between a working store
 * and one that never dispatches anything.
 *
 * The rules are §6.4's, restated per type rather than per merge-mode field:
 *
 *   - `initial`   — satisfied from the first commit. It is where the flow starts.
 *   - `fork`      — passes its single in-edge through to every arm, unchanged.
 *   - `join`      — conjunctive: every in-edge, which is what `merge:"all"` used to mean.
 *   - `merge`     — disjunctive: any in-edge, which is what `merge:"any"` used to mean.
 *   - `decision`  — its in-edge must be satisfied AND this out-edge must be the one whose
 *                   guard fired, so exactly one arm is ever carried.
 *   - terminators — never a source; they have no out-edges to satisfy.
 *
 * `seen` guards a cycle. S6 forbids one, but this function runs on graphs that have not been
 * validated yet — `validate` calls readiness while deciding whether to accept the very commit
 * that would introduce it — so a total predicate is the only safe one. Returning false keeps
 * it conservative: a cycle is mutual dependency, not proof of satisfaction.
 */
function edgeSatisfied(graph: Graph, edge: Edge, seen: Set<string>): boolean {
  const source = graph.nodes.get(edge.from);
  if (source === undefined) return false;

  if (!isBehaviour(source)) {
    if (seen.has(source.id)) return false;
    seen.add(source.id);
    return controlSatisfied(graph, source, edge, seen);
  }

  // Same shape as `edgeDead`: the control branch above has returned, so this is work.
  if (!satisfiesBlockingEdge(source)) return false;
  if (edge.guard === undefined) return true;
  return guardMatches(source, edge.guard);
}

/**
 * Does this guard fire on what the source recorded?
 *
 * The VERDICT is asked first and the resolution second, because the projection loses exactly
 * the distinction that matters: `resolutionOf` maps both `confirmed` and `declined` onto
 * `satisfied`, so a resolution-shaped guard cannot express *did they say yes or no*. Asking
 * the verdict first makes `{on:"confirmed"}` and `{on:"declined"}` route to different arms,
 * while `{on:"timeout"}` and the rest keep working against the projection they were written
 * for.
 */
function guardMatches(source: BehaviourNode, guard: Edge["guard"]): boolean {
  if (guard === undefined || guard === "else" || !("on" in guard)) return false;
  const on = guard.on;
  const outcome = source.status.outcome;
  if (outcome !== null && outcome.verdict === on) return true;
  return resolutionOf(source) === on;
}

function predicateGuardMatches(
  graph: Graph,
  decision: ActivityNode,
  predicate: CountPredicate,
): boolean {
  const pending = inEdges(graph, decision.id).map((edge) => edge.from);
  const seen = new Set<string>();
  let matching = 0;
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const node = graph.nodes.get(id);
    if (node === undefined) continue;
    if (!isBehaviour(node)) {
      pending.push(...inEdges(graph, node.id).map((edge) => edge.from));
      continue;
    }
    const outcome = node.status.outcome;
    if (
      outcome?.verdict === predicate.count.verdict &&
      Object.entries(predicate.count.attrs ?? {}).every(
        ([key, value]) => outcome.attrs?.[key] === value,
      )
    )
      matching += 1;
  }
  return matching >= predicate.n;
}

/**
 * A control node's in-edges, minus the ones a supersede has taken out of the live graph (D5).
 *
 * Without this, growing the graph poisons every join downstream. The sanctioned way to replace
 * a step is to supersede it and wire its replacement — the superseded node keeps its edges,
 * because nothing is ever deleted — and a superseded node is abandoned, so its stale edge
 * reads as DEAD. A join is conjunctive, so one dead in-edge is enough to kill it: replacing a
 * step would silently withdraw everything behind the join it fed.
 *
 * Caught by `fixtures/goalie.*` rather than by reasoning — the fixture supersedes a claimed
 * step mid-work, which is exactly the shape, and the wrong answer showed up as a node reading
 * `withdrawn` three versions before anything had gone wrong.
 *
 * Only the control rules need this. A behaviour node with no live in-edge left is refused by
 * S7 at commit, so it cannot reach a reader in that state.
 */
function liveIn(graph: Graph, id: string): Edge[] {
  return inEdges(graph, id).filter((edge) => {
    const source = graph.nodes.get(edge.from);
    return source !== undefined && isNodeLive(source);
  });
}

/** The per-type rule for a control node, evaluated over its own in-edges. */
function controlSatisfied(
  graph: Graph,
  source: ActivityNode,
  out: Edge,
  seen: Set<string>,
): boolean {
  const ins = liveIn(graph, source.id);

  switch (source.type) {
    case "initial":
      // The one node whose satisfaction is not a function of anything upstream, because
      // there is no upstream. A second `initial` is an S1 refusal, not this function's
      // problem — asking it here would make readiness depend on whole-graph validity.
      return true;
    case "fork":
      return ins.some((edge) => edgeSatisfied(graph, edge, seen));
    case "join":
      // Conjunctive over reachable arms. Untaken/dead arms are excluded, but a join with no
      // reachable inputs is itself unreachable rather than vacuously satisfied.
      const reachable = ins.filter((edge) => !edgeDead(graph, edge, new Set(seen)));
      return (
        reachable.length > 0 && reachable.every((edge) => edgeSatisfied(graph, edge, new Set(seen)))
      );
    case "merge":
      return ins.some((edge) => edgeSatisfied(graph, edge, seen));
    case "decision":
      return (
        ins.some((edge) => edgeSatisfied(graph, edge, seen)) && firedGuard(graph, source) === out
      );
    default:
      // `final` and `flow_final` absorb; they have no out-edges, so reaching here means the
      // graph wired one anyway and the honest answer is that it carries nothing.
      return false;
  }
}

/**
 * Which of a decision's out-edges fires — a pure function of what is already recorded.
 *
 * A decision has no status and needs none: the arm it takes is determined by the resolution of
 * whatever is upstream of it, which is append-only and first-wins (§6.7). So this is derivable
 * at read time and after a crash, and there is nothing to persist that could disagree with it.
 *
 * Guards are evaluated in EDGE ORDER, first match wins, and `else` fires when nothing matched.
 * Edge order is append order (§6.1), so two folds of one log pick the same arm.
 */
export function firedGuard(graph: Graph, decision: ActivityNode): Edge | null {
  const source = decisionSource(graph, decision);
  const outs = outEdges(graph, decision.id);
  const active = liveIn(graph, decision.id).some((edge) => isEdgeSatisfied(graph, edge));
  if (!active) return null;
  // `guardMatches`, not an equality against the projection — the same rule the edge predicates
  // use, and for the same reason: `confirmed` and `declined` both project to `satisfied`, so an
  // equality here would route yes and no to the identical arm.
  const matched = outs.find((edge) => {
    if (edge.guard === undefined || edge.guard === "else") return false;
    return "count" in edge.guard
      ? predicateGuardMatches(graph, decision, edge.guard)
      : source !== null && guardMatches(source, edge.guard);
  });
  const hasPredicateGuard = outs.some(
    (edge) => edge.guard !== undefined && edge.guard !== "else" && "count" in edge.guard,
  );
  if (
    matched === undefined &&
    !hasPredicateGuard &&
    (source === null || resolutionOf(source) === null)
  ) {
    return null;
  }
  return matched ?? outs.find((edge) => edge.guard === "else") ?? null;
}

/** The node a decision routes on: the first resolved status-carrying node upstream of it. */
function decisionSource(graph: Graph, decision: ActivityNode): BehaviourNode | null {
  const pending = liveIn(graph, decision.id).map((edge) => edge.from);
  const seen = new Set<string>();
  while (pending.length > 0) {
    const id = pending.shift();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const source = graph.nodes.get(id);
    if (source === undefined) continue;
    if (isBehaviour(source)) {
      if (resolutionOf(source) !== null) return source;
      continue;
    }
    pending.push(...liveIn(graph, source.id).map((edge) => edge.from));
  }
  return null;
}

/**
 * §6.4 — "An in-edge whose SOURCE is dropped is excluded from merge evaluation: it neither
 * satisfies nor blocks." That exclusion and the "readiness does not inherit it" sentence in
 * the next paragraph cannot both hold literally for an activity with more than one in-edge, and
 * the shipped fixture is the proof: at head, `goalie-confirmed` carries a `satisfied`-
 * conditioned in-edge from `wait-for-priya`, which `supersede_node` dropped. Nothing can
 * un-drop a terminal activity and no op removes an edge, so under the literal reading that join
 * is unreachable **forever** — silently, since `readyFrontier` just omits it.
 *
 * So the exclusion applies, and the guarantee the second sentence exists for is delivered by
 * the zero-live clause instead: an activity whose in-edges are ALL dropped is not ready either.
 * The second activity on an untaken branch still never lands on the frontier, which is the
 * failure ("pivot send included") that sentence was written to prevent.
 *
 * The exclusion is abandonment — `withdrawn` or `terminated` — and nothing else. `failed` is deliberately not
 * excluded (§6.2: "tried, didn't work" ≠ "we stopped wanting this") — a subtree stuck under
 * a visibly failed activity is a human's to look at, not the store's to delete.
 */
export function isReady(graph: Graph, activity: ActivityNode): boolean {
  // §6.2's two families, enforced at the one place that decides what gets handed out.
  // A control node is not work: it has no status to claim, no instruction to execute, and
  // nothing an executor could do with it. It is resolved by the store at commit, and the
  // frontier is the exact surface where letting one through would get it dispatched.
  //
  // The check is the family, not `status.state`. Every node is still BORN with a status
  // object today, so a state test would pass a diamond straight through — and the whole
  // point of the arity rules is that a diamond sits between an action and its successor,
  // which is the position that reaches the frontier first.
  if (!isBehaviour(activity)) return false;
  // Unclaimed and unfinished. `inactive` and `ready` are the two states the derivation
  // moves between, and a node in either is a candidate; anything else is claimed or over.
  if (!isUnclaimed(activity.status.state)) return false;
  if (!isNodeLive(activity)) return false;
  const ins = inEdges(graph, activity.id);
  // A root blocks on nothing and is ready. Tested before the live-arm filter, because a root
  // has no in-edge that could be live and the zero-live clause below would otherwise strand it.
  if (ins.length === 0) return true;
  // Abandoned, or on an arm that can never fire. The second is not redundant: the cascade
  // leaves a terminal or `active` activity on a dead arm exactly as it found it, so the
  // abandonment test alone would let one of those satisfy a `merge` on a branch nobody took.
  const live = ins.filter(
    (edge) =>
      // A control source has no status to be abandoned; it is judged by the per-type rules in
      // `controlDead` instead, which `isArmDead` reaches.
      !isAbandoned(graph.nodes.get(edge.from)?.status?.state ?? "inactive") &&
      !isArmDead(graph, edge.from),
  );
  // A node with zero live in-edges is unreachable, not ready.
  if (live.length === 0) return false;
  // Conjunctive, always. The disjunction that `spec.merge: "any"` used to express is a `merge`
  // NODE now, and `edgeSatisfied` carries it across — so the choice moved from a field on the
  // node being joined into, where a model had to pick it, to a shape you can see.
  //
  // That field did real damage on its way out. It was invisible in the picture, so the viewer's
  // own comment asserted nothing read it while `isReady` did, and the viewer painted a live
  // `any` node dead the moment one arm died. One field, two operators, and no way to tell from
  // the graph which one you had.
  return live.every((edge) => isEdgeSatisfied(graph, edge));
}

/** §6.8 — the ready frontier. Computed, never stored. */
export function readyFrontier(graph: Graph): ActivityNode[] {
  // A QUERY over recorded state, not a computation. `ready` is derived by the store at commit
  // and written as an op (§6.2.1), so the frontier a fresh process reads is the frontier the
  // commit decided — not one recomputed by whatever this file says today.
  //
  // `isReady` has not gone away; it moved. It is the predicate the derivation evaluates, and
  // it is still the only place the rule lives.
  return [...graph.nodes.values()].filter((node) => node.status?.state === "ready");
}

/**
 * The `--json` read contract (§6.8). Ordered and plain, so that folding twice and
 * stringifying twice yields identical bytes.
 */
export interface GraphProjection {
  schema_version: number;
  version: number;
  nodes: ActivityNode[];
  edges: Edge[];
}

export function projectGraph(graph: Graph): GraphProjection {
  return {
    schema_version: graph.schema_version,
    version: graph.version,
    nodes: [...graph.nodes.values()],
    edges: graph.edges,
  };
}

/** Convenience for callers that hold records rather than a folded graph. */
export function headVersion(records: readonly MutationRecord[]): number {
  return records[records.length - 1]?.v ?? 0;
}
