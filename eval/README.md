# `eval/` — the rig

A paired A/B on **Terminal-Bench 3 / Frontier-Bench v0.1**: the same model, on the same
tasks, with and without Kona. Proposal, costings and the frozen pre-registration:
[`docs/eval.md`](../docs/eval.md).

**A directory, not a package** — §6.12's category for `demo/`, and for the same reason: it
drives `kona` as a subprocess, and the package graph exists to constrain the product, not
the instruments. Nothing here is importable by `core`, `kona` or `viewer`.

## What the two arms are

|              | Agent                                    | Difference                                                    |
| ------------ | ---------------------------------------- | ------------------------------------------------------------- |
| **baseline** | Harbor's stock `terminus-2`              | —                                                             |
| **kona**     | `eval/harbor/kona_agent.py:KonaTerminus` | `kona` on `PATH`, `.kona/` initialised at `/`, one `SKILL.md` |

Same model, same prompt template, same parser, same turn loop. `KonaTerminus` subclasses
`Terminus2` and overrides only `setup()`. Terminus-2 discovers `SKILL.md` by itself —
Harbor scans `skills_dir` inside the container and parses the same YAML frontmatter the
Claude Code plugin already uses, so the skill format ported for free.

`.kona/` goes at `/` because the CLI walks up from cwd looking for it, the way git finds
`.git` — so no assumption about any task's working directory is needed.

## Running it

```bash
eval/run/00-preflight.sh     # no API key, no tokens: installs Harbor, compiles kona,
                             # checks skill drift, builds images, proves the layer installs
export DEEPSEEK_API_KEY=...
eval/run/01-probe.sh         # ~10 min, ~$0.30 — measures the REAL cost per run
eval/run/02-ab.sh            # ~70 min — the paired A/B
```

Run pre-flight the day _before_. Run slots are the scarce resource, not money, and the
first one should not be spent discovering that an image does not build.

**Do not skip the probe.** Per-run cost spans $0.5–$1.7 depending entirely on whether
prompt caching engages, which is the difference between the iteration costing $6 and $20.
The probe measures it and prints how many tasks fit a $10 or $15 cap.

Knobs: `MODEL` (default `deepseek/deepseek-v4-flash`), `N_CONCURRENT`, `DATASET`.

## Why these six tasks

Every task in `harbor/tasks.txt` has a **native** agent budget of ≤60 minutes in its own
`task.toml`, so the run uses `--agent-timeout-multiplier 1.0` and each gets exactly the
time its author intended. Nothing is truncated — "you crippled the tasks" is not available
as an objection to whatever comes out. Wall-clock is 60 m (longest budget) + 10 m (longest
verifier) ≈ 70 minutes; footprint is 40 GB of container RAM across both arms.

## Reading the result

`eval/analyze/paired.ts` reports per-task deltas, the **sign pattern**, and the
pre-registered go/no-go bar. The unit is a task, not a run. Six tasks at one attempt each
reports a _direction_, never significance, and the tool says so on every invocation.

## The gate

`eval/gen/check-drift.ts` fails if `plugin/skills/run/SKILL.md` changes without the eval
skill being reviewed. The eval skill is an **adaptation** of the plugin loop — the plugin
is written around counterparties, replies and irreversible sends, and these tasks have
none — so it is authored by hand, which is exactly why it can rot silently. Re-stamp with
`--accept` after reviewing.

## Known fidelity gaps

Recorded because they bound what the result can claim, not because they are acceptable:

- **The port flattens two roles into one.** The plugin splits orchestrator
  (`skills/run`) from executor (`agents/kona-executor`, a subagent with its own tools and
  an `EXECUTED`/`COMPOSED`/`REFUSED` contract). Terminus-2 has no subagents, so both
  collapse into one loop and the executor's fail-closed rules become prose.
- **Invariant coverage on effect-free work is 1 of 3.** Terminal protection fires; the
  predicate-satisfiability and effect-gate invariants have no waits or sends to protect.
  Measured, not assumed — `plans/active/kona-eval/context.md` → Q1.
- **A stub identity is required.** `brief` returns `NO_IDENTITY` before it checks whether a
  node has an effect, so the container ships a fictional mailbox it never uses.
