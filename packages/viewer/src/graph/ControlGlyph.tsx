/**
 * The seven control nodes, as the notation rather than as cards.
 *
 * A control node is not work: it has no status, no instruction, and nothing an executor could
 * do with it. Drawing it as a card — which is what happened before this file existed — says
 * the opposite of all three, and puts a status chip on a node that has no status to show.
 *
 * **They ARE selectable, and that is the point of the redesign rather than a detail.** The
 * argument for the whole activity model is that a branch point used to have "no object to hang
 * on and no id to reference": you could see that the flow split, and you could not click the
 * split, cite it in a rationale, or ask why it went that way. An unclickable diamond leaves
 * that argument half delivered, so every glyph here opens the Inspector like a card does.
 *
 * Geometry note, learned the hard way in `MarkerNode`: the glyph IS the node box. A smaller
 * mark drawn inside a larger box leaves every arrow ending on the box edge instead of on the
 * mark, which reads as a line that never quite arrives. `ACTIVITY_SIZE` in `layout/dagre.ts`
 * holds the box, and each shape below fills it exactly.
 */

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { NodeType } from "@kona/core";
import { collapsedStatusSummary } from "../model/collapse.ts";
import type { CollapsedRegion } from "../model/collapse.ts";
import { ACTIVITY_SIZE, COLLAPSED_GROUP_SIZE } from "../layout/dagre.ts";
import { cn } from "../lib/cn.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";

export const KONA_CONTROL_TYPE = "kona-control";

export interface ControlData extends Record<string, unknown> {
  type: NodeType;
  name: string | null;
  selected: boolean;
  fresh: boolean;
  region?: CollapsedRegion;
  onToggle?: () => void;
}

/** What each glyph is FOR, in a reader's words. The tooltip is the only place it is spelled. */
const MEANING: Partial<Record<string, string>> = {
  initial: "where the flow starts. Exactly one per pursuit.",
  final: "the pursuit is over — the flow reached its end.",
  flow_final: "this path is over. The pursuit continues on its other paths.",
  decision: "one way in, several out. Exactly one arm fires, chosen by its guard.",
  merge: "several ways in, one out. ANY of them is enough.",
  join: "several ways in, one out. ALL of them are needed.",
  fork: "one way in, several out. Every arm runs at the same time.",
};

/**
 * Explicit pixel dimensions, never `size-full`.
 *
 * A React Flow node has no CSS size of its own — `Canvas.tsx` passes `width`/`height` as data
 * for the layout and edge routing, and deliberately does NOT set them as style, because a node
 * carrying explicit style dimensions is skipped by React Flow's measuring pass and every edge
 * touching it silently fails to render. `ActivityCard` pins its own box for the same reason.
 * So `size-full` here resolves against a zero-height parent: the first version of this file did
 * that and the diamonds were invisible on screen while every test passed, because nothing in
 * the suite renders a diamond and measures it.
 */
function Glyph({ type }: { type: string }): React.ReactElement {
  const box = ACTIVITY_SIZE[type as NodeType];

  // Diamonds. A decision and a merge are the same mark in UML, deliberately: both are a hinge,
  // and which one it is reads off the edges. The SQUARE is sized so that its diagonal is the
  // box — a square of side s rotated 45° needs s·√2 of room — or the corners overflow into the
  // neighbouring rank and dagre has not reserved that space.
  if (type === "decision" || type === "merge") {
    const side = Math.round(box.height / Math.SQRT2);
    return (
      <span
        aria-hidden
        className="block rotate-45 rounded-[2px] border-2 border-foreground bg-card"
        style={{ width: side, height: side }}
      />
    );
  }

  // Bars. Solid, and narrow in `rankdir: LR` because the flow runs left-to-right across them.
  if (type === "fork" || type === "join") {
    return <span aria-hidden className="block rounded-sm bg-foreground" style={box} />;
  }

  if (type === "initial") {
    return <span aria-hidden className="block rounded-full bg-foreground" style={box} />;
  }

  // Flow final: a circled X, UML's mark for "this token stops here, the pursuit does not".
  if (type === "flow_final") {
    return (
      <span
        aria-hidden
        className="relative flex items-center justify-center rounded-full border-2 border-carbon-40"
        style={box}
      >
        <span className="absolute h-[1.5px] w-2.5 rotate-45 bg-carbon-40" />
        <span className="absolute h-[1.5px] w-2.5 -rotate-45 bg-carbon-40" />
      </span>
    );
  }

  // ActivityNode final: a ring around a dot.
  return (
    <span
      aria-hidden
      className="flex items-center justify-center rounded-full border-2 border-foreground"
      style={box}
    >
      <span className="size-2 rounded-full bg-foreground" />
    </span>
  );
}

function ControlGlyph({ data }: NodeProps): React.ReactElement {
  const { type, name, selected, fresh, region, onToggle } = data as unknown as ControlData;
  const label = name ?? type.replace("_", " ");

  if (region !== undefined) {
    return (
      <div
        style={COLLAPSED_GROUP_SIZE}
        className={cn(
          "flex cursor-pointer flex-col justify-center rounded-lg border border-border bg-card px-3 text-left shadow-subtle",
          selected && "ring-2 ring-cobalt-bold",
          fresh && "animate-flash",
        )}
      >
        <Handle type="target" position={Position.Left} isConnectable={false} />
        <button
          type="button"
          aria-label={`expand ${label}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggle?.();
          }}
          className="flex min-w-0 flex-col text-left"
        >
          <span className="truncate text-[13px] font-medium">{label}</span>
          <span className="mt-1 line-clamp-2 font-mono text-[10px] text-muted-foreground">
            {collapsedStatusSummary(region)}
          </span>
          <span className="mt-1 font-mono text-[9px] uppercase text-carbon-40">expand group</span>
        </button>
        <Handle type="source" position={Position.Right} isConnectable={false} />
      </div>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          aria-label={`${type}${name === null ? "" : `: ${name}`}`}
          // The wrapper pins the box — `ActivityCard` does the same, and for the same reason:
          // React Flow gives a node no CSS size of its own, so anything inside that measures
          // against its parent measures against zero.
          style={ACTIVITY_SIZE[type]}
          className={cn(
            "flex items-center justify-center cursor-pointer",
            // Selection is a ring OUTSIDE the box, never a size change: dagre has already
            // placed this and every edge has already been routed to its bounds.
            selected && "ring-2 ring-offset-2 ring-cobalt-bold rounded-sm",
            fresh && "animate-flash",
          )}
        >
          <Handle type="target" position={Position.Left} isConnectable={false} />
          <Glyph type={type} />
          <Handle type="source" position={Position.Right} isConnectable={false} />
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <span className="font-medium">{label}</span>
        {MEANING[type] !== undefined && (
          <span className="block text-carbon-40">{MEANING[type]}</span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export const controlNodeTypes = { [KONA_CONTROL_TYPE]: ControlGlyph };
