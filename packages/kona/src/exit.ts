/**
 * §6.8 — exit status is 8-bit, so HTTP-shaped codes are not available: `409` truncates to
 * `153` and `422` to `166`, which would silently read as success-adjacent nonsense in a
 * shell. Four small codes, and the detail goes to stderr as a symbolic reason.
 */

import type { Rejection } from "@kona/core";

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_STALE_BASE_VERSION = 3;
export const EXIT_INVARIANT_VIOLATION = 4;

export function exitCodeFor(rejection: Rejection): number {
  if (rejection.code === "INVARIANT_VIOLATION") return EXIT_INVARIANT_VIOLATION;
  if (rejection.reason === "STALE_BASE_VERSION") return EXIT_STALE_BASE_VERSION;
  return EXIT_REFUSED;
}
