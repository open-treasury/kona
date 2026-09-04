/**
 * "…then flash the new subtree" — the last beat of §6.10 rule 1.
 *
 * The diff already knows exactly which activities and edges a version added. This hook is only the
 * decay: it holds that set for long enough to be seen and then drops it, so an activity added three
 * versions ago is not still glowing when the fourth lands. Without the decay the canvas
 * accumulates highlight until everything is highlighted, which is the same as nothing being
 * highlighted.
 */

import { useEffect, useRef, useState } from "react";
import type { GraphDiff } from "../model/types.ts";
import { edgeKeyString } from "../model/diff.ts";

const FLASH_MS = 1500;

export interface Fresh {
  nodes: ReadonlySet<string>;
  edges: ReadonlySet<string>;
}

const EMPTY: Fresh = { nodes: new Set(), edges: new Set() };

/**
 * `diff` is the change the newest version made. It is compared by version rather than by
 * identity so that a re-render caused by the clock ticking does not restart the flash.
 */
export function useFresh(diff: GraphDiff | null, holdMs: number = FLASH_MS): Fresh {
  const [fresh, setFresh] = useState<Fresh>(EMPTY);
  const seenRef = useRef<number>(-1);

  useEffect(() => {
    if (diff === null || diff.toVersion === seenRef.current) return;
    seenRef.current = diff.toVersion;

    if (diff.addedNodes.length === 0 && diff.addedEdges.length === 0) {
      setFresh(EMPTY);
      return;
    }

    setFresh({
      nodes: new Set(diff.addedNodes),
      edges: new Set(diff.addedEdges.map(edgeKeyString)),
    });

    const id = setTimeout(() => {
      setFresh(EMPTY);
    }, holdMs);
    return () => {
      clearTimeout(id);
    };
  }, [diff, holdMs]);

  return fresh;
}

/**
 * The same highlight, held rather than decayed — for a version the reader PINNED.
 *
 * `useFresh` answers "what just arrived", so it fades: an activity added three versions ago must
 * stop glowing or everything glows and nothing is highlighted. Pinning asks a different
 * question — "what did v8 touch" — and the answer has to stay on screen while the reader
 * looks from the row to the canvas and back.
 *
 * Wider than the flash, too. The flash shows what a version ADDED, because that is what
 * arriving means. A pinned version is being read, and "changed" includes a status tick, a
 * recorded outcome and a supersede — versions that add nothing at all still did something,
 * and a pin that highlighted nothing for them would look broken.
 */
export function freshFromDiff(diff: GraphDiff): Fresh {
  return {
    nodes: new Set([
      ...diff.addedNodes,
      ...diff.statusChanged.map((change) => change.id),
      ...diff.outcomeAdded,
      ...diff.superseded.map((entry) => entry.id),
    ]),
    edges: new Set(diff.addedEdges.map(edgeKeyString)),
  };
}
