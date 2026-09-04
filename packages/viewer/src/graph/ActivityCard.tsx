/**
 * §6.10 rule 4: **every activity renders its own state inline.**
 *
 * Status, wait predicate, deadline countdown, predicate counter, and for a blocked activity the
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
 * Everything rendered here was decided in `model/` and arrives on `ActivityView`. This component
 * makes no judgment of its own — that is the rule that keeps the canvas and the CLI agreeing.
 */

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import {
  Circle,
  CircleCheck,
  CircleSlash,
  OctagonPause,
  CircleX,
  LoaderCircle,
  Radio,
  Sigma,
  TriangleAlert,
  UserCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Status } from "@kona/core";
import type { ActivityView, WaitPhase, WaitState } from "../model/types.ts";
import { ACTIVITY_SIZE } from "../layout/dagre.ts";
import { formatDuration } from "../format.ts";
import { cn } from "../lib/cn.ts";
import { Badge } from "../ui/badge.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";

export const KONA_ACTIVITY_TYPE = "kona";

export interface CardData extends Record<string, unknown> {
  view: ActivityView;
  fresh: boolean;
}

/**
 * The seven lifecycle states (§6.2.1) as one glyph each, in the Actions vocabulary: a ring you
 * read by its shape before you read it by its colour.
 *
 * The PAYLOADS moved with the meanings, not with the names, and that distinction is the whole
 * risk in this map: the keys are compiler-checked and the values are not, so renaming the keys
 * and leaving the payloads where they sat would invert every glyph on the canvas and compile
 * perfectly. `active` now means *being worked* — the spinner, which used to be `in_flight` —
 * and the bare queued ring moved to `ready`.
 *
 * `inactive` is new and is deliberately the quietest thing here: "the graph has not reached
 * this yet" is not a state a reader should be drawn to, and it is the commonest state in any
 * large pursuit. `terminated` shares `withdrawn`'s slash because both are abandonment, but
 * takes the failed-family ink: somebody was working it when it was stopped, and that is closer
 * to a wound than to a tidy-up.
 */
const STATUS_GLYPH: Record<Status, { icon: LucideIcon; tone: string; spin: boolean }> = {
  inactive: { icon: Circle, tone: "text-carbon-40", spin: false },
  ready: { icon: Circle, tone: "text-status-active-ink", spin: false },
  active: { icon: LoaderCircle, tone: "text-status-in-flight-ink", spin: true },
  completed: { icon: CircleCheck, tone: "text-status-done-ink", spin: false },
  failed: { icon: CircleX, tone: "text-status-failed-ink", spin: false },
  withdrawn: { icon: CircleSlash, tone: "text-status-dropped-ink", spin: false },
  terminated: { icon: CircleSlash, tone: "text-status-failed-ink", spin: false },
};

/**
 * Rule 8's colours. `resolved` is the success green and `failed` is not — a wait that ended
 * without satisfying anything must not be painted the same as one that did, or the card would
 * contradict the blocked reason on the activity it feeds.
 */
const WAIT_TONE: Record<WaitPhase, string> = {
  awaiting: "text-wait-awaiting",
  blown: "text-wait-blown",
  resolved: "text-wait-resolved",
  failed: "text-wait-failed",
  unarmed: "text-carbon-40",
  withdrawn: "text-carbon-40",
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
 * is exactly one, and it is reserved whether or not it has content — see `ACTIVITY_SIZE`, where
 * the reason is that a height which grew with the status would re-run dagre on a status tick.
 */
function DetailRow({ view }: { view: ActivityView }): React.ReactElement | null {
  const blocked = view.blocked;
  if (blocked !== null) {
    return (
      <div
        className={cn(
          ROW,
          "text-status-failed-ink",
          (blocked.unreachable || blocked.parked) && "font-semibold",
        )}
      >
        {/*
          Three states, not two. §6.10 rule 11: a node waiting on something that will never
          arrive must not be drawn like one that is merely waiting its turn. `unreachable` is
          over — nothing can revive it. `parked` is stalled under a FAILED arm, which §6.4
          rule 5 deliberately keeps alive so a human can repair it rather than the store
          silently deleting the work. Drawn as an ordinary wait, that second case is exactly
          the quiet hang this whole line exists to name.
        */}
        {blocked.unreachable ? (
          <CircleSlash aria-hidden className="size-3 shrink-0 opacity-70" />
        ) : blocked.parked ? (
          <OctagonPause aria-hidden className="size-3 shrink-0 opacity-70" />
        ) : (
          <TriangleAlert aria-hidden className="size-3 shrink-0 opacity-70" />
        )}
        <span className="truncate">{blocked.summary}</span>
      </div>
    );
  }
  const outcome = view.activity.status?.outcome ?? null;
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
  // looking at a wait is looking for the countdown; "anchored to X, which is still in flight" is
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
        {wait.timeoutTarget !== null && (
          <div className="mt-1 opacity-70">timeout route → {wait.timeoutTarget}</div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function ActivityCard({ data, selected }: NodeProps): React.ReactElement {
  const { view, fresh } = data as unknown as CardData;
  const activity = view.activity;
  const wait = view.wait;
  const superseded = activity.provenance.superseded_by !== null;

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
      style={{
        ...ACTIVITY_SIZE[activity.type],
        // §6.2 — AcceptEventAction is a rectangle with a notch cut into its INCOMING edge, the
        // receiving mirror of SendSignalAction's outgoing point. It is the notation, and it is
        // also the only thing on the canvas that says "this one is not ours to do" without
        // reading a word: an action is worked by an agent, an accept_event by the world.
        //
        // A clip-path rather than a border, because the notch has to eat the border too — a
        // rounded rectangle with a triangle drawn on it reads as a rectangle with a decoration.
        // The cost is the rounded corners, which clip-path cannot keep; the pentagon's silhouette
        // is the stronger signal and wins.
        ...(activity.type === "accept_event"
          ? { clipPath: "polygon(0 0, 100% 0, 100% 100%, 0 100%, 14px 50%)" }
          : {}),
      }}
      className={cn(
        "flex flex-col justify-center gap-1 overflow-hidden border border-border",
        activity.type === "accept_event" ? "rounded-none pl-5" : "rounded-lg",
        "bg-card px-3 py-2 shadow-subtle",
        "transition-[border-color,box-shadow,opacity] duration-[--transition-medium]",
        // Dimmed, not erased. Nothing is ever deleted from a Kona graph, and an activity that has
        // been dropped or replaced is still part of how the pursuit got here — §6.3's whole
        // argument. On a light ground the floor for that is higher than on a dark one: below
        // about 60% the label stops being legible and "retired" reads as "broken render".
        activity.status?.state === "withdrawn" && "opacity-65",
        superseded && "opacity-60",
        selected && "border-primary shadow-standard",
        fresh && "animate-flash",
      )}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />

      <div className="flex min-w-0 items-center gap-2">
        {/* A card is only ever an action or an accept_event, so this is always present —
            but the union says so rather than the reader having to know it. */}
        {activity.status !== undefined && <StatusGlyph status={activity.status.state} />}
        <Tooltip>
          <TooltipTrigger asChild>
            {/* `min-w-0` is what makes the truncation land on the LABEL's own box rather than
                on the flex row, and `flex-1` is what stops the trailing slot taking width the
                label needed. Without the pair, a long countdown wins an argument it should
                never have been in. */}
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{activity.name}</span>
          </TooltipTrigger>
          <TooltipContent>{activity.spec.instruction}</TooltipContent>
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

export const nodeTypes = { [KONA_ACTIVITY_TYPE]: ActivityCard };
