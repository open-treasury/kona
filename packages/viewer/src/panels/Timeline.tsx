/**
 * §6.10 rule 5: **the second panel is the mutation timeline — version + op + rationale.**
 *
 * *That panel, not the canvas, is the differentiator.* Every tracing product on the market can
 * draw a graph; none of them can show you why the graph is shaped the way it is, because they
 * have nothing to show it from. Kona has `rationale.why` and `reason_code` on every commit,
 * enforced by a schema that makes omitting them impossible, so this panel is the one place the
 * whole architecture becomes visible.
 *
 * Clicking a version is **read-only time travel** (rule 6), and the wording is load-bearing:
 * nothing here says restore, revert, roll back or undo, because the log is append-only and the
 * offer would be a lie. It says *viewing*, and it offers to come back to head.
 */

import { useState } from "react";
import type { TimelineEntry } from "../model/types.ts";
import { formatIso } from "../format.ts";
import { cn } from "../lib/cn.ts";
import { Badge } from "../ui/badge.tsx";
import { ScrollArea } from "../ui/scroll-area.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";

export interface TimelineProps {
  entries: readonly TimelineEntry[];
  headVersion: number;
  /** Which version the canvas is showing. Equal to `headVersion` unless time-travelling. */
  viewing: number;
  onView: (version: number) => void;
}

function shapeOf(entry: TimelineEntry): { text: string; stable: boolean } {
  const diff = entry.diff;
  if (diff === null) return { text: "genesis", stable: true };

  const retired = diff.statusChanged.filter((change) => change.to === "dropped").length;
  if (diff.topologyStable) {
    // A bare `supersede_node` retires a branch without adding a node or setting
    // `superseded_by`, so nothing moves and the layout is right not to re-run — but "status
    // only" would undersell a branch being closed.
    return retired > 0
      ? { text: `${retired} branch retired — no re-layout`, stable: true }
      : { text: "status only — no re-layout", stable: true };
  }

  const parts: string[] = [];
  if (diff.addedNodes.length > 0) parts.push(`+${diff.addedNodes.length} node`);
  if (diff.addedEdges.length > 0) parts.push(`+${diff.addedEdges.length} edge`);
  if (diff.superseded.length > 0) parts.push(`${diff.superseded.length} superseded`);
  return { text: parts.join(" · ") || "topology changed", stable: false };
}

function Entry({
  entry,
  isHead,
  isViewing,
  onView,
}: {
  entry: TimelineEntry;
  isHead: boolean;
  isViewing: boolean;
  onView: () => void;
}): React.ReactElement {
  const shape = shapeOf(entry);
  const [open, setOpen] = useState(false);
  const extras =
    entry.expectedEffect !== null ||
    entry.alternativesRejected.length > 0 ||
    entry.trigger !== null;

  return (
    <div
      className={cn(
        "border-b border-border border-l-2 border-l-transparent",
        isHead && "border-l-primary bg-carbon-4",
        isViewing && "border-l-status-sending-ink bg-warning-bg",
      )}
    >
      <button
        type="button"
        onClick={onView}
        title={`view the graph as it stood at v${String(entry.version)} — read-only`}
        className="w-full cursor-pointer px-3 py-2.5 text-left hover:bg-carbon-4"
      >
        <div className="flex items-baseline gap-2 font-mono text-[10px] text-carbon-40">
          <span className="font-semibold text-foreground">v{entry.version}</span>
          <Badge tone="reason" size="xs">
            {entry.reasonCode}
          </Badge>
          <span className="flex-1" />
          <span className="truncate">{entry.actor}</span>
          <span className="shrink-0">{formatIso(entry.observedAt)}</span>
        </div>

        {/*
          The serif is the point of this line. Everything else on the panel is machine output —
          a version, an opcode, a node id, a timestamp — and it is all set in mono. `why` is the
          one place a person wrote a sentence, and §6.3 is the argument that the sentence is the
          product. Setting it in Crimson Pro is how a reader sees that at a glance, before
          reading a word of it.
        */}
        <p className="mt-1.5 font-serif text-[15px] leading-snug text-foreground">{entry.why}</p>

        {entry.ops.length > 0 && (
          <ul className="mt-1.5 flex flex-col gap-px">
            {entry.ops.map((op, index) => (
              <li
                key={`${String(entry.version)}:${String(index)}`}
                className="flex min-w-0 gap-1.5 font-mono text-[10px] text-muted-foreground"
              >
                <span className="w-24 shrink-0 text-carbon-40">{op.kind}</span>
                <span className="truncate">
                  {op.node}
                  {op.detail === "" ? "" : ` · ${op.detail}`}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div
          className={cn(
            "mt-1.5 font-mono text-[9.5px] tracking-wide",
            shape.stable ? "text-carbon-40" : "text-primary",
          )}
        >
          {shape.text}
        </div>
      </button>

      {/*
        §6.3's rationale is four fields, not one. `why` is the sentence a human reads, but the
        other three are what make it auditable: what the author expected, what they considered
        and dismissed, and what event provoked them. The fixture happens to leave them empty on
        every record, which is exactly why they need a home now — a field that is only rendered
        once it has data is a field that gets discovered to be missing on stage.
      */}
      {extras && (
        <div className="px-3 pb-2.5">
          <button
            type="button"
            onClick={() => {
              setOpen((value) => !value);
            }}
            className="cursor-pointer text-ui-xs font-medium text-carbon-40 uppercase hover:text-muted-foreground"
          >
            {open ? "− " : "+ "}
            rationale detail
          </button>
          {open && (
            <dl className="mt-1.5 grid grid-cols-[86px_minmax(0,1fr)] gap-x-2 gap-y-0.5 font-mono text-[10px]">
              {entry.trigger !== null && (
                <>
                  <dt className="text-carbon-40">trigger</dt>
                  <dd className="break-words text-muted-foreground">{entry.trigger}</dd>
                </>
              )}
              {entry.expectedEffect !== null && (
                <>
                  <dt className="text-carbon-40">expected</dt>
                  <dd className="break-words text-muted-foreground">{entry.expectedEffect}</dd>
                </>
              )}
              {entry.alternativesRejected.length > 0 && (
                <>
                  <dt className="text-carbon-40">rejected</dt>
                  <dd className="break-words text-muted-foreground">
                    {entry.alternativesRejected.join(" · ")}
                  </dd>
                </>
              )}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

export function Timeline({
  entries,
  headVersion,
  viewing,
  onView,
}: TimelineProps): React.ReactElement {
  return (
    <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <div className="flex items-center gap-2 border-b border-border px-3 py-3 text-ui font-medium text-muted-foreground uppercase">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help">mutation timeline</span>
          </TooltipTrigger>
          <TooltipContent>
            every commit carries a rationale — the schema makes omitting one impossible (§6.3).
            Click a version to see the graph as it stood; it is read-only, never a revert.
          </TooltipContent>
        </Tooltip>
        <span className="flex-1" />
        <span>{entries.length} versions</span>
      </div>

      <ScrollArea className="min-h-0">
        {entries.length === 0 ? (
          <p className="p-7 text-center font-mono text-[11px] text-carbon-40">no mutations yet</p>
        ) : (
          entries.map((entry) => (
            <Entry
              key={entry.version}
              entry={entry}
              isHead={entry.version === headVersion}
              isViewing={entry.version === viewing && viewing !== headVersion}
              onView={() => {
                onView(entry.version);
              }}
            />
          ))
        )}
      </ScrollArea>
    </section>
  );
}
