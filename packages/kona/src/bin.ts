#!/usr/bin/env bun
/** The process boundary. Everything below `run` is testable without one. */

import { run } from "./cli.ts";
import { systemClock } from "./clock.ts";

const code = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  pid: process.pid,
  now: systemClock,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});

process.exit(code);
