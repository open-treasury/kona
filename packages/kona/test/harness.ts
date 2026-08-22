import { expect } from "bun:test";
import { run } from "../src/cli.ts";
/** A real pursuit in a temp directory, a fixed clock, and captured streams. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../src/io.ts";

export interface Harness {
  dir: string;
  io: Io;
  out: string[];
  err: string[];
  writeOps: (name: string, ops: unknown) => string;
  /** Advance the fixed clock, so a test can tell `attempted_at` from `completed_at`. */
  setClock: (iso: string) => void;
  reset: () => void;
  cleanup: () => void;
}

export function harness(now = "2026-08-21T12:00:00.000Z"): Harness {
  const dir = mkdtempSync(join(tmpdir(), "kona-test-"));
  const out: string[] = [];
  const err: string[] = [];
  let clock = now;

  return {
    dir,
    out,
    err,
    setClock: (iso) => {
      clock = iso;
    },
    io: {
      cwd: dir,
      pid: 4242,
      now: () => clock,
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

/**
 * Put a roster on the record, so a node addressed to one of these people is legal under
 * invariant 3(b). Returns the new head version.
 *
 * TWO commits, and it has to be two: §6.7 says "a recipient existing only in the proposing
 * batch is rejected", which is a statement about pre-commit head. A batch that records a
 * roster and emails it at once is refused — you cannot email somebody you have not yet
 * looked up.
 *
 * Deliberately its OWN node rather than whatever the test's plan already calls a roster: a
 * fixture that made the evidence and the node's `inputs` the same record would silently
 * satisfy `inputs_resolved` too, and tests about being blocked would stop testing it.
 */
export async function seedRoster(h: Harness, names: readonly string[]): Promise<number> {
  const plan = h.writeOps("seed-roster-plan.json", [
    {
      op: "add_node",
      label: "Roster on file",
      type: "task",
      spec: {
        instruction: "The roster as it stands, read from the club sheet.",
        outputs: [{ name: "members", type: "string[]" }],
        effect_class: "pure",
      },
    },
  ]);
  expect(
    await run(
      ["mutate", "--ops", plan, "--base-version", "0", "--why", "who is on the roster", "--reason-code", "MISSING_STEP"],
      h.io,
    ),
  ).toBe(0);

  const record = h.writeOps("seed-roster-record.json", [
    {
      op: "record_output",
      node: "roster-on-file",
      output_name: "members",
      value: [...names],
      evidence_ref: "roster.csv#v3",
    },
    // Finished, so it leaves the frontier: the roster HAS been read, and a seed that
    // lingered in `kona next` would show up in every readiness assertion downstream.
    { op: "set_status", node: "roster-on-file", status: "done", evidence_ref: "roster.csv#v3" },
  ]);
  expect(
    await run(
      ["mutate", "--ops", record, "--base-version", "1", "--why", "read the club sheet", "--reason-code", "OTHER"],
      h.io,
    ),
  ).toBe(0);

  h.reset();
  return 2;
}
