/**
 * The six ops, as pure functions over a graph (§6.4).
 *
 * This module is shared by `fold` and by `mutate`'s pre-commit dry run, which is the
 * point: the state a mutation is validated against is produced by the same code that
 * will later reproduce it from the log. There is no second implementation to drift.
 */

import type { CommittedOp } from "./schema.ts";
import { namedIn } from "./named.ts";
import { parseEffectEvidence } from "./effect.ts";
import type { Edge, Graph, Activity, ActivitySpec, OutcomeRecord } from "./graph.ts";
import { isActivityTerminal, resolvingOutcome } from "./graph.ts";
import { type Result, ok, refuse } from "./result.ts";

/**
 * §6.4 — "Internal order: additions and rewires before cancellations."
 *
 * A stable partition rather than a sort: order *within* each class is the authored array
 * order, so `ops[1]` still applies before `ops[2]`. What moves is cancellation, which
 * goes last so that a batch superseding an activity and adding its compensation is legal
 * however the author happened to sequence the two.
 */
const CANCELLATION_OPS = new Set(["supersede_activity"]);

/** An op paired with the position it held in the authored array, for error reporting. */
export interface PositionedOp {
  op: CommittedOp;
  index: number;
}

export function orderOps(ops: readonly CommittedOp[]): PositionedOp[] {
  const positioned = ops.map((op, index) => ({ op, index }));
  return [
    ...positioned.filter((entry) => !CANCELLATION_OPS.has(entry.op.op)),
    ...positioned.filter((entry) => CANCELLATION_OPS.has(entry.op.op)),
  ];
}

/**
 * `spec` is shared by reference on purpose: §6.2 makes it the AUTHORED half, changed only
 * by an op that replaces the whole activity, never edited in place. Everything an op *does*
 * write — status and provenance — is copied.
 *
 * Hand-written rather than `structuredClone` because `core` declares no ambient runtime:
 * zero deps, no globals, nothing to stub. That is what makes the mutation-score target on
 * this file affordable (§6.12).
 */
function cloneActivity(activity: Activity): Activity {
  return {
    ...activity,
    status: {
      ...activity.status,
      conditions: [...activity.status.conditions],
      outcomes: activity.status.outcomes.map((entry) => ({ ...entry })),
      effect_log: activity.status.effect_log.map((entry) => ({ ...entry })),
    },
    provenance: { ...activity.provenance },
  };
}

function cloneGraph(graph: Graph): Graph {
  return {
    schema_version: graph.schema_version,
    version: graph.version,
    activities: new Map([...graph.activities].map(([id, activity]) => [id, cloneActivity(activity)])),
    edges: graph.edges.map((edge) => ({ ...edge })),
  };
}

function makeNode(
  id: string,
  name: string,
  type: Activity["type"],
  spec: ActivitySpec,
  scope: string | undefined,
  version: number,
): Activity {
  return {
    id,
    type,
    name,
    spec,
    status: {
      state: "active",
      outcomes: [],
      outcome: null,
      output: null,
      output_evidence: null,
      conditions: [],
      effect_log: [],
      observed_at_version: version,
    },
    provenance: {
      created_by_version: version,
      ...(scope === undefined ? {} : { group: scope }),
      supersedes: null,
      superseded_by: null,
    },
  };
}

function sameEdge(a: Edge, b: Edge): boolean {
  return a.from === b.from && a.to === b.to && a.condition?.on === b.condition?.on;
}

/**
 * Apply one op to a graph the caller already owns. Mutates `graph` in place; callers go
 * through `applyOps`, which hands it a clone.
 */
function applyOne(
  graph: Graph,
  op: CommittedOp,
  version: number,
  occurredAt: string,
  opIndex: number,
): Result<null> {
  const at = { op_index: opIndex };

  switch (op.op) {
    case "add_activity": {
      if (graph.activities.has(op.id)) {
        return refuse("DUPLICATE_ACTIVITY_ID", `activity '${op.id}' already exists`, {
          activity: op.id,
          ...at,
        });
      }
      graph.activities.set(
        op.id,
        makeNode(op.id, op.name, op.type, op.spec, op.scope, version),
      );
      return ok(null);
    }

    case "add_edge": {
      if (op.from === op.to) {
        return refuse("SELF_EDGE", `${namedIn(graph, op.from)} cannot require itself`, {
          activity: op.from,
          ...at,
        });
      }
      for (const endpoint of [op.from, op.to]) {
        if (!graph.activities.has(endpoint)) {
          return refuse("UNKNOWN_ACTIVITY", `edge endpoint '${endpoint}' does not exist`, {
            activity: endpoint,
            ...at,
          });
        }
      }
      const edge: Edge = {
        from: op.from,
        to: op.to,
        ...(op.condition === undefined ? {} : { condition: op.condition }),
      };
      if (graph.edges.some((existing) => sameEdge(existing, edge))) {
        return refuse(
          "DUPLICATE_EDGE",
          `an identical edge ${namedIn(graph, op.from)} -> ${namedIn(graph, op.to)} already exists`,
          { activity: op.to, ...at },
        );
      }
      graph.edges.push(edge);
      return ok(null);
    }

    case "set_status": {
      const activity = graph.activities.get(op.activity);
      if (activity === undefined) {
        return refuse("UNKNOWN_ACTIVITY", `activity '${op.activity}' does not exist`, {
          activity: op.activity,
          ...at,
        });
      }
      // §6.6 — the outbox rides on `evidence_ref`, because there is no seventh op. This
      // MATERIALISES what the log already says; it decides nothing, so re-folding an old
      // log cannot produce an effect ledger the operator never approved.
      const evidence = parseEffectEvidence(op.evidence_ref);
      if (evidence !== null && evidence.kind === "reserve") {
        activity.status.effect_log.push({
          effect_key: evidence.effect_key,
          payload_hash: evidence.payload_hash,
          attempted_at: occurredAt,
          completed_at: null,
          outcome: null,
          message_id: null,
        });
      } else if (evidence !== null) {
        const reserved = activity.status.effect_log.find(
          (entry) => entry.effect_key === evidence.effect_key && entry.completed_at === null,
        );
        if (reserved === undefined) {
          return refuse(
            "UNRESERVED_EFFECT",
            `no open reservation '${evidence.effect_key}' on '${op.activity}' to record against`,
            { activity: op.activity, ...at },
          );
        }
        reserved.completed_at = occurredAt;
        reserved.outcome = evidence.outcome;
        reserved.message_id = evidence.message_id;
      }
      activity.status.state = op.status;
      activity.status.observed_at_version = version;
      return ok(null);
    }

    case "record_outcome": {
      const activity = graph.activities.get(op.activity);
      if (activity === undefined) {
        return refuse("UNKNOWN_ACTIVITY", `activity '${op.activity}' does not exist`, {
          activity: op.activity,
          ...at,
        });
      }
      // Append, never overwrite (§6.7). A `late` reply must not be able to replace the
      // verdict the graph already acted on.
      const recorded: OutcomeRecord = {
        verdict: op.verdict,
        evidence_ref: op.evidence_ref,
        ...(op.attrs === undefined ? {} : { attrs: op.attrs }),
        at_version: version,
      };
      activity.status.outcomes.push(recorded);
      activity.status.outcome = resolvingOutcome(activity.status.outcomes);
      activity.status.observed_at_version = version;
      return ok(null);
    }

    case "record_output": {
      const activity = graph.activities.get(op.activity);
      if (activity === undefined) {
        return refuse("UNKNOWN_ACTIVITY", `activity '${op.activity}' does not exist`, {
          activity: op.activity,
          ...at,
        });
      }
      // §6.2: `outputs` is what makes `inputs[].ref` mean anything. An output nobody
      // declared can never be referenced, so writing one is an authoring error, not data.
      if (!activity.spec.outputs.some((declared) => declared.name === op.output_name)) {
        return refuse(
          "UNDECLARED_OUTPUT",
          `activity ${namedIn(graph, op.activity)} declares no output named '${op.output_name}'`,
          { activity: op.activity, ...at },
        );
      }
      activity.status.output = { ...activity.status.output, [op.output_name]: op.value };
      activity.status.output_evidence = {
        ...activity.status.output_evidence,
        [op.output_name]: op.evidence_ref,
      };
      activity.status.observed_at_version = version;
      return ok(null);
    }

    case "supersede_activity": {
      const activity = graph.activities.get(op.activity);
      if (activity === undefined) {
        return refuse("UNKNOWN_ACTIVITY", `activity '${op.activity}' does not exist`, {
          activity: op.activity,
          ...at,
        });
      }
      if (op.by !== undefined) {
        const replacement = graph.activities.get(op.by);
        if (replacement === undefined) {
          return refuse("UNKNOWN_ACTIVITY", `replacement activity '${op.by}' does not exist`, {
            activity: op.by,
            ...at,
          });
        }
        if (op.by === op.activity) {
          return refuse("SELF_SUPERSEDE", `'${op.activity}' cannot supersede itself`, {
            activity: op.activity,
            ...at,
          });
        }
        replacement.provenance.supersedes = op.activity;
      }
      activity.provenance.superseded_by = op.by ?? null;
      // Derivable housekeeping, so the store does it (§6.4). An activity that already ran
      // keeps its terminal status — superseding does not un-send an email — but one still
      // in flight stops being work: `dropped` is "we stopped wanting this".
      if (!isActivityTerminal(activity)) {
        activity.status.state = "dropped";
        activity.status.observed_at_version = version;
      }
      return ok(null);
    }
  }
}

/**
 * Apply a committed batch. Returns a new graph; `graph` is never touched, which is what
 * lets invariant 1 compare pre-commit head against the post-commit result.
 */
/**
 * Stand-in timestamp for a DRY RUN. `validate` applies a batch against a clone purely to
 * test the invariants, and that graph is discarded — `mutate` writes the record and the
 * next read folds it with the record's real `occurred_at`. Nothing stamped with this ever
 * reaches disk.
 */
const DRY_RUN_TIME = "";

export function applyOps(
  graph: Graph,
  ops: readonly CommittedOp[],
  version: number,
  occurredAt: string = DRY_RUN_TIME,
): Result<Graph> {
  const draft = cloneGraph(graph);
  for (const { op, index } of orderOps(ops)) {
    const outcome = applyOne(draft, op, version, occurredAt, index);
    if (!outcome.ok) return outcome;
  }
  draft.version = version;
  return ok(draft);
}
