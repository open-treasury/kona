/**
 * The parser. §6.7: "The parser first, free." A zod schema at the CLI boundary rejects
 * malformed shape — legal type and required fields, well-formed guards, and a deadline on
 * every accept-event — before any graph logic runs.
 *
 * Every object is `strictObject`: an unrecognised key is a rejection, not a silent drop.
 * A typo'd `recipient_refs` that parsed as "no recipient" would walk straight past
 * invariant 3(b).
 *
 * ## What mutation testing reports here, and why most of it stays
 *
 * A third of this file is zod error TEXT — `"activity id must match …"`, `"every wait requires a
 * deadline (§6.2)"` — plus zod's own `code` and `path` fields. Mutants that blank those
 * strings survive, and deliberately: §6.8 makes the symbolic REASON the API and zod's message
 * merely the detail behind it. Pinning the wording would be testing the phrasing of an error
 * rather than the fact of one, and would break on every zod upgrade for no gain.
 *
 * The mutants worth killing here are the ones that change what the parser ACCEPTS, and they
 * are tested in `contracts.test.ts` — the anchors on `/^\$\d+$/` and `/^\d+[smhd]$/`, which
 * unanchored would let `goalie$0` be a batch ref and `48hours` be a duration.
 */

import { z } from "zod";
import {
  ACTIVITY_ID_PATTERN,
  MAX_ACTIVITY_ID_LENGTH,
  PREFIX_PATTERN,
  isValidActivityId,
} from "./ids.ts";
import {
  ACTOR_KINDS,
  GUARD_VALUES,
  EFFECT_CLASSES,
  MATCH_KINDS,
  REASON_CODES,
  STATUSES,
  TRIGGER_RELATIONS,
  VERDICTS,
} from "./vocab.ts";

/** A committed activity id. §6.2. */
export const ActivityIdSchema = z
  .string()
  .max(MAX_ACTIVITY_ID_LENGTH)
  .regex(ACTIVITY_ID_PATTERN, "activity id must match [a-z0-9][a-z0-9-]* and never contain '/'");

/**
 * §6.4 intra-batch reference: `$0` is the id minted by `ops[0]`.
 *
 * The spec's grammar also shows `$2.children.dana`, which addressed children created by
 * ops that pass three deleted. With six ops nothing creates a child, so the dotted form
 * has no referent and is rejected rather than silently ignored.
 */
export const OpRefSchema = z.string().regex(/^\$\d+$/, "batch ref must be $N");

export function isOpRef(value: string): boolean {
  return /^\$\d+$/.test(value);
}

/**
 * Authored position: either a committed id or a reference to an earlier op in this batch.
 *
 * A single refinement rather than a union of the two schemas, because a union reports
 * "Invalid input" — and an author who just wrote `goalie/dana` needs to be told which of
 * the two forms they missed, not that something was wrong.
 */
const AuthoredRefSchema = z
  .string()
  .refine(
    (value) => isOpRef(value) || isValidActivityId(value),
    "must be an activity id matching [a-z0-9][a-z0-9-]* (never '/'), or a batch ref like $0",
  );

// ---------------------------------------------------------------------------
// ActivityNode spec — the AUTHORED half of an activity (§6.2)
// ---------------------------------------------------------------------------

/** §6.2 — deadlines take one of exactly three shapes. */
const DeadlineAtSchema = z.strictObject({
  at: z.iso.datetime(),
});
const AuthoredDeadlineAfterSchema = z.strictObject({
  after: AuthoredRefSchema,
  duration: z.string().regex(/^\d+[smhd]$/, "duration must look like 48h"),
});
const CommittedDeadlineAfterSchema = z.strictObject({
  after: ActivityIdSchema,
  duration: z.string().regex(/^\d+[smhd]$/, "duration must look like 48h"),
});
const DeadlineExprSchema = z.strictObject({
  expr: z.string().min(1),
  backstop: z.iso.datetime(),
  after_unknown: z.boolean(),
});
const AuthoredDeadlineSchema = z.union([
  DeadlineAtSchema,
  AuthoredDeadlineAfterSchema,
  DeadlineExprSchema,
]);
export const DeadlineSchema = z.union([
  DeadlineAtSchema,
  CommittedDeadlineAfterSchema,
  DeadlineExprSchema,
]);
export type Deadline = z.infer<typeof DeadlineSchema>;

const InputRefSchema = z.strictObject({
  /** Resolves to a DECLARED output of some activity. Without the pair, every ref dangles. */
  ref: z.string().min(1),
});

const OutputDeclSchema = z.strictObject({
  name: z.string().min(1),
  type: z.string().min(1),
});

/**
 * §6.2 — the effect block, required on `pivot` and `compensatable`.
 *
 * `correlation` and `effect_key` are absent when authored and filled in by the store:
 * correlation derives from the activity id (§6.5) and the key from (activity_id, created_by_version)
 * (§6.6). An author who supplied either would be minting identity, which §6.4 forbids.
 */
const AuthoredEffectSchema = z.strictObject({
  channel: z.literal("email"),
  /** A ref, never a literal address — invariant 3(b) resolves it against the graph. */
  recipient_ref: z.string().min(1),
});

const CommittedEffectSchema = AuthoredEffectSchema.extend({
  correlation: z.string().min(1),
  effect_key: z.string().min(1),
});

const CountPredicateSchema = z.strictObject({
  count: z.strictObject({
    verdict: z.enum(VERDICTS),
    attrs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  }),
  op: z.literal(">="),
  n: z.number().int().min(1),
});
export type CountPredicate = z.infer<typeof CountPredicateSchema>;

const GuardSchema = z.union([
  z.literal("else"),
  z.strictObject({ on: z.enum(GUARD_VALUES) }),
  CountPredicateSchema,
]);

/** §6.5 — the authored half of an accept-event action. */
const WaitMatchShape = {
  kind: z.enum(MATCH_KINDS),
  conditions: z
    .array(
      z.strictObject({
        kind: z.string().min(1),
        on: z.enum(GUARD_VALUES),
        in_reply_to: z.array(z.string()).optional(),
        from: z.string().optional(),
        at: z.iso.datetime().optional(),
        predicate: z.unknown().optional(),
      }),
    )
    .min(1, "a wait with no conditions can never resolve"),
  /**
   * DECLARED BY §6.5 AND READ BY NOTHING. Recorded here rather than quietly carried.
   *
   * The spec's wait example carries `"memory": true` and never says what it means. No code
   * reads it, so the default below is arbitrary and mutation testing correctly reports
   * flipping it as a surviving mutant — there is no behaviour for it to change.
   *
   * It stays because removing it would be a RETROACTIVE tightening: this is a
   * `strictObject`, `MutationRecordSchema` re-parses every historical line on every fold, and
   * every wait in every committed log carries the field. Dropping it would turn those lines
   * into `UNPARSEABLE_RECORD` — and because the expected version is computed from the last
   * SUCCESSFUL record, one refused line cascades the rest of the log into
   * `VERSION_DISCONTINUITY` and the pursuit becomes unreadable forever.
   *
   * So: accepted, defaulted, unread, and now written down.
   */
  memory: z.boolean().default(true),
};
const AuthoredWaitMatchSchema = z.strictObject(WaitMatchShape);
const CommittedWaitMatchSchema = z.strictObject({
  ...WaitMatchShape,
  correlation: z.string().min(1).optional(),
});

/**
 * One arm of a wait's or-group (§6.5), derived from the parser rather than restated beside it.
 *
 * Exported because consumers were writing their own looser copy and then narrowing back down
 * to it by hand. That is two hand-kept shapes and, measured, eleven mutants no test could
 * kill — guards against a match block the parser cannot admit in the first place.
 */
export type WaitCondition = z.infer<typeof CommittedWaitMatchSchema>["conditions"][number];
export type WaitMatch = z.infer<typeof CommittedWaitMatchSchema>;

type AuthoredEffect = z.infer<typeof AuthoredEffectSchema>;
type CommittedEffect = z.infer<typeof AuthoredEffectSchema> | z.infer<typeof CommittedEffectSchema>;

export interface ActionSpec {
  instruction: string;
  inputs: { ref: string }[];
  outputs: { name: string; type: string }[];
  effect_class: (typeof EFFECT_CLASSES)[number];
  effect?: CommittedEffect;
  compensates?: string;
}

export interface AcceptEventSpec extends ActionSpec {
  deadline: Deadline;
  match: WaitMatch;
}

interface AuthoredActionSpec extends Omit<ActionSpec, "effect"> {
  effect?: AuthoredEffect;
}

interface AuthoredAcceptEventSpec extends AuthoredActionSpec {
  deadline: z.infer<typeof AuthoredDeadlineSchema>;
  match: z.infer<typeof AuthoredWaitMatchSchema>;
}

export type ControlSpec = Record<string, never>;

type ControlNodeFields = {
  [T in "initial" | "decision" | "merge" | "fork" | "join" | "final" | "flow_final"]: {
    type: T;
    name?: string;
    spec: ControlSpec;
  };
}["initial" | "decision" | "merge" | "fork" | "join" | "final" | "flow_final"];

type NodeFields =
  | { type: "action"; name: string; spec: ActionSpec }
  | { type: "accept_event"; name: string; spec: AcceptEventSpec }
  | ControlNodeFields;

type AuthoredNodeFields =
  | { type: "action"; name: string; spec: AuthoredActionSpec }
  | { type: "accept_event"; name: string; spec: AuthoredAcceptEventSpec }
  | ControlNodeFields;

type TailOp<R extends string> =
  | { op: "add_edge"; from: R; to: R; guard?: z.infer<typeof GuardSchema> }
  | { op: "set_status"; node: R; status: (typeof STATUSES)[number]; evidence_ref: string }
  | {
      op: "record_outcome";
      node: R;
      verdict: (typeof VERDICTS)[number];
      evidence_ref: string;
      attrs?: Record<string, unknown>;
    }
  | { op: "record_output"; node: R; output_name: string; value: unknown; evidence_ref: string }
  | { op: "supersede_node"; node: R; by?: R };

export type AuthoredOp = ({ op: "add_node" } & AuthoredNodeFields) | TailOp<string>;
export type CommittedOp = ({ op: "add_node"; id: string } & NodeFields) | TailOp<string>;

/** The spec keys that only a worked node may carry. Read by `refineNode`, listed once. */
function behaviourSpecShape<R extends z.ZodType>(ref: R, effect: z.ZodType) {
  return {
    instruction: z.string().min(1),
    inputs: z.array(InputRefSchema).default([]),
    outputs: z.array(OutputDeclSchema).default([]),
    effect_class: z.enum(EFFECT_CLASSES),
    effect: effect.optional(),
    compensates: ref.optional(),
  };
}

function refineBehaviourSpec(spec: Record<string, unknown>, ctx: z.RefinementCtx): void {
  const effectClass = spec["effect_class"];
  const needsEffect = effectClass === "pivot" || effectClass === "compensatable";
  if (needsEffect && spec["effect"] === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["spec", "effect"],
      message: `effect_class '${effectClass}' requires an effect block (§6.2)`,
    });
  }
  if (!needsEffect && spec["effect"] !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["spec", "effect"],
      message: "an effect block on a pure or reversible activity would never be reserved",
    });
  }
}

function addNodeSchemas<R extends z.ZodType>(ref: R, committed: boolean) {
  const base = { op: z.literal("add_node"), ...(committed ? { id: ActivityIdSchema } : {}) };
  const effectSchema = committed
    ? z.union([AuthoredEffectSchema, CommittedEffectSchema])
    : AuthoredEffectSchema;
  const actionSpec = z
    .strictObject(behaviourSpecShape(ref, effectSchema))
    .superRefine(refineBehaviourSpec);
  const acceptEventSpec = z
    .strictObject({
      ...behaviourSpecShape(ref, effectSchema),
      deadline: committed ? DeadlineSchema : AuthoredDeadlineSchema,
      match: committed ? CommittedWaitMatchSchema : AuthoredWaitMatchSchema,
    })
    .superRefine(refineBehaviourSpec);
  const controls = ["initial", "decision", "merge", "fork", "join", "final", "flow_final"] as const;
  return [
    z.strictObject({
      ...base,
      type: z.literal("action"),
      name: z.string().min(1),
      spec: actionSpec,
    }),
    z.strictObject({
      ...base,
      type: z.literal("accept_event"),
      name: z.string().min(1),
      spec: acceptEventSpec,
    }),
    ...controls.map((type) =>
      z.strictObject({
        ...base,
        type: z.literal(type),
        name: z.string().min(1).optional(),
        spec: z.strictObject({}),
      }),
    ),
  ];
}

// ---------------------------------------------------------------------------
// The six ops (§6.4)
// ---------------------------------------------------------------------------

/**
 * The five ops that carry no minted identity. Shared verbatim between the authored and
 * committed unions — only `add_node` differs between the two, and only by gaining an `id`.
 */
function tailOps<R extends z.ZodType>(ref: R) {
  return [
    z.strictObject({
      op: z.literal("add_edge"),
      /** §6.2: `{from: A, to: B}` means **B requires A**. */
      from: ref,
      to: ref,
      guard: GuardSchema.optional(),
    }),
    z.strictObject({
      op: z.literal("set_status"),
      node: ref,
      status: z.enum(STATUSES),
      evidence_ref: z.string().min(1),
    }),
    z.strictObject({
      op: z.literal("record_outcome"),
      node: ref,
      verdict: z.enum(VERDICTS),
      evidence_ref: z.string().min(1),
      attrs: z.record(z.string(), z.unknown()).optional(),
    }),
    z.strictObject({
      op: z.literal("record_output"),
      node: ref,
      output_name: z.string().min(1),
      value: z.unknown(),
      evidence_ref: z.string().min(1),
    }),
    z.strictObject({
      op: z.literal("supersede_node"),
      node: ref,
      by: ref.optional(),
    }),
  ] as const;
}

/** What an author submits: `$N` refs allowed, no minted ids (§6.4 forbids client ids). */
const AuthoredOpUnion = z.union([
  ...addNodeSchemas(AuthoredRefSchema, false),
  ...tailOps(AuthoredRefSchema),
]);
export const AuthoredOpSchema = AuthoredOpUnion as typeof AuthoredOpUnion & z.ZodType<AuthoredOp>;

/**
 * What the log stores: every ref resolved, every id minted. `fold` never mints, so a
 * replay cannot drift from the commit that produced it.
 */
const CommittedOpUnion = z.union([
  ...addNodeSchemas(ActivityIdSchema, true),
  ...tailOps(ActivityIdSchema),
]);
export const CommittedOpSchema = CommittedOpUnion as typeof CommittedOpUnion &
  z.ZodType<CommittedOp>;

/**
 * The AUTHORED half of an activity, derived from the parser rather than restated beside it.
 * Two hand-kept copies of this shape would drift, and the one that drifts is whichever
 * the invariants read.
 */
export type ParsedNodeSpec = ActionSpec | AcceptEventSpec | ControlSpec;

export const AuthoredBatchSchema = z
  .array(AuthoredOpSchema)
  .min(1, "a mutation with no ops is not a mutation");

// ---------------------------------------------------------------------------
// The mutation record (§6.3) — one line per commit
// ---------------------------------------------------------------------------

/** §6.3 — the differentiator. The schema makes omitting it impossible. */
const RationaleSchema = z.strictObject({
  why: z.string().min(1, "--why is required on every mutating verb (§8)"),
  expected_effect: z.string().optional(),
  alternatives_rejected: z.array(z.string()).default([]),
  reason_code: z.enum(REASON_CODES),
});
export type Rationale = z.infer<typeof RationaleSchema>;

const ActorSchema = z.strictObject({
  kind: z.enum(ACTOR_KINDS),
  id: z.string().min(1),
});
export type Actor = z.infer<typeof ActorSchema>;

const TriggerSchema = z.strictObject({
  relation: z.enum(TRIGGER_RELATIONS),
  kind: z.string().min(1),
  from: z.string().optional(),
  in_reply_to: z.string().optional(),
  body: z.string().optional(),
});
export type Trigger = z.infer<typeof TriggerSchema>;

/**
 * §6.9 — who the executor is speaking as. The graph cannot know this, and an executor
 * handed an activity without it signs as nobody and commits to anything.
 */
const IdentitySchema = z.strictObject({
  mailbox: z.string().min(3),
  display_name: z.string().min(1),
  signature: z.string().min(1),
  authority: z.string().min(1, "state plainly what the executor may NOT commit to"),
});
export type Identity = z.infer<typeof IdentitySchema>;

/**
 * Pursuit-wide configuration, carried on the GENESIS RECORD rather than in a second file.
 *
 * §6.1 allows `.kona/` exactly two files and no snapshot, and §6.7 requires the pursuit to
 * be reconstructible from the log alone. A `config.json` would satisfy neither: it would
 * be a second system of record, unversioned, and silently editable after the human
 * approved a plan that depended on it. On v0 it is durable, diffable and resurrectable.
 */
export const PursuitConfigSchema = z.strictObject({
  identity: IdentitySchema.optional(),
  /**
   * The prefix every activity id in this pursuit opens with, fixed at `kona init`.
   *
   * It lives on the genesis record rather than in a flag or a second file because ids
   * already committed cannot be re-minted: if the prefix could change, the log would carry
   * two id shapes and neither would be wrong.
   */
  prefix: z.string().regex(PREFIX_PATTERN).optional(),
  /** Invariant 3(a): the cumulative cap on irreversible sends. */
  effect_budget: z.number().int().min(0).optional(),
});
export type PursuitConfig = z.infer<typeof PursuitConfigSchema>;

export const MutationRecordSchema = z.strictObject({
  v: z.number().int().min(0),
  schema_version: z.number().int().min(1),
  /** Engine-stamped, never LLM-stamped (§6.3). */
  observed_at: z.iso.datetime(),
  occurred_at: z.iso.datetime(),
  actor: ActorSchema,
  trigger: TriggerSchema.optional(),
  ops: z.array(CommittedOpSchema),
  /** Present on v0 only; every later record leaves it absent. */
  config: PursuitConfigSchema.optional(),
  rationale: RationaleSchema,
  /**
   * Starts null and is written later, on evidence. Rationale without outcome is a
   * changelog; rationale with outcome is training data (§6.3).
   */
  outcome: z.unknown().nullable(),
});
export type MutationRecord = z.infer<typeof MutationRecordSchema>;

/**
 * 2 — `sending` became `in_flight` (§6.2).
 * 6 — the activity model: nine node types in two families, and the seven-state lifecycle
 *     (§6.2, §6.2.1). `in_flight` -> `active`, `done` -> `completed`, and the old `active` and
 *     `dropped` each split in two.
 *
 * The status is DATA in `mutations.jsonl`, not just an identifier, so a rename is a breaking
 * change to the log format rather than a cosmetic one. An older log is refused at fold rather
 * than read with an alias: the graph is a fold over the log, and a store that silently accepts
 * two spellings of one state has two spellings to keep true forever.
 *
 * The bump is load-bearing in a way the last one was not, and it is worth saying why. Version 2
 * was protected by the enum as well: a v1 log carrying `sending` is refused because the token
 * no longer exists. This one is NOT, in one direction — a v5 log carrying `active` folds
 * perfectly cleanly under the new vocabulary and reads as CLAIMED when it meant unclaimed. The
 * token survived and inverted, so the version refusal is the only thing standing between an
 * old log and a silently wrong graph. Nothing else in the repo would notice.
 */
export const SCHEMA_VERSION = 6;
