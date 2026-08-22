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
 * is in fully controlled mode: positions are props, so the only place they can change smoothly
 * is here.
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
export function useTweenedPositions(target: Positions, durationMs: number = DEFAULT_MS): Positions {
  const [positions, setPositions] = useState<Positions>(target);
  const renderedRef = useRef<Positions>(target);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const from = renderedRef.current;

    const settle = (): void => {
      renderedRef.current = target;
      setPositions(target);
    };

    // Nothing to interpolate: either the layout is unchanged, or every node in it is new.
    const moves = [...target].some(([id, point]) => {
      const prev = from.get(id);
      return prev !== undefined && (prev.x !== point.x || prev.y !== point.y);
    });
    if (!moves || durationMs <= 0 || prefersReducedMotion()) {
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
  }, [target, durationMs]);

  return positions;
}
