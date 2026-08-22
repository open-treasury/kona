/**
 * A clock, injected rather than read.
 *
 * §6.8 holds the `kona` binary to "a pure function of `mutations.jsonl` + the clock + the
 * mailbox cursor", and `core` has a compiler gate enforcing it. `demo/` has no such gate —
 * it is a directory, not a package — so the same discipline is kept by construction here:
 * nothing under `demo/mailbox/` or `demo/personas/` calls `Date.now()`, and every timestamp
 * comes through one of these.
 *
 * The payoff is that a scripted run reproduces, which is what makes the rig usable as spec §7's
 * acceptance test rather than only as stage decoration. It reproduces for everything the rig
 * itself stamps; a remote provider's own timestamps are its business, and `port.ts` says which
 * fields those are.
 */

/** Returns an ISO-8601 instant. */
export type Clock = () => string;

export function systemClock(): Clock {
  return () => new Date().toISOString();
}

/**
 * A clock that starts at `startIso` and advances by `stepMs` on every read.
 *
 * Advancing on read rather than staying frozen matters: two messages that share a timestamp
 * cannot be ordered, and a cursor over them cannot be made monotonic.
 */
export function steppingClock(startIso: string, stepMs = 1000): Clock {
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) throw new TypeError(`steppingClock: not an ISO instant: ${startIso}`);
  let tick = 0;
  return () => new Date(start + tick++ * stepMs).toISOString();
}
