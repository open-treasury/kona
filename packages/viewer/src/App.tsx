/**
 * The whole application, and deliberately the only stateful thing in it.
 *
 * There are exactly four pieces of state here: the text of the log (owned by the feed), the
 * wall clock, and two pieces of pure UI — which node is selected and whether the timeline is
 * open. Everything else on screen is a pure function of those. That is what "the viewer holds
 * zero authoritative state" means operationally: kill the process, restart it, and the view is
 * identical, because there was never anything here to lose.
 *
 * There is no version to be "at". The canvas shows head and only head — the timeline is read,
 * not operated (see `Timeline.tsx`).
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { useLogFeed } from "./feed/useLog.ts";
import { useNow } from "./feed/useNow.ts";
import { buildPursuit } from "./model/pursuit.ts";
import { buildGraphView } from "./model/view.ts";
import { createLayoutCache } from "./layout/dagre.ts";
import { Canvas } from "./graph/Canvas.tsx";
import { freshFromDiff, useFresh } from "./graph/useFresh.ts";
import { useTweenedPositions } from "./graph/useTween.ts";
import type { Point } from "./graph/useTween.ts";
import { Timeline } from "./panels/Timeline.tsx";
import { Inspector } from "./panels/Inspector.tsx";
import { cn } from "./lib/cn.ts";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip.tsx";

/**
 * The feed light. `open` and `lost` are `EventSource`'s words, not a reader's — what a reader
 * wants to know is whether the picture in front of them is still following the file. `lost`
 * renders as *reconnecting* because that is what is actually happening: EventSource retries on
 * its own with a backoff, so there is nothing for anybody to do about it.
 */
const FEED: Record<string, { dot: string; label: string }> = {
  connecting: { dot: "bg-status-dropped-ink", label: "connecting" },
  open: { dot: "bg-status-done-ink animate-breathe", label: "live" },
  lost: { dot: "bg-status-failed-ink", label: "reconnecting" },
};

const NOTICE = "px-3.5 py-1.5 font-mono text-[11px] border-b border-border";

export function App(): React.ReactElement {
  const feed = useLogFeed();
  const now = useNow();
  const [selected, setSelected] = useState<string | null>(null);
  // Which version's change is held highlighted on the canvas. Null is the normal state:
  // the newest arrival flashes and fades, and nothing is pinned.
  const [pinnedVersion, setPinnedVersion] = useState<number | null>(null);
  // §6.10 rule 5 calls this panel the differentiator, so defaulting it CLOSED is a real
  // trade: the canvas gets the whole window, and the reason the graph looks like this is one
  // click away rather than in front of you. The header button is worded rather than a bare
  // icon so that the click is at least advertised.
  const [timelineOpen, setTimelineOpen] = useState(false);

  // Structure is memoized on the log text and the view on the clock, separately. Re-folding a
  // whole log once a second to move a countdown would be this viewer's own version of Burr
  // #834: the right answer at the wrong cost, and it would first be felt at the fan-out.
  const shown = useMemo(() => buildPursuit(feed.text), [feed.text]);

  const view = useMemo(
    () => buildGraphView(shown.graph, shown.completionTime, now),
    [shown, now],
  );

  // One cache for the process lifetime. §6.10 rule 2: the layout is recomputed when the
  // topology signature changes and at no other time, so a status tick cannot move a node.
  const layoutCache = useRef(createLayoutCache());
  const layout = useMemo(() => layoutCache.current(shown.graph), [shown]);

  const target = useMemo<ReadonlyMap<string, Point>>(() => {
    const points = new Map<string, Point>();
    for (const [id, box] of layout.boxes) points.set(id, { x: box.x, y: box.y });
    // The two notation circles move with everything else, or they would sit where the previous
    // version left them while the graph slid out from under their arrows.
    for (const [id, box] of layout.markers) points.set(id, { x: box.x, y: box.y });
    return points;
  }, [layout]);

  const positions = useTweenedPositions(target);

  const shownEntry = useMemo(
    () => shown.timeline.find((entry) => entry.version === shown.graph.version) ?? null,
    [shown],
  );
  const flash = useFresh(shownEntry?.diff ?? null);

  // A pin outranks the flash. `useFresh` answers "what just arrived" and decays; a pinned
  // version answers "what did v8 touch" and has to stay put while the reader looks from the
  // row to the canvas. The canvas takes one highlight set and does not care which it is.
  const pinnedDiff = useMemo(
    () => shown.timeline.find((entry) => entry.version === pinnedVersion)?.diff ?? null,
    [shown, pinnedVersion],
  );
  const fresh = pinnedDiff === null ? flash : freshFromDiff(pinnedDiff);

  // A pinned version can be scrolled off the end of a truncated timeline, or belong to a log
  // that has since been replaced. Drop the pin rather than highlight nothing and look broken.
  useEffect(() => {
    if (pinnedVersion !== null && pinnedDiff === null) setPinnedVersion(null);
  }, [pinnedVersion, pinnedDiff]);

  // A node can be selected and then time-travelled out of existence.
  useEffect(() => {
    if (selected !== null && !view.byId.has(selected)) setSelected(null);
  }, [view, selected]);

  const selectedView = selected === null ? null : (view.byId.get(selected) ?? null);
  // ONE right rail, with two sections in it rather than two rails side by side. A second
  // 380px column would cost the canvas 760px of a 1512px window, and the graph is already the
  // thing that runs out of room first (kona-e6-8h7.10). Stacking also keeps §6.10 rule 5's
  // panel reachable while a node is selected — a rail that swapped the timeline out for the
  // inspector would make selecting a card silently close the differentiator.
  const railOpen = timelineOpen || selectedView !== null;
  const damaged = shown.damaged;

  return (
    <TooltipProvider>
      <div
        className={cn(
          "grid h-full grid-rows-[44px_minmax(0,1fr)]",
          railOpen ? "grid-cols-[minmax(0,1fr)_380px]" : "grid-cols-[minmax(0,1fr)]",
        )}
      >
        <header className="col-span-full flex items-center gap-4 border-b border-border bg-background px-4 shadow-nav">
          {/* Set in caps as a literal, not `uppercase`: the wordmark IS the capitals, and a
              screen reader should read what is on the sign. Caps want the tracking opened up —
              `tracking-tight` is for lowercase, where the letters already sit close. */}
          <span className="text-[15px] font-semibold tracking-wide">KONA</span>
          <span className="text-ui-xs text-carbon-40 uppercase">Workflow Viewer</span>
          <span className="flex-1" />

          {/*
            Left to right: is the picture still following the file, what version is it, and the
            way to the reasons behind it. Widest fact to narrowest, and the only control last —
            so the eye lands on the one thing that can be WRONG (a dead feed) before it lands
            on anything it can click.
          */}
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex cursor-help items-center gap-1.5 text-ui-xs text-muted-foreground uppercase">
                <span
                  className={cn("size-1.5 rounded-full", FEED[feed.state]?.dot ?? "bg-carbon-40")}
                />
                {FEED[feed.state]?.label ?? feed.state}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              the file-watch stream from the pursuit&apos;s <code>mutations.jsonl</code> — the
              viewer&apos;s only source. While it is live, every append reaches this canvas.
            </TooltipContent>
          </Tooltip>

          <span className="font-mono text-[11px] text-muted-foreground">
            v<b className="font-semibold text-foreground">{shown.graph.version}</b>
          </span>

          {/*
            A word and nothing else. §6.10 rule 5 calls this panel "the differentiator", and a
            closed panel behind an unlabelled chevron is a differentiator nobody finds — the
            label is what makes it findable, and the fill is what says whether it is open, so a
            glyph beside it was the third thing saying the same thing.
          */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-expanded={timelineOpen}
                onClick={() => {
                  setTimelineOpen((open) => !open);
                }}
                className={cn(
                  "inline-flex items-center rounded-sm border px-2 py-1",
                  "text-ui-xs uppercase transition-colors duration-[--transition-fast]",
                  timelineOpen
                    ? "border-transparent bg-accent text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                timeline
              </button>
            </TooltipTrigger>
            <TooltipContent>
              the mutation timeline — every commit&apos;s rationale, newest first. §6.3 makes
              omitting one impossible, so there is a `why` behind every shape on this canvas.
            </TooltipContent>
          </Tooltip>
        </header>

        <main
          className={cn(
            "relative flex min-h-0 min-w-0 flex-col",
            railOpen && "border-r border-border",
          )}
        >
          {damaged.length > 0 && (
            <p className={cn(NOTICE, "bg-error-bg text-status-failed-ink")}>
              {damaged.length} damaged record(s): {damaged[0]?.reason} at line {damaged[0]?.line}
            </p>
          )}
          {shown.tornTail && (
            <p className={cn(NOTICE, "bg-warning-bg text-status-in-flight-ink")}>
              torn final line — the expected shape of a crash, not damage. Folded without it.
            </p>
          )}
          <div className="min-h-0 flex-1">
            <Canvas
              graph={shown.graph}
              view={view}
              positions={positions}
              fresh={fresh}
              selected={selected}
              onSelect={setSelected}
            />
          </div>
        </main>

        {/*
          Unmounted, not hidden. The panel is a pure function of `head.timeline`, so there is
          nothing in it to preserve across a close — and leaving it mounted would keep a
          scrolled position and a `rationale detail` toggle alive behind a panel nobody can
          see, which is state the viewer is not supposed to have.
        */}
        {railOpen && (
          <aside className="flex min-h-0 min-w-0 flex-col bg-background">
            {/* The selected node on top, because it is what the reader just asked for. It is
                capped rather than halved: a task with no wait and no outcome is six rows, and
                giving it half the rail would be six rows of data over a field of white. */}
            {selectedView !== null && (
              <div
                className={cn(
                  "flex min-h-0 flex-col",
                  timelineOpen ? "max-h-[58%] border-b border-border" : "flex-1",
                )}
              >
                <Inspector
                  graph={shown.graph}
                  view={selectedView}
                  onClose={() => {
                    setSelected(null);
                  }}
                />
              </div>
            )}
            {timelineOpen && (
              <div className="flex min-h-0 flex-1 flex-col">
                <Timeline
                  entries={shown.timeline}
                  headVersion={shown.graph.version}
                  pinnedVersion={pinnedVersion}
                  onPin={setPinnedVersion}
                />
              </div>
            )}
          </aside>
        )}
      </div>
    </TooltipProvider>
  );
}
