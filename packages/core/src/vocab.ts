/**
 * The closed vocabularies. Every one of these is a spec-level decision (§6.2, §6.3, §6.4);
 * widening one is a spec change, not a code change.
 *
 * Each vocabulary is a `const` tuple so that the TypeScript union and the zod enum are
 * derived from the same single source. There is no second list to forget to update.
 */

/** §6.2 — two node types. `quorum` was folded into `wait{match:predicate}` in pass three. */
export const NODE_TYPES = ["task", "wait"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** §6.2 — five statuses. */
export const STATUSES = ["active", "sending", "done", "failed", "dropped"] as const;
export type Status = (typeof STATUSES)[number];

/**
 * §6.2 — `sending` is deliberately NOT terminal: it means the real world's answer is
 * unknown, not that the node resolved.
 */
export const TERMINAL_STATUSES = ["done", "failed", "dropped"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/** The only status that satisfies a downstream blocking edge. §6.4 readiness fails safe. */
export const TERMINAL_SUCCESS_STATUS = "done" as const;

export function isTerminal(status: Status): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * §6.4 / §6.5 — what a counterparty decided.
 * `late` is the §6.5 verdict for a reply that arrives after its wait already resolved:
 * it is recorded and never reopens the wait.
 */
export const VERDICTS = [
  "confirmed",
  "declined",
  "tentative",
  "timed_out",
  "bounced",
  "late",
] as const;
export type Verdict = (typeof VERDICTS)[number];

/** §6.2 — the resolutions an edge condition can fire on. */
export const EDGE_CONDITIONS = [
  "accept",
  "edit",
  "respond",
  "ignore",
  "timeout",
  "bounced",
  "satisfied",
] as const;
export type EdgeCondition = (typeof EDGE_CONDITIONS)[number];

/** §6.2 — how reversible this node's effect on the world is. */
export const EFFECT_CLASSES = ["pure", "reversible", "compensatable", "pivot"] as const;
export type EffectClass = (typeof EFFECT_CLASSES)[number];

/** §6.6 — a node in one of these classes moves bytes we cannot take back. */
export const IRREVERSIBLE_EFFECT_CLASSES = ["compensatable", "pivot"] as const;

export function isIrreversible(effectClass: EffectClass): boolean {
  return (IRREVERSIBLE_EFFECT_CLASSES as readonly string[]).includes(effectClass);
}

/** §6.2 — required when a node has more than one blocking in-edge. */
export const MERGE_MODES = ["all", "any"] as const;
export type MergeMode = (typeof MERGE_MODES)[number];

/** §6.2 — the three things a `wait` can block on. */
export const MATCH_KINDS = ["event", "human", "predicate"] as const;
export type MatchKind = (typeof MATCH_KINDS)[number];

/** §6.3 — machine-readable why. Free text lives in `why`; this is the queryable part. */
export const REASON_CODES = [
  "COUNTERPARTY_DECLINED",
  "DEADLINE_PASSED",
  "NEW_CONSTRAINT",
  "MISSING_STEP",
  "QUORUM_MET",
  "CONTRADICTION",
  "WITHDRAWN",
  "OTHER",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** §6.7 — role-scoped write authority. Only `orchestrator` may mutate topology. */
export const ACTOR_KINDS = ["orchestrator", "subagent", "human"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** §6.3 — what relation the triggering event bears to the mutation. */
export const TRIGGER_RELATIONS = [
  "Trigger",
  "Invalidate",
  "Derive",
  "Approve",
  "Timeout",
] as const;
export type TriggerRelation = (typeof TRIGGER_RELATIONS)[number];

/** §6.4 — the six ops. There is no seventh, and no opcode is reserved for one. */
export const OP_KINDS = [
  "add_node",
  "add_edge",
  "set_status",
  "record_outcome",
  "record_output",
  "supersede_node",
] as const;
export type OpKind = (typeof OP_KINDS)[number];

/**
 * §6.4 — forbidden verbs, listed so the Definition-of-Done check ("no `delete_node`
 * verb and no `rollback` opcode anywhere in code or schema") has something to assert
 * against rather than grepping prose.
 */
export const FORBIDDEN_OP_KINDS = [
  "delete_node",
  "rollback",
  "replace_graph",
  "edit_rationale",
  "reparent",
] as const;

/** §6.4 — ops that are legal against a terminal node. Everything else is invariant 1. */
export const TERMINAL_SAFE_OP_KINDS = [
  "supersede_node",
  "record_outcome",
  "record_output",
] as const;
