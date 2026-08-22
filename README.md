# Kona

**Beads with state machines, plus the plugin Beads never had.**

A deterministic CLI over an append-only log of typed mutations. An LLM authors a workflow
graph, a human approves it, and the model **mutates its topology mid-run** as reality
answers — fan-outs sprout, follow-ups appear on silence, paths reroute when a premise
breaks. Every change carries its rationale. Any fresh session reads the file and continues.

> **⚖ The law: the `kona` binary never calls a language model.**
> Every verb is a pure function of `.kona/mutations.jsonl` + the clock + the mailbox cursor.
> All judgment lives in the Claude Code plugin.

Design: [`docs/prd.md`](docs/prd.md) · [`docs/spec.md`](docs/spec.md) · [`docs/plan.md`](docs/plan.md)
Evidence: [`docs/probes/`](docs/probes/) (six empirical runs) · [`docs/research/`](docs/research/) (200 technologies)

---

## Status

Block 1, first vertical slice: **`init` → `mutate` → `graph`, end to end.**

| Verb | |
|---|---|
| `kona init` | create `.kona/`, write the genesis record, refuse on a network filesystem |
| `kona mutate` | the only write path — validate → lock → CAS → append → fsync |
| `kona graph` | the only read contract — the graph is a **fold** over the log |
| `next` `brief` `poll` `resume` `effect` `view` | specified, not built; the CLI says so rather than doing nothing |

Of the three invariants, **#1 (terminal & effect protection)** is enforced. #2 and #3 land
with the wait and outbox engines.

## Try it

```bash
bun install
bun run check          # typecheck (incl. the purity gate) + lint + knip + tests

alias kona="bun $PWD/packages/kona/src/bin.ts"

mkdir /tmp/thursday && cd /tmp/thursday
kona init
cat > ops.json <<'EOF'
[
  {"op":"add_node","label":"Ask Dana to play Thursday","type":"task",
   "spec":{"instruction":"Email Dana asking if she can play in goal Thursday.",
           "outputs":[{"name":"reply","type":"string"}],
           "effect_class":"pivot",
           "effect":{"channel":"email","recipient_ref":"roster.contacts#dana"}}},
  {"op":"add_node","label":"Wait for Dana","type":"wait",
   "spec":{"instruction":"Await Dana's reply.","effect_class":"pure",
           "deadline":{"at":"2026-08-22T17:00:00.000Z"},
           "on_timeout":"$0",
           "match":{"kind":"event","conditions":[{"kind":"reply","on":"satisfied"}]}}},
  {"op":"add_edge","from":"$0","to":"$1"}
]
EOF
kona mutate --ops ops.json --base-version 0 \
  --why "Dana is the only goalie on the roster" --reason-code MISSING_STEP
kona graph
kona mutate --ops ops.json --base-version 0 --why "again" --reason-code OTHER; echo $?  # 3
```

`--why` and `--reason-code` are **required**. A commit without a rationale is impossible,
not discouraged.

**Exit status is 8-bit** — `409` truncates to `153`, so HTTP-shaped codes are not available:
`0` ok · `1` refused · `3` stale base version · `4` invariant violation. Every non-zero exit
writes one stderr line beginning with a symbolic reason.

## Layout

```
packages/core/    types, vocabularies, the 6 ops, invariants, fold.
                  ZERO deps. PURE: no fs, no clock, no model.
packages/kona/    .kona/ layout, lock + CAS, the verbs. The only thing that writes.
packages/viewer/  React Flow + dagre over the log. Depends on core ONLY — it cannot
                  reach the store, because it does not depend on the package that is one.
```

The dependency graph enforces what prose can only assert: `core` has no `node:fs` import
to make, so exactly one package writes bytes, and `viewer` has no `@kona/cli` to import.

## The viewer

```bash
cd packages/viewer && bun run dev     # falls back to fixtures/ when there is no pursuit here
KONA_ROOT=/tmp/thursday bun run dev   # or point it at one
```

Localhost only, read-only, zero outbound calls. It reads **the log** and folds it with `core`'s
own `foldLog`, which is the same function `kona graph --json` calls — so it cannot drift, and
`packages/viewer/test/contract.test.ts` asserts the projection byte-for-byte against
`fixtures/thursday.graph.json`. The mutation timeline needs `rationale`, which the graph
projection does not carry; that is why the viewer reads the log rather than the projection.

Append a version to a pursuit it is watching and the topology re-ranks, tweens and flashes the
new subtree. A **status-only** version moves nothing: dagre is memoized on a topology signature,
not on `graph_version`, which bumps on a status tick too.

The stylesheet is compiled, not plugged in: `bun run css` turns `src/theme.css` into the
committed `src/styles.css`. `bun-plugin-tailwind` resolves relative to the working directory,
and `kona view` runs from the operator's pursuit directory, where there is no `bunfig.toml` —
the plugin would silently not be found and the viewer would render unstyled. A test recompiles
and compares, so the committed file cannot drift.

## The purity gate

`core` being pure is a spec-level law, so it is checked by a machine — in three places,
because no single one covers it:

| | Catches |
|---|---|
| `packages/core/tsconfig.purity.json` | `types: []`, so `node:fs` does not resolve and `process` / `Bun` are not names. Impure `core` **fails to compile** |
| `.oxlintrc.json` override | `Date.now`, `Math.random`, restricted imports and globals, scoped to `core/src` |
| `packages/core/test/purity.test.ts` | the rest — `new Date()`, `fetch`, and the forbidden opcodes — since those typecheck fine against `lib.esnext` |

Verify the gate bites:

```bash
echo 'export const x = process.pid;' >> packages/core/src/ids.ts
bun run typecheck:purity   # TS2591: Cannot find name 'process'
```

## Quality gates

`bun run check` must be clean. Coverage and mutation score are **targets, not gates** (spec §7).

| | |
|---|---|
| `bun run typecheck` | TypeScript 7.0.2, four projects including the purity gate |
| `bun run lint` | oxlint 1.79 with type-aware rules |
| `bun run knip` | unused files, exports, dependencies |
| `bun test` | 570 tests |
| `bun run mutate` | StrykerJS 10, three tiers with per-area floors |

## Toolchain notes — TypeScript 7 breaks things, and here is how

TS 7.0 is the native Go port. Its npm entry exports exactly two keys, `version` and
`versionMajorMinor`: **there is no programmatic compiler API until 7.1.** Anything that
does `require("typescript")` for the compiler is dead on arrival. Each of these was
verified empirically, not read off a changelog.

| | |
|---|---|
| **typescript-eslint is impossible** | It throws `typescript-eslint does not support TS 7.0.` at *module load*. `@typescript-eslint/parser` has the same guard, so there is no "small ESLint for just the architectural rules" escape hatch either. Hence **oxlint**, whose type-aware engine is a standalone Go binary versioned against the compiler (`oxlint-tsgolint@7.0.2001`) |
| **Stryker needs one line** | `@stryker-mutator/core`'s sandbox calls `ts.parseConfigFileTextToJson()` and dies before running a single mutant. `tsconfigFile` points at a **file that does not exist**, which makes the preprocessor a no-op; the real tsconfig is still copied into the sandbox, and Bun does not need it rewritten |
| **No `typescript-checker`** | It cannot initialise against TS 7.0, and it buys nothing: Bun is transpile-only, so a type-invalid mutant still runs and still dies. Measured — identical per-directory scores with and without it |
| **No project references** | `composite: true` cannot combine with `noEmit: true` (TS6310), so references would force a build step. Bun's workspace symlink plus `"exports"` resolves `@kona/core` with no tsconfig help at all |
| **Config keys now removed** | `baseUrl` (use `paths`), `target: es5`, `moduleResolution: node`, `module: amd\|umd\|system`, and — surprisingly — `esModuleInterop: false` and `allowSyntheticDefaultImports: false`, which are now permanently on |
| **`types` defaults to `[]`** | Which is inconvenient everywhere else and exactly what makes the purity gate free |

`knip --production` is deliberately **not** a gate: it flags every export whose only
consumer is a test, and this package's real consumers — the viewer and the plugin — are
later epics. `exclude: ["types"]` is set for the same reason.
