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
    const derived = deriveCorrelation(identity.mailbox, node.id);
    if (derived.ok) {
      correlation = derived.correlation;
      correlationDetail = `replies correlate to ${derived.correlation.reply_to}`;
    } else {
      correlationOk = false;
      correlationDetail = derived.reason;
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
