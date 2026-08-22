/**
 * The quorum counter: §6.2's `{count:{verdict,attrs}, op, n}`, evaluated against the graph.
 *
 * A `wait{match:"predicate"}` is the one node whose state cannot be read off the node itself —
 * it lives in the outcomes of the nodes feeding it, and the reader's actual question is "how
 * many more answers do we need, and can they still arrive?". Rule 4 requires that number on
 * the node, so it is computed once, here, rather than by whichever component happens to be
 * rendering.
 *
 * The predicate block is `unknown` in core's schema (§6.5 leaves it open so predicates can
 * grow), which makes this the one model function that has to parse rather than read. It parses
 * defensively on purpose: a predicate shape we do not recognise must render as an unmet count
 * with the problem named, never as a thrown exception that takes the whole canvas down with
 * it. D5 — unknown shapes render as detail, they do not throw.
 */

import type { Graph, Node, OutcomeRecord } from "@kona/core";
import { inEdges, isTerminal, satisfiesBlockingEdge } from "@kona/core";
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
function predicateBlockOf(node: Node): unknown {
  const conditions = node.spec.match?.conditions ?? [];
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
 * `count confirmed role=goalie >= 1`. Built from the block, never from a table of node ids.
 */
export function predicateMatchLabel(node: Node): string | null {
  const parsed = parseQuorum(predicateBlockOf(node));
  if (!parsed.ok) return null;
  const { quorum } = parsed;
  const attrs = Object.entries(quorum.attrs).map(([k, v]) => `${k}=${renderValue(v)}`);
  return ["count", quorum.verdict, ...attrs, quorum.op, String(quorum.n)].join(" ");
}

/**
 * Non-null only for a `wait{match:"predicate"}`.
 *
 * The population is the sources of this node's blocking in-edges — with one edge kind (§6.2)
 * every in-edge is blocking, so `inEdges` is the population and there is nothing to filter.
 * A source contributes on its recorded outcome, not on its edge condition: `declined` fires
 * the same `satisfied` edge as `confirmed` (see `resolutionOf`), and the whole point of the
 * counter is to tell those two apart.
 */
export function predicateCount(graph: Graph, node: Node): PredicateCount | null {
  if (node.spec.match?.kind !== "predicate") return null;

  const sources = inEdges(graph, node.id)
    .map((edge) => graph.nodes.get(edge.from))
    .filter((source): source is Node => source !== undefined);

  // `live` is independent of whether the predicate itself parses, so it is worth computing
  // even for a malformed one: a reader still wants to know whether anyone can still answer.
  //
  // `isTerminal` alone is the wrong test, and wrong in the direction that understates the
  // odds: §6.4 makes `record_outcome` legal against a terminal node, so a source that is
  // `done` without a resolving outcome can still answer this quorum. `blocked.ts` reasons
  // exactly that way about the identical situation — its `isPermanent` refuses to call a
  // `done`-without-resolution edge dead — and the two must not disagree about one node.
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

  const parsed = parseQuorum(predicateBlockOf(node));
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
