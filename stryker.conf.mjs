/**
 * Mutation testing. §7 sets floors per area rather than one number, because the areas
 * differ in what a surviving mutant would mean: in `validate()` and `fold()` it is a bad
 * graph reaching the file; in the CLI's argument plumbing it is a worse error message.
 *
 * Stryker has exactly ONE global `thresholds` object and no per-glob mechanism, so a
 * per-area floor means one run per area. `scripts/mutation.sh` drives them all.
 *
 * WHY `tsconfigFile` POINTS AT A FILE THAT DOES NOT EXIST:
 * @stryker-mutator/core's sandbox preprocessor does `import('typescript')` and calls
 * `ts.parseConfigFileTextToJson()`. TypeScript 7.0's npm entry exports exactly two keys —
 * `version` and `versionMajorMinor` — so that call throws before a single mutant runs.
 * Naming a nonexistent file makes the preprocessor a no-op; the real tsconfig is still
 * copied into the sandbox, and Bun does not need it rewritten.
 *
 * There is deliberately NO `checkers: ["typescript"]`. @stryker-mutator/typescript-checker
 * cannot initialise against TS 7.0 (it needs the same absent compiler API), and it buys
 * nothing here: Bun is transpile-only, so a type-invalid mutant still runs and still dies.
 */

const TIERS = {
  /** Pure, branch-heavy, and the last thing standing between a bad batch and the log. */
  core: {
    mutate: ["packages/core/src/**/*.ts"],
    thresholds: { high: 100, low: 95, break: 90 },
  },
  /**
   * §7 puts the outbox at 100: a surviving mutant here is a second email, and there is
   * no rollback.
   */
  outbox: {
    mutate: [
      "packages/core/src/effect.ts",
      "packages/kona/src/commands/effect.ts",
      "packages/kona/src/hash.ts",
    ],
    thresholds: { high: 100, low: 100, break: 95 },
  },
  /** The write path: lock, CAS, append, fsync. A surviving mutant here is a lost commit. */
  durability: {
    mutate: [
      "packages/kona/src/lock.ts",
      "packages/kona/src/store.ts",
      "packages/kona/src/commands/mutate.ts",
      "packages/kona/src/commit.ts",
    ],
    thresholds: { high: 100, low: 95, break: 90 },
  },
  /** Verb dispatch, rendering, path handling. */
  rest: {
    mutate: [
      "packages/kona/src/**/*.ts",
      "!packages/kona/src/lock.ts",
      "!packages/kona/src/store.ts",
      "!packages/kona/src/commands/mutate.ts",
      "!packages/kona/src/commands/effect.ts",
      "!packages/kona/src/commit.ts",
      "!packages/kona/src/hash.ts",
      "!packages/kona/src/bin.ts",
    ],
    thresholds: { high: 95, low: 90, break: 80 },
  },
};

const tier = process.env.STRYKER_TIER ?? "core";
const config = TIERS[tier];
if (config === undefined) {
  throw new Error(`Unknown STRYKER_TIER "${tier}". Expected one of: ${Object.keys(TIERS).join(", ")}`);
}

export default {
  $schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  packageManager: "npm",
  testRunner: "command",
  // Scoped to `packages/` on purpose. Every tier mutates code under `packages/`, and the
  // demo suite exercises `demo/` — so running it per mutant tests nothing and costs
  // everything: it re-runs a full divergence scenario per assertion, ~18s, against a
  // packages suite that takes 0.4s. Across ~1400 mutants that is the difference between
  // half a minute and seven hours.
  commandRunner: { command: "bun test packages" },
  // The command runner reports no per-test coverage, so this must be "off".
  coverageAnalysis: "off",
  tsconfigFile: "stryker-no-such-tsconfig.json",
  mutate: config.mutate,
  thresholds: config.thresholds,
  concurrency: 8,
  timeoutMS: 20000,
  tempDirName: `.stryker-tmp/${tier}`,
  reporters: ["clear-text", "progress"],
  clearTextReporter: { logTests: false, allowEmojis: false },
};
