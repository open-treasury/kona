/**
 * The seed the Kona container applies has to be a seed the store accepts.
 *
 * `eval/skills/kona/seed.json` is committed into every Kona container and applied there with
 * `kona mutate --ops`. `kona_agent.py` raises on a non-zero exit, and a raise inside
 * `setup()` makes an ERRORED trial rather than a failed one — so a seed the store refuses
 * does not weaken the Kona arm, it VOIDS it. Every trial errors, the job reports nothing,
 * and the run is billed for the whole two hours anyway.
 *
 * Nothing type-checks that file. It is hand-authored JSON standing against a vocabulary the
 * store keeps moving — node types, statuses, op names, the keys inside `spec` — so the way
 * it breaks is that a token gets renamed in `packages/core` and this JSON, which no compiler
 * has ever read, keeps the old one. That is a rename in a completely different directory,
 * which is exactly the kind of break nobody goes looking for.
 *
 * `eval/run/00-preflight.sh` step 4 makes the same assertion for the operator, minutes before
 * a run. This one makes it on every `bun run check` — which is where the rename that would
 * break it is actually typed, and hours earlier than pre-flight.
 *
 * It drives `kona` as a subprocess rather than importing the store, for both of the reasons
 * the rig always does: `eval/` is "a directory, not a package" (README) and imports nothing
 * from `packages/`, and the question being asked is whether the compiled BINARY accepts the
 * seed. `packages/kona/src/bin.ts` is the exact entry point `eval/bin/build-kona.sh` compiles
 * into the binary the container gets, so answering it here answers it there.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EVAL_ROOT = join(import.meta.dir, "..");
const REPO_ROOT = join(EVAL_ROOT, "..");
const BIN = join(REPO_ROOT, "packages", "kona", "src", "bin.ts");
const SEED = join(EVAL_ROOT, "skills", "kona", "seed.json");
const CONFIG = join(EVAL_ROOT, "skills", "kona", "config.json");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function kona(cwd: string, argv: readonly string[]): Promise<Run> {
  const proc = Bun.spawn([process.execPath, BIN, ...argv], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

let dir: string;
let init: Run;
let seeded: Run;
let frontier: Run;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kona-seed-"));
  // The same flags `kona_agent.py` passes, not a convenient subset. Identity can only be set
  // at init and the prefix is fixed for the life of the pursuit, so an init without
  // `--config` would be a different pursuit from the one the container seeds.
  init = await kona(dir, ["init", "--config", CONFIG, "--prefix", "kn"]);
  seeded = await kona(dir, [
    "mutate",
    "--ops",
    SEED,
    "--base-version",
    "0",
    "--reason-code",
    "MISSING_STEP",
    "--why",
    "Skeleton plan: understand before deciding, decide before doing.",
  ]);
  frontier = await kona(dir, ["next", "--json"]);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the container's seed", () => {
  test("a pursuit initialises from the eval identity config", () => {
    // Not the thing under test — the thing the thing under test stands on. If this is the
    // failure, nothing below it means anything.
    expect([init.code, init.stderr.trim()]).toEqual([0, ""]);
  });

  test("the store accepts it against a fresh pursuit at version 0", () => {
    // Asserted as a pair so that a refusal shows up in the diff as the store's own line —
    // `MALFORMED_OPS op=3 3.type: Invalid option: expected one of ...` names the op and the
    // vocabulary that moved, and reading it beats re-deriving it from an exit code.
    expect([seeded.code, seeded.stderr.trim()]).toEqual([0, ""]);
  });

  test("and it leaves a frontier, or it removed no blank page", () => {
    // Committing is not the point; being pickup-able is. A seed whose every node is blocked
    // exits 0 and starts the Kona arm at the same empty store the seed exists to replace —
    // and the run reads as an honest zero-adoption result rather than as a broken rig.
    expect(frontier.code).toBe(0);
    const ready = JSON.parse(frontier.stdout) as { nodes: unknown[] };
    expect(ready.nodes.length).toBeGreaterThan(0);
  });
});
