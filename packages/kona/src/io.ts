/**
 * Everything the CLI touches that is not the log: streams, cwd, clock, pid.
 *
 * Injected rather than reached for, so a test drives the real verb end to end against a
 * temp directory and a fixed clock, and asserts on exact bytes.
 */

import type { Clock } from "./clock.ts";

export interface Io {
  cwd: string;
  pid: number;
  now: Clock;
  out: (line: string) => void;
  err: (line: string) => void;
}
