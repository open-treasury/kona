/**
 * Display formatting, kept away from the model.
 *
 * These functions decide how something reads, never what it means. Anything that decides what
 * a value *is* — whether a deadline has blown, whether an activity is ready — belongs in `model/`
 * and is tested against the fixture; anything here is free to change without a test breaking.
 */

const UNITS: [ms: number, suffix: string][] = [
  [86_400_000, "d"],
  [3_600_000, "h"],
  [60_000, "m"],
  [1000, "s"],
];

/**
 * A countdown with two units of precision, signed. "2d 6h", "14m 03s", "-1h 22m".
 *
 * Two units rather than one because "1d" hides eleven hours, and rather than three because a
 * chip that reflows every second is harder to read than one that does not.
 */
export function formatDuration(ms: number): string {
  const negative = ms < 0;
  let rest = Math.abs(ms);
  const parts: string[] = [];

  for (const [size, suffix] of UNITS) {
    if (parts.length === 2) break;
    const n = Math.floor(rest / size);
    if (n === 0 && parts.length === 0 && size > 1000) continue;
    parts.push(parts.length === 0 ? `${n}${suffix}` : `${String(n).padStart(2, "0")}${suffix}`);
    rest -= n * size;
  }

  if (parts.length === 0) parts.push("0s");
  return (negative ? "-" : "") + parts.join(" ");
}

/** UTC throughout. A pursuit's log is UTC and a local rendering would disagree with it. */
export function formatInstant(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A timestamp for a person: `Aug 22, 06:57Z`.
 *
 * The `Z` stays. This file's rule is UTC throughout — a pursuit's log is UTC and a local
 * rendering would disagree with the file it claims to be showing — and a UTC time printed
 * without its marker is not friendlier, it is a time in the wrong zone with no way to tell.
 * The year is dropped because a pursuit runs for days, and the one on screen is this one.
 */
export function formatStamp(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  const date = new Date(parsed);
  const month = MONTHS[date.getUTCMonth()] ?? "";
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${month} ${String(date.getUTCDate())}, ${hh}:${mm}Z`;
}

export function formatIso(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? iso : formatInstant(parsed);
}

/** Compact JSON for the inspector's reveal blocks. */
export function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

/**
 * A status as a reader's word rather than the wire value.
 *
 * `active` is the one status the viewer does not print as it is spelled. Statuses land inside
 * sentences here, and "which is still active" reads as *merely alive* rather than §6.2.1's
 * *somebody is inside it right now*. One place does the translation so the two call sites
 * cannot drift apart.
 */
export function statusInWords(state: string): string {
  return state === "active" ? "in flight" : state;
}
