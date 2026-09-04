/**
 * The closed vocabularies. Every one of these is a spec-level decision (§6.2, §6.3, §6.4);
 * widening one is a spec change, not a code change.
 *
 * Each vocabulary is a `const` tuple so that the TypeScript union and the zod enum are
 * derived from the same single source. There is no second list to forget to update.
 */

/**
 * §6.2 — the nine node types, in two families.
 *
 * The families are the load-bearing distinction, not the count. A **behaviour** node is worked
 * by an agent and carries a `status`; a **control** node is derived by the store at commit and
 * carries none. Every consumer that asks "does this have a status" must branch on the family,
 * never on a list of seven names it then has to keep in sync — that second list is the one
 * that drifts.
 */
export const BEHAVIOUR_NODE_TYPES = ["action", "accept_event"] as const;
export type BehaviourNodeType = (typeof BEHAVIOUR_NODE_TYPES)[number];

/** §6.2 — resolved by the store at commit (D1), never worked, never claimed, never in `next`. */
export const CONTROL_NODE_TYPES = [
  "initial",
  "decision",
  "merge",
  "fork",
  "join",
  "final",
  "flow_final",
] as const;
export type ControlNodeType = (typeof CONTROL_NODE_TYPES)[number];

export const NODE_TYPES = [...BEHAVIOUR_NODE_TYPES, ...CONTROL_NODE_TYPES] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export function isControlNode(type: string): type is ControlNodeType {
  return (CONTROL_NODE_TYPES as readonly string[]).includes(type);
}

export function isBehaviourNode(type: string): type is BehaviourNodeType {
  return (BEHAVIOUR_NODE_TYPES as readonly string[]).includes(type);
}

/**
 * §6.2 — how many edges each type may carry, as `[min, max]` with `null` for unbounded.
 *
 * This table IS the structural half of the spec: S7 ("an action has exactly one in-edge") is
 * not a separate rule, it is the `action` row. Writing the rules as data rather than as a
 * switch is what lets the refusal name the type, the bound and the count in one message
 * without nine hand-written sentences drifting apart from the nine cases.
 */
export const NODE_ARITY: Readonly<
  Record<NodeType, { in: readonly [number, number | null]; out: readonly [number, number | null] }>
> = {
  initial: { in: [0, 0], out: [1, 1] },
  action: { in: [1, 1], out: [1, 1] },
  accept_event: { in: [1, 1], out: [1, 1] },
  decision: { in: [1, 1], out: [2, null] },
  merge: { in: [2, null], out: [1, 1] },
  fork: { in: [1, 1], out: [2, null] },
  join: { in: [2, null], out: [1, 1] },
  final: { in: [1, null], out: [0, 0] },
  flow_final: { in: [1, null], out: [0, 0] },
};

/**
 * §6.2.1 — the lifecycle. BPMN 2.0's Activity Lifecycle minus the compensation states, and it
 * applies to behaviour nodes only; a control node has no status at all.
 *
 * | state | written by | means |
 * |---|---|---|
 * | `inactive`   | creation                       | dependencies not yet satisfied |
 * | `ready`      | DERIVED at commit              | satisfied and unclaimed — the frontier |
 * | `active`     | `set_status` — a claim         | somebody is working it |
 * | `completed`  | `set_status`                   | terminal success, and the only state that satisfies an edge |
 * | `failed`     | `set_status`                   | tried, didn't work |
 * | `withdrawn`  | DERIVED at commit              | never claimed; the flow went elsewhere |
 * | `terminated` | `set_status`, or supersede     | WAS claimed; stopped before it finished |
 *
 * Two of the seven are the store's to write and are refused from an author: `ready` and
 * `withdrawn` are statements the graph makes, not ones an agent may assert.
 *
 * On the names: this is the second rename of this vocabulary. `sending` became `in_flight` at
 * schema v2 because the name described only one of the two facts it covered; the whole set now
 * moves to BPMN's because three separate conflations had accumulated. `active` meant both
 * *not reached yet* and *available now*, and only the second is a frontier. BPMN's `Active`
 * means *being worked*, which was `in_flight` — so anyone with BPMN in their background read
 * the old name backwards. And `dropped` was a union of BPMN's `Withdrawn` and `Terminated`,
 * which are different enough that one word had to describe half the cases wrongly.
 */
export const STATUSES = [
  "inactive",
  "ready",
  "active",
  "completed",
  "failed",
  "withdrawn",
  "terminated",
] as const;
export type Status = (typeof STATUSES)[number];

/**
 * `active` is deliberately NOT terminal: a claim with an open effect means the real world's
 * answer is unknown, not that the node resolved.
 */
export const TERMINAL_STATUSES = ["completed", "failed", "withdrawn", "terminated"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/** The only status that satisfies a downstream blocking edge. §6.4 readiness fails safe. */
export const TERMINAL_SUCCESS_STATUS = "completed" as const;

/** The states an author may write. `ready` and `withdrawn` are derived by the store. */
export const DERIVED_STATUSES = ["ready", "withdrawn"] as const;

export function isDerivedStatus(status: string): boolean {
  return (DERIVED_STATUSES as readonly string[]).includes(status);
}

/** The state a node is born in, before any derivation has looked at it. */
export const INITIAL_STATUS = "inactive" as const;

/** Unclaimed and unfinished — the two states the readiness derivation moves between. */
export function isUnclaimed(status: Status): boolean {
  return status === "inactive" || status === "ready";
}

/**
 * Over without having succeeded, and not because it was tried and failed.
 *
 * The two are one question wherever the graph asks "can this edge ever satisfy" — §6.4's
 * "an in-edge whose source is abandoned is excluded from merge evaluation" is about
 * abandonment, and it does not care which kind. They are two states rather than one because
 * a READER cares enormously: "an arm the graph resolved away" and "somebody was working this
 * and we pulled the plug" are different things to be told.
 */
export function isAbandoned(status: Status): boolean {
  return status === "withdrawn" || status === "terminated";
}

export function isTerminal(status: Status): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * §6.4 / §6.5 / §6.2 — what was decided. One vocabulary, two families.
 *
 * §6.4 lists the five a counterparty's reply can carry, §6.5 adds `late`, and §6.2 says of
 * a `wait{kind:"human"}` that "the four kinds are `outcome.verdict` values" — which makes
 * `accept | edit | respond | ignore` verdicts too. They are listed together here because
 * they are read the same way: a predicate counts them, and an edge condition projects them.
 */
export const REPLY_VERDICTS = [
  "confirmed",
  "declined",
  "tentative",
  "timed_out",
  "bounced",
  /** §6.5 — a reply that arrived after its wait resolved. Recorded; never reopens it. */
  "late",
] as const;

/** §6.2 — the four decisions a human wait can return. */
export const DECISION_VERDICTS = ["accept", "edit", "respond", "ignore"] as const;

export const VERDICTS = [...REPLY_VERDICTS, ...DECISION_VERDICTS] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * The verdicts that CLOSE a wait. The other two are the states §6.5 says the contract must
 * name, because a retry loop never converges on them: `tentative` records without
 * resolving, and `late` is by definition after the fact. Neither may become the resolving
 * outcome, or a "maybe" would fire a downstream pivot.
 */
export const NON_RESOLVING_VERDICTS = ["tentative", "late"] as const;

export function isResolvingVerdict(verdict: Verdict): boolean {
  return !(NON_RESOLVING_VERDICTS as readonly string[]).includes(verdict);
}

/** §6.2 — the resolutions an edge condition can fire on. */
const EDGE_CONDITIONS = [
  "accept",
  "edit",
  "respond",
  "ignore",
  "timeout",
  "bounced",
  "satisfied",
] as const;
export type EdgeCondition = (typeof EDGE_CONDITIONS)[number];

/**
 * What a guard may test. Verdicts FIRST, and that ordering is the point.
 *
 * `resolutionOf` projects a verdict onto an `EDGE_CONDITIONS` value, and it maps both
 * `confirmed` and `declined` onto `satisfied` — the wait resolved either way; the answer is in
 * the outcome. That projection is right for "did this wait finish", and useless for the
 * question the product actually asks: *did Dana say yes or no*. A guard spelled `{on:"accept"}`
 * against a `confirmed` reply simply never fires, which is how this was found — by writing the
 * ten-node slice and watching the arm not fire.
 *
 * So a guard reads the VERDICT where there is one, and falls back to the resolution. The two
 * sets overlap on `bounced` (a verdict and a resolution, the same event) and that is harmless:
 * they agree.
 */
export const GUARD_VALUES = [
  ...VERDICTS,
  ...EDGE_CONDITIONS.filter((condition) => !(VERDICTS as readonly string[]).includes(condition)),
] as const;
export type GuardValue = (typeof GUARD_VALUES)[number];

/** §6.2 — how reversible this activity's effect on the world is. */
export const EFFECT_CLASSES = ["pure", "reversible", "compensatable", "pivot"] as const;
export type EffectClass = (typeof EFFECT_CLASSES)[number];

/** §6.6 — an activity in one of these classes moves bytes we cannot take back. */
export const IRREVERSIBLE_EFFECT_CLASSES = ["compensatable", "pivot"] as const;

export function isIrreversible(effectClass: EffectClass): boolean {
  return (IRREVERSIBLE_EFFECT_CLASSES as readonly string[]).includes(effectClass);
}

/** §6.2 — the three things an `accept_event` can block on. */
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
export const TRIGGER_RELATIONS = ["Trigger", "Invalidate", "Derive", "Approve", "Timeout"] as const;
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
 * §6.7 — the shape refusals, named once so the prose that teaches them cannot drift.
 *
 * These are the refusals an author actually hits, and the plugin's repair table is asserted
 * against this list. A reason added here without a repair written for it fails that test,
 * which is the point: a refusal the model has never been told how to fix is a loop.
 */
export const STRUCTURAL_REFUSALS = [
  "ARITY",
  "WAIT_MUST_ROUTE",
  "NO_ELSE_ARM",
  "AMBIGUOUS_ELSE",
  "GUARD_OUTSIDE_DECISION",
  "DERIVED_STATUS",
  "INITIAL_NODE",
  "UNREACHABLE_NODE",
  "DEAD_END",
  "CYCLE",
] as const;

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

/** §6.4 — ops that are legal against a terminal activity. Everything else is invariant 1. */
export const TERMINAL_SAFE_OP_KINDS = [
  "supersede_node",
  "record_outcome",
  "record_output",
] as const;
