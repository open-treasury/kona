/**
 * §6.10 rule 4: **every node renders its own state inline.**
 *
 * Status, wait predicate, deadline countdown, predicate counter, and for a blocked node the
 * reason as text. Dify's loudest UX complaint is having to leave the graph to find out what
 * happened; a card that says "blocked" and makes you click to learn why has the same defect in
 * a smaller font.
 *
 * The shape is GitHub Actions': a **circular status glyph** leading a single title row, with
 * the one number that matters trailing it, and detail underneath only where there is detail.
 * That layout is worth borrowing for a specific reason — a run graph and a pursuit graph are
 * read the same way, by scanning a column of rows for the one that is not green — and it buys
 * back a third of the card height, which is the thing that bites at 31 arms (kona-e6-8h7.10).
 *
 * Where it stops: Actions has one status and one duration per row, and rule 4 asks for more
 * than that. So the glyph and the trailing metric are theirs, and the rows beneath are ours.
 *
 * Everything rendered here was decided in `model/` and arrives on `NodeView`. This component
 * makes no judgment of its own — that is the rule that keeps the canvas and the CLI agreeing.
 */

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import {
  Circle,
  CircleCheck,
  CircleSlash,
  CircleX,
  Hourglass,
  LoaderCircle,
  Radio,
  Sigma,
  TriangleAlert,
  UserCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Status } from "@kona/core";
import type { NodeView, WaitPhase, WaitState } from "../model/types.ts";
import { NODE_SIZE } from "../layout/dagre.ts";
import { formatDuration } from "../format.ts";
import { cn } from "../lib/cn.ts";
import { Badge } from "../ui/badge.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";

export const KONA_NODE_TYPE = "kona";

export interface CardData extends Record<string, unknown> {
  view: NodeView;
  fresh: boolean;
}

/**
 * The five statuses (§6.2 froze them) as one glyph each, in the Actions vocabulary: a ring you
 * read by its shape before you read it by its colour. `sending` spins because it is the one
 * status that is genuinely mid-flight, and `active` is a bare ring because "queued, nobody has
 * run it" is the absence of an outcome rather than an outcome of its own.
 */
const STATUS_GLYPH: Record<Status, { icon: LucideIcon; tone: string; spin: boolean }> = {
  active: { icon: Circle, tone: "text-status-active-ink", spin: false },
  sending: { icon: LoaderCircle, tone: "text-status-sending-ink", spin: true },
  done: { icon: CircleCheck, tone: "text-status-done-ink", spin: false },
  failed: { icon: CircleX, tone: "text-status-failed-ink", spin: false },
  dropped: { icon: CircleSlash, tone: "text-status-dropped-ink", spin: false },
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

/** The countdown, and only for a wait whose clock is still running. */
function countdownOf(wait: WaitState): string | null {
  if (wait.phase !== "awaiting" && wait.phase !== "blown") return null;
  if (wait.remainingMs === null) return null;
  return wait.remainingMs >= 0
    ? `${formatDuration(wait.remainingMs)} left`
    : `${formatDuration(-wait.remainingMs)} over`;
}

function StatusGlyph({ status }: { status: Status }): React.ReactElement {
  const glyph = STATUS_GLYPH[status];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <glyph.icon
          aria-label={status}
          className={cn("size-4 shrink-0", glyph.tone, glyph.spin && "animate-spin")}
        />
      </TooltipTrigger>
      <TooltipContent>{status}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The one line under the title that a TASK gets: why it cannot run, or what it answered. There
 * is exactly one, and it is reserved whether or not it has content — see `NODE_SIZE`, where
 * the reason is that a height which grew with the status would re-run dagre on a status tick.
 */
function DetailRow({ view }: { view: NodeView }): React.ReactElement | null {
  const blocked = view.blocked;
  if (blocked !== null) {
    return (
      <div
        className={cn(
          ROW,
          "text-status-failed-ink",
          blocked.unreachable && "font-semibold",
        )}
      >
        {blocked.unreachable ? (
          <CircleSlash aria-hidden className="size-3 shrink-0 opacity-70" />
        ) : (
          <TriangleAlert aria-hidden className="size-3 shrink-0 opacity-70" />
        )}
        <span className="truncate">{blocked.summary}</span>
      </div>
    );
  }
  const outcome = view.node.status.outcome;
  if (outcome !== null) {
    return (
      <div className={cn(ROW, "text-muted-foreground")}>
        <span className="w-3 shrink-0" />
        <span className="truncate">{outcome.verdict}</span>
      </div>
    );
  }
  return null;
}

function WaitRow({ wait }: { wait: WaitState }): React.ReactElement {
  const MatchIcon = MATCH_ICON[wait.matchKind ?? "event"] ?? Radio;
  // When there is no clock, WHY there is no clock outranks what would close the wait. A reader
  // looking at a wait is looking for the countdown; "anchored to X, which is still active" is
  // the answer to the question they actually asked, and the match label is one hover away.
  const line = wait.unresolvedReason ?? wait.matchLabel;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn(ROW, "text-muted-foreground")}>
          <MatchIcon aria-hidden className="size-3 shrink-0 opacity-70" />
          <span className="truncate">{line}</span>
          {wait.predicate !== null && (
            <Badge
              tone="outline"
              size="xs"
              className={cn(
                "ml-auto text-[10px] normal-case",
                wait.predicate.met && "border-success text-success",
              )}
            >
              {wait.predicate.have}/{wait.predicate.need}
            </Badge>
          )}
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
  );
}

function NodeCard({ data, selected }: NodeProps): React.ReactElement {
  const { view, fresh } = data as unknown as CardData;
  const node = view.node;
  const wait = view.wait;
  const superseded = node.provenance.superseded_by !== null;

  // The trailing slot is Actions' duration column, and it holds ONLY what fits there: a
  // countdown. It briefly held the deadline prose as a fallback, and that prose ate the label —
  // every wait on the canvas rendered as `Wait…`, which is the one thing a card must never lose.
  // Where there is no countdown, the row beneath says why.
  const trailing = wait === null ? null : countdownOf(wait);

  return (
    <div
      // The card, not the React Flow wrapper, carries the box: measured on 12.11.3, a wrapper
      // with explicit style dimensions is skipped by the measuring pass and takes every edge
      // touching it with it — silently, no warning, just no lines.
      style={NODE_SIZE[node.type]}
      className={cn(
        "flex flex-col justify-center gap-1 overflow-hidden rounded-lg border border-border",
        "bg-card px-3 py-2 shadow-subtle",
        "transition-[border-color,box-shadow,opacity] duration-[--transition-medium]",
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

      <div className="flex min-w-0 items-center gap-2">
        <StatusGlyph status={node.status.state} />
        {node.type === "wait" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Hourglass aria-hidden className="size-3 shrink-0 text-carbon-40" />
            </TooltipTrigger>
            <TooltipContent>a wait — this node blocks until something answers it</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            {/* `min-w-0` is what makes the truncation land on the LABEL's own box rather than
                on the flex row, and `flex-1` is what stops the trailing slot taking width the
                label needed. Without the pair, a long countdown wins an argument it should
                never have been in. */}
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{node.label}</span>
          </TooltipTrigger>
          <TooltipContent>{node.spec.instruction}</TooltipContent>
        </Tooltip>
        {trailing !== null && (
          // Actions puts a duration here. A pursuit's equivalent is how long is left, which is
          // the number a reader is actually waiting on.
          <span
            className={cn(
              "shrink-0 font-mono text-[10px] tabular-nums",
              WAIT_TONE[wait?.phase ?? "unarmed"],
            )}
          >
            {trailing}
          </span>
        )}
      </div>

      {wait !== null && <WaitRow wait={wait} />}
      <DetailRow view={view} />

      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

export const nodeTypes = { [KONA_NODE_TYPE]: NodeCard };
