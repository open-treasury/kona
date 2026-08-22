/**
 * `cn` — conditional classes, with later Tailwind utilities beating earlier ones.
 *
 * `clsx` flattens the conditions; `twMerge` resolves the conflicts, which is the half that
 * matters here. A node card composes a base class list with a status modifier, and without the
 * merge `border-l-status-dropped-ink border-l-status-done-ink` would resolve by stylesheet order
 * rather than by argument order — the same class list would paint differently depending on
 * which utility Tailwind happened to emit first.
 */

import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
