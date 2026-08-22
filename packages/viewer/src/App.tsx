/**
 * The whole application, and deliberately the only stateful thing in it.
 *
 * There are exactly three pieces of state here: the text of the log (owned by the feed), the
 * wall clock, and two pieces of pure UI — which node is selected and which version is being
 * looked at. Everything else on screen is a pure function of those. That is what "the viewer
 * holds zero authoritative state" means operationally: kill the process, restart it, and the
 * view is identical, because there was never anything here to lose.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { useLogFeed } from "./feed/useLog.ts";
import { useNow } from "./feed/useNow.ts";
import { buildPursuit, pursuitAt } from "./model/pursuit.ts";
import { buildGraphView } from "./model/view.ts";
import { createLayoutCache } from "./layout/dagre.ts";
import { Canvas } from "./graph/Canvas.tsx";
import { useFresh } from "./graph/useFresh.ts";
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
  const [viewing, setViewing] = useState<number | null>(null);
  // §6.10 rule 5 calls this panel the differentiator, so defaulting it CLOSED is a real
  // trade: the canvas gets the whole window, and the reason the graph looks like this is one
  // click away rather than in front of you. The header button is worded rather than a bare
  // icon so that the click is at least advertised.
  const [timelineOpen, setTimelineOpen] = useState(false);

  // Structure is memoized on the log text and the view on the clock, separately. Re-folding a
  // whole log once a second to move a countdown would be this viewer's own version of Burr
  // #834: the right answer at the wrong cost, and it would first be felt at the fan-out.
  const head = useMemo(() => buildPursuit(feed.text), [feed.text]);

  // `pursuitAt` rather than the two-line conditional it replaces, because nothing in this
  // package tests a `.tsx` file — judgment left in a component is judgment no mutant can
  // reach, and the first version of exactly this line shipped a bug that 589 tests missed.
  const shown = useMemo(() => pursuitAt(head, feed.text, viewing), [head, feed.text, viewing]);

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
    return points;
  }, [layout]);

  // The snap key is the version the reader ASKED for. It changes only when they scrub, never
  // when the file grows, which is exactly the line between "the graph moved" and "I moved".
  const positions = useTweenedPositions(target, String(viewing));

  const shownEntry = useMemo(
    () => head.timeline.find((entry) => entry.version === shown.graph.version) ?? null,
    [head, shown],
  );
  const fresh = useFresh(shownEntry?.diff ?? null);

  // A node can be selected and then time-travelled out of existence.
  useEffect(() => {
    if (selected !== null && !view.byId.has(selected)) setSelected(null);
  }, [view, selected]);

  const selectedView = selected === null ? null : (view.byId.get(selected) ?? null);
  const travelling = shown.graph.version !== head.graph.version;
  const damaged = head.damaged;

  return (
    <TooltipProvider>
      <div
        className={cn(
          "grid h-full grid-rows-[44px_minmax(0,1fr)]",
          timelineOpen ? "grid-cols-[minmax(0,1fr)_380px]" : "grid-cols-[minmax(0,1fr)]",
        )}
      >
        <header className="col-span-full flex items-center gap-4 border-b border-border bg-background px-4 shadow-nav">
          {/* Set in caps as a literal, not `uppercase`: the wordmark IS the capitals, and a
              screen reader should read what is on the sign. Caps want the tracking opened up —
              `tracking-tight` is for lowercase, where the letters already sit close. */}
          <span className="text-[15px] font-semibold tracking-wide">KONA</span>
          <span className="text-ui-xs text-carbon-40 uppercase">Workflow graph</span>
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
            "relative grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto]",
            timelineOpen && "border-r border-border",
          )}
        >
          {damaged.length > 0 && (
            <p className={cn(NOTICE, "bg-error-bg text-status-failed-ink")}>
              {damaged.length} damaged record(s): {damaged[0]?.reason} at line {damaged[0]?.line}
            </p>
          )}
          {head.tornTail && (
            <p className={cn(NOTICE, "bg-warning-bg text-status-sending-ink")}>
              torn final line — the expected shape of a crash, not damage. Folded without it.
            </p>
          )}
          {travelling && (
            <p
              className={cn(
                NOTICE,
                "flex items-center gap-2.5 bg-warning-bg text-status-sending-ink",
              )}
            >
              <span>
                viewing v{shown.graph.version} as it stood — read-only. Head is v{head.graph.version}.
              </span>
              <button
                type="button"
                onClick={() => {
                  setViewing(null);
                }}
                className="cursor-pointer rounded-[3px] border border-current px-1.5 text-[10px]"
              >
                back to head
              </button>
            </p>
          )}

          <Canvas
            graph={shown.graph}
            view={view}
            positions={positions}
            fresh={fresh}
            selected={selected}
            onSelect={setSelected}
          />

          {selectedView !== null && (
            <Inspector
              graph={shown.graph}
              view={selectedView}
              onClose={() => {
                setSelected(null);
              }}
            />
          )}
        </main>

        {/*
          Unmounted, not hidden. The panel is a pure function of `head.timeline`, so there is
          nothing in it to preserve across a close — and leaving it mounted would keep a
          scrolled position and a `rationale detail` toggle alive behind a panel nobody can
          see, which is state the viewer is not supposed to have.
        */}
        {timelineOpen && (
          <aside className="grid min-h-0 grid-rows-[minmax(0,1fr)] bg-background">
            <Timeline
              entries={head.timeline}
              headVersion={head.graph.version}
              viewing={shown.graph.version}
              onView={(version) => {
                setViewing(version === head.graph.version ? null : version);
              }}
            />
          </aside>
        )}
      </div>
    </TooltipProvider>
  );
}
