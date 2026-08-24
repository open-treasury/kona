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
import { formatStamp } from "../format.ts";
import { changeSummary } from "../model/summary.ts";
import { reasonGloss, reasonLabel } from "../model/reason.ts";
import { cn } from "../lib/cn.ts";
import { ScrollArea } from "../ui/scroll-area.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";

export interface TimelineProps {
  entries: readonly TimelineEntry[];
  /** The version on the canvas — always head, and marked so the newest row is not just first. */
  headVersion: number;
  /** The version whose change is held highlighted on the canvas, or null for none. */
  pinnedVersion: number | null;
  onPin: (version: number | null) => void;
}

function Entry({
  entry,
  isHead,
  pinned,
  onPin,
}: {
  entry: TimelineEntry;
  isHead: boolean;
  pinned: boolean;
  onPin: () => void;
}): React.ReactElement {
  const gloss = reasonGloss(entry.reasonCode);
  const [open, setOpen] = useState(false);
  const extras =
    entry.expectedEffect !== null ||
    entry.alternativesRejected.length > 0 ||
    entry.trigger !== null;
  const detail = entry.ops.length > 0 || extras;

  return (
    <div
      className={cn(
        "border-b border-border border-l-2 border-l-transparent",
        isHead && "border-l-primary bg-carbon-4",
      )}
    >
      {/* `aria-current` and the accent rule are the only things that single out head, and both
          are descriptions rather than offers. The one thing to press is the version chip. */}
      <div
        aria-current={isHead ? "true" : undefined}
        className={cn("px-3 py-2.5", pinned && "bg-carbon-4")}
      >
        {/*
          Who, and when — the way an activity feed says it, because that is what this is. It
          led with `v13` and a right-aligned ISO string, which is the ordering a database would
          choose: the version is the row's identity but it is nobody's first question.
        */}
        <div className="flex items-baseline gap-1.5 font-mono text-[10px] text-carbon-40">
          <span className="truncate font-medium text-muted-foreground">{entry.actor}</span>
          <span>·</span>
          <span className="shrink-0">{formatStamp(entry.observedAt)}</span>
          <span className="flex-1" />
          {/*
            Press it to highlight what that version touched, ON THE HEAD CANVAS. It does not
            put an earlier graph there — `viewing`, the "as it stood at v8" banner and the
            layout jump are gone and stay gone. This answers "which of these activities did v8
            touch", which is a question about the graph already on screen.

            The chip and not the row, because the row already contains the `+ N ops` toggle
            and a button inside a button is not a thing.
          */}
          <button
            type="button"
            onClick={onPin}
            aria-pressed={pinned}
            title={
              pinned
                ? "stop highlighting this version"
                : `highlight what v${String(entry.version)} changed`
            }
            className={cn(
              "shrink-0 cursor-pointer rounded-sm px-1 tabular-nums",
              "hover:bg-carbon-8 focus-visible:outline-2 focus-visible:outline-primary",
              pinned && "bg-primary text-primary-foreground",
            )}
          >
            v{entry.version}
          </button>
        </div>

        {/*
          What it did, in one line. This slot used to hold the op list, which is the record
          rather than a summary — four opcodes a reader had to add up themselves to learn that
          two steps were added. The opcodes are still exact and still here, one toggle down.
        */}
        <div className="mt-0.5 font-mono text-[11px] text-foreground">{changeSummary(entry)}</div>

        {/*
          The serif is the point of this line. Everything around it is machine output — an
          actor, a version, an opcode, a timestamp — and all of it is set in mono. `why` is the
          one place a person wrote a sentence, and §6.3 is the argument that the sentence is
          the product. Crimson Pro is how a reader sees that before reading a word of it.
        */}
        <p className="mt-2 font-serif text-[15px] leading-snug text-foreground">{entry.why}</p>

        {/*
          The category, labelled so it explains itself rather than sitting up top as a chip a
          reader has to decode. `reason:` in front is what turns `missing step` from a tag into
          a statement about the sentence above it.
        */}
        <div className="mt-2 flex items-baseline gap-1.5 font-mono text-[10px]">
          <span className="text-carbon-40">reason:</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help text-muted-foreground underline decoration-border decoration-dotted underline-offset-2">
                {reasonLabel(entry.reasonCode)}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {gloss ?? "a cause this build of the viewer does not have a description for"}
              <div className="mt-1 font-mono opacity-70">reason_code: {entry.reasonCode}</div>
            </TooltipContent>
          </Tooltip>
        </div>

        {detail && (
          <>
            <button
              type="button"
              onClick={() => {
                setOpen((value) => !value);
              }}
              className="mt-1.5 cursor-pointer font-mono text-[10px] text-carbon-40 hover:text-muted-foreground"
            >
              {/* A verb, not a glyph. `+ 2 ops` names a quantity and leaves the reader to
                  infer that the row does something; `View 2 ops` says what pressing it does,
                  which is the whole job of the only control on the panel. */}
              {open ? "Hide" : "View"} {entry.ops.length}{" "}
              {entry.ops.length === 1 ? "op" : "ops"}
              {extras ? " · rationale detail" : ""}
            </button>

            {open && entry.ops.length > 0 && (
              <ul className="mt-1.5 flex flex-col gap-px">
                {entry.ops.map((op, index) => (
                  <li
                    key={`${String(entry.version)}:${String(index)}`}
                    className="flex min-w-0 gap-1.5 font-mono text-[10px] text-muted-foreground"
                  >
                    <span className="w-24 shrink-0 text-carbon-40">{op.kind}</span>
                    <span className="truncate">
                      {op.activity}
                      {op.detail === "" ? "" : ` · ${op.detail}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {/*
        §6.3's rationale is four fields, not one. `why` is the sentence a human reads, but the
        other three are what make it auditable: what the author expected, what they considered
        and dismissed, and what event provoked them. The fixture happens to leave them empty on
        every record, which is exactly why they need a home now — a field that is only rendered
        once it has data is a field that gets discovered to be missing on stage.
      */}
      {extras && open && (
        <div className="px-3 pb-2.5">
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
        </div>
      )}
    </div>
  );
}

export function Timeline({
  entries,
  headVersion,
  pinnedVersion,
  onPin,
}: TimelineProps): React.ReactElement {
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
            <Entry
              key={entry.version}
              entry={entry}
              isHead={entry.version === headVersion}
              pinned={entry.version === pinnedVersion}
              onPin={() => {
                onPin(entry.version === pinnedVersion ? null : entry.version);
              }}
            />
          ))
        )}
      </ScrollArea>
    </section>
  );
}
