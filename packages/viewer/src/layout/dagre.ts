/**
 * Where the nodes sit — and, the part that actually matters, when we are allowed to work that
 * out again.
 *
 * §6.10 rule 2: memoise dagre and never re-lay-out on a status tick. Status ticks are the
 * common case — a reply lands, a node goes `done`, a predicate ticks up — and re-ranking the
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

/** A placed node, in React Flow's coordinates: `x`/`y` are the TOP-LEFT corner. */
export interface NodeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Layout {
  /** Insertion order, so anything that iterates it gets rule 7's visual order for free. */
  boxes: Map<string, NodeBox>;
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
 * node after the reader had started reading.
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
export const NODE_SIZE: Readonly<Record<NodeType, { width: number; height: number }>> = {
  task: { width: 300, height: 62 },
  wait: { width: 300, height: 82 },
};

/**
 * Everything the picture is a function of, and nothing else.
 *
 * Ids come out in insertion order because rule 7 pins visual order to it — a reordering really
 * would be a different picture. `type` is in because it picks the box size. `superseded_by` is
 * in because `supersede_node` is a topology op: it retires a node in favour of another, and a
 * retired node is not drawn as a live one. Folding it in buys a re-layout on a supersede, which
 * is a shape change a reader should watch move.
 *
 * Deliberately absent: `state`, `outcome`, `output`, `conditions`, `effect_log`,
 * `observed_at_version` and the graph version. Those are exactly what a status tick moves, and
 * a status tick must not move a node.
 *
 * Node ids are `[a-z0-9][a-z0-9-]*` (§6.2), so `:`, `>` and a newline cannot occur inside one
 * and the encoding needs no escaping to stay unambiguous.
 */
export function topologySignature(graph: Graph): string {
  const parts: string[] = [];
  for (const node of graph.nodes.values()) {
    parts.push(`n:${node.id}:${node.type}:${node.provenance.superseded_by ?? ""}`);
  }
  for (const edge of graph.edges) {
    parts.push(`e:${edge.from}>${edge.to}>${edge.condition?.on ?? ""}`);
  }
  return parts.join("\n");
}

export function layoutGraph(graph: Graph): Layout {
  return runDagre(graph, topologySignature(graph));
}

/**
 * The memo. One slot: the viewer lays out one graph, the head one, and re-lays it when the
 * file changes.
 *
 * It hands back the SAME object, not an equal one. React re-renders on identity, so returning
 * a fresh but deeply-equal `Layout` would defeat the memo at the only layer where it pays —
 * every node would re-render on every status tick even though not one of them moved.
 */
export function createLayoutCache(): (graph: Graph) => Layout {
  let cached: Layout | null = null;
  return (graph: Graph): Layout => {
    const signature = topologySignature(graph);
    if (cached !== null && cached.signature === signature) return cached;
    cached = runDagre(graph, signature);
    return cached;
  };
}

/** Takes the signature rather than recomputing it, so a cache miss folds the graph once. */
function runDagre(graph: Graph, signature: string): Layout {
  const g = new graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>();
  // Left to right: a pursuit reads as a chain of dependencies, and `{from, to}` means "to
  // requires from". The rank gap is wide enough for an edge label to sit in later.
  g.setGraph({ rankdir: "LR", nodesep: 18, ranksep: 72, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of graph.nodes.values()) {
    // A copy, because dagre writes `x`, `y` and its own bookkeeping onto the label it is
    // handed; passing `NODE_SIZE[type]` itself would let one layout scribble on the constant
    // every later layout reads.
    g.setNode(node.id, { ...NODE_SIZE[node.type] });
  }
  for (const edge of graph.edges) {
    // `setEdge` mints any endpoint it does not already know, and a minted node has no size:
    // dagre would place a phantom and shove the real boxes around it. A dangling edge is a
    // shape the model already names (`BlockedCause.kind === "missing"`), so it is skipped here
    // and reported there.
    if (graph.nodes.has(edge.from) && graph.nodes.has(edge.to)) {
      g.setEdge(edge.from, edge.to);
    }
  }

  dagreLayout(g);

  const boxes = new Map<string, NodeBox>();
  for (const node of graph.nodes.values()) {
    const size = NODE_SIZE[node.type];
    const placed = g.node(node.id);
    // dagre reports the CENTRE; React Flow positions by the TOP-LEFT corner. The subtraction
    // lives here, once, because getting it wrong is silent: every node sits half a box up and
    // to the left, the edges still join them, and it reads as a styling mistake rather than an
    // arithmetic one.
    boxes.set(node.id, {
      x: (placed.x ?? 0) - size.width / 2,
      y: (placed.y ?? 0) - size.height / 2,
      width: size.width,
      height: size.height,
    });
  }

  const label = g.graph();
  return { boxes, width: extent(label.width), height: extent(label.height), signature };
}

/**
 * A graph with no nodes — v0 of every log — leaves dagre folding `Math.max` over nothing, so
 * it reports the extent as `-Infinity` rather than as zero or as absent. Normalised once here:
 * a canvas sized from `-Infinity` renders as a blank page, which looks like a broken viewer
 * rather than like an empty pursuit.
 */
function extent(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}
