/** A real pursuit in a temp directory, a fixed clock, and captured streams. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixedClock } from "../src/clock.ts";
import type { Io } from "../src/io.ts";

export interface Harness {
  dir: string;
  io: Io;
  out: string[];
  err: string[];
  writeOps: (name: string, ops: unknown) => string;
  reset: () => void;
  cleanup: () => void;
}

export function harness(now = "2026-08-21T12:00:00.000Z"): Harness {
  const dir = mkdtempSync(join(tmpdir(), "kona-test-"));
  const out: string[] = [];
  const err: string[] = [];

  return {
    dir,
    out,
    err,
    io: {
      cwd: dir,
      pid: 4242,
      now: fixedClock(now),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    },
    writeOps: (name, ops) => {
      const path = join(dir, name);
      writeFileSync(path, JSON.stringify(ops));
      return path;
    },
    reset: () => {
      out.length = 0;
      err.length = 0;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export const ASK_DANA = [
  {
    op: "add_node",
    label: "Ask Dana to play Thursday",
    type: "task",
    spec: {
      instruction: "Email Dana asking if she can play in goal Thursday.",
      outputs: [{ name: "reply", type: "string" }],
      effect_class: "pivot",
      effect: { channel: "email", recipient_ref: "roster.contacts#dana" },
    },
  },
  {
    op: "add_node",
    label: "Wait for Dana",
    type: "wait",
    spec: {
      instruction: "Await Dana's reply.",
      effect_class: "pure",
      deadline: { at: "2026-08-22T17:00:00.000Z" },
      on_timeout: "$0",
      match: { kind: "event", conditions: [{ kind: "reply", on: "satisfied" }] },
    },
  },
  { op: "add_edge", from: "$0", to: "$1" },
];
