/**
 * `kona brief <node>` — §6.9. The three things the graph cannot know, plus the one
 * computation the CLI must not get wrong.
 *
 * The brief exists because it was measured: 0 of 8 fresh subagents could execute a node
 * without it — no node declared an `output`, so every `inputs[].ref` dangled — and 10 of
 * 10 could once these blocks were required. It is not documentation; it is the interface.
 *
 * `preconditions_satisfied` **FAILS CLOSED**. An earlier version failed open, which is the
 * worst possible direction for a check standing in front of an irreversible send: a
 * missing input read as "no objection" rather than "unknown".
 */

import { type Graph, type Node, inEdges, isEdgeSatisfied, outEdges } from "./graph.ts";
import type { Identity, MutationRecord, PursuitConfig } from "./schema.ts";
import { hasSentEffect } from "./effect.ts";
import { type Correlation, deriveCorrelation } from "./correlation.ts";

/**
 * The event-waits hanging off a send — the nodes a reply to it could belong to.
 *
 * ## Why the token is the WAIT's id and not the sender's
 *
 * §6.5 gives the correlation token twice, and with the SAME literal both times: once on the
 * effect node (`spec.effect.correlation`) and once on the wait (`match.correlation`). One
 * conversation, one token. The question is only which node id it derives from, and the answer
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
 * normal way to retry — and the replacement is a NEW node with a new id. The wait behind it
 * usually survives. Deriving from the sender would silently reissue the address for a
 * conversation already in somebody's mail client.
 *
 * An earlier version of this file derived from `node.id`, which meant `kona brief` handed an
 * executor a `Reply-To` that `kona poll` could never match: every reply in a real run would
 * have arrived correlated to nothing. Unit tests on either half passed — each was
 * self-consistent — and only driving a whole pursuit through both showed it.
 */
function awaitingWaits(graph: Graph, node: Node): Node[] {
  return outEdges(graph, node.id).flatMap((edge) => {
    const target = graph.nodes.get(edge.to);
    if (target === undefined || target.type !== "wait") return [];
    if (target.provenance.superseded_by !== null) return [];
    // Only an EVENT wait takes mail. A predicate wait is judged from the graph and a human
    // wait from a person; neither has an inbox, and addressing a reply to one would be a
    // reply nothing reads.
    const match = target.spec.match;
    const kind = typeof match === "object" && match !== null ? (match as { kind?: unknown }).kind : null;
    return kind === "event" ? [target] : [];
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
  disclosable: ["instruction", "inputs", "correlation.reply_to", "correlation.subject_tag", "identity"],
  withheld: [
    "deadline",
    "on_timeout",
    "graph_structure",
    "rationale",
    "effect_key",
    "sibling_nodes",
    "budget",
  ],
};

export interface UpstreamNeighbour {
  id: string;
  label: string;
  state: string;
  condition?: string;
  /** What it produced, so the executor can use it without re-reading the graph. */
  output: unknown;
}

export interface DownstreamNeighbour {
  id: string;
  label: string;
  condition?: string;
}

export interface Brief {
  node: Node;
  /** The node's immediate neighbourhood, so an executor can see what it depends on. */
  subgraph: {
    upstream: UpstreamNeighbour[];
    downstream: DownstreamNeighbour[];
  };
  identity: Identity;
  correlation: Correlation | null;
  effect_key: string | null;
  preconditions_satisfied: Preconditions;
  disclosure: Disclosable;
}

export type BriefResult = { ok: true; brief: Brief } | { ok: false; reason: string; message: string };

/** Resolve `inputs[].ref` of the form `<node-id>.<output-name>` against recorded outputs. */
function checkInputs(graph: Graph, node: Node): PreconditionCheck {
  const unresolved: string[] = [];
  for (const input of node.spec.inputs) {
    const dot = input.ref.indexOf(".");
    if (dot <= 0) {
      unresolved.push(`${input.ref} (not <node>.<output>)`);
      continue;
    }
    const sourceId = input.ref.slice(0, dot);
    const outputName = input.ref.slice(dot + 1);
    const source = graph.nodes.get(sourceId);
    if (source === undefined) {
      unresolved.push(`${input.ref} (no node '${sourceId}')`);
      continue;
    }
    if (!source.spec.outputs.some((declared) => declared.name === outputName)) {
      unresolved.push(`${input.ref} ('${sourceId}' declares no '${outputName}')`);
      continue;
    }
    if (source.status.output === null || !(outputName in source.status.output)) {
      unresolved.push(`${input.ref} (not produced yet)`);
    }
  }
  return {
    name: "inputs_resolved",
    ok: unresolved.length === 0,
    detail: unresolved.length === 0 ? "every input resolves to a recorded output" : unresolved.join("; "),
  };
}

function checkDependencies(graph: Graph, node: Node): PreconditionCheck {
  const blocking = inEdges(graph, node.id).filter((edge) => !isEdgeSatisfied(graph, edge));
  return {
    name: "dependencies_satisfied",
    ok: blocking.length === 0,
    detail:
      blocking.length === 0
        ? "every blocking in-edge has a terminal-success source"
        : blocking.map((edge) => `waiting on '${edge.from}'`).join("; "),
  };
}

function checkBudget(graph: Graph, node: Node, budget: number | undefined): PreconditionCheck {
  if (node.spec.effect === undefined) {
    return { name: "budget_remaining", ok: true, detail: "node sends nothing" };
  }
  if (budget === undefined) {
    // FAIL CLOSED. An unconfigured cap is an UNKNOWN cap, and the whole point of
    // invariant 3(a) is that a mutator cannot spend what nobody approved.
    return {
      name: "budget_remaining",
      ok: false,
      detail: "no effect budget configured for this pursuit; an unknown cap is not an unlimited one",
    };
  }
  const spent = [...graph.nodes.values()].filter(hasSentEffect).length;
  return {
    name: "budget_remaining",
    ok: spent < budget,
    detail: `${spent} of ${budget} irreversible sends used`,
  };
}

export function buildBrief(
  graph: Graph,
  nodeId: string,
  config: PursuitConfig,
): BriefResult {
  const node = graph.nodes.get(nodeId);
  if (node === undefined) {
    return { ok: false, reason: "UNKNOWN_NODE", message: `node '${nodeId}' does not exist` };
  }

  // §6.9: brief returns these three things "or it refuses". An executor handed a brief
  // with no identity will sign as nobody and commit to anything.
  const { identity } = config;
  if (identity === undefined) {
    return {
      ok: false,
      reason: "NO_IDENTITY",
      message:
        "this pursuit has no identity configured; an executor cannot speak for someone the graph cannot name",
    };
  }

  let correlation: Correlation | null = null;
  let correlationDetail = "node sends nothing, so it needs no reply address";
  let correlationOk = true;
  if (node.spec.effect !== undefined) {
    const awaiting = awaitingWaits(graph, node);
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
      const target = awaiting[0] as Node;
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
      ok: node.status.state === "active" && node.provenance.superseded_by === null,
      detail: `state '${node.status.state}'${node.provenance.superseded_by === null ? "" : ", superseded"}`,
    },
    checkDependencies(graph, node),
    checkInputs(graph, node),
    {
      name: "effect_slot_unfired",
      ok: !hasSentEffect(node),
      detail: hasSentEffect(node) ? "this node has already moved bytes" : "no send recorded",
    },
    { name: "correlation_expanded", ok: correlationOk, detail: correlationDetail },
    checkBudget(graph, node, config.effect_budget),
  ];

  return {
    ok: true,
    brief: {
      node,
      subgraph: {
        upstream: inEdges(graph, node.id).map((edge) => {
          const source = graph.nodes.get(edge.from);
          const neighbour: UpstreamNeighbour = {
            id: edge.from,
            label: source?.label ?? "(missing)",
            state: source?.status.state ?? "unknown",
            output: source?.status.output ?? null,
          };
          if (edge.condition !== undefined) neighbour.condition = edge.condition.on;
          return neighbour;
        }),
        downstream: outEdges(graph, node.id).map((edge) => {
          const neighbour: DownstreamNeighbour = {
            id: edge.to,
            label: graph.nodes.get(edge.to)?.label ?? "(missing)",
          };
          if (edge.condition !== undefined) neighbour.condition = edge.condition.on;
          return neighbour;
        }),
      },
      identity,
      correlation,
      effect_key: null,
      preconditions_satisfied: { ok: checks.every((check) => check.ok), checks },
      disclosure: DISCLOSURE,
    },
  };
}
