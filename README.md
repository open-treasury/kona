# Kona

**A living workflow graph — Beads with state machines.**

An agent's plan normally lives in its context window: you cannot see it, it cannot constrain
what the agent does next, and it dies with the session. Kona puts it in a file — a graph the
model authors, works against, and rewrites as reality answers, carrying the reason for every
change.

**You can see it.** A live graph, not a chat scroll. Steps are claimed before they are worked,
so a plan that goes quiet tells you *which step* it is quiet inside — and every mutation
carries a `--why` the store refuses to commit without.

**The agent is grounded by it.** `kona next` is the only source of work, and it is computed
from the log rather than remembered. A finished step is terminal: the store refuses to reopen
it, so work is not silently redone. This is enforcement, not advice — three invariants live in
the store, not in a prompt.

**And it survives.** Kill the session; a fresh one reads the file and continues. There is no
snapshot to rebuild, because the graph *is* a fold over the log.

> **⚖ The law: the `kona` binary never calls a language model.**
> Every verb is a pure function of `.kona/mutations.jsonl` + the clock + the mailbox cursor.
> All judgment lives in the Claude Code plugin — which is what makes the store testable, the
> crash-resume decidable, and the cost bounded by events rather than turns.

## Why this is not already solved

Every property above exists somewhere. The three-way intersection does not, and for a
structural reason:

| | |
|---|---|
| **The mutator is a machine** | Adaptive BPM solved runtime workflow change in 2008, with rationale fields and all. It died because the mutator was an expert human with a BPMN editor. LLMs removed that bottleneck two years ago |
| **The timeline is irreversible** | AFlow, ADAS and DSPy optimise topology *between* runs, scored against a benchmark they re-execute. You cannot email thirty people five times and take the mean |
| **Waits outlive the process** | Temporal, LittleHorse, Golem, Hatchet and Trigger.dev all pin in-flight work to the version it started on. **Every replay-based engine buys crash-resume by forbidding mutation.** That unanimity is the evidence this is unsolved rather than merely unbuilt |

## What we measured

The demo is a public benchmark, not a scenario we wrote: Terminal-Bench 3's
`production-planning` — reconcile an ERP, an MES and a warehouse into a schedule that
survives **20 constraint checks**. Four hours of expert time, authored by a manufacturing
engineer. The same model runs it twice, with Kona and without. Rig and pre-registration:
[`docs/eval.md`](docs/eval.md).

Given a five-node skeleton and nothing else, the agent:

- **authored its own plan** — 15 nodes and 22 edges added in a single commit
- **claimed each step before working it**, so a plan that goes quiet says *which* step
- **caught its own mistake** — committed a `supersede_node` carrying reason code
  `CONTRADICTION` when it found it had read a constraint wrong, with the correction in one
  sentence. Unprompted, inside a benchmark container
- **satisfied 17 of 20 constraints** — and scored **`0.0`**, because the suite is
  all-or-nothing. A plan is not a solver. What it changes is whether you can tell the
  difference, which is exactly what a binary score throws away

## What's inside

```
packages/core/    types, the 6 ops, 3 invariants, fold. ZERO deps, no fs, no clock, no model
packages/kona/    .kona/ layout, lock + CAS, the 9 verbs. The only thing that writes
packages/viewer/  React Flow + dagre over the log. Depends on core ONLY — it cannot reach
                  the store, because it does not depend on the package that is one
plugin/           the Claude Code plugin: two skills, an executor subagent, a SessionStart
                  hook. Where ALL the judgment lives
eval/             the measurement rig: the benchmark task, both arms, the analysis
```

The dependency graph enforces what prose can only assert: `core` has no `node:fs` to import,
so exactly one package writes bytes.

**Nine verbs, and no tenth.** `init` · `mutate` (the only write path: validate → lock → CAS →
append → fsync) · `graph` (the only read contract — a **fold** over the log, never a snapshot)
· `next` (the ready frontier, computed never stored) · `brief` · `effect reserve|record` (the
outbox) · `resume` · `poll` · `view`.

**Three invariants, enforced in the store rather than advised in a prompt:** terminal and
effect protection · predicate-waits stay satisfiable · effects are bounded and addressed.

## Try it

The demo's own task, in miniature. Effect-free — every node is `pure` — which is what most
real work looks like.

```bash
bun install
bun run check          # typecheck (incl. the purity gate) + lint + knip + tests

alias kona="bun $PWD/packages/kona/src/bin.ts"

mkdir /tmp/plan && cd /tmp/plan
kona init
```

**v1 — read before you schedule.** The dependency is not advice: `kona next` will not offer
the scheduling step until the reading step is `done`.

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

**v2 — now it can be planned.** `$N` refers to an earlier op in the same batch; ids are
minted from labels.

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

**Claim it before you work it.** A node in flight leaves the frontier, so a plan that goes
quiet says which step it is quiet inside:

```bash
printf '[{"op":"set_status","node":"schedule-the-work-orders","status":"in_flight","evidence_ref":"claim"}]' > claim.json
kona mutate --ops claim.json --base-version 2 --why "Starting placement." --reason-code OTHER
kona next     # the node is gone from the frontier
```

A second claim on the same node is refused with `ALREADY_CLAIMED`. If the holder never comes
back, `kona resume` returns it — nothing was sent, so nothing needs a human.

**And the refusal, which is the product.** The moment a pursuit touches the world the store
stops guessing. Ask a supplier the graph has never heard of and it will not have it:

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

## Quality gates

`bun run check` — typecheck (including a purity gate that makes `core`'s independence a
compile error, not a code review note), lint, knip, and **1,244 tests**. Mutation-score
floors where it pays: `validate()` and `fold()` at 100.

The plugin's prompts are tested against the code they describe: the op shapes in the skill
files are extracted and run through the real parser, and the vocabularies they quote are
compared against `core`'s frozen tuples. The README's own walkthrough above is executed by
`packages/kona/test/readme.test.ts` — a code fence is not code until something runs it.

## More

[`docs/prd.md`](docs/prd.md) · [`docs/spec.md`](docs/spec.md) · [`docs/eval.md`](docs/eval.md)
· [`docs/prfaq.md`](docs/prfaq.md)

Where you see a number in this repo, it was measured. `n=60`, `17 of 20`, `0 of 8 -> 10 of 10`
are the receipts.
