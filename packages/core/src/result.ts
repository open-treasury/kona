/**
 * How `core` says no.
 *
 * §6.8 requires every non-zero exit to write one stderr line beginning with a symbolic
 * reason, so a rejection carries a machine-readable `reason` alongside prose. Returning
 * a value rather than throwing keeps the pure layer honest: a caller cannot forget to
 * handle a rejection, because it has nothing else to unwrap.
 */

export type RejectionCode = "REFUSED" | "INVARIANT_VIOLATION";

export interface Rejection {
  /** Maps to the process exit status: REFUSED -> 1, INVARIANT_VIOLATION -> 4 (§6.8). */
  code: RejectionCode;
  /** Symbolic, stable, greppable. The first token of the stderr line. */
  reason: string;
  message: string;
  /** The activity the operator has to go look at. §6.7: "Reject the commit, name the activity." */
  activity?: string;
  /** Which op in the batch. Absent when the rejection is about the batch as a whole. */
  op_index?: number;
  /** Which invariant, when `code` is INVARIANT_VIOLATION. */
  invariant?: 1 | 2 | 3;
}

export type Result<T> = { ok: true; value: T } | { ok: false; rejection: Rejection };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function refuse(
  reason: string,
  message: string,
  extra: Omit<Rejection, "code" | "reason" | "message"> = {},
): Result<never> {
  return { ok: false, rejection: { code: "REFUSED", reason, message, ...extra } };
}

export function violate(
  invariant: 1 | 2 | 3 | undefined,
  reason: string,
  message: string,
  extra: Omit<Rejection, "code" | "reason" | "message" | "invariant"> = {},
): Result<never> {
  return {
    ok: false,
    rejection: {
      code: "INVARIANT_VIOLATION",
      reason,
      message,
      ...(invariant === undefined ? {} : { invariant }),
      ...extra,
    },
  };
}

/** One line, symbolic reason first. §6.8. */
export function formatRejection(rejection: Rejection): string {
  const parts = [rejection.reason];
  if (rejection.invariant !== undefined) parts.push(`invariant=${rejection.invariant}`);
  if (rejection.activity !== undefined) parts.push(`activity=${rejection.activity}`);
  if (rejection.op_index !== undefined) parts.push(`op=${rejection.op_index}`);
  parts.push(rejection.message);
  return parts.join(" ");
}
