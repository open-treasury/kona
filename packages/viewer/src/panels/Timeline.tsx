/**
 * §6.10 rule 5: **the second panel is the mutation timeline — version + op + rationale.**
 *
 * *That panel, not the canvas, is the differentiator.* Every tracing product on the market can
 * draw a graph; none of them can show you why the graph is shaped the way it is, because they
 * have nothing to show it from. Kona has `rationale.why` and `reason_code` on every commit,
 * enforced by a schema that makes omitting them impossible, so this panel is the one place the
 * whole architecture becomes visible.
 *
 * **Nothing on a row is a control.** The panel is read, not operated: the version, the reason
 * code, the ops and the rationale are facts, and there is no verb anywhere in it. Rows were
 * briefly buttons that time-travelled the canvas — the affordance is gone and so is the state
 * behind it, which is why `App` no longer has a version to be "at" other than head.
 */

import { useState } from "react";
import type { TimelineEntry } from "../model/types.ts";
import { formatIso } from "../format.ts";
import { reasonGloss, reasonLabel } from "../model/reason.ts";
import { cn } from "../lib/cn.ts";
import { Badge } from "../ui/badge.tsx";
import { ScrollArea } from "../ui/scroll-area.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";

export interface TimelineProps {
  entries: readonly TimelineEntry[];
  /** The version on the canvas — always head, and marked so the newest row is not just first. */
  headVersion: number;
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
}: {
  entry: TimelineEntry;
  isHead: boolean;
}): React.ReactElement {
  const shape = shapeOf(entry);
  const gloss = reasonGloss(entry.reasonCode);
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
      )}
    >
      {/* `aria-current` and the accent rule are the only things that single out head, and both
          are descriptions rather than offers. There is nothing here to press. */}
      <div aria-current={isHead ? "true" : undefined} className="px-3 py-2.5">
        <div className="flex items-baseline gap-2 font-mono text-[10px] text-carbon-40">
          <span className="font-semibold text-foreground">v{entry.version}</span>
          {/*
            §6.3's machine-readable half, said out loud. `MISSING_STEP` is a value you filter a
            log by; it is not a thing you say to a person, and rendering it raw made the one
            field that names WHAT KIND OF THING HAPPENED the least readable thing on the row.
            The tooltip carries the category's meaning and the exact enum value, so the
            queryable half is one hover away rather than gone.
          */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge tone="reason" size="xs" className="cursor-help">
                {reasonLabel(entry.reasonCode)}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              {gloss ?? "a cause this build of the viewer does not have a description for"}
              <div className="mt-1 font-mono opacity-70">reason_code: {entry.reasonCode}</div>
            </TooltipContent>
          </Tooltip>
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
      </div>

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

export function Timeline({ entries, headVersion }: TimelineProps): React.ReactElement {
  // No panel header. The thing that opened this said `timeline`, and its tooltip carries the
  // §6.3 explanation — a title bar underneath repeating the word, plus a count the entries
  // already are, would be the panel's most valuable row spent restating its own name.
  return (
    <section className="grid min-h-0 grid-rows-[minmax(0,1fr)]">
      <ScrollArea className="min-h-0">
        {entries.length === 0 ? (
          <p className="p-7 text-center font-mono text-[11px] text-carbon-40">no mutations yet</p>
        ) : (
          entries.map((entry) => (
            <Entry key={entry.version} entry={entry} isHead={entry.version === headVersion} />
          ))
        )}
      </ScrollArea>
    </section>
  );
}
