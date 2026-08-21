# Technical Specification (SPEC) — Project Kona: the living workflow graph

**Status:** Draft — awaiting approval · **Owner:** Ilya Vorobiev · **Date:** 2026-08-21
**Constraint:** one operator, four parallel Claude Code windows, 12–14 hours, demo Aug 22 @ AGI House.

> Every decision below is argued from `docs/research/` — a 200-technology prior-art library compiled 2026-08-21
> by 69 research agents, distilled in [`research/00-design-lessons.md`](./research/00-design-lessons.md).
> Citations read `(see 04 — ADEPT2)` → `docs/research/04-*.md`, section `## ADEPT…`.
> Where the research **contradicts the PRD**, it is called out rather than smoothed over (§6.11, §11).

---

## 0. TL;DR

**The graph is a fold over an append-only mutation log, and nothing else is the truth.** `.kona/mutations.jsonl` is the system of record; `graph.json` is a derived projection you can delete at any time. Folding is a pure data operation — it is **not** Temporal-style replay and never re-executes an action. That single inversion is what lets Kona have crash-resume *and* mid-run topology mutation at once; every replay-based engine in the survey buys resume by forbidding mutation (see 03 — Temporal).

- **6 node types · 11 mutation ops · 7 enforced invariants (+5 lint rules) · ~17 CLI verbs. Nothing else.** Conceptual sprawl is a named cause of death (see 01 — Gas Town). Ops grew 9→11 because two probes found the vocabulary could not express what it needed to (an accept and a decline emitted identical ops; every `inputs[].ref` resolved to nothing). Invariants **shrank** 11→7 for the opposite reason: across 40 proposals only 4–5 ever fired, and one of them was rejecting *correct* work. See `probes/`.
- **Three observed fields, three questions:** `status.state` = *where are we* · `status.outcome` = *what was decided* · `status.output` = *what did this node produce*. Conflating any two is how both probes' worst bugs happened.
- **`--why` is a required argument on every mutating verb.** No rationale, no commit. All 200 technologies surveyed either lose the *why* or keep it in a file decoupled from the version — that gap is the product.
- **No rollback, no `delete_node`, and `rollback` is not even reserved as an opcode.** YAWL kept it in the enum while its validator hard-rejected it, which just misled tool authors (see 04 — YAWL).
- **Only the orchestrator mutates topology.** Subagents `set_status` and write their own node's output. That one rule removes most of the need for locking (§6.7).
- **Mid-run mutation is fully automatic — no approval gates on topology, ever.** One pre-execution approval scopes the whole pursuit; a declared effect budget is the circuit breaker. Gate on irreversible *effects*, never on *mutations* (§6.9).
- **Stack:** TypeScript on Bun (CLI + viewer, one toolchain) · React + Vite + `@xyflow/react` + dagre, fully controlled, read-only · JSONL + JSON on disk. No database, no daemon, no CRDT, no server.
- **Mailboxes: DECIDED — one plus-addressed Gmail, $0** (§6.11). The correlation token lives in Kona's own `Reply-To` (`ilya+kona-<node_id>@…`), so the fan-out needs 30 *tags on one inbox*, not 30 inboxes. Mailpit is the offline fallback behind the same port.
- **⚠ One thing still needs Ilya before Block 4 (§11 Q2): the demo needs a beat where two fan-out arms end up structurally different**, or a knowledgeable reviewer correctly calls the whole thing `withParam` with extra steps.

---

## 1. Meta Information

- **Branch:** `spec/block-0-graph-store`
- **Epic:** Block 0 — graph schema + storage contract (PRD §14); the serial dependency for Blocks 1–4
- **PRD:** [`./prd.md`](./prd.md) (v3.9, 2026-08-20)
- **Research:** [`./research/00-design-lessons.md`](./research/00-design-lessons.md) + 14 category docs + `README.md`
- **Supersedes:** nothing. First SPEC in the repo.

---

## 2. Context

Kona is a state layer for long-horizon agents: a **living workflow graph** that is simultaneously the plan, the durable state, the progress record, and the memory of a multi-day pursuit. The model authors it from a plain-language brief, a human approves it, and then **the model mutates its topology mid-run** — fanning out per-counterparty sub-flows, sprouting follow-ups on silence, rerouting when a premise breaks — with every mutation versioned and carrying its rationale. Any fresh session reads the file and continues.

This SPEC is PRD §14's **Block 0**: the schema, on-disk formats, mutation vocabulary, command contract, and technology choices that Blocks 1–4 build against in parallel. The PRD is explicit that all technology choices are made here, and that agents must not improvise the schema independently.

**The positioning constraint that drives the design.** Runtime structural mutation of a running workflow is 2005–2012 prior art (ADEPT2/AristaFlow), and its change logs already carried *"change reason and change performer."* It failed commercially because the mutator was an expert human with a BPMN editor. Kona's claim is **the mutator is an LLM, on an irreversible timeline, and the version history is the next agent's briefing** — so the mutation record is not an audit column bolted on at the end. It is the primary artifact, and the schema must make omitting it impossible.

---

## 3. Key Technical Drivers

| # | Driver | Concretely | PRD |
|---|---|---|---|
| **D1** | **Resurrection** | The pursuit is fully reconstructible from `.kona/` alone. No session state, no daemon memory, no asking the model what it was doing. | US5, §7 (f) |
| **D2** | **Safe mutability** | An LLM changes topology mid-run without orphans, cycles, unsatisfiable quorums, or duplicate sub-flows. | US2, US4, §7 (b) |
| **D3** | **Irreversibility** | Emails cannot be un-sent. No rollback; exactly-once external effects across crashes; compensate forward. | §7 (d), R4 |
| **D4** | **Mandatory rationale** | Every change carries a machine-readable *why*, queryable by the next fresh-context agent. | US3, §7 (c) |
| **D5** | **Shared substrate** | Orchestrator + N fresh-context subagents on one graph, no corruption, no double-sends. | US7, §7 (e) |
| **D6** | **Legibility** | A human reads the graph, the diff and the reason — at 60+ nodes, on a projector, live. Unreadable = demo failed even if the code works. | R1, R2 |
| **D7** | **Build cost** | Fits the 12–14h box across four windows. Anything needing a migration, a server, or a merge algorithm is out. | §14 |
| **D8** | **Demo survivability** | Nothing fragile happens live. Every external hop has an injection fallback. | R5 |

**The pairs that kill options.** D1+D2 rule out deterministic replay (determinism forbids mutation). D3+D5 rule out CRDTs (they guarantee convergence, not *validity* — and Kona's invariants are validity constraints that must be rejectable).

---

## 4. Current State

Greenfield. At spec time: `docs/` untracked, no source, no toolchain, no CI.

| Component | State |
|---|---|
| `docs/prd.md`, `docs/prfaq.md` | v3.9, approved shape, four blocks defined |
| `docs/research/` | 200 technologies · 14 category docs · synthesis · index — the evidence base for this SPEC |
| Source, tests, toolchain, CI | **None.** Block 0's output is this document; Block 1 writes the first line of code. |

| Block | Window | Depends on |
|---|---|---|
| 1 — Storage (`kona` CLI) | W1 | §6.1–§6.8 |
| 2 — Plugin (orchestrator + executor) | W2 | §6.8 CLI contract, §6.9 |
| 3 — Viewer | W3 | §6.10 — `kona graph --json` **only** |
| 4 — Demo rig | W4 | §6.11 — the `MailboxProvider` port |

**Contract rule:** Blocks 2–4 touch `.kona/` **only** through the CLI. Beads' entire third-party UI ecosystem had to be rewritten when its file format changed; read through the binary, not the file (see 01 — Beads).

---

## 5. Considered Options

Four genuine architectural forks. Everything in §6 follows from these.

### 5.1. Decision 1 — the storage substrate

| | Description | Verdict |
|---|---|---|
| **O1** Existing durable engine (Temporal / LangGraph / Burr) + sidecar | Engine owns execution; a parallel file describes the graph | **Rejected — fatal.** Temporal forbids mid-flight mutation by construction; LangGraph checkpoints carry `channel_values` and **zero** topology; Burr's writer refuses to rewrite `graph.json` (*"Graph already exists … Not overwriting"*). Two sources of truth diverge immediately. (03, 02) |
| **O2** Embedded versioned SQL (Dolt) | Cell-level branch/diff/merge | **Rejected.** Beads' Dolt migration failed in the field badly enough that community members published third-party migration gists; cell merge yields logically *valid-but-wrong* rows — exactly what the invariants exist to prevent. (01, 09) |
| **O3** SQLite + WAL + a `mutations` table | CLI sole writer, `BEGIN IMMEDIATE`, viewer read-only | **Honest runner-up**, and the documented migration path. Rejected for the demo: it costs the `cat`-able file and the readable diff — two of the three visceral deltas R1 depends on — and adds a schema-migration surface mid-hackathon. (09) |
| **O4** **Append-only JSONL + derived JSON snapshot** | `mutations.jsonl` is truth; `graph.json` is a rebuildable projection; `flock` + CAS | ✅ **CHOSEN** — see below |
| **O5** CRDT (Automerge / Yjs / Loro) | Multi-writer merge, no coordination | **Rejected.** Convergence ≠ validity; nothing in Automerge can *reject* a merge. Kona has a single authoritative writer on one machine — precisely the centralised case where CRDT complexity buys nothing. Named in PRD R6 as a scope-blowout signal. (09) |
| **O6** Git-as-database, commit per mutation | `git merge` as the write protocol | **Rejected.** Line-based and semantically blind. Beads' clobber data — 54 cross-actor overwrites, median 31 min apart, none inside any plausible conflict window — proves the enemy is **hand-offs, not races**, so merging would have prevented zero of them. (01, 09) |

**Why O4.** Every mature system in the survey independently converges on the same three primitives — an append-only log of fine-grained ops, a derived materialized snapshot, and exactly one serialising writer (Datomic, XTDB, Dolt, SQLite WAL, KurrentDB, Braintrust, Memgraph, ADEPT2's delta overlay). O4 is those three primitives with zero dependencies, and the log is simultaneously the rationale record, the viewer's scrubber and the procedural memory — one mechanism, four claims.

| Driver | O1 | O2 | O3 | **O4** | O5 | O6 |
|---|---|---|---|---|---|---|
| D1 Resurrection | + | + | + | **+** | + | + |
| D2 Safe mutability | **−** forbidden | ~ | + | **+** | **−** no validity | ~ |
| D3 Irreversibility | **−** replay re-fires | + | + | **+** | − | + |
| D4 Rationale | **−** no field | ~ bolt-on | + | **+** structural | − | ~ commit msg |
| D5 Shared substrate | + | + | + | **+** CAS+lease | + | − |
| D6 Legibility | − | − | ~ | **+** `cat`-able | − | + |
| D7 Build cost | − | **−** | + | **+** | − | ~ |
| D8 Demo survivability | ~ | − | + | **+** | − | ~ |

### 5.2. Decision 2 — the execution & resume model

| | E1 Deterministic replay | **E2 Level-triggered reconciliation** | E3 Reactive tick |
|---|---|---|---|
| Exemplar | Temporal, Durable Functions, Golem | Kubernetes, Terraform, Argo CD | Behavior Trees, teleo-reactive |
| Resume = | re-run code against the event log | read declared state, compute what remains unsatisfied, act | re-walk from root each tick, `halt()` anything mid-flight |
| Mutation | forbidden | ordinary in-band data edit | free, but status is re-derived |
| Irreversible acts | **re-fires** | never re-fired; status durable + monotonic | **halted mid-flight** |
| Verdict | Rejected — D2, D3 fail | ✅ **Chosen** — the only model where D1+D2+D3 co-exist | Rejected — D3 fails |

**The distinction to state precisely, because it is the sharpest technical objection:** folding a mutation log is a pure function over data and produces no side effects; replaying a Temporal workflow re-executes code. **Kona folds; it never replays.** (see 03 — Temporal; 06 — Kubernetes, Behavior Trees)

### 5.3. Decision 3 — who may change the graph, and how

| | M1 Regenerate the plan | M2 Select from a catalogue | **M3 Typed closed op set** |
|---|---|---|---|
| Exemplar | Plan-and-Execute replanners; AFlow's `write_graph_files` | YAWL worklets, CMMN planning tables | ADEPT2 change ops, py_trees `insert/prune/replace`, Zeebe batch modification |
| Node identity | **destroyed** — loses the binding between a node and the email it already sent | preserved | preserved |
| Invariants | uncheckable | checkable, ceiling is "no new structure" | checkable per-op, pre/post-conditioned |
| Verdict | Rejected — breaks D1 and D3 | Rejected as architecture; **kept as the pitch's ablation baseline** | ✅ **Chosen** |

The research is unanimous: **every system that works constrains the LLM to named, typed operations** — AFlow's `operator.json`, Self-Discover's seed modules, FlowMind's vetted API set, EvoAgentX's schema validation. And the strongest negative evidence: Graphiti's worst production bug (#1728) was an LLM handed a globally-retrieved candidate list of bare fact strings and told to pick what to invalidate — **41% of one deployment's facts ended up wrongly retired.** *Never let a mutation name its target by fuzzy description.* (see 05; 07)

### 5.4. Decision 4 — the viewer

| | V1 Mermaid | V2 Cytoscape / G6 | **V3 React Flow + dagre** | V4 tldraw |
|---|---|---|---|---|
| Re-render | **full rebuild of the SVG** | delta | delta, fully controlled | canvas records |
| Live mutation | **fatal** — identity, animation, pan/zoom destroyed | good | good | good |
| "Click a node, read why" | — | hit-testing project (Canvas) | a `<div>` (DOM nodes) | canvas |
| Cost to first pixel | minutes | hours | **~1h — Burr ships exactly this stack** | hours |
| Verdict | Rejected for live view; **kept for the pre-execution approval snapshot only** | Runner-up | ✅ **Chosen** | Rejected — not OSS for production |

(see 10 — React Flow, Mermaid; 02 — Burr)

---

## 6. Proposed Solution

### 6.1. On-disk layout — `.kona/`

```
.kona/
  mutations.jsonl   # SOURCE OF TRUTH. append-only, fsync'd. Never compacted, never GC'd.
  graph.json        # materialized head. DERIVED. Safe to delete; rebuilt by folding.
  events.jsonl      # inbound world events (replies, deadline fires, bounces, injections). append-only.
  blobs/<sha256>    # email bodies, attachments — pointer-not-payload
  plan/<hash>.json  # frozen, content-hashed approval artifacts
  schema.json       # the closed node/op vocabulary, versioned
  lock              # flock target; exists only while a mutation is in flight
```

**Write order is the whole durability story:**
`append the mutation → fsync → materialize graph.json → then take the side effect.`
That is Braintrust's WAL-then-compact in miniature and Memgraph's snapshot+WAL recipe, and it makes Langfuse's flush-loss failure mode impossible. **Persist the mutation, then act; never act then log.** (see 08 — Braintrust, Langfuse, Helicone; 09 — Memgraph)

| Rule | Why | Source |
|---|---|---|
| **Never compact or GC the log** | After `bd compact --days 7`, **42 of 43** sampled version addresses vanished, invalidating every published reference. Kona's history *is* the product. | 01 |
| `graph.json` is deletable and rebuilt by folding | Makes D1 real rather than aspirational; also the recovery scan | 03 — DBOS |
| **Node payloads hold handles and summaries, not bodies** | The file must stay small enough for an LLM to re-read whole on every resume — *that read budget, not a service quota, is Kona's real ceiling.* Temporal dies at 51,200 events; Argo at a 1 MB etcd cap. | 03; 02 |
| **JSON/JSONL only, never pickle** | MS Agent Framework had to build a restricted unpickler; Voyager #194 is RCE from a downloaded checkpoint | 02, 05 |
| **No coordinates. Ever.** | Two agents will conflict on cosmetics | 10 |
| `schema_version` from commit one | LangGraph #536 has been open two years for want of it | 02 |
| Refuse to run on a network filesystem | rename/WAL semantics corrupt on Dropbox/iCloud/NFS | 09 |
| `.kona/` trivially gitignorable | so it does not pollute every PR | 01 — Gas Town |
| No git hooks, no daemon, no writes to `~/.claude/settings.json` | The #1 reason people rip Beads out — there is a community uninstaller | 01 |

### 6.2. Node schema — declared vs observed

The most-repeated structural lesson in the survey: **every mature system separates the declared part from the observed part** (Terraform config/state, Kubernetes spec/status, HTN method-tree/trace, Argo CD git/cluster). Kona splits them inside the node and stamps the version each observation was computed against.

```jsonc
{
  "id": "goalie/dana",              // stable, human-meaningful, minted at creation.
                                    // NEVER derived from position or content (see 14 — Adapton, Nix)
  "type": "task",                   // task | wait | gate | join | quorum | group
  "label": "Ask Dana to play Thursday",   // REQUIRED on every node type

  "spec": {                         // AUTHORED. Changed only by a mutation op.
    "instruction": "…",             // for the HUMAN/executor. Never load-bearing: see the prose ban below
    "inputs":  [{ "ref": "roster.availability" }],   // resolves to a DECLARED OUTPUT, never prose
    "outputs": [{ "name": "availability", "type": "date[]" }],  // ← what this node PRODUCES
    "merge": "all",                 // all | any — REQUIRED on any node with >1 blocking in-edge

    "effect_class": "pivot",        // pure | reversible | compensatable | pivot   (see 11; 09 — Sagas)
    "effect": {                     // REQUIRED on every pivot/compensatable node
      "channel": "email",
      "recipient_ref": "roster.contacts#dana",   // a ref, never a literal address in prose
      "correlation": "kona+goalie-dana@…",        // FULLY EXPANDED. no template variables
      "payload_ref": "sha256:…",
      "effect_key": "ek_9f2a…"      // minted at NODE CREATION, not at execution
    },

    "obviated_if": "quorum:goalie >= 1",            // (see 12 — BB1)
    "max_reattempts": 3, "window": "1h"             // restart budget (see 12 — Erlang/OTP)
  },

  "status": {                       // OBSERVED. Written by executors.
    "state": "waiting",             // WHERE we are — lifecycle only
    "outcome": null,                // WHAT was decided — written only by record_outcome
    "output": null,                 // WHAT was produced — written only by record_output
    "conditions": [                 // OPEN list, not an enum
      { "type": "WaitSatisfied", "status": "False", "reason": "NoReply", "at": "…" }
    ],
    "effect_log": [],               // §6.6 — the result, not a flag
    "attempted_at": null, "completed_at": null,
    "observed_at_version": 41       // viewer greys out status stale w.r.t. head (see 06 — K8s)
  },

  "provenance": {
    "created_by_version": 12,
    "group": "goalies",             // the fan-out container node
    "template_id": "ask_goalie_v1", "instance_key": "dana",
    "supersedes": null
  }
}
```

**`outputs` is the field the briefing probe proved was missing, and without it half the design is decorative.** §6.2 has always said *reference-by-node-id, NEVER prose* (ReWOO, see 05) — but no node declared an output, so every `inputs[].ref` was a dangling pointer. A fresh subagent reported it verbatim: *"All six `inputs[].ref` on the nodes upstream of me name a node id and resolve to nothing. Even if every upstream node had run perfectly, this brief would look identical to me."* Result: **0/8 executable, 7/8 one compliant step from a wrong irreversible send.** See `probes/authoring-briefing.md`.

**Three observed fields, three different questions.** Conflating any two of them is how the probes' worst bugs happened:

| Field | Answers | Written by |
|---|---|---|
| `status.state` | *where are we?* | `set_status` |
| `status.outcome` | *what was decided?* | `record_outcome` |
| `status.output` | *what did this node produce?* | `record_output` |

**Deadlines are typed, one of three shapes** — eight authoring trials invented four incompatible shapes and shipped two deadlines already in the past at creation:

```jsonc
{"at": "2026-08-22T17:00:00Z"}                       // absolute
{"after": "invite@dana", "duration": "48h"}          // relative to a node completing
{"expr": "game_date - 24h", "backstop": "…", "after_unknown": true}   // derived; see Terraform (06)
```

**Six node types. One flat record, discriminated by `type`.**

**Every node type carries `label`** — a human-readable string stating what it is or asks. *(Probe fix 1: a `gate` that cannot state its question is unusable; 7 of 10 scenarios independently invented `title`/`instruction` on one, producing the single largest defect cluster — 9 observations and most of invariant #1's firings. See `probes/q4-mutator.md`.)*

| type | What it is | Required fields beyond `id`, `type`, `label` |
|---|---|---|
| `task` | does one thing; carries `effect_class`. **A compensation is a `task` with `compensates: <node_id>`** — not its own type | `instruction`, `effect_class`, `outputs`, `effect` (if pivot/compensatable) |
| `wait` | one node, N conditions, first-wins, **mandatory `deadline` + timeout edge** (§6.5) | `conditions`, `deadline`, `on_timeout` |
| `gate` | needs a human: `accept \| edit \| respond \| ignore` | `decision_kinds`, `deadline`, `on_timeout` |
| `join` | merge point over declared in-edges. **`merge: all\|any` is required** — `join` was AND-only and all four authoring briefs produced a potential deadlock on the main path | `merge` |
| `quorum` | predicate over a set defined by a **key expression**, not a hand-drawn edge list | `predicate`, `over`, `on_unsatisfied` |
| `group` | fan-out container. **A real node the LLM emits, not a viewer annotation** | `members`, `fan_out_over`, `reports_into`, `max_children`, `child_template` |

**The `group` and `quorum` fields above are not additions — they are debts.** The old invariant #7 required every fan-out child to declare the join/quorum it reports into and gave no field to say it in — it is now *dropped*, subsumed by quorum population being derived from `waits-for` edges (§6.7.1). It is recorded here because all eight authoring trials independently invented `reports_into`, `on_unsatisfied`, and a `condition` on branch edges. When 8/8 independent runs invent the same fields, the schema was short those fields.

**`gate` takes a `deadline` and `on_timeout` too, exactly like a `wait`.** A gate is a wait whose event is a human. The probe found ten valid-but-permanently-stuck graphs, most caused by an undecided gate freezing a plan past its own quorum deadline with no invariant to catch it.

*Explicitly not node types:* a timeout is an **edge** off a wait, not a timer node; a router is a `gate`; a sub-flow is `group` + parent-child edges, not nesting.

**Edges — four blocking, four annotating** (Beads' split, stolen wholesale):
blocking `blocks` · `parent-child` · `waits-for` (join over *dynamically created* children — Beads already proves you need this once fan-out is runtime-determined) · `conditional-blocks` (the timeout/failure branch).
annotating `discovered-from` · `caused-by` · `supersedes` · `compensates`.
Carry **two lanes** — `sequence` (who runs next) and `provides` (whose output feeds whom); Rete, BaklavaJS and Unreal Blueprints arrived at that split independently (see 01; 10; 14).

**⚠ The two edge lanes use OPPOSITE direction conventions, and this must be stated as loudly as the blocking one.**

| Lane | `{from: A, to: B}` means | Read it as |
|---|---|---|
| **blocking** | **B requires A** | "B needs A" |
| **annotating** | **A is about B** (subject → object) | "A was caused-by / discovered-from / supersedes B" |

The authoring probe mitigated the blocking-edge footgun successfully (7/8 correct) and then found it had simply **migrated one edge-kind over: annotating edges were inverted in 3 of 4 briefs.** One inverted `caused-by` gave `cancel_booking` blocking in-degree 0 — making "cancel the booking" a **second root `kona next` could dispatch before anything was ever booked.** Hence lint rule 8 (§6.8.1).

**`conditional-blocks` edges carry a `condition`**, and a set of branches leaving one node carries a mutual-exclusivity declaration. Five branch points per authored graph were otherwise unnameable — at exactly the irreversible choices.

**Status — a small enum plus an open `conditions[]` list.** Kubernetes deprecated its `phase` enum in writing precisely because *"adding new enum values breaks backward compatibility"* (see 06).

`blocked | ready | running | waiting | sending | done | failed | dropped | superseded | stale`

**Terminal = `done | failed | dropped | superseded`.** Non-terminal: `blocked | ready | running | waiting | sending | stale`. Five rules turn on this word (invariants 3, 4, 5, the forbidden-op list, and the Fix 7 merge rule) and it was undefined until 2026-08-21. Two deliberate calls: **`sending` is non-terminal**, so `kona effect record` is not caught by the no-mutation-of-terminal rule; **`stale` is non-terminal**, because it is awaiting a human decision rather than closed.

Three of those are non-obvious and all three are argued:

- **`failed` ≠ `dropped`.** Jason's BDI goal lifecycle separates "tried, didn't work" from "we stopped wanting this." Kona needs it for "counterparty went silent, branch abandoned." (06 — BDI)
- **`sending`** is the only status meaning *we do not know what happened in the real world.* (11 — outbox)
- **`stale`** — a node invalidated by an upstream mutation is marked with a reason and surfaced for a decision, **never auto-re-executed**, because the downstream node may be "email the coach." (10 — marimo)

**Invalidating sentries:** a `done` node must be able to return to active when a later event invalidates it — a goalie who confirmed can cancel — with the invalidation recorded as a versioned mutation. Most agent frameworks have monotonic status and get this wrong. (see 04 — GSM)

### 6.3. The mutation record — the differentiator, made structurally mandatory

One line of `mutations.jsonl` per commit.

```jsonc
{
  "v": 42, "parent_v": 41,
  "parents": [41],               // plural: costs nothing now, only thing that permits reconciling
                                 //   two concurrent mutations later            (see 09 — Noms)
  "hash": "sha256:…",            // Merkle chain over history                   (see 14 — Nix)
  "client_id": "cid_7c1e…",      // idempotency: a replayed fan_out is a no-op, not a duplicate sub-flow
  "schema_version": 1,

  "observed_at": "…",            // when Kona learned      } bi-temporal, ENGINE-stamped, never LLM-stamped
  "occurred_at": "…",            // when it actually happened }              (see 09 — XTDB; 07 — Graphiti)

  "actor": { "kind": "orchestrator|subagent|human", "id": "exec-3" },   // the AGENT, not the process

  "trigger": {
    "relation": "Trigger|Invalidate|Derive|Approve|Timeout",   // typed        (see 08 — TRAIL)
    "event_ref": "evt_118",
    "context_snapshot_ref": "ctx_44",   // what the agent saw    } the DIFF between these two
    "prior_context_ref":    "ctx_31"    //                       }   IS the candidate rationale (04 — YAWL)
  },

  "ops": [ … ],                  // the closed set, applied atomically in fixed internal order

  "rationale": {
    "why": "≤2 sentences",                                   // CAPPED; long form lives in the viewer
    "expected_effect": "quorum(goalie) satisfiable by Fri",  // machine-checkable
    "alternatives_rejected": ["cancel the game", "play without a goalie"],
    "reason_code": "COUNTERPARTY_DECLINED | DEADLINE_PASSED | NEW_CONSTRAINT | MISSING_STEP | …"
  },

  "migration": "transfer|compensate",   // names the recovery class
  "conflict": null,                     // set by the STORE, never by the agent
  "outcome": null                       // WRITTEN LATER, ON EVIDENCE
}
```

Four calls that are not obvious, each argued:

1. **`outcome` starts `null` and is filled by a later real-world event.** AFlow computes `succeed = after > before` against a benchmark; Kona has no benchmark, no counterfactual, and N=1 — you cannot re-run "email 12 hockey parents" five times and take the mean. Write the rationale synchronously, leave the outcome null, let a WAIT resolution fill it in. *Rationale without outcome is a changelog; rationale with outcome is training data.* (05 — AFlow, ADAS)
2. **A rationale is never edited.** Append a new version referencing the old. A-MEM's evolution loop rewrites old notes in place and destroys the record of what the agent believed at the time. (07; 04 — RDR)
3. **Suppression rule — version mutations, not snapshots.** If a re-plan produces a fragment semantically equal to the existing one, do **not** write a version: hash each node's semantic content and make `mutate` a no-op-with-revalidation on an unchanged hash. The counter-case is Airflow #54337 — naive version-on-every-structural-change produced **hundreds of DAG versions per day**. Without this the log fills with "the agent thought about it again" and the procedural-memory claim is worthless. (14 — Salsa's backdating; 03 — Airflow)
4. **`why` is capped.** Reflexion's sliding window and ExpeL's own token-limit caveat are the warning. (07, 05)

**Pre-concede loudly:** ADEPT2's change logs already carried *"change reason and change performer"*; ProCycle already retrieved similar past changes for reuse; Mailgun ships a `description` field beside a production routing rule. Versioned-mutation-with-rationale is **not novel in kind**. What is new: in ProCycle a human typed the reason into a dialog and a human decided whether to reuse it; in Kona the LLM emits it as a side effect of deciding and a fresh-context subagent consumes it as its only briefing. (04, 13)

### 6.4. The mutation op set — 11 ops, id-addressed, batched into one commit

```
add_node(scope, spec)                        -> $id
add_edge(from, to, kind)                     -> $edge_id
fan_out(node, template_id, keys[])           -> {group: $id, join: $id, children: {key: $id}}
reroute_edge(edge_id, new_to)
set_status(node, status, evidence_ref)
record_outcome(node, verdict, evidence_ref, attrs?)  -> verdict ∈ confirmed|declined|tentative|timed_out|bounced
record_output(node, output_name, value_or_ref, evidence_ref)   -> satisfies a declared `outputs` entry
supersede_node(node, by?)                                          (never delete)
add_wait(node, {label, conditions, deadline, on_timeout})  -> $id
insert_compensation(node, spec)              -> $id
resolve_gate(node, decision, text)                                 (human)
```

**`record_output` is the eleventh op, and it is what makes `inputs[].ref` mean anything.** A node declares `outputs`; `record_output` fills one in; `kona brief` resolves a downstream node's `inputs[].ref` against it. Without this pair the reference-by-node-id design is decorative — proven, not theorised: 0/8 fresh subagents could execute, because every upstream ref resolved to nothing (`probes/authoring-briefing.md`). The store rejects a `record_output` whose `output_name` is not in that node's declared `outputs`.

**Fix 5 — `record_outcome` is the tenth op, and it closes the deepest hole the probe found.** All ten scenarios independently hit it: `roster_quorum` reads `count(confirmed)` and `count(role=goalie, confirmed)`, and **nothing in the 9-op vocabulary could write either field.** `set_status` moves a lifecycle enum; `evidence_ref` is free text. So an ACCEPT and a DECLINE emitted *identical ops* and the quorum predicate — the thing the whole pursuit turns on — was unevaluable. A 10-op closed schema is still closed. `verdict` is typed and closed; `attrs` carries predicate-visible facts (`{role: "goalie"}`) and nothing else.

**`fan_out`'s expansion rule, stated so it is implementable.** The review found `template_id` referenced but never defined — no shape, no storage, no lifecycle — which made the headline op's first implementation question unanswerable. Resolved **without** adding a template directory (a second store would contradict §6.1's one-file principle and give crash-resume another thing to reconcile):

- `child_spec` is an ordinary node spec that may contain `{{key}}`. `template_id` is a caller-supplied **lineage label** — free string, no registry, nothing resolves it; it is stamped onto each child's `provenance.template_id` so §7.2's assertion (a) can find it.
- At commit the store copies `child_spec` once per key, substituting `{{key}}` in exactly three whitelisted places — `label`, `effect.recipient_ref`, `effect.correlation` — mints the child id as `<group_slug>-<key>`, sets `provenance.instance_key` and `provenance.group`, mints a **distinct `effect_key` per child**, and **rejects the whole batch if any `{{…}}` survives an expansion.**
- `reports_into` names an existing `join` or `quorum`; **default is the newly minted join.** This closes a real hole the review found: a fan-out spawned to repair a quorum wired its children into its *own* new join, so three irreversible emails went out and their confirmations counted toward nothing — while all seven invariants passed, because the original quorum's population was untouched and therefore trivially still satisfiable.
- `add_node(scope, …)` may also carry `provenance.template_id`, or a mid-run arm added singly cannot satisfy §7.2 assertion (a).

**Fix 3 — intra-batch symbolic references.** Ops return ids, but a batch is static JSON, so a batch cannot name what it just created. Nine of ten scenarios fabricated ids to work around this. Ops therefore return **`$0`, `$1`, … positionally**, referencing the op's index in this batch; `fan_out` returns a structured handle (`$2.children.dana`). The store resolves symbols at commit and rejects any unresolved or forward reference. Caller-supplied ids are **not** accepted — that was the other workaround and it risks colliding with a live node and writing to the wrong one.

**Fix 2 — what each op auto-wires, stated explicitly.** Ambiguity here caused *every* orphan in the probe and all five invariant-#3 firings.

| Op | Edges it creates automatically | You must add |
|---|---|---|
| `add_node(scope, …)` | `scope -parent-child-> $new` **only if** `scope` is a `group`; otherwise **nothing** | every `blocks` edge, always |
| `fan_out(node, …)` | `node -blocks-> group`, `group -parent-child-> each child`, `each child -waits-for-> join` | edges out of `join` |
| `add_wait(node, …)` | `node -blocks-> $wait`, `$wait -conditional-blocks-> on_timeout` | edges out of `$wait` on the success path |
| `insert_compensation(node, …)` | `node -compensates-> $new` (annotating) | any `blocks` edge if the compensation must run before something |
| `record_outcome` | nothing — it writes data, not topology | — |

**Fix 7 — branch resolution semantics, the sentence the contract never had.** The v2 probe's dominant *silent* failure was deadlock from mutually-exclusive branches AND-joined downstream, and its root cause was that nothing defined what happens to a branch that is never taken. Agents flagged it as an assumption they had to invent, invented it differently each time, and built on it. Defined now:

> When a `wait` or `gate` reaches a terminal resolution, **the store** — not the agent — marks every outgoing branch it did not take as `dropped`, with a system-generated rationale.
> A `dropped` in-edge is **excluded from merge evaluation: it neither satisfies nor blocks.**
> A `join`/`quorum` whose remaining live in-edges are all terminal is satisfied. One with **zero** live in-edges routes to `on_unsatisfied`, never hangs.

Two consequences worth stating, because they remove whole defect classes:

- **The agent never writes a tidying op again.** Retiring a dead follow-up was 5 of v2's 10 rejections — invariant 4 punishing exactly the housekeeping the store should have done itself. Fix (a) is not a separate change; it falls out of this one. Invariant 4 now reads: `on_timeout` must name a node that is non-terminal **while the wait itself is non-terminal**. Once the wait resolves, its timeout target's state is irrelevant.
- **Mutually-exclusive branches can no longer deadlock a downstream merge**, because the untaken one is dropped and dropped edges are excluded rather than pending.

**Fix 8 — a gate's out-edges must be conditioned.** `blocks` means "any **successful** completion" — a `failed` node clears no `blocks` edge and fires its `conditional-blocks` failure branch instead. Before that qualifier, a gate resolved with `ignore`, or timed out, still cleared a `blocks` edge — meaning an irreversible send could fire with no approval, which is the opposite of what the gate is for. v2's validator called it exactly: *"either a deadlock or toothless."* Every out-edge of a `gate` or `wait` is now `conditional-blocks` carrying an explicit `condition` (`on: accept` / `on: ignore|timeout`); an unconditioned `blocks` edge out of either is rejected by lint. No new edge kind needed — the `condition` field added above does the work.

**Fix 9 — quorum population is declared by membership, not by an id glob.** `over: "invite@*"` made node ids load-bearing for predicate evaluation, and once ids became server-minted (fix 3) a newly added invite could not be *proven* in-population — 2 of v2's 10 rejections. A node is in a quorum's population iff it has a `waits-for` edge into that quorum. `over` is derived from edges; the string glob is gone.

**Fix 10 — `add_wait` takes a `label`.** `label` is required on every node and `add_wait`'s signature had nowhere to supply one — a self-contradiction flagged in 8 of 10 scenarios.

**Fix 6 — batch semantics are pinned, not left to inference.** Ops apply **in array order**. **Invariants 1, 2, 3, 4, 6 and 7 are post-state predicates**, checked once against post-commit state. **Invariant 5 is an op-delta predicate**, checked per-op against pre-commit head state — see §6.7.1 for why that distinction is load-bearing rather than pedantic. Four scenarios built batches whose legality flipped depending on this, which means some of the probe's accepts were conditional on the validator sharing the proposer's guess. Internal apply order is still additions-and-rewires before cancellations (Zeebe, §6.4 below) — the array is validated against that order and rejected if it violates it, rather than being silently reordered.

**Forbidden by construction, with no opcode reserved:**
`delete_node` · `rollback` · `replace_graph` / any whole-graph write · `edit_rationale` · `reparent` · any write to a node in a terminal state · any write of a coordinate · any op whose payload is executable code.

Each refusal is argued: reserving an unimplemented `rollback` is itself a trap (YAWL). `reparent` is the mutation most likely to produce an incoherent graph mid-run — Cytoscape makes parentage immutable-after-creation for exactly this reason, so create the container and its children in one mutation. Terminal-state immutability is OpenLineage's rule and prevents the most likely demo-day corruption: a late subagent writing to a node that already resolved. Free-form code as payload is how AFlow got RCE (#42) and how Langflow's CVE-2025-3248 reached CISA's KEV catalog. (04, 10, 08, 05, 02)

| Design point | Why |
|---|---|
| **Batched into one versioned commit, fixed internal order: additions and rewires → then cancellations** | Zeebe applies modifications all-or-nothing with activations hardcoded before terminations; Camunda 7 executes in submitted order and *silently destroys scopes, variables and subscriptions* if you cancel first. (03) |
| **One LLM call emits the whole batch with one shared rationale** | OptoPrime's claimed 2–3× advantage over TextGrad comes precisely from one call seeing the whole structure. (05) |
| **`fan_out` is one atomic op that also creates the `group` and the `join`** | Conductor pairs `FORK_JOIN_DYNAMIC` with a mandatory JOIN; Neo4j's oldest production complaint is hot-node write contention — many writers appending to one parent's child list is exactly that shape. One orchestrator op, recorded once. (03, 09) |
| **Every op addresses a node *instance*, with an explicit parent scope** | After fan-out there are N live copies of "send follow-up", so node ids alone are not addresses. Zeebe's `ancestorElementInstanceKey` — including its `-1` sentinel for "the unique live scope, error if not unique" — is copied directly. **Getting this wrong is the most likely source of a silent wrong-counterparty email on stage.** (03) |
| **Every op carries a caller-supplied `client_id`** | A crash-replayed `fan_out` must be a no-op, not a duplicate sub-flow. Without it, resume-from-the-file silently corrupts topology on every crash. (13, 03) |
| **Additive vs destructive gates the human** (§6.9) | XState's own compatibility heuristic; ADEPT2's per-pattern-per-object authorization. (02, 04) |

### 6.5. Wait / event / deadline semantics

```jsonc
"wait": {
  "conditions": [                                   // or-group, FIRST-WINS        (see 03 — Hatchet)
    {"kind":"reply",    "match":{"in_reply_to":["<msg-id>"],"from":"dana@…"}, "on":"edge_ok"},
    {"kind":"deadline", "at":"2026-08-29T17:00Z",                             "on":"edge_timeout"}
  ],                                                // deadline REQUIRED, non-nullable
  "if_part": "quote < budget",                      // optional predicate over case data (04 — CMMN)
  "correlation": "kona+goalie-dana@demo.example",   // DERIVED from node id        (see 13 — Postmark)
  "cursor": {"source":"api","last_seen":"…","last_checked_at":"…"},
  "memory": true,                                   // "reply arrived" survives a crash
  "obviated_if": "quorum:goalie >= 1",
  "resolution": null    // satisfied | timeout | bounced | superseded
}
```

| Decision | Argument |
|---|---|
| **`deadline` non-nullable, enforced by the CLI** | Four independent lineages converge — tuple-space `in`, FIPA `reply-by`, A2A `input_required`, OTP restart budgets — and email supplies the decisive reason: a message in someone's spam folder is *sent*, produces no bounce and no reply, and the wait hangs forever. This is the schema decision that most directly prevents a silent multi-day hang. (12, 13) |
| **Correlation key derived from the node id, never minted per run** | n8n's documented footgun is that `$resumeWebhookUrl` changes across executions, so the token you emailed goes stale. Postmark's `MailboxHash` and testmail.app's derive-don't-provision addressing put the identifier *in the address*, so a reply arriving three days after a crash routes to the right node with **no LLM call and no header archaeology** — and makes fan-out **idempotent for free**. (02, 13) |
| **Reconciliation is the source of truth; webhooks are a latency optimisation** | Mailpit does not retry failed webhooks and rate-limits to 1/s; AgentMail publishes no retry semantics and *excludes spam/blocked events by default*; Postmark drops permanently on 403; SendGrid drops silently after three days. Store `{cursor, last_checked_at}`; resume re-scans since cursor. (13; 06 — K8s) |
| **Resolution is four-way, not boolean** | A bounce is not a timeout and the compensating action differs. Copy Resonate's five promise state names verbatim — Pending / Resolved / Rejected / RejectedCanceled / RejectedTimedout — because "cancelled because the plan changed" vs "timed out" is exactly what the rationale record must explain. (13, 03) |
| **First-match-wins routing, deterministic ordering, dedupe on provider `message_id`** | Mailgun evaluates *all* matching routes — under evaluate-all one reply could satisfy two waits in two fanned-out sub-flows and advance both, which is unrecoverable under no-rollback. (13, 03) |
| **`last_checked_at` stamp** | So the viewer distinguishes "patiently waiting" from "stuck" — the exact hazard Colledanchise names for event-driven behavior trees. (06) |
| **`obviated_if` per wait** | When goalie #2 says yes, the other thirteen waits are automatically marked obviated **with a rationale** rather than rotting in the viewer. *The single most directly transplantable idea in the coordination category.* (12 — BB1) |

**Reject LangGraph's interrupt model explicitly, and say why.** LangGraph re-runs the node on resume because its durable unit is a *code position*; the resulting multi-interrupt resume bugs are a multi-year defect area (#2870 → #3072 → #4028 → #6626 → #8579, the last still open Aug 2026). Kona's durable unit is a node record with an explicit status, so resume is *"read the file, see `waiting`, do nothing."* **Every one of those bug classes is a symptom of replay semantics Kona does not need to have.** (see 11)

### 6.6. Irreversible effects — intent, act, record

You cannot make a local state change and an external side effect atomic. 2PC is the protocol nobody uses; the outbox is the industry's admission of defeat. The reachable design is one atomic local write, at-least-once external effect, dedup by key, compensation when dedup fails. (see 11)

```
1. kona effect reserve <node> --kind email.send --payload-hash <h>
      → append mutation {status: sending, effect_key, exact payload} → FSYNC → return effect_key
2. executor sends
3. kona effect record <node> --key <k> --outcome sent --message-id <id>
      → append outcome, status: sent
```

**The three crash windows, and the one everybody forgets:**

| Crash between | Resume finds | Action |
|---|---|---|
| mutation and fsync | no record | safe — nothing happened |
| fsync and send | `sending` | **safe to retry with the same key** |
| **send and outcome** | `sending` | **must ask a human.** The real world's state is genuinely unknown. Design this case explicitly — it is the one a demo will hit. |

| Rule | Why |
|---|---|
| `effect_key = hash(node_id, recipient, resolved_body, v)`, minted at **node creation** | Bazel's law generalises: a cache key is only safe when it covers everything that determines the output. An under-specified key is a double-sent email. (14) |
| Store the **result**, not a flag — `{message_id, sent_at, provider, sandbox_or_real, outcome}` | Downstream waits must match replies against **which** send they correspond to, after fan-out produced several near-identical emails. (11 — Stripe) |
| **Parameter-comparison rule:** key matches but body differs ⇒ **loud error in the viewer** | Never a silent no-op and never a second email. A genuine Kona-specific hazard precisely because the mutator rewrites node payloads. (11 — Stripe) |
| A node with a non-empty `effect_log` is **never re-executed** — the CLI refuses | Structural, not a convention. XState's corollary: `invoke`s *do* restart, so classify effects and only auto-restart `pure`/`reversible`. (11, 06) |
| `attempted_at` ≠ `completed_at`; attempted-without-completion = **needs human adjudication**, not retry | Make's mtime footgun maps exactly onto "the node has an output, so it's done." (06, 14) |
| Multi-step compensation persists a **step cursor after each step** | Or resume replays an already-sent email. (04 — YAWL's `ExletRunner._actionIndex`) |
| The **`effect_log` `outcome` field** — *not* `status.state` — distinguishes `queued → sent → delivered → bounced` | `sent` is not `delivered` and the graph must say which. These are effect outcomes; the node's own `status.state` stays inside the closed enum, or invariant 1 would reject the CLI's own effect path. (13) |
| **Restart budget:** `max_reattempts` within `window`; on exhaustion escalate to a gate, never loop | Without a budget an LLM mutator retries forever and burns a mailbox. (12 — Erlang/OTP) |

Every action node is typed by reversibility — `pure | reversible | compensatable | pivot` — and the invariant follows: **pivot nodes require an upstream gate; compensatable nodes require a declared compensation.** That turns "Kona has no rollback" from an apology into an enforced schema invariant. (see 11 — Revisable by Design; 09 — Sagas)

### 6.7. Invariants and concurrency

#### 6.7.1. Enforce — seven checks, and why the other nine moved to lint

Real verification is off the table: soundness of workflow nets is **EXPSPACE-complete**, and undecidable for reset nets (a "cancel this whole sub-flow" arc, i.e. exactly what abandonment is). Camunda concedes the same hole in production prose: *"The process engine is not able to detect modifications that create such situations. It is up to the user of this API."* So the store ships a cheap linear-time floor — and the floor got **smaller**, not bigger, once the probes said which checks earn their place.

**The evidence for cutting.** Across 40 proposals in two runs, only **4 of 11** invariants ever fired in v1 and **5 of 11** in v2. Six or seven had never caught anything. Worse, the un-relaxed invariant 4 was **5 of v2's 10 rejections** — the store rejecting the model for correctly tidying a dead branch. A check that has never caught a defect but does reject correct work is negative value.

**ENFORCE — blocks the commit, names the offending node.**

| # | Invariant | Why it earns its place |
|---|---|---|
| 1 | **Schema validity** — every node has a legal `type` and all required fields incl. `label` | Free; it is type-checking. Fired 7× then 1× |
| 2 | **No cycles** among `blocks` edges | 5 lines. Beads enforces the same thing on `bd dep add` |
| 3 | **Reachability both ways** — every node reachable from root and able to reach a terminal | Fired 6× across runs; every firing was a real orphan |
| 4 | **Every wait/gate has a `deadline` and an `on_timeout`**, the target non-terminal *while the wait is non-terminal* | **The single check that prevents a silent multi-day hang.** A message in spam is *sent*: no bounce, no reply, no error |
| 5 | **Terminal & effect protection — an OP-DELTA predicate, evaluated per-op against PRE-COMMIT head state, not a post-state graph scan.** For a node terminal at commit time, no op in this batch may (a) add or reroute a *blocking* edge whose `to` is that node, or (b) target it at all, except `supersede_node` / `insert_compensation` / `record_outcome` / `record_output`. And no `supersede_node`/`reroute_edge` on a node with a non-empty `effect_log` unless the same batch carries an `insert_compensation` for it. **Blocking edges that already exist into a terminal node are untouched — they are the record of how it became reachable.** | This **is** the no-rollback guarantee. ⚠ It was written as a post-state predicate until 2026-08-21 and was **fatal**: a blocking edge `{from:A,to:B}` means "B requires A", so B's own dependency edges point *into* B and do not vanish when B finishes. Post-commit, the graph permanently contains blocking edges into terminal nodes — so the first completed node made every later commit 422 forever, and branch resolution invalidated the graph it had just written. Evaluating terminality pre-commit also stops `set_status(n,"done")` from self-rejecting |
| 6 | **Quorum stays satisfiable** — population is the set of `waits-for` edges into it | The only invariant that ever caught a genuine *reasoning* error rather than a schema slip — twice |
| 7 | **Effect budget + `max_fanout`** — cumulative irreversible sends ≤ the budget declared in the approved plan | **§6.9 removed every human gate on topology and named this as the replacement.** Drop it and "fully automatic mutation" has no backstop at all |

Plus the write protocol, which is not a graph property: **`parent_v` must equal head, else 409 → re-read → re-decide, never blind-merge.**

**MOVED TO `kona lint` (§6.8.1) — warns at author time, does not block a mutation.**

| Was | Now | Why it moved |
|---|---|---|
| merge declared | L1 | All four authoring briefs produced an OR-join deadlock — a *planning* defect, catchable before a human approves |
| refs resolve to a declared output | L2 | Already handled at run time: `kona brief` marks it `UNRESOLVED` and the executor refuses (proven 2/2) |
| effects complete and funded (recipient, correlation) | L3 | Author-time property. A missing recipient is a bad plan, not a bad mutation |
| liveness | L4 | Expensive to compute per commit, and the §6.4 *branch resolution* rule removes the deadlock class structurally rather than bya per-commit check |
| rationale fidelity | L5 | About whether a human should trust the diff — a review concern, not a corruption one |
| fan-out declares `reports_into` | *dropped* | Subsumed: quorum population is now derived from `waits-for` edges, so there is nothing left to declare |
| no unevidenced status/outcome | *dropped to report* | Fired once in 40 and is a judgment call, not a structural one. Annotate it (§6.7.2) |

**Why this is safe to cut.** Every enforced check maps to an observed failure or an irreversible harm. Every moved check maps to a *plan quality* problem, which `kona lint` catches before a human approves and before anything is sent. The store's job is to stop corruption; lint's job is to stop bad plans. Conflating them is what made the store reject correct work.

**Scope constraint (the Ellis answer), retained.** A mutation batch may not touch a node currently `waiting` with an outstanding real-world commitment outside its declared change region; the CLI computes that set and refuses. And the line for the stage when a judge raises the 1995 dynamic change bug: *"We don't migrate state, we recompute it."* Kona has no tokens — node status is durable data folded from a log. If there is nothing to migrate, there is nothing to migrate incorrectly.

#### 6.7.2. Log, don't block

Write a `conflict` annotation with a reason and surface it in the viewer for: a mutation touching a region containing `done`/`sending` nodes; whether a rationale is *good*; whether a fan-out was *warranted*; conformance drift between the approved graph and what ran (render as a ribbon — **observability, never a runtime gate**, because a checker that "fails" a divergent run has nothing to do under no-rollback).

**Do not implement ADEPT2's compliance gating** — it exists to protect a reversible transactional world, still strands instances as "progressed too far", and needed a whole follow-up paper of Adjustment Strategies. **Do** steal Strategy 2: when a new step should have gone before something already done, insert it at the first still-reachable successor position and log the displacement. **Explicitly refuse Strategy 3** (trace rewriting) — Kona's event log is append-only and never edited. (see 04)

#### 6.7.3. Concurrency — four rules, in order of how much they buy

1. **Role-scoped write authority.** Only the orchestrator mutates topology; subagents only `set_status` and write their own node's output. *This single rule removes most of the need for locking.* Steal ReWOO's Planner/Worker/Solver split and Akka's one-active-writer-per-entity guarantee. (05, 12)
2. **Atomic claim with a TTL lease.** `kona next --agent X --lease 30m`, implemented as `O_EXCL`/atomic rename. Two subagents call concurrently; exactly one wins. Linda proves this is sufficient, and it is the only mechanism preventing two subagents emailing the same goalie. Expose the *eligible set* through the CLI rather than letting a subagent pick — the blackboard KS-activation-record pattern. (12)
3. **Compare-and-swap on `parent_v`.** 409 → re-read → re-decide. ~20 lines. (09 — KurrentDB; 04 — ADEPT2)
4. **One macro-step per external event.** One inbound email = acquire lock, apply the full cascade of derived status changes and topology mutations as micro-steps, stamp them with one logical timestamp and one version id, release. Subagents propose; only the macro-step commits. (04 — GSM)

**And the rule that matters more than all four.** Beads #5898: 54 cross-actor overwrites, median 31 minutes apart, none inside any plausible conflict window. The enemy is **hand-offs, not races** — locking prevents zero of those. Therefore **judgment-bearing fields are append-only event streams with actor + timestamp + rationale per entry, and the current value is a projection.** A subagent that reads a stale field and writes over it produces a new event and never destroys the prior one. (see 01)

**Per-field merge rules** for the three fields that can genuinely race: `status` merges by lattice (`blocked < ready < running < done`, `failed` absorbing); a wait's received-replies by set union; a quorum's satisfied-count by **recomputation from the union of its inputs**, never as a mutable integer two agents can both overwrite; `rationale` by append. Thirty lines, written before the fan-out feature exists. (see 09 — Irmin, Automerge)

**Ephemeral vs durable split.** Presence ("subagent-3 holds a lease on the Smith sub-flow") lives in a non-persisted channel; the graph file holds only durable truth. That is *why* crash-resume correctly ignores stale presence. (see 09 — Yjs; 10 — tldraw)

#### 6.7.4. Crash-resume contract — what a fresh session derives from `.kona/` alone

State it in the README and **test it as a test, not as a slogan**: `kill -9` mid-mutation, restart, require progress with zero session state.

| # | Must be derivable |
|---|---|
| 1 | Full topology at head — nodes, edges, groups, per-node status |
| 2 | The frontier — which nodes are runnable now — **computed, never stored** (01 — `bd ready`) |
| 3 | Every open wait's predicate, deadline, correlation address, cursor, `last_checked_at` |
| 4 | For every irreversible node: `effect_key` and the full `effect_log` result |
| 5 | Every unresolved gate and who owns it — pending approvals must be *in the file* |
| 6 | The rationale chain for any node — `kona why <node>` |
| 7 | The approved baseline — which version the human approved — so post-hoc alignment is possible |

**Resume is reconcile-then-repair, not just load.** The file says "waiting on Bob" while Bob replied during the crash window. `load_graph() → reconcile_waits_against_world(inbox, clock) → repair`, and **each repair is itself logged as a mutation with a rationale.** YAWL's `cleanseRestoredRunners()` is the model. (see 04)

**The loader must be partial-tolerant.** Open a forward-versioned or partially-corrupt graph, report which nodes failed, let the orchestrator repair. All-or-nothing parsing turns a one-node schema error into a dead multi-day pursuit. (see 10 — BaklavaJS)

### 6.8. The CLI command contract — what all four blocks build against

One binary owns every mutation. Every read supports `--json`; every mutating verb requires `--why` and `--base-version`.

| Verb | Kind | Contract |
|---|---|---|
| `kona init` | setup | create `.kona/`, write `schema_version`, refuse on a network filesystem |
| `kona plan --brief <f> -o <plan>` | author | validate a proposed op batch → emit a frozen content-hashed artifact. **Does not commit** |
| `kona apply <plan> --why "…"` | mutate | commit a previously-approved artifact verbatim; fails if the hash does not match |
| `kona mutate --ops <f> --base-version N --why "…"` | mutate | the general path: validate → `flock` → CAS → append → fsync → materialize |
| `kona validate <plan>` | read | dry-run the 7 enforced invariants; the LLM must pass this before proposing |
| `kona lint` | read | post-authoring checks: inverted edge direction, sequence-implied-by-numbering, unreachable nodes |
| `kona graph --json [--version N]` | read | **the one supported read contract.** Powers the viewer and the scrubber |
| `kona status [--json]` | read | head version, counts by state, ready nodes, armed waits + time remaining, open gates, `sending` unknowns |
| `kona next --agent <id> --lease 30m` | claim | return eligible unleased nodes **and take a lease**. The only way a subagent gets work. **Never returns an uninstantiated branch template inside an unexpanded `group`** — the probe walked a fresh agent straight into `send_scope_package` with `<bidder_id>` unbound |
| `kona brief <node>` | read | **the fresh subagent's entire world. Eight required blocks — see §6.8.1.** Refuses rather than returning a partial brief |
| `kona why <node>` | read | the rationale chain for one node |
| `kona set-status <node> --state … --why "…"` | mutate | executor status transition + conditions |
| `kona effect reserve\|record` | effect | the §6.6 outbox sequence |
| `kona event add --kind … --evidence <ref>` | ingest | append to `events.jsonl`; **also the demo's injection path and the live-failure fallback** |
| `kona resume` | reconcile | the §6.7.4 reconcile-then-repair |
| `kona history [--node <id>]` | read | the rationale timeline — feeds the viewer's second panel and the agent's self-query |
| `kona view [--port]` | viewer | start the localhost viewer. **User-run, never plugin-spawned** (§6.10) |

#### 6.8.1. `kona brief` — eight required blocks · `kona lint` — eleven rules

**`kona brief <node>` returns all eight blocks or refuses.** Each was named independently by fresh subagents on three or four different briefs; together they are the difference between 0/8 executable and a working substrate.

| Block | Contents | Why |
|---|---|---|
| `resolved_inputs` | for each `inputs[].ref`, the **actual upstream output value**, or an explicit `UNRESOLVED` marker | *the single fix that moves Claim B.* Named by every trial |
| `node_status` + `gate_decisions` | own + upstream status **from one source — never restate status in two blocks**; per upstream gate: which `decision_kind`, when, by whom, and **`approved_payload` — the exact text that was accepted, not only `edited_payload` when it was edited** | must distinguish "plan approved at v1" from "this gate answered". **`approved_payload` is the v2 probe's main residual finding:** on `decision_kind: accept` there was no payload, so the agent authored fresh copy for an irreversible send whose approval was granted against wording it never saw — silently breaking §6.9's approval-diff item 3 |
| `recipient` | resolved address(es) + To/Cc/Bcc disclosure policy | direct cause of the wrong-address risk; also what §6.9's approval-diff item 3 requires |
| `identity` | sending mailbox, display name, signature, legal entity, **and an authority statement** ("you may commit up to £X" / "you may not commit funds") | missing in 4/4 briefs; in 3 the only identity available was a personal Gmail — wrong for a bid desk |
| `correlation` | the **fully-expanded literal** reply-to address and subject tag | one trial emitted `kona+offsite-booking@<kona-inbox>` verbatim: a perfect send that could never correlate |
| `time` | timezone, current timestamp, every deadline resolved to absolute | named in 3 briefs |
| `effect_ledger` | budget total / consumed / reserved / remaining | **invariant 7** is the circuit breaker and the executor could not see the meter |
| `preconditions_satisfied` | computed **by the CLI, never inferred by the agent**, and **fails CLOSED**. The AND of: every declared input resolved · every upstream gate returned · `effect_ledger.remaining` > 0 · this node's `effect_key` reserved-and-unfired. Plus an explicit refusal instruction when false | 7/8 v1 HIGH-risk cases were a node saying "send exactly what was approved at `<gate>`" where that gate had not returned. **And in the v2 probe this block failed OPEN** — it read `true` while a declared input was UNRESOLVED, and the refusal was carried by `resolved_inputs` contradicting it. The safety block pointed the wrong way |
| `disclosable` | per-field marking of what may appear in outbound content | The v2 probe's one repeated behavioural defect (2/2): the agent read `captain_reply_wait`'s internal timeout and turned it into an outbound promise — "please reply by Sunday" — converting internal graph state into an external commitment nobody authorised. Derived, not invented, self-flagged; still wrong. If a reply-by should be stated, the `effect` block says so |

**The executor's return contract, tightened by the v2 probe.** `EXECUTED` must mean *bytes moved*. Both EXECUTE arms composed a complete, correct payload and stopped at the transport — then one reported `decision: EXECUTED` anyway. A runner reading only that field marks an unrecallable effect as done when nothing was sent. So: **`EXECUTED`** (effect fired, `effect_log` written) · **`COMPOSED`** (payload ready, not dispatched; node stays `sending`) · **`REFUSED`** with **`refusal_reason` mandatory** — one trial left it `"(n/a)"` and filed the real blocker under `missing_context`, which a script parsing refusals would never see.

**`kona lint` runs at author time — before a human is asked to approve.** Rules come straight from the 90 authoring defects.

1. Reject any node with >1 blocking in-edge and no declared `merge` *(catches all 8 OR-join deadlocks)*
2. Reject unknown fields — the vocabulary is closed, or divergence never stops *(7 defects)*
3. Every `gate` `decision_kind`, every `quorum.on_unsatisfied`, every `wait.on_timeout` names a **reachable** target *(8 dead-end defects, including an unreachable compensation)*
4. Deadline feasibility: parses, is future at approval, chain monotone against the event it serves *(`rsvp-deadline-can-postdate-game`, `wait-deadline-in-past-at-creation`)*
5. `effect_budget` ≥ computed worst-case pivots including `max_fanout` *(10 defects)*
6. Every `inputs[].ref` resolves to a **declared output**, not merely to a node id
7. Every pivot declares a recipient source and a correlation address, and both resolve — **no unexpanded template variables**
8. Edge-direction check extended to **annotating** edges; assert blocking in-degree ≥ 1 for every non-root *(the `cancel_booking` second-root bug)*
9. Reviewability budget: warn above N nodes / M chars of instruction *(6/8 were unreviewable in 30s)*
10. Ban load-bearing prose: any constraint gating a decision lives in a typed field; `instruction` is reserved for the human *(12 defects)*
11. **Never trust a self-reported lint pass.** Two trials claimed a validation they had not correctly run. `kona validate` is the gate; the model's own note is not evidence

**Exit codes are part of the contract:** `0` ok · `409` stale base version · `422` invariant violation (body names the invariant and the node) · `423` node leased by another agent.

**Hardcode the five queries the viewer needs** — ready nodes, blocked-on-wait, waits past deadline, recent mutations, rationale chain. **No query language.** (see 09 — Neo4j)

### 6.9. Block 2 — the Claude Code plugin and the approval step

**Harness constraints — verified against Claude Code docs 2026-08-21, not assumed:**

| Assumption | Status | Consequence |
|---|---|---|
| Subagents start with genuinely fresh context | ✅ **verified** — fresh unless explicitly forked | Properties (e) and (f) hold; `kona brief` really is the whole briefing |
| Subagents can run concurrently | ⚠️ **capped at 20** by default (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`) | See the reframe below — it is not binding in practice |
| Subagents can shell out and write files concurrently | ✅ **verified** — no harness serialisation or sandboxing; locking is ours | `flock` + CAS (§6.7.3) is the whole concurrency story, as designed |
| The plugin can ship the `kona` binary | ✅ **verified** — `bin/` is added to PATH automatically | No install step; the plugin *is* the distribution |
| A `SessionStart` hook can run `kona resume` | ✅ **verified** — `hooks/hooks.json`, `matcher: "startup"` | §6.7.4's reconcile fires automatically on a fresh session — this is the kill-and-resume beat, automated |
| Orchestrator → subagent nesting | ✅ **verified** — 3 levels allowed, we need 2 | Fine |
| The plugin can run the viewer as a managed background server | ❌ **not supported** — no idiomatic pattern | See §6.10; the user starts it. Not a redesign |
| Dispatch wall-clock per subagent | ❌ **undocumented** | Must be measured in the dry run; it sets the pace of the whole loop |

**The 20-cap reframe — subagents are for judgment, not for execution.** The instinct is that a 30-way fan-out needs 30 subagents and therefore two batches. It does not. Sending 30 templated emails is 30 *sends*, which the orchestrator does directly in one macro-step; there is nothing to reason about and nothing worth a fresh context window. A subagent is warranted only where a node needs **judgment** — reading a counterparty's reply, deciding what it means, proposing a mutation. Those arrive one at a time as replies land, not thirty at once. US7 asks for ≥2 concurrent subagents; the cap is 10× that. Budget ~10 concurrent to leave headroom for the main session, and batch explicitly rather than relying on harness throttling.

| Command | Does |
|---|---|
| `/kona:plan <brief>` | LLM authors the graph as a **batch of typed ops** against the node catalogue → CLI validates → frozen artifact → viewer renders → human approves |
| `/kona:apply <hash>` | Consumes *that artifact*; must not re-derive or re-prompt |
| `/kona:run` | Orchestrator loop: `kona next` → dispatch fresh-context subagent → subagent works, records status, **proposes** ops → orchestrator commits as one macro-step |

**The approval object is a frozen, content-hashed plan artifact.** This is the only defensible answer to "what exactly did the human approve?" (see 06 — Terraform)

**The gate is a node in the graph, not an out-of-band pause.** Otherwise approval cannot survive a crash — HumanLayer's own founder named the gap: *"Most frameworks do a bad job of handling any tool call that would be asynchronous or long running (imagine an agent calling a tool and having to hang for hours or days while waiting for a response from a human)."* (see 11)

**What the diff must show for a human to actually trust it** — this decides whether approval is real or theatre:

1. A **rendered delta on the graph itself**, not prose: ghosted new nodes, struck-through removals, highlighted rerouted edges, staged before commit (06 — Argo CD; 03 — Camunda Operate)
2. **The node plus its neighbourhood** — what produced this draft, what it unblocks, which quorum it serves. A HumanLayer reviewer approves `send_email(to=…)` blind; that is the failure to avoid, and it is the strongest argument for the viewer being the approval surface rather than a Slack card (11)
3. **The exact irreversible payload** — real recipient, real body — plus a viewable artifact pointer (13)
4. **Provenance per node** — the email, the roster row, the source fact. Turns review into verification rather than trust (01 — Devin)
5. **A one-sentence plain-language narrative** beside the graph. FlowMind ablated this and found user feedback improved results (05)
6. **`after_unknown` markers** on fields only knowable after a reply, rather than letting the LLM invent them now (06 — Terraform)
7. **Which provider handles the send, and whether it is a sandbox or the real internet** (13)

| Rule | Why |
|---|---|
| **DECIDED — mid-run mutation is fully automatic. There are no approval gates on TOPOLOGY, ever — which says nothing about EFFECTS, gated by §6.6.** Gate on irreversible *effects*, not on *mutations*: a mutation is versioned, rationale-carrying data in a file that the viewer shows the instant it lands, and it is never itself dangerous. Sending an email is. Those are already separate events (§6.6), so the gate belongs on the effect | Adaptive BPM died because change was **expensive and blameful**; putting a human back in the mutation path re-creates the exact failure Kona claims to have removed (04 — Reijers). It also breaks the demo's own claim: a pursuit cannot survive an overnight crash if a modal is waiting for a human at 2am. Terraform is the precedent — it does not ask you to approve plan *revisions*, only `apply` (06) |
| **Approval is scoped to the plan, not to the action.** The single pre-execution approval (property a) authorises the *class* of effects the plan declares — "will email up to 30 players from this roster" — exactly as `terraform plan` shows "will create 30 resources" and you approve once, not thirty times | 06 — Terraform |
| **A declared effect budget is the circuit breaker, and it replaces every gate we removed.** **Invariant 7** caps `max_fanout` and total irreversible sends against the budget declared in the approved plan. Exceeding it pauses the pursuit and asks. It fires approximately never — and it is the honest answer to "so it can just email anyone?" | 03 — Airflow's `max_map_length` |
| **`gate` nodes survive, but only when the *plan* declares a human decision** ("Ilya picks the final date"). Authored into the graph by the model at planning time, never injected by the system at mutation time | 01 — Linear's `elicitation` activity |

> **⚠ Read §6.6 and §6.9 together or you will get this wrong.** §6.9 removes gates on *mutations* — changing the plan. §6.6 keeps them on *effects* — acting on the world: a `pivot` node still requires an upstream gate, and the effect budget bounds everything else. An authoring trial reasoned through exactly this ambiguity, chose the §6.9 reading, and **shipped a graph with 12 irreversible sends and no upstream gate**; another dodged the rule by classifying an email send as `compensatable`. The sentence to hold on to: **the plan changes freely; the world does not.**

**What actually carries the safety, stated precisely** (§6.7.1) — because the honest version is narrower than "an invariant handles it":

| Guard | Where it lives | Strength |
|---|---|---|
| Superseding a node that already emailed someone requires a compensation in the same commit | **invariant 5**, enforced | hard |
| A quorum must remain satisfiable | **invariant 6**, enforced | hard |
| Cumulative irreversible sends ≤ the approved budget | **invariant 7**, enforced | hard — this is the circuit breaker that replaced the gates |
| A new precondition may not contradict an already-executed action | **report-only** (§6.7.2) since the 16→7 cut | *soft — annotated in the viewer, does not block* |
| The executing node's preconditions actually hold | `kona brief`'s fail-closed `preconditions_satisfied` (§6.8.1) | hard, at execution rather than at commit |

So: **mid-run, the store enforces structure and the budget; it does not adjudicate whether a mutation is *wise*.** The mutation path's real floor is invariant 7 plus the brief's fail-closed check — not a general contradiction detector. Say it that way rather than claiming more. Net effect on the demo: one approval at the start, then it runs untouched — and the goalie re-plan becomes a moment you *watch* rather than a modal you dismiss.
| **No timed auto-proceed** | A 30-second countdown is fine for a sandboxed VM and unacceptable when the side effect is an email to a real person; it trains people to rubber-stamp (01 — Devin) |
| **A denial is a mutation.** The human's verbatim text becomes the `rationale`; the four-way taxonomy is `accept \| edit \| respond \| ignore` with a per-node config of which are permitted | Makes the human a first-class mutator and reuses D4 for free — refusals become procedural memory, not a status flip (11 — HumanLayer, LangGraph) |
| **Validate before you version** | A human approval that fails validation is rejected *before* it is written; the log records decisions, not malformed attempts (11 — Temporal Update validator) |
| **Subagents propose; only the CLI commits** | Graphiti #1728 wrongly retired 41% of one deployment's facts because an LLM's fuzzy answer was applied directly (07) |
| **Subagent context is a subgraph walk, not a transcript** — `kona brief <node>` | StateFlow's single growing message list is the anti-pattern; the graph file, not a transcript, is the source of truth, or D1 is unachievable (05, 07) |
| **Ship the §6.2 catalogue verbatim into the plan prompt — never paraphrase it.** Three authoring trials believed `gate` has no `deadline` field when §6.2 requires one; that stale copy alone produced four stuck-gate defects | the probe's cheapest finding |
| **State the annotating-edge direction convention as loudly as the blocking one** (§6.2) | inverted in 3 of 4 briefs; one created a second root `kona next` could have dispatched |
| **Require a premise check before authoring** — one lookup confirming the named job / tenancy / counterparty exists, recorded as a fact rather than baked into node names | **2 of 4 briefs referenced entities that do not exist** (no "Maple Street" job among 799 in the live ledger) and 8/8 runs produced a confident, well-formed, approvable graph anyway |
| **Require a worst-case pivot count reconciled against `effect_budget`** before the human sees the plan | one graph's own author note computed worst case 23 against a declared budget of 20 |
| **Require a ≤10-line plain-language header** — what it does, where it can spend, where it stops for you | 6/8 authored graphs were unreviewable in 30 seconds, which makes §6.9's "the human sets scope once" a rubber stamp |
| **Two prompt-level footguns, free from Beads' docs:** temporal phrasing inverts edge direction ("X comes before Y" → wrong edge; force "Y needs X"), and numbering steps does not create sequence | Both caught by `kona lint` — which is exactly where human review sits (01) |
| **Small MCP surface if ever built** | Task Master's 36 tools cost ≈21,000 tokens per turn. Serve the protocol as a *resource*; keep tools to the mutation verbs (01) |

**And the strongest justification for having the gate at all, worth quoting on stage:** writing to procedural memory is *"significantly riskier than writing to episodic or semantic memory, as it can easily introduce bugs or allow an agent to subvert its designers' intentions."* Kona is exactly the agent doing that. (see 07 — CoALA)

### 6.10. Block 3 — the viewer

React Flow (`@xyflow/react`, **fully controlled**) + dagre `rankdir:'LR'`, positions derived on every version. DOM nodes are what make "click a node, read why the graph changed" a `<div>` rather than a hit-testing project. Burr proves the shape is 12-hour-achievable.

**The viewer is a separate process the user starts — `kona view` — not something the plugin spawns.** Claude Code has no supported pattern for a plugin to manage a long-running localhost server (verified 2026-08-21; background *monitors* stream stdout, they do not host a server). This costs nothing and is arguably more correct: the viewer holds zero authoritative state and is a pure observer of the file, so it is not part of the pursuit and should not share its lifecycle. For the demo it is on screen from the start anyway — you would never want a server spawning mid-run.

**The anti-spaghetti mechanisms — this is R2, and it is demo-critical, not polish:**

| # | Rule | Source |
|---|---|---|
| 1 | **Collapse fan-out groups by default**, one container node with an aggregate status — "goalies · 7 sent / 3 replied / 2 timed out" — and **redirect edges from hidden children to the container** | 10 — G6 combos, ComfyUI `parent_id`/`display_id` |
| 2 | **Groups are real nodes the LLM emits alongside the children, in the same mutation.** If grouping lives only in the viewer, the multi-agent substrate loses it | 10 — Unreal comment boxes |
| 3 | **Cap the visible altitude** — under ~100 nodes in the default view. Acceptance test: a reviewer understands it in 30 seconds | 10 — Mermaid, Unreal |
| 4 | **Deterministic layout; animate, don't snap.** Same graph ⇒ same coordinates; pin visual order by insertion order (which Kona controls, because mutations are append-ordered); tween between layouts | 10 — ELK has no incremental mode; vis-network physics |
| 5 | **Never re-layout on a status tick.** Memoize dagre keyed on `graph_version`; re-layout only on topology change | **Burr #834 froze this exact view on dense transitions until July 2026 — the fan-out moment is where it bites** (02) |
| 6 | **Every node renders its own state inline** — status chip, wait predicate, deadline countdown, quorum counter ("1/1 goalie"), and for a blocked node **the reason as text** | Dify's biggest UX complaint is leaving the graph to see what happened; CMMN died of hidden behaviour; Node-RED's per-node `status()` line is trivial to reproduce (02, 04) |
| 7 | **The second panel is the mutation timeline** — version + op + rationale, newest first, with a scrubber that re-projects at any version. **That panel, not the canvas, is the differentiator** | 03 — Airflow 3 version-pinned rendering; 09 — Datomic as-of |
| 8 | **The scrubber must look nothing like undo.** Read-only time travel; explicitly not React Flow Pro's Undo/Redo, explicitly not Kestra's revert button | 10, 03, 09 |
| 9 | **Three-colour runtime state on waits** — fulfilled / temporarily violated (awaiting, within deadline) / permanently violated (deadline blown, timeout branch live) | 04 — DECLARE |
| 10 | **Read-only for topology; intervention allowed on status.** Groot2 disallows adding nodes in Monitor mode while offering breakpoints and force-SUCCESS/FAILURE — copy both halves, routed through the CLI so it lands in the log | 06 — Groot2; 10 — Drawflow |
| 11 | **Fan-out arms named after the counterparty, not hashed** — `goalie/dana` | 01 — Beads `--ref arm-{{name}}`; 03 — Dagster `mapping_key` |
| 12 | **Localhost only, zero outbound calls, metadata-only by default** with an explicit reveal toggle. The graph holds counterparty names and email bodies; Haystack's default renderer ships your graph to the public mermaid.ink service — the exact mistake not to make, and an audience will notice | 02, 08 |
| 13 | **Presence, not co-editing.** A swimlane of "who wrote what, when" is more legible for multi-agent than a graph overlay | 02 — XState Inspector; 09 — Yjs awareness |
| 14 | **`kona graph --json` + file-watch/SSE is the one read contract** | 01 — Beads |
| 15 | **Mermaid for the pre-execution approval snapshot only** — the model writes it fluently and it renders inline with no viewer running. Never for the live view | 10 |
| 16 | **Prototype the diff animation first** — file change → re-layout → tween → flash the new subtree. Kona's core claim is only *visible* if the viewer shows topology changing. Build that before styling anything | 10 |

**Do not build a graph editor.** Flowise — 55k stars, Workday-acquired 2025 — was archived **2026-08-13**, nine days before the demo, its maintainers citing coding agents beating "the typical rigid workflow low-code approach." The lesson is not "graphs are dead"; it is **"human-authored static graphs are dead."** (see 02)

### 6.11. Block 4 — the demo rig ⚠ **a correction to PRD §14**

The research contradicts the PRD's mailbox decision on three independent grounds:

| PRD §14 assumption | Finding |
|---|---|
| AgentMail MPP-metered, **$2/inbox, ~$60 for 30** | **Matches no published plan.** 30 inboxes falls in the dead zone between Developer (10 · $20/mo) and Startup (150 · $200/mo). Email support@agentmail.cc before committing. (13) |
| 30 real inboxes, live round-trip on stage | **New domains need ~4 weeks of sender reputation**; Gmail suspension is per-account and 24h — longer than the demo window; and spam placement is **silent**: no bounce, no error, the graph shows "sent, waiting for reply" forever. (13) |
| Webhooks deliver replies | **No provider offers a delivery guarantee strong enough to be state.** (13) |

**DECIDED (2026-08-21) — one plus-addressed mailbox, two accounts, $0.** The insight that collapses the problem: **the correlation token belongs in Kona's own `Reply-To`, not in the counterparty's identity.**

```
From:     ilya@gmail.com
To:       dana.persona@gmail.com
Reply-To: ilya+kona-goalie-dana@gmail.com     ← the node id, in the address
```

The persona replies to that; it lands in the one inbox; the plus-tag names the exact WAIT node it satisfies — **no LLM call, no header archaeology, and no dependence on the `From` address.** The fan-out never needed 30 receive identities; it needed 30 *tags on one*.

| Component | Decision |
|---|---|
| Kona's mailbox | **One** — Ilya's real Gmail. Every outbound sets `Reply-To: ilya+kona-<node_id>@gmail.com` |
| Persona sender | A **second** ordinary Gmail; one SMTP session, N replies, distinct `From:` display names. Two accounts, not one, because Gmail threads a message you send to yourself instead of delivering it |
| Cost | **$0.** No provisioning, no wallet, no new domain, no reputation ramp |
| Offline fallback | **Mailpit**, behind the same `MailboxProvider` port (`provision / send / poll-thread`) — deterministic, zero stage risk (D8) |
| AgentMail | **Free tier, 1–2 hero branches only.** Keeps the agent-native-inbox beat at $0. Not the fan-out — see the cap note below |

1. **`MailboxProvider` port stays** — provider is a config value, never a schema decision. `gmail-plus` (default) · `mailpit` (offline) · `agentmail` (one hero branch).
2. **Two independent correlation keys, free.** Primary: the plus-tag on the reply's `To:`/`Delivered-To:`. Fallback: `In-Reply-To` → message-id → node. The wait schema already stores `{thread_id, last_seen_message_id}` (§6.5), so the second key needs no new fields — if a client drops `Reply-To`, threading still routes the reply.
3. **Aliases vs plus-addressing — the distinction that makes this safe at exactly our cast size.** Gmail *send-as aliases* are capped (~30/user); **plus-addressing is uncapped** because it is local-part parsing, not a configured identity. We need ~31 tags and zero aliases.
4. **Deliverability is now the safest available path**: Gmail↔Gmail between two established accounts — no new domain, no four-week reputation ramp, well inside the 500/day consumer limit. Vary each body per persona (the personas require this anyway) so 30 near-identical messages don't trip bulk heuristics.
5. **Every send records `provider` and `sandbox_or_real`** so a demo run can be replayed and proven contained.
6. Personas, the rival captain and the scripted goalie-decline are `kona event add` injections — which double as the live-failure fallback for every external hop (PRD R5).

**Why AgentMail free can't carry the fan-out even if it supports `+`.** Whether AgentMail does sub-addressing is **UNVERIFIED** — the corpus records only that "the inbox ID *is* the address." It probably does, and it is a five-minute test (create one free inbox, send to `inbox+test@…`, confirm the tag survives on `To:`). But the binding constraint is not the 3-inbox limit, it is the **~100 messages/day cap**: one full run is ~60 messages (30 out + 30 replies), so **two rehearsals exceed the daily cap before demo day** — exactly when the rig must be exercised repeatedly. Gmail's 500/day absorbs eight full runs. Hence the split by volume, not by credibility: Gmail carries throughput, AgentMail carries the branch where its API *is* the story. If the `+` test passes, the fan-out can be swapped to AgentMail later without touching the schema — that is what the port is for. *(All AgentMail tier figures are unverified vendor/directory numbers; confirm before depending on them.)*

*Rejected: 30 agent-provisioned AgentMail inboxes (PRD §14 v3.9).* The `$2 × 30 ≈ $60` line matches no published plan — 30 falls between Developer (10 · $20/mo) and Startup (150 · $200/mo) — and a new domain sending 30 emails in minutes fails **silently**: spam placement produces no bounce and no error, so the graph would show "sent, waiting for reply" forever. (see 13)

**Feed subagents the quote-stripped body** (Postmark's `StrippedTextReply`). The reason is token cost — a threaded reply carries the entire quoted history — not security. (see 13)

*Out of scope: prompt injection via inbound mail.* The demo's counterparties are personas we author, so there is no adversary; and in the general case this is the ordinary "an agent reads untrusted content" exposure that every tool reading a webpage or a file already has — Kona does not introduce it. If asked: the closed op vocabulary (§6.4) and the human gate on destructive ops (§6.9) already bound what any injected instruction could express, because both exist for correctness reasons anyway. No build item.

### 6.12. Pros, Cons, Consequences

**Pros**
- D1–D5 are enforced by schema and CLI, not by prompts — the only durable way to constrain an LLM mutator.
- Zero infrastructure. Four windows build in parallel behind one JSON contract.
- The mutation log is simultaneously the audit trail, the viewer's scrubber, the procedural memory and the pitch. One mechanism, four claims.
- Every choice has a named precedent, so the concessions ledger (PRD R3) writes itself and the novelty claim narrows to something true.

**Cons**
- No semantic merge. Conflicting proposals get a `409` and one agent re-decides — correct, but it burns a model call.
- Fold cost is O(history). Irrelevant at demo scale; compaction is future work and must compact *state* while keeping *rationale*, never the reverse.
- The invariant set is a floor, not soundness. Seven cheap linear-time checks; everything else is a logged judgment call. Say this proactively — it is the honest "hard problem for the product, not the prototype" line (PRD R4).
- The `sending`-crash window requires a human. Honest rather than convenient.

**Consequences — three corrections the research forces on the pitch**
1. **Runtime graph mutation shipped in 2008 (ADEPT2).** Never claim the mechanism. Claim the mutator, the irreversible timeline, and the rationale-as-briefing.
2. **Versioned-mutation-with-rationale is also 2008 prior art** — ADEPT2's change logs carried "change reason and change performer." Pre-concede it.
3. **No-rollback is the mainstream position, not a shortcut** — YAWL's validator hard-rejects `rollback` while shipping `compensate` as first-class; Sagas is from 1987. Cite it as validation.

**Promote the under-claimed property.** The strongest and narrowest novelty in the ledger is not topology mutation — it is **WAIT semantics on an irreversible timeline**. Nothing in the LLM-workflow-search literature has a clock or a counterparty; nothing in the tracing/provenance category holds the future at all; LangGraph re-runs the node; CrewAI's async human-in-the-loop is an open unanswered issue. *"Ask any agent framework what happens when the reply arrives in three days and the process is dead."* (see 00 — Novelty ledger)

---

## 7. Testing Strategy

**Quality bar — set by Ilya 2026-08-21, then made OPTIONAL 2026-08-21. Coverage and mutation score are targets to aim at, not gates that block.**

Only two gates actually block: **lint clean** and **typecheck clean**. Both are ~free and catch real defects, so they stay mandatory. Everything below is the standard to work toward where time allows — highest value first, and the ranking is the useful part now that the bar is not enforced.

| Gate | Requirement |
|---|---|
| **Line + branch coverage** | *Target* 100% on new/changed code. **Not a gate** |
| **Mutation score (StrykerJS)** | *Target*, per-module floors — see below. **Not a gate.** If time is short, run it on `validate()` alone and skip the rest |
| **Lint** | **GATE — clean, zero warnings** |
| **Typecheck** | **GATE — clean, `strict` on** |

**Mutation targets by module.** Stryker's own defaults are `high: 80, low: 60, break: null` — the tool ships treating 80 as good and never failing the build. A flat 100 across a whole repo is not a stronger bar, it is a *misallocated* one: the 90→100 stretch typically costs as much as 0→90 and is spent almost entirely on equivalent mutants and defensive branches. Concentrate it where a surviving mutant is a defect.

| Module | `break` | Why |
|---|---:|---|
| `validate()` — the 7 enforced invariants (§6.7.1) | **100** | Pure, branch-heavy, and a surviving mutant is **a bad graph that commits**. Highest-value target in the codebase |
| `fold()` — mutations → graph (§6.1) | **100** | Pure function, and it *is* the file's correctness |
| `effect_key` lifecycle + outbox (§6.6) | **100** | Guards duplicate irreversible sends — precisely what mutation testing is for |
| CAS / `flock` / lease (§6.7.3) | **95** | Some timing paths cannot be mutated meaningfully |
| CLI parsing, `brief` assembly, viewer projection | **90** | Real value, diminishing fast |
| Viewer (React components) | *excluded* | Mutation testing on rendering is mostly noise |
| Demo rig | *excluded* | Throwaway by design |

**Per-package invocations from day one**, each with its own committed config and floor — treasury's pattern, and its CI spec found a single serial Stryker job was the entire pipeline's wall-clock pole at 19.8 min.

**The equivalent-mutant rule of thumb:** if killing a mutant requires a test you cannot state as a behaviour ("given X, when Y, then Z"), it is probably equivalent — `// Stryker disable next-line <mutator> : <reason>` it rather than contorting the test. Every disable carries a written reason and is reviewed like code.

All code is written **test-first (RED → GREEN → REFACTOR)**. A test that has never failed has not been shown to test anything.

**One operational note:**

1. **Stryker + Bun is proven in your own toolchain** — the treasury repo runs Stryker 9.6.1 against `bun run --filter <pkg>` across 11 packages, so the runner configuration is a copy, not a research task. Split invocations per package from the start (treasury's CI spec found a single serial Stryker job was its entire wall-clock pole at 19.8 min).

**PRD §14's shaping stands unchanged** now that coverage and mutation score are optional — that tension is resolved. **If you write only one test suite on Friday, write the one for `validate()`** (the 7 enforced invariants, §6.7.1): it is pure, branch-heavy, has no I/O, and a surviving mutant there is a bad graph reaching the file. Second priority is `fold()`. Everything else can wait for the hardening pass. Two coherent readings, and they need different plans:

- **As the standing bar for Kona as a product** — correct, and the natural place to enforce it is after the hackathon, on the code that survives. Friday ships a prototype; the bar applies to the hardening pass.
- **As a Friday constraint** — then §14 must be re-shaped: the honest version is Block 1 (store + invariants) built to the full bar and Blocks 2–4 cut hard, because the store is where a mutation-tested invariant actually pays. Attempting all four blocks at 100/100 in 12–14 hours will not land.

Flagged here rather than silently absorbed. **Ilya's call — see §11 Q6.**

### 7.1. Unit — written first, non-negotiable (Block 1)

| Unit | Critical behaviours |
|---|---|
| `fold(mutations) → graph` | determinism; full fold ≡ snapshot+tail; tolerates a truncated final line (torn write); partial-tolerant on an unknown node type |
| `validate(graph, ops)` | one test per invariant #1–#7, each asserting **rejection with the right reason** |
| Suppression rule | a semantically-equal re-plan writes **no** version |
| `effect_key` lifecycle | minted at creation; the three crash windows (§6.6) resolve to retry / retry / **ask-human**; key match + payload mismatch ⇒ loud error; `done` never re-fires |
| CAS + lock | stale `--base-version` ⇒ 409 + head; concurrent writers serialise; lock released on crash; **never held across a wait** |
| Lease manager | two agents cannot hold one node; expired leases reclaimed |
| Op ordering | additions/rewires strictly before cancellations |
| Fan-out addressing | ops target node *instances*; ambiguous parent scope ⇒ error, never a guess |
| Merge rules | status lattice; replies by set union; quorum count by **recomputation**, not a mutable integer |

### 7.2. Integration (end of Block 1, before Block 2 lands)

| Test | Asserts |
|---|---|
| **`kill -9` mid-mutation** | restart makes progress with zero session state; only overdue timeouts fire; **nothing re-sent** |
| **Duplicate-send guard** | crash between reserve and record ⇒ `sending`, no re-send, human surfaced |
| **Fan-out → quorum** | 30 instances, replies out of order, quorum flips exactly once, the other 28 waits auto-**obviated with a rationale** |
| **Premise break** | goalie declines ⇒ quorum unsatisfiable ⇒ **invariant 6** forces a re-plan branch rather than a silent bad graph |
| **Divergent arms** — *the end-to-end acceptance test for the whole product claim* | Run the pursuit to completion from an approved v1 plan in which every arm has the identical shape `invite → wait → {yes\|no\|silent}`. Then assert against the final graph: **(a)** it contains ≥1 node whose `template_id` appears nowhere in v1 — i.e. structure the approved plan never described; **(b)** ≥1 counterparty node exists whose `instance_key` was not in the v1 roster input; **(c)** at least three arms have **pairwise different node counts**; **(d)** ≥1 arm has an edge leaving its own `group` into another sub-flow. If (a)–(d) pass, the run produced structure no parameterised fan-out could. If they fail, the system demonstrably behaved as `withParam` regardless of how the code is written |
| **Snapshot loss** | `rm .kona/graph.json` ⇒ next command rebuilds identically |
| **Two subagents, one graph** | concurrent proposals; one commits, one 409s and re-decides; no corruption, no double-send |
| **Late reply after timeout** | lands as a logged event on an obviated node; does **not** silently reopen a closed sub-flow |

**Why this one test carries more than the others.** Every probe so far validated a *piece* — the mutator emits legal ops, the planner authors a graph, a fresh agent executes from `kona brief`. None of them answers the actual claim: *does a pursuit finish structurally different from what was approved?* If every arm ends the same shape as v1 with statuses filled in, the graph at v80 is the graph at v1 and the product is a parameterised loop — which Argo has shipped since 2018. This is the only test that can fail in a way that invalidates the premise rather than a component.

### 7.3. Not automated — rehearsed instead

Viewer rendering, readability at 30+ nodes, and the demo rig go through the **two full dry runs** in PRD §14's integration block, with kill-resume rehearsed twice. R2 is validated by eye against the full cast before the persona count is frozen (rule #3: a reviewer understands it in 30 seconds).

---

## 8. Definition of Done

### Universal

- [ ] `bun test` passes; §7.1 and §7.2 green
- [ ] `bun run typecheck` clean (`strict`) — **gate**
- [ ] `bun run lint` clean, zero warnings — **gate**
- [ ] *(optional, §7)* coverage and Stryker targets — aim for them on `validate()` and `fold()` first; not blocking
- [ ] `kona --help` documents every verb; every read supports `--json`; exit codes match §6.8
- [ ] `schema_version` in every on-disk file
- [ ] SPEC updated wherever the implementation diverged

### Feature-specific

- [ ] **`--why` is a required argument on every mutating verb.** A commit without a rationale is impossible, not discouraged *(D4)*
- [ ] All 7 enforced invariants checked pre-commit, each with a distinct human-readable rejection naming the node
- [ ] **Rejected mutations are logged**, not silently dropped — a refused mutation is procedural memory too *(§6.7.2)*
- [ ] No `delete_node` verb and no `rollback` opcode anywhere in code or schema
- [ ] `deadline` and `on_timeout` schema-required on every `wait`; a wait without them fails validation
- [ ] The suppression rule works: a semantically-equal re-plan writes no version
- [ ] `.kona/graph.json` is deletable and rebuildable *(proven by the §7.2 snapshot-loss test)*
- [ ] Nothing outside the CLI reads or writes `.kona/`
- [ ] `kona resume` on a fresh terminal prints correct status in **< 60 s** with no session state *(US5)*
- [ ] Every irreversible node carries an `effect_key` minted at creation; the three crash windows behave per §6.6 *(D3)*
- [ ] **No approval gate exists on any topology mutation** — the whole pursuit runs on one pre-execution approval *(§6.9)*
- [ ] The plan declares an effect budget; exceeding it pauses the pursuit rather than sending *(invariant 7)*
- [ ] Only the orchestrator mutates topology; a subagent attempting it is refused *(D5)*
- [ ] Viewer holds zero authoritative state; dagre memoized on `graph_version` *(Burr #834)*
- [ ] Fan-out groups collapse by default with edges redirected to the container *(R2)*
- [ ] Rationale timeline is a first-class panel; clicking any node shows its log and its why *(US3)*
- [ ] Scrubber is visually distinct from anything that reads as undo *(D3)*
- [ ] Viewer makes zero outbound network calls; message bodies redacted behind an explicit toggle
- [ ] Startup refuses to run on a network filesystem
- [ ] Repo public before the demo with `docs/research/` included — the concessions ledger is the receipts

---

## 9. Alternatives Not Chosen

| Alternative | Why rejected |
|---|---|
| **Temporal / Cadence / Restate as the runtime** | Deterministic replay structurally forbids mid-flight mutation and re-executes side effects. Temporal's own Nov 2025 post concedes the boundary: *"Deterministic in execution … BUT NOT predetermined"* — their dynamic agent is a fixed loop whose *body* an LLM picks; the loop's topology never changes. (03) |
| **LangGraph as the substrate** | Checkpoints carry `channel_values` and **zero** topology. Its `Send` fans out N invocations of one *pre-declared* node; Kona's fan-out creates N nodes with distinct types, waits and deadlines. Its interrupt-and-re-run model is a multi-year defect area. (02, 11) |
| **Burr as the substrate** | Closest shipped neighbour and the source of the viewer stack — but its writer refuses to rewrite `graph.json`, the human sits *outside* the graph (needs a live process; cannot express "wait for Dana until Friday"), and it performs no validation, which is fine when a human wrote the machine once and unacceptable when an LLM rewrites it mid-run. (02) |
| **A BPMN/CMMN engine (Camunda, Flowable, jBPM)** | Runtime modification genuinely ships — as a *privileged human repair tool*. C7's docs: *"Process instance modification within the same instance is not recommended! An activity which tries to modify its own process instance can cause undefined behavior."* Kona's premise is that the running agent is the normal mutator; we inherit their mechanics and pay the reentrancy cost they avoided by forbidding it. (03, 04) |
| **CRDT (Automerge / Yjs / Loro)** | Convergence ≠ validity; nothing can *reject* a merge. Single writer on one machine is exactly the case where CRDT complexity buys nothing. (09) |
| **Dolt / embedded versioned SQL** | Beads' migration failed in the field; cell merge yields logically valid-but-wrong rows. (01, 09) |
| **SQLite + WAL** | Honest runner-up and the documented migration path. Costs the `cat`-able file and the readable diff. |
| **Event-sourcing purism (log only, no snapshot)** | Agents and humans read the graph directly; O(1) resume matters. Snapshot + log is the category's convergence. (09) |
| **Mermaid for the live view** | Full SVG rebuild destroys node identity, animation and pan/zoom. Kept for the approval snapshot only. (10) |
| **Selecting sub-flows from a catalogue (YAWL worklets / CMMN)** | Precisely the ceiling Kona breaks: *"worklets chose from a catalogue a human wrote; Kona writes the sub-flow."* Kept as the pitch's ablation baseline. (04) |
| **Regenerating the plan on re-plan** | Destroys node identity and therefore the binding between a node and the email it already sent — breaks D1 and D3 at once. (05) |
| **ELK.js** | Highest layout quality, highest integration risk; the React Flow docs themselves say *"We don't often recommend elkjs."* dagre unless a working example is copied wholesale. (10) |
| **React Flow `parentId` / `extent:'parent'` sub-flows** | Child positions are relative forever (#3393, open since 2023) and dagre's cluster support is its weakest part. Lay out flat, draw group boxes from child bounding boxes. (10) |
| **MCP server in v1** | PRD §13: design-for, don't build. The CLI's `--json` contract is the migration path; a large tool surface costs ~21k tokens/turn. (01) |
| **A protocol, registry or discovery layer** | ACP was archived four months after shipping. Speak MCP for tools; the defensible surface is the artifact, not the transport. (12) |
| **Compaction / GC of the mutation log** | `bd compact --days 7` made 42 of 43 sampled version addresses vanish. Kona's history is the product. (01) |
| **Conformance / soundness checking as a runtime gate** | Real soundness is EXPSPACE-complete and undecidable for reset nets; and a checker that "fails" a divergent run has nothing to do under no-rollback. Ship it as a viewer ribbon. (04, 06) |
| **Learned-template auto-replay / cross-run skill library** | Soar keeps chunking **off by default** after four decades; AWM reports offline workflows *impairing* online ones. Suggest to the human; never auto-apply. (06, 05) |

---

## 10. References

**Primary — `docs/research/`** (200 technologies, 69 agents, compiled 2026-08-21):
`00-design-lessons.md` (synthesis · 405 inline citations) · `01` agent trackers & plan artifacts · `02` graph/state-machine agent frameworks · `03` durable execution & workflow engines · `04` adaptive BPM & process flexibility · `05` LLM-authored workflow graphs · `06` planning, plan repair & reactive plans · `07` memory systems · `08` traces, provenance & observability · `09` versioned & concurrent storage · `10` graph rendering & the viewer · `11` HITL, approval & irreversibility · `12` multi-agent coordination substrates · `13` mailboxes & the demo rig · `14` incremental computation & build graphs.

**Canonical citations for the concessions ledger (PRD R3)**

- Reichert & Dadam, *ADEPTflex* (1998); *ADEPT2* (ICDE 2005) — correctness-preserving structural change of running instances; change logs carrying change reason and performer.
- Schonenberg, Mans, Russell, Mulyar & van der Aalst, *Towards a Taxonomy of Process Flexibility* (CAiSE'08) — flexibility by design / deviation / underspecification / **change**.
- Ellis, Keddara & Rozenberg (1995) — the dynamic change bug and the reachability criterion.
- Adams, van der Aalst & ter Hofstede — YAWL worklets & exlets; `rollback` reserved and hard-rejected, `compensate` first-class.
- Reijers, *Workflow Flexibility: The Forlorn Promise* (IEEE WETICE 2006).
- Zhang et al., *AFlow* (ICLR 2025 Oral); Wu et al., *StateFlow* (COLM 2024) — LLM-authored structure, topology fixed before the episode.
- Garcia-Molina & Salem, *Sagas* (1987) — compensation, not rollback.
- Camunda 7 docs — *"An activity which tries to modify its own process instance can cause undefined behavior."*

**⚠ Citation correction.** Current Beads is **Dolt-backed**, and `issues.jsonl` is an *export only* — its README says it is *"not the source of truth or a backup."* Cite Beads as *"a CLI-mutated local store with a git-synced history and a JSONL export for viewers."* The frozen SQLite+JSONL architecture Kona actually imitates is **`beads_rust`/`br`**, whose stated philosophy is *"it never commits, pushes, pulls, installs hooks, or runs as a background service."* Getting this wrong in front of someone who knows Beads is an unforced error. (see 00 — Open questions #10)

**⚠ Sentiment caveat.** All community sentiment in the research library is Hacker News + GitHub issues; **Reddit was unreachable in every research pass**, and several entries are explicitly marked "no signal found" — which is not the same as "no complaints exist." Do not cite absence of criticism as quality.

**Project documents:** [`prd.md`](./prd.md) · [`prfaq.md`](./prfaq.md) · [`research/README.md`](./research/README.md)

---

## 11. Open Questions

### The one that decides whether to build

| # | Question | Status |
|---|---|---|
| **Q4** | **Is the mutator premise validated?** | **NO — and this is the headline risk.** v1 55%, v2 50% (n=20, difference −5pp ± 31pp: *unchanged*, not regressed). All six schema fixes worked on exactly what they targeted — inv 1: 7→1, inv 3: 5→1, symbolic refs 0→20/20, `record_outcome` 20/20 — but **accept was never bounded by schema legality.** The residual is branch semantics and liveness. **All 10 accepted commits ship at least one substantive silent defect**, and 2–4 of them are permanently stuck graphs |

**Two things close it, and the second matters more:**

1. **Does the retry loop converge?** *(Probe 5, designed, not yet run.)* Every number so far is **first-attempt, zero-feedback** — the hardest version of the question. In the real loop the CLI rejects with a named invariant and the agent re-decides. If attempt 2 fixes a deterministic invariant error, **50% raw is survivable and the premise holds.** If it thrashes, no schema change rescues it. Nobody has tested this; it is the single most decision-relevant unknown left.
2. **Do the five v2 contract bugs move raw accept?** *(v3, n≥60.)* See Q9.

**A correction I owe on the threshold.** I set "raw accept must clear ~0.90" without checking the instrument could measure it. **n=20 cannot certify 0.90 even at a perfect score** — 20/20 has a Wilson lower bound of 0.839. Certifying ≥0.90 needs n≥60. The per-fix metrics (0/20→20/20) are readable at n=20; the accept rate is not. Any v3 must run at n≥60 or it answers nothing.

### Open — need a decision

| # | Question | Status | Default |
|---|---|---|---|
| **Q9** | **Five contract bugs the v2 probe found**, all cheap: (a) **invariant 4 punishes tidying** — retiring a timeout branch that can never fire leaves `on_timeout` naming a terminal node, and this is **5 of the 10 rejections**; relax it to apply only while the wait is non-terminal. (b) **`quorum.over="invite@*"` is an id glob** and symbolic refs mean the server mints ids, so a new invite cannot be proven in-population — declare membership explicitly. (c) **Unfired conditional branches are undefined** — the root cause of the dominant silent deadlock; agents invented an assumption and built on it. (d) **`add_wait` has no label slot** though `label` is required. (e) **A gate is "deadlock or toothless"** — no accept-only edge kind exists | Specified, not applied | Apply all five, then v3 at n≥60 |

### Open — only closable by building

| # | Question |
|---|---|
| **Q7** | **Nothing checks whether the pursuit's premises are true.** 2 of 4 briefs referenced entities that do not exist and **8/8 runs produced a confident, approvable graph anyway.** Mitigated by a prompt requirement; nothing enforces it. The failure mode most likely to survive into real use |
| **Q8** | **The irreversible step has never been exercised.** Both EXECUTE arms composed a correct payload and stopped at the transport — 0/4 dispatched. Decision correctness proven; send correctness not. First integration test after Block 1: reserve → send → record, with `kill -9` in each of §6.6's three windows |

### Resolved

| # | Resolution |
|---|---|
| **Q2** | **Divergent arms** → written up as §7.2's end-to-end acceptance test (assertions a–d) and PRD §9's script. Sam's referral of an off-roster goalie is the *recovery path* from the premise break, not a bolted-on beat |
| **Q6** | **Coverage / mutation-score bar** → **optional** (Ilya). Lint and typecheck remain gates; coverage and Stryker are targets, aimed at `validate()` and `fold()` first. PRD §14's shaping stands unchanged |
| **Q1** | **Mailbox** → one plus-addressed Gmail + one persona sender, $0; Mailpit fallback; AgentMail free on 1–2 hero branches (§6.11) |
| **Q3** | **Mid-run approval frequency** → **never.** Mutation is automatic; approval is scoped to the plan once; the effect budget is the circuit breaker (§6.9) |
| **Q5** | **Prompt injection via inbound mail** → out of scope (Ilya). Authored personas; general untrusted-content exposure; the closed vocabulary and effect gate already bound it |

### Non-blocking, recorded for honesty

- What fills `outcome` for a **diffuse** mutation — a reroute, a group creation — whose effect never gets its own wait.
- Whether the rationale log is reusable as memory *within one pursuit*. AWM is the closest published work and reports offline workflows *impairing* online ones. Asserted, not evidenced.
- **Accept = "no invariant fired," exactly 1:1 across both runs.** Everything the suite does not name passes by construction. Rationale fidelity was deliberately held back to keep v1↔v2 comparable, then enabled for v3, and now lives as lint rule **L5** — 3/20 v2 rationales were machine-checkably false.
