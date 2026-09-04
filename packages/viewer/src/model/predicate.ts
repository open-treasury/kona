/**
 * The quorum counter: §6.2's `{count:{verdict,attrs}, op, n}`, evaluated against the graph.
 *
 * A `wait{match:"predicate"}` is the one activity whose state cannot be read off the activity itself —
 * it lives in the outcomes of the activities feeding it, and the reader's actual question is "how
 * many more answers do we need, and can they still arrive?". Rule 4 requires that number on
 * the activity, so it is computed once, here, rather than by whichever component happens to be
 * rendering.
 *
 * The predicate block is `unknown` in core's schema (§6.5 leaves it open so predicates can
 * grow), which makes this the one model function that has to parse rather than read. It parses
 * defensively on purpose: a predicate shape we do not recognise must render as an unmet count
 * with the problem named, never as a thrown exception that takes the whole canvas down with
 * it. D5 — unknown shapes render as detail, they do not throw.
 */

import type {
  AcceptEventNode,
  BehaviourNode,
  Graph,
  ActivityNode,
  Edge,
  OutcomeRecord,
} from "@kona/core";
import { inEdges, isBehaviour, isEdgeDead, isTerminal, satisfiesBlockingEdge } from "@kona/core";
import type { PredicateCount } from "./types.ts";

/** The parsed shape. Everything is widened to the primitive we can actually check. */
interface Quorum {
  verdict: string;
  attrs: Record<string, unknown>;
  op: string;
  n: number;
}

type ParseResult = { ok: true; quorum: Quorum } | { ok: false; problem: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pull the predicate block out of the match conditions. §6.5 hangs it off a condition rather
 * than off the match, so a wait could in principle carry several; the first one wins, because
 * a second would be a second answer to the same question and the store does not emit one.
 */
function predicateBlockOf(activity: ActivityNode): unknown {
  if (activity.type !== "accept_event") return undefined;
  const conditions = activity.spec.match?.conditions ?? [];
  for (const condition of conditions) {
    if (condition.predicate !== undefined) return condition.predicate;
  }
  return undefined;
}

function parseQuorum(block: unknown): ParseResult {
  if (block === undefined) return { ok: false, problem: "no condition carries a predicate" };
  if (!isRecord(block)) return { ok: false, problem: "predicate is not an object" };

  const count = block["count"];
  if (!isRecord(count)) return { ok: false, problem: "predicate has no count block" };

  const verdict = count["verdict"];
  if (typeof verdict !== "string") {
    return { ok: false, problem: "predicate count has no verdict" };
  }

  const rawAttrs = count["attrs"];
  if (rawAttrs !== undefined && !isRecord(rawAttrs)) {
    return { ok: false, problem: "predicate count attrs is not an object" };
  }

  const op = block["op"];
  if (typeof op !== "string") return { ok: false, problem: "predicate has no op" };

  const n = block["n"];
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return { ok: false, problem: "predicate threshold n is not a number" };
  }

  return { ok: true, quorum: { verdict, attrs: rawAttrs ?? {}, op, n } };
}

/** `null` means "an operator we do not implement" — distinct from "false". */
function compare(have: number, op: string, need: number): boolean | null {
  switch (op) {
    case ">=":
      return have >= need;
    case ">":
      return have > need;
    case "==":
      return have === need;
    case "<=":
      return have <= need;
    case "<":
      return have < need;
    default:
      return null;
  }
}

function renderValue(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

/**
 * Every key the predicate asks for must be present and equal. Absent `attrs` on the outcome
 * therefore matches only an empty filter — a counterparty who answered without saying in what
 * role has not answered the question the quorum asked.
 */
function attrsMatch(want: Record<string, unknown>, outcome: OutcomeRecord): boolean {
  const entries = Object.entries(want);
  if (entries.length === 0) return true;
  const got = outcome.attrs;
  if (got === undefined) return false;
  return entries.every(([key, value]) => {
    if (!Object.hasOwn(got, key)) return false;
    const actual = got[key];
    // Object.is covers primitives; the structural fallback keeps a nested attr honest.
    return Object.is(actual, value) || JSON.stringify(actual) === JSON.stringify(value);
  });
}

function chipLabel(quorum: Quorum): string {
  const attrs = Object.entries(quorum.attrs).map(([k, v]) => `${k}=${renderValue(v)}`);
  return [quorum.verdict, ...attrs].join(" · ");
}

/**
 * One line naming what the quorum is counting, for the wait's match chip:
 * `count confirmed role=goalie >= 1`. Built from the block, never from a table of activity ids.
 */
export function predicateMatchLabel(activity: ActivityNode): string | null {
  const parsed = parseQuorum(predicateBlockOf(activity));
  if (!parsed.ok) return null;
  const { quorum } = parsed;
  const attrs = Object.entries(quorum.attrs).map(([k, v]) => `${k}=${renderValue(v)}`);
  return ["count", quorum.verdict, ...attrs, quorum.op, String(quorum.n)].join(" ");
}

/**
 * A control node's in-edges, minus the ones a supersede has taken out of the live graph — the
 * same filter core applies before it judges a merge or a join, and here for the same reason.
 * Nothing is ever deleted (§6.3), so a superseded node keeps its edges and a superseded source
 * is abandoned; one abandoned arm kills a join, so without this, replacing a step would empty
 * the population of every quorum behind the join it fed.
 */
function liveIn(graph: Graph, id: string): Edge[] {
  return inEdges(graph, id).filter(
    (edge) => graph.nodes.get(edge.from)?.provenance.superseded_by == null,
  );
}

/**
 * The behaviour nodes whose answers this quorum counts, walked THROUGH the control nodes
 * between them and the wait.
 *
 * The population used to be `inEdges(wait)` outright, on the grounds that with one edge kind
 * every in-edge is blocking and so there was nothing to filter. That was true while a
 * convergence was a fan-in of behaviour nodes straight onto one wait. §6.2's arity ends it: an
 * `accept_event` has exactly ONE in-edge, and every convergence now goes through an explicit
 * `merge` or `join`. So the sole in-edge of a quorum wait comes from a **control node**, which
 * has no status and no outcome and can therefore never answer anything — the counter read
 * `0 of N` forever, and `live` counted the diamond itself as one more answer still to come.
 *
 * A control node is not an answer: it is skipped without being counted, and the walk carries on
 * to the behaviour nodes underneath it.
 *
 * WHICH of those still count is core's question, not a second one asked here. `isEdgeDead`
 * carries §6.4 across a control node with the asymmetry that matters — **disjunctive** for a
 * `merge` (dead only once every alternative is dead) and **conjunctive** for a `join` (one dead
 * arm is enough, because the join can never complete without it). So a join one of whose arms a
 * decision has routed away carries nobody at all, while a merge in the same position still
 * carries the arm that lived. A second traversal invented here is how the chip and the store
 * come to disagree about one edge.
 *
 * A behaviour source is kept whatever its state and judged below on its own status and outcome,
 * exactly as before: the walk changes what the population IS, never how a member is counted.
 */
function populationOf(graph: Graph, wait: AcceptEventNode): BehaviourNode[] {
  // The population is BEHAVIOUR nodes: control nodes are traversed on the way to them and
  // never counted. A diamond is not an answer, and counting one as "still live" would keep a
  // quorum reading satisfiable on evidence that can never arrive. `gather` walks through them;
  // this is where they stop being members.
  const members = new Map<string, BehaviourNode>();
  const walked = new Set<string>();
  for (const edge of inEdges(graph, wait.id)) gather(graph, edge, members, walked);
  return [...members.values()];
}

function gather(
  graph: Graph,
  edge: Edge,
  members: Map<string, ActivityNode>,
  walked: Set<string>,
): void {
  const source = graph.nodes.get(edge.from);
  if (source === undefined) return;

  // Keyed by id: a fork that rejoins reaches the same behaviour node down two paths, and one
  // counterparty who answered once is one answer, not two. Insertion order is edge order,
  // which §6.1 makes the one stable order in the system, so `contributors` does not reshuffle.
  if (isBehaviour(source)) {
    members.set(source.id, source);
    return;
  }

  // A cycle is mutual dependency, not proof of anything. S6 forbids one, but this runs against
  // graphs nothing has validated — and a control node visited twice adds nobody a first visit
  // did not, so stopping costs nothing and keeps the walk total.
  if (walked.has(source.id)) return;
  walked.add(source.id);

  // Nothing can ever come this way: a join with a dead arm, a decision's untaken arm, a merge
  // whose every alternative is dead. Counting the answers stranded behind it would paint
  // `1/1 met` on a wait the store will never make ready — the quorum chip and the blocked
  // reason on the very next card disagreeing about the same edge.
  if (isEdgeDead(graph, edge)) return;

  for (const inner of liveIn(graph, source.id)) gather(graph, inner, members, walked);
}

/**
 * Non-null only for a `wait{match:"predicate"}`.
 *
 * The population is `populationOf` — the behaviour nodes feeding this wait, through whatever
 * control nodes stand between. A source contributes on its recorded outcome, not on its edge
 * condition: `declined` fires the same `satisfied` edge as `confirmed` (see `resolutionOf`),
 * and the whole point of the counter is to tell those two apart.
 */
export function predicateCount(graph: Graph, activity: ActivityNode): PredicateCount | null {
  if (activity.type !== "accept_event" || activity.spec.match.kind !== "predicate") return null;

  const sources = populationOf(graph, activity);

  // `live` is independent of whether the predicate itself parses, so it is worth computing
  // even for a malformed one: a reader still wants to know whether anyone can still answer.
  //
  // `isTerminal` alone is the wrong test, and wrong in the direction that understates the
  // odds: §6.4 makes `record_outcome` legal against a terminal activity, so a source that is
  // `completed` without a resolving outcome can still answer this quorum. `blocked.ts` reasons
  // exactly that way about the identical situation — its `isPermanent` refuses to call a
  // `completed`-without-resolution edge dead — and the two must not disagree about one activity.
  //
  // What is genuinely over is a source that finished WITHOUT succeeding (`satisfiesBlockingEdge`,
  // §6.4's fail-safe rule), and a source that has already given its resolving answer, which
  // §6.7 makes first-wins and final.
  //
  // The outcome test comes FIRST and applies to open sources too. §6.7 makes the resolving
  // outcome append-only and first-wins, so a source that has answered has answered, whether or
  // not the store has got round to closing it — and `record_outcome` without `set_status` is a
  // legal batch. Testing terminality first counted such a source as one more answer still to
  // come, which tells the reader the quorum has more chances than it has.
  const live = sources.filter(
    (source) =>
      source.status.outcome === null &&
      (!isTerminal(source.status.state) || satisfiesBlockingEdge(source)),
  ).length;

  const parsed = parseQuorum(predicateBlockOf(activity));
  if (!parsed.ok) {
    return {
      have: 0,
      need: 0,
      op: "",
      live,
      met: false,
      label: `unreadable predicate: ${parsed.problem}`,
      contributors: [],
    };
  }

  const { quorum } = parsed;
  const contributors = sources
    .filter((source) => {
      // §6.4: a dropped source never satisfies readiness, and a failed one satisfies nothing
      // either. Counting what it said before the store abandoned it renders `1/1 met` on a
      // branch that is dead — the quorum chip and the blocked reason on the very next card
      // disagreeing about the same edge. `satisfiesBlockingEdge` is the store's own test, so
      // the counter and `isEdgeSatisfied` draw the population the same way.
      if (!satisfiesBlockingEdge(source)) return false;
      const outcome = source.status.outcome;
      if (outcome === null) return false;
      if (outcome.verdict !== quorum.verdict) return false;
      return attrsMatch(quorum.attrs, outcome);
    })
    .map((source) => source.id);

  const have = contributors.length;
  const met = compare(have, quorum.op, quorum.n);
  const base = chipLabel(quorum);

  return {
    have,
    need: quorum.n,
    op: quorum.op,
    live,
    met: met ?? false,
    label: met === null ? `${base} — unsupported operator '${quorum.op}'` : base,
    contributors,
  };
}
