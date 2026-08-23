# Kona: the state layer for long-horizon agents

**A living workflow graph — Beads for state machines.**

August 22, 2026 at AGI House — Today I'm open-sourcing **Kona**. You describe a goal in plain English; the model writes the plan as a graph you can read and approve. Then you watch it work: steps are claimed before they're worked, so a plan that goes quiet says *which step* it is quiet inside; branches sprout as the agent fans out; paths reroute when reality objects; and every change carries its reason — one click away. Kill the session; a fresh one reads the graph and continues.

Anyone who runs agents daily knows the three walls. The plan is invisible — a chat scroll and a flat todo list. The pursuit dies with the session — and resuming means re-explaining. The state lives in improvised files nobody else can read. People clearly want a fix: Beads, a mere issue tracker for agents, took 1,000 GitHub stars in six days — but tickets aren't state machines. Temporal forbids changing a running workflow by design. And the theory of self-adapting workflows existed since 2008 — it died because every change needed a human to write it. LLMs removed that bottleneck two years ago. Nobody put the two together.

**The demo is a public benchmark, not a scenario we wrote.** Terminal-Bench 3's `production-planning`: reconcile an ERP, an MES and a warehouse system into a schedule that survives twenty constraint checks — shift calendars, downtime, engineering release, lots you must not over-allocate. Four hours of expert time, authored by a manufacturing engineer. The same model runs it twice, side by side, with Kona and without.

Watch the arm that has it. Handed a five-node skeleton and nothing else, the agent read the three systems and authored its own plan against them — **fifteen more nodes and twenty-two edges in a single commit**. It claimed each step before working it, recorded every outcome with a pointer to the evidence, and then, unprompted, hit a constraint it had read wrong: it committed a `supersede_node` carrying the reason code **`CONTRADICTION`** and one sentence saying what it had corrected. That is the entire thesis — a plan changing shape as reality answers, and saying why — happening inside a benchmark container.

Then kill it. A fresh terminal reads the file and carries on; there is no session state and no snapshot to rebuild.

**And the number, stated honestly, because it is the most interesting thing here.** The benchmark scores this task **all-or-nothing**: twenty checks or zero. One measured run worked its plan to completion, wrote all three SQL deliverables, and scored **`0.0`** — while satisfying **17 of the 20 constraints**, failing only order coverage, schedule feasibility and alt-groups. A plan is not a solver, and Kona never claimed to make the answer right. What it made was the difference *visible* — which is exactly what a binary score throws away. The arm without it reached a similar place, and its state is a directory of `debug7.py` files with no record of what any of them concluded.

Inside are four building blocks:

* **memory** — the graph store itself: every node, status, and "why," fully versioned, in one append-only file. Three invariants are enforced in the store rather than advised in a prompt, and the binary never calls a model;
* **plugin** — Claude Code commands that plan, execute, and dispatch fresh-context subagents against the graph — the whole ready frontier at once, not one step at a time;
* **viewer** — a live view where you watch the graph mutate, pin any version to see exactly what it changed, and click into any decision;
* **eval** — the measurement rig: the benchmark task, both arms, and the analysis that reports per-constraint results instead of the score that hides them.

Everything is in the repo — clone it and try it on your own tasks.
