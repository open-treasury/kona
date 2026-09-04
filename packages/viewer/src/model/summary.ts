/**
 * What a version DID, in one line a person can read.
 *
 * The panel used to put the op list where this line goes — `add_edge`, `supersede_node`, an activity
 * id truncated at the panel's edge. That is the record, and it is not a summary: reading four
 * opcodes to work out that two steps were added is work the row should have done for you.
 *
 * The op list is still there, one toggle away, because it is what actually happened and the
 * summary is a claim about it. This function decides what that claim says, which is why it
 * lives here and not in the panel — nothing in this package tests a `.tsx`.
 */

import type { GraphDiff, TimelineEntry } from "./types.ts";

/**
 * English plurals are irregular often enough that guessing with `+ "s"` is not worth it.
 *
 * `node` is regular and needs no override; `branch` is the one left that does. The noun rename
 * took the irregular case away from this line, which is worth noticing rather than deleting the
 * helper: `branch`/`branches` is still here and `+ "s"` is still wrong for it.
 */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/**
 * The list-of-two joiner English actually uses. `and` rather than a comma, because "added 2
 * activities, 2 edges" reads as a list that got cut off and "added 2 activities and 2 edges" does not.
 */
function conjoin(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1] ?? ""}`;
}

/**
 * Status changes are named ONLY when nothing else happened.
 *
 * Not because they do not matter — they are most of what a live pursuit does — but because a
 * version that adds two activities, wires an edge and retires two branches has already said the
 * interesting thing, and appending "and 2 status changes" to that pushes the line to two rows
 * to report the least surprising part of it. On a version that changed nothing else, the same
 * fact is the entire content of the line, and it carries rule 2's evidence with it.
 */
function topologySegments(diff: GraphDiff): string[] {
  const added: string[] = [];
  if (diff.addedNodes.length > 0) added.push(plural(diff.addedNodes.length, "node"));
  if (diff.addedEdges.length > 0) added.push(plural(diff.addedEdges.length, "edge"));

  const segments: string[] = [];
  if (added.length > 0) segments.push(`added ${conjoin(added)}`);
  if (diff.superseded.length > 0) {
    segments.push(`retired ${plural(diff.superseded.length, "branch", "branches")}`);
  }
  return segments;
}

/**
 * One line for the header of a timeline row. Never empty: a version that reports nothing is a
 * version a reader will assume the viewer failed to render.
 */
export function changeSummary(entry: TimelineEntry): string {
  const diff = entry.diff;
  // v0. `foldLog` gives it no diff because there is no version before it to differ from.
  if (diff === null) return "opened the pursuit";

  if (diff.topologyStable) {
    // Rule 2's claim, said where a reader can check it: the layout did not re-run, and this is
    // the line that says why it did not have to.
    if (diff.superseded.length > 0) {
      return `retired ${plural(diff.superseded.length, "branch", "branches")} — no re-layout`;
    }
    if (diff.statusChanged.length > 0) {
      return `${plural(diff.statusChanged.length, "status change")} — no re-layout`;
    }
    if (diff.outcomeAdded.length > 0) {
      return `${plural(diff.outcomeAdded.length, "outcome")} recorded — no re-layout`;
    }
    return "no change to the graph";
  }

  const segments = topologySegments(diff);
  // Topology moved but not by adding or retiring — an edge condition changed, say. The ops know
  // what it was; the summary declines to invent a verb for it.
  return segments.length > 0 ? segments.join(" · ") : "changed the shape of the graph";
}
