# SPEC — Kona

**Status: Approved** (Ilya, 2026-08-21) · **Owner:** Ilya Vorobiev
**PRD:** [`prd.md`](./prd.md) · **Plan:** [`plan.md`](./plan.md)

> This says what Kona _is_. How it got here — four simplification passes, six probe runs, an eight-lens review — lives in git and in an evidence base that is **not published** (see §11). Decisions carry a one-clause reason only where re-introducing the mistake is likely, and every measurement they rest on is quoted here rather than merely cited.

---

## 0. TL;DR

**Kona is Beads with state machines, plus the plugin Beads never had.** A deterministic CLI over an append-only log; a Claude Code plugin holding all the judgment.

- **One file.** `.kona/mutations.jsonl` is the system of record; the graph is a **fold** over it — a pure data operation, not replay, which is what lets crash-resume and mid-run mutation coexist.
- **⚖ The law: the `kona` binary never calls a model.** Every verb is a pure function of the log + the clock + the mailbox cursor.
- **9 node types · 2 families · 6 ops · 1 edge kind · 7 statuses · 3 invariants · 9 verbs · 3 packages.**
- **`--why` is required on every mutating verb.** No rationale, no commit.
- **No rollback.** Emails are sent. Nodes are superseded and compensated, never deleted.
- **One gate:** a mutation creating a new irreversible effect to a recipient the graph has never seen.

---

## 1. Meta

|         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch  | `spec/block-0-graph-store` · Epic: Block 0 (PRD §14)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Amended | **2026-08-28 — the activity model.** §6.2 rewritten to nine node types in two families, §6.2.1 added for the seven-state lifecycle, §6.4 for the six renamed ops and the two commit-time derivations, §6.7 for the three-tier ladder, §6.8 and §6.10 for what the verbs and the canvas now show. `schema_version` 5 → 6. Rationale and blast radius: [`prd-activity-model.md`](./prd-activity-model.md), [`spec-delta-activity-model.md`](./spec-delta-activity-model.md) |
| Stack   | **TypeScript 7** (native) on Bun · React + `@xyflow/react` + dagre · JSONL on disk                                                                                                                                                                                                                                                                                                                                                                                        |
| Budget  | 12–14 h, one operator, four parallel windows                                                                                                                                                                                                                                                                                                                                                                                                                              |

**Toolchain — TypeScript 7.0 (native Go port, released 2026-07-08).** Bun transpiles and runs TS itself, so `bun test` and `bun build --compile` are unaffected by which `tsc` is installed; `tsc` is the **typecheck gate only**, and there it is 8–12× faster than the JS compiler.

|                                     |                                                                                                                                                                                                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Free wins**                       | `strict: true` and `module: esnext` are now **defaults** — §7's gate and the Bun target both come for nothing. `--checkers` parallelises the check                                                                                                                         |
| **Config it forces**                | `types: []` is the new default, so Bun's globals need an explicit `"types": ["bun"]`. No `baseUrl` — use `paths`. No `target: es5`, `moduleResolution: activity`, `module: amd\|umd\|systemjs`                                                                             |
| **⚠ No programmatic API until 7.1** | Anything consuming the compiler API needs TS 6 side-by-side via `@typescript/typescript6` (ships a `tsc6`). **typescript-eslint is named in the announcement as needing it** — so `bun run lint` with typed rules wants that package installed                             |
| **⚠ Unverified**                    | Whether StrykerJS's TypeScript checker works against 7.0. It is the same class of dependency. §7 already makes mutation score a _target, not a gate_, so the downside is bounded — but **check it before relying on the 100% target**, and fall back to `tsc6` if it bites |

_Source: [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)._

**Platform — macOS is the tested target; Windows and Linux are designed for, not verified.** Most of the design is already portable by accident: §0.5 deleted the derived snapshot, which took **atomic rename** — the single worst Windows footgun — with it, and node ids are `[a-z0-9-]` so macOS's case-insensitive filesystem cannot collide with Linux's case-sensitive one. Four things need a deliberate choice, and all four are cheap **now** and annoying later:

|                        | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The lock**           | **An `O_EXCL` lockfile, not `flock`.** `fs.open(path, 'wx')` fails atomically if the file exists — on all three platforms. `flock` is POSIX-only and Windows has no equivalent. Same amount of code; write the portable one first. Store `{pid, started_at}` inside, written via `link` from a staged file so it never exists empty. A lock older than the longest legal write is **reported, not reclaimed** — see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Never auto-reclaim** | A stale lock is refused with `STALE_LOCK` and the operator clears it, the way git handles `index.lock`. Reclaiming cannot be made safe: the check that judges a lock stale and the removal that takes it are two operations, so a second writer can read the old holder, watch the first writer complete its whole reclaim, then move that **fresh** lock aside and append too. There is no POSIX compare-and-delete. §6.7 gives write authority to the orchestrator alone, so reclaiming was solving a problem this design does not have, at the cost of one it would. **Which message the operator gets is decided by a liveness probe, not by the clock**: `kill(pid, 0)` on the holder, where `EPERM` means alive-and-someone-else's and only `ESRCH` means gone. Age alone was a poor proxy for the first thirty seconds — precisely the window a crash is discovered in — and a fresh terminal was told "another writer holds it" while naming a corpse. PID reuse can make a dead holder look alive, which errs toward "someone may be writing"; the dangerous direction cannot happen. Cross-host pids are meaningless, which is one more thing §1's network-filesystem refusal buys |
| **Network-FS refusal** | Detecting a network mount properly needs `statfs` magic numbers on Linux, `statfs` flags on macOS and `GetDriveType` on Windows — none exposed by Bun. **Use a path heuristic** (Dropbox · iCloud · OneDrive · Google Drive) plus a `--force` escape. The risk is lower than it was, since only the append path remains                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **`kona view`**        | Three commands for one job: `open` · `xdg-open` · `start`. Or print the URL and let the user click it, which is what a localhost tool should probably do anyway                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **The fold**           | **Strip a trailing `\r` per line.** One line of code that covers both CRLF (git `autocrlf` on Windows, if a pursuit is ever committed) and part of the torn-line case §7 already tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Distribution: `bun build --compile` emits a platform-specific binary, so shipping `plugin/bin/` cross-platform means a target per OS. **For Friday, ship the TS and require Bun** — one artifact, no matrix.

---

## 2. Context

An LLM authors a workflow graph from a plain-language goal, a human approves it, and then **the model mutates its topology mid-run** as reality answers — fan-outs sprout, follow-ups appear on silence, paths reroute when a premise breaks. Every mutation is versioned with its rationale. Any fresh session reads the file and continues.

Runtime structural mutation is 2005–2012 prior art (ADEPT2), _including_ rationale-carrying change logs. It failed commercially because the mutator was an expert human with a BPMN editor. **The claim is the mutator, the irreversible timeline, and history-as-briefing** — never the mechanism.

---

## 3. Drivers

|        | Driver              | Concretely                                                                        |
| ------ | ------------------- | --------------------------------------------------------------------------------- |
| **D1** | Resurrection        | Fully reconstructible from `.kona/` alone. No session state.                      |
| **D2** | Safe mutability     | An LLM changes topology without orphans, cycles or unsatisfiable predicates.      |
| **D3** | Irreversibility     | No rollback. Exactly-once external effects across crashes. Compensate forward.    |
| **D4** | Mandatory rationale | Every change carries a machine-readable _why_, queryable by the next agent.       |
| **D5** | Legibility          | A human reads the graph and the diff, live, on a projector.                       |
| **D6** | Build cost          | Fits 12–14 h. Anything needing a server, a migration or a merge algorithm is out. |

**D1+D2 rule out deterministic replay** — determinism forbids mutation. **D3 rules out CRDTs** — they guarantee convergence, not validity, and these invariants must be _rejectable_.

---

## 4. Current state

Greenfield: `docs/` only. No source, no toolchain, no CI. Block 0's output is this document.

---

## 5. Options considered

| Decision               | Chosen                                          | Rejected, and why                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Substrate**          | Append-only JSONL, folded on read               | **Temporal / LangGraph / Burr** — replay forbids mutation; LangGraph checkpoints carry state and _zero_ topology; Burr refuses to rewrite its own graph. **Dolt** — cost Beads two dozen bugs. **SQLite** — honest runner-up and the migration path, but costs the `cat`-able file. **CRDT** — convergence ≠ validity. |
| **Resume model**       | Level-triggered reconciliation (K8s, Terraform) | **Replay** re-executes side effects. **Reactive tick** halts work mid-flight — catastrophic once an email is sent.                                                                                                                                                                                                     |
| **Mutation authority** | Typed closed op set, CLI-validated              | **Regenerating the plan** destroys node identity, and with it the binding between a node and the email it already sent. **Select-from-catalogue** (YAWL worklets) is the ceiling this breaks.                                                                                                                          |
| **Viewer**             | React Flow + dagre, read-only                   | **Mermaid** re-renders whole; identity, animation and camera die on every mutation.                                                                                                                                                                                                                                    |

---

## 6. The system

### 6.1 The file

```
.kona/
  mutations.jsonl   # THE FILE. append-only, fsync'd. Never compacted, never GC'd.
  lock              # O_EXCL lockfile, held only during a write (portable; see §1)
  rejections.jsonl  # §8's procedural memory. NEVER folded, not a system of record.
```

**Write order is the durability story:** `append → fsync → then take the side effect.` Never the reverse.

- The graph is `fold(mutations.jsonl)`. There is no snapshot to keep coherent.
- **`rejections.jsonl` is a third file and deliberately not a third system of record.** §8 requires a refused mutation to be remembered, and it cannot live in the log: `fold` needs versions to increment by one, and a refused batch changed nothing. Nothing folds this file, nothing decides anything from it, and deleting it loses memory rather than state — so the two-file rule's actual purpose, one system of record and no snapshot that can go stale against it, is intact. A stale base version is _not_ recorded: that is contention, not a defect in the batch.
- Activity payloads hold **handles and summaries, never bodies** — the read budget of an LLM re-reading the graph on resume is the real ceiling.
- JSON only, never pickle. `schema_version` on line 1.
- Refuse to run on a network filesystem; rename semantics corrupt on Dropbox/iCloud/NFS.

### 6.2 Nodes and edges

```jsonc
{
  "id": "gk-9x2t", // store-minted <prefix>-<hash>, [a-z0-9][a-z0-9-]*, never `/`
  "type": "action", // one of the NINE, §6.2's table
  "name": "Ask Dana to play Thursday",

  "spec": {
    // AUTHORED — changed only by a mutation op
    "instruction": "…",
    "inputs": [{ "ref": "roster.availability" }], // resolves to a DECLARED output
    "outputs": [{ "name": "reply", "type": "string" }],
    "effect_class": "pivot", // pure | reversible | compensatable | pivot
    "effect": {
      // required on pivot / compensatable
      "channel": "email",
      "recipient_ref": "roster.contacts#dana", // a ref, never a literal address
      "correlation": "ilya+kona-gk-9x2t@…", // FULLY EXPANDED
      "effect_key": "ek_9f2a…",
    },
    "compensates": null, // node id, if this action offsets an executed one
  },

  "status": {
    // OBSERVED — behaviour nodes only; a control node has none
    "state": "ready", // WHERE we are — §6.2.1
    "outcome": null, // WHAT was decided  (record_outcome)
    "output": null, // WHAT was produced (record_output)
    "conditions": [], // open list: {type, status, reason, at}
    "effect_log": [],
    "observed_at_version": 41,
  },

  "provenance": { "created_by_version": 12, "supersedes": null, "superseded_by": null },
}
```

**Nine node types, in two families.** The pursuit's graph IS the Activity; these are its nodes.

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

> **Behaviour nodes are worked by an agent. Control nodes are resolved by the store, at commit, with no model in the loop.**

Only `action` and `accept_event` carry `status`, `outcome`, `output` and `effect_log`. Only `action` appears in `kona next` or can be claimed; `accept_event` is polled. In the schema this is a discriminated union on `type`, not a shared shape with unused fields. Every control-node add uses `"spec": {}` exactly; behaviour-only fields are refused.

`accept_event` is what `wait` was, and keeps every rule §6.5 gives it: **three match kinds** — `{kind:"event"}` an inbound reply · `{kind:"human"}` a decision (the four kinds are `outcome.verdict` values) · `{kind:"predicate"}` a condition over the behaviour nodes beneath its in-edge. Every one requires a **`deadline`**, and its single out-edge must target a `decision`, which carries the timeout route. There is no `on_timeout` field.

**Three observed fields, three questions.** Conflating any two is how the worst probe bugs happened.

| Field            | Answers                        | Written by       |
| ---------------- | ------------------------------ | ---------------- |
| `status.state`   | where are we                   | `set_status`     |
| `status.outcome` | what was decided               | `record_outcome` |
| `status.output`  | what did this activity produce | `record_output`  |

`outputs` is what makes `inputs[].ref` mean anything — without the pair every ref dangles and a fresh subagent cannot execute (measured 0/8).

### 6.2.1 The lifecycle

**Seven states, on behaviour nodes only.** BPMN 2.0's Activity Lifecycle minus the compensation states.

| state        | written by                        | means                                                                     |
| ------------ | --------------------------------- | ------------------------------------------------------------------------- |
| `inactive`   | `add_node`                        | exists; its dependencies are not yet satisfied                            |
| `ready`      | **derived at commit**             | satisfied and unclaimed — _this is the frontier_                          |
| `active`     | `set_status` — a claim            | claimed; somebody is working it                                           |
| `completed`  | `set_status`                      | terminal success, and **the only state that satisfies a downstream edge** |
| `failed`     | `set_status`                      | tried, didn't work                                                        |
| `withdrawn`  | **derived at commit**             | never claimed; the flow went elsewhere                                    |
| `terminated` | `set_status`, or `supersede_node` | **was** claimed; stopped before it finished                               |

**Terminal** = `completed | failed | withdrawn | terminated`. **`active` is non-terminal** — a claim with an open effect means the real world's answer is unknown, not that the node resolved.

`failed` ≠ `withdrawn` ≠ `terminated`: "tried, didn't work" · "the flow went elsewhere and it was never started" · "somebody was working it and we stopped them". `supersede_node` picks between the last two from the state it finds, so an author never chooses.

**`ready` and `withdrawn` are the store's to write**, and an authored `set_status` naming either is refused: both are statements about the graph, not about the work.

**`ready → inactive` is the one transition BPMN has no equivalent for.** Insert a step in front of an available node — §6.4's growth shape, or any new blocking edge — and it stops being available. BPMN's lifecycle is monotonic because BPMN's topology does not change at runtime. Kona's does; that is the product.

**Readiness is derived and logged, not recomputed by readers.** At commit the store writes an explicit `set_status` op for each `inactive ↔ ready` transition. This is still reconstructible from the log alone and creates no snapshot beside it; it also lets the log answer _how long did an available step sit unclaimed_.

**One edge kind:** `{from, to, guard?}` — no identity. `{from: A, to: B}` means **B requires A**, with exactly one exception: an in-edge to a `merge` is a _disjunct_, since any one arm is enough.

A `guard` is legal only on an out-edge of a `decision` (S5), where it is mandatory and exactly one edge carries the explicit string `"else"` (S3). Absence never means else. It has exactly three forms:

```jsonc
{"guard": {"on": "accept"}}
{"guard": {"count": {"verdict":"confirmed","attrs":{"role":"goalie"}}, "op": ">=", "n": 1}}
{"guard": "else"}
```

**An `accept_event` may not fire anything directly** (S4): its single out-edge targets a decision. This replaces the old rule that every `wait` out-edge carried a condition; the unsafe direct route is now a shape the schema cannot hold rather than a check that can be forgotten.

Provenance is a **node field** (`supersedes`, `compensates`), never an edge.

**Deadlines, one of three shapes:**

```jsonc
{"at": "2026-08-22T17:00:00Z"}
{"after": "gk-9x2t", "duration": "48h"}   // must anchor to a BEHAVIOUR node
{"expr": "game_date - 24h", "backstop": "…", "after_unknown": true}
```

### 6.3 The mutation record

One line per commit. This is the differentiator; the schema makes omitting it impossible.

```jsonc
{
  "v": 42,
  "schema_version": 6,
  "observed_at": "…",  "occurred_at": "…",   // engine-stamped, never LLM-stamped
  "actor": { "kind": "orchestrator|subagent|human", "id": "exec-3" },
  "trigger": { "relation": "Trigger|Invalidate|Derive|Approve|Timeout",
               "kind": "email.reply", "from": "dana@…", "in_reply_to": "m-101", "body": "…" },
  "ops": [ … ],
  "rationale": {
    "why": "≤2 sentences",
    "expected_effect": "quorum(goalie) satisfiable by Fri",
    "alternatives_rejected": ["cancel the game"],
    "reason_code": "COUNTERPARTY_DECLINED | DEADLINE_PASSED | NEW_CONSTRAINT | MISSING_STEP | QUORUM_MET | CONTRADICTION | WITHDRAWN | OTHER"
  },
  "outcome": null      // WRITTEN LATER, ON EVIDENCE
}
```

- **`outcome` starts null.** No benchmark, N=1 — you cannot re-run "email twelve parents" and take the mean. An accept-event's resolution fills it in. _Rationale without outcome is a changelog; rationale with outcome is training data._
- **A rationale is never edited.** Append a new version referencing the old.
- **Suppression:** a re-plan producing a semantically equal fragment writes **no version**. Version mutations, not snapshots.

### 6.4 The six ops

```
add_node(spec)                                                -> $id
add_edge(from, to, {guard?})
set_status(node, status, evidence_ref)
record_outcome(node, verdict, evidence_ref, attrs?)               confirmed|declined|tentative|timed_out|bounced
record_output(node, output_name, value_or_ref, evidence_ref)
supersede_node(node, by?)                                         (never delete)
```

**Forbidden, no opcode reserved:** `delete_node` · `rollback` · `replace_graph` · `edit_rationale` · `reparent` · any write to a terminal node · coordinates · executable payloads · client-assigned ids.

- **Batch semantics pinned.** Ops apply in array order; invariants check once against post-commit state — **except invariant 1**, an op-delta predicate against pre-commit head. Internal order: additions and rewires before cancellations.
- **Intra-batch references:** `$0`, `$1` — the id returned by `ops[N]`. Forward and unresolved refs rejected. Never invent an id.
- **No op creates an edge you did not write.** Auto-wiring was the cause of every orphan a probe produced.
- **Fan-out** is `add_node` × N + `add_edge` × N in one batch. The atomic unit is the commit.

**Structure is judged over the LIVE subgraph.** A superseded node, and any edge with a superseded endpoint, is invisible to the arity rules and to S1–S7. Without it the graph could not grow: an `action` is 1-in/1-out, S2 demands every node reach a terminator, and there is no edge-removal op — so extending a branch that already ends would need a seventh. The sanctioned shape is **supersede the terminator, add the work, add a new terminator**: three ops, no new verb, and the log keeps the record that the branch used to end there.

**Branch resolution — the store does the housekeeping, never the agent.**

> When an accept-event resolves, the decision it feeds fires exactly one arm and the store marks the target of every untaken out-edge `withdrawn`, **transitively**: any node whose _every_ live blocking in-edge originates at an abandoned one is withdrawn too. It stops at a node still held by a live in-edge — a shared descendant, which survives. The cascade never writes `terminated`: it will not rewrite a claimed node, or one whose `effect_log` is non-empty, and those go to `withheld` for a human.
>
> An in-edge whose **source** is abandoned is **excluded** — it neither satisfies nor blocks. A `join` whose remaining live in-edges are all satisfied is satisfied; one with **zero** live in-edges is itself unreachable, and the unreachability propagates rather than hanging.
>
> **Readiness fails safe and does not inherit the exclusion.** A node is ready iff it is not abandoned and every live blocking in-edge has a terminal-_success_ source with its guard true. An abandoned source never satisfies readiness — otherwise the second node on an untaken branch has no blocker, lands on the frontier, and gets dispatched, pivot send included.
>
> **Satisfaction and deadness both carry ACROSS a control node**, per type: `initial` satisfies; `fork` passes its one in-edge to every arm; `join` is conjunctive; `merge` is disjunctive; a `decision` carries only the arm whose guard fired. Without this every graph returns an empty frontier — under S7 an action's single in-edge comes from a node that has no status to be `completed`.
>
> **A `failed` source is not abandoned.** It can never satisfy, so its subtree stalls — loudly, under a visibly failed node, which is better than the store silently deleting work someone is about to repair. A join inherits this, and §6.10 rule 11 requires the viewer to draw a parked join differently from a waiting one.

**Two derivations run at commit, in this order, and both emit explicit ops.** Routing and withdrawal first; **readiness second**. A node on an arm this commit just withdrew must not be lifted to `ready` and corrected after — the intermediate op would say the store offered work on a branch nobody took, which is the exact fail-safe above, undone by an ordering mistake rather than a rule change.

Every time the contract asked the model to tidy up, it forgot, half-did it, or was rejected for trying. **When the housekeeping is derivable, the store does it.**

### 6.5 Accept-events

```jsonc
"match": {
  "kind": "event",
  "conditions": [                                  // or-group, first-wins
    {"kind":"reply",    "in_reply_to":["<m-101>"], "from":"dana@…", "on":"satisfied"},
    {"kind":"deadline", "at":"2026-08-22T17:00Z",                   "on":"timeout"}
  ],
  "correlation": "ilya+kona-goalie-dana@…",        // DERIVED from the node id
  "cursor": {"last_seen":"…","last_checked_at":"…"},
  "memory": true,
  "resolution": null                               // satisfied | timeout | bounced | withdrawn
}
```

- **Correlation derives from the node id**, never minted per run — a token that changes across executions goes stale in someone's inbox. Specifically **the accept-event's id**, not the sender's: the two carry the same literal because they are one conversation, and the accept-event is the end that owns it. `record_outcome` targets the accept-event, so a reply has to route there; and a send can be superseded while the accept-event behind it survives, which is exactly the case where a sender-derived token would be reissued for a conversation already sitting in somebody's mail client. `kona brief` therefore looks _forward_ from the sending node, through any control nodes between them, to the accept-event it feeds — and **fails closed on more than one**, since guessing which accept-event a reply belongs to would advance the wrong arm under no-rollback. A send with no accept-event behind it gets no reply address at all; nothing is listening.
- **Reconciliation is truth; webhooks are a latency optimisation.** No provider offers a delivery guarantee strong enough to be state.
- **First-match-wins**, deduped on provider message-id. Evaluate-all would let one reply advance two fanned-out accept-events — unrecoverable under no-rollback.
- **Three cases the contract must name**, because a retry loop never converges on them: a reply arriving after its accept-event resolved is `record_outcome(verdict:"late")` and **never reopens** it; a tentative reply records without resolving; a satisfied predicate accept-event has the **store** withdraw its still-armed siblings.
- **An `accept_event` is polled, never claimed.** When armed it is `ready`, but it never appears in `kona next` and `kona brief` refuses it. A blown deadline records `verdict:"timed_out"`, sets the node `completed`, and lets the following decision select its `timeout`-guarded edge; there is no `on_timeout` field and `kona resume` does not add topology.

### 6.6 Irreversible effects

You cannot make a local write and an external effect atomic. The outbox is the admission of that.

```
1. kona effect reserve <node> --payload-hash <h>   → append intent, status: active, FSYNC
2. executor sends
3. kona effect record <node> --key <k> --outcome sent --message-id <id>
```

| Crash between       | Resume finds | Action                                                       |
| ------------------- | ------------ | ------------------------------------------------------------ |
| append and fsync    | nothing      | safe — nothing happened                                      |
| fsync and send      | `active`     | **safe to retry with the same key**                          |
| **send and record** | `active`     | **must ask a human.** The world's state is genuinely unknown |

- **`effect_key = hash(node_id, created_by_version)`** — **payload-independent by design**; `payload_hash` is computed at reserve. _The key names the slot; the hash proves the bytes were the ones approved._ Putting the body in the key makes the mismatch check unreachable, and the second email sends.
- Same key, **different payload_hash** ⇒ loud error in the viewer. Never a silent no-op, never a second send.
- A node with a non-empty `effect_log` is **never re-executed** — the CLI refuses.
- `attempted_at` ≠ `completed_at`; attempted-without-completion is **human adjudication**, not retry.
- **No per-node retry budget** — and the absence is load-bearing, not an omission. One node has exactly one slot, because the key is a function of `(node_id, created_by_version)`; a failed send makes the node terminal and invariant 1 forbids reopening it. So **retrying is superseding and replacing**: a new node, a new key, and a graph mutation the model must justify. A `max_reattempts` field was specified here and deleted — nothing could ever spend it, and a budget nothing can spend reads as a safety net that is not there.
- **What that moves, and where.** The research's actual demand — _"without a budget, an LLM mutator will retry forever"_ — is now carried entirely by **invariant 3(a)**, the pursuit-wide cap on cumulative irreversible sends. Which makes 3(a)'s budget, still undefined in §6.7, the only thing standing between a mutator and two hundred emails. **It is no longer optional.**

### 6.7 Invariants, concurrency, resume

**A three-tier rejection ladder, cheapest first. Every tier names the offending node.**

| tier           | checks                                                                                                                                                                                                                | needs                       | exit                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------- |
| **schema**     | legal `type` and `status`; the required fields for that type; guard well-formedness; a `name` on every behaviour node                                                                                                 | the batch alone             | **1** `REFUSED`             |
| **structural** | the arity table (§6.2) · **S3** every decision out-edge guarded, exactly one `else` · **S4** an `accept_event` routes to a decision · **S5** guards only from a decision · **S7** an `action` has exactly one in-edge | batch + head, one hop       | **1** `REFUSED`             |
| **invariant**  | **S1** exactly one `initial`, everything reachable from it · **S2** every node reaches a terminator · **S6** no cycles · the three below                                                                              | the whole post-commit graph | **4** `INVARIANT_VIOLATION` |

The split is the existing one: the first two tiers say _you wrote the op wrong_, the third says _the graph you would have made is unsound_. S1 and S2 make the orphan and the dead end **decidable**, which `prd.md` §15 R4 had to concede was "a logged judgment call" — without an initial node there is no definition of reachable, and without a terminator none of terminating.

**Then three invariants. Reject the commit, name the node.**

| #     | Invariant                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1** | **Terminal & effect protection** — an **op-delta** predicate, per-op against **pre-commit head**. For a node terminal at commit time: no new blocking edge into it, and no op targets it except `supersede_node` / `record_outcome` / `record_output`. No supersede of a node with a non-empty `effect_log` unless the same batch carries its compensation. **Existing** blocking edges into terminal nodes are untouched — they record how it became reachable.                                                                                       |
| **2** | **Predicate accept-events stay satisfiable** — the population is reached by traversing THROUGH control nodes to the behaviour nodes beneath, counting a `merge` disjunctively and a `join` conjunctively. `satisfiable iff matching_confirmed + still_live >= n`                                                                                                                                                                                                                                                                                       |
| **3** | **Effects are bounded and addressed** — (a) cumulative irreversible ATTEMPTS ≤ the approved budget, enforced at `effect reserve` and failing closed when no budget is configured. _Attempts, not confirmed sends: the two crash windows leave a reservation whose outcome is genuinely unknown, so a cap that only counted confirmed sends would be spendable without limit by crashing;_ (b) `recipient_ref` resolves to an entity already in the graph carrying an `evidence_ref`. **A recipient existing only in the proposing batch is rejected.** |

3(b) is not theoretical: at n=60 the mutator met an unsatisfiable predicate by **inventing counterparties and queueing email to them**, passing every other check — because the suite rewarded it.

**Predicate grammar**, one closed form: `{"count": {"verdict":"confirmed","attrs":{"role":"goalie"}}, "op": ">=", "n": 1}`. Reads only `outcome.verdict` and `outcome.attrs`; no other names resolve.

**Log, don't block:** a mutation touching a region containing `completed` or claimed nodes gets a `conflict` annotation surfaced in the viewer. When a new step should have preceded something already done, insert it at the first still-reachable successor and log the displacement. **Never rewrite the trace.**

**Concurrency, in order of what it buys:**

1. **Role-scoped write authority.** Only the orchestrator mutates topology; subagents `set_status` and write their own activity's output. This removes most of the need for locking.
2. **CAS on `--base-version` against head.** Exit 3 → re-read → re-decide, never blind-merge. _(54 cross-actor overwrites in Beads' data were median 31 minutes apart — the enemy is hand-offs, not races, so the fix is rejection.)_
3. **One macro-step per external event.** One inbound reply = one lock, one cascade, one version.
4. **Judgment-bearing fields are append-only** with actor + timestamp + rationale; the current value is a projection.

**Three verbs change contract.** `kona next` returns `action` nodes whose status is `ready` — never a control node, never an `accept_event`, which is polled rather than claimed — and each element carries the `fork` it descends from, so nodes sharing one are dispatched as a set. It also reports `complete` when the flow has reached its `final`, which an empty frontier alone cannot distinguish from _stuck_. `kona graph --json` renames `activities` → `nodes` and `edges[].condition` → `guard`, and `status` is absent on the seven control types. `kona brief` refuses a control node and an `accept_event`.

**Crash-resume — derivable from the file alone:** topology and per-node status · the frontier, recorded by commit-time readiness ops · every open accept-event's predicate, deadline, correlation and cursor · every irreversible action's `effect_key` and `effect_log` · every unresolved gate · the rationale chain for any node · which version the human approved.

**Resume is reconcile-then-repair:** fold → fire overdue timeouts → reconcile accept-events against the world → report claimed-with-an-open-effect unknowns. **Each repair is itself a logged mutation with a rationale.** Never re-execute a `completed` node — enforced in the store, not in a prompt. The loader is partial-tolerant: a damaged graph reports which nodes failed rather than dying.

### 6.8 The CLI — and the law

> **⚖ The `kona` binary never calls a language model.** Not once, not as a fallback. Every verb is a pure function of `mutations.jsonl` + the clock + the mailbox cursor.

| kona answers                                                                                                                                    | The plugin answers                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| what's ready · did a reply arrive · has the deadline passed · is the predicate satisfiable · which branches weren't taken · is this batch legal | **did Dana say yes** · **what should the plan become** · **what does this activity's work involve** |

Four things follow, which is why it is a law: §7's 100% mutation-score target is only affordable with nothing stochastic to mock; `kona resume` produces _one_ answer rather than a plausible one, which makes D1 a guarantee; cost is bounded by decisions rather than turns; and it is the positioning.

| Verb                                               | Contract                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `kona init`                                        | create `.kona/`, write `schema_version`, refuse on a network filesystem                    |
| `kona mutate --ops <f> --base-version N --why "…"` | **the only write path.** validate → lock → CAS → append → fsync                            |
| `kona graph --json [--version N]`                  | **the only read contract.** Status, history and the rationale chain are projections        |
| `kona next`                                        | ready `action` nodes from recorded state; each has `fork`, and the response has `complete` |
| `kona brief <node>`                                | §6.9                                                                                       |
| `kona poll`                                        | scan each armed accept-event's cursor; report what changed                                 |
| `kona resume`                                      | reconcile-then-repair                                                                      |
| `kona effect reserve\|record`                      | the §6.6 outbox — the only verbs that touch the world                                      |
| `kona view [--port]`                               | start the localhost viewer. **User-run, never plugin-spawned**                             |

**Exit status is 8-bit** (`409` truncates to `153`): `0` ok · `1` refused · `3` stale base version · `4` invariant violation. Every non-zero exit writes one stderr line beginning with a symbolic reason — `STALE_BASE_VERSION` (+ head), `INVARIANT_VIOLATION` (+ invariant and activity), `REFUSED` (+ reason).

**The reason token is the API; the code is a coarse class.** Exit `4` means precisely "the stderr line begins with `INVARIANT_VIOLATION`", which is invariants 1 and 2. **Invariant 3 exits `1`**, both halves, because neither is a transition guard: 3(b) is parser-class — does this string name somebody the graph already knew — and 3(a) is a ledger read at `effect reserve`, where the send actually happens. They carry `UNEVIDENCED_RECIPIENT` and `EFFECT_BUDGET_EXHAUSTED`, and §6.9's one human gate keys on those tokens rather than on the number. Worth stating because the trap is silent: a script branching on `-eq 4` alone misses the fabricated-counterparty case, which is the one it most wants to catch.

Hardcode the five queries the viewer needs. **No query language.**

### 6.9 The plugin

| Command              | Does                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/kona:plan <brief>` | LLM authors the graph as a batch of typed ops → CLI validates → viewer renders → human approves                                                                                      |
| `/kona:run`          | **The loop, carrying no bookkeeping.** `kona next` → dispatch verbatim → `kona poll` → **call a model only when an event needs a decision** → `kona mutate`. ~1 model call per cycle |
| executor skill       | consumes `kona brief`; returns `EXECUTED` (bytes moved) / `COMPOSED` (payload ready, not dispatched) / `REFUSED` (with `refusal_reason` **mandatory**)                               |

**`kona brief <node>` returns the action's subgraph plus three things the graph cannot know, or it refuses:**

| Block                     | Why the graph cannot know it                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`                | outgoing mailbox, display name, signature, **and an authority statement** ("you may not commit funds")                                            |
| `correlation`             | the **fully-expanded literal** reply-to and subject tag — a template variable that reaches a counterparty can never correlate                     |
| `preconditions_satisfied` | computed by the CLI, **fails CLOSED**: every input resolved · every upstream gate returned · budget remaining · `effect_key` reserved-and-unfired |

Plus `disclosable` — a per-field marking of what may appear in outbound content, or an agent will read an accept-event's internal timeout and turn it into a promise nobody authorised.

**Mutation is automatic — with exactly one gate.**

> **Automatic:** every topology mutation. Fan-out, reroute, follow-up, obviation, supersede-with-compensation, re-plan.
> **Gated:** a mutation creating a new irreversible effect targeting **a recipient not already evidenced in the graph.**

Narrow on purpose. Adaptive BPM died because change was expensive and blameful, so **changing the plan stays free**; what costs a human decision is _inventing a person to email_. **The plan changes freely; the world does not; and nobody new enters the world without a human.**

The approval object is a **frozen, content-hashed plan artifact** — the only defensible answer to "what exactly did the human approve?" A denial is a mutation: the human's verbatim text becomes its rationale. No timed auto-proceed. Gate op _classes_, never individual mutations.

**Two prompt rules, free from Beads' docs:** temporal phrasing inverts edge direction (force "Y needs X"), and numbering steps does not create sequence. Ship the §6.2 catalogue **verbatim** into the plan prompt — a paraphrase produced four stuck-gate defects. Require a premise check: 2 of 4 briefs referenced entities that do not exist and produced confident, approvable graphs anyway.

The plugin is **additive and trivially removable** — no git hooks, no daemon, no writes to `~/.claude/settings.json`.

### 6.10 The viewer

React Flow (fully controlled) + dagre `rankdir:'LR'`, positions derived every version, never stored. Read-only for topology; status intervention routes through the CLI so it lands in the log.

| #   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Build the diff animation first.** File change → re-layout → tween → flash the new subtree. The claim is only _visible_ if the viewer shows topology changing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2   | **Memoize dagre on a TOPOLOGY SIGNATURE; never re-layout on a status tick.** The signature must include the guard, which the rename moved from `condition` to `guard` — keyed on the old name it silently stops distinguishing arms, and a rewired decision returns a cached layout under a changed label. Burr's graph view froze on exactly this until July 2026, and the fan-out is where it bites. _(Corrected during E6: this rule originally said "memoize on `graph_version`", which defeats its own second clause — `graph_version` bumps on a status tick too, so keying on it re-runs dagre for every reservation, receipt and reply. The current signature is `{node id, type, superseded_by}` per node and `{from, to, guard}` per edge; eight of the fixture's thirteen versions change none of it, and five of those eight are the outbox. `packages/viewer/test/layout.test.ts` asserts the cache returns the IDENTICAL object across a reserve→record pair, because React re-renders on identity and an equal-but-fresh layout would defeat the memo at the only layer where it pays.)_ |
| 3   | **Collapse fan-out groups by default** — one container, aggregate status, edges redirected to it. The region is now STRUCTURAL: a `fork`, everything it dominates, up to its immediate post-dominator when there is one and each arm's terminator otherwise. Defined for an unjoined fork too, which is why §6.7 can leave well-nestedness a lint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 4   | **Every behaviour node renders its own state inline** — status chip, accept-event predicate, deadline countdown, predicate counter, and for a blocked action **the reason as text**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 5   | **The second panel is the mutation timeline** — version + op + rationale. _That panel, not the canvas, is the differentiator_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 6   | **The scrubber must look nothing like undo.** Read-only time travel, never revert-to-version-N                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 7   | Deterministic layout; **animate, don't snap.** Pin visual order by insertion order                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 8   | Three-colour accept-events: fulfilled / awaiting-within-deadline / deadline-blown — the hourglass badge's three colours                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 11  | **A parked node must not read as a waiting one.** §6.4 keeps a `failed` arm alive rather than abandoning it, so a join under one stalls forever by design. Unreachable means nothing can revive it; parked means nothing will happen until a person acts. Drawn the same, the second is the quiet hang this whole product exists to remove                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 12  | **Control nodes render as glyphs, not cards**, and carry no status chip because they have no status — but they ARE selectable. §3's argument for the model is that a branch point had no object to point at; an unclickable diamond delivers half of it. The Inspector shows a decision's out-edges in evaluation order with the fired arm marked, a merge or join's _k of n_, and a fork's arms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 9   | **Localhost only, zero outbound calls**, message bodies behind an explicit reveal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 10  | `kona graph --json` + file-watch is the **one** read contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**Do not build a graph editor.** An editable canvas is a second, unversioned mutator with no rationale.

### 6.11 The evaluation rig

The demo is **one task from Terminal-Bench 3** — `production-planning`, a supply-chain
problem that must reconcile ERP, MES and WMS and emit three SQL writebacks against twenty
constraint checks. `eval/` runs it twice, same model both sides, with and without Kona.
See [`eval.md`](./eval.md) for the design, the costings and the frozen pre-registration.

|           |                                                                                |
| --------- | ------------------------------------------------------------------------------ |
| Harness   | Terminus-2, inside Harbor — the harness the benchmark's own leaderboard uses   |
| Arms      | stock Terminus-2 vs the same plus `kona` on `PATH` and one `SKILL.md`          |
| Isolation | one container per arm; the store is a compiled `kona-bin`, no Bun in the image |
| Scoring   | reward is **binary** on this suite, so the comparison reads the per-check CTRF |

**What replaced the staged rig, and what was lost with it.** The earlier version drove a
hockey game through a real mailbox — plus-addressed Gmail, a persona sender, Mailpit as the
offline fallback — and its 69 tests are the reason several claims below carry measurements.
It is deleted: one demo, and it is the benchmark. The measurements stand as history; the code
that produced them does not, and §12 says so rather than implying the proof is still runnable.

### 6.12 Packages

```
core/     types, vocabularies, validators, the 6 ops, 3 invariants, branch resolution.
          ZERO deps. PURE: no fs, no clock, NO MODEL.
kona/     fold, .kona/ layout, lock + CAS, waits, outbox, resume, the 9 verbs.
          The only thing that writes.
viewer/   React + xyflow + dagre. Depends on core ONLY.
eval/     the measurement rig — a directory, not a package
plugin/   .claude-plugin manifest, skills, hooks, bin/ ← the compiled binary
```

**The dependency graph enforces three rules prose can only assert:** the viewer cannot import the store because it does not depend on it; exactly one package calls `writeFile`; and `core` being pure is what makes the 100% mutation-score target affordable.

It mapped onto the four windows — W1 `core`, W2 `kona`, W3 `viewer`, W4 the rig — so each owned packages rather than files. W3 and W4 unblock when **`core` compiles**, roughly 50 minutes in.

---

## 7. Testing

**Gates:** `bun run lint` and `bun run typecheck`, clean. Coverage and mutation score are **targets, not gates**.

Per-package Stryker floors where mutation testing pays: **`validate()` and `fold()` at 100** — pure, branch-heavy, and a surviving mutant is a bad graph reaching the file — outbox 100 · CAS/lock 95 · the rest 90 · viewer excluded. If only one suite gets written, write `validate()`. _Equivalent mutants are unkillable by construction; exclude them with a written reason, reviewed like code._

**Unit, written first:** `fold` determinism and torn-line tolerance · one test per invariant asserting **rejection with the right reason** · the suppression rule · `effect_key` across all three crash windows · CAS and lock release on crash · op ordering · branch-withdrawal transitivity.

**Integration:**

| Test                     | Asserts                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kill -9` mid-mutation   | restart makes progress with zero session state; **nothing re-sent**                                                                                                                                                                                                                                                                                                                                                    |
| Duplicate-send guard     | crash between reserve and record ⇒ claimed with an open effect, no re-send, human surfaced                                                                                                                                                                                                                                                                                                                             |
| Fan-out → predicate      | replies out of order; the predicate flips once; siblings become `withdrawn` with a rationale                                                                                                                                                                                                                                                                                                                           |
| Premise break            | the only goalie declines ⇒ invariant 2 forces a re-plan rather than a silent bad graph                                                                                                                                                                                                                                                                                                                                 |
| **Divergent arms**       | from a v1 plan where every arm is identical, assert **(a)** an activity no v1 activity's shape describes · **(b)** a counterparty absent from the v1 roster · **(c)** three arms with pairwise different activity counts · **(d)** an arm with an edge leaving its own group. _Pass and the run produced structure no parameterised fan-out could. Fail and the system behaved as `withParam` regardless of the code._ |
| Untaken arm, two deep    | both nodes end `withdrawn`, neither appears in `next`, neither reserves an effect, the join satisfies rather than hanging                                                                                                                                                                                                                                                                                              |
| Late reply after timeout | lands as a logged outcome; does **not** reopen a completed accept-event                                                                                                                                                                                                                                                                                                                                                |

Six of these seven survive as unit tests in `core` and `kona` — branch withdrawals, the crash
windows, the predicate flip, the timeout. **Two do not.** _Divergent arms_ was asserted by the
staged rig's `assertions.ts` and went with it, and the `kill -9` row is now covered only in
simulation: `packages/kona/test/kill-resume.test.ts` reproduces the states a crash leaves —
a torn line, a stale lock, an open reservation — but a process cannot kill itself mid-syscall
inside a test, so what proved the simulation faithful was a real signal to a real process
group, and that is gone (§6.11). Naming it here rather than leaving the table implying
otherwise: a test suite that quietly stops asserting something is worse than one that says so.

---

## 8. Definition of Done

Each line names where it is enforced, because a checklist that cannot be re-checked by a
stranger is a memory rather than a definition.

- [x] `bun run typecheck` and `bun run lint` clean — plus `knip` and 1,200 tests, as `bun run check`
- [x] **`--why` is required on every mutating verb** — `cli.test.ts` "a commit without a rationale is impossible"; `--reason-code` is checked against the closed vocabulary, so `BECAUSE` is refused too
- [x] All 3 invariants enforced pre-commit, each with a distinct rejection naming the activity; the parser rejects shape first — `TERMINAL_ACTIVITY_PROTECTED` / `UNCOMPENSATED_SUPERSEDE`, `PREDICATE_UNSATISFIABLE`, `EFFECT_BUDGET_EXHAUSTED` / `UNEVIDENCED_RECIPIENT`. Invariant 1 is an **op-delta against pre-commit head**, never a post-state predicate
- [x] **Rejected mutations are logged** — `.kona/rejections.jsonl`, best-effort and never a system of record. a live run read back the two refusals it produced, with the rationale each carried (measured before the staged rig was deleted; §6.11)
- [x] No `delete_node` verb and no `rollback` opcode anywhere in code or schema — `FORBIDDEN_OP_KINDS` exists so the check has something to assert against; `purity.test.ts` greps `core` for the strings and `contracts.test.ts` proves the parser refuses each
- [x] Folding the log twice yields an identical graph; a torn final line is tolerated — and `dropTornTail` truncates by BYTES before the next append, so a torn line cannot be buried mid-file where it stops being a tail
- [x] Nothing outside the CLI reads or writes `.kona/`; **no verb calls a model** — the purity gate is three mechanisms (a tsconfig with `types: []`, an oxlint override, and a test for what still typechecks), and a test greps the plugin's hook script for `.kona`
- [x] `kona resume` on a fresh terminal prints correct status in **< 60 s** with no session state — **measured at 135 ms**, after a real `SIGKILL` to a real process group, eleven times — measured before the staged rig was deleted, and no longer reproducible in-repo (§6.11)
- [x] Every irreversible node carries a payload-independent `effect_key`; the three crash windows behave per §6.6 — the key is `hash(node_id, created_by_version)` and the `payload_hash` proves the bytes, so re-reserving the same slot with different bytes is `EFFECT_PAYLOAD_MISMATCH` rather than a second send
- [x] Only the orchestrator mutates topology; a subagent attempting it is refused — and invariant 2 EXEMPTS a subagent from the satisfiability check, because an actor that cannot author the repair must not be blocked for failing to include one
- [x] Viewer holds zero authoritative state; dagre memoized on a **topology signature** (see §6.10 rule 2 — the original wording named `graph_version`, which re-layouts on the status ticks the same rule forbids); zero outbound calls
- [x] Startup refuses on a network filesystem — path heuristic for Dropbox / iCloud / OneDrive / Google Drive / UNC, with `--force`
- [ ] Repo public before the demo. **`probes/` and `research/` are withheld** — reversed from the original "with `probes/` and `research/`", which read the receipts as the deliverable. They are not: the findings are, and those are in §11, in the three design documents, and in a comment at every decision they justify. The concessions ledger in §11 is public, which is the part that names what this owes to prior art

---

## 9. Alternatives not chosen

|                                  | Why                                                                                                                                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Temporal / Cadence / Restate** | Deterministic replay forbids mid-flight mutation and re-executes side effects. Their own framing concedes it: _"deterministic in execution… but not predetermined"_                          |
| **LangGraph**                    | Checkpoints carry state and **zero** topology. `Send` fans out N invocations of one _pre-declared_ activity; Kona's fan-out creates N nodes with distinct types, accept-events and deadlines |
| **Burr**                         | Closest shipped neighbour and the source of the viewer stack — but its writer refuses to rewrite `graph.json`, the human sits _outside_ the graph, and it performs no validation             |
| **BPMN engines**                 | Runtime modification ships — as a _privileged human repair tool_. Camunda: _"an activity which tries to modify its own process instance can cause undefined behavior"_                       |
| **CRDTs**                        | Convergence ≠ validity. Nothing can _reject_ a merge                                                                                                                                         |
| **Dolt / SQLite**                | SQLite is the documented migration path; both cost the `cat`-able file and the readable diff                                                                                                 |
| **Mermaid for the live view**    | Full re-render destroys activity identity, animation and camera                                                                                                                              |
| **Select-from-catalogue**        | Precisely the ceiling Kona breaks: _worklets chose from a catalogue a human wrote; Kona writes the sub-flow_                                                                                 |
| **MCP server in v1**             | Design for it, don't build it. A large tool surface costs ~21k tokens/turn                                                                                                                   |
| **Compacting the log**           | Beads' `compact` made 42 of 43 sampled version addresses vanish. The history is the product                                                                                                  |

---

## 10. Open questions

|        |                                                                                                                                                                                                                             |                                                                                                          |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Q1** | **Nothing verifies the pursuit's premises.** 2 of 4 authoring briefs referenced entities that do not exist and 8/8 runs produced confident, approvable graphs anyway                                                        | Mitigated by a prompt requirement, enforced by nothing. The failure most likely to survive into real use |
| **Q2** | **The irreversible send has never been exercised.** Both execute arms of the brief probe composed a correct payload and stopped at the transport                                                                            | First integration test after Block 1                                                                     |
| **Q3** | **Re-measure the retry loop.** At n=60 it converted 19 loud rejections into 19 silent commits — **negative expected value** under the old suite. Invariants 1 and 3(b) are what flip it, and that is asserted, not measured | The natural next probe                                                                                   |

**Recorded for honesty:** what fills `outcome` for a diffuse mutation whose effect never gets its own accept-event; whether the rationale log is genuinely reusable as memory _within_ one pursuit (AWM, the closest published work, reports offline workflows _impairing_ online ones); and that the probes ruled out catastrophes without producing reliability numbers — brief-v2's 10/10 is effectively n≈5, consistent with a true failure rate up to 26%.

---

## 11. References

**The evidence base is not published, and citations to it will not resolve.** `probes/` is six
runs — mutator v1/v2/v3, authoring+briefing, brief-v2, the eight-lens review — and `research/`
is 200 technologies across 14 categories plus `00-design-lessons.md`. Both quote primary
sources at length, and the probe transcripts are raw model output from runs written for us and
nobody else.

What that costs a reader is the transcript, not the finding. Every claim either directory
supports is stated here with its measurement — the n=60 mutator inventing counterparties, the
2-of-4 briefs referencing entities that do not exist, the 0-of-8 to 10-of-10 swing from
pairing inputs with outputs, the 19 loud rejections that became 19 silent commits. A citation
you cannot open is still a claim you can check against the code that enforces it.

**Concessions ledger:** Reichert & Dadam, _ADEPTflex_ (1998) / _ADEPT2_ (ICDE 2005) · Schonenberg et al., _Taxonomy of Process Flexibility_ (CAiSE'08) · Ellis, Keddara & Rozenberg (1995), the dynamic change bug · Adams et al., YAWL worklets & exlets · Reijers, _Workflow Flexibility: The Forlorn Promise_ (2006) · Zhang et al., _AFlow_ (ICLR 2025) · Wu et al., _StateFlow_ (COLM 2024) · Garcia-Molina & Salem, _Sagas_ (1987).

⚠ **Cite Beads accurately:** it is Dolt-backed and `issues.jsonl` is an export, _"not the source of truth."_ The frozen SQLite+JSONL architecture Kona imitates is `beads_rust`/`br`.
