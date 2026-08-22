/**
 * The canvas. React Flow in **fully controlled** mode — positions are props, derived from
 * dagre every version and never stored (§6.10).
 *
 * It is deliberately not an editor: no drag, no connect, no delete, no keyboard mutation.
 * An editable canvas would be a second mutator with no rationale and no version, which is the
 * one thing §6.10 forbids outright. Selection exists only to open the inspector.
 */

import { useMemo } from "react";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import type { Graph } from "@kona/core";
import type { GraphView } from "../model/types.ts";
import type { ViewEdge } from "../model/edges.ts";
import { viewEdges } from "../model/edges.ts";
import { edgeKeyString } from "../model/diff.ts";
import { NODE_SIZE } from "../layout/dagre.ts";
import type { Fresh } from "./useFresh.ts";
import type { Positions } from "./useTween.ts";
import { KONA_NODE_TYPE, nodeTypes } from "./NodeCard.tsx";
import type { CardData } from "./NodeCard.tsx";

export interface CanvasProps {
  graph: Graph;
  view: GraphView;
  positions: Positions;
  fresh: Fresh;
  selected: string | null;
  onSelect: (id: string | null) => void;
}

/**
 * React Flow puts `className` on the edge's `<g>`, which is the only styling hook it offers a
 * plain (non-custom) edge. Data on `edge.data` never reaches the DOM, so the state has to ride
 * in as class names.
 *
 * The three kinds are meant to be told apart WITHOUT reading a label: a dependency is a solid
 * line because it gates something, a timeout route is dashed amber because it is an escape
 * hatch that has not fired, and a supersede is a faint dotted aside because it is lineage
 * rather than flow. A reader should be able to see which lines the pursuit is waiting on by
 * squinting at it.
 */
function edgeClass(edge: ViewEdge, fresh: boolean): string {
  const parts = ["e", `e-${edge.kind}`];
  if (edge.kind === "requires") {
    if (edge.dead) parts.push("e-dead");
    else if (edge.satisfied) parts.push("e-sat");
  }
  if (fresh) parts.push("e-fresh");
  return parts.join(" ");
}

/** Only a dependency is worth labelling; the other two say what they are by how they look. */
function edgeLabel(edge: ViewEdge): string | undefined {
  return edge.kind === "requires" ? (edge.condition ?? undefined) : undefined;
}

export function Canvas({
  graph,
  view,
  positions,
  fresh,
  selected,
  onSelect,
}: CanvasProps): React.ReactElement {
  // `data` identity is held stable across tween frames: React Flow memoizes a node's render on
  // it, so rebuilding it 60 times a second would re-render every card for the whole animation.
  const data = useMemo(() => {
    const map = new Map<string, CardData>();
    for (const nodeView of view.nodes) {
      map.set(nodeView.node.id, { view: nodeView, fresh: fresh.nodes.has(nodeView.node.id) });
    }
    return map;
  }, [view, fresh]);

  const nodes = useMemo<FlowNode[]>(
    () =>
      view.nodes.map((nodeView) => {
        const id = nodeView.node.id;
        const size = NODE_SIZE[nodeView.node.type];
        return {
          id,
          type: KONA_NODE_TYPE,
          position: positions.get(id) ?? { x: 0, y: 0 },
          data: data.get(id) ?? { view: nodeView, fresh: false },
          // The dagre box, so an edge knows where to land before the DOM has been measured.
          // Do NOT also set `style.width` / `style.height`: measured on React Flow 12.11.3,
          // a node carrying explicit style dimensions is skipped by the measuring pass, its
          // handle bounds are never computed, and every edge touching it silently fails to
          // render — no warning, no error, just no lines. The card pins its own box instead.
          width: size.width,
          height: size.height,
          selected: id === selected,
          draggable: false,
          connectable: false,
          deletable: false,
        };
      }),
    [view, positions, data, selected],
  );

  const edges = useMemo<FlowEdge[]>(
    () =>
      viewEdges(graph).map((edge) => {
        const flow: FlowEdge = {
          id: edge.id,
          source: edge.from,
          target: edge.to,
          className: edgeClass(
            edge,
            // Only a dependency flashes. The diff reports added dependencies, and a supersede
            // arc appearing is already announced by the card it points at.
            edge.kind === "requires" &&
              fresh.edges.has(edgeKeyString({ from: edge.from, to: edge.to, on: edge.condition })),
          ),
          animated: false,
          deletable: false,
          selectable: false,
        };
        // Assigned rather than spread: `exactOptionalPropertyTypes` refuses an explicit
        // `label: undefined`, and a conditional spread inside `map` is what oxlint's
        // `no-map-spread` is about.
        const label = edgeLabel(edge);
        if (label !== undefined) flow.label = label;
        return flow;
      }),
    [graph, fresh],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      edgesFocusable={false}
      deleteKeyCode={null}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      onNodeClick={(_event, node) => {
        onSelect(node.id);
      }}
      onPaneClick={() => {
        onSelect(null);
      }}
      fitView
      /*
       * `fitView` has a legibility FLOOR, and the canvas's own `minZoom` sits well below it.
       *
       * Measured on a 31-arm pursuit — the size the PRD actually scopes, "email up to 30
       * players from this roster": the graph is 1328 x 5216 px in a 1131 x 672 pane, so
       * fitting it whole needs scale 0.13 and renders a 260px card at 34px. That is not a
       * small graph, it is a grey smear. Below about 0.45 a card's label stops being a label.
       *
       * So the opening shot is as much of the graph as stays readable, and the rest is the
       * scroll wheel — never an unreadable whole. The canvas `minZoom` is still 0.05, because
       * deliberately zooming out to see the SHAPE of a fan-out is a reasonable thing to want;
       * being dropped there on load is not.
       */
      fitViewOptions={{ padding: 0.18, minZoom: 0.45, maxZoom: 1 }}
      minZoom={0.05}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={22} size={1} color="var(--color-dots)" />
      <Controls showInteractive={false} />
      {/*
        No minimap. It bought an overview that matters only past about ten arms — see
        kona-e6-8h7.10, where a 31-arm pursuit does not fit above the legibility floor — and
        it cost a permanent box over the bottom-right of the canvas at every size below that.
        If group containers land (T6.4), the overview comes back for free and in the right
        place: on the graph, not floating over it.
      */}
    </ReactFlow>
  );
}
