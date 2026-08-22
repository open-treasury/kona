/**
 * Why a node is not running.
 *
 * §6.10 rule 4 asks every node to render its own state inline, and "for a blocked node the
 * reason as text". That sentence is the whole module: a red ring around a node tells a reader
 * that something is wrong and nothing about what, so they go and read the log by hand, which
 * is the failure this viewer exists to prevent.
 *
 * Every judgment here is delegated to `@kona/core` — `isReady`, `isEdgeSatisfied`,
 * `resolutionOf`. A second opinion computed locally would eventually disagree with the store,
 * and then the canvas would show work as available that `kona` refuses to dispatch. What this
 * module adds is only the *explanation*: core answers "no", and we walk the same in-edges core
 * walked to say which ones, and whether any of them can ever change.
 */

import type { Edge, Graph, Node } from "@kona/core";
import { inEdges, isEdgeSatisfied, isReady, isTerminal, resolutionOf } from "@kona/core";
import type { BlockedCause, BlockedReason, Readiness } from "./types.ts";

/**
 * The five answers, in precedence order — the order is the interesting part.
 *
 * `superseded` outranks everything, including `settled`, because supersede is about the
 * node's standing rather than its state: a superseded node can still be `active`, and the
 * only honest label for it is "replaced". Trusting `status.state` there would put work
 * nobody intends to do back in front of the reader as live; falling through to `isReady`
 * would call it blocked and demand a reason for a step that has already been answered by its
 * replacement. And a node that is `done` *and* superseded — which is what the fixture's
 * roster step is — should read as replaced, not merely finished, because the replacement is
 * the thing the reader needs to follow.
 *
 * `running` sits between `settled` and `ready` because `sending` is deliberately not terminal
 * (§6.2): the real world's answer is unknown, so it is neither finished nor available.
 */
export function readinessOf(graph: Graph, node: Node): Readiness {
  if (node.provenance.superseded_by !== null) return "superseded";
  if (isTerminal(node.status.state)) return "settled";
  if (node.status.state === "sending") return "running";
  if (isReady(graph, node)) return "ready";
  return "blocked";
}

/**
 * One cause per unsatisfied in-edge, in edge order, or null when the node is not blocked.
 *
 * Edge order rather than any ranking, because §6.1 makes append order the one stable order in
 * the system; sorting by severity would reshuffle the list on a status tick and lose the
 * reader's place.
 */
export function blockedReason(graph: Graph, node: Node): BlockedReason | null {
  if (readinessOf(graph, node) !== "blocked") return null;

  const edges = inEdges(graph, node.id);
  const causes = edges
    .filter((edge) => !isEdgeSatisfied(graph, edge))
    .map((edge) => causeFor(graph, edge));

  const [only] = causes;
  return {
    summary:
      causes.length === 1 && only !== undefined
        ? only.text
        : `${causes.length} of ${edges.length} dependencies unmet`,
    causes,
    // ONE permanently dead in-edge is already fatal, because `isReady` asks for EVERY
    // in-edge to be satisfied: the node can never reach the frontier again, whatever the
    // other blockers do next. `every` would be the right answer for a `merge:"any"` node —
    // and `spec.merge` does exist in the schema — but grep `core` for it: nothing reads it,
    // `isReady` least of all. Answering `every` here would render a semantics the store does
    // not have, and would paint an already-dead branch as merely waiting. That is the silent
    // hang this field exists to name.
    unreachable: causes.some(isPermanent),
  };
}

/**
 * Classify one unsatisfied edge. The order of the tests is the order of the facts: whether
 * the source exists at all, then what happened to it, and only for a source that finished
 * successfully is the edge's condition the thing that failed.
 *
 * `dropped` and `failed` are checked before the condition because they are the answer even
 * when the condition would also have failed — §6.4's readiness fails safe, so a dropped
 * source never satisfies anything, and saying "it fired the wrong resolution" would imply
 * that a different resolution was still on the table.
 */
function causeFor(graph: Graph, edge: Edge): BlockedCause {
  const wants = edge.condition?.on ?? null;
  const source = graph.nodes.get(edge.from);

  if (source === undefined) {
    // No node, so no label: the id is the only name we can honestly print.
    return {
      from: edge.from,
      fromLabel: edge.from,
      wants,
      fired: null,
      kind: "missing",
      text: `${edge.from} is missing from the graph`,
    };
  }

  const label = source.label;
  const fired = resolutionOf(source);
  const base = { from: edge.from, fromLabel: label, wants, fired };

  if (source.status.state === "dropped") {
    return { ...base, kind: "dropped", text: `${label} was dropped and can never satisfy this` };
  }
  if (source.status.state === "failed") {
    return { ...base, kind: "failed", text: `${label} failed and can never satisfy this` };
  }
  if (!isTerminal(source.status.state)) {
    return { ...base, kind: "not-finished", text: `${label} ${pending(source)}` };
  }
  // `done`, so the edge is conditional and the condition is what did not match.
  return { ...base, kind: "wrong-resolution", text: mismatch(source, fired, wants) };
}

/** What "not finished" means depends on what the node is doing, and a reader can tell. */
function pending(source: Node): string {
  if (source.status.state === "sending") return "is still sending";
  return source.type === "wait" ? "has not answered yet" : "has not finished yet";
}

function mismatch(source: Node, fired: string | null, wants: string | null): string {
  const verb = source.type === "wait" ? "answered" : "resolved";
  const needs = wants === null ? "a resolution" : wants;
  if (fired === null) {
    return `${source.label} finished without a resolution, this edge needs ${needs}`;
  }
  return `${source.label} ${verb} ${fired}, this edge needs ${needs}`;
}

/**
 * Can this cause still turn into a satisfied edge?
 *
 * A dropped, failed or missing source is over. A wrong resolution is over only once the
 * source has actually resolved — §6.7 makes the resolving outcome append-only and
 * first-wins, so it can never be traded for the one this edge wanted. A `done` source with
 * no resolution yet is a different matter: `record_outcome` is legal against a terminal node
 * (§6.4), so that edge may still come good and must not be called dead.
 */
function isPermanent(cause: BlockedCause): boolean {
  if (cause.kind === "wrong-resolution") return cause.fired !== null;
  return cause.kind === "dropped" || cause.kind === "failed" || cause.kind === "missing";
}
