/**
 * Log text in, everything the viewer renders that does not depend on the wall clock. The one
 * entry point the React tree calls.
 *
 * D1 is what this module is: the viewer folds the same file `kona graph --json` folds, with
 * core's own `foldLog`, because the projection alone cannot answer three of the spec's
 * requirements. The timeline needs `v`, `ops` and `rationale`; rule 6's read-only time travel
 * needs every version, not just head; and a `{after, duration}` deadline needs to know when
 * its anchor actually finished, which is `observed_at` in the log and appears nowhere in the
 * graph. Folding here rather than shelling out is also what makes the whole view a pure
 * function of its arguments, which is why every assertion in `test/` can be exact.
 *
 * There is no clock in this signature, and that is the point. `GraphView` is built separately
 * (`buildGraphView`) because a countdown ticks every second while structure changes only when
 * the file does; folding a whole log once a second to move a countdown would be this viewer's
 * own Burr #834. The caller memoizes this on the log text and rebuilds only the view on the
 * clock, which is only possible because nothing returned here reads `now`.
 *
 * `torn_tail` and `damaged` come out on the result rather than being swallowed. A truncated
 * final line is the expected shape of a crash — append-then-fsync can damage nothing else —
 * and a viewer that quietly rendered the graph without it would be showing a pursuit one
 * mutation behind the file, with no sign that it was. §6.7 is explicit: report which records
 * failed rather than dying, and rather than hiding.
 */

import type { MutationRecord } from "@kona/core";
import { TERMINAL_SUCCESS_STATUS, foldLog } from "@kona/core";
import { buildTimeline } from "./timeline.ts";
import type { Instant, PursuitView } from "./types.ts";

/**
 * Version → the moment the store observed it.
 *
 * `observed_at` and not `occurred_at`: §6.3 has the engine stamp `observed_at`, while
 * `occurred_at` is when the world says the thing happened and can be anything a counterparty's
 * mail server chose to write. A clock run off a remote stamp is a clock that can move
 * backwards.
 *
 * An unparseable stamp is left out rather than defaulted. A missing entry is a case every
 * consumer already handles, and handles by saying so in words; a `NaN` or an epoch zero would
 * silently produce a deadline in 1970 and paint the node blown.
 */
export function versionTimeOf(records: readonly MutationRecord[]): Map<number, Instant> {
  const times = new Map<number, Instant>();
  for (const record of records) {
    const at = Date.parse(record.observed_at);
    if (!Number.isNaN(at)) times.set(record.v, at);
  }
  return times;
}

/**
 * Node id → the moment it first *succeeded*. The clock a `{after, duration}` deadline runs
 * from, and the reason this map exists at all.
 *
 * The tempting one-liner is `versionTime.get(node.status.observed_at_version)`, and it is
 * wrong. `observed_at_version` is the LAST version to touch the node, and §6.4 makes
 * `record_outcome` and `record_output` legal against a terminal one: a delivery receipt or a
 * §6.5 `late` reply landing an hour after the send would move `observed_at_version` forward,
 * slide the downstream deadline with it, and turn a wait the store considers blown back into
 * one that is quietly counting down. The moment a node finished cannot be revised by learning
 * something else about it afterwards, so it is recorded when it happens and never again —
 * hence FIRST occurrence only, even if a later version sets `done` a second time.
 *
 * Only `done` counts, and `TERMINAL_SUCCESS_STATUS` rather than the literal for the same
 * reason `satisfiesBlockingEdge` uses it: `failed` and `dropped` are terminal too, and a send
 * that bounced never started anybody's clock.
 */
export function completionTimeOf(records: readonly MutationRecord[]): Map<string, Instant> {
  const times = new Map<string, Instant>();
  for (const record of records) {
    const at = Date.parse(record.observed_at);
    if (Number.isNaN(at)) continue;
    for (const op of record.ops) {
      if (op.op !== "set_status" || op.status !== TERMINAL_SUCCESS_STATUS) continue;
      if (!times.has(op.node)) times.set(op.node, at);
    }
  }
  return times;
}

/**
 * `upToVersion` is read-only time travel (§6.10 rule 6), and it is not a revert: nothing is
 * written, nothing is removed, and head is still head — the caller simply folds fewer lines.
 * Both time maps are built from the same truncated record list on purpose, so a deadline
 * anchored to a node that has not finished *yet at this version* reads as unarmed rather than
 * borrowing a time from a future the reader is not looking at.
 */
export function buildPursuit(logText: string, upToVersion?: number): PursuitView {
  // `exactOptionalPropertyTypes` refuses `{ upToVersion: undefined }`, and rightly: absent and
  // present-but-undefined mean different things to a fold with a ceiling.
  const folded = foldLog(logText, upToVersion === undefined ? {} : { upToVersion });

  return {
    graph: folded.graph,
    records: folded.records,
    timeline: buildTimeline(folded.records),
    versionTime: versionTimeOf(folded.records),
    completionTime: completionTimeOf(folded.records),
    tornTail: folded.torn_tail !== null,
    damaged: folded.damaged,
  };
}
