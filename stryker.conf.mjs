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

/**
 * WHICH SUITES CAN KILL THIS TIER'S MUTANTS — and no more.
 *
 * The command runner re-runs the whole command per mutant, so every second in it is
 * multiplied by the mutant count. Including a suite that cannot possibly kill a tier's
 * mutants is pure cost; excluding one that can would let a covered mutant survive and send
 * somebody hunting a test that already exists.
 *
 * The line is the dependency graph. `packages/viewer` imports `@kona/core` and NEVER
 * `@kona/cli` — `packages/viewer/test/seam.test.ts` enforces that in both directions — so
 * viewer tests can kill a `core` mutant and can never kill a `kona` one.
 *
 * The cost is not marginal. `packages/viewer/test/logFeed.test.ts` is a real `fs.watch` test
 * and spends about five seconds asleep, which it has to: notification timing is the thing
 * under test. That is 5s of every 7.2s run, paid per mutant, for suites that in the
 * kona-only tiers cannot change the answer.
 *
 * `KONA_SKIP_EXTERNAL` is the same rule one level down: `plugin-catalogue.test.ts` shells out
 * to `claude plugin validate` three times, which no tier's mutants can affect either. It runs
 * in `bun run check` and sits out mutation runs.
 */
const KONA_ONLY = "KONA_SKIP_EXTERNAL=1 bun test packages/core packages/kona";
const EVERYTHING = "KONA_SKIP_EXTERNAL=1 bun test packages";

const TIERS = {
  /** Pure, branch-heavy, and the last thing standing between a bad batch and the log. */
  core: {
    mutate: ["packages/core/src/**/*.ts"],
    thresholds: { high: 100, low: 95, break: 90 },
    // The viewer folds, diffs and renders core's output all day; its tests kill core mutants
    // that nothing in `packages/core/test` reaches.
    command: EVERYTHING,
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
    // `core/effect.ts` is in scope, and the viewer reads `effect_log` to paint a node as
    // sending. At a 100 floor the conservative command is the right one.
    command: EVERYTHING,
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
    command: KONA_ONLY,
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
    command: KONA_ONLY,
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
  // Never `demo/`. Those suites drive the binary as a SUBPROCESS, so they cannot report a
  // mutant's death to Stryker's sandbox at all — and they are minutes long apiece, because
  // one of them kills real processes. See the note on TIERS for the split within `packages/`.
  commandRunner: { command: config.command },
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
