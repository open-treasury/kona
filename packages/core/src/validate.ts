/**
 * `validate()` — the pre-commit gate. §7: "If only one suite gets written, write
 * `validate()`." A surviving mutant here is a bad graph reaching the file.
 *
 * The order is fixed and each stage may only assume the previous one passed:
 *
 *   1. parse      shape, free, before any graph logic runs (§6.7)
 *   2. authority  role-scoped write access (§6.7 concurrency #1)
 *   3. normalize  `$N` resolved, ids minted (§6.4)
 *   4. apply      the batch, against a clone of head
 *   5. invariants op-delta against **pre-commit head** (§6.7)
 */

import type { Actor, AuthoredOp, CommittedOp } from "./schema.ts";
import { AuthoredBatchSchema } from "./schema.ts";
import { type Graph, isNodeTerminal } from "./graph.ts";
import { applyOps } from "./apply.ts";
import { normalizeBatch } from "./normalize.ts";
import { type Result, ok, refuse, violate } from "./result.ts";

/** §6.7 — only the orchestrator may change the shape of the graph. */
const TOPOLOGY_OPS = new Set(["add_node", "add_edge", "supersede_node"]);

export function parseBatch(raw: unknown): Result<AuthoredOp[]> {
  const parsed = AuthoredBatchSchema.safeParse(raw);
  if (parsed.success) return ok(parsed.data);
  const first = parsed.error.issues[0];
  return refuse(
    "MALFORMED_OPS",
    parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; "),
    first?.path[0] !== undefined && typeof first.path[0] === "number"
      ? { op_index: first.path[0] }
      : {},
  );
}

export function checkAuthority(actor: Actor, ops: readonly AuthoredOp[]): Result<null> {
  if (actor.kind !== "subagent") return ok(null);
  const index = ops.findIndex((op) => TOPOLOGY_OPS.has(op.op));
  if (index === -1) return ok(null);
  return refuse(
    "UNAUTHORIZED_ACTOR",
    `a subagent may not mutate topology; op ${index} is '${ops[index]?.op}'`,
    { op_index: index },
  );
}

/**
 * Invariant 1 — terminal & effect protection.
 *
 * An **op-delta** predicate: each op is tested against **pre-commit head**, never against
 * post-commit state. The difference is the whole invariant. `{from: A, to: B}` means "B
 * requires A", so B's dependency edges point *into* B and survive B completing — a
 * post-state reading of "no blocking edge into a terminal node" would reject every commit
 * from the first completed node onward. Existing edges into terminal nodes are untouched;
 * they record how the node became reachable.
 */
export function checkInvariant1(pre: Graph, ops: readonly CommittedOp[]): Result<null> {
  const terminalAtHead = new Set(
    [...pre.nodes.values()].filter(isNodeTerminal).map((node) => node.id),
  );

  // A compensation is an added node declaring which executed node it offsets. The
  // direction matters: the NEW node compensates the OLD one, never the reverse.
  const compensatedInBatch = new Set(
    ops.flatMap((op) =>
      op.op === "add_node" && typeof op.spec.compensates === "string"
        ? [op.spec.compensates]
        : [],
    ),
  );

  for (const [index, op] of ops.entries()) {
    if (op.op === "add_edge" && terminalAtHead.has(op.to)) {
      return violate(
        1,
        "TERMINAL_NODE_PROTECTED",
        `cannot add a blocking edge into '${op.to}', which is already terminal`,
        { node: op.to, op_index: index },
      );
    }

    if (op.op === "set_status" && terminalAtHead.has(op.node)) {
      return violate(
        1,
        "TERMINAL_NODE_PROTECTED",
        `'${op.node}' is terminal; only supersede_node, record_outcome and record_output may target it`,
        { node: op.node, op_index: index },
      );
    }

    if (op.op === "supersede_node") {
      const node = pre.nodes.get(op.node);
      if (
        node !== undefined &&
        node.status.effect_log.length > 0 &&
        !compensatedInBatch.has(op.node)
      ) {
        return violate(
          1,
          "UNCOMPENSATED_SUPERSEDE",
          `'${op.node}' has already moved bytes; superseding it requires a compensation in the same batch`,
          { node: op.node, op_index: index },
        );
      }
    }
  }

  return ok(null);
}

export interface ValidateInput {
  /** Pre-commit head. Never mutated. */
  graph: Graph;
  /** Raw authored ops, straight off disk. Unparsed on purpose — stage 1 is the parser. */
  ops: unknown;
  actor: Actor;
  /** The version this batch would commit as. */
  version: number;
}

export interface ValidateOutput {
  /** Refs resolved, ids minted. This is what gets written to the log. */
  ops: CommittedOp[];
  /** Post-commit graph, for previewing a mutation without writing it. */
  graph: Graph;
}

export function validate(input: ValidateInput): Result<ValidateOutput> {
  const parsed = parseBatch(input.ops);
  if (!parsed.ok) return parsed;

  const authorized = checkAuthority(input.actor, parsed.value);
  if (!authorized.ok) return authorized;

  const normalized = normalizeBatch(input.graph, parsed.value);
  if (!normalized.ok) return normalized;

  const applied = applyOps(input.graph, normalized.value, input.version);
  if (!applied.ok) return applied;

  const invariant1 = checkInvariant1(input.graph, normalized.value);
  if (!invariant1.ok) return invariant1;

  return ok({ ops: normalized.value, graph: applied.value });
}
