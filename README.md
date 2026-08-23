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
Measurement (proposal): [`docs/eval.md`](docs/eval.md)

Those three rest on an evidence base that is **not published**: six empirical probe runs and a
200-technology prior-art review. Both quote heavily from primary sources, and the probe
transcripts are raw model output from runs never written to be read by anyone else. What they
concluded is public — every claim they support is stated with its measurement, either in the
documents above or in a comment at the decision it justifies. Where you see a number in this
repo, it was measured; `n=60` and `2 of 4` and `0 of 8 -> 10 of 10` are the receipts.

---

## Status

**Complete.** Nine verbs, three invariants, the viewer, the Claude Code plugin, and an
evaluation rig that runs it against a real benchmark. 1,240 tests.

| Verb | |
|---|---|
| `kona init` | create `.kona/`, write the genesis record, refuse on a network filesystem |
| `kona mutate` | the only write path — validate → lock → CAS → append → fsync |
| `kona graph` | the only read contract — the graph is a **fold** over the log (`--json --history` adds the rationale chain; `--history` alone changes nothing, since the text rendering has nowhere to put it) |
| `kona next` | the ready frontier, computed never stored |
| `kona brief` | a node's subgraph plus identity, correlation and fail-closed preconditions |
| `kona effect` | `reserve` \| `record` — the outbox, the only verbs that touch the world |
| `kona resume` | reconcile-then-repair: fires overdue deadlines, surfaces unknown sends |
| `kona poll` | which wait each inbound reply belongs to — and nothing about what it says |
| `kona view` | start the viewer — user-run, never plugin-spawned |

All three invariants are enforced in the store, not advised in a prompt:

| | |
|---|---|
| **1 — terminal & effect protection** | a terminal node takes only `supersede_node`, `record_outcome`, `record_output`; superseding a node that has moved bytes needs a compensation in the same batch. Tested as an **op-delta against pre-commit head**, never as a post-state predicate |
| **2 — predicate-waits stay satisfiable** | a batch may not leave a quorum unreachable. Recording the second of two refusals is refused with `PREDICATE_UNSATISFIABLE` — "add a live member in this batch, or supersede the wait" — which is what makes a recovery *atomic with* the premise break rather than a promise to fix it later |
| **3 — the effect gate** | (a) the pursuit-wide budget is spent at `effect reserve`, counting **attempts**, because a cap counting only confirmed sends is spendable by crashing; (b) a `recipient_ref` must resolve to somebody the graph already knew — **a recipient existing only in the proposing batch is rejected** |

## Try it

The worked example is the demo's own task: a production plan that must satisfy constraints
read out of three systems before anything is scheduled. It is effect-free — every node is
`pure`, nothing is ever sent — which is what most real work looks like.

```bash
bun install
bun run check          # typecheck (incl. the purity gate) + lint + knip + tests

alias kona="bun $PWD/packages/kona/src/bin.ts"

mkdir /tmp/plan && cd /tmp/plan
kona init
```

**v1 — read before you schedule.** Nothing may be planned until something in the graph says
what the constraints are. The dependency is not advice: `kona next` will not offer the
scheduling step until the reading step is `done`.

```bash
cat > constraints.json <<'EOF'
[
  {"op":"add_node","label":"Read the line constraints","type":"task",
   "spec":{"instruction":"Read the shift calendar and downtime windows for every line.",
           "outputs":[{"name":"windows","type":"string[]"}],"effect_class":"pure"}},
  {"op":"record_output","node":"$0","output_name":"windows",
   "value":["L1 06:00-14:00","L2 14:00-22:00"],"evidence_ref":"mes.shift_calendar#v3"},
  {"op":"set_status","node":"$0","status":"done","evidence_ref":"mes.shift_calendar#v3"}
]
EOF
kona mutate --ops constraints.json --base-version 0 \
  --why "Read the calendar before scheduling against it." --reason-code MISSING_STEP
```

**v2 — now the work can be planned.** `$N` refers to an earlier op in the same batch, and ids
are minted from labels.

```bash
cat > schedule.json <<'EOF'
[
  {"op":"add_node","label":"Escalate: no feasible slot","type":"task",
   "spec":{"instruction":"Report that demand cannot be met inside the calendar.",
           "effect_class":"pure"}},
  {"op":"add_node","label":"Schedule the work orders","type":"task",
   "spec":{"instruction":"Place each released order on a qualified line inside its window.",
           "inputs":[{"ref":"read-the-line-constraints.windows"}],
           "outputs":[{"name":"placements","type":"string[]"}],"effect_class":"pure"}},
  {"op":"add_edge","from":"read-the-line-constraints","to":"$1"}
]
EOF
kona mutate --ops schedule.json --base-version 1 \
  --why "The calendar is read; the orders can be placed against it." --reason-code NEW_CONSTRAINT

kona graph
kona next     # the ready frontier — computed, never stored
kona mutate --ops schedule.json --base-version 1 --why "again" --reason-code OTHER; echo $?  # 3
```

**Claim it before you work it.** A node in flight leaves the frontier, so nothing else picks
it up, and a plan that goes quiet says which step it is quiet inside:

```bash
printf '[{"op":"set_status","node":"schedule-the-work-orders","status":"in_flight","evidence_ref":"claim"}]' > claim.json
kona mutate --ops claim.json --base-version 2 --why "Starting placement." --reason-code OTHER
kona next     # the node is gone from the frontier
```

A second claim on the same node is refused with `ALREADY_CLAIMED`. If the holder never comes
back, `kona resume` returns it — nothing was sent, so nothing needs a human.

**And the refusal, which is the product.** The example above sends nothing, but the moment a
pursuit touches the world the store stops guessing. Ask a supplier the graph has never heard
of, as your *first* commit against a fresh pursuit, and it will not have it:

```bash
cat > notify.json <<'EOF'
[
  {"op":"add_node","label":"Escalate: shortage unresolved","type":"task",
   "spec":{"instruction":"Report that the shortage could not be covered.","effect_class":"pure"}},
  {"op":"add_node","label":"Ask the supplier to expedite","type":"task",
   "spec":{"instruction":"Email the supplier asking them to pull the delivery forward.",
           "effect_class":"pivot",
           "effect":{"channel":"email","recipient_ref":"suppliers.contacts#acme"}}}
]
EOF
kona mutate --ops notify.json --base-version 0 --why "expedite the shortage" --reason-code OTHER
```

```
UNEVIDENCED_RECIPIENT node=ask-the-supplier-to-expedite op=1 nothing in the graph attests to
'acme' (recipient_ref 'suppliers.contacts#acme'). A recipient must already be named by a
recorded output that cited its source, or by an outcome's attrs — evidence that existed
BEFORE this batch. At n=60 a mutator that could not satisfy a constraint invented
counterparties and queued real email to them, passing every other check. Record where
'acme' came from first, or ask a human.
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
plugin/           the Claude Code plugin: two skills, one executor agent, a SessionStart
                  hook. Where ALL the judgment lives.
eval/             the measurement rig. A directory, NOT a package, so nothing here is
                  importable by core, kona or viewer — it drives the binary as a
                  subprocess, the way an agent in a container does.
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

## The plugin

```bash
claude plugin validate plugin        # manifest, skills and agent, checked by the real tooling
```

Two skills and one agent, and the split between them is the law again: `/kona:plan` authors a
graph and `/kona:run` executes one, and neither can send anything the binary has not already
agreed to. `skills/run` sets `disable-model-invocation: true` — the loop that moves bytes is
started by a person, never picked up because it looked relevant.

The §6.2 op catalogue ships into the plan prompt **verbatim**, because a paraphrase produced
four stuck-gate defects in the probes. "Verbatim" cannot mean copying the spec's shorthand,
which is not parseable JSON — so every JSON example in every skill file is extracted by
`packages/kona/test/plugin-catalogue.test.ts` and run through the real `parseBatch`. If the
schema changes and the prompt does not, that test fails. So do the vocabularies: the statuses,
verdicts and reason codes quoted in the prompt are compared against `core`'s frozen tuples.

The SessionStart hook runs `kona resume --dry-run` and **nothing else** — reporting, never
repairing, because firing timeouts unprompted at every session start is a commit nobody asked
for. It never touches `.kona/` directly either; a test greps for it, because a second thing
that knows the layout is how a format ends up with two readers.

## What was proven, and how

The rig that proved these is gone — its scenario was a hockey game, and the demo is now a
single supply-chain task from Terminal-Bench 3 (see [`docs/eval.md`](docs/eval.md)). The
measurements it took stand; they are recorded here because the code that produced them no
longer is.

Three runs drove the real binary as a subprocess, and none subsumed another. A **replay**
proved things about structure a loop cannot make happen on cue. A **loop** proved termination,
which a replay assumes. And only a **real signal** proved that the state a crash leaves is the
state the in-process tests simulate — a detached process group, `SIGKILL`, a genuinely fresh
process made to say what is going on.

Each of the last two found a bug the others could not. `kona brief` was handing executors the
sender's reply address while `kona poll` watched for the wait's, so every reply in a real run
would have correlated to nothing — both halves had passing unit tests. And a `kill -9`
mid-write left the next command naming a corpse for thirty seconds, in exactly the window a
crash gets discovered in.

`kona resume` answered a fresh terminal in **135ms**, against §8's 60-second budget. What makes
it that is having no snapshot to rebuild.
it that is having no snapshot to rebuild.

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
| `bun test` | 1,200 tests |
| `bun run mutate` | StrykerJS 10, four tiers with per-area floors. Measured 2026-08-22: `core` **90.84** (floor 90) · `outbox` **96.73** (95) · `durability` **95.19** (90) · `rest` **81.45** (80) |

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

`knip --production` is deliberately **not** a gate: it flags every export whose only consumer
is a test. `exclude: ["types"]` is set for the same reason.

The floors differ by area because a surviving mutant means different things in different
places: in `validate()` it is a bad graph reaching the file, and in the CLI's argument
plumbing it is a worse error message. The outbox is highest — a surviving mutant there is a
second email, and there is no rollback.

Each mutation tier runs only the suites that could kill its mutants. `packages/viewer` imports
`@kona/core` and never `@kona/cli` — a test enforces both directions — so viewer tests can kill
a `core` mutant and can never kill a `kona` one. That is not a micro-optimisation: the viewer's
`fs.watch` test has to spend five real seconds asleep, and the command runner pays it per
mutant. Scoping the kona-only tiers took `durability` from about ten minutes to one.
