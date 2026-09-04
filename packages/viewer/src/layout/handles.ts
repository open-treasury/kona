/**
 * The handle geometry, stated rather than measured.
 *
 * React Flow will not draw an edge whose endpoints are not "initialized". Its test, from
 * `@xyflow/system`, is
 *
 *   `!!(activity.internals.handleBounds || activity.handles?.length) && !!(measured.width || width)`
 *
 * and `getEdgePosition` returns `null` when either end fails it — silently, with no warning
 * and no error. `handleBounds` is produced by a ResizeObserver measuring the card's DOM, so
 * until that pass lands there are no bounds and **every edge in the graph is missing**. That
 * is the "sometimes the edges are gone and I have to reload" bug: reloading does not fix
 * anything, it just gives the observer another chance to win the race.
 *
 * Every card puts its target handle at the left edge, centred, and its source handle at the
 * right edge, centred — and dagre has already laid the graph out using these exact boxes. So
 * the positions are known before any measurement and can simply be declared.
 *
 * `getEdgePosition` reads `internals.handleBounds || toHandleBounds(activity.handles)`, so measured
 * bounds still win the moment they exist. This is a floor, not an override: it removes the
 * window in which there is nothing to draw with, and changes nothing after it closes.
 */

import { Position } from "@xyflow/react";
import type { NodeHandle } from "@xyflow/react";

export function edgeHandles(size: { width: number; height: number }): NodeHandle[] {
  const y = size.height / 2;
  return [
    { type: "target", position: Position.Left, x: 0, y, width: 1, height: 1 },
    { type: "source", position: Position.Right, x: size.width, y, width: 1, height: 1 },
  ];
}

/**
 * A bar's handles, distributed ALONG its length rather than stacked at its midpoint.
 *
 * A fork is a synchronisation mark: the point of drawing it as a bar rather than a dot is that
 * you can see the arms leave it at different heights, in the order dagre ranked them. With one
 * centred handle every arm leaves the same pixel and the bar reads as a decorated dot — the
 * shape is there and the information it exists to carry is not.
 *
 * The count is the arm count and the bar's length is a function of the same number
 * (`sizeOf`), so the spacing is even by construction rather than by tuning.
 */
export function barHandles(
  size: { width: number; height: number },
  ins: number,
  outs: number,
): NodeHandle[] {
  const along = (count: number) =>
    // Midpoints of `count` equal bands, so the first and last sit inside the bar rather than
    // on its ends — an arrow landing exactly on a corner reads as missing it.
    Array.from(
      { length: Math.max(count, 1) },
      (_, index) => ((index + 0.5) / Math.max(count, 1)) * size.height,
    );

  return [
    ...along(ins).map((y, index) => ({
      type: "target" as const,
      position: Position.Left,
      id: `in-${String(index)}`,
      x: 0,
      y,
      width: 1,
      height: 1,
    })),
    ...along(outs).map((y, index) => ({
      type: "source" as const,
      position: Position.Right,
      id: `out-${String(index)}`,
      x: size.width,
      y,
      width: 1,
      height: 1,
    })),
  ];
}
