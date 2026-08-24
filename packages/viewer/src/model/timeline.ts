/**
 * The mutation timeline — §6.10 rule 5, and the panel the plan calls the differentiator.
 *
 * Every tracing product can draw a graph. None of them can say why the graph has the shape it
 * has, because none of them has anywhere to put the answer. Kona's schema makes `why` and
 * `reason_code` impossible to omit, so this module's job is small and worth doing carefully:
 * turn each committed record into one row a person can read without opening the log, and hand
 * the canvas the diff that row is responsible for.
 *
 * Newest first, because a reader arrives asking what just happened. The log itself is oldest
 * first — it is an append-only file and could not be anything else — so the reversal belongs
 * here, once, rather than in whichever component happens to be rendering.
 *
 * **The per-version graphs are folded incrementally, in one pass.** The obvious alternative —
 * `foldLog(text, {upToVersion: v})` once per version — is quadratic in the length of the log,
 * and quadratic work behind a file watcher is exactly the shape of bug that makes a viewer
 * feel broken at scale: fine on the eight-line fixture, a visible stall on a pursuit that ran
 * for a week, and it happens on every single append. Each record's graph is its predecessor's
 * with one `applyOps` on top, which is the same function `foldLog` uses, so this cannot drift
 * from the fold it replaces.
 */

import type { Actor, CommittedOp, Graph, MutationRecord, Trigger } from "@kona/core";
import { SCHEMA_VERSION, applyOps, emptyGraph } from "@kona/core";
import { statusInWords } from "../format.ts";
import { diffGraphs } from "./diff.ts";
import type { TimelineEntry, TimelineOp } from "./types.ts";

/**
 * "orchestrator", "human ilya", "subagent roster-check".
 *
 * The kind alone when the id repeats it, because "orchestrator orchestrator" is noise in a
 * column a reader scans. §6.7 scopes write authority by kind, so the kind is the half that
 * carries meaning and it always leads.
 */
function actorLabel(actor: Actor): string {
  return actor.kind === actor.id ? actor.kind : `${actor.kind} ${actor.id}`;
}

/**
 * One line for what provoked the mutation.
 *
 * `trigger.body` is deliberately not in it. §6.10 rule 9 puts message bodies behind an
 * explicit reveal, and the timeline is the one panel that is always on screen — a counterparty's
 * words landing in it would put them on the projector during a demo with nobody having asked.
 * The relation and the kind say what happened; the inspector can offer the rest.
 */
function triggerLine(trigger: Trigger): string {
  const parts = [`${trigger.relation} · ${trigger.kind}`];
  if (trigger.from !== undefined) parts.push(`from ${trigger.from}`);
  if (trigger.in_reply_to !== undefined) parts.push(`in reply to ${trigger.in_reply_to}`);
  return parts.join(" · ");
}

function renderValue(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

/** `role=goalie · reason=away that week`, in the order the store recorded them. */
function renderAttrs(attrs: Record<string, unknown> | undefined): string[] {
  if (attrs === undefined) return [];
  return Object.entries(attrs).map(([key, value]) => `${key}=${renderValue(value)}`);
}

/**
 * Which activity the row is about.
 *
 * For `add_edge` that is `to`, not `from`: §6.2 says `{from: A, to: B}` means **B requires A**,
 * so the edge is a fact about B's dependencies. Reading it the other way round is the single
 * most common mistake made against this data model, and it is silent — the picture still draws,
 * every arrow simply points the wrong way.
 */
function subjectOf(op: CommittedOp): string {
  if (op.op === "add_activity") return op.id;
  if (op.op === "add_edge") return op.to;
  return op.activity;
}

/** The human half of the row. Phrasing, not judgment — nothing here decides anything. */
function detailOf(op: CommittedOp): string {
  switch (op.op) {
    case "add_activity":
      // The type is in because the two behave differently and a reader wants to know which
      // arrived: a `wait` is a step that will sit there until the world answers.
      return `added ${op.type}`;
    case "add_edge":
      return op.condition === undefined
        ? `requires ${op.from}`
        : `requires ${op.from} on ${op.condition.on}`;
    case "set_status":
      // The timeline is a sentence, so the status arrives as a word — see `statusInWords`.
      return `-> ${statusInWords(op.status)}`;
    case "record_outcome":
      // The verdict, then the attrs, because the attrs are what a predicate counts on
      // (`role=goalie`) and a reader tracking a quorum is looking for exactly them.
      return [op.verdict, ...renderAttrs(op.attrs)].join(" · ");
    case "record_output":
      // The name, never the value: an output is arbitrary JSON and rule 9's reveal is the
      // place for it. The name alone tells a reader which `inputs[].ref` just resolved.
      return `output ${op.output_name}`;
    case "supersede_activity":
      // `by` is optional (§6.4). Superseding with no replacement is how a branch is retired
      // outright — the fixture's Priya wait, after her address bounced — and calling that
      // "superseded by undefined" would read as a missing activity rather than a deliberate end.
      return op.by === undefined ? "superseded" : `superseded by ${op.by}`;
  }
}

function timelineOp(op: CommittedOp): TimelineOp {
  return { kind: op.op, activity: subjectOf(op), detail: detailOf(op) };
}

export function buildTimeline(records: readonly MutationRecord[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  // `emptyGraph` needs a schema version and the records carry it; falling back to core's
  // constant only matters for an empty log, which has no rows to build either way.
  let current: Graph = emptyGraph(records[0]?.schema_version ?? SCHEMA_VERSION);

  for (const [index, record] of records.entries()) {
    const before = current;
    const applied = applyOps(before, record.ops, record.v);
    // These records came out of `foldLog`, which applied every one of them with this same
    // function and kept only the ones that succeeded — so a refusal here is unreachable rather
    // than merely unlikely. Carrying the previous graph forward is the honest fallback: the
    // version produced no change we can show, which is what an empty diff says.
    current = applied.ok ? applied.value : before;

    entries.push({
      version: record.v,
      observedAt: record.observed_at,
      occurredAt: record.occurred_at,
      actor: actorLabel(record.actor),
      why: record.rationale.why,
      reasonCode: record.rationale.reason_code,
      expectedEffect: record.rationale.expected_effect ?? null,
      alternativesRejected: record.rationale.alternatives_rejected,
      trigger: record.trigger === undefined ? null : triggerLine(record.trigger),
      ops: record.ops.map(timelineOp),
      // Genesis has no predecessor to compare against. Diffing it against the empty graph
      // would produce a row of zeroes indistinguishable from a status tick, and "nothing
      // changed" is the wrong thing to say about the version that started the pursuit.
      diff: index === 0 ? null : diffGraphs(before, current),
    });
  }

  // Newest first (rule 5). `toReversed` rather than `reverse` so the array we hand back is not
  // one we have already been mutating in place.
  return entries.toReversed();
}
