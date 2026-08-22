/**
 * §6.10 rule 4: **every node renders its own state inline.**
 *
 * Status chip, wait predicate, deadline countdown, predicate counter, and for a blocked node
 * the reason as text. Dify's loudest UX complaint is having to leave the graph to find out what
 * happened; a card that says "blocked" and makes you click to learn why has the same defect in
 * a smaller font.
 *
 * Everything rendered here was decided in `model/` and arrives on `NodeView`. This component
 * makes no judgment of its own — that is the rule that keeps the canvas and the CLI agreeing.
 */

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { Check, CircleSlash, Clock, Radio, Sigma, TriangleAlert, UserCheck, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { NodeView, WaitPhase, WaitState } from "../model/types.ts";
import { NODE_SIZE } from "../layout/dagre.ts";
import { formatDuration } from "../format.ts";
import { cn } from "../lib/cn.ts";
import { Badge, StatusBadge } from "../ui/badge.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";

export const KONA_NODE_TYPE = "kona";

export interface CardData extends Record<string, unknown> {
  view: NodeView;
  fresh: boolean;
}

/** The left rule is the status, at a glance, from across a room. */
const EDGE_TONE: Record<string, string> = {
  active: "border-l-status-active-ink",
  sending: "border-l-status-sending-ink",
  done: "border-l-status-done-ink",
  failed: "border-l-status-failed-ink",
  dropped: "border-l-status-dropped-ink",
};

/**
 * Rule 8's colours. `resolved` is the success green and `failed` is not — a wait that ended
 * without satisfying anything must not be painted the same as one that did, or the card would
 * contradict the blocked reason on the node it feeds.
 */
const WAIT_TONE: Record<WaitPhase, string> = {
  awaiting: "text-wait-awaiting",
  blown: "text-wait-blown",
  resolved: "text-wait-resolved",
  failed: "text-wait-failed",
  unarmed: "text-carbon-40",
  dropped: "text-carbon-40",
};

const MATCH_ICON: Record<string, LucideIcon> = {
  event: Radio,
  human: UserCheck,
  predicate: Sigma,
};

const ROW = "flex min-w-0 items-center gap-1.5 font-mono text-[10px]";
const TEXT = "truncate";

function Row({
  icon: Icon,
  className,
  children,
}: {
  icon: LucideIcon;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className={cn(ROW, "text-muted-foreground", className)}>
      <Icon aria-hidden className="size-3 shrink-0 opacity-70" />
      {children}
    </div>
  );
}

function WaitRows({ wait }: { wait: WaitState }): React.ReactElement {
  // A countdown belongs only to a wait whose clock is still running. A resolved wait that
  // answered before its deadline would otherwise render "6h left" for ever, which reads as
  // still-waiting — the one thing rule 8's three colours exist to distinguish. Where there is
  // no countdown, the reason there is none is the next most useful thing to say.
  const live = wait.phase === "awaiting" || wait.phase === "blown";
  const countdown =
    live && wait.remainingMs !== null
      ? wait.remainingMs >= 0
        ? `${formatDuration(wait.remainingMs)} left`
        : `${formatDuration(-wait.remainingMs)} over`
      : null;
  const MatchIcon = MATCH_ICON[wait.matchKind ?? "event"] ?? Radio;

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={cn(ROW, WAIT_TONE[wait.phase])}>
            <Clock aria-hidden className="size-3 shrink-0 opacity-70" />
            <span className={TEXT}>
              {countdown ?? wait.unresolvedReason ?? wait.deadlineLabel}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <div>{wait.deadlineLabel}</div>
          {wait.unresolvedReason !== null && (
            <div className="mt-1 opacity-70">{wait.unresolvedReason}</div>
          )}
          {wait.onTimeout !== null && (
            <div className="mt-1 opacity-70">on timeout → {wait.onTimeout}</div>
          )}
        </TooltipContent>
      </Tooltip>

      <Row icon={MatchIcon}>
        <span className={TEXT}>{wait.matchLabel}</span>
        {wait.predicate !== null && (
          <Badge
            tone="outline"
            size="xs"
            className={cn(
              "ml-auto text-[10px] normal-case",
              wait.predicate.met && "border-status-done-ink text-status-done-ink",
            )}
          >
            {wait.predicate.have}/{wait.predicate.need}
          </Badge>
        )}
      </Row>
    </>
  );
}

function NodeCard({ data, selected }: NodeProps): React.ReactElement {
  const { view, fresh } = data as unknown as CardData;
  const node = view.node;
  const blocked = view.blocked;
  const superseded = node.provenance.superseded_by !== null;

  return (
    <div
      // The card, not the React Flow wrapper, carries the box: measured on 12.11.3, a wrapper
      // with explicit style dimensions is skipped by the measuring pass and takes every edge
      // touching it with it — silently, no warning, just no lines.
      style={NODE_SIZE[node.type]}
      className={cn(
        "flex flex-col gap-1.5 overflow-hidden rounded-lg border border-border px-2.5 py-2",
        "border-l-[3px] bg-card shadow-subtle",
        "transition-[border-color,box-shadow,opacity] duration-[--transition-medium]",
        EDGE_TONE[node.status.state],
        // Dimmed, not erased. Nothing is ever deleted from a Kona graph, and a node that has
        // been dropped or replaced is still part of how the pursuit got here — §6.3's whole
        // argument. On a light ground the floor for that is higher than on a dark one: below
        // about 60% the label stops being legible and "retired" reads as "broken render".
        node.status.state === "dropped" && "opacity-65",
        superseded && "opacity-60",
        selected && "border-primary shadow-standard",
        fresh && "animate-flash",
      )}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />

      <div className="flex min-w-0 items-center gap-1.5">
        <Badge tone="outline" size="xs">
          {node.type}
        </Badge>
        <StatusBadge status={node.status.state} />
        <span className="flex-1" />
        {view.readiness === "ready" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="size-1.5 shrink-0 rounded-full bg-primary shadow-[0_0_0_3px_--alpha(var(--color-primary)/20%)]" />
            </TooltipTrigger>
            <TooltipContent>on the ready frontier — `kona next` would dispatch this</TooltipContent>
          </Tooltip>
        )}
        {view.irreversible && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Zap aria-hidden className="size-3 shrink-0 text-status-sending-ink" />
            </TooltipTrigger>
            <TooltipContent>
              effect_class {node.spec.effect_class} — this moves bytes we cannot take back
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <div className="line-clamp-2 text-[12.5px] leading-tight font-semibold">
            {node.label}
          </div>
        </TooltipTrigger>
        <TooltipContent>{node.spec.instruction}</TooltipContent>
      </Tooltip>

      {view.wait !== null && <WaitRows wait={view.wait} />}

      {blocked !== null && (
        <Row
          icon={blocked.unreachable ? CircleSlash : TriangleAlert}
          className={cn("text-status-failed-ink", blocked.unreachable && "font-semibold")}
        >
          <span className={TEXT}>{blocked.summary}</span>
        </Row>
      )}

      {node.status.outcome !== null && (
        <Row icon={Check} className="text-wait-resolved">
          <span className={TEXT}>{node.status.outcome.verdict}</span>
        </Row>
      )}

      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

export const nodeTypes = { [KONA_NODE_TYPE]: NodeCard };
