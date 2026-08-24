/**
 * Edges must be drawable before anything has been measured.
 *
 * The bug this guards: the canvas rendered its cards, dagre had laid them out in dependency
 * order, and not one edge appeared — including the two marker edges. Reloading sometimes
 * fixed it, which is the tell for a race rather than bad data.
 *
 * React Flow refuses to position an edge whose endpoints fail `isNodeInitialized`:
 *
 *   `!!(node.internals.handleBounds || node.handles?.length) && !!(measured.width || width)`
 *
 * `handleBounds` arrives from a ResizeObserver on the card's DOM. Until it does, the only way
 * the test can pass is `node.handles`, and `getEdgePosition` silently returns `null` for every
 * edge in the graph while it is missing.
 *
 * So these assert the geometry the canvas declares, against the same node boxes dagre uses.
 * If the card ever moves a handle off the left or right edge, this fails here rather than as
 * an intermittently empty canvas.
 */

import { describe, expect, test } from "bun:test";
import { Position } from "@xyflow/react";
import { MARKER_SIZE, NODE_SIZE } from "../src/layout/dagre.ts";
import { edgeHandles } from "../src/layout/handles.ts";

const BOXES = [
  ["task", NODE_SIZE.task],
  ["wait", NODE_SIZE.wait],
  ["marker", MARKER_SIZE],
] as const;

describe("edgeHandles", () => {
  for (const [name, size] of BOXES) {
    describe(name, () => {
      const handles = edgeHandles(size);

      test("declares both a source and a target", () => {
        // `handles.length` is the half of isNodeInitialized that does not need the DOM, and
        // an edge needs a target on one node and a source on the other.
        expect(handles.map((h) => h.type).toSorted()).toEqual(["source", "target"]);
      });

      test("puts the target on the left edge, vertically centred", () => {
        const target = handles.find((h) => h.type === "target");
        expect(target).toMatchObject({ position: Position.Left, x: 0, y: size.height / 2 });
      });

      test("puts the source on the right edge, vertically centred", () => {
        const source = handles.find((h) => h.type === "source");
        expect(source).toMatchObject({
          position: Position.Right,
          x: size.width,
          y: size.height / 2,
        });
      });

      test("gives every handle a non-zero box", () => {
        // `toHandleBounds` defaults a missing width/height to 1. Relying on that default
        // would make the geometry depend on library internals we do not control.
        for (const handle of handles) {
          expect(handle.width).toBeGreaterThan(0);
          expect(handle.height).toBeGreaterThan(0);
        }
      });

      test("satisfies React Flow's initialization test with no measurement at all", () => {
        // The predicate, transcribed from @xyflow/system. `width` comes from the same
        // NODE_SIZE box the canvas sets, so both halves hold before the observer runs.
        const measured = undefined;
        const initialized = !!(measured ?? handles.length) && !!(measured ?? size.width);
        expect(initialized).toBe(true);
      });
    });
  }

  test("handles sit inside the node box, so an edge lands on the card and not beside it", () => {
    for (const [, size] of BOXES) {
      for (const handle of edgeHandles(size)) {
        expect(handle.x).toBeGreaterThanOrEqual(0);
        expect(handle.x).toBeLessThanOrEqual(size.width);
        expect(handle.y).toBeGreaterThanOrEqual(0);
        expect(handle.y).toBeLessThanOrEqual(size.height);
      }
    }
  });
});
