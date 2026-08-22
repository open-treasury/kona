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
import { foldLog } from "@kona/core";
import { useLogFeed } from "./feed/useLog.ts";
import { useNow } from "./feed/useNow.ts";
import { buildPursuit } from "./model/pursuit.ts";
import { buildGraphView } from "./model/view.ts";
import { createLayoutCache } from "./layout/dagre.ts";
import { Canvas } from "./graph/Canvas.tsx";
import { useFresh } from "./graph/useFresh.ts";
import { useTweenedPositions } from "./graph/useTween.ts";
import type { Point } from "./graph/useTween.ts";
import { Timeline } from "./panels/Timeline.tsx";
import { Inspector } from "./panels/Inspector.tsx";
import { cn } from "./lib/cn.ts";
import { TooltipProvider } from "./ui/tooltip.tsx";

const LIVE_DOT: Record<string, string> = {
  connecting: "bg-status-dropped",
  open: "bg-status-done animate-breathe",
  lost: "bg-status-failed",
};

const NOTICE = "px-3.5 py-1.5 font-mono text-[11px] border-b border-border";

export function App(): React.ReactElement {
  const feed = useLogFeed();
  const now = useNow();
  const [selected, setSelected] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);

  // Structure is memoized on the log text and the view on the clock, separately. Re-folding a
  // whole log once a second to move a countdown would be this viewer's own version of Burr
  // #834: the right answer at the wrong cost, and it would first be felt at the fan-out.
  const head = useMemo(() => buildPursuit(feed.text), [feed.text]);

  const shown = useMemo(
    () =>
      viewing === null || viewing >= head.graph.version
        ? head.graph
        : foldLog(feed.text, { upToVersion: viewing }).graph,
    [feed.text, head, viewing],
  );

  const view = useMemo(
    () => buildGraphView(shown, head.completionTime, now),
    [shown, head, now],
  );

  // One cache for the process lifetime. §6.10 rule 2: the layout is recomputed when the
  // topology signature changes and at no other time, so a status tick cannot move a node.
  const layoutCache = useRef(createLayoutCache());
  const layout = useMemo(() => layoutCache.current(shown), [shown]);

  const target = useMemo<ReadonlyMap<string, Point>>(() => {
    const points = new Map<string, Point>();
    for (const [id, box] of layout.boxes) points.set(id, { x: box.x, y: box.y });
    return points;
  }, [layout]);

  const positions = useTweenedPositions(target);

  const shownEntry = useMemo(
    () => head.timeline.find((entry) => entry.version === shown.version) ?? null,
    [head, shown],
  );
  const fresh = useFresh(shownEntry?.diff ?? null);

  // A node can be selected and then time-travelled out of existence.
  useEffect(() => {
    if (selected !== null && !view.byId.has(selected)) setSelected(null);
  }, [view, selected]);

  const selectedView = selected === null ? null : (view.byId.get(selected) ?? null);
  const travelling = shown.version !== head.graph.version;
  const damaged = head.damaged;

  return (
    <TooltipProvider>
      <div className="grid h-full grid-cols-[minmax(0,1fr)_380px] grid-rows-[44px_minmax(0,1fr)]">
        <header className="col-span-full flex items-center gap-4 border-b border-border bg-background px-4 shadow-nav">
          <span className="text-[15px] font-semibold tracking-tight">kona</span>
          <span className="text-ui-xs text-carbon-40 uppercase">
            the binary never calls a model
          </span>
          <span className="flex-1" />
          <span className="font-mono text-[11px] text-muted-foreground">
            v<b className="font-semibold text-foreground">{shown.version}</b> ·{" "}
            <b className="font-semibold text-foreground">{view.nodes.length}</b> nodes ·{" "}
            <b className="font-semibold text-foreground">{shown.edges.length}</b> edges ·{" "}
            <b className="font-semibold text-foreground">{view.frontier.length}</b> ready
          </span>
          <span className="inline-flex items-center gap-1.5 text-ui-xs text-muted-foreground uppercase">
            <span className={cn("size-1.5 rounded-full", LIVE_DOT[feed.state])} />
            {feed.state}
          </span>
        </header>

        <main className="relative grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] border-r border-border">
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
                viewing v{shown.version} as it stood — read-only. Head is v{head.graph.version}.
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
            graph={shown}
            view={view}
            positions={positions}
            fresh={fresh}
            selected={selected}
            onSelect={setSelected}
          />

          {selectedView !== null && (
            <Inspector
              graph={shown}
              view={selectedView}
              onClose={() => {
                setSelected(null);
              }}
            />
          )}
        </main>

        <aside className="grid min-h-0 grid-rows-[minmax(0,1fr)] bg-background">
          <Timeline
            entries={head.timeline}
            headVersion={head.graph.version}
            viewing={shown.version}
            onView={(version) => {
              setViewing(version === head.graph.version ? null : version);
            }}
          />
        </aside>
      </div>
    </TooltipProvider>
  );
}
