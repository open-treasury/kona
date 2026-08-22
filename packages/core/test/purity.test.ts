/**
 * The determinism law, for the half the compiler cannot see.
 *
 * `tsconfig.purity.json` already makes `core` fail to compile if it imports `node:fs` or
 * names `process` or `Bun` — those need ambient types it does not load. But `Date.now`,
 * `new Date` and `Math.random` live in `lib.esnext`, so they typecheck perfectly. They are
 * also exactly the impurities that matter here: §6.8 makes every verb a pure function of
 * the log **+ the clock**, and a clock `core` reaches for itself is a clock no test can fix.
 *
 * oxlint 1.79 has no `no-restricted-syntax`, so expressing this as a lint rule would mean
 * an alpha JS plugin. A test costs nothing and names the reason when it fires.
 */

import { describe, expect, test } from "bun:test";
import { FORBIDDEN_OP_KINDS } from "../src/index.ts";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

const BANNED: { pattern: RegExp; why: string }[] = [
  { pattern: /\bDate\.now\s*\(/, why: "reads the wall clock; take a clock as an argument" },
  { pattern: /\bnew Date\s*\(\s*\)/, why: "reads the wall clock; take a clock as an argument" },
  { pattern: /\bMath\.random\s*\(/, why: "non-deterministic; a fold must be reproducible" },
  { pattern: /\bperformance\.now\s*\(/, why: "reads a clock" },
  { pattern: /\bfetch\s*\(/, why: "core does no I/O" },
];

/** Scan code, not prose: a comment explaining the ban must not trip it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(dir, name));
}

describe("core is pure (§6.12)", () => {
  const files = sourceFiles(SRC);

  test("there is something to check", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  test.each(files)("%s reaches for no clock and no randomness", (file) => {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const { pattern, why } of BANNED) {
      const match = pattern.exec(code);
      expect(match === null ? "" : `${match[0]} — ${why}`).toBe("");
    }
  });

  test("no forbidden opcode appears anywhere in core", () => {
    // §8: "No `delete_node` verb and no `rollback` opcode anywhere in code or schema."
    // vocab.ts names them in one exported list so the ban is checkable; nothing else may.
    const quoted = new RegExp(`"(${FORBIDDEN_OP_KINDS.join("|")})"`);
    const offenders = files
      .filter((file) => !file.endsWith("vocab.ts"))
      .filter((file) => quoted.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
