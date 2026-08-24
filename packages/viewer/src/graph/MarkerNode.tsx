/**
 * The activity diagram's initial and final activities — the filled circle the flow starts from and
 * the ringed circle it runs into.
 *
 * **They are notation, and the code keeps them at arm's length from the pursuit.** Nothing in
 * the log corresponds to them: they carry no status, they are not selectable, they are absent
 * from `GraphView.activities` and from `Layout.boxes`, and any count of "how many activities does this
 * pursuit have" cannot pick them up. What they render is a fact about the SHAPE of the graph —
 * which cards nothing comes before, and which cards nothing comes after — and that fact is
 * computed in `flowTerminals` where it can be tested.
 *
 * The final ring says less than UML's does, on purpose. There is no final state in Kona: §6.1
 * makes the topology mutate mid-run, so this is "nothing depends on what feeds me, at this
 * version", not "the pursuit is over".
 */

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { cn } from "../lib/cn.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";

export const KONA_MARKER_TYPE = "kona-marker";

export interface MarkerData extends Record<string, unknown> {
  kind: "start" | "end";
}

function MarkerNode({ data }: NodeProps): React.ReactElement {
  const { kind } = data as unknown as MarkerData;
  const isStart = kind === "start";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          aria-label={isStart ? "start" : "end"}
          // The circle IS the activity box — `MARKER_SIZE` matches it exactly. A smaller circle
          // drawn inside a larger box leaves every arrow ending on the box edge instead, which
          // reads as a line that never quite arrives.
          className={cn(
            "flex size-5 items-center justify-center rounded-full",
            isStart ? "bg-foreground" : "border-2 border-foreground",
          )}
        >
          <Handle type="target" position={Position.Left} isConnectable={false} />
          {/* UML's final activity is a ring around a dot; the initial activity is the disc alone. */}
          {!isStart && <span className="size-2 rounded-full bg-foreground" />}
          <Handle type="source" position={Position.Right} isConnectable={false} />
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {isStart
          ? "where the pursuit starts — the steps to its right have nothing before them"
          : "nothing depends on the steps to its left, at this version. Not “finished”: the topology changes mid-run, so a leaf now can grow children in the next version."}
      </TooltipContent>
    </Tooltip>
  );
}

export const markerNodeTypes = { [KONA_MARKER_TYPE]: MarkerNode };
