/**
 * §6.10 rule 7: **animate, don't snap.**
 *
 * When the log gains a version that changes the topology, dagre re-ranks and most nodes move.
 * Cutting them to their new coordinates makes the fan-out read as a redraw — the viewer looks
 * like it reloaded, and the one thing worth showing (that *this* graph grew *these* nodes)
 * is lost in the flicker. Interpolating the same positions over ~450 ms makes the growth
 * legible, which is the entire argument for building the diff animation first (rule 1).
 *
 * The tween runs off `requestAnimationFrame` rather than CSS transitions because React Flow
 * is in fully controlled mode: positions are props, and they have to be — the edges are drawn
 * from the same store the nodes are, so animating the nodes with a CSS transition would leave
 * every edge attached to where its node used to be for the length of the tween.
 *
 * **The noise this makes, and the fix that does not work.** Re-rendering the nodes ~28 times
 * makes React Flow re-measure each time, and the browser emits `ResizeObserver loop completed
 * with undelivered notifications` about once a frame — 96 of them, measured, for one version
 * landing. It is not an exception: the spec says the skipped observations go out on the next
 * frame, and Chrome reports it through `window.onerror` with no stack and line 0. It is
 * invisible under `kona view`, which serves a production bundle with no error overlay, and it
 * paints a red panel over the canvas under `bun run dev`.
 *
 * **Do not try to swallow it.** A capture-phase `window` `error` listener that matches the
 * message and calls `stopImmediatePropagation` — with or without `preventDefault` — silences
 * it and simultaneously stops React Flow ever finishing its measuring pass: nodes render,
 * `fitView` never runs, and **every edge disappears**. Measured both ways, twice. Whatever
 * xyflow does with that event, it needs it. A quiet console is not worth a canvas with no
 * edges on it.
 */

import { useEffect, useRef, useState } from "react";

export interface Point {
  x: number;
  y: number;
}

export type Positions = ReadonlyMap<string, Point>;

const DEFAULT_MS = 460;

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Interpolate from wherever the nodes currently *look* to where the new layout puts them.
 *
 * A node absent from the previous frame starts at its destination: there is no honest place to
 * fly it in from, and the flash on the card is what says "this one is new". Interrupting a
 * tween is safe — the running frame's positions are what the next tween starts from, so a
 * burst of appends produces one continuous motion rather than a stutter back to the old rank.
 */
export function useTweenedPositions(
  target: Positions,
  /**
   * Changes whenever the reader JUMPED rather than the file grew, and a change makes this
   * layout snap instead of tween.
   *
   * Rule 7's "animate, don't snap" is about a version *landing*: the graph grew, and the
   * motion is the growth. Read-only time travel is not that. Sliding the canvas from v10's
   * layout to v2's claims a rearrangement that never happened — the graph did not move, the
   * reader did — and rule 6 is emphatic that time travel must not look like the graph
   * changing under you.
   *
   * It is also what makes the interaction quiet. Interpolating over ~28 frames re-renders
   * every node on each one, and React Flow re-measures on each re-render; scrubbing back one
   * version produced **120** "ResizeObserver loop completed with undelivered notifications"
   * warnings, measured. Snapping produces one layout pass.
   */
  snapKey: string,
  durationMs: number = DEFAULT_MS,
): Positions {
  const [positions, setPositions] = useState<Positions>(target);
  const renderedRef = useRef<Positions>(target);
  const frameRef = useRef<number | null>(null);
  const snapRef = useRef(snapKey);

  useEffect(() => {
    const from = renderedRef.current;
    const jumped = snapRef.current !== snapKey;
    snapRef.current = snapKey;

    const settle = (): void => {
      renderedRef.current = target;
      setPositions(target);
    };

    // Nothing to interpolate: either the layout is unchanged, or every node in it is new.
    const moves = [...target].some(([id, point]) => {
      const prev = from.get(id);
      return prev !== undefined && (prev.x !== point.x || prev.y !== point.y);
    });
    if (jumped || !moves || durationMs <= 0 || prefersReducedMotion()) {
      settle();
      return;
    }

    const start = performance.now();
    const step = (stamp: number): void => {
      const progress = Math.min(1, (stamp - start) / durationMs);
      const eased = easeOutCubic(progress);
      const next = new Map<string, Point>();
      for (const [id, point] of target) {
        const prev = from.get(id) ?? point;
        next.set(id, {
          x: prev.x + (point.x - prev.x) * eased,
          y: prev.y + (point.y - prev.y) * eased,
        });
      }
      renderedRef.current = next;
      setPositions(next);
      frameRef.current = progress < 1 ? requestAnimationFrame(step) : null;
    };

    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [target, snapKey, durationMs]);

  return positions;
}
