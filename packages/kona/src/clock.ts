/**
 * The clock, as a value.
 *
 * §6.8 makes every verb a pure function of the log + **the clock** + the mailbox cursor.
 * Passing the clock in rather than calling `Date.now()` is what keeps that sentence
 * testable: a test supplies a fixed clock and the same log yields the same bytes.
 */

export type Clock = () => string;

/** Wall clock, ISO-8601 with milliseconds. The only place `new Date()` is called. */
export const systemClock: Clock = () => new Date().toISOString();

export function fixedClock(iso: string): Clock {
  return () => iso;
}
