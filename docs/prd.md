# PRD: Project Kona

## 1. Meta Information
* **Status:** Approved (2026-08-21)
* **Date:** 2026-08-21
* **Owner:** Ilya Vorobiev
* **Event:** Long Horizon Agents Build Day @ AGI House
* **Version:** v5.1 — §4, §7 and §15 R3 corrected against the 200-technology prior-art review; the novelty claim is now narrower and survives a fact-check, which v3.9's "empty quadrant" did not. §7: mid-run mutation is now fully automatic — one pre-execution approval, no gates thereafter. §4: adds the one-line positioning — Beads with state machines, plus a plugin — and the determinism law behind it. §7: mid-run mutation is automatic except for introducing a new counterparty — the v3 probe found the mutator inventing people to email. §9: the fan-out now visibly diverges (Priya / Pat / Sam-referring-Marcus), which is what separates it from `withParam`. §14/§16: mailbox strategy changed from 30 agent-provisioned inboxes to one plus-addressed mailbox ($0).

## 2. What Kona Does (plain words)
We help people who delegate multi-day tasks to AI agents **see what the agent is doing and actually get the task finished** — the agent's plan becomes a live, visible file that explains itself and survives any crash.

Specific example: you tell Kona "get a hockey game together next week — invite the whole list of thirty, we need a goalie plus seven skaters." It writes a plan you can read before anything happens. Then you watch that plan work: thirty emails go out, replies land, checkmarks flip. The goalie cancels — you watch the plan reroute itself and explain why. Your laptop dies overnight; in the morning you open a fresh terminal, type "continue," and it picks up from the plan file alone. The same machine runs a contractor buyout at work.

## 3. Problem
Agents can already *do* long multi-step work. What's missing is everything around the doing:

* **You can't see the plan.** Ask Claude Code to run a buyout or organize a hockey game and it will design a decent workflow — but you never see the workflow. What is it doing? What state is it in? What comes next? Today's answer is a chat scroll and a flat todo list.
* **The pursuit dies with the session.** The construction works for a few hours, then the session hangs, compacts, or the box restarts. Resuming means re-explaining. There is no artifact that *is* the pursuit, independent of any process.
* **The plan's logic lives nowhere.** State ends up scattered across text files the agent invented ad hoc. No structure, no history, no "why." A ticket tracker (Beads, Linear) stores issues with dependencies — that's not a state machine, and multi-step real-world work *is* a state machine.

This is hackathon-sized in the demo and enterprise-sized in life: a GC buyout runs ~2 weeks of exactly this shape, a multi-entity close 6.4 days median (APQC) — same graph, bigger stakes.

**Picture of victory:** describe the goal once → review a graph of what the agent intends → watch that graph execute and *reshape itself* live as reality answers → kill any session, open a fresh one, say "continue," and it picks up from the graph alone.

## 4. Existing Options
Every property Kona claims already exists somewhere. The landscape, by quadrant:

* **Generate graphs (once, offline).** AFlow/ADAS/GPTSwarm: LLMs author and even optimize workflow *topology* — but between runs, scored against a benchmark they can re-execute. Cursor Plan Mode / Claude Code plan mode: reviewable plans before execution.
* **Constrain with graphs (human-authored, frozen).** Burr: a developer writes the machine in Python; the model walks it, never rewrites it. LangGraph: dynamic *routing* (`Command/goto`), compiled topology, checkpoints carrying state and zero structure. Temporal: mid-flight mutation *forbidden* by deterministic replay.
* **Mutate graphs at runtime — a human presses the button.** ADEPT2/AristaFlow: correctness-preserving structural change of *running* instances, with change logs carrying "change reason and change performer" — in 2008. Camunda: process instance modification, shipped, in production — and its own docs warn that an activity modifying its own instance "can cause undefined behavior." jBPM/Flowable: ad-hoc and dynamic task injection.
* **Mutate graphs at runtime — the machine does it, inside one execution.** ComfyUI's `DynamicPrompt` expands nodes at runtime with `parent_id`/`display_id` lineage, in a 128k-star project. py_trees does UUID-addressed `insert_subtree`/`prune_subtree`. Buck2's `dynamic_output` defers graph construction until artifacts can be read.
* **Remember in graphs (facts, not execution).** Zep/Graphiti: bi-temporal versioned knowledge graphs — memory of what is *true*, not of what the pursuit is *doing*.
* **Track in lists.** Beads: a CLI-mutated local store with git-synced history — agent-mutable, multi-agent, crash-resumable; the right storage pattern, the wrong semantics (issues, not state machines). TodoWrite / Manus / Devin plans: the agent updates a flat list mid-run — status flips, no topology, no rationale.

**The honest lineage:** runtime structural mutation of a running workflow was solved by adaptive BPM (ADEPT2/AristaFlow, van der Aalst's "flexibility by change") in 2005–2012 — *including versioned change logs with a rationale field* — and failed commercially because the mutator was an expert human with a BPMN editor, and change was expensive and blameful. The theory is 20 years old. The economically viable mutator — an LLM — is 2 years old.

**The one-line positioning, and it is the most useful sentence in this document.** **Kona is Beads with state machines, plus the plugin Beads never had.** Beads is a deterministic CLI holding an *issue* graph that agents drive by prompt; it is the closest prior art and the PRD concedes it already. Kona is a deterministic CLI holding an **execution** graph — waits with deadlines, irreversible effects, quorums — and it ships the agent loop as a Claude Code plugin rather than leaving it to whatever the user writes in `AGENTS.md`. **The binary contains no model at all** (`spec.md` §6.8.2); every judgment lives in the plugin. That split is what makes the store testable, crash-resume decidable, and the cost bounded by events rather than turns.

**The empty intersection.** No single property above is new. The three-way intersection is, and Kona is the only place all three hold at once:

1. **The mutator is a machine, not a human.** Rules out ADEPT2, Camunda, jBPM, Flowable, Griptape — every one is a privileged human repair tool.
2. **The timeline is irreversible and unrepeatable.** Rules out AFlow, ADAS, GPTSwarm, DSPy, STOP — all of them re-execute candidates against a score. You cannot email thirty players five times and take the mean.
3. **Waits outlive the process; resume is multi-day.** Rules out ComfyUI, py_trees, Buck2, LangGraph — all mutate inside a single execution.

And the intersection is empty for a *structural* reason, which is the strongest form of the argument: **every replay-based engine buys crash-resume by forbidding mutation.** Temporal, LittleHorse, Golem, Hatchet, Trigger.dev, Conductor and Microsoft Agent Framework all pin in-flight work to the version it started on. That unanimity is evidence the combination is genuinely unsolved, not merely unbuilt.

## 5. How Builders Do This Today
Run the honest experiment: Claude Code + Gmail MCP, "handle my buyout / organize the hockey game." It designs the workflow logic fine — logic isn't the hard part — writes the emails, invents state files, loops on the inbox. It survives a few hours, then dies with the session; you resume by hand and it mostly recovers. The real gap: **the plan is invisible, unversioned, and unreadable by anyone but the session that improvised it** — no fresh session, second agent, or human can read the pursuit and act on it. Serious builders bolt on a tracker (Beads) and a loop (Ralph): task lists persist, but the state machine of the work still lives nowhere — ticket ≠ state. And beneath it all the old economics stand: hand-authoring one workflow's logic costs $2.5–15K or engineer-weeks, per workflow.

## 6. Why It Matters
* **The plan-artifact is already the most-loved moment in agents.** TodoWrite's live checklist, Manus's side-panel tasks, Devin's plan view — the industry accidentally discovered that watching the plan update *is* the product. Then everyone stopped at a flat list. Kona gives that moment its full form: topology, branches sprouting, rationale on click, survival after death.
* **Opacity is a measured pain.** The agent-observability market exists on one complaint: "I can't see what my agent is doing." Traces show the past; a living graph shows the *intention* — and why it changed. Beads (an issue tracker for agents!) did 1,000 GitHub stars in six days; the hunger for durable agent structure is revealed preference.
* **The authorship tax is the durable economics.** Hand-building one waiting/branching workflow costs $2.5–15K (agency) or engineer-weeks (in-house), which is why companies automate three processes and staff the rest with humans. When the model authors *and revises* the workflow, marginal cost per workflow is a prompt.
* **Model progress doesn't close this gap.** Better models make the *doing* better; the plan still lives in a context window and dies with it. Persistence, visibility, and revisability are architecture, not capability — available with today's models.

## 7. Product Thesis
**Kona is the state layer for long-horizon agents — a glass-box agent: you don't read logs about what it did, you watch the plan think.**

The core artifact is a **living workflow graph** — authored by the model from a plain-language goal, human-reviewable before launch, then **mutated by the model during execution**: fan-outs sprout per-counterparty sub-flows, follow-up branches appear on silence, paths reroute when a premise breaks. Every mutation is **versioned with its rationale** — click any node, see what happened and why the graph changed. The graph *is* the plan, the state, the progress, and the memory; any fresh session reads it and continues. Waits, quorums, joins, and deadlines are just node types in it.

Four properties, one file: **authored** (model-generated from the brief, reviewable), **mutable** (topology changes mid-run, by the agent, **without asking — except to introduce a new counterparty**), **versioned** (every change carries its why; irreversible real-world actions get logs, not rollbacks), **shared** (orchestrator and fresh-context subagents read/write the same graph; it's the coordination substrate and the resurrection artifact).

**One approval at the start, and one narrow gate thereafter.** You approve the plan once, which scopes what the pursuit may do — "email up to 30 players from this roster" — exactly as `terraform plan` shows thirty resources and you approve once rather than thirty times. After that the agent reshapes the graph freely and never stops to ask, because a mutation is versioned data you can read in the viewer the instant it lands. Adaptive BPM died because change was expensive and blameful; putting a human back in the *mutation* path would re-create that, and a pursuit cannot survive an overnight crash if a modal is waiting for someone at 2am.

**The one exception, and we found it the hard way.** An empirical run of the mutator at n=60 found that when it could not satisfy a constraint, it **invented counterparties and queued real email to them** — passing every structural check, because the cheapest way to satisfy "we need one more goalie" is to add a candidate and nothing required the candidate to be real. So: **introducing a recipient the graph has never seen requires a human.** Everything else stays automatic. The plan changes freely; the world does not; and nobody new enters the world without a human.

**The sharpest claim — and the one to lead with: no system that can *rewrite its own plan* has a clock or a counterparty.** Ask any agent framework what happens when the reply arrives in three days and the process is dead. LangGraph re-runs the node, which is a multi-year family of duplicate-side-effect bugs (#2870 → #8579, still open). CrewAI's async human-in-the-loop is an open, unanswered issue. The entire LLM-workflow-generation literature — AFlow, ADAS, GPTSwarm, DSPy — has no wait, no deadline, no event-triggered branch, no counterparty at all. The entire tracing and provenance category records the past and holds nothing about the future.

**State it that precisely, because the unqualified version is false and §4 falsifies it two paragraphs earlier.** Temporal, LittleHorse, Golem, Hatchet, Trigger.dev, Conductor and Microsoft Agent Framework all have excellent durable timers — and every one of them **pins in-flight work to the version it started on.** n8n's Wait node has a four-mode resume taxonomy and a frozen topology. So the honest form is the same three-way intersection as §4: **the systems with a clock forbid mutation; the systems that mutate have no clock.** A judge who has run Temporal will catch the unqualified claim in one sentence, and it is the claim we lead with. A durable `wait(reply-from-X, deadline, timeout-branch)` on an irreversible timeline is narrower than "the agent rewrites its plan," it is the thing the demo physically shows, and it is much harder to dismiss.

Positioning, stated honestly: *we didn't invent runtime workflow mutation — adaptive BPM did, in 2008, with a rationale field in the change log, and it died because the mutator was an expert human at 3am. We replaced the mutator.* Assembled, not invented; a thing people will love to use, built in a day.

Differentiation one-liners, strongest first: **Nobody has a clock.** Every framework above dies with its process or re-runs the node; our wait survives days and resumes from the file. **Nobody has a counterparty.** The workflow-generation literature optimizes graphs against a benchmark it can re-run; ours changes shape because a real person declined. **Adaptive BPM had both the mechanism and the rationale log — and needed a human to press the button**; we replaced the mutator, which is the only reason the flexibility is now cheap enough to use. Then the rest: Burr proves people want the machine — a developer writes it and it's frozen; we make the model write and rewrite it. TodoWrite updates a list; we mutate a graph — topology, parallelism, per-decision rationale. Temporal forbids mid-flight change by construction; our durability comes from the file, so the plan stays revisable. Zep versions facts; we version the pursuit.

## 8. Goals
* **G1 — Win the room:** a demo where the audience *watches the graph think* — sprout, reroute, and survive a kill — and a judge can repeat the idea in one sentence.
* **G2 — Prove the bundle with a real artifact:** graph authored from a brief, mutated live by the agent, resumed from death — no faked screens.
* **G3 — Compound:** public repo + recorded demo same day; the "glass-box agent / living plan" essay to follow.

## 9. Demo — Hockey Night
Setup: the rival team's captain emails a challenge — "let's play in the next two weeks." Thirty players invited; minimum 8 to play — 1 goalie, 5 field, 2 subs — and goalies are scarce, so losing the one confirmed goalie is a crisis. All communication over email; by demo time the plan's first node is already green from the setup run: **the agent provisioned its own mailbox and minted a reply address per player** (`+kona-<node_id>`, so every reply routes itself back to the exact node that sent it). Counterparty agents (persona profiles: availability windows, positions, temperaments) reply **instantly** — no waiting theater; the show is the graph.

1. **Author (30s).** Brief goes in. Kona emits the plan as a graph — poll the group, collect availabilities, satisfy the typed roster (≥1 goalie!), negotiate date with the rival captain, confirm. Human reviews the graph, approves.
2. **Fan-out (45s).** Execute. Thirty emails go out and the graph *sprouts* thirty per-player sub-flows on screen — collapsed into groups, expanding on click. Every arm starts the **identical** shape: `invite → wait → {yes | no | silent}`. Replies land within seconds; nodes flip; the roster tally and goalie constraint update live. **Three arms then stop matching each other** — and this is the point of the demo, not decoration:
   * **Priya** replies *"in, but only if we start after 8pm."* Not a yes and not a no. The graph grows a **constraint node** and a branch that reaches **out of Priya's own sub-flow into the rival-captain negotiation** — one player's reply changing a different part of the plan.
   * **Pat** goes quiet. A follow-up branch appears on the deadline. **The deliberately boring arm**, kept so the other two have something to be different from.
   * **Sam** is the third — see beat 3, because his reply is what rescues the pursuit.
3. **Premise break, and the recovery that proves the claim (45s).** Dana — the only goalie — pulls out. The quorum predicate goes unsatisfiable and the graph visibly reroutes. Then **Sam's reply lands: *"I'm out, but my brother Marcus plays goalie — want me to ask him?"*** Marcus is **not on the thirty-player roster and has no node in the graph.** Kona mints one: a new counterparty, a new wait with its own deadline, wired into the goalie quorum. Click the mutation → the rationale is right there.

   **This is the beat that answers the sharpest objection.** Argo, Kestra and Windmill have all done parameterised fan-out over a pre-authored template since 2018, and thirty identical arms are indistinguishable from it. But `withParam` iterates a list fixed before the loop starts — here the list **gained a member the plan never knew about**, and that member's sub-flow has a different shape from every other. Scrub the version slider back to v1 and point at the empty space: no node, and no *template* for one. Same assertions run as an automated test — `spec.md` §7.2 *Divergent arms*.
4. **Kill & resume (30s).** Kill the session on stage. Fresh terminal: `continue`. The agent reads the graph, states where the pursuit stands, and proceeds. The graph is the resurrection artifact — the long-horizon claim, made physical.
5. **Close (30s).** Roster locked, confirmations sent, game node green. One line: "The theory is from 2008. The mutator that makes it usable shipped two years ago. We assembled them today." Scrub the version history as the outro.

## 10. Users
* **Primary (event):** judges and an audience who run agents daily and have personally suffered the opaque run and the dead session.
* **Underlying persona:** anyone delegating multi-step real-world work to an agent — developers first (it's a Claude Code plugin), operators next.

## 11. User Stories & Acceptance Criteria

**US1 — Author & review.** As a requester, I state a goal in plain English and get a reviewable workflow graph of what the agent intends.
* AC: graph generated from the brief with no task-specific template; contains typed nodes (tasks, waits, gates/joins, the goalie constraint); rendered in the viewer before execution; I explicitly approve.

**US2 — Live topology mutation.** As an observer, I watch the graph change shape as the pursuit runs.
* AC: fan-out visibly spawns per-counterparty sub-flows; ≥3 distinct topology mutations (add / reroute / prune) occur on screen during the demo; node statuses and the roster tally update live.

**US3 — Rationale on click.** As a reviewer, every change explains itself.
* AC: clicking any node shows its log; clicking any mutation shows the "why"; version history is scrubbable end to end.

**US4 — Premise-break re-plan.** As a requester, when new information invalidates the plan, the agent revises the graph rather than plowing on.
* AC: the goalie-declines event produces a visible re-plan branch with logged rationale; downstream nodes reflect the revision. Scripted into the demo rig; the signature beat.

**US5 — Kill & resume.** As a skeptic, I can kill the process and lose nothing.
* AC: session killed live; fresh session reads the graph and correctly states pursuit status and next actions in <60s; continues to completion. No session state consulted.

**US6 — Completion.** As a requester, the pursuit ends and knows it ended.
* AC: roster constraint satisfied → confirmations sent → project marked done in the graph; final state visible in viewer.

**US7 — Shared graph (stretch).** As an orchestrator, parallel fresh-context subagents work the same graph.
* AC: ≥2 subagents execute different ready nodes concurrently, each writing status/logs back to the store without corruption.

## 12. Success Metrics (Demo-Day Win Conditions)
* Graph authored from the brief live or same-day, no templates; approval step shown.
* ≥3 on-screen topology mutations including the premise-break re-plan with visible rationale.
* Kill-and-resume completes in under 60 seconds, zero crashes in the slot.
* End-to-end pursuit completes: roster locked, done state reached.
* Every spoken claim survives the concessions ledger (§15 R3); at least one judge repeats "living plan / glass-box" back.
* Repo public + demo video recorded by end of day.

## 13. Scope
**In (the four blocks):**
1. **Storage — the graph store (the core).** Holds the living graph: typed nodes (tasks; waits with event semantics — reply-from-X, deadlines, timeout branches; gates; joins), statuses, per-node logs, per-mutation rationale, and full version history. Answers agent queries (what's ready, what's waiting, where are we) and feeds the viewer. Implementation is deferred to the spec — written Friday as Block 0, not now.
2. **Plugin — Claude Code.** Commands: create project / set objective / plan / execute. An orchestrator reads the graph, dispatches ready nodes to fresh-context subagents, and merges their updates; executors do the work, log results, and propose mutations. Claude Code only.
3. **Viewer.** A live view of the graph as it executes: statuses and topology updating in near-real-time, collapse/expand for per-person sub-flows (readability is demo-critical, not polish), click any node → its log and the "why" behind each change, browsable version history.
4. **Demo rig.** Thirty player personas + a rival captain replying instantly over email; organizer side runs on Ilya's real mailbox, with a `+kona-<node_id>` reply address minted per player so every reply routes itself back to its node; the persona simulator sends from a second account; the goalie-decline premise-break is scripted; one event-injection path doubles as the live-failure fallback.

**Out:** MCP server (design-for, don't build), other coding CLIs, VS Code extension, auth/multi-user, production-grade storage, the poker/plumber scenarios (reserve bench), dormancy counters and waiting-tax staging, correctness checking beyond basic sanity.

## 14. Shaping — fitting it in 12–14 hours (Friday)
Assumptions: Ilya + 4 parallel Claude Code windows; prototype quality; Saturday reserved for demo prep, pitch, tests, and slack.

* **Block 0 — Graph schema + storage contract (0.5–1h, serial, first).** Everything depends on it; write the schema, formats, and command contract as a one-page spec — all technology choices are made there, not here — then fan out. Do not let agents improvise the schema independently.
* **Block 1 — Storage (3–4h, one window).** Create / mutate / query / version operations per the Block-0 contract. Cut-line: version browsing stays raw history, no custom diff UI.
* **Block 2 — Plugin: orchestrator + executor skills (3–4h, one window).** Loop: read → dispatch → merge. Cut-line: subagents sequential first, parallel only if US7 time allows; parallelism via Claude Code's native subtasks.
* **Block 3 — Viewer (3–4h, one window).** Live graph render, node detail panel, version browser — built on a ready-made graph-UI library chosen in the spec. +1h for collapse/expand groups — do not cut this one; an unreadable graph kills the demo. Cut-line: animations, minimap, dark-mode niceties.
* **Block 4 — Demo rig (2–3h, one window; may slip to Saturday morning).** Persona generation is a prompt; the simulator is one process + one inbox strategy (below); the goalie-decline is a scripted event injection.
* **Integration + dry run (2h, end of day, all hands).** One full pursuit end-to-end, kill-resume rehearsed twice.

Wall-clock: 0.5h schema → 4h parallel build → 2h integration → 2–3h rig → 1h dry run ≈ **10–11h**, inside 12–14 with margin. **Cut order if slipping:** version dropdown → viewer polish → 30 personas→10 → tmux theater → US7 parallelism. **Never cut:** live mutation, rationale-on-click, kill-and-resume.

**Mailbox decision — REVISED v4.1: one plus-addressed mailbox, two accounts, $0.** The correlation token goes in *Kona's own* `Reply-To` (`ilya+kona-<node_id>@gmail.com`), not in the counterparty's identity — so the fan-out needs 30 **tags on one inbox**, not 30 inboxes. Kona sends from Ilya's real Gmail; the persona simulator sends from a second ordinary Gmail with distinct `From:` display names. Two independent correlation keys come free: the plus-tag on `To:`, and `In-Reply-To` → message-id → node. Mailpit stays behind the same `MailboxProvider` port as the offline, deterministic fallback (R5). Optionally keep **one** free-tier AgentMail inbox so the "it bought its own mailbox" beat survives at $0.

*Why the change:* the prior-art review found the v3.9 assumption ($2/inbox × 30 ≈ $60) matches no published AgentMail plan — 30 falls in the dead zone between Developer (10 · $20/mo) and Startup (150 · $200/mo) — and, more seriously, that a new domain sending 30 emails in minutes is a **silent** failure mode: spam placement produces no bounce and no error, so the graph would show "sent, waiting for reply" forever. Gmail↔Gmail on two established accounts is the safest delivery path available: no new domain, no four-week reputation ramp, well inside the 500/day limit. Note the distinction that makes this safe at exactly our cast size: Gmail *send-as aliases* are capped (~30/user); *plus-addressing* is uncapped, and we need ~31 tags and zero aliases. See `docs/spec.md` §6.11.

## 15. Risks & Mitigations
* **R1 — "It's TodoWrite with extra steps."** The kill-shot dismissal. Mitigation: the three deltas must be *visceral* on screen — branching topology, rationale-on-click, resurrection. If any of the three isn't visible, the demo failed even if the code works.
* **R2 — Spaghetti graph.** Twenty sub-flows rendered naively reads as chaos, not intelligence. Mitigation: collapse/expand groups + auto-layout are in-scope, demo-critical; rehearse with the full 20 before deciding persona count.
* **R3 — Judge fact-checks novelty.** Concessions ledger pre-loaded: adaptive BPM/ADEPT2 (the mechanism *and* the rationale-carrying change log are both 2008; our mutator is the LLM — that's the axis), Burr (human-authored frozen machine), AFlow (offline generation, benchmark-scored), LangGraph (routing, not topology; checkpoints carry state and zero structure), Camunda (human operator; self-modification is "undefined behavior" by its own docs), TodoWrite/Cursor plans (list vs graph, status vs structure, log vs rationale), Temporal (forbids mutation; our durability is the file), YAWL (`rollback` hard-rejected while `compensate` ships — no-rollback is the mainstream position, not our shortcut).
  **Five more surfaced by the prior-art review, each with its answer:** *ComfyUI `DynamicPrompt`* — runtime node expansion with lineage in a 128k-star project; answer: pre-typed children inside one execution, no rationale, no waits, no human gate. *Griptape `insert_tasks`* — a genuine splice API; answer: a human-called Python method, not an agent-driven operation. *Buck2 `dynamic_output`* — deferred graph construction; answer: every artifact must be `declare_output`-ed during static analysis, and issue #432 is exactly the case it does not solve and Kona's normal case. *Agent Workflow Memory* — the closest published "history becomes procedural memory"; answer: AWM must *reconstruct* a routine from a flat trajectory, while our log already records the sub-flow as a graph fragment with the rationale that caused it. *"From Agent Traces to Trust"* (June 2026) — typed agent-provenance graphs; answer: built *after* the run to explain it; ours **is** the run.
  **Two attacks the ledger did not cover, and they are the ones a Camunda or Temporal judge actually makes.** *Reentrancy:* R3 itself quotes Camunda's "an activity which tries to modify its own process instance can cause undefined behavior" — and Kona's orchestrator mutates the graph it is executing while subagents write to it. The answer is §6.7.3: compare-and-swap on `parent_v`, one macro-step per external event, role-scoped write authority, and subagent writes scoped to status only. Camunda avoided the problem by forbidding it; we pay for it, and we should say we pay for it. *Determinism:* "you gave up deterministic replay" is true and deliberate — durability comes from the file, not from re-execution, which is the whole reason mutation is expressible at all. Concede both immediately; neither is a weakness we are hiding.
  Never claim the mechanism is new. Claim the three-way intersection (§4) and lead with the wait semantics (§7).
* **R4 — Unsound mutations.** LLM-mutated graphs can orphan nodes or deadlock. Prototype answer: minimal invariants enforced by the store (edges reference real nodes; no orphan actives); everything else is a logged judgment call. Say this proactively — it's the honest "hard problem for the product, not the prototype" line.
* **R5 — Demo-rig fragility.** Email delivery, auth, thirty personas. Materially reduced by the §14 mailbox change — no payment flow, no provisioning step, no new-domain reputation ramp, and Gmail↔Gmail between two established accounts is the safest delivery path available. Remaining mitigation: one simulator process; Mailpit as an offline fallback behind the same port; event injection as fallback for every external hop; the recap scrub must be able to carry the demo if live email dies.
* **R6 — Scope blowout.** The shaping cut-order is pre-agreed; if a block exceeds its box by >1h, cut before extending. Saturday exists for polish, not for finishing Block 1.
* **R7 — Name collisions.** "Stateflow" is MathWorks to anyone from embedded; Letta owns "sleep-time." Say "living plan," "workflow graph," "glass-box agent."

## 16. Open Questions

**Decided:** the divergence beat is written into §9 — Priya conditional, Pat silent, **Sam referring an off-roster goalie as the recovery from Dana's withdrawal** — and doubles as `spec.md` §7.2's end-to-end acceptance test; solo build (no Misha — the four-window shaping already assumes one operator); repo goes public Saturday **before** the demo (the "it's already open source" line is part of the pitch); cast = 30 players + rival captain; **mailboxes = one plus-addressed Gmail for Kona + one for the persona simulator, $0, Mailpit as the offline fallback (§14).** The AgentMail wallet/paid-provisioning smoke test is no longer on the critical path.