# PRD: The Activity Model — a UML Activity Diagram subset

## 1. Meta Information

- **Status:** Approved (2026-08-27)
- **Date:** 2026-08-27
- **Owner:** Ilya Vorobiev
- **Spec delta:** [`spec-delta-activity-model.md`](./spec-delta-activity-model.md) — the approved implementation-level change record, now incorporated into `spec.md`.
- **Normative contract:** [`spec.md`](./spec.md), schema v6. [`prd.md`](./prd.md) keeps the product thesis; this document records why the notation changed.
- **Version:** v2 — audited against the code on 2026-08-27 across six surfaces (viewer model, viewer rendering, plugin skills, plugin runtime, eval rig, CLI) plus three cross-cutting critics. v1 costed `core` and priced everything else as a rename; the audit found two contradictions **inside v1**, one contradiction with a documented NEVER-CUT decision in `branch.ts`, and four surfaces that could not start because v1 left a required answer blank. §2.1 records the eight decisions that closes; §9–§13 replace the two thin paragraphs v1 gave the viewer and the plugin; §14 is new and is the part that actually governs the schedule.

> Historical baseline: implementation observations phrased as "today" or "currently" below refer to the pre-v6 tree audited on 2026-08-27. They are migration evidence, not current authoring instructions.

## 2. What changes, in one paragraph

Kona's graph stops inventing its own control-flow notation and adopts a **subset of UML Activity Diagrams**: an initial node, two final nodes, actions, accept-event actions, decisions, merges, forks and joins. Branching and concurrency stop being _fields on the nodes that consume them_ and become **nodes you can point at**. The orchestrator gets a word for "these run at the same time" that it did not previously have, the viewer gets a notation its audience already reads, and two classes of malformed graph — the orphan and the dead end — become decidable rather than a matter of judgment.

## 2.1 Eight decisions this draft makes

v1 left these blank or got them wrong, and four surfaces reported being unable to start without them. Each is a decision, not a recommendation — overrule any of them and the sections downstream change.

| #       | Decision                                                                                                                                                                                                                                           | Why, and what it unblocks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1**  | **Routing is derived once, at commit — never in the fold.** A commit that resolves a decision, kills an arm, or satisfies a join appends the resulting `set_status` ops to the batch before it is written, exactly as the drop cascade does today. | v1 §5 said control nodes are "resolved by the fold." `branch.ts:1-18` marks the opposite a **NEVER CUT** design decision, and states the reason: `fold` replays every record through `applyOps`, so a cascade living there re-runs on every read forever using _today's_ code — change the rule next month and every historical log folds to a graph the human never approved, with the log unchanged, so nothing looks wrong. The product claim was never "the fold computes it"; it is **no model in the loop**. Deriving at commit keeps that and keeps history honest. It also hands the viewer the reachability verdict as recorded data instead of forcing it to re-implement the cascade — which `seam.test.ts` forbids. |
| **D2**  | **An `accept_event` is polled, never claimed.** It does not appear in `kona next`, is never dispatched to an executor, and `kona brief` refuses it.                                                                                                | v1 contradicted itself: §5's table said it appears in `next` and is claimable, §6 said "ready to be POLLED, never to be worked," §10 promised the executor is only ever handed an `action`. Worse, the hole is live today — `graph.ts:279` `isReady` has no type test and `run/SKILL.md` dispatches everything `next` returns — and claiming a wait **silently disarms it**, because `deadline.ts:92` `armedWaits` requires `state === "active"`. The deadline then never fires. v1 as written preserved that bug; D2 kills it.                                                                                                                                                                                                 |
| **D3**  | **`spec.on_timeout` is deleted.** A blown deadline is `record_outcome(verdict:"timed_out")` on the accept-event, and the `timeout`-guarded out-edge of the decision it feeds carries the route.                                                    | One route, one representation. v1 kept both and left the collision unsettled, blocking five surfaces. Its `kona resume` authored `add_edge(wait → escape, condition:{on:"timeout"})` at `resume.ts:126` — a single op that violated S4, S5 and the 1/1 arity simultaneously. Under D3 `timeoutRepair` collapses to two ops that were already legal, and `resume` stops mutating topology at all.                                                                                                                                                                                                                                                                                                                                |
| **D4**  | **Guard spelling is fixed** (§8): `{"guard": {"on": "accept"}}`, the count form `{"guard": {"count": {…}, "op": ">=", "n": 1}}`, and `else` as the bare string `{"guard": "else"}`.                                                                | Blocked the most surfaces of anything in v1. `else` has to be _written_, not implied by absence — an absent guard is an S5 violation, and the two must not be the same bytes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **D5**  | **Structural rules are evaluated over the LIVE subgraph** — nodes not superseded, and edges whose endpoints are both live.                                                                                                                         | Without this the product thesis is impossible. S2 says every node reaches a final; an action is 1-in/1-out; there is no edge-removal op and there never will be. So extending a branch that already terminates would need an eighth op. Under D5 the recipe is: supersede the terminator, add the work, add a new terminator — the dead edge stops counting the moment its endpoint is superseded. One extra op, no new verb, and the log keeps the record that this branch used to end here.                                                                                                                                                                                                                                   |
| **D6**  | **`Node` is a discriminated union on `type` in `core`**, so a control node has no `status` field to write rather than an empty one to ignore.                                                                                                      | Makes a whole class of bug a compile error in all three packages. It also _replaces_ v1's success criterion 3 — a property test asserting "no control node ever acquires a status" is only necessary in the representation where that is expressible, so keeping the test would be evidence we chose the weak one.                                                                                                                                                                                                                                                                                                                                                                                                              |
| **D7**  | **Invariant 2's predicate population traverses through control nodes** to the behaviour nodes underneath.                                                                                                                                          | v1 §7 claimed the three invariants were unchanged. False: `validate.ts:489` defines the population as `inEdges(wait.id)` and `:500` reads `member.status.state`. Under 1/1 arity plus S7 that population is one control node with no status — a `TypeError` inside `validate()`, and `bin.ts` has no top-level catch, so `kona mutate` dies with a stack trace instead of a §6.8 refusal line.                                                                                                                                                                                                                                                                                                                                  |
| **D10** | **The status vocabulary becomes BPMN 2.0's Activity Lifecycle, seven states: `inactive · ready · active · completed · failed · withdrawn · terminated`.** _(Approved 2026-08-27.)_                                                                 | The old five conflated three distinct facts. **(a)** old `active` meant both _the graph has not reached this yet_ and _this is available right now_. **(b)** BPMN's `Active` means _being worked_, which was `in_flight`. **(c)** `dropped` combined BPMN's `Withdrawn` and `Terminated`. `ready` and `withdrawn` are derived by the store at commit and written as ops, so readers query recorded state rather than recomputing readiness. Full lifecycle, transitions, authority split and migration hazards are in spec delta §6.2.1.                                                                                                                                                                                        |
| **D9**  | **The noun becomes `node` everywhere** — `add_node` / `supersede_node`, the wire keys, and the prose in the README, both skills and the executor. _(Approved 2026-08-27.)_                                                                         | UML reserves "Activity" for the whole diagram; the boxes are nodes. It also makes the half-renamed `NodeStatus` / `NodeCondition` / `ParsedNodeSpec` / `refineNode` in `core` correct rather than stale. Cost: the third rename of this noun in a week, landing in the same commit as the wire format (§8).                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **D8**  | **Control nodes may carry an optional `name`**, and `named()` falls back to `'<type>' (<id>)` when absent.                                                                                                                                         | A decision usually deserves a sentence — _"Did Dana accept?"_ — and the viewer, every refusal message and the timeline all need something to print that is not a bare hash.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## 3. Problem — pre-v6 control flow had no address

Before schema v6, a Kona graph had two node types (`task`, `wait`) and one edge kind. Everything else about how work flowed was encoded in **fields**:

- **Branching** lives in `condition.on` on an edge, plus the rule that _every_ out-edge of a `wait` must carry one (§6.2). The branch point itself does not exist as an object.
- **Joining** lives in `merge: "all" | "any"` on the node being joined into (§6.2).
- **Branch death** lives in a transitive drop cascade the store runs when a wait resolves (§6.4), because there is nothing for a dead branch to terminate _at_.
- **Concurrency lives nowhere at all.** Two out-edges from one node might be alternatives or might be parallel work; the topology does not say, and the orchestrator dispatching subagents has to guess.
- **Start and end live nowhere either.** A pursuit begins at "the nodes with no in-edges" and finishes when "the frontier is empty." Both are computed, neither is drawn, and neither can carry a rationale.

Five consequences, in descending order of how much they cost:

1. **`merge: all|any` is two different operators wearing one field, and a model picks between them.** On a set of _parallel_ branches, `any` silently discards the other arms' results. On a set of _alternative_ branches, `all` deadlocks forever. UML separates these into Join and Merge precisely because they are not the same operator, and the failure mode of confusing them is invisible in both directions.
2. **You cannot cite the decision.** Rationale attaches to a commit and status attaches to a node; a branch point is neither, so "why did it go this way" has no object to hang on and no id to reference. The mutation timeline — §6.10 rule 5, _the_ differentiator panel — cannot show a routing decision as a thing that happened.
3. **The store does subtle housekeeping to compensate.** §6.4's cascade — drop the untaken targets, transitively, stop at a live in-edge, exclude dropped sources from merge evaluation, route a zero-live merge to `on_timeout` — is four interacting rules whose entire job is to simulate terminators that do not exist.
4. **Orphans and dead ends are undecidable.** [`prd.md`](./prd.md) §15 R4 concedes this: "LLM-mutated graphs can orphan nodes or deadlock. Prototype answer: minimal invariants… everything else is a logged judgment call." Without an initial node there is no definition of _reachable_, and without a final node there is no definition of _terminating_.
5. **The model writes chains, because chains are all we can show it.** Commit `aa69624` — _"every example we showed the model was a chain, so it wrote a chain."_ The plan skill has no vocabulary for concurrency to put in an example, so its examples are sequential, so the authored plans are sequential.

And one naming debt: commit `7b1283c` renamed the nodes to "nodes" on the grounds that UML calls them that. It does not. In UML an **Activity** is the whole diagram; the boxes inside it are **ActivityNodes**, and the ones that do work are **Actions**. The half-finished rename is still visible in `core` — `NodeStatus`, `NodeCondition`, `ParsedNodeSpec`, `refineNode` — and this redesign makes those names correct again instead of stale.

## 4. The subset

Nine node types. The pursuit's graph **is** the Activity; these are its nodes.

| UML               | `type`         | Glyph                             | Arity (in / out)     | Does work?          | Resolved by       |
| ----------------- | -------------- | --------------------------------- | -------------------- | ------------------- | ----------------- |
| InitialNode       | `initial`      | ●                                 | 0 / 1                | no                  | store at commit   |
| Action            | `action`       | rounded box                       | 1 / 1                | **yes — an agent**  | an executor       |
| AcceptEventAction | `accept_event` | concave pentagon, hourglass badge | 1 / 1                | **yes — the world** | `poll` / `resume` |
| DecisionNode      | `decision`     | ◇                                 | 1 / n≥2, all guarded | no                  | store at commit   |
| MergeNode         | `merge`        | ◇                                 | n≥2 / 1              | no                  | store at commit   |
| ForkNode          | `fork`         | ▮ bar                             | 1 / n≥2              | no                  | store at commit   |
| JoinNode          | `join`         | ▮ bar                             | n≥2 / 1              | no                  | store at commit   |
| ActivityFinalNode | `final`        | ◎                                 | n≥1 / 0              | no                  | store at commit   |
| FlowFinalNode     | `flow_final`   | ⊗                                 | n≥1 / 0              | no                  | store at commit   |

**`accept_event` is the one addition to plain UML control flow, and it is not an invention** — AcceptEventAction is UML's own name for "block until an event arrives," which is exactly Kona's `wait`. It keeps every rule §6.5 gives it: a `match` of kind `event | human | predicate`, a mandatory `deadline`, a timeout route (now carried by a decision guard rather than `on_timeout` — D3), a correlation address derived from its own id, a cursor, and first-match-wins deduplication.

**Its glyph is a concave pentagon** — a rectangle with a notch cut into the incoming edge, the receiving counterpart to SendSignalAction's convex point. The **hourglass** is a different node in UML: AcceptTimeEventAction, "wait until a time." A Kona accept-event is always _both_, because §6.2 makes a `deadline` mandatory and routes timeout through the explicit `timeout` guard on the following decision. So the viewer draws the pentagon as the node and an hourglass as its deadline badge, and the hourglass is the glyph on that guard. One node, because Kona's or-group resolves reply-or-deadline first-match-wins (§6.5); two glyphs, because two things can end it.

**Why a type and not `action` with a tag in its spec.** Half-conceded: in the UML metamodel an AcceptEventAction _is_ an Action — ActivityNode → ExecutableNode → Action → AcceptEventAction — so the pedantic reading is that this is a discriminated Action, not a sibling of one. The disagreement is therefore small: both designs put a tag on the node, and the only question is which field carries it. It goes in `type` for three reasons, and the third is the general rule:

1. **`type` is where every consumer already looks.** zod's `discriminatedUnion` needs a top-level literal key to give a useful rejection; a nested `spec.match !== undefined` is a refinement, and refinements report worse errors at exactly the boundary §6.7 says must be free and first.
2. **The two share little execution behavior.** An `accept_event` requires `match` and `deadline`; an action does not. Both carry the behaviour-node base fields, but only an action is resolved by an executor, claimable, returned by `kona next`, or accepted by `kona brief`. An accept-event is resolved by `kona poll` or `kona resume`. `kona brief` has to look _forward_ from a send to the accept-event behind it and fail closed on more than one (§6.5) — a type test, not a field probe.
3. **The rule this follows, which also says where variation should _not_ become a type:** a **type** when the required fields and the legal ops differ; a **spec field** when only the evaluation differs. That is why a wait's three match kinds — `event | human | predicate` — stay a spec field and do _not_ become three node types: they share the deadline, the timeout route, the correlation, the cursor and the poll path, and differ only in what counts as a match. Same rule, opposite answer, and it is the reason the vocabulary stops at nine instead of drifting upward.

**Two final nodes, because a fan-out needs its branches to die without killing the pursuit.** `flow_final` terminates one path — _Dana declined; this arm is over_ — and is the single most common terminator in a real graph. `final` terminates the pursuit. With only one of them, a declined counterparty either ends the run or leaves a dangling arm that nothing can distinguish from unfinished work.

## 5. The central rule — two families, and only one of them is work

> **Behaviour nodes are worked by an agent. Control nodes are resolved by the store, at commit, with no model in the loop.**

|                                                | Behaviour nodes (`action`, `accept_event`)                       | Control nodes (the other seven)                        |
| ---------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------ |
| `status.state`                                 | yes                                                              | **none**                                               |
| `status.outcome` / `output` / `effect_log`     | yes                                                              | **none**                                               |
| `effect_class`, `deadline`, `inputs`/`outputs` | yes                                                              | **none**                                               |
| Appears in `kona next`                         | `action` only (D2)                                               | **never**                                              |
| Claimable by a subagent                        | `action` only (D2)                                               | **never**                                              |
| Accepted by `kona brief`                       | `action` only (D2)                                               | **never — refused**                                    |
| How it advances                                | an executor records evidence · a wait is resolved by `kona poll` | the store derives it at commit and writes the ops (D1) |

This is what keeps §6.8's law intact — _the binary contains no model_ — while making the graph much more expressive. A control node has no judgment in it: a Decision's guard reads recorded verdicts, a Join counts satisfied in-edges, a Fork satisfies all of its out-edges at once.

**But it is derived at commit, not at fold (D1).** The distinction is not pedantic and `branch.ts` already paid for the lesson: a derivation that lives in the fold re-runs on every read forever, using whatever the code says _today_, so changing the routing rule next month would silently re-fold every historical log into a graph nobody approved. The store decides once, appends the resulting `set_status` ops to the batch, and the log records the decision — exactly as it already does for id minting and the withdrawal cascade. Readiness uses the same mechanism: derived at commit, written as explicit ops, and queried from recorded state.

It also means **the node count grows but the work count does not**. A fan-out to three counterparties adds a fork, a join and three flow-finals; none of them is ever dispatched, claimed, briefed, or paid for. Measured on the one real Kona-arm graph the eval rig has produced, the same work goes from 20 nodes / 26 edges to 33 / 39 — **+65% nodes, +50% edges, +0% work**. §12 says what that does to the rig's metrics.

## 6. Flow semantics

UML is defined by token flow; Kona's graph is a fold over an append-only log. The reconciliation is that **reachability replaces tokens**, evaluated over the folded graph:

- **`initial`** — its out-edge is satisfied from the first commit. Exactly one per Activity.
- **`action`** — ready iff its single in-edge is satisfied. Only terminal-success (`completed`) satisfies its out-edge; `failed`, `withdrawn`, and `terminated` do not.
- **`accept_event`** — resolved by `kona poll` or `kona resume`, never worked and never claimed (D2). It satisfies its out-edge on any resolution, and that out-edge must target a `decision` (§7), so the resolution is always routed by a visible guard rather than clearing a plain edge. A blown deadline is a `timed_out` outcome routed by the decision's `timeout` guard — there is no `on_timeout` field any more (D3).
- **`decision`** — evaluates guards in edge order; **exactly one out-edge fires**; the others become unreachable. An `else` edge is mandatory, so a decision can never fail to route.
- **`merge`** — satisfied by the **first** satisfied in-edge. It does not wait, and it never merges data.
- **`fork`** — satisfies **all** out-edges at once. This is the only construct that creates concurrency, and `kona next` reports the fork id alongside each of its arms so the orchestrator dispatches them as a set instead of inferring parallelism from shape.
- **`join`** — satisfied when **all reachable** in-edges are satisfied.
- **`final` / `flow_final`** — absorb. `flow_final` ends its path; `final` marks the pursuit complete, which is the first time completion has been a recorded fact rather than an empty frontier.

**Unreachability propagates, and it fails safe.** §6.4's four cascade rules survive intact, restated against terminators that now exist: an unreachable in-edge is _excluded_ from a Join rather than blocking it; a Merge or Join whose in-edges are all unreachable is itself unreachable; unreachability flows downstream and stops at any node still held by a reachable in-edge — a shared descendant survives. And readiness does not inherit the exclusion: **an unreachable predecessor never satisfies readiness**, or the second node on an untaken branch lands on the frontier and gets dispatched, irreversible send included. That last sentence is the one bug this rule exists to prevent, and it is unchanged from §6.4.

**Structure is judged over the live subgraph (D5), which is what makes the graph growable.** A superseded node, and any edge with a superseded endpoint, is invisible to the arity rules and to S1–S7. So extending a branch that already terminates is: supersede its `flow_final`, add the new work, add a new terminator — three ops, no new verb, and the log still records that the branch used to end there. Without this rule S2 plus 1/1 arity plus the permanent absence of an edge-removal op would make incremental growth impossible, which would delete the product thesis in the name of tidiness.

**The subset is acyclic.** UML permits a decision to route backwards; Kona does not, and will reject a cycle at commit. Iteration is not expressed by looping — it is expressed by the orchestrator **adding nodes**, which is the entire product. _We do not loop; we grow._ Retry-until-success is therefore a graph that gets longer, with a rationale on every extension, and that is the correct record of what actually happened.

## 7. Structure becomes shape — validation rules that used to be prose

The parser runs first and free (§6.7), and gains the arity table in §4 verbatim, plus:

| #   | Rule                                                                  | What it replaces                                                                                                                                |
| --- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Exactly one `initial`; every node reachable from it                   | R4's "no orphan actives", previously a judgment call                                                                                            |
| S2  | Every node reaches a `final` or `flow_final`                          | nothing — dead ends were undetectable                                                                                                           |
| S3  | Every out-edge of a `decision` carries a guard; exactly one is `else` | "the store fires the out-edge whose condition matches"                                                                                          |
| S4  | An `accept_event`'s single out-edge targets a `decision`              | _"every out-edge of a `wait` must carry a condition — otherwise an ignored or timed-out wait clears a plain edge and a pivot fires unapproved"_ |
| S5  | Guards appear **only** on out-edges of a `decision`                   | `condition?` on any edge                                                                                                                        |
| S6  | No cycles                                                             | nothing — implicit in the DAG fold                                                                                                              |
| S7  | An `action` has exactly one in-edge                                   | `merge: all \| any`                                                                                                                             |

S4 is the important one: **the safety rule that most directly prevents an unapproved pivot stops being a rule and becomes a shape.** A wait cannot be wired to fire something directly, because the schema does not let it have any out-edge that is not a decision. S7 is the same trick applied to joining — a node cannot silently join, because it cannot have two in-edges.

**All seven are evaluated over the live subgraph (D5)** — superseded nodes and edges with a superseded endpoint do not count — and **all seven are checked at commit, against post-commit state.** S1 and S2 are whole-graph properties and every commit here is incremental, so this is a real constraint on the author, not a formality: a batch that adds a step must also terminate it. That is one extra op, and it is the price of dead ends being detectable at all. `--steps` supplies the terminator automatically (§11).

**Guard grammar is closed.** A guard reads `outcome.verdict`, `outcome.attrs`, or the existing predicate count form. `EDGE_CONDITIONS` keeps its seven values as the verdict projections a guard may test, and §8 pins the JSON.

**The three invariants of §6.7 survive, but invariant 2 does not survive untouched (D7).** Terminal-and-effect protection and the effect budget carry over unchanged and now apply only to behaviour nodes. Invariant 2 — predicate-waits stay satisfiable — is defined at `validate.ts:489` with the population `inEdges(wait.id)`, and then reads `member.status.state` at `:500`. Under 1/1 arity plus S7 that population is a single control node with no status: a `TypeError` inside `validate()`, and `bin.ts` has no top-level catch, so the operator gets a bun stack trace instead of a §6.8 refusal line. The population must **traverse through** control nodes to the behaviour nodes beneath, counting a merge disjunctively and a join conjunctively. Same for the viewer's `predicateCount`, which has the identical definition and the same bug.

## 8. Schema and ops

**Still six ops. There is no seventh, and none is added here.** They are renamed to match the corrected vocabulary:

```
add_node(spec)                                         -> $id     // any of the nine types
add_edge(from, to, {guard?})                                      // guard only from a decision
set_status(node, status, evidence_ref)                            // behaviour nodes only
record_outcome(node, verdict, evidence_ref, attrs?)               // behaviour nodes only
record_output(node, output_name, value_or_ref, evidence_ref)      // action only
supersede_node(node, by?)                                         // never delete
```

Deleted from the vocabulary: **`MERGE_MODES`** entirely, and **`spec.on_timeout`** (D3). `merge: "all"` is now a Join, `merge: "any"` is now a Merge, and the case that used to be ambiguous is now two different nodes with two different glyphs.

**The guard, spelled once (D4).** `edge.condition` becomes `edge.guard`, and it takes exactly three forms:

```jsonc
{"op":"add_edge", "from":"kona-9x2t", "to":"kona-4f2a", "guard": {"on":"accept"}}
{"op":"add_edge", "from":"kona-9x2t", "to":"kona-1kd8", "guard": {"count":{"verdict":"confirmed","attrs":{"role":"goalie"}}, "op":">=", "n":1}}
{"op":"add_edge", "from":"kona-9x2t", "to":"kona-7bd0", "guard": "else"}
```

`else` is **written**, never implied by absence — an absent guard on a decision's out-edge is an S5 refusal, and the two must not be the same bytes.

**The wire rename is one decision applied in nine places, and it has to happen in one commit.** `activities` (in `kona graph` and `kona next`), `activity_id` (poll's `WaitAddress` and `InboundMatch`, resume's `waits` and `unknown_sends`), the `activity` key on four op payloads, and `edges[].condition`. `packages/viewer/test/contract.test.ts` is the mechanised consumer contract for exactly this and asserts a byte-for-byte projection, so it moves in the same commit or the gate is red.

Batch semantics, `$0`/`$1` intra-batch references, the ban on auto-wiring, and the rule that a fan-out is one atomic commit all carry over unchanged. A fan-out commit now reads: one fork, N actions, N flow-finals or one join, and the edges — still one commit, still one rationale.

```
       ┌──▶ [Ask Dana]  ──▶ (Dana replies) ──▶ ◇──accept──▶ ▮
   ● ─▶▮───▶ [Ask Pat]   ──▶ (Pat replies)  ──▶ ◇──accept──▶ ▮ ──▶ [Lock roster] ──▶ ◎
       └──▶ [Ask Sam]   ──▶ (Sam replies)  ──▶ ◇──accept──▶ ▮
                                                └──else───▶ ⊗
```

The `else` arms terminating at `⊗` are the declines. Under today's model they are a drop cascade with no picture.

## 9. Core — the package that blocks everything, and that nobody costed

`packages/core` carries **100% of the blocking work** and every other surface's estimate is explicitly conditioned on it landing first. Its exposure: 3,806 source lines, 5,712 test lines, **651 of the repo's 1,291 tests**, and `test/fixtures.ts` is imported by 17 of its 20 test files.

| Area          | What changes                                                                                                                                                                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vocab.ts`    | `ACTIVITY_TYPES` → nine `NODE_TYPES` in two families; `MERGE_MODES` deleted; `OP_KINDS` renamed twice                                                                                                                                                                                                 |
| `schema.ts`   | `Node` becomes a discriminated union on `type` (D6); per-type required-field sets; `condition` → `guard` with three forms; `on_timeout` removed                                                                                                                                                       |
| `graph.ts`    | `isReady` and `isEdgeSatisfied` must **satisfy across a control node**. Today `satisfiesBlockingEdge` is a bare `status.state === "done"`; under S7 an action's single in-edge comes from `initial`, so on day one every v2 graph either returns an empty frontier or throws on an undefined `status` |
| `branch.ts`   | The cascade generalises from "untaken wait out-edges" to decision routing and unreachability propagation — still at commit, still emitting explicit ops (D1)                                                                                                                                          |
| `validate.ts` | S1–S7 as named refusals; invariant 2's population traverses control nodes (D7); 731 lines today, `invariants.test.ts` is 1,146                                                                                                                                                                        |
| `resume.ts`   | `timeoutRepair` collapses to `record_outcome(timed_out)` + `set_status(completed)`; it stops mutating topology entirely (D3)                                                                                                                                                                          |
| `brief.ts`    | `awaitingWaits` becomes a forward walk **through** control nodes to the first behaviour node on each path, still failing closed on more than one                                                                                                                                                      |
| `deadline.ts` | `armedWaits`' `state === "active"` test stops being a disarm hazard once D2 removes waits from the claimable set                                                                                                                                                                                      |
| New exports   | reachability, the fired guard, fork-region membership — each must land **with a consumer in the same commit**, because `knip.json` sets `includeEntryExports: true` and `bun run check` goes red on an unused export                                                                                  |

**One thing to watch that has bitten this repo before.** S1, S6 and S7 make several existing defensive branches unreachable — `armDead`'s cycle guard at `graph.ts:238`, `isReady`'s empty-in-edge root case at `:285` — and mutants in unreachable code always survive. The `core` tier's break threshold is 90 and it closed at 90.84 (`kona-o2i`). Deleting the newly-dead branches is part of the work, not cleanup afterwards.

## 10. Viewer

v1 called this "the largest and the cheapest" gain. The first half is right and the second is wrong: **it is the largest single surface in the redesign**, at 5–7 days for rendering and 3–5 for the model layer, and it cannot start until core lands and the fixture regenerates.

The reason is that three separate uniformity assumptions all break at once, and a fourth thing appears that v1 never mentioned:

- **One renderer.** `Canvas.tsx:95` forces every node through `nodeTypes = { kona: ActivityCard }`. Needs three: an action card, an accept-event card with the pentagon silhouette and hourglass badge, and a `ControlGlyph` for the seven.
- **One size table with two entries.** `ACTIVITY_SIZE` (`dagre.ts:67`) becomes nine, including the open question of **how long a fork/join bar is** in `rankdir: LR` — a bar is a narrow vertical rule whose length should scale with its arm count, which no current layout code contemplates.
- **One handle geometry.** `edgeHandles` returns one target at x=0 and one source at x=width, both centred — the geometry commit `426cb50` declares ahead of measurement so edges can draw at all. A bar needs _n_ distributed, addressable handles; a pentagon needs its target offset past the notch; a circle needs a single centred pair.
- **The synthetic markers become duplicate notation.** `MarkerNode.tsx`, `START_MARKER_ID` / `END_MARKER_ID` and `flowTerminals` (`edges.ts:188-243`) exist for one reason, stated in their own doc comment: Kona has no initial or final node, so `end` means "nothing depends on this at this version." Real `initial` and `final` nodes make them a second bullseye on the canvas. They come out, along with `ActivityView.isStart`/`isEnd`.

**Three derivations the fold does not hand over, and v1 budgeted none of them:**

1. **Blocked reasons that stay legible.** `blockedReason` reports one cause per unsatisfied in-edge. Under S7 the immediate blocker of a blocked action is almost always a merge or a join — a node with no name, no status and no story. The viewer has to walk back **through** control nodes to the behaviour node a reader can act on. `blocked.ts:72` also hard-codes conjunctive unreachability (`causes.some(isPermanent)`) and justifies it in a comment claiming _"`spec.merge` does exist in the schema — but grep `core` for it: nothing reads it, `isReady` least of all."_

   **That comment is false, and the bug it licenses is live today.** `graph.ts:296` reads `activity.spec.merge === "any"` and switches `live.some(...)` against `live.every(...)`. So for an `any` node the viewer marks the whole node unreachable as soon as _one_ in-edge dies, when it should require all of them — it paints a perfectly live merge as "can never happen". Worth fixing before the redesign rather than porting; under v2 it is the `merge` node's entire semantics.

2. **Predicate population through a merge or join** — the same traversal as D7, needed twice, in two packages, and it must skip control nodes without counting them as answers still to come.
3. **The routing row in the timeline.** The promise above — _decision `kona-4f2a` took `else`, because Dana's verdict was `declined`_ — is buildable only because D1 writes routing as ops. Under v1's fold-time story it was unbuildable: `buildTimeline` maps `record.ops` to rows, and there would have been no op.

Everything else in §6.10 survives: rules 1, 3, 6, 7, 9 and 10 untouched, rule 8's three wait colours become the hourglass's three colours. Two corrections to v1: **rule 2's memo does not come free** — `dagre.ts:110` also encodes `edge.condition?.on`, which is `undefined` for every guarded edge after the rename, so a rewired decision would hand back a cached layout under a changed label; and **success criterion 7's fork…join collapse has zero existing code** — §6.10 rule 3 was never implemented, the only trace is an aspirational comment at `Canvas.tsx:255`, and the region boundary is undefined while §18 Q2 declines to require a fork to have a matching join. Budget it as a feature (2–3 days), not a polish item, or cut it explicitly.

## 11. Plugin

Small in code, large in contract — and the code is smaller than v1 implied while the contract is much larger.

**Zero cost:** `plugin/hooks/`, `plugin/bin/`, `plugin/scripts/` and `plugin.json` parse no graph JSON and name no node type. `session-start.sh` echoes `kona resume --dry-run` verbatim.

**The executor (3–5 hours):** a noun rename, two regenerated op examples with real `<prefix>-<hash>` ids, one new paragraph stating that seven of nine types are never dispatched and an `accept_event` is resolved by `kona poll` (D2), and a bound on the exit-3 retry loop, which today tells the executor to re-read and re-commit with no limit.

**The two skills (2 days, and they are pedagogy, not find-and-replace):**

- `plan/SKILL.md` contains **zero multi-op arrays** — verified by grep. Commits `aa69624` and `b6574cf` both fixed `eval/skills/kona/SKILL.md`, so the _plugin_ path never received the fan-out exemplar this PRD's §3 cites as the previous attempt. The fork/join exemplar has to be the first full example in the file, not §5's afterthought.
- Its §1 `spec` block lists every field with REQUIRED/optional comments, which under two families is actively misleading — it tells the model `instruction` and `effect_class` are required, on a node type that has neither. It becomes a per-type field matrix.
- `"B REQUIRES A"` and the _"say 'Y needs X' out loud"_ trick are the file's most carefully tuned paragraphs and are now wrong at exactly one place: an in-edge to a `merge` is a disjunct, not a requirement.
- New rules with no text today: fork-vs-sequence, when a decision is required, **terminate every branch**, and a refusal-repair table for S1–S7.
- `run/SKILL.md` needs the fork-set dispatch paragraph, a join-barrier stop condition, and a rewritten §5 — its "fan out, reroute, add a follow-up, obviate a branch" recipes each need a v2 shape, and the growth recipe is D5's supersede-the-terminator move.

**Two facts that constrain the schedule.** `packages/kona/test/plugin-catalogue.test.ts` asserts the ops documented in the skills equal `OP_KINDS` exactly, runs every JSON example through the real `parseBatch`, **and pins literal prose strings** — including a two-line blockquote in `run/SKILL.md:177-178` that fails if reflowed by one word. So the plugin prose is a hard co-requisite of the op rename, in the same commit. And measured: the same three-way fan-out goes from 14 ops / 2,379 bytes to 41 ops / 3,628 bytes. R1 and R2 both route their mitigation through `kona mutate --steps` — a flag `plan/SKILL.md` mentions **zero times**.

## 12. The evaluation rig

The rig touches structure in four places and only two are code.

- **It authors** structure in `eval/skills/kona/seed.json` and `eval/skills/kona/SKILL.md`. Every op there is refused by a v2 store, and the seed's failure mode is a hard `RuntimeError` at container setup that **voids the whole arm** — so `eval/run/00-preflight.sh` gains a seed-validation step that fails fast and cheap.
- **It renders** structure in `eval/report/pursuit-versions.html`, which has hand-baked data and **no generator anywhere in the repo**. §14's "fixtures and the rig regenerate from their generators" is false for this file.
- **It scores** nothing over structure — `analyze/paired.ts` reads Harbor rewards and CTRF only. The primary read and the pre-registered go/no-go bar survive untouched, which is the best news in this document.
- **It asserts** nothing over structure either — which means R1's "watch it in the eval rig" and success criterion 8 both currently have **no instrument**. `eval/analyze/shape.ts` has to be built: it reads the `mutations.jsonl` artifact all three run scripts already collect and nothing reads, and reports nodes by family, edges, topology ops and max fan width per run. It needs only the type _names_, so it is the one item that can start on day one.

**The metrics become non-comparable and the pre-registration has to say so.** +65% nodes and +50% edges for identical work means every node-count comparison against a pre-break run is meaningless, and the SKILL text change invalidates all three recorded zero-adoption results. `docs/eval.md` §10 gets a dated amendment in the format of the existing ones, and the baseline needs one paid re-run.

## 13. Docs, fixtures, and three artifacts whose window closes at the version bump

None of this was in v1's scope, and one item is genuinely irreversible.

**`docs/spec.md` is normative and is cited 443 times from code** across 114 files — §6.2 ×84, §6.4 ×70, §6.7 ×61, §6.5 ×45, §6.10 ×42. v1 claimed to supersede "§6.2 and §6.4 only"; that is false. §6.7's parser clause (_"a condition on every wait out-edge, a deadline and `on_timeout` on every wait"_) is contradicted outright by S5 and D3. The spec is a deliverable of this change, not a follow-up.

**`fixtures/README.md` is a written freeze on the thing being changed** — _"the two things that are frozen are the ones the visual vocabulary needs: **2 node types and 5 statuses**"_ — and it is the first document whoever regenerates the fixture will read.

**`scripts/make-fixture.sh` is the schedule's real critical path and no surface owns it.** 243 lines of hand-authored v1 pursuit across 13 commits, including a four-in-edge predicate wait that S7 makes illegal. It is not a rename pass; the Thursday story has to be re-authored as an activity graph. It also has the same first-match name aliasing as the CLI test harness — a v2 fan-out with three flow-finals all named "Declined" would silently collapse onto one id.

**Three artifacts are rendered from v1 logs and cannot be re-made after the loader stops reading them:**

| Artifact                                            | Why the window closes                                                                                                       |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `eval/report/pursuit-versions.html`                 | source is a `schema_version` 5 log; no generator exists in the repo                                                         |
| `docs/img/viewer-v5.png` — the pre-redesign capture | shows all-rectangular cards, a synthetic `__end` bullseye, and an action with three out-edges that v2's arity makes illegal |
| `docs/pitch.md`'s demo stills                       | same notation, same problem                                                                                                 |

Re-take or freeze all three **before** the version bump. This is the only genuinely irreversible item in the migration.

Minor but worth catching in the same pass: `README.md:147` reads _"a single static binary with no Activity in the image"_ — a find-and-replace casualty of `7b1283c` mangling "no **Node** in the image," i.e. Node.js. It is on the front page, and nobody grepping for node-type vocabulary will find it, because the string is `Activity`.

## 14. Migration and sequencing

**The break is `schema_version: 6` and the new store refuses to fold an older log**, under the existing `SCHEMA_VERSION_UNSUPPORTED` damage reason (`fold.ts:97`), and does not translate. The alternative buys compatibility for a body of logs consisting of test fixtures and one benchmark run, and pays with a permanent translation layer inside the one function the crash-resume story rests on.

**A note on the number.** `SCHEMA_VERSION` is **5** today (`schema.ts:426`) and the fixture's genesis record carries it, so this break is 5 → 6. Earlier drafts of this document said "version 2", which was the count of node vocabularies, not the schema version — they are unrelated, and the code's number is the one that governs.

**There is no sequence that keeps the root gate green throughout**, and the reasons are structural: `package.json` has one `"test": "bun test"` that discovers all 52 files in one process, so green means core + kona + viewer + eval simultaneously; and `plugin-catalogue.test.ts` puts plugin markdown inside the kona gate. The red window can be _confined_, not avoided.

**The ordering that confines it:**

0. **Decide D1–D8 and close the irreversible windows** (½–1 day, no core code). Re-take or freeze the three artifacts in §13. Build `eval/analyze/shape.ts`. Add the seed check to pre-flight.
1. **Core, with `task`/`wait` kept as scaffold aliases** — the nine types land, the version does _not_ bump yet.
2. **Regenerate `fixtures/thursday.*` into v2 _shape_ before the version bump.** This is the highest-leverage ordering decision in the migration: it breaks the otherwise circular dependency (viewer tests need a v2 fixture → the fixture is emitted by the binary → the binary's tests need v2 fixtures) without any atomic flip.
3. **The break landing** — version bump, aliases removed, op rename, wire rename, plugin prose, all in one commit because the gates chain them. This is the red window: **1–2 days** with step 2 done, weeks without it.
4. **Viewer**, then **eval re-run** for the new baseline.

**Un-shippable in between, stated plainly.** From the version bump until the fixture lands, the viewer renders a blank canvas under a one-line "1 damaged record(s)" footnote — not a degraded view, an empty one — and anyone pointing it at a pre-break pursuit sees that forever. From the `OP_KINDS` rename until the skills land, the model authors ops the store refuses.

**Two gates that will bite in non-obvious ways.** `knip` runs with `includeEntryExports: true`, so every new core export must land with a consumer or `check` goes red — which is exactly the trap "core exports the fold judgments first, the viewer consumes them later" walks into. And `stryker.conf.mjs`'s `core` and `outbox` tiers both use `EVERYTHING = "bun test packages"` — all three packages — with the stated rationale that viewer tests kill core mutants nothing in `packages/core/test` reaches. **While the viewer suite is red, those two tiers cannot produce a score at all**; Stryker's initial test run fails and aborts. The 100-floor `validate()`/`fold()`/outbox obligations in §8 of the spec are unmeasurable for the duration.

**The smallest slice that proves the design before the full rewrite** — ten nodes, one of each type, in `packages/core/test`:

```
● → ▮fork ┬→ [Ask Dana] → (Dana replies) → ◇ ─accept→ ▮join → [Lock roster] → ◎
          │                                 └─else───→ ⊗
          └→ [Book the pitch] ─────────────────────────↑
```

It proves the four things that would be catastrophic to discover late: readiness routes _through_ a control node; a control node never reaches the frontier; decision routing plus unreachability propagation actually replaces the drop cascade; and a fork/join region is expressible in one atomic commit.

## 15. Scope

**In.** The nine node types and their arity rules · §6's flow semantics · S1–S7 · D1–D8 · the six renamed ops and the wire rename · `MERGE_MODES` and `on_timeout` deleted · `schema_version` 6 with a refusing loader · core's fold, validate, branch, resume and brief · three viewer renderers, the nine-entry size table, per-shape handles, marker deletion, the three new derivations · both skills, the executor, `session-start.sh`'s v1 message · the eval seed, SKILL, directives, `shape.ts` and the `eval.md` amendment · `spec.md`, `fixtures/README.md`, `make-fixture.sh`, the README and the three closing-window artifacts.

**Out.** ObjectNodes and object flow · swimlanes / partitions · interruptible regions · expansion regions · SendSignalAction as a distinct type · loops and cycles · enforcing that every fork has a matching join (§18 Q2) · a graph editor · v1 compatibility in any form.

**Explicitly at risk, cut first if it slips:** the fork…join structural collapse (§10). It is a feature with no existing code and an undefined boundary, and the viewer is legible without it.

## 16. Definition of done

1. `vocab.ts` exports nine node types in two families; `MERGE_MODES` and `on_timeout` are gone; the forbidden-op list still has nothing to add.
2. `Node` is a discriminated union (D6), so a control-node status is a **compile error** — replacing v1's property test, whose necessity would have been evidence of the weaker representation.
3. A property test asserts **`kona next` never returns a control node or an `accept_event`**, over generated graphs. (The repo has no property-testing dependency today; adding one is part of the work.)
4. Eight structural refusals proven end-to-end at the CLI boundary, each naming the offending node: two initials · an unguarded decision out-edge · a decision with no `else` · an action with two in-edges · a wait wired to anything but a decision · a node unreachable from `initial` · a node reaching no final · a cycle. Plus three CLI-only: a control node to `brief`, a control node to `effect reserve`, and a pre-break log (which already refuses under the existing token `SCHEMA_VERSION_UNSUPPORTED`, `fold.ts:97` — no new reason is minted for it).
5. The §6.4 cascade behaviours survive unchanged — `branch.test.ts` and `waits.test.ts` pass against forks, joins and flow-finals, including _an unreachable source never satisfies readiness_ — and the cascade still runs at commit, not in the fold.
6. `kona resume` on a blown deadline commits two ops and mutates no topology (D3).
7. The `core` and `outbox` mutation tiers are back above their break thresholds (90 / 95) with the newly-unreachable defensive branches deleted rather than left to survive.
8. `eval/analyze/shape.ts` reports a regenerated authoring run as **not a chain** — the first time R1 and this criterion have had an instrument.
9. `docs/spec.md` §6.2, §6.4, §6.5, §6.7 and §6.10 read as v2, and no code comment cites a § that no longer says what it cites.

**Honest total: roughly 15–25 working days across seven surfaces**, of which `core` is the blocking prefix and the viewer is the largest single piece.

## 17. Risks

- **R1 — More nodes per unit of meaning.** Now measured, not estimated: +65% nodes, +50% edges, +2.9× ops on a fan-out, for identical work. Three answers — none of the new nodes is ever _worked_, the collapse boundary is exact rather than heuristic, and the model authors them. Watch it with `shape.ts`; if authored graphs get materially more expensive, the answer is `--steps` sugar, not a smaller vocabulary.
- **R2 — The model has to author correct control structure.** It writes what it is shown, and the plugin path has never been shown a multi-op batch at all. Mitigations: the S-rules refuse bad shapes by name, the exemplar changes first, `--steps` supplies the initial and final.
- **R3 — Join deadlock.** Unreachability propagation (§6) handles the arm that is never taken — §6.4's "zero live in-edges" rule ported to a structure that can express it. It does **not** handle the arm that was taken and `failed`, which parks the join with no deadline and no verdict. See Q6; this risk is open, not mitigated.
- **R4 — UML literalism.** §6 and §15 say which parts are excluded. "Subset" is load-bearing and stays in the title.
- **R5 — The mutation gate goes dark mid-migration**, so a regression could land unmeasured in exactly the two tiers the Definition of Done singles out at a 100 floor. Mitigation: step 2 of §14 confines the window to one landing, and DoD item 7 gates the exit.
- **R6 — An irreversible window is missed.** Three artifacts in §13 cannot be re-made once the v1 loader is gone. Mitigation: step 0, before any core code.

## 18. Open questions

**Sorted by who owns the answer.** Most of what follows is not a product question — it is `spec.md` §6.2/§6.4/§6.5/§6.7/§6.8 deciding an implementation detail, and it is listed here only because the audit surfaced it and it would otherwise be lost. Three are genuinely this document's to answer, because each one changes what the product _is_ for a person using it.

### Product — this PRD must answer

One.

**P1 — are control nodes selectable, and what does the Inspector say about each of the seven?** §3's argument for the entire redesign is that a branch point today has "no object to hang on and no id to reference." If control nodes cannot be clicked, the id is still unreachable from the picture and that argument is only half delivered. If they can, the Inspector needs seven panels' worth of content — and today it renders status, readiness, effect class and four reveals, none of which a control node has.

An earlier draft listed completion as a second product question. It is not one: `kona next` already prints `nothing ready`, and the run skill tells finished from waiting by checking whether the waits are armed. The `final` node only changes completion from _inferred from absence_ to _recorded_, which is a one-field addition to `kona next` with an obvious answer, not a decision. It is in the spec delta.

The one product question that has been answered — whether to rename the noun to `node` — was approved on 2026-08-27 and is recorded as **D9** in §2.1.

Two items that earlier drafts listed here have been demoted, because neither is a choice this redesign presents:

- **A `failed` arm parks everything downstream forever.** This is existing, deliberate behaviour, not something the join node introduces. `isReady` (`graph.ts:296`) is already conjunctive by default, and `isEdgeDead` (`:206`) deliberately does _not_ treat `failed` as dead — _"the subtree stalls, loudly, under a visibly failed activity, which is better than the store silently deleting work someone is about to repair."_ The redesign gives that behaviour a bar and a name; it does not change it. It appeared as an open question only because R3 claimed the redesign _prevented_ join deadlock, which was an overclaim. R3 is corrected; the only work it implies is a viewer one — a parked join must read as parked, not as waiting.
- **Work already in flight when the plan reroutes.** Also already decided, in §6.5: a satisfied predicate-wait has the store drop its still-armed siblings, and a reply arriving afterwards is recorded `verdict:"late"` and never reopens anything. Nothing about that changes. What the audit actually found is that §6's propagation rules, as written here, describe only never-taken branches and omit the abandoned-sibling case — an incompleteness in this document's new text, not a decision anyone needs to make.

### Spec — answered, in the delta

All nine are decided in [`spec-delta-activity-model.md`](./spec-delta-activity-model.md), written as drop-in replacement prose for `spec.md` §6.2 and §6.4 with amendments to §6.5, §6.7, §6.8 and §6.10. Summary of the answers: no forced fork/join nesting (a `conflict` lint instead, with the collapse region defined by dominance) · a three-tier rejection ladder splitting exit 1 from exit 4 · `obviated_if` and `scope` deleted · one predicate grammar with two placements · deadlines may not anchor to a control node · control nodes may be superseded with no special rule · `--steps` becomes head-aware · fork/join bars scale with arm count.

**The same sort applies to §2.1.** Of the nine decisions there, only **D2** (a claimed wait silently stops its own deadline) and **D5** (the graph must stay growable, or the thesis dies) are product decisions, and **D9** is the approved rename. **D1** is architectural with a product guarantee attached — history folds to the graph the human approved. The other five are spec's, and they now live in the delta.

**One thing the delta deliberately leaves open:** the pre-existing `spec.merge` bug in the viewer's unreachability calculation — which is a fix to the old model, not part of this change. Control-node `spec` is settled: schema v6 requires exactly `{}`.
