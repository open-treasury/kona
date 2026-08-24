/**
 * `kona effect reserve|record` — §6.6's outbox, and **the only verbs that touch the world**.
 *
 *   1. reserve  -> append intent, status `sending`, FSYNC
 *   2. executor sends
 *   3. record   -> append the outcome
 *
 * You cannot make a local write and an external effect atomic. The outbox is the admission
 * of that, and the ordering is the whole durability story: append, fsync, *then* take the
 * side effect. Never the reverse.
 *
 * A caveat the spec's table understates: crash windows 2 and 3 — between fsync and send,
 * and between send and record — leave EXACTLY the same bytes on disk, a `sending` activity
 * with `completed_at: null`. Nothing in the log can tell them apart, which is why the
 * honest handling is to surface both for a human (or for reconciliation against the
 * mailbox, which §6.5 makes the source of truth) rather than to retry one of them.
 */

import {
  type Graph,
  type Activity,
  effectByKey,
  effectsCommitted,
  pursuitConfig,
  encodeRecordEvidence,
  encodeReserveEvidence,
  hasSentEffect,
  openEffect,
} from "@kona/core";
import type { EffectOutcome } from "@kona/core";
import { type BuildResult, commitBatch } from "../commit.ts";
import { effectKey } from "../hash.ts";
import { EXIT_OK, EXIT_REFUSED } from "../exit.ts";
import type { Io } from "../io.ts";
import type { Rationale } from "../commit.ts";

export interface ReserveOptions {
  activity: string;
  payloadHash: string;
  rationale: Rationale;
  actorId: string;
  json: boolean;
}

export interface RecordOptions {
  activity: string;
  key: string;
  outcome: EffectOutcome;
  messageId: string;
  rationale: Rationale;
  actorId: string;
  json: boolean;
}

function lookup(graph: Graph, id: string, io: Io): Activity | null {
  const activity = graph.activities.get(id);
  if (activity === undefined) {
    io.err(`REFUSED UNKNOWN_ACTIVITY activity '${id}' does not exist`);
    return null;
  }
  return activity;
}

export async function runReserve(io: Io, options: ReserveOptions): Promise<number> {
  let reservedKey = "";
  let idempotent = false;

  const outcome = await commitBatch(io, (graph, records): BuildResult => {
    const activity = lookup(graph, options.activity, io);
    if (activity === null) return { refused: EXIT_REFUSED };

    if (activity.spec.effect === undefined) {
      io.err(
        `REFUSED NOT_AN_EFFECT_ACTIVITY '${activity.id}' is effect_class '${activity.spec.effect_class}' and reserves nothing`,
      );
      return { refused: EXIT_REFUSED };
    }

    // §6.6 — "An activity with a non-empty effect_log is never re-executed. The CLI refuses."
    if (hasSentEffect(activity)) {
      io.err(`REFUSED EFFECT_ALREADY_SENT '${activity.id}' has already moved bytes; it is never re-executed`);
      return { refused: EXIT_REFUSED };
    }

    // Payload-INDEPENDENT: the key names the slot, the hash proves the bytes.
    const key = effectKey(activity.id, activity.provenance.created_by_version);
    reservedKey = key;

    // Only an OPEN reservation can be re-reserved. A closed one — even a failed send —
    // is a slot that already had its answer, and treating it as idempotent would let a
    // terminal activity look dispatchable again.
    const existing = effectByKey(activity, key);
    if (existing !== null && existing.completed_at === null) {
      if (existing.payload_hash !== options.payloadHash) {
        // The check that a body-derived key would have made unreachable. Loud, never a
        // silent no-op, and never a second send.
        io.err(
          `REFUSED EFFECT_PAYLOAD_MISMATCH '${activity.id}' reserved ${key} for payload ${existing.payload_hash}, ` +
            `now offered ${options.payloadHash}. The approved bytes are not these bytes.`,
        );
        return { refused: EXIT_REFUSED };
      }
      // Same slot, same bytes, still open: crash window 2. Re-reserving is a no-op, which
      // is what makes the retry safe rather than a second email.
      idempotent = true;
      return { refused: EXIT_OK };
    }

    // INVARIANT 3(a), enforced at the moment of spending (§6.7).
    //
    // There is no per-activity retry budget, and deliberately so: one activity has exactly one
    // slot, because the key is a function of (activity, created_by_version). Retrying means
    // superseding and replacing — a NEW activity with a NEW key — which is a graph mutation
    // the model has to justify. So this pursuit-wide cap is the ONLY thing bounding a
    // runaway loop, and `brief` merely advising on it was not enough: advice that the
    // enforcement point ignores is not a circuit breaker.
    const { effect_budget: budget } = pursuitConfig(records);
    const committed = effectsCommitted(graph);
    if (budget === undefined) {
      // FAIL CLOSED, exactly as `brief` does. An unconfigured cap is an UNKNOWN cap, and
      // the whole point is that a mutator cannot spend what nobody approved.
      io.err(
        `REFUSED NO_EFFECT_BUDGET this pursuit has no effect budget, so there is nothing to ` +
          `spend against. Set one with 'kona init --config'; an unknown cap is not an unlimited one.`,
      );
      return { refused: EXIT_REFUSED };
    }
    if (committed >= budget) {
      io.err(
        `REFUSED EFFECT_BUDGET_EXHAUSTED this pursuit has committed ${committed} of ${budget} ` +
          `irreversible effects. Escalate to a human — do not raise the budget to get past this.`,
      );
      return { refused: EXIT_REFUSED };
    }

    if (activity.status.state !== "active") {
      io.err(`REFUSED NOT_DISPATCHABLE '${activity.id}' is '${activity.status.state}', not active`);
      return { refused: EXIT_REFUSED };
    }

    return {
      commit: {
        ops: [
          {
            op: "set_status",
            activity: activity.id,
            status: "in_flight",
            evidence_ref: encodeReserveEvidence(key, options.payloadHash),
          },
        ],
        rationale: options.rationale,
        actor: { kind: "subagent", id: options.actorId },
      },
    };
  });

  if (!outcome.ok) {
    if (!idempotent) return outcome.code;
    io.out(
      options.json
        ? JSON.stringify({ ok: true, effect_key: reservedKey, reserved: false, idempotent: true })
        : `already reserved ${reservedKey} for this payload — send it, do not re-reserve`,
    );
    return EXIT_OK;
  }

  io.out(
    options.json
      ? JSON.stringify({
          ok: true,
          effect_key: reservedKey,
          reserved: true,
          idempotent: false,
          version: outcome.value.version,
        })
      : `reserved ${reservedKey} at v${outcome.value.version} — fsynced, safe to send`,
  );
  return EXIT_OK;
}

export async function runRecord(io: Io, options: RecordOptions): Promise<number> {
  const outcome = await commitBatch(io, (graph): BuildResult => {
    const activity = lookup(graph, options.activity, io);
    if (activity === null) return { refused: EXIT_REFUSED };

    const open = openEffect(activity);
    if (open === null) {
      io.err(
        `REFUSED NO_OPEN_EFFECT '${activity.id}' has no reservation awaiting an outcome; reserve before you send`,
      );
      return { refused: EXIT_REFUSED };
    }
    if (open.effect_key !== options.key) {
      io.err(
        `REFUSED EFFECT_KEY_MISMATCH '${activity.id}' has ${open.effect_key} open, not ${options.key}`,
      );
      return { refused: EXIT_REFUSED };
    }

    return {
      commit: {
        ops: [
          {
            op: "set_status",
            activity: activity.id,
            status: options.outcome === "sent" ? "done" : "failed",
            evidence_ref: encodeRecordEvidence(open.effect_key, options.outcome, options.messageId),
          },
        ],
        rationale: options.rationale,
        actor: { kind: "subagent", id: options.actorId },
      },
    };
  });

  if (!outcome.ok) return outcome.code;

  io.out(
    options.json
      ? JSON.stringify({
          ok: true,
          effect_key: options.key,
          outcome: options.outcome,
          message_id: options.messageId,
          version: outcome.value.version,
        })
      : `recorded ${options.key} as ${options.outcome} at v${outcome.value.version}`,
  );
  return EXIT_OK;
}
