/**
 * "…then flash the new subtree" — the last beat of §6.10 rule 1.
 *
 * The diff already knows exactly which nodes and edges a version added. This hook is only the
 * decay: it holds that set for long enough to be seen and then drops it, so a node added three
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
