/**
 * The wall clock, in exactly one place.
 *
 * §6.10 rule 4 wants a live deadline countdown, which means something has to re-render on a
 * timer. Keeping that one thing here — rather than a `Date.now()` inside a node component —
 * is what lets every model function stay pure and take `now` as an argument, and it is why
 * `test/waitState.test.ts` can pin a moment and assert an exact remaining time.
 */

import { useEffect, useState } from "react";

/** One second is the coarsest tick that still makes a countdown look alive. */
const TICK_MS = 1000;

export function useNow(tickMs: number = TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, tickMs);
    return () => {
      clearInterval(id);
    };
  }, [tickMs]);

  return now;
}
