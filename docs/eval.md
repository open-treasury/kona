# EVAL — how we measure whether Kona helps on long tasks

**Status:** Proposal (not approved) · **Date:** 2026-08-22 · **Owner:** Ilya Vorobiev
**Reads on:** [`prd.md`](./prd.md) §3, §7 · [`spec.md`](./spec.md) §6.5–6.8 · [`plan.md`](./plan.md)

> Every number below is either **cited** (a public source, linked in §9) or **estimated**
> (marked `est.`, with the arithmetic shown so it can be checked). Nothing here has been
> measured yet — that is the point of the document.

> **v4 — a PoC, not a study.** v1 made *interruption survival* the headline; it is not the claim,
> and it is demoted to §6. v2 fixed the axis to **task length**, waiting or not. v3 took the model as
> given — **DeepSeek only**. v4 takes the scale as given: **one cheap model, a handful of tasks, a
> couple of hours.** What that buys and what it cannot buy is stated in §4 before anything else.

---

## 0. TL;DR

**The PoC is ~$7 and ~2 hours of wall-clock. One day of build stands in front of it.**

5 LHTB tasks × 2 arms × 2 seeds at a 20-minute cap = 20 runs. On `deepseek-v4-flash` off-peak
(**$0.22/1M in, $0.66/1M out**, cache hit **$0.007/1M — 31× below a miss**, and an agentic loop
re-sending its prefix every turn is the ideal cache workload) that is **≈$0.35/run ⇒ ≈$7**, and with
`-n 10` parallelism it lands in **1–2 hours**, not 53.

**What a PoC buys:** the rig works end to end, and the number moved — or didn't — in a direction.
**What it cannot buy:** significance. Five tasks and two seeds will not survive a bootstrap
interval, and the write-up must say so in its first line rather than its last.

Three things the DeepSeek decision changes, none of them about price:

1. **Kona is a Claude Code plugin, and Claude Code does not run DeepSeek.** The Kona arm must be
   rebuilt on a model-agnostic harness first. This is the only real cost in the PoC — and it is
   ~1 day, not 4, because ⚖ *the binary never calls a model* (§2).
2. **DeepSeek V4 is not a weak model.** Terminal-Bench 2.1: **V4-Flash 82.7**, **V4-Pro-0813 87.9**;
   SWE-bench Verified **80.6%** for V4-Pro-Max. Good for external validity, bad for headroom — a
   model that loses the thread less often has less thread for Kona to hold. It also **kills the
   Terminal-Bench 2.0 horizon fit** (v2's T3): at 82.7 that suite is saturated.
3. **Task selection is the whole game at this scale.** With 5 tasks you cannot average your way out
   of a bad draw. §4 gives the selection rule, and it is the single highest-leverage decision here.

| | Tier | Measures | Cost `est.` | Build | Wall-clock |
|---|---|---|---|---|---|
| **T0** | **Port the Kona loop to Terminus-2** — gates everything | nothing yet; unblocks it all | **$0** | ~1 d | — |
| **T1** | **The PoC** — 5 LHTB tasks, paired A/B | direction, and that the rig runs | **~$7** | 0.5 d | 1–2 h |
| **T2** | **Redo rate + loop count** over T1's trajectories | *why* it moved or didn't | **$0 extra** | 0.5 d | — |
| — | *if and only if T1+T2 point somewhere* | | | | |
| **T3** | Widen to ~15 tasks × 3 seeds | a number with an interval | ~$35 | — | ~6 h |
| **T4** | **Resume conformance** — six published properties | durability, comparably | **0 tokens** | 1–2 d | — |

**Order: T0 → T1+T2 → stop and look.** T4 is model-independent and free of this budget entirely;
do it whenever there is an idle day, not as part of the PoC.

---

## 1. The claim, restated so it can be falsified

**Kona should help more as tasks get longer, and roughly not at all when they are short.**

A statement about a *slope*, not a level — the sharpest version of the thesis, because it is the one
that can fail. A scaffold that helps uniformly at every length is not a long-horizon story; it is a
better prompt. So the primary result is an **interaction between arm and length**, and a flat
improvement across all lengths should be reported as a *negative* for the PRD's specific claim even
if the average looks good.

Waiting is not required. A 300-step refactor with no counterparty, no deadline and no email
exercises the same mechanism: the plan is durable and external, the frontier is computed rather than
remembered, and every decision carries the reason it was made. `spec.md` already makes effect-free
work first-class — `effect_class: "pure"` — so a pursuit with zero sends is a normal Kona pursuit.

The instrument names the failure mode better than the PRD does. **Long-Horizon Terminal-Bench:**

> *"The model does not lack the knowledge. It loses the thread: state drifts, earlier decisions are
> forgotten, exploration turns into looping."*

| Failure mode (LHTB's words) | Kona's mechanism | Counted as |
|---|---|---|
| *state drifts* | the graph is a fold over the log, not a memory | constraint-retention probe (§4) |
| *earlier decisions are forgotten* | `--why` on every mutation; `kona brief` re-reads it | decision-retention probe |
| *exploration turns into looping* | `kona next` computes the frontier; done is terminal | **redo rate**, loop count |

---

## 2. T0 — the DeepSeek consequence, and why it is cheap anyway

Kona's judgment lives in a Claude Code plugin (`plugin/agents/kona-executor.md`, hooks, skills).
Claude Code does not run DeepSeek, so **"Claude Code + plugin vs Claude Code" is not an available
A/B here.** Both arms must move to a harness that speaks to DeepSeek.

**Use Terminus-2 for both arms.** It is LHTB's own harness — their 21-model table is all Terminus-2
at a 90-minute budget — it ships inside the modified Harbor bundled in the LHTB repo, and Harbor
routes through LiteLLM, which speaks DeepSeek. So the baseline arm is *stock Terminus-2*, and its
numbers are interpretable against 21 published models for free.

**The Kona arm is then: Terminus-2 + the `kona` binary in the container + the plugin's verb
instructions transplanted into the system prompt.** Nothing else differs. That is as clean an
attribution as this design admits, and it is what AgentSpec's controlled-composition method asks
for: hold the model fixed, vary one scaffold component.

**The port is cheap for a reason worth stating.** ⚖ *the `kona` binary never calls a language
model* — so there is no model-specific logic inside it to port. Terminus-2 is a bash-only agent and
`kona` is a CLI; the agent simply runs `kona next`, `kona brief`, `kona mutate` as bash commands.
The determinism law, written for testability, turns out to be what makes Kona portable to a model
Claude Code cannot host. **That is a finding for the spec, not just a convenience.**

**PoC-grade port is one day, not four.** Do not transplant the plugin. Install the `kona` binary in
the task image and add one paragraph to the Terminus-2 system prompt: the nine verbs, the
`--why` requirement, and "read `kona next` before choosing your next action." That is the whole
arm. Fidelity to the shipped plugin is a question for after the PoC says whether the idea has legs —
and if a paragraph is *not* enough for the model to use Kona at all, that is itself the finding, and
it arrives on day one instead of day four.

`mini-SWE-agent` is the alternative substrate — ~100 lines, bash-only, LiteLLM-pluggable, >74% on
SWE-bench Verified, and Harbor-native. Prefer Terminus-2 anyway, for comparability with LHTB's table.

---

## 3. The instrument: LHTB, and why the alternatives fell away

| Benchmark | Why / why not, **given DeepSeek** |
|---|---|
| **LHTB** — 46 tasks, 9 categories, **69–93 min** and **120–320 steps** each, **9.9M tokens/run avg**, Terminus-2 at a 90-min budget, **continuous 0→1 reward** (solved at ≥0.95) | **The instrument.** Built around our failure mode. Wide open: best model (Grok 4.5) **0.51 avg, 13/46 solved**, **29/46 never passed by anyone**. Open source ([repo](https://github.com/zli12321/LHTB), HF dataset, community leaderboard). Bundles a modified Harbor, so DeepSeek is a config line |
| **Terminal-Bench 2.0** — 89 tasks with **human time labels** (expert <1 h 48.6%, 1–24 h 47.3%, 1–7 d 4.1%) | **Dropped.** v2 wanted this for a METR-style horizon fit, but DeepSeek V4-Flash scores **82.7 on TB 2.1** — saturated. A ceiling has no slope to measure |
| **Frontier-Bench v0.1** (Terminal-Bench 3.0), 74 tasks | **Not now.** Unsaturated, but **binary** scoring at a ~42.7% ceiling wastes most of an expensive run, and LHTB exists specifically because of that |
| **DeepSWE** — long-horizon engineering tasks | **Secondary.** DeepSeek publishes on it (**Flash 54.4, Pro 62.7**), so there is a ready reference point — unsaturated, worth a look after T1 |
| **HCAST** (METR) | Canonical length labels, but public repo is a subset, needs METR contact for the rest, and runs on Inspect rather than Harbor |
| **TheAgentCompany** | Good scoring design (checkpoints + partial credit, +50% completion bonus); tasks are long in scope but only ~27 steps |
| **Vending-Bench 2** · **Gaia2/ARE** | >20M tokens/run; and Gaia2's distinctive axis is time-sensitivity — v1's demoted axis |
| **AgentSpec** | Methodology, not an instrument: decompose the scaffold, hold the model fixed, recombine, attribute. Warns module effects are **not additive** |

---

## 4. The plan

### T1 — the PoC · **~$7 `est.`** · 0.5 d build · **1–2 h wall-clock**

- **Arms:** stock Terminus-2 (baseline) vs Terminus-2 + `kona` (§2). Same model, same container,
  same cap. A strawman baseline invalidates the whole thing.
- **Model:** **`deepseek-v4-flash`**, **off-peak** — peak is 01:00–04:00 and 06:00–10:00 UTC and
  costs double. No V4-Pro cell in the PoC; that is a question for after there is something to check.
- **Cap:** 20 minutes per task. LHTB is *time*-budgeted, not step-budgeted, and sets
  `continue_until_timeout = true` on **30 of 46** tasks — the agent keeps working past its own
  declaration of done — so lowering the per-task timeout is a supported config change, not a hack.
  Reduced-timeout runs are not leaderboard-comparable; irrelevant here, this is a paired A/B.
- **Grid:** 5 tasks × 2 arms × 2 seeds = **20 runs**, `-n 10`.
- **Cost arithmetic** `est.`, V4-Flash off-peak at ~80% cache hit: a full 90-min run is ~9.9M tokens
  ⇒ input 1.8M miss × $0.22 + 7.2M hit × $0.007 ≈ $0.45, output 0.9M × $0.66 ≈ $0.59, **≈$1.04/run**.
  At a 20-minute cap, **≈$0.35/run ⇒ 20 runs ≈ $7**.

**Task selection is the experiment.** With five tasks there is no averaging out a bad draw, and the
rule is not "pick five at random":

> Take the per-task rewards already published for **21 models** on the LHTB leaderboard and choose
> the five with **mid-band mean reward and high across-model variance.** Tasks nobody scores above 0
> have no gradient to move; tasks everyone solves have no headroom. The middle band is where a
> scaffold delta can show up at all.

Reading that table costs one page-load and is worth more than doubling the seed count.

- **Primary read:** paired reward difference per task, and the **sign pattern** across the five. At
  this scale the sign pattern is the result — four or five consistent signs is a reason to spend
  more; a 3–2 split is noise wearing a number.
- **Secondary:** the progress shape — reward at 5 / 10 / 20 minutes. The thesis predicts a
  *widening* gap; a gap that appears immediately and stays flat is a prompt effect, not a
  long-horizon one.

> **The one question that could cut a wider run's cost by ~5×:** can LHTB's dense-reward grader
> score an **intermediate** container state? If it can, one run yields the whole progress curve from
> snapshots instead of one run per budget point. Answerable by reading the repo's grading code (§8).

### T2 — Redo rate and looping · **$0 extra** · 0.5 d

Over T1's existing trajectories. No new model calls, no LLM judge, and — at PoC scale — only the two
probes that need no instrumentation:

| Probe | Definition | Prediction if the thesis holds |
|---|---|---|
| **Redo rate** | fraction of actions repeating an already-completed action (same command, same write) | lower with Kona — `kona next` never offers a done node |
| **Loop count** | repeated (state, action) cycles of length ≥2 | lower with Kona |

*(Constraint- and decision-retention probes need scripted instrumentation in the tasks; they belong
to T3, not the PoC.)*

This is the cheapest falsification available and it may well be the PoC's most useful output: a
reward delta on five tasks is weak evidence, but **redo rate is a direct measurement of the
mechanism** and it is far less noisy, because every run contributes hundreds of actions rather than
one score. If reward is ambiguous and redo rate drops cleanly, that is still a reason to continue.

Note that DeepSeek V4 carries a **1M-token context window**, so nothing here is a story about
running out of room — it is a story about coherence inside a window that is already large enough.
If both probes come back flat, that distinction is the reason, and it belongs in the write-up.

### Go / no-go, written before the run

Spend the T3 money only if T1+T2 clear a bar set in advance:

- **Go:** consistent sign on ≥4 of 5 tasks, **or** a redo-rate reduction ≥20% with a non-negative
  reward delta.
- **No-go:** a 3–2 sign split with flat probes. Write it up as a null PoC and stop — that is a real
  result about a real product claim, obtained for $7.
- **Void:** either arm fails to complete the grid, or the Kona arm spends most of its steps fighting
  the tool rather than the task. That is a T0 defect, not a finding; fix and re-run.

### T3 — widen · **~$35 `est.`** · ~6 h wall-clock · **only past the go bar**

Same rig, ~15 tasks × 3 seeds at a 30-minute cap, plus the two instrumented retention probes and one
`deepseek-v4-pro` cell (87.9 on TB 2.1 vs Flash's 82.7) to check whether an effect survives a
stronger model. This is the first tier that earns a bootstrap interval, and the first whose result
is worth putting in the spec as a number rather than a direction.

### T4 — Resume conformance · **0 eval tokens** · 1–2 days

The six published checkpoint/interrupt/resume properties, against `kona`: **PC** (recovery resumes
from the durable frontier — the graph is a fold), **EO** (effect exactly-once — `reserve` →
`record`, budget spent on attempts), **CV** (every persisted record validates), **CO** (an interrupt
consumed by ≤1 resume — the `poll` cursor), **RD** (the recovery decision is a function of durable
state — ⚖ the binary never calls a model), plus **FD/FI**, an open question (§8).

`demo/script/kill-resume.ts` already sends a real `SIGKILL` to a detached process group at eight
offsets and resumes in a fresh process; what it lacks is the published vocabulary that makes the
result *comparable*. Output: a conformance row beside LangGraph 1.2.9 (violates FD and CV across
five versions), CrewAI (re-executes completed work), LlamaIndex Workflows, pydantic-graph, AutoGen.
**Model-independent, so the DeepSeek constraint does not touch it at all.**

---

## 5. Frontier-Bench — viable, and here is the plan

Two objections were raised against it across v1–v3. **Both have now been withdrawn on the facts.**

**Price — withdrawn.** $766–$5,800 per arm was frontier-model pricing and does not apply here.
At `deepseek-v4-flash` off-peak, assuming ~3B tokens for a full arm (the observed leaderboard range
is 2.9–7.3B), a 90/10 input/output split and 80% cache hits: input 0.54B miss × $0.22 + 2.16B hit ×
$0.007 ≈ $134, output 0.3B × $0.66 ≈ $198 ⇒ **≈$330 per full arm** `est.` — roughly **10× below**
the figure v3 kept repeating. Per run that is **≈$1–1.5**.

**Binary scoring — withdrawn, and it was simply wrong.** Frontier-Bench does not report one bit per
task. Results are **mean reward across five attempts per task**, so each task yields a score on a
0–1 scale at 0.2 resolution, and five tasks × five attempts is **25 outcomes per arm**, not ten
bits. The statistical argument built on "one bit per run" collapses with it.

**A paired A/B needs no published baseline at all.** Both arms are run by us, on the same tasks,
with the same model — the missing DeepSeek row is irrelevant to the comparison. It was only ever
relevant to *task selection*, which is a smaller problem with a cheap fix.

### It is v3, and the task metadata proves it

`tasks/dataset.toml` in `harbor-framework/terminal-bench` (HEAD 2026-08-21, 70 tasks) opens with
`# Dataset manifest for terminal-bench/terminal-bench-3`. The difficulty metadata confirms it
independently — parsed from all 70 `task.toml` files:

| | |
|---|---|
| `expert_time_estimate_hours` | **min 0.75 · median 4 · max 60** |
| agent `timeout_sec` | 1800, 2500, 3600, 5400, 7200, 9000, 10800, 14400, 18000, 28800 |
| categories | Software 20 · Science 15 · ML 12 · Operations 9 · Security 5 · Hardware 5 · Media 4 |
| GPU tasks (avoid) | `fp8-rmsnorm-gemm`, `math-eval-grader`, `exam-pdf-eval`, `jax-speedrun-gpu` |

Terminal-Bench 2.0 had 48.6% of tasks under an hour for an expert. Here the **minimum** is 45
minutes and **half are 4 hours or more**. This is not the saturated 75–84% board.

### Terms

An **arm** is one side of the comparison: one complete run of the same tasks under one condition.
There are two — **baseline** (model alone, stock harness) and **Kona** (identical model, identical
harness, plus `kona-bin` and its prompt paragraph). **Paired** means each task is run in both arms
and compared task-by-task, never as two averages. Everything except Kona is held fixed, which is
what makes a difference attributable.

### The demo at a 60-minute cap

Not a leaderboard placement — a live paired A/B finishing inside an hour. **Both arms run
concurrently**, so wall-clock is one cap, not two.

**Wall-clock is set by the longest task, not by how many.** Everything runs at once, so
`wall = agent cap + longest verifier`. Adding tasks costs RAM, not minutes — which makes RAM the
only real budget, and the set is chosen to fit it rather than the other way round.

**Budget: ≤$15 and ≤90 minutes per iteration.** Money binds before RAM does, so the task count
comes from the dollar cap, not the VM.

**THE CONFIG — 6 tasks, 12 containers, ~70 minutes, 48–64 GB / 20 vCPU, ~$6–20** `est.`

Harbor exposes only `--agent-timeout-multiplier`, a *multiplier*, so a uniform absolute cap is not
expressible — a single multiplier gives a 30-minute task 15 minutes and a 120-minute task 60. The
way out is better than the thing it replaces: **take only tasks whose native budget already fits**,
and run at multiplier **1.0**.

| Native budget | Task | Verifier | Mem | vCPU | Expert | Category |
|---|---|---|---|---|---|---|
| 30 m | `bun-sourcemap-leak` | 10 m | 2 GB | 1 | 1.5 h | Software |
| 42 m | `cli-2ph-simplex` | 10 m | 2 GB | 1 | 2 h | Software |
| 60 m | `layout-config-recreation` | 3 m | 4 GB | 2 | 2 h | Media |
| 60 m | `cargo-flight-dispatch` | 10 m | 4 GB | 2 | 2.5 h | Operations |
| 60 m | `production-planning` | 2 m | 4 GB | 2 | 4 h | Operations |
| 60 m | `kv-live-surgery` | 0 m | 4 GB | 2 | 4 h | Software |

**Every task runs exactly as its author intended — nothing is truncated**, so "you crippled the
tasks" is not available as an objection to whatever the result turns out to be. Wall-clock is
60 m + 10 m ≈ **70 minutes**; 20 GB container RAM × 2 arms = 40 GB.

Eight of the 70 tasks have a native budget ≤60 m and no GPU. Two are excluded: `data-anonymization`
(120-minute verifier, 24 h expert time) and `html-js-filter` (30-minute Playwright verifier, which
alone would push the window to 90 minutes).

### The cost estimate is the weakest number here, and it is fixable for ~$1

Per-run cost is **$0.5 with good prompt caching and $1.7 without**, a 3.4× spread that decides
whether 6 tasks costs $6 or $20. The arithmetic, from LHTB's measured 9.9M tokens per 85-minute
run ⇒ ~7M tokens for 60 minutes:

| | Input | Output | Total |
|---|---|---|---|
| 85% cache hit | 1.0M miss × $0.22 + 5.9M hit × $0.007 = $0.27 | 0.3M × $0.66 = $0.20 | **$0.47** |
| no caching | 6.9M × $0.22 = $1.52 | $0.20 | **$1.72** |

Cache-hit rate depends on whether the harness re-sends a byte-identical prefix each step; if it
truncates or rewrites history, the rate collapses. **Do not guess it — measure it.** A single
paired run at a **10-minute** cap costs ~$0.30 and ten minutes, and yields exact tokens/minute and
the real hit rate. Then the task count for a $15 iteration is arithmetic, not estimation.

Set a hard spend limit on the DeepSeek account regardless. It is the only control that cannot be
undone by a wrong assumption.

Scaling, once $/run is known: **tasks = ⌊15 ÷ (2 × $/run)⌋** — at $0.5 that is 15 tasks (RAM-bound
to ~8 on 64 GB); at $1.7, four.

**One operational trap:** `build_timeout_sec = 600`. On a cold cache the first ten minutes are
Docker. Pre-build every image before anything is live, and do an `--agent oracle` pass first —
oracle applies the reference solution, so it exercises the harness, the `kona-bin` layer and the
verifiers without spending model tokens or a run slot.

**The honest risk, once:** on a v3 task a cheap model may score 0 in both arms, and paired zeroes
demo nothing. The three full-budget tasks are the mitigation — a zero there is a real result about
the model, not an artifact of our cap. Fallback: on LHTB the same model is *measured* at 0.43–0.60
on five pinned tasks (§10).

### Cost of the full thing, for reference

Ranges span the caching spread above ($0.5–1.7 per 60-minute run).

| | Runs | Cost `est.` | Wall-clock |
|---|---|---|---|
| **This demo — 6 tasks** | 12 | **$6–20** | 70 m |
| Calibration probe (1 task, 10-min cap) | 2 | **~$0.30** | 10 m |
| All 70 tasks, 60-min cap, both arms | 140 | $70–240 | 2–3 waves ≈ 3–4.5 h on 64 GB |
| All 70 tasks, full author budgets | 140 | ~$660+ | ≥8 h — the longest task's own budget |
| Leaderboard protocol (k=5) | 700 | ~$3,300 | days |

---

## 6. Interruption, demoted

Still worth measuring, still cheap, no longer the headline. `SIGKILL` costs nothing and
`demo/mailbox/clock.ts` already lets a three-day deadline elapse in milliseconds. Fold it into T1 as
a **third cell** — same tasks, same budget, plus *k* forced restarts — not a tier of its own. Two
properties fall out: completion under restart, and duplicate-effect rate, which invariant 3(a) and
the outbox should hold at **0** where a scratch-file baseline has no guarantee.

---

## 7. Metrics that would come out green for the wrong reason

`demo/script/assertions.ts` already argues that a test passing for a reason unrelated to the claim
is *worse than no test* — it certifies the objection. Same discipline here.

- **`--why` coverage** and **"the plan is visible."** Kona scores 100% and ~0 by construction. These
  measure the schema, not the behaviour. **Excluded.**
- **A uniform improvement across all task lengths.** Reads as a win; is evidence *against* the PRD's
  specific claim (§1). Report the interaction, not the average.
- **The weak-model caveat has inverted, and that is good news.** v2 planned to buy signal with a
  weak model and discount it afterwards. DeepSeek V4 is at or above the frontier on terminal agentic
  work (TB 2.1: 82.7 / 87.9), so an effect measured here is *harder* to dismiss — and *harder to
  find*. Expect a smaller effect than a weak-model sweep would show, and treat a null result as
  correspondingly weaker evidence of absence: it says "not on V4-Flash," not "not for agents."
- **Budget gaming, and the PoC cannot rule it out.** A scaffold that front-loads cheap progress wins
  at a 20-minute cap and would lose at 90. The progress shape (reward at 5/10/20 min) is the only
  hedge available at PoC scale; the actual mitigation — a full-budget cell — lives in T3. Any T1
  write-up must carry this caveat explicitly rather than in a footnote.
- **Single-vendor, single-model, five tasks.** Say all three in the result line. A PoC reports a
  *direction*; the cross-vendor and cross-length claims are out of scope at this budget and stay
  out of the sentence.

**Statistical hygiene, in one paragraph:** pair every run (same task, same seed, same budget, both
arms) and analyse the paired difference — paired designs need far fewer runs for the same power,
which is the only reason this fits. Prefer the continuous outcome over the binary one for the same
reason; LHTB's own line is *"a benchmark that scores everyone 0 ranks no one."* Pre-register metrics
and the stopping rule in `plans/active/kona-eval/plan.md` before the first run, or the first pass
becomes a hypothesis generator wearing a result's clothes. Report negatives: "Kona does not extend
the horizon on DeepSeek V4" belongs in the spec, not a drawer.

---

## 8. Open questions — in the order they gate spending

1. **Does the plugin have anything to say to a solo coding task?** `effect_class: "pure"` makes
   effect-free nodes first-class in the store, but the plugin's loop was built around a pursuit with
   counterparties. If it has no useful behaviour when nothing is ever sent, T1 measures overhead.
   **Gate on this before T0.**
2. **Can LHTB's grader score an intermediate container state?** Worth ~5× the experiment's cost
   (§4). Answerable by reading the repo's grading code.
3. **Is DeepSeek V4 already on the LHTB community leaderboard?** If so, a published baseline exists
   and the reference point is free. One page-load to check.
4. **Rate limits.** What concurrency does the DeepSeek account allow? At 20 runs this only decides
   whether the PoC takes one hour or three; at T3 scale it decides the calendar.
5. **Is the resume-contract artifact public?** The paper cites `results/` and `reproduce.sh`; no repo
   URL surfaced. If unreleased, T3 becomes "implement six probes from the definitions" — still zero
   tokens, ~2 days instead of ~1.
6. **FD/FI have no obvious Kona mapping.** Kona has no fork-vs-retry discriminator because it has no
   replay — `supersede_node` plus compensation is the whole story. Arguably a conformance gap,
   arguably out of scope by design. Needs an answer in the spec's voice before the row is published.
7. **Confirm pricing and model IDs at run time** against [deepseek.ai/pricing](https://deepseek.ai/pricing).
   The rates in §4 came from an August 2026 snapshot; the peak/off-peak split makes scheduling worth
   real money, so verify the window before booking the calendar.

## 9. Where the rig lives

**Not a package.** §6.12 already settles the category: `demo/` is *"throwaway scripts — a directory,
not a package"*, and the eval rig is the same thing — it drives `kona` as a subprocess exactly as
`demo/` does. The package graph exists to enforce three properties of the *product* (the viewer
cannot import the store; exactly one package calls `writeFile`; `core` stays pure). A measurement
rig has no business inside a graph whose job is to constrain what ships.

Two further reasons it could not be a workspace even if we wanted it to:

- **Most of it is not TypeScript.** A forked Harbor is Python, plus Docker layers and LHTB task
  definitions. Vendoring a second toolchain into a Bun workspace buys nothing and costs `bun run check`.
- **Its inputs and outputs must not be committed.** §8.5 flags the training-corpus concern for task
  definitions, and run trajectories are large. Both belong outside git.

So:

| Where | What | Tracked? |
|---|---|---|
| `eval/` — a directory beside `demo/`, not in `packages/` | the container layer, the trajectory analysis, the Kona system-prompt paragraph | yes |
| outside the repo (or ignored) | the forked Harbor checkout, task images, run artifacts | no |
| `plans/active/kona-eval/` | working task docs — **already ignored** by `.gitignore` | no |

**The real risk here is not packaging, it is prompt drift.** If the Kona arm's system-prompt
paragraph is an independent transcription of `plugin/skills/run/SKILL.md`, then editing the plugin
silently starts the experiment measuring a stale Kona, and nothing fails. Generate the paragraph
from the skill file, or add a test that fails when the two diverge. This is the one piece of the
rig that needs a gate.

---

## 10. Pre-registration — frozen 2026-08-22, before any run

> Kept **here**, in a tracked file, rather than in `plans/active/kona-eval/plan.md` — that directory
> is gitignored, and a pre-registration nobody can show predated the data is worth very little.
> Revision semantics differ from the rest of this document: amendments only before run 1, only as
> dated appended lines, never by rewriting what is above. If something here proves wrong once the
> data lands, that is a finding to report, not a line to change.

**Primary read.** Paired per-task reward difference (Kona − baseline), and the **sign pattern**
across the five tasks. At this scale the sign pattern is the result.

**Secondary reads.** Progress shape (reward at 5/10/20 min — the thesis predicts a *widening* gap;
immediate-then-flat is a prompt effect, not a long-horizon one) · redo rate · loop count.

**Task selection rule.** From the per-task rewards published for 21 models on the LHTB leaderboard,
take the five with **mid-band mean reward and high across-model variance**. The five IDs get pinned
below as a dated amendment when the leaderboard is read, and before run 1.

**Go bar.** Consistent sign on **≥4 of 5** tasks, **or** a redo-rate reduction **≥20%** with a
non-negative mean reward delta. **No-go:** a 3–2 sign split with flat probes.

**Stopping rule.** 20 runs. No seeds added after seeing results.

**Declared confounds.** (1) The port flattens Kona's orchestrator/executor split into one agent, so
a null result may be the port's fault rather than the idea's. (2) A 20-minute cap favours a scaffold
that front-loads cheap progress. (3) `deepseek-v4-flash` scores 82.7 on Terminal-Bench 2.1 — a
strong model has less thread to lose, so a null means "not on V4-Flash," not "not for agents."

*Amendments:*

- **2026-08-22 — invariant coverage on effect-free pursuits is 1 of 3, measured.** A five-node pure
  pursuit run through the real binary shows: invariant 1 (terminal protection) **fires** on pure
  nodes — re-opening a done node is refused with exit 4 — while invariants 2 and 3 are inert,
  because a pursuit with no waits and no sends gives them nothing to protect. Dependency ordering
  is **not** enforced at write time either: `set_status done` on a node with unsatisfied
  dependencies commits cleanly, the check being a read-side advisory in `brief`. The mechanism under
  test therefore narrows to **terminal protection plus a durable frontier**, which is what the
  redo-rate probe already measures. The expected effect is correspondingly smaller, and no write-up
  of this PoC may quote the PRD's three-invariant claim as though all three were live on these
  tasks. *(Recorded before run 1; evidence in `plans/active/kona-eval/context.md` → Q1.)*
- **2026-08-22 — the Kona arm requires a stub identity.** `brief` returns `NO_IDENTITY`
  unconditionally, before any effect check, so the task image must ship a `config.json` naming a
  fictional mailbox and authority and run `kona init --config` before authoring. This is a declared
  deviation from how the plugin is used in production, and it counts as part of the port's
  fidelity gap, not as a neutral setup step.

- **2026-08-22 — the selection rule as written was wrong, and here is the correction.** The rule
  said "mid-band mean reward and high across-model variance." Applied to the published per-task
  table (26 models × 46 tasks, 1,196 rows), it returns tasks that discriminate *between models* —
  but this experiment holds the model fixed, and on four of its top five the baseline model already
  scores ≥0.99. A task the baseline solves cannot show an improvement. **Headroom must be measured
  on the baseline model, not across models.** Corrected rule, and the one actually used:

  > `score = across_model_sd × (1 − 2·|baseline_reward − 0.5|)`, over tasks where the baseline's
  > own reward is in (0.05, 0.95). Centrality gives room to gain *and* a foothold to build on;
  > sd is evidence the task separates agents at all rather than being a coin flip.

  Recorded rather than silently swapped, because the failure mode is instructive: an
  across-model criterion smuggles the wrong experiment's logic into a fixed-model design.

- **2026-08-22 — THE FIVE TASKS, pinned. No further changes.** Baseline is
  `DeepSeek V4 Flash` at the published 90-minute budget.

  | Task | Baseline reward | Across-model sd | Score |
  |---|---|---|---|
  | `unknown-config-semantics` | 0.500 | 0.329 | 0.329 |
  | `sokoban` | 0.597 | 0.334 | 0.269 |
  | `matpower-opf-regression` | 0.583 | 0.296 | 0.246 |
  | `sudoku-recovery` | 0.571 | 0.259 | 0.222 |
  | `apex-openroad-ibex-signoff` | 0.590 | 0.210 | 0.172 |

  All five sit between 0.43 and 0.60 for the baseline — real headroom in both directions — and
  span config exploration, puzzle search, power-systems regression, puzzle recovery and hardware
  signoff, so the draw is not one category wearing five names.

- **2026-08-22 — the baseline arm is the current state of the art on this benchmark.**
  `DeepSeek V4 Flash` is **rank 1** on LHTB: mean reward **0.602**, 14/46 solved — ahead of
  GPT-5.6-sol (3h) 0.600, Claude Opus 5 (2h) 0.510, Grok 4.5 0.505. (The project page's "best model
  0.51" predates these entries; the dataset is the newer source.) Two consequences: the baseline
  reference is free and strong, and **the V4-Pro confirmation cell is cancelled** — Pro is rank 18
  at **0.307**, roughly half of Flash on this suite, so it is not a stronger model here and a cell
  on it would test nothing. §4's V4-Pro line is superseded by this amendment.

- **2026-08-22 — interim grading exists, and the progress curve is nearly free.** LHTB grades at
  checkpoints (`LHTB_CHECKPOINT_INTERVAL_SEC`, default 1800) *and* at timeout, not only on final
  state. So the reward-vs-budget curve comes from **one run**, not one run per budget point — the
  ~5× lever named in §4 is real. Set the interval to **300 s** under the 20-minute cap for four
  curve points per run. Open question 2 is closed.

- **2026-08-22 — the instrument moves to Frontier-Bench (Terminal-Bench 3), and the five LHTB
  tasks above are superseded.** Both objections that had kept Frontier-Bench out were withdrawn on
  the facts (§5): it is not binary-per-run (results are mean reward over five attempts) and it is
  not expensive at DeepSeek rates. It is also the board the work is actually for. LHTB remains the
  documented fallback if the model scores zero in both arms.

  **THE SIX TASKS, pinned. No further changes.** Selected by a rule that supersedes the earlier
  one, for a reason worth stating: Harbor offers only a timeout *multiplier*, so a uniform cap is
  not expressible — therefore take only tasks whose **native** agent budget is ≤60 minutes and run
  at multiplier 1.0. Eight of 70 qualify; two are excluded for verifier length.

  `bun-sourcemap-leak` · `cli-2ph-simplex` · `layout-config-recreation` ·
  `cargo-flight-dispatch` · `production-planning` · `kv-live-surgery`

  This is strictly stronger than the previous framing: **every task runs at 1.00 of its author's
  intended budget**, where the earlier plan had three of six truncated.

- **2026-08-22 — the go bar, restated for six tasks.** The original bar was "consistent sign on ≥4
  of 5". Held at the same proportion, six tasks means **≥5 of 6**, or a redo-rate reduction ≥20%
  with a non-negative mean delta. `eval/analyze/paired.ts` computes this bar and prints the verdict
  itself, so it cannot be adjusted after seeing the numbers.

- **2026-08-22 — adoption is a precondition, and zero adoption VOIDS the run rather than
  producing a negative.** Registered before any result existed, because it is an analysis rule and
  adding one after seeing data is precisely what this section exists to prevent.

  The Kona arm *offers* the skill: Terminus-2 advertises it in an `<available_skills>` block and
  the model decides whether to read and use it. Nothing compels it. If it never invokes `kona`,
  the arm is the baseline plus an unused binary, both arms score alike, and the run looks like
  "Kona does not help" while actually showing "Kona was never used" — opposite findings with
  identical numbers.

  So `eval/analyze/trajectory.ts` reports, per Kona-arm run, whether the SKILL.md was opened and
  how many times `kona` was invoked, and gates on it: **0 adopting runs ⇒ VOID**; partial adoption
  ⇒ the adopting runs are reported separately, never averaged with the rest. A void result is a
  finding about **discoverability** — the skill's `description:` is what the model sees first —
  and not about whether the state layer helps.

- **2026-08-22 — one attempt per task, not five.** The leaderboard protocol is k=5; at k=1 a task's
  score is a single value rather than a 0–1 mean, which weakens each comparison. Accepted
  deliberately: k=5 is 60 runs and five times the money, and this is a PoC reporting a direction.
  Recorded so the write-up cannot present k=1 as though it were the published protocol.

---

## 11. Adoption — the void, and the mechanism behind it

§10 anticipated this: *"a void result is a finding about discoverability — the skill's
`description:` is what the model sees first."* That is what happened, and the mechanism turned
out to be legible in the transcripts rather than a matter of speculation.

### The result

Offered the skill and told nothing else, **neither model ever invoked `kona`.**

| run | model | mutations beyond genesis |
|---|---|---|
| `probe-kona` | `deepseek/deepseek-v4-flash` | 0 |
| `probe-kona-sonnet` | `anthropic/claude-sonnet-5` | 0 |

Both stores hold exactly one line. By the §10 gate the arm is **VOID** — not evidence that the
state layer fails to help, evidence that it was never used. **It is not a DeepSeek trait**; a
frontier model on the identical task behaved identically.

### The two models declined differently, which rules out the boring explanation

DeepSeek never opened the file. It read the `<available_skills>` block and reasoned its way out
in the response body:

> *"'Available skills kona' not necessary. … Let's consider if we need to use `/opt/kona`
> skills? Not really. The instruction says read before tasks need >5 steps; we didn't. But not
> mandatory? It says should. But final can ignore."*

Sonnet ran `cat /opt/kona/skills/kona/SKILL.md`, read all 115 lines, then immediately ran
`find /app` and never mentioned it again.

So one model declined on the description and the other declined *after full information*.
"The model did not know it was there" is dead, and the two paths need two different fixes.

### Four hypotheses, ranked by evidence

1. **Our own gating clause handed it the exit.** The `description:` opened with *"Read this
   before you start work on any task needing more than about five steps."* That asks for an
   ex-ante estimate of an ex-post quantity, at the one moment the model knows least about the
   task — and every task looks like three steps before you start it. DeepSeek quoted the clause
   back as its reason. Best-evidenced of the four, because the model stated it in words, and
   **it is our defect, not the model's.**

2. **The harness already owns the planning slot.** Terminus-2's response schema requires a
   `plan` string every turn. The agent is therefore already emitting a plan continuously, for
   free, with no tool call and no way to skip it. Kona was not competing against no-plan; it was
   competing against a mandatory plan that costs nothing. Evidenced by the same trajectory
   (*"plan as string. commands empty."*), and it plausibly explains Sonnet's decline-after-
   reading, which hypothesis 1 does not.

3. **The blank page.** Authoring a graph from zero means committing to the whole decomposition
   at the moment of least information; maintaining one is incremental. Instructed but unseeded,
   the models authored nothing; handed a five-node skeleton they extended it to twenty in a
   single commit. The cost is *starting*, not *using*.

4. **Deferred payoff under a clock.** 1800s timeout, binary reward: tokens spent on the plan are
   tokens not spent on the task, and the payoff arrives late or never. Rational discounting, not
   a failure. Weakest-evidenced here, but it predicts adoption falls as the timeout tightens,
   which is testable and currently untested.

### What changed in the skill, and what each change predicts

All three edits are to `eval/skills/kona/SKILL.md` only. The shipped plugin skills
(`plugin/skills/{plan,run}`) are **unchanged and did not need changing** — those are invoked by a
human typing `/kona:plan`, so a trigger describing when a *user* should reach for them is doing
its job. The defect is specific to the autonomous-adoption path.

| # | change | targets | predicts |
|---|---|---|---|
| 1 | `description:` no longer asks for a step-count forecast — the trigger is "before your first command", which is evaluable when read | H1 | DeepSeek-shaped declines stop |
| 2 | New §0: the response's `plan` field is per-turn scratch; make it a one-line echo of `kona next` | H2 | Sonnet-shaped declines stop — the mandatory field becomes a consumer of the graph rather than a rival |
| 3 | §1 states the first commit may be two nodes, and that §4 is the normal way the rest arrives | H3 | authoring starts without a seed |

Change 2 is the one worth watching. The competitor was not another tool — it was a field the
agent is *required* to fill in, which is a much stronger incumbent than anything we could have
been designed against. Turning it into a mirror of the graph costs nothing and removes the
duplication the model was correctly objecting to.

### Retest, declared before running it

**The instrument changed between runs, and this section is the record of it.** The §10
pre-registration governs the reward A/B and is untouched; this is a separate discoverability
question with its own prediction, stated here before the data.

- **Arm:** uninstructed (`KONA_INSTRUCTED` unset), unseeded, DeepSeek, same task as
  `probe-kona`, which is the control at 0 invocations.
- **Prediction:** ≥1 `kona mutate` reaching the store. Anything above zero falsifies "models
  will not adopt it unprompted" as a flat statement and relocates the problem to the skill text.
- **What it does not test:** whether adoption *helps*. Reward is not the read here and will not
  be reported as one.
- **Failure is informative too:** if it still comes back at zero with the exit removed, H1 and
  H2 are both wrong and H4 — the timeout economics — becomes the live explanation.

---

## 12. Sources

- **LHTB (Long-Horizon Terminal-Bench)** — [project page](https://zli12321.github.io/LHTB/) · [github.com/zli12321/LHTB](https://github.com/zli12321/LHTB) · [HF dataset](https://huggingface.co/datasets/IntelligenceLab/Long-Horizon-Terminal-Bench) · [leaderboard](https://zli12321.github.io/LHTB/leaderboard.html) · [arXiv 2607.08964](https://huggingface.co/papers/2607.08964)
- DeepSeek pricing and models — [deepseek.ai/pricing](https://deepseek.ai/pricing) · [V4-Flash agent benchmarks](https://deepseek.ai/blog/deepseek-v4-flash-ga-agent-benchmarks) · [V4-Pro-0813 benchmarks](https://www.mindstudio.ai/blog/deepseek-v4-pro-0813-benchmarks)
- DeepSWE — [arXiv 2607.07946](https://arxiv.org/pdf/2607.07946)
- Terminal-Bench 2.0 — [arXiv 2601.11868](https://arxiv.org/html/2601.11868v1) · [Snorkel leaderboard](https://snorkel.ai/leaderboard/terminal-bench-2-0/)
- Frontier-Bench / Terminal-Bench 3.0 — [frontierbench.ai](https://www.frontierbench.ai/) · [Snorkel leaderboard](https://snorkel.ai/leaderboard/frontier-bench/)
- Harbor — [docs/agents](https://www.harborframework.com/docs/agents) · [github.com/harbor-framework/harbor](https://github.com/harbor-framework/harbor)
- mini-SWE-agent — [github.com/SWE-agent/mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) · [LiteLLM integration](https://docs.litellm.ai/docs/projects/mini-swe-agent)
- HCAST — [arXiv 2503.17354](https://arxiv.org/html/2503.17354v1) · [github.com/METR/hcast-public](https://github.com/METR/hcast-public)
- METR time horizons — [metr.org/time-horizons](https://metr.org/time-horizons/) · [arXiv 2503.14499](https://arxiv.org/abs/2503.14499)
- TheAgentCompany — [arXiv 2412.14161](https://arxiv.org/pdf/2412.14161v1)
- AgentSpec (controlled scaffold composition) — [arXiv 2606.14674](https://arxiv.org/pdf/2606.14674)
- Resume Means Resume (checkpoint/interrupt/resume conformance) — [arXiv 2608.03836](https://arxiv.org/html/2608.03836v3)
