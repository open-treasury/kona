# SPEC DELTA — the activity model

**Status:** Approved (2026-08-27) · **Owner:** Ilya Vorobiev · **Upstream:** [`prd-activity-model.md`](./prd-activity-model.md)

This is the approved change record for [`spec.md`](./spec.md) **§6.2**, **§6.2.1**, **§6.4**, **§6.5**, **§6.7**, **§6.8** and **§6.10**. The changes have been incorporated; `spec.md` is the normative contract. The product-level argument lives upstream and is not repeated here.

**Two changes, one principle.** The nine node types are the visible half; the seven-state lifecycle in §6.2.1 is the other. **One principle governs every deletion below.** The redesign adds seven control nodes, and in exchange it deletes **every field that duplicated structure**: `merge`, `on_timeout`, `obviated_if`, `scope`. Anything a node now says by its shape stops being sayable twice.

---

## §6.2 Nodes and edges — REPLACEMENT

The pursuit's graph **is** the Activity. Its nodes are these nine, in two families.

| UML               | `type`         | Glyph                        | In / out             | Family        |
| ----------------- | -------------- | ---------------------------- | -------------------- | ------------- |
| InitialNode       | `initial`      | ●                            | 0 / 1                | control       |
| Action            | `action`       | rounded box                  | 1 / 1                | **behaviour** |
| AcceptEventAction | `accept_event` | concave pentagon + hourglass | 1 / 1                | **behaviour** |
| DecisionNode      | `decision`     | ◇                            | 1 / n≥2, all guarded | control       |
| MergeNode         | `merge`        | ◇                            | n≥2 / 1              | control       |
| ForkNode          | `fork`         | ▮                            | 1 / n≥2              | control       |
| JoinNode          | `join`         | ▮                            | n≥2 / 1              | control       |
| ActivityFinalNode | `final`        | ◎                            | n≥1 / 0              | control       |
| FlowFinalNode     | `flow_final`   | ⊗                            | n≥1 / 0              | control       |

**Behaviour nodes are worked; control nodes are derived.** Only `action` and `accept_event` carry `status`, `outcome`, `output` and `effect_log`. In the schema this is a **discriminated union on `type`**, not a shared shape with unused fields — a control-node status is a compile error, not a runtime convention.

```jsonc
// A behaviour node. The AUTHORED half is `spec`; the OBSERVED half is `status`.
{
  "id": "kona-9x2t",                 // store-minted <prefix>-<hash>, [a-z0-9][a-z0-9-]*, never `/`
  "type": "action",
  "name": "Ask Dana to play Thursday",
  "spec": {
    "instruction": "…",
    "inputs":  [{ "ref": "roster.availability" }],
    "outputs": [{ "name": "reply", "type": "string" }],
    "effect_class": "pivot",         // pure | reversible | compensatable | pivot
    "effect": { "channel": "email", "recipient_ref": "roster.contacts#dana",
                "correlation": "ilya+kona-kona-4f2a@…", "effect_key": "ek_9f2a…" },
    "compensates": null
  },
  "status": { "state": "ready", "outcomes": [], "outcome": null, "output": null,
              "conditions": [], "effect_log": [], "observed_at_version": 41 },
  "provenance": { "created_by_version": 12, "supersedes": null, "superseded_by": null }
}

// A control node. No `status` key exists on it at all.
{
  "id": "kona-7bd0",
  "type": "decision",
  "name": "Did Dana accept?",        // OPTIONAL on control nodes, required on behaviour nodes
  "spec": {},
  "provenance": { "created_by_version": 12, "supersedes": null, "superseded_by": null }
}
```

The three observed fields still answer three different questions — `state` where we are, `outcome` what was decided, `output` what was produced — and conflating any two remains the way the worst probe bugs happened.

## §6.2.1 The lifecycle — NEW

**Seven states, on behaviour nodes only.** This is BPMN 2.0's Activity Lifecycle minus the compensation states, and it replaces `active | in_flight | done | failed | dropped` wholesale.

| state        | written by                                     | means                                                                     |
| ------------ | ---------------------------------------------- | ------------------------------------------------------------------------- |
| `inactive`   | `add_node` — the creation default              | exists; its dependencies are not yet satisfied                            |
| `ready`      | **derived at commit**                          | dependencies satisfied and unclaimed — _this is the frontier_             |
| `active`     | `set_status` — a claim                         | claimed; somebody is working it                                           |
| `completed`  | `set_status`                                   | terminal success, and **the only state that satisfies a downstream edge** |
| `failed`     | `set_status`                                   | tried, didn't work                                                        |
| `withdrawn`  | **derived at commit**                          | never claimed; the flow went elsewhere and set it aside                   |
| `terminated` | `set_status`, or `supersede_node` housekeeping | **was** claimed; stopped before it finished                               |

`TERMINAL_STATUSES = [completed, failed, withdrawn, terminated]` · `TERMINAL_SUCCESS_STATUS = completed`. `active` is deliberately **not** terminal: a claim with an open effect means the real world's answer is unknown, not that the node resolved.

```
                    ┌──────────── derived ────────────┐
                    ▼                                 │
  (add_node) →  inactive  ──derived──▶  ready  ──claim──▶  active  ──▶ completed
                    │                     │                  │      └─▶ failed
                    └────── derived ──────┘                  └────────▶ terminated
                              │                                  (was being worked)
                              ▼
                          withdrawn
                       (never claimed)
```

**Why `dropped` became two states, and not one.** The pre-v6 `dropped` state was a union of the two BPMN cases, and an earlier draft of this section claimed only the first could happen — citing `isDroppable` (`branch.ts:38`), which refused to drop a claimed node. That was true of **the cascade** and false of the system. Both other paths were reproduced end-to-end before migration: `supersede_node` against a non-terminal node rewrote it at `apply.ts:283-285`, whose own comment stated the second case in one sentence — _"one still in flight stops being work"_; and a plain `kona mutate set_status <id> dropped` against a claimed node was accepted, exit 0, no warning. Even a node with an **open reservation** could be dropped via supersede plus a compensating `add_node` in the same batch.

Splitting it costs one state and buys three things:

- **`supersede_node` stops guessing.** Its housekeeping picks the state from what it finds: `withdrawn` if the node was `inactive` or `ready`, `terminated` if it was `active`. The author never chooses, so the two can never be mixed up by hand.
- **Authority splits cleanly.** `withdrawn` is **store-only** — it is a statement about topology, and an author asserting "the flow went elsewhere" is asserting something the graph decides. `terminated` is **authored**, because deliberately stopping work in progress is exactly the kind of judgment §6.4 says belongs to a person, plus the derived case above.
- **`withheld` finally has somewhere to go.** `branch.ts:47` computes the nodes the cascade refused to withdraw — claimed, or bytes already moved — and promises _"each one is a human's decision."_ `validate.ts:729` returns it and **no CLI verb reads it**, so today those nodes sit claimed forever. They are precisely the `terminated` candidates: `kona resume` reports them, and a human commits the transition.

Empirically every `dropped` in every committed artifact is the withdrawn case — the fixture's `th-1ppl` was unclaimed when superseded at v12, and the eval report's footer calls its two _"an arm the graph resolved away, not a step anyone abandoned"_ — so `terminated` is a permitted-but-unwitnessed path that the vocabulary has never been able to name.

One collision to record: `WITHDRAWN` is already a `REASON_CODE` (`vocab.ts:106`), and two tests pair it with `status: "dropped"` today. It stays a reason code and may accompany either terminal state; a status and a reason code sharing a word in two closed vocabularies is tolerable, and the alternative — renaming a reason code the model has been trained on — is worse.

**Two of the seven are derived-and-written, and they are the same mechanism.** The store computes them at commit and appends explicit `set_status` ops to the batch, exactly as §6.4's cascade already does. `isReady` does not disappear — it moves from a read-time predicate to the derivation that emits `inactive → ready`.

**Readiness is derived and logged, not recomputed by readers.** A fresh session still needs no snapshot beside the log to rebuild and trust. A derived fact written _into_ the append-only log is not a snapshot — `withdrawn` has always worked this way. The log can now answer a question it could not before: **when did this become available, and how long did it sit unclaimed?** That is queue time, and it is the efficiency measure the eval rig has no instrument for.

### Transitions

| from → to                          | by                                | rule                                                                                                                      |
| ---------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| — → `inactive`                     | `add_node`                        | every behaviour node is born here                                                                                         |
| `inactive` → `ready`               | derived                           | all live in-edges satisfied, traversing through control nodes                                                             |
| **`ready` → `inactive`**           | derived                           | **the transition BPMN does not have** — see below                                                                         |
| `ready` → `active`                 | `set_status`                      | the claim. `active → active` is refused `ALREADY_CLAIMED`                                                                 |
| `active` → `completed \| failed`   | `set_status`                      | the executor, on evidence                                                                                                 |
| `active` → `inactive`              | `set_status`                      | `kona resume` releasing a stale claim; the same commit's derivation re-lifts it to `ready` if its dependencies still hold |
| `inactive \| ready` → `withdrawn`  | derived                           | the cascade on an untaken arm, or `supersede_node` against an unclaimed node                                              |
| `active` → `withdrawn`             | **refused**                       | it was being worked; that is `terminated`                                                                                 |
| `active` → `terminated`            | `set_status`, or `supersede_node` | the authored case, and the store's housekeeping when superseding a claimed node                                           |
| `inactive \| ready` → `terminated` | **refused**                       | nothing was stopped; that is `withdrawn`                                                                                  |
| any terminal → anything            | **refused**                       | invariant 1, unchanged                                                                                                    |

**`ready → inactive` is the one transition BPMN has no equivalent for, and it exists for the reason the product exists.** Insert a step in front of a node that was available — §6.4's growth shape, or any new blocking edge — and it stops being available. BPMN's lifecycle is monotonic because BPMN's topology does not change at runtime. Kona's does. The lifecycle is therefore non-monotonic in exactly the one place the thesis lives, and a reader should be told that rather than discover it.

**The cascade still never terminates anything by itself.** `isDroppable`'s two guards are unchanged: it will not rewrite a claimed node, and it will not rewrite one whose `effect_log` is non-empty, because cancelling a plan does not un-send an email. Those nodes go to `withheld`, `kona resume` reports them, and a human commits `terminated` — with a compensation in the same batch when bytes have moved.

**Cost, stated honestly.** One commit that completes a node emits one `ready` op per newly-unblocked successor, so a wide fan-in produces a burst. That is the same shape and the same order of magnitude as the drop cascade, and unlike the cascade it is data somebody wants: the timeline can now show _became ready at v14, claimed at v19_. Only actual transitions are written — a derivation that changes nothing emits nothing, per §6.3's suppression rule.

**One edge kind, and guards live in exactly one place.** `{from, to, guard?}`, no identity. `{from: A, to: B}` means **B requires A** _except_ into a `merge`, where an in-edge is a disjunct — the one place that sentence stops being uniformly true, and the plan skill must say so.

A `guard` is legal **only** on an out-edge of a `decision` (S5), where it is mandatory (S3), and takes exactly three forms:

```jsonc
{"guard": {"on": "accept"}}                                                  // a verdict projection
{"guard": {"count": {"verdict":"confirmed","attrs":{"role":"goalie"}}, "op": ">=", "n": 1}}
{"guard": "else"}                                                            // exactly one per decision
```

`else` is **written, never implied by absence** — an absent guard on a decision's out-edge is an S5 refusal, and the two must not be the same bytes. The verdict vocabulary is unchanged: `accept | edit | respond | ignore | timeout | bounced | satisfied`.

**Deadlines, three shapes, with one new refusal:**

```jsonc
{"at": "2026-08-22T17:00:00Z"}
{"after": "kona-9x2t", "duration": "48h"}     // MUST anchor to a behaviour node — S-Q5
{"expr": "game_date - 24h", "backstop": "…", "after_unknown": true}
```

`after` anchoring to a control node is refused at commit. Completion times are built from `set_status` ops and a control node emits none, so such a wait would sit unarmed forever with nothing able to say why — a silent hang, which is the one failure mode this whole document exists to remove.

### Migrating to the lifecycle — what the compiler cannot catch

This rename is a **swap**: the token `active` survives and means the opposite. That makes it categorically different from an ordinary rename, and the difference was measured rather than reasoned about — the audit applied the rename in an isolated copy of the repo and ran it.

| Measured                                     | Result                                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Renaming `vocab.ts` alone                    | **27 type errors**, and **100% are on `in_flight`** — the token that disappears. Not one mentions `active` |
| `const a: Status = "active"` post-rename     | **Compiles clean.** zod agrees: `parseBatch` accepts every new member and refuses only `in_flight`         |
| Reverting one source site to the stale token | tsc reports **zero errors, every time**                                                                    |

Both mechanisms check _membership_, and `active` never stops being a member. **Neither the compiler nor the schema is a backstop for half of this change.** The tests are the only net, and it is a good one for six of the seven source sites — 29, 28, 167, 32, 24 and 8 failures respectively. It has exactly one hole, and it was reproduced:

> **A fully green, fully inverted build exists.** Leave both `resume.ts:149` (the stale-claim repair op) and its single assertion at `resume.test.ts:262` stale, and you get **0 type errors and 1290 tests passing**. The build's behaviour: `kona resume`'s repair for a stale claim is to re-claim it, which `validate` then refuses with `ALREADY_CLAIMED` — whose message tells the operator to _"run `kona resume`"_, the command that just produced the refused batch. One test stands behind that site; every other has eight or more.

**The five source sites that hold the swap**, each needing a judgment rather than a substitution, because old `active` maps to _two_ new states depending on the derivation:

| Site                               | Today                                 | Becomes                                                       |
| ---------------------------------- | ------------------------------------- | ------------------------------------------------------------- |
| `graph.ts:280`                     | the readiness gate                    | the derivation that emits `inactive → ready`                  |
| `apply.ts:85`                      | birth state `"active"`                | `"inactive"`                                                  |
| `deadline.ts:92` `armedWaits`      | `=== "active"`                        | `=== "ready"`                                                 |
| `resume.ts:149` stale-claim repair | `"active"`                            | `"inactive"`, re-lifted by the same commit's derivation       |
| `brief.ts:257` `node_live`         | `=== "active"`                        | the non-terminal set                                          |
| `kona/commands/effect.ts:136`      | `!== "active"` gates `effect reserve` | `!== "ready"` — and it is the only verb that moves real bytes |

**Never run a two-pass substitution.** `validate.ts:186-187` is the only place both sides of the swap sit on adjacent lines; a sed doing `in_flight → active` before `active → ready` double-substitutes and collapses `checkClaimExclusivity` into a `ready → ready` rule, which stops guarding claims entirely and restores the double-claim its own comment records as measured. It type-checks. Use a placeholder token.

**`SCHEMA_VERSION` must go to 6, and nothing will tell you if it does not.** `schema.ts:418-424` states the precedent for exactly this rename: _"The status is DATA in mutations.jsonl, not just an identifier, so the rename is a breaking change to the log format rather than a cosmetic one."_ And the asymmetry that makes the bump load-bearing: a v5 log carrying `in_flight` is refused loudly by the enum, but a v5 log carrying `active` folds **cleanly** under the new vocabulary and reads as claimed. Only the version refusal catches it.

**Unguarded classes, in descending order of consequence.** The audit's green tree renamed zero comments, zero test names, zero doc files and zero CSS custom-property names, and passed 1290/1290:

- **`theme.css:102-131`** names colours after statuses and carries a 19-line comment whose entire argument is _"why `active` is not the yellow."_ After the rename `active` **is** the yellow. `stylesheet.test.ts` only byte-compares a fresh Tailwind build, so it can never see that a token's name no longer matches its colour.
- **`ActivityCard.tsx:57-63`** — `STATUS_GLYPH` is `Record<Status, …>`: keys compiler-checked, **values not**. Rename the keys without moving the icon/tone/spin payloads and every glyph on the canvas inverts, cleanly compiled.
- **`plugin-catalogue.test.ts`** does catch a stale status inside a ` ```jsonc ` fence and does pin the status table to `STATUSES` — but by **set equality**. Reversing the row's order to teach the opposite lifecycle went fully green. Order is what a status table is _for_.
- **The eval rig has no equivalent guard at all**: its ops live in ` ```bash ` fences the extractor skips, and `KONA_DIRECTIVE` (`kona_agent.py:196`) hard-codes _"Set a node `in_flight` before you start it"_ as a Python string. `eval/run/lib.sh:97` records what that costs: _"`in_flight` shipped in the skill while the container still held a binary that only knew `sending` — and it cost a two-hour Sonnet A/B that was testing a product nobody was running."_
- **The migration audit found a 0% prose base rate.** `sending → in_flight` had already happened at schema v2, yet **21 stale `sending` references remained at audit time** across `spec.md`, `plan.md`, `fixtures/README.md`, `scripts/`, `.beads/` and eight source files. That finding is why schema-v6 documentation was reconciled explicitly rather than by token substitution.

**Two things were guarded, correcting an earlier assumption.** The pre-migration `fixtures/thursday.graph.json` had six old-meaning `active` values that produced **3 failures** in `contract.test.ts` via the fold-vs-disk byte comparison, and a stale `in_flight` in the mutations log cascaded to **78**. The fixture was not a silent hazard; it has since been regenerated as schema v6.

**Leave `eval/report/pursuit-versions.html` alone, deliberately.** Its 136 `"status": "active"` values are a frozen capture of a real, paid, measured run recorded under today's meanings; rewriting them would falsify a historical record. It gets a dated banner naming the vocabulary it was recorded under. Same for `.beads/issues.jsonl`.

**Sed decoys** a mechanical pass will corrupt: `.react-flow__edge.inactive` and `showInteractive` (React Flow's, not ours), the JS iterator property `done`, shell `for … done`, the real directory path `plans/active/kona-eval/`, `EffectOutcome`'s `failed`/`sent`, the wait-resolution enum's `dropped`, and 62 beads records carrying `"status":"closed"`.

### Deleted from §6.2

| Field                   | Replaced by                                                 | Why it goes                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `merge: "all" \| "any"` | a `join` node / a `merge` node                              | one field doing two operators' work, chosen by a model. `all` over alternatives deadlocks; `any` over parallel arms silently discards results |
| `on_timeout`            | a `timeout`-guarded out-edge of the decision the wait feeds | two representations of one route. It also made `kona resume` author an edge that S4, S5 and the arity table each forbid                       |
| `obviated_if`           | a `decision` with a `flow_final` arm                        | "this branch is moot" is now a shape. Same argument as `merge`                                                                                |
| `scope`                 | the `fork`'s own `name` (D8)                                | arm membership is structural once a fork exists; `scope` was a second, unverifiable source of truth for the same grouping                     |

---

## §6.4 The six ops — REPLACEMENT

```
add_node(spec)                                            -> $id     // any of the nine types
add_edge(from, to, {guard?})                                          // guard only from a decision
set_status(node, status, evidence_ref)                                // behaviour nodes only
record_outcome(node, verdict, evidence_ref, attrs?)                   // behaviour nodes only
record_output(node, output_name, value_or_ref, evidence_ref)          // action only
supersede_node(node, by?)                                             // never delete
```

**Six. There is no seventh, and none is reserved.** Forbidden, unchanged: `delete_node` · `rollback` · `replace_graph` · `edit_rationale` · `reparent` · any write to a terminal node · coordinates · executable payloads · client-assigned ids.

Batch semantics are unchanged: ops apply in array order, invariants check once against post-commit state, `$0`/`$1` intra-batch references with forward refs rejected, **no op creates an edge you did not write**, and a fan-out is one atomic commit.

### Structure is judged over the LIVE subgraph

A node with `superseded_by ≠ null`, and any edge with a superseded endpoint, is invisible to the arity rules and to S1–S7. This is what makes the graph growable, and it is not a convenience: `action` is 1-in/1-out, S2 requires every node to reach a terminator, and there is no edge-removal op — so without it, extending a branch that already ends would require a seventh op.

**Growing a branch, the sanctioned shape** — three ops, no new verb:

```jsonc
[ {"op":"supersede_node", "node":"kona-1kd8"},                       // the old flow_final
  {"op":"add_node", "type":"action", "name":"Chase Dana by phone", "spec":{…}},
  {"op":"add_edge", "from":"kona-9x2t", "to":"$1"},
  {"op":"add_node", "type":"flow_final"},
  {"op":"add_edge", "from":"$1", "to":"$3"} ]
```

**Superseding a control node is legal (S-Q6)** and needs no rule of its own. Supersede a `decision` or a `fork` without re-wiring the arms beneath it and S1 or S2 fails against post-commit state anyway — the existing rules already say what is unsound, so a special case would only be a second place to disagree.

### Branch resolution — still derived once, at COMMIT

> This is the load-bearing sentence of the whole delta. Routing **and readiness** are derived by `validate()`, which appends the resulting `set_status` ops to the batch before it is written. Neither is **ever** performed by `fold` or `applyOps`.

`fold` replays every record through `applyOps`, so a derivation living there re-runs on every read forever using whatever the code says _today_. Change the routing rule next month and every historical log folds into a graph the human never approved — with the log unchanged, so nothing looks wrong. The store decides once and the log records the decision, exactly as for id minting. Readiness is likewise derived once at commit and recorded as explicit ops; readers do not recompute it.

Two derivations run, in this order, and both emit explicit ops:

1. **Routing and withdrawal** — the rules below.
2. **Readiness** — every behaviour node whose live in-edges are now all satisfied transitions `inactive → ready`; every node that was `ready` and no longer qualifies transitions back to `inactive` (§6.2.1). Control nodes are traversed, never marked, because they have no status.

Readiness runs second because a node on an arm that this commit just withdrew must not be lifted to `ready` first and corrected after — the intermediate state would be a real op in a real log, and §6.4's fail-safe exists precisely so an untaken branch never reaches the frontier.

The routing rules, restated against terminators that now exist:

1. **A decision fires exactly one out-edge.** Guards are evaluated in edge order, first match wins; `else` fires when none matched. The targets of the untaken out-edges become unreachable.
2. **Unreachability propagates transitively** and stops at any node still held by a reachable in-edge — a shared descendant survives.
3. **A `join` excludes unreachable in-edges** rather than blocking on them. A `join` or `merge` whose in-edges are _all_ unreachable is itself unreachable, and propagates.
4. **Readiness does not inherit the exclusion.** An unreachable predecessor never satisfies readiness — otherwise the second node on an untaken branch reaches the frontier and gets dispatched, irreversible send included. This is §6.4's original fail-safe and it is unchanged.
5. **A `failed` source is not unreachable.** It can never satisfy, so its subtree stalls — loudly, under a visibly failed node, which is better than the store silently deleting work someone is about to repair. A `join` inherits this unchanged; §6.10 rule 11 requires the viewer to render a parked join distinctly from a waiting one.
6. **Abandoning still-armed siblings.** When a predicate resolves, the store withdraws the sibling `accept_event`s that fed it and marks their downstream unreachable by rule 2. A reply arriving afterwards is `record_outcome(verdict:"late")` and **never reopens** anything. This is §6.5's existing rule; it is stated here because rules 1–4 describe branches never _taken_ and would otherwise leave the abandoned case unnamed.

**Every time the contract asked the model to tidy up, it forgot, half-did it, or was rejected for trying. When the housekeeping is derivable, the store does it.**

---

## §6.5 Waits — AMENDMENTS

An `accept_event` keeps every rule §6.5 gives it: the three match kinds `event | human | predicate`, a mandatory `deadline`, a correlation address derived from **its own** id, a cursor, first-match-wins deduplication on provider message-id, and the three cases the contract must name (`late`, `tentative`, and a satisfied predicate withdrawing its siblings).

Three amendments:

- **`on_timeout` is gone.** A blown deadline is `record_outcome(verdict:"timed_out")` plus `set_status(completed)`, and the `timeout`-guarded out-edge of the decision the accept-event feeds carries the route. `kona resume` therefore stops mutating topology entirely — its timeout repair is two ops that were already legal.
- **An `accept_event` is polled, never claimed.** It does not appear in `kona next`, is never dispatched to an executor, and `kona brief` refuses it. Under §6.2.1 an armed accept-event is `ready` — never `active`, because nothing may claim it. Before v6, `armedWaits` required `state === "active"` (then the unclaimed state), so claiming a wait silently disarmed it and its deadline never fired. Schema v6 refuses the claim, and the state the deadline engine reads is the state nothing else can take.
- **One predicate grammar, two placements (S-Q4).** `{"count": {"verdict":…,"attrs":{…}}, "op":…, "n":…}` is a single closed form with a single evaluator. It may appear as a wait's `match.kind:"predicate"` or as a `decision` guard. It reads only `outcome.verdict` and `outcome.attrs`; no other names resolve.

**Both placements resolve their population by traversing through control nodes** to the behaviour nodes beneath — counting a `merge` disjunctively and a `join` conjunctively, and skipping control nodes without counting them as answers still to come. The old definition (a wait's own in-edges) yields exactly one control node under the new arity, and then reads a `status` that does not exist.

---

## §6.7 Invariants — AMENDMENTS

The parser still runs first and free. What is new is a **three-tier rejection ladder**, which answers S-Q2 and which the plugin's refusal-repair table branches on:

| Tier           | Checks                                                                                                                                                                                                                       | Needs                   | Exit                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------- |
| **Schema**     | legal `type`; legal `status`; the required fields for that type; guard well-formedness; a `name` on every behaviour node                                                                                                     | the batch alone         | **1** `REFUSED`             |
| **Structural** | arity (§6.2 table) · **S3** every decision out-edge guarded, exactly one `else` · **S4** an `accept_event`'s out-edge targets a `decision` · **S5** guards only from a decision · **S7** an `action` has exactly one in-edge | batch + head, one hop   | **1** `REFUSED`             |
| **Invariant**  | **S1** exactly one `initial`, every node reachable from it · **S2** every node reaches a `final` or `flow_final` · **S6** no cycles · the three existing invariants                                                          | whole post-commit graph | **4** `INVARIANT_VIOLATION` |

The split is the existing one, not a new idea: the schema and structural tiers say _you wrote the op wrong_; the invariant tier says _the graph you would have made is unsound_. Both name the offending node.

**The three invariants survive, and one of them changes.** Terminal-and-effect protection and the effect budget carry over unchanged, applying only to behaviour nodes. **Invariant 2 — predicate-waits stay satisfiable — takes the traversal from §6.5**, because its current population (`inEdges(wait)`) is one control node under the new arity and its current status read is a `TypeError` inside `validate()`, which has no caller that catches it.

**S1 and S2 are checked at commit against post-commit state**, which is a real constraint on the author rather than a formality: a batch that adds a step must also terminate it. That is one extra op, and it is the price of dead ends being detectable at all.

**Claim exclusivity is a transition rule, not a fourth invariant, and it is unchanged in substance.** `ready → active` is legal; `active → active` refuses `ALREADY_CLAIMED`. CAS does not cover this and it is worth being precise about why: CAS rejects a commit written against a _stale_ head, and a second agent reading **after** the first claim commits sees a perfectly current head — measured, two claims on one node, both exit 0. The other transitions out of `active` stay legal, or a claimed node could never be released. The one addition is that a `set_status` writing `ready` or `withdrawn` from an author rather than from the store's own derivation is refused: those two states are the store's to write.

**Log, don't block** is unchanged, and gains one use: an unjoined `fork` (S-Q1) is **not** an invariant violation — a fork whose arms end at flow-finals is sound and UML does not require well-nestedness — but it is usually a mistake, so it is reported as a `conflict` annotation and surfaced in the viewer.

---

## §6.8 The CLI — AMENDMENTS

The nine verbs are unchanged in name and number. Three change contract:

- **`kona next`** becomes a **query over recorded state** rather than a computation: return the `action` nodes whose status is `ready`. It never returns a control node (they have no status) and never an `accept_event` (it is polled, not claimed). Each element gains `fork`: the id of the fork it descends from, or `null`. Nodes sharing a `fork` are one concurrent set.

  The verb keeps its name. `kona ready` would match the status but advertise a query it does not perform: an armed `accept_event` is also `ready` — that is the state the deadline engine reads — and D2 deliberately keeps waits out of the dispatch list. `next` means _work you can take_, which is the filtered thing it returns, and it avoids coupling a verb name to a vocabulary that has now been renamed twice. `kona next --help` states the relationship at the point of confusion: **the ready actions — waits are ready too, but they are polled, not claimed.**

- **`kona next`** additionally reports completion, **additively**. `nothing ready` stays exactly as it is — it remains true, and it is the answer to a different question — and a `complete` flag is added beside it: `version 42 · nothing ready · complete`, and `complete: true` in the JSON. Today an empty frontier covers three situations — finished, waiting on the world, stalled — and the run skill separates them by checking whether every wait is armed. Completion is now a fact the graph states rather than one the caller infers, and the skill gains a third stop condition. A boolean rather than a replacement message, so a JSON consumer reads a field instead of string-matching, and nothing that parses today's output breaks.
- **`kona graph --json`** renames `edges[].condition` → `edges[].guard`, and `status` is absent on the seven control types. This is §6.10 rule 10's one read contract, so the change lands with its consumer test in the same commit.
- **`kona brief`** refuses a control node and an `accept_event`, and its forward walk from a send to the accept-event it feeds now passes **through** control nodes, stopping at the first behaviour node on each path — still failing closed on more than one, since guessing which accept-event a reply belongs to would advance the wrong arm under no-rollback.

**`kona mutate --steps` becomes head-aware (S-Q7).** On an empty pursuit it emits `initial` → the steps → `final`. On a non-empty one it appends after a named node, superseding that branch's terminator and adding a new one — the §6.4 growth shape, as sugar. It is no longer a pure function of its arguments, and that is the point: without it, the cheapest legal first commit and every subsequent extension both cost the model more than the work does.

**The wire rename is one decision applied in nine places, in one commit:** `activities` → `nodes` (in `graph` and `next`), `activity_id` → `node_id` (poll's `WaitAddress` and `InboundMatch`, resume's `waits` and `unknown_sends`), the `activity` key on four op payloads, and `edges[].condition` → `guard`.

---

## §6.10 The viewer — AMENDMENTS

Rules 1, 3, 5, 6, 7, 9 and 10 are unchanged. Rule 8's three wait colours become the hourglass badge's three colours. Four amendments and one addition:

- **Rule 2 (memoize dagre on a topology signature) does not survive untouched.** The signature encodes `edge.condition?.on` and `spec.on_timeout`, both of which this delta renames or deletes. Left alone it silently stops distinguishing guards, and a rewired decision returns a cached layout under a changed label — which reads as a styling bug, not a correctness one.
- **Rule 3's collapse region gets a structural definition that does not require a join (S-Q1).** A region is a `fork`, plus every node it dominates, up to and including its immediate post-dominator when one exists — the `join` — and otherwise each arm's terminator. This is well-defined for both nested and unjoined forks, which is what lets S-Q1 answer "lint, not invariant" without leaving the collapse boundary undefined.
- **Rule 4's readiness vocabulary mostly collapses.** The viewer today derives `ready | blocked | running | settled | superseded` from `status.state` plus four graph conditions. Five of those are now recorded: `ready` is `ready`, `running` is `active`, `settled` is any terminal state, and `blocked` is `inactive`. Only `superseded` stays derived, from `provenance` — so **`Readiness` is deleted rather than kept**, and `readinessOf` becomes a superseded check. Keeping both would put `ready` in two unions with different meanings, and `blocked.test.ts:82`/`:84` would become textually identical `.toBe("ready")` assertions about different vocabularies two lines apart.
- **Rule 4 gains a control-node clause.** Control nodes render as glyphs, not cards, and carry no status chip because they have no status. A `decision` shows its out-edges in evaluation order with the fired one marked; a `join` shows _k of n_ arms satisfied.
- **Bar geometry (S-Q8).** In `rankdir: LR` a fork/join bar is a narrow vertical rule: fixed width, height `max(min_height, arms × handle_pitch)`, with _n_ addressable handles distributed along it. Fixed-size bars collide with their own edges above three arms.
- **New rule 11 — a parked join must not read as a waiting one.** §6.4 rule 5 leaves a join under a `failed` arm stalled forever by design. The viewer must render that state distinctly, with the failed node named. A plan that goes quiet has to say _which step_ it is quiet inside; a join that will never complete, drawn as one that is merely waiting, is the exact failure this product exists to remove.

**Still not a graph editor.** An editable canvas is a second, unversioned mutator with no rationale.

---

## The nine answers, in one table

|      | Question                                 | Answer                                                                                                                                     |
| ---- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| S-Q1 | Must a `fork` reach a matching `join`?   | **No.** Sound without one; reported as a `conflict` lint. The collapse region is defined by dominance, so it stays well-defined either way |
| S-Q2 | Exit 1 or exit 4 for S1–S7?              | **Both** — the three-tier ladder in §6.7. Local shape refuses (1); whole-graph properties violate (4)                                      |
| S-Q3 | Does `obviated_if` survive?              | **Deleted.** A decision with a flow-final arm says it structurally                                                                         |
| S-Q4 | One predicate mechanism or two?          | **One grammar, one evaluator, two placements** — a wait's `match`, or a decision's guard                                                   |
| S-Q5 | May a deadline anchor to a control node? | **No**, refused at commit. Control nodes emit no `set_status`, so there is no completion time and the wait would hang unarmed and mute     |
| S-Q6 | Can a control node be superseded?        | **Yes**, with no special rule — S1/S2 already reject the unsound cases                                                                     |
| S-Q7 | Is `--steps` head-aware?                 | **Yes.** Empty pursuit: `initial` → steps → `final`. Non-empty: append after a named node, superseding that branch's terminator            |
| S-Q8 | How long is a fork/join bar?             | **Scales with arm count**, clamped, with _n_ distributed addressable handles                                                               |
| S-Q9 | What happens to `scope`?                 | **Deleted.** Arm membership is structural once a fork exists; the fork's own `name` labels the region                                      |

**Post-approval resolution:** control-node `spec` is required and must be exactly `{}` in schema v6.

## Open — deliberately not decided here

- **`spec.merge` in the viewer.** `blocked.ts` computes unreachability with `some(isPermanent)` on the stated grounds that nothing in `core` reads `spec.merge`. `graph.ts` does read it, so an `any` node is currently painted dead when one input dies. This is a **v1 bug**, and fixing it before the port is cleaner than carrying it into the `merge` node's semantics — but it is a fix to today's code, not part of this delta.
- **`seam.test.ts`'s A3 gate is a hardcoded five-name list** — `isReady`, `isEdgeSatisfied`, `resolutionOf`, `satisfiesBlockingEdge`, `readyFrontier`. It is the gate that stops the canvas rendering a second opinion from the store's, and it does not cover the new fold judgments: a `firedGuard()` written inline in a glyph component passes the grep. The list needs extending as the exports land, and nothing will remind anyone.
- **The mutation timeline's rows inflate and nobody budgeted it.** `changeSummary` renders "added N activities and M edges." §6.4's worked fan-out turns one human event — _ask three people_ — from "added 4 activities and 4 edges" into roughly twice that. R1 costs the inflation in tokens and in rig metrics; the sentence a person reads in the differentiator panel is a third place, and it is the one that is supposed to be legible.
- **The viewer has no channel for "this pursuit predates the break."** A refused genesis record breaks the fold immediately, so the reader gets an empty canvas under a one-line footnote reading `1 damaged record(s): SCHEMA_VERSION_UNSUPPORTED at line 1`. That is the right information at entirely the wrong volume, and §14 says anyone pointing the viewer at a pre-break pursuit sees it forever.
- **A scaling fork/join bar fights `dagre.ts`'s stated design.** S-Q8 says the bar's length scales with arm count, but the layout's own header says sizes are "fixed per type rather than per card" and "nothing is measured, ever," because a measured height would make geometry depend on render. The answer needs an explicit two-pass rule — lay out with a stub, then draw the bar across its arms — not just a number in the size table.
