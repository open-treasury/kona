/**
 * Why an activity is not running.
 *
 * §6.10 rule 4 asks every activity to render its own state inline, and "for a blocked activity the
 * reason as text". That sentence is the whole module: a red ring around an activity tells a reader
 * that something is wrong and nothing about what, so they go and read the log by hand, which
 * is the failure this viewer exists to prevent.
 *
 * Every judgment here is delegated to the store — to `@kona/core`'s `isEdgeSatisfied`,
 * `isEdgeDead`, `isArmDead` and `resolutionOf`, and to the lifecycle state the commit itself
 * recorded. A second opinion computed locally would eventually disagree with the store, and
 * then the canvas would show work as available that `kona` refuses to dispatch. What this
 * module adds is only the *explanation*: the log says an activity is `inactive`, and we walk
 * the same edges core walked to say which dependency is unmet, and whether it can ever change.
 *
 * **The walk crosses control nodes, and that is what the activity model forced.** Under the
 * §6.2 arity table an `action` has exactly ONE in-edge, and every convergence goes through a
 * `merge` or a `join` — so the immediate source of a blocked action is almost always a node
 * with no status, no work and no story. "Waiting on Goalie and pitch both in" is a diagram
 * co-ordinate, not a reason. So each unmet in-edge is followed back through the control nodes,
 * applying the same per-type rules core applies, and reported against the first BEHAVIOUR node
 * on each path — the step a reader can actually go and do something about.
 *
 * There are three readings, not two, and rule 11 exists because the middle one used to be
 * invisible:
 *
 *   - **waiting** — some dependency is still open. Ordinary, and most of what a reader sees.
 *   - **parked** — nothing can ever satisfy it, and yet the store deliberately keeps the branch
 *     alive: §6.4 rule 5 says a `failed` source is *not* unreachable, because "tried, didn't
 *     work" is a human's to repair rather than the store's to delete. A join under a failed arm
 *     therefore stalls forever while looking exactly like one that is merely waiting. That is
 *     the failure rule 11 names, so the summary says so, and names the failed node.
 *   - **unreachable** — the store has resolved the branch away: `isArmDead`, the same predicate
 *     the cascade in `branch.ts` withdraws on.
 */

import type { Edge, Graph, ActivityNode } from "@kona/core";
import {
  inEdges,
  isAbandoned,
  isArmDead,
  isBehaviour,
  isEdgeDead,
  isEdgeSatisfied,
  isTerminal,
  resolutionOf,
} from "@kona/core";
import { guardLabel } from "./guard.ts";
import type { BlockedCause, BlockedReason, Standing } from "./types.ts";

/**
 * The recorded state, with exactly one thing layered over it.
 *
 * There is no derivation left here, and that absence is the point. §6.2.1 makes all seven
 * states facts in the log — `ready` and `withdrawn` written by the store's own derivations at
 * commit, the rest by `set_status` — so asking the edges "is this ready" a second time would
 * be the second opinion this module exists not to have. The frontier a reader sees is the
 * frontier the commit decided, not one recomputed by whatever this file says today.
 *
 * `superseded` outranks the state because supersede is about the activity's standing rather
 * than where it got to: a superseded activity can still be `ready`, and returning that would
 * put work nobody intends to do back in front of the reader as live. One that is `completed`
 * *and* superseded — which is what the fixture's roster step is — should read as replaced
 * rather than merely finished, because the replacement is the thing the reader must follow.
 */
export function readinessOf(activity: ActivityNode): Standing | null {
  if (activity.provenance.superseded_by !== null) return "superseded";
  // A control node has no standing to report: it is not work, and nothing about it is
  // "getting on". Null rather than a placeholder state, so a caller that renders standing
  // has to decide what to do about a node that has none instead of drawing a wrong word.
  return activity.status?.state ?? null;
}

/**
 * One cause per unmet BEHAVIOUR dependency, in edge order, or null when nothing is blocked.
 *
 * Edge order rather than any ranking, because §6.1 makes append order the one stable order in
 * the system; sorting by severity would reshuffle the list on a status tick and lose the
 * reader's place. Control nodes are traversed and never reported, exactly as §6.5's predicate
 * population and §6.8's `kona brief` walk traverse them — they are notation, and a reader
 * cannot work one.
 */
export function blockedReason(graph: Graph, activity: ActivityNode): BlockedReason | null {
  // `inactive` IS blocked: §6.2.1 defines it as "dependencies not yet satisfied", and it is
  // the state the readiness derivation lifts to `ready` the moment they are. Anything else —
  // claimed, terminal, or replaced — has no unmet dependency to explain.
  //
  // A control node has NO standing (`null`), and that is not "anything else": rule 4 wants
  // *k of n arms satisfied* on a join glyph, which is this same walk asked of the bar itself.
  // Bailing on `null` here is what made the bar go quiet, and it is a trap the discriminated
  // union created — before it, a control node reported `inactive` like everything else.
  const standing = readinessOf(activity);
  if (standing !== null && standing !== "inactive") return null;

  // Which in-edges count is a per-family question, and core answers it twice: `isReady` weighs
  // all of a behaviour node's, while `controlSatisfied` weighs a control node's LIVE ones. Both
  // shapes reach here — rule 4 wants *k of n arms* on a join glyph, which is this same walk
  // asked of the bar itself — so the family decides, exactly as it does in core.
  const edges = isBehaviour(activity) ? inEdges(graph, activity.id) : liveIn(graph, activity.id);
  // One `seen` per in-edge, mutated down the walk — the same shape and the same reason as
  // core's own `edgeSatisfied`: it makes a cycle terminate without making a shared subtree
  // disappear from a sibling's answer.
  const branches = edges
    .filter((edge) => !isEdgeSatisfied(graph, edge))
    .map((edge) => walk(graph, edge, guardLabel(edge), new Set()));

  const causes = distinct(branches.flatMap((branch) => branch.causes));
  const dependencies = new Set(edges.flatMap((edge) => dependenciesOf(graph, edge, new Set())));
  const stall = branches.reduce<Stall | null>((found, branch) => found ?? branch.stall, null);

  return {
    summary: summaryOf(causes, dependencies, stall),
    causes,
    // Rule 11 gets a field of its own rather than living only in the summary text: the card
    // switches its icon on this, and an icon cannot read a sentence.
    parked: stall !== null,
    unreachable: isUnreachable(graph, activity, edges),
  };
}

/**
 * Can the store ever offer this activity again?
 *
 * The two clauses that judge a live graph are core's own answer, and neither is recomputed
 * here. That matters more than it looks: this field used to be `causes.some(isPermanent)`,
 * which asked ONE question of every
 * shape and so had to be wrong about half of them. A `join` dies on one dead arm and a `merge`
 * only once EVERY arm is dead — under the old rule a merge with three alternatives was painted
 * permanently unreachable the moment the first one died, while `kona` went on driving it. The
 * distinction is the node TYPE now, and it lives inside `isEdgeDead`'s per-type walk, which is
 * exactly why this delegates rather than re-deriving.
 *
 *   - `isArmDead` — every in-edge dead, or from a node itself on a dead arm. This is the
 *     predicate the cascade in `branch.ts` withdraws on and that `isReady` excludes on, so
 *     agreeing with it is agreeing with the frontier.
 *   - one dead in-edge, among the in-edges readiness actually EVALUATES. Readiness is
 *     conjunctive, so one edge that can never satisfy settles it whatever the others do. Under
 *     the activity model a behaviour node has exactly one in-edge anyway, and every disjunction
 *     is a `merge` node whose all-arms-dead rule is inside `isEdgeDead`.
 *
 * A `failed` source is deliberately in neither: §6.4 rule 5 says it is not unreachable, and
 * `summaryOf` reports it as parked instead. The third clause is the one case core cannot
 * answer — a source that is not in the graph at all, where `edgeDead` returns false because it
 * cannot see the node, not
 * because the node might come good — and ids are minted from the NAME AND the commit that
 * carries it (`ids.ts`), so nothing can mint that id back. That is a damaged graph, and naming
 * it is the whole job here.
 */
function isUnreachable(graph: Graph, activity: ActivityNode, edges: readonly Edge[]): boolean {
  if (isArmDead(graph, activity.id)) return true;
  if (edges.some((edge) => !graph.nodes.has(edge.from))) return true;
  return edges.filter((edge) => evaluated(graph, edge)).some((edge) => isEdgeDead(graph, edge));
}

/**
 * The in-edges `isReady` weighs, and it is not all of them.
 *
 * §6.4 — "an in-edge whose SOURCE is abandoned is excluded from merge evaluation: it neither
 * satisfies nor blocks". So an abandoned source is a cause (a reader wants to know that arm
 * died) but never evidence of unreachability: the fixture's quorum still reaches the frontier
 * with Priya's withdrawn wait hanging off it, and calling it hung would be the exact opposite of
 * the silent-hang warning this field exists to give.
 */
function evaluated(graph: Graph, edge: Edge): boolean {
  // `isBehaviour` rather than a hand-rolled `status !== undefined`: the store owns the question
  // of what a family IS, and a second answer here is the duplicated judgment the seam gate
  // exists to stop.
  const source = graph.nodes.get(edge.from);
  const state = source !== undefined && isBehaviour(source) ? source.status.state : undefined;
  if (state === undefined || isAbandoned(state)) return false;
  return !isArmDead(graph, edge.from);
}

/** The nearest join that can never complete, and the causes that park it. §6.10 rule 11. */
interface Stall {
  join: ActivityNode;
  blockers: BlockedCause[];
}

/**
 * One unmet dependency edge, resolved to the behaviour nodes beneath it.
 *
 * `stalled` is the question core declines to answer: *can this edge ever come good?* It is
 * `isEdgeDead` widened by exactly the two leaves core leaves live on purpose — a `failed` and a
 * missing source — and aggregated by the identical per-type rules, so the two can only ever
 * disagree about a branch somebody is expected to repair.
 */
interface Branch {
  causes: BlockedCause[];
  stalled: boolean;
  stall: Stall | null;
}

const OPEN: Branch = { causes: [], stalled: false, stall: null };
const CARRIES_NOTHING: Branch = { causes: [], stalled: true, stall: null };

/**
 * Follow one unmet edge back to the behaviour nodes it rests on.
 *
 * `wants` is the guard the leaf has to have fired, threaded down unchanged until a nearer edge
 * carries its own. Only a `decision` out-edge may carry one (S5), so this is how a leaf three
 * hops below a diamond is still told which resolution the arm was asking for.
 */
function walk(graph: Graph, edge: Edge, wants: string | null, seen: Set<string>): Branch {
  const source = graph.nodes.get(edge.from);
  if (source === undefined) {
    return { causes: [missingCause(edge.from, wants)], stalled: true, stall: null };
  }

  if (isBehaviour(source)) {
    const cause = causeFor(source, wants);
    return { causes: [cause], stalled: isPermanent(cause), stall: null };
  }

  // A cycle is mutual dependency, not proof of anything. S6 forbids one, but this runs on
  // graphs nothing has validated — a torn log, a hand-built shape — so the walk has to be
  // total, and stopping without a verdict is the conservative stop.
  if (seen.has(source.id)) return OPEN;
  seen.add(source.id);
  return through(graph, source, edge, wants, seen);
}

/**
 * The per-type rule for a control node, over its own LIVE in-edges (D5) — the mirror of core's
 * `controlSatisfied` and `controlDead`, restated for causes instead of for booleans.
 *
 * Written per type rather than as one loop with a flag, for the reason core writes it that way:
 * `some` and `every` disagree on the empty case in the dangerous direction, and a `join` and a
 * `merge` differ by exactly that word.
 */
function through(
  graph: Graph,
  control: ActivityNode,
  out: Edge,
  wants: string | null,
  seen: Set<string>,
): Branch {
  const ins = liveIn(graph, control.id);
  /** Walk an arm only if it is not already met — a satisfied arm blocks nobody. */
  const arm = (edge: Edge): Branch =>
    isEdgeSatisfied(graph, edge) ? OPEN : walk(graph, edge, guardLabel(edge) ?? wants, seen);

  switch (control.type) {
    case "initial":
      // Where the flow starts. It is satisfied from the first commit, so it is never reached
      // through an unmet edge, and nothing upstream of it exists to blame.
      return OPEN;

    case "fork":
      // A fork carries its one in-edge to every arm unchanged, so it blocks exactly when that
      // edge does.
      return combine(ins.map(arm), (arms) => arms.length > 0 && arms.every(isStalled));

    case "merge":
      // Disjunctive: every alternative has to be over before the merge is. This is the half the
      // old `some` got backwards, and the half that reported live work as hung.
      return combine(ins.map(arm), (arms) => arms.length > 0 && arms.every(isStalled));

    case "join": {
      // Conjunctive: one arm that can never satisfy parks the join forever — the state rule 11
      // exists for, so it is recorded here together with the arm that caused it.
      const arms = ins.map(arm);
      const branch = combine(arms, (parts) => parts.some(isStalled));
      if (!branch.stalled) return branch;
      // The deepest join wins: a nested one names a smaller and more specific region.
      const blocker = arms.find(isStalled);
      return {
        ...branch,
        stall: branch.stall ?? { join: control, blockers: blocker?.causes ?? [] },
      };
    }

    case "decision": {
      // Exactly one arm fires, so every OTHER arm is dead the moment one does — and none is
      // dead before that. An arm that did not fire is explained by the node that ROUTES the
      // decision and never by the diamond, which is why every live in-edge is walked here even
      // when its own edge is satisfied: the edge is met, the arm still did not fire, and what
      // the reader needs is the resolution that took the other one.
      const arms = ins.map((edge) => walk(graph, edge, guardLabel(edge) ?? wants, seen));
      return combine(
        arms,
        (parts) => isEdgeDead(graph, out) || (parts.length > 0 && parts.every(isStalled)),
      );
    }

    default:
      // `final` and `flow_final` absorb; §6.2's arity gives them no out-edge, so reaching here
      // means the graph wired one anyway and the honest answer is that it carries nothing.
      return CARRIES_NOTHING;
  }
}

function combine(arms: Branch[], stalled: (arms: Branch[]) => boolean): Branch {
  const over = stalled(arms);
  return {
    causes: arms.flatMap((branch) => branch.causes),
    stalled: over,
    // A stall below is only news while the path it is on is itself over: a merge with one live
    // alternative left is not blocked by the dead one, and reporting the join beneath it would
    // tell a reader the pursuit is finished while the store is still driving it.
    stall: over ? arms.reduce<Stall | null>((found, arm) => found ?? arm.stall, null) : null,
  };
}

function isStalled(branch: Branch): boolean {
  return branch.stalled;
}

/**
 * A control node's in-edges, minus the ones a supersede took out of the live graph (D5).
 *
 * Core's own `liveIn`, which it does not export. A superseded node keeps its edges — nothing is
 * ever deleted — so without this, replacing one step upstream would read as a permanently
 * unsatisfiable arm on every join below it.
 */
function liveIn(graph: Graph, id: string): Edge[] {
  return inEdges(graph, id).filter(
    (edge) => graph.nodes.get(edge.from)?.provenance.superseded_by == null,
  );
}

/**
 * Every behaviour node an edge ultimately rests on, met or not — §6.5's traversal, stopping at
 * the first behaviour node on each path.
 *
 * This is the denominator, and it is why the denominator is no longer the in-edge count: one
 * in-edge from a join can carry four dependencies, and `2 of 1 dependencies unmet` is not a
 * sentence.
 */
function dependenciesOf(graph: Graph, edge: Edge, seen: Set<string>): string[] {
  const source = graph.nodes.get(edge.from);
  if (source === undefined) return [edge.from];
  if (isBehaviour(source)) return [source.id];
  if (seen.has(source.id)) return [];
  seen.add(source.id);
  return liveIn(graph, source.id).flatMap((into) => dependenciesOf(graph, into, seen));
}

/** The same behaviour node can be reached down two paths; a reader needs it once. */
function distinct(causes: BlockedCause[]): BlockedCause[] {
  const seen = new Set<string>();
  return causes.filter((cause) => {
    const key = `${cause.from} ${cause.wants ?? ""} ${cause.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The one line a card renders, in precedence order.
 *
 * A parked join outranks the counts because of rule 11: `3 of 4 dependencies unmet` is a true
 * sentence about a join that will never complete, and it reads exactly like one that is merely
 * waiting. Telling those two apart is the whole of the rule, so it takes the line.
 */
function summaryOf(causes: BlockedCause[], dependencies: Set<string>, stall: Stall | null): string {
  if (stall !== null) return stallLine(stall);

  const [only] = causes;
  // Nothing unmet, and yet not `ready`: readiness is derived at commit (§6.2.1), so a log
  // written by an older store — or one read between the two halves of a commit — can say
  // exactly this. Silence would read as a bug in the viewer; it is a fact about the log.
  if (only === undefined) return "no unmet dependency — the store has not lifted this to ready";
  if (causes.length === 1) return only.text;
  // The walk can reach one node down two guarded arms, so the denominator is floored at the
  // number of causes it has to explain rather than reading `3 of 2`.
  return `${causes.length} of ${Math.max(dependencies.size, causes.length)} dependencies unmet`;
}

/** Rule 11 — "render that state distinctly, with the failed node named". */
function stallLine(stall: Stall): string {
  const [first] = stall.blockers;
  if (first === undefined) return `${stall.join.name} can never complete`;
  if (stall.blockers.length === 1) return `${stall.join.name} can never complete — ${first.text}`;
  const names = stall.blockers.map((cause) => cause.fromLabel);
  const last = names[names.length - 1] ?? "";
  return `${stall.join.name} can never complete — ${names.slice(0, -1).join(", ")} and ${last} can never satisfy it`;
}

/**
 * Classify one unmet dependency. The order of the tests is the order of the facts: whether the
 * source exists at all, then what happened to it, and only for a source that finished
 * successfully is the guard the thing that failed.
 *
 * The two abandoned states are checked before the guard because they are the answer even when
 * the guard would also have failed — §6.4's readiness fails safe, so an abandoned source never
 * satisfies anything, and saying "it fired the wrong resolution" would imply that a different
 * resolution was still on the table. They share one `kind` and take two sentences: both are
 * over, and §6.2.1 splits the states because a reader cares enormously which — "the flow went
 * elsewhere" is not "somebody was working this and we pulled the plug".
 */
function causeFor(source: ActivityNode, wants: string | null): BlockedCause {
  const label = source.name;
  const fired = resolutionOf(source);
  const base = { from: source.id, fromLabel: label, wants, fired };

  if (source.status?.state === "withdrawn") {
    return { ...base, kind: "withdrawn", text: `${label} was dropped and can never satisfy this` };
  }
  if (source.status?.state === "terminated") {
    return {
      ...base,
      kind: "withdrawn",
      text: `${label} was stopped before it finished and can never satisfy this`,
    };
  }
  if (source.status?.state === "failed") {
    return { ...base, kind: "failed", text: `${label} failed and can never satisfy this` };
  }
  if (source.status === undefined || !isTerminal(source.status.state)) {
    return { ...base, kind: "not-finished", text: `${label} ${pending(source)}` };
  }
  // Terminal success, so what is unmet is the guard this arm was asking for.
  return { ...base, kind: "wrong-resolution", text: mismatch(source, fired, wants) };
}

function missingCause(id: string, wants: string | null): BlockedCause {
  // No activity, so no name: the id is the only handle we can honestly print.
  return {
    from: id,
    fromLabel: id,
    wants,
    fired: null,
    kind: "missing",
    text: `${id} is missing from the graph`,
  };
}

/** An `accept_event` is answered by somebody; an `action` is finished by somebody. */
function answers(type: string): boolean {
  return type === "accept_event";
}

/** What "not finished" means depends on what the activity is doing, and a reader can tell. */
function pending(source: ActivityNode): string {
  if (source.status?.state === "active") return "is still in flight";
  return answers(source.type) ? "has not answered yet" : "has not finished yet";
}

function mismatch(source: ActivityNode, fired: string | null, wants: string | null): string {
  const verb = answers(source.type) ? "answered" : "resolved";
  const needs = wants === null ? "a resolution" : wants;
  if (fired === null) {
    return `${source.name} finished without a resolution, this edge needs ${needs}`;
  }
  return `${source.name} ${verb} ${fired}, this edge needs ${needs}`;
}

/**
 * Can this cause still turn into a satisfied edge?
 *
 * An abandoned, failed or missing source is over — a terminal state is permanent (invariant 1
 * refuses `set_status` on a head-terminal node) and only `completed` ever satisfies one. A
 * wrong resolution is over only once the source has actually resolved: §6.7 makes the resolving
 * outcome append-only and first-wins, so it can never be traded for the one this arm wanted. A
 * `completed` source with no resolution yet is a different matter — `record_outcome` is legal
 * against a terminal activity (§6.4), so that edge may still come good and must not be called
 * dead.
 */
function isPermanent(cause: BlockedCause): boolean {
  if (cause.kind === "wrong-resolution") return cause.fired !== null;
  return cause.kind === "withdrawn" || cause.kind === "failed" || cause.kind === "missing";
}
