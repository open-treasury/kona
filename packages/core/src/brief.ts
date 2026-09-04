/**
 * `kona brief <activity>` — §6.9. The three things the graph cannot know, plus the one
 * computation the CLI must not get wrong.
 *
 * The brief exists because it was measured: 0 of 8 fresh subagents could execute an activity
 * without it — no activity declared an `output`, so every `inputs[].ref` dangled — and 10 of
 * 10 could once these blocks were required. It is not documentation; it is the interface.
 *
 * `preconditions_satisfied` **FAILS CLOSED**. An earlier version failed open, which is the
 * worst possible direction for a check standing in front of an irreversible send: a
 * missing input read as "no objection" rather than "unknown".
 */

import { named } from "./named.ts";
import {
  type ActionNode,
  type ActivityNode,
  type Edge,
  type Graph,
  inEdges,
  isEdgeSatisfied,
  isNodeLive,
  outEdges,
} from "./graph.ts";
import { isUnclaimed } from "./vocab.ts";
import type { Identity, MutationRecord, PursuitConfig } from "./schema.ts";
import { hasSentEffect } from "./effect.ts";
import { type Correlation, deriveCorrelation } from "./correlation.ts";

/**
 * The event-waits hanging off a send — the activities a reply to it could belong to.
 *
 * ## Why the token is the WAIT's id and not the sender's
 *
 * §6.5 gives the correlation token twice, and with the SAME literal both times: once on the
 * effect activity (`spec.effect.correlation`) and once on the wait (`match.correlation`). One
 * conversation, one token. The question is only which activity id it derives from, and the answer
 * has to be the wait's, for two reasons.
 *
 * The routing reason: an inbound reply has to become a `record_outcome`, and `record_outcome`
 * targets the WAIT. `waitAddresses` and `matchInbound` are built on that — they map an
 * address to the wait it resolves. A token naming the sender would have to be translated by
 * traversing an edge at match time, and a message that arrives after the graph moved has no
 * guarantee that edge still reads the same.
 *
 * The staleness reason, which is the spec's own: "a token that changes across executions goes
 * stale in someone's inbox". A send can be superseded and replaced — §6.7 makes that the
 * normal way to retry — and the replacement is a NEW activity with a new id. The wait behind it
 * usually survives. Deriving from the sender would silently reissue the address for a
 * conversation already in somebody's mail client.
 *
 * An earlier version of this file derived from `activity.id`, which meant `kona brief` handed an
 * executor a `Reply-To` that `kona poll` could never match: every reply in a real run would
 * have arrived correlated to nothing. Unit tests on either half passed — each was
 * self-consistent — and only driving a whole pursuit through both showed it.
 */
function awaitingWaits(graph: Graph, activity: ActivityNode): ActivityNode[] {
  return forwardToWaits(graph, activity.id, new Set());
}

/**
 * Walk forward to the first node that carries a status on each path, THROUGH control nodes.
 *
 * The one-hop version this replaces was correct while a send could only ever be wired
 * straight to its wait. It is not any more: under S7 a `fork` or a `decision` may sit between
 * them, and a one-hop lookup would find a diamond, return nothing, and hand the executor a
 * brief with no reply address — for a send whose whole purpose is to get a reply. Silent, and
 * it would present as "the counterparty never answered".
 *
 * Stopping at the first status-carrying node on each path is what keeps `kona brief`'s
 * fail-closed-on-more-than-one rule meaningful: the walk widens at a fork exactly as the flow
 * does, so two waits behind one send are still two, and still refused.
 */
function forwardToWaits(graph: Graph, from: string, seen: Set<string>): ActivityNode[] {
  if (seen.has(from)) return [];
  seen.add(from);

  return outEdges(graph, from).flatMap((edge) => {
    const target = graph.nodes.get(edge.to);
    if (target === undefined) return [];
    if (!isNodeLive(target)) return [];
    if (target.status === undefined) return forwardToWaits(graph, target.id, seen);
    if (target.type !== "accept_event") return [];
    // Only an EVENT wait takes mail. A predicate wait is judged from the graph and a human
    // wait from a person; neither has an inbox, and addressing a reply to one would be a
    // reply nothing reads.
    return target.spec.match?.kind === "event" ? [target] : [];
  });
}

/** The config lives on the genesis record; this reads it back out of a folded log. */
export function pursuitConfig(records: readonly MutationRecord[]): PursuitConfig {
  return records[0]?.config ?? {};
}

export interface PreconditionCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Preconditions {
  ok: boolean;
  checks: PreconditionCheck[];
}

/**
 * §6.9 — a per-field marking of what may appear in outbound content.
 *
 * Without it an agent reads a wait's internal timeout and turns it into a promise: "I'll
 * need to hear back by Thursday" is a commitment the graph never made and the counterparty
 * will hold you to.
 */
export interface Disclosable {
  disclosable: string[];
  withheld: string[];
}

export const DISCLOSURE: Disclosable = {
  disclosable: [
    "instruction",
    "inputs",
    "correlation.reply_to",
    "correlation.subject_tag",
    "identity",
  ],
  withheld: ["deadline", "graph_structure", "rationale", "effect_key", "sibling_nodes", "budget"],
};

export interface UpstreamNeighbour {
  id: string;
  name: string;
  state: string;
  guard?: Edge["guard"];
  /** What it produced, so the executor can use it without re-reading the graph. */
  output: unknown;
}

export interface DownstreamNeighbour {
  id: string;
  name: string;
  guard?: Edge["guard"];
}

export interface Brief {
  activity: ActionNode;
  /** The activity's immediate neighbourhood, so an executor can see what it depends on. */
  subgraph: {
    upstream: UpstreamNeighbour[];
    downstream: DownstreamNeighbour[];
  };
  /** Null on a pure activity: there is nobody to speak for, so none is required. */
  identity: Identity | null;
  correlation: Correlation | null;
  effect_key: string | null;
  preconditions_satisfied: Preconditions;
  disclosure: Disclosable;
}

export type BriefResult =
  | { ok: true; brief: Brief }
  | { ok: false; reason: string; message: string };

/** Resolve `inputs[].ref` of the form `<activity-id>.<output-name>` against recorded outputs. */
function checkInputs(graph: Graph, activity: ActivityNode): PreconditionCheck {
  const unresolved: string[] = [];
  for (const input of activity.spec.inputs) {
    const dot = input.ref.indexOf(".");
    if (dot <= 0) {
      unresolved.push(`${input.ref} (not <activity>.<output>)`);
      continue;
    }
    const sourceId = input.ref.slice(0, dot);
    const outputName = input.ref.slice(dot + 1);
    const source = graph.nodes.get(sourceId);
    if (source === undefined) {
      unresolved.push(`${input.ref} (no activity '${sourceId}')`);
      continue;
    }
    if (source.status === undefined) {
      unresolved.push(`${input.ref} ('${sourceId}' is a control node and declares no outputs)`);
      continue;
    }
    if (!source.spec.outputs.some((declared) => declared.name === outputName)) {
      unresolved.push(`${input.ref} ('${sourceId}' declares no '${outputName}')`);
      continue;
    }
    // A control node produces nothing, so an input ref pointing at one can never resolve.
    // Reported as unproduced rather than crashed: the author wrote a ref, and the brief's job
    // is to tell them which refs are not ready yet.
    if (source.status?.output == null || !(outputName in source.status.output)) {
      unresolved.push(`${input.ref} (not produced yet)`);
    }
  }
  return {
    name: "inputs_resolved",
    ok: unresolved.length === 0,
    detail:
      unresolved.length === 0 ? "every input resolves to a recorded output" : unresolved.join("; "),
  };
}

function checkDependencies(graph: Graph, activity: ActivityNode): PreconditionCheck {
  const blocking = inEdges(graph, activity.id).filter((edge) => !isEdgeSatisfied(graph, edge));
  return {
    name: "dependencies_satisfied",
    ok: blocking.length === 0,
    detail:
      blocking.length === 0
        ? "every blocking in-edge has a terminal-success source"
        : blocking.map((edge) => `waiting on '${edge.from}'`).join("; "),
  };
}

function checkBudget(
  graph: Graph,
  activity: ActivityNode,
  budget: number | undefined,
): PreconditionCheck {
  if (activity.spec.effect === undefined) {
    return { name: "budget_remaining", ok: true, detail: "activity sends nothing" };
  }
  if (budget === undefined) {
    // FAIL CLOSED. An unconfigured cap is an UNKNOWN cap, and the whole point of
    // invariant 3(a) is that a mutator cannot spend what nobody approved.
    return {
      name: "budget_remaining",
      ok: false,
      detail:
        "no effect budget configured for this pursuit; an unknown cap is not an unlimited one",
    };
  }
  const spent = [...graph.nodes.values()].filter(hasSentEffect).length;
  return {
    name: "budget_remaining",
    ok: spent < budget,
    detail: `${spent} of ${budget} irreversible sends used`,
  };
}

export function buildBrief(graph: Graph, nodeId: string, config: PursuitConfig): BriefResult {
  const activity = graph.nodes.get(nodeId);
  if (activity === undefined) {
    return {
      ok: false,
      reason: "UNKNOWN_ACTIVITY",
      message: `activity '${nodeId}' does not exist`,
    };
  }
  if (activity.type !== "action") {
    return {
      ok: false,
      reason: "NOT_BRIEFABLE",
      message: `${named(activity)} is a ${activity.type}; only action nodes can be briefed`,
    };
  }

  const { identity } = config;

  let correlation: Correlation | null = null;
  let correlationDetail = "activity sends nothing, so it needs no reply address";
  let correlationOk = true;
  if (activity.spec.effect !== undefined) {
    // §6.9: brief returns these three things "or it refuses". An executor handed a brief with
    // no identity will sign as nobody and commit to anything.
    //
    // Asked HERE, and not at the top, because only an activity that SENDS has anybody to sign to.
    // A pure activity has no counterparty, no reply address and nothing to commit on anyone's
    // behalf — the correlation check below already says exactly that in words. Refusing it
    // for a missing identity made effect-free pursuits unusable without inventing a mailbox
    // nobody reads, and §6.2 makes `effect_class: "pure"` first-class rather than degenerate.
    if (identity === undefined) {
      return {
        ok: false,
        reason: "NO_IDENTITY",
        message:
          `${named(activity)} sends to '${activity.spec.effect.recipient_ref}', and this pursuit has no ` +
          "identity configured; an executor cannot speak for someone the graph cannot name",
      };
    }

    const awaiting = awaitingWaits(graph, activity);
    if (awaiting.length === 0) {
      correlationDetail = "nothing waits on this send, so a reply has nowhere to route";
    } else if (awaiting.length > 1) {
      // Fail closed. An executor picking one would be guessing which wait a reply belongs
      // to, and §6.5's first-match-wins means the wrong guess advances the wrong arm — under
      // no-rollback, unrecoverably.
      correlationOk = false;
      correlationDetail =
        `${String(awaiting.length)} waits hang off this send (${awaiting.map((wait) => wait.id).join(", ")}); ` +
        "a reply address can name only one, and guessing which would route an answer to the wrong arm";
    } else {
      const target = awaiting[0] as ActivityNode;
      const derived = deriveCorrelation(identity.mailbox, target.id);
      if (derived.ok) {
        correlation = derived.correlation;
        correlationDetail = `replies correlate to ${derived.correlation.reply_to} — ${target.id}`;
      } else {
        correlationOk = false;
        correlationDetail = derived.reason;
      }
    }
  }

  const checks: PreconditionCheck[] = [
    {
      name: "node_live",
      // A control node is never briefed at all (D2). This check fails CLOSED on purpose — an earlier version failed open, in front
      // of an irreversible send.
      ok:
        activity.status !== undefined && isUnclaimed(activity.status.state) && isNodeLive(activity),
      detail: `state '${activity.status?.state ?? "n/a — a control node"}'${isNodeLive(activity) ? "" : ", superseded"}`,
    },
    checkDependencies(graph, activity),
    checkInputs(graph, activity),
    {
      name: "effect_slot_unfired",
      ok: !hasSentEffect(activity),
      detail: hasSentEffect(activity)
        ? "this activity has already moved bytes"
        : "no send recorded",
    },
    { name: "correlation_expanded", ok: correlationOk, detail: correlationDetail },
    checkBudget(graph, activity, config.effect_budget),
  ];

  return {
    ok: true,
    brief: {
      activity,
      subgraph: {
        upstream: inEdges(graph, activity.id).map((edge) => {
          const source = graph.nodes.get(edge.from);
          const neighbour: UpstreamNeighbour = {
            id: edge.from,
            name: source?.name ?? "(missing)",
            state: source?.status?.state ?? "unknown",
            output: source?.status?.output ?? null,
          };
          if (edge.guard !== undefined) neighbour.guard = edge.guard;
          return neighbour;
        }),
        downstream: outEdges(graph, activity.id).map((edge) => {
          const neighbour: DownstreamNeighbour = {
            id: edge.to,
            name: graph.nodes.get(edge.to)?.name ?? "(missing)",
          };
          if (edge.guard !== undefined) neighbour.guard = edge.guard;
          return neighbour;
        }),
      },
      identity: identity ?? null,
      correlation,
      effect_key: null,
      preconditions_satisfied: { ok: checks.every((check) => check.ok), checks },
      disclosure: DISCLOSURE,
    },
  };
}
