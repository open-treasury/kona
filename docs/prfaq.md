# Kona: the state layer for long-horizon agents

**A living workflow graph — Beads for state machines.**

August 22, 2026 at AGI House — Today I'm open-sourcing **Kona**. You describe a goal in plain English; the model writes the plan as a graph you can read and approve. Then you watch it work: branches sprout as the agent fans out, paths reroute when reality objects, and every change carries its reason — one click away. Kill the session; a fresh one reads the graph and continues.

Anyone who runs agents daily knows the three walls. The plan is invisible — a chat scroll and a flat todo list. The pursuit dies with the session — and resuming means re-explaining. The state lives in improvised files nobody else can read. People clearly want a fix: Beads, a mere issue tracker for agents, took 1,000 GitHub stars in six days — but tickets aren't state machines. Temporal forbids changing a running workflow by design. And the theory of self-adapting workflows existed since 2008 — it died because every change needed a human to write it. LLMs removed that bottleneck two years ago. Nobody put the two together.

In the demo, Kona organizes a hockey game: thirty players invited, eight needed, at least one goalie. It even buys its own thirty mailboxes first, ~$2 each, from its own wallet. Thirty branches sprout on screen; replies flip nodes in seconds; the only goalie bails and the plan visibly reroutes. Then I kill the session on stage, type "continue" in a fresh terminal, and it picks up from the file. Same machine runs a contractor buyout or a monthly close — that's the point.

Inside are four building blocks:

* **memory** — the graph store itself: every node, status, and "why," fully versioned;
* **plugin** — Claude Code commands that plan, execute, and dispatch fresh-context subagents against the graph;
* **viewer** — a live view where you watch the graph mutate and click into any decision;
* **short demo** — the hockey scenario with its persona agents, ready to run.

Everything is in the repo — clone it and try it on your own tasks.