/**
 * What the lines mean.
 *
 * Everything else on this canvas describes itself: a card carries its own status word, its own
 * countdown, its own blocked reason. The lines are the exception — six visual codes, none of
 * them nameable by looking, and a reader who does not already know that a dashed amber arc is
 * `on_timeout` has no way to find out. That is the one place the graph asks for prior knowledge,
 * so it is the one place worth spending a panel on.
 *
 * **Collapsed by default**, for the same reason the timeline is: this window's job is to show
 * a pursuit, and a permanent box in the corner is furniture. It is a labelled chip rather than
 * a `?` glyph because a legend nobody finds is a legend nobody has.
 */

import { useState } from "react";
import { Panel } from "@xyflow/react";
import { cn } from "../lib/cn.ts";

interface Row {
  /** Drawn with the same tokens `theme.css` gives the real edge, so the sample cannot drift. */
  stroke: string;
  width: number;
  dash?: string;
  round?: boolean;
  opacity?: number;
  term: string;
  gloss: string;
}

const ROWS: readonly Row[] = [
  {
    stroke: "var(--color-edge)",
    width: 1.5,
    term: "requires",
    gloss: "this step cannot start until that one is done",
  },
  {
    stroke: "var(--color-success)",
    width: 2,
    term: "satisfied",
    gloss: "that requirement is met — the work is free to run",
  },
  {
    stroke: "var(--color-carbon-8)",
    width: 1.5,
    dash: "3 4",
    term: "never satisfiable",
    gloss: "the step it needs ended without succeeding, so it can never become ready",
  },
  {
    stroke: "var(--color-ochre-bold)",
    width: 1.25,
    dash: "5 4",
    opacity: 0.45,
    term: "on timeout",
    gloss: "where a blown deadline goes. §6.4 gives every wait one, so nothing hangs silently",
  },
  {
    stroke: "var(--color-carbon-40)",
    width: 1.25,
    dash: "1 4",
    round: true,
    opacity: 0.7,
    term: "replaced by",
    gloss: "this was superseded. Nothing is ever deleted, so it keeps its place",
  },
];

function Sample({ row }: { row: Row }): React.ReactElement {
  return (
    <svg aria-hidden width="26" height="8" viewBox="0 0 26 8" className="mt-1 shrink-0">
      <line
        x1="0"
        y1="4"
        x2="26"
        y2="4"
        stroke={row.stroke}
        strokeWidth={row.width}
        strokeDasharray={row.dash}
        strokeLinecap={row.round === true ? "round" : "butt"}
        opacity={row.opacity}
      />
    </svg>
  );
}

export function Legend(): React.ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <Panel position="bottom-right" className="!m-3">
      <div
        className={cn(
          "overflow-hidden rounded-md border border-border bg-card shadow-subtle",
          open && "w-[300px]",
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen((value) => !value);
          }}
          className={cn(
            "w-full cursor-pointer px-2.5 py-1.5 text-left text-ui-xs uppercase",
            "text-muted-foreground transition-colors duration-[--transition-fast]",
            "hover:bg-accent hover:text-foreground",
          )}
        >
          {open ? "Hide legend" : "Legend"}
        </button>

        {open && (
          <dl className="flex flex-col gap-2 border-t border-border px-2.5 py-2.5">
            {ROWS.map((row) => (
              <div key={row.term} className="flex gap-2">
                <Sample row={row} />
                <div className="min-w-0">
                  <dt className="font-mono text-[10px] text-foreground">{row.term}</dt>
                  <dd className="text-[10px] leading-snug text-carbon-40">{row.gloss}</dd>
                </div>
              </div>
            ))}

            {/*
              The two notation circles. They are not edges, but they are the other thing on the
              canvas nothing in the log corresponds to, so this is where a reader will look.
            */}
            <div className="flex gap-2 border-t border-border pt-2">
              <span className="mt-0.5 flex shrink-0 items-center gap-1">
                <span className="size-2.5 rounded-full bg-foreground" />
                <span className="flex size-2.5 items-center justify-center rounded-full border border-foreground" />
              </span>
              <div className="min-w-0">
                <dt className="font-mono text-[10px] text-foreground">start / end</dt>
                <dd className="text-[10px] leading-snug text-carbon-40">
                  where the flow enters and leaves. The ring is not &ldquo;finished&rdquo; — the
                  graph grows, so a leaf now can gain children in the next version
                </dd>
              </div>
            </div>
          </dl>
        )}
      </div>
    </Panel>
  );
}
