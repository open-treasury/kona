/**
 * Where the activities sit — and, the part that actually matters, when we are allowed to work that
 * out again.
 *
 * §6.10 rule 2: memoise dagre and never re-lay-out on a status tick. Status ticks are the
 * common case — a reply lands, an activity goes `completed`, a predicate ticks up — and re-ranking the
 * whole graph on each one is what froze Burr's graph view. The fan-out is where it bites: one
 * `wait` gaining an outcome would re-rank its siblings, every box would shift a few pixels,
 * and the canvas would crawl under a reader who is trying to read it.
 *
 * So the memo key is a TOPOLOGY SIGNATURE, not `graph.version` (D3). The version bumps on a
 * status tick too — fixture v3 and v4 carry nothing but statuses, outcomes and outputs — so
 * keying on it would re-lay-out at exactly the moment the rule forbids.
 */

import { graphlib, layout as dagreLayout } from "@dagrejs/dagre";
import type { EdgeLabel, GraphLabel, NodeLabel } from "@dagrejs/dagre";
import type { Graph, NodeType } from "@kona/core";
import { END_MARKER_ID, START_MARKER_ID, flowTerminals, viewEdges } from "../model/edges.ts";
import { guardKey } from "../model/guard.ts";

/** A placed activity, in React Flow's coordinates: `x`/`y` are the TOP-LEFT corner. */
export interface NodeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Layout {
  /** Insertion order, so anything that iterates it gets rule 7's visual order for free. */
  boxes: Map<string, NodeBox>;
  /**
   * The two notation circles, placed by the same pass so their arrows are short and land where
   * the eye expects. Deliberately a SEPARATE map from `boxes`: they are not pursuit activities, and
   * anything counting or iterating the graph's activities must not pick them up by accident.
   */
  markers: Map<string, NodeBox>;
  width: number;
  height: number;
  /** The key this layout was computed under, carried on the value so a cache cannot mis-pair
   *  a signature with someone else's geometry. */
  signature: string;
}

/**
 * Fixed sizes. Nothing is measured, ever — rule 7 wants a deterministic layout, and measuring
 * the DOM makes the geometry a function of the reader's installed fonts: the same log would
 * lay out differently on two machines, and a webfont swapping in mid-render would move every
 * activity after the reader had started reading.
 *
 * Fixed **per type** rather than per card — which is the constraint that
 * shapes the card, so it is worth stating plainly.
 *
 * A card that grew to fit its content would be the obvious thing and it would break rule 2. Its
 * height would then depend on the blocked reason and the recorded outcome, both of which appear
 * and vanish on a *status* tick — so a reply landing would change a box, change the layout, and
 * re-rank the whole graph. That is precisely the freeze this module exists to prevent.
 *
 * So each type reserves its worst case instead: a task is a title row plus ONE detail row
 * (blocked reason, or the verdict, or nothing), and a wait is a title row plus the match line
 * plus that same detail row. The countdown does not need a row of its own — it rides in the
 * trailing slot on the title, the way a duration does in a GitHub Actions run graph.
 *
 * Measured against the 31-arm pursuit: this takes the graph from 5216px tall to about 3300, so
 * `fitView`'s legibility floor now shows about sixteen arms rather than ten (kona-e6-8h7.10).
 */
/** A bar shorter than this reads as a tick rather than as a synchronisation mark. */
const BAR_MIN_HEIGHT = 44;

/** Room per arm, matched to `nodesep` so the bar spans the arms rather than crowding them. */
const BAR_ARM_PITCH = 22;

export const ACTIVITY_SIZE: Readonly<Record<NodeType, { width: number; height: number }>> = {
  // Behaviour nodes: cards. `accept_event` is taller because it carries a match line.
  action: { width: 300, height: 62 },
  accept_event: { width: 300, height: 82 },

  // Control nodes: glyphs, sized as punctuation rather than as steps. The box IS the glyph
  // (see MARKER_SIZE below), so these dimensions are the drawn mark, not a bounding pad.
  initial: { width: 20, height: 20 },
  final: { width: 20, height: 20 },
  flow_final: { width: 20, height: 20 },
  decision: { width: 44, height: 44 },
  merge: { width: 44, height: 44 },

  /**
   * A fork/join bar is a narrow VERTICAL rule in `rankdir: "LR"`, and its LENGTH follows its
   * arm count — see `sizeOf` below.
   *
   * That looks at first like the thing this module refuses to do. It is not: "nothing is
   * measured, ever" is about not letting geometry depend on RENDER, because a measured height
   * makes the layout a function of the DOM and reintroduces the race that loses every edge.
   * Arm count is not a measurement — it is a property of the graph, known before dagre runs
   * and identical on every machine. A constant bar was the wrong reading of the rule: with
   * more than about four arms the edges converge outside the bar's own length, and a fork that
   * its own arrows miss is not notation, it is a stray mark.
   */
  fork: { width: 8, height: BAR_MIN_HEIGHT },
  join: { width: 8, height: BAR_MIN_HEIGHT },
};

/**
 * The initial and final circles. Small enough to read as punctuation rather than as a step.
 *
 * The box IS the circle, and that is load-bearing: React Flow attaches an edge at the handle,
 * which sits on the box edge, so any padding between the box and the drawn circle shows up as
 * a gap between the arrow and the mark it is pointing at.
 */
export const MARKER_SIZE = { width: 20, height: 20 } as const;
export const COLLAPSED_GROUP_SIZE = { width: 220, height: 72 } as const;

/**
 * Everything the picture is a function of, and nothing else.
 *
 * Ids come out in insertion order because rule 7 pins visual order to it — a reordering really
 * would be a different picture. `type` is in because it picks the box size. `superseded_by` is
 * in because `supersede_node` is a topology op: it retires an activity in favour of another, and a
 * retired activity is not drawn as a live one. Folding it in buys a re-layout on a supersede, which
 * is a shape change a reader should watch move.
 *
 * Deliberately absent: `state`, `outcome`, `output`, `conditions`, `effect_log`,
 * `observed_at_version` and the graph version. Those are exactly what a status tick moves, and
 * a status tick must not move an activity.
 *
 * ActivityNode ids are `[a-z0-9][a-z0-9-]*` (§6.2), so `:`, `>` and a newline cannot occur inside one
 * and the encoding needs no escaping to stay unambiguous.
 */
export function topologySignature(
  graph: Graph,
  collapsed: ReadonlySet<string> = new Set(),
): string {
  const parts: string[] = [];
  for (const activity of graph.nodes.values()) {
    parts.push(`n:${activity.id}:${activity.type}:${activity.provenance.superseded_by ?? ""}`);
  }
  for (const edge of graph.edges) {
    parts.push(`e:${edge.from}>${edge.to}>${guardKey(edge)}`);
  }
  for (const id of collapsed) parts.push(`c:${id}`);
  return parts.join("\n");
}

export function layoutGraph(graph: Graph, collapsed: ReadonlySet<string> = new Set()): Layout {
  return runDagre(graph, topologySignature(graph, collapsed), collapsed);
}

/**
 * The memo. One slot: the viewer lays out one graph, the head one, and re-lays it when the
 * file changes.
 *
 * It hands back the SAME object, not an equal one. React re-renders on identity, so returning
 * a fresh but deeply-equal `Layout` would defeat the memo at the only layer where it pays —
 * every activity would re-render on every status tick even though not one of them moved.
 */
export function createLayoutCache(): (graph: Graph, collapsed?: ReadonlySet<string>) => Layout {
  let cached: Layout | null = null;
  return (graph: Graph, collapsed: ReadonlySet<string> = new Set()): Layout => {
    const signature = topologySignature(graph, collapsed);
    if (cached !== null && cached.signature === signature) return cached;
    cached = runDagre(graph, signature, collapsed);
    return cached;
  };
}

/**
 * The box for one node. Fixed per type, except a bar, whose length follows its arm count.
 *
 * Exported because the canvas needs the identical answer: dagre places the graph with these
 * boxes and React Flow draws with them, and a disagreement between the two puts every edge on
 * a bar at the wrong end of it.
 */
export function sizeOf(
  graph: Graph,
  node: { id: string; type: NodeType },
): {
  width: number;
  height: number;
} {
  const base = ACTIVITY_SIZE[node.type];
  if (node.type !== "fork" && node.type !== "join") return base;

  const arms = Math.max(
    graph.edges.filter((edge) => edge.from === node.id).length,
    graph.edges.filter((edge) => edge.to === node.id).length,
  );
  return { width: base.width, height: Math.max(base.height, arms * BAR_ARM_PITCH) };
}

/** Takes the signature rather than recomputing it, so a cache miss folds the graph once. */
function runDagre(graph: Graph, signature: string, collapsed: ReadonlySet<string>): Layout {
  const g = new graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>();
  // Left to right: a pursuit reads as a chain of dependencies, and `{from, to}` means "to
  // requires from". The rank gap is wide enough for an edge label to sit in later.
  g.setGraph({ rankdir: "LR", nodesep: 18, ranksep: 72, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const activity of graph.nodes.values()) {
    // A copy, because dagre writes `x`, `y` and its own bookkeeping onto the label it is
    // handed; passing the constant itself would let one layout scribble on the value every
    // later layout reads.
    g.setNode(activity.id, {
      ...(collapsed.has(activity.id) ? COLLAPSED_GROUP_SIZE : sizeOf(graph, activity)),
    });
  }
  // Every edge the canvas will DRAW, not just the dependencies — `viewEdges` is the one
  // answer to "what is in the picture", so ranking and drawing cannot disagree. An arc that
  // dagre never saw gets routed across the whole canvas to reach an activity the layout did not
  // know it was attached to.
  for (const edge of viewEdges(graph)) {
    // `setEdge` mints any endpoint it does not already know, and a minted activity has no size:
    // dagre would place a phantom and shove the real boxes around it. A dangling edge is a
    // shape the model already names (`BlockedCause.kind === "missing"`), so it is skipped here
    // and reported there.
    if (graph.nodes.has(edge.from) && graph.nodes.has(edge.to)) {
      g.setEdge(edge.from, edge.to);
    }
  }

  // The two notation circles, and the arrows that make them mean anything. Adding them to the
  // SAME pass is what keeps those arrows short: an unranked marker would be placed at the
  // origin and its arrow would cross the whole canvas to reach the first step.
  const terminals = flowTerminals(graph);
  if (terminals.starts.size > 0) {
    g.setNode(START_MARKER_ID, { ...MARKER_SIZE });
    for (const id of terminals.starts) g.setEdge(START_MARKER_ID, id);
  }
  if (terminals.ends.size > 0) {
    g.setNode(END_MARKER_ID, { ...MARKER_SIZE });
    for (const id of terminals.ends) g.setEdge(id, END_MARKER_ID);
  }

  dagreLayout(g);

  const boxes = new Map<string, NodeBox>();
  for (const activity of graph.nodes.values()) {
    const size = collapsed.has(activity.id) ? COLLAPSED_GROUP_SIZE : sizeOf(graph, activity);
    const placed = g.node(activity.id);
    // dagre reports the CENTRE; React Flow positions by the TOP-LEFT corner. The subtraction
    // lives here, once, because getting it wrong is silent: every activity sits half a box up and
    // to the left, the edges still join them, and it reads as a styling mistake rather than an
    // arithmetic one.
    boxes.set(activity.id, {
      x: (placed.x ?? 0) - size.width / 2,
      y: (placed.y ?? 0) - size.height / 2,
      width: size.width,
      height: size.height,
    });
  }

  const markers = new Map<string, NodeBox>();
  for (const id of [START_MARKER_ID, END_MARKER_ID]) {
    if (!g.hasNode(id)) continue;
    const placed = g.node(id);
    markers.set(id, {
      x: (placed.x ?? 0) - MARKER_SIZE.width / 2,
      y: (placed.y ?? 0) - MARKER_SIZE.height / 2,
      width: MARKER_SIZE.width,
      height: MARKER_SIZE.height,
    });
  }

  const label = g.graph();
  return { boxes, markers, width: extent(label.width), height: extent(label.height), signature };
}

/**
 * A graph with no activities — v0 of every log — leaves dagre folding `Math.max` over nothing, so
 * it reports the extent as `-Infinity` rather than as zero or as absent. Normalised once here:
 * a canvas sized from `-Infinity` renders as a blank page, which looks like a broken viewer
 * rather than like an empty pursuit.
 */
function extent(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}
