# Technical Specification (SPEC) — Project Kona: the living workflow graph

**Status:** Draft — awaiting approval · **Owner:** Ilya Vorobiev · **Date:** 2026-08-21
**Constraint:** one operator, four parallel Claude Code windows, 12–14 hours, demo Aug 22 @ AGI House.

> Every decision below is argued from `docs/research/` — a 200-technology prior-art library compiled 2026-08-21
> by 69 research agents, distilled in [`research/00-design-lessons.md`](./research/00-design-lessons.md).
> Citations read `(see 04 — ADEPT2)` → `docs/research/04-*.md`, section `## ADEPT…`.
> Where the research **contradicts the PRD**, it is called out rather than smoothed over (§6.11, §11).

---

## 0. TL;DR

**The graph is a fold over an append-only mutation log, and nothing else is the truth.** `.kona/mutations.jsonl` is the system of record, and after §0.5 it is the **only** file — reads fold the log; there is no snapshot to keep coherent. Folding is a pure data operation — it is **not** Temporal-style replay and never re-executes an action. That single inversion is what lets Kona have crash-resume *and* mid-run topology mutation at once; every replay-based engine in the survey buys resume by forbidding mutation (see 03 — Temporal).

- **3 node types · 6 ops · 3 edge kinds · 5 statuses · 4 invariants · ~10 CLI verbs. One file.** Conceptual sprawl is a named cause of death (see 01 — Gas Town). Ops grew 9→11 because two probes found the vocabulary could not express what it needed to (an accept and a decline emitted identical ops; every `inputs[].ref` resolved to nothing). Invariants **shrank** 11→7 for the opposite reason: across 40 proposals only 4–5 ever fired, and one of them was rejecting *correct* work. See `probes/`.
- **Three observed fields, three questions:** `status.state` = *where are we* · `status.outcome` = *what was decided* · `status.output` = *what did this node produce*. Conflating any two is how both probes' worst bugs happened.
- **`--why` is a required argument on every mutating verb.** No rationale, no commit. All 200 technologies surveyed either lose the *why* or keep it in a file decoupled from the version — that gap is the product.
- **No rollback, no `delete_node`, and `rollback` is not even reserved as an opcode.** YAWL kept it in the enum while its validator hard-rejected it, which just misled tool authors (see 04 — YAWL).
- **⚖ THE LAW: Kona contains no model.** Not one call, anywhere in the binary. Every verb is a pure function of `mutations.jsonl` + the clock + the mailbox cursor. Judgment lives entirely in the Claude Code plugin. **Kona is Beads with state machines; the plugin is what Beads never had.**
- **Only the orchestrator mutates topology.** Subagents `set_status` and write their own node's output. That one rule removes most of the need for locking (§6.7).
- **Mid-run mutation is fully automatic — no approval gates on topology, ever.** One pre-execution approval scopes the whole pursuit; a declared effect budget is the circuit breaker. Gate on irreversible *effects*, never on *mutations* (§6.9).
- **Stack:** TypeScript on Bun (CLI + viewer, one toolchain) · React + Vite + `@xyflow/react` + dagre, fully controlled, read-only · JSONL + JSON on disk. No database, no daemon, no CRDT, no server.
- **Mailboxes: DECIDED — one plus-addressed Gmail, $0** (§6.11). The correlation token lives in Kona's own `Reply-To` (`ilya+kona-<node_id>@…`), so the fan-out needs 30 *tags on one inbox*, not 30 inboxes. Mailpit is the offline fallback behind the same port.
- **The `withParam` objection is answered** (§7.2's four-assertion *divergent arms* test + PRD §9's script): thirty identical arms would read as parameterised fan-out, so the run must end with structure no template described. **Resolved — see §11.**

---

## 0.5. The simplification pass — what was deleted, and why it was safe

Applied 2026-08-21, after the spec was complete and reviewed. Running Musk's algorithm in order, and the first step is the one that mattered.

**Step 1 — the requirements were dumb, and they were mine.** Every requirement traces to a named source, and when you check the names a pattern falls out: `fan_out` came from Conductor's `FORK_JOIN_DYNAMIC` and Neo4j's hot-node contention; leases from Hearsay-II blackboards; nine invariants from ADEPT2 and Petri-net soundness; `graph.json` from Datomic and event-sourcing snapshot practice; group-collapse from ComfyUI at 100+ nodes. **All of it is production-scale requirement imported into a fourteen-hour prototype for one pursuit.** The research library is 200 systems that survived contact with scale, and this spec generalised from all of them without asking whether Kona has their problem. It does not: one graph, one writer, one machine, one day.

**The dumbest requirement was "thirty counterparties."** It buys nothing. The claim is *divergence*, not volume — three arms that end structurally different prove more than thirty identical ones. And it is a wash visually, because R2 forces you to collapse thirty arms into one container, and a container of thirty looks exactly like a container of six. Changing one number upstream deleted a three-hour "never cut" ticket.

**Step 2 — delete.**

| Deleted | From → to | Cascade |
|---|---|---|
| 5 mutation ops (§6.4) | 11 → **6** | the whole auto-wiring table, the largest ambiguity in the contract |
| 5 invariants (§6.7.1) | 9 → **4** + a parser | two were *shape*, not graph properties; one never fired in 40 proposals; one's cause was the auto-wiring just deleted |
| `graph.json` (§6.1) | snapshot + log → **one file** | materialization, atomic rename, head-mismatch detection, rebuild-on-mismatch |
| Leases + eligibility queue (§6.7.3) | many agents → **one writer** | the concurrency epic's hardest half |
| 6 of 9 `brief` blocks (§6.8.1) | 9 → **subgraph + 3** | the six were derivable from the graph once `record_output` existed |
| 30 counterparties → **6** (§6.11) | | group collapse, the persona generator, most layout risk |

**≈105 h → ≈48 h. Critical path 6.1 h → ≈3.5 h.**

**Step 3 — what is left, in one sentence.** *An append-only log of typed ops, each carrying a rationale, folded into a graph on read, with four checks and an outbox.*

**The 10% to add back** — Musk's rule is that if nothing comes back you did not cut deep enough. Expected returns, in order: `fan_out` as pure sugar once someone hand-writes the batch and hates it · the cycle check (5 lines, the first time an LLM writes one) · leases, the moment a second executor is real.

**What was not touched, because it is the claim rather than the scale.** The mutation log with mandatory rationale · `record_outcome` + `record_output` (without them an accept and a decline emit identical ops, and every `inputs[].ref` dangles — both empirically demonstrated) · the outbox and payload-independent `effect_key` · branch resolution · invariant 4, evidenced recipients · crash-resume · the rationale timeline panel.

**The honest summary: the 80% retained is the entire claim. What was deleted is robustness at a scale this build will not reach.**

## 0.6. Simplification, pass two — deleting the taxonomy

§0.5 deleted things imported from other people's systems. This pass went after things the spec still believed in, decision by decision. The finding is different in kind: **pass one removed machinery, pass two removed vocabulary.**

| Decision | Before | After | The argument |
|---|---|---|---|
| Node types | 6 | **3** | `gate` is a `wait` whose event is a human — the spec said so in its own prose. `join` is a property of in-degree, not a kind of thing. `group` existed for a collapse feature §0.5 deleted |
| Node statuses | 10 | **5** | `blocked`/`ready` were **derived values being stored** — §6.7.4 calls the frontier "computed, never stored" two sections from an enum containing both. `running`/`waiting` merged: the node's type says which. `stale` never fired. `superseded` merged into `dropped` — the rationale already says which |
| Edge kinds | 8 | **3** | `conditional-blocks` is `blocks` + a field. `waits-for` is a second name for a quorum's blocking in-edges. `discovered-from`/`caused-by` are narration the mutation log already carries — **and the review found both inverted in 3 of 4 briefs**, so the redundancy was costing accuracy |
| Mutation record | 15 fields | **9** | Six existed for concurrent writers or an adversary: `parents[]`, `hash`, `client_id`, two cornerstone-diff refs, `migration`/`conflict` |
| Files | 6 | **3** | `blobs/` is a read-budget optimisation for a budget six personas do not have. `plan/` and `schema.json` were already homeless |
| Packages | 7 | **6** | `store` and `effects` are both I/O over one file, and merging them breaks none of the rules the boundaries enforce |

**~72 h → ~45 h.** Ops stayed at six — §0.5 already took those.

**The tension worth recording, because it is a genuine trade rather than a win.** The probes were unambiguous that a *closed, named vocabulary* is what makes LLM output reliable. `gate` is a better word than `wait{match:{kind:"human"}}` is a concept. So this pass resolves it by separating the two: **the store knows three types; the authoring prompt may still say six words.** Deleting the types is a code simplification. Deleting the words would be a reliability regression.

**The 10% expected back:** `client_id` the first time a retry double-appends · `blobs/` at ~100 messages · `gate` as a real type if the model starts mis-typing waits · `parents[]` the day there are two writers.

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
| **O4** **Append-only JSONL, folded on read** | `mutations.jsonl` is truth; `flock` + CAS. *(Chosen with a derived snapshot; §0.5 later deleted the snapshot too)* | ✅ **CHOSEN** — see below |
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
  mutations.jsonl   # THE FILE. append-only, fsync'd. Never compacted, never GC'd.
  events.jsonl      # inbound world events (replies, deadline fires, bounces). append-only.
  lock              # flock target; exists only while a mutation is in flight
```

**Three deleted in pass two (§0.6):** `blobs/` — pointers-not-payloads exists for a read budget six personas do not have (~6 KB of scripted replies total; inline them, add the indirection back at ~100 messages). `plan/` — went with the frozen-artifact ticket §0.5 already cut. `schema.json` — ships inside the binary; it does not need to be on disk.

**Write order is the whole durability story:**
`append the mutation → fsync → then take the side effect.`
That is Braintrust's WAL-then-compact in miniature and Memgraph's snapshot+WAL recipe, and it makes Langfuse's flush-loss failure mode impossible. **Persist the mutation, then act; never act then log.** (see 08 — Braintrust, Langfuse, Helicone; 09 — Memgraph)

| Rule | Why | Source |
|---|---|---|
| **Never compact or GC the log** | After `bd compact --days 7`, **42 of 43** sampled version addresses vanished, invalidating every published reference. Kona's history *is* the product. | 01 |
| **There is one file.** Reads fold the log; there is no snapshot to keep coherent | A materialized head is a cache for graphs too large to fold per read. At ~40 mutations folding is microseconds, so the cache bought nothing and cost atomic-rename, head-mismatch detection and rebuild-on-mismatch. Deleted in §0.5 |
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
  "id": "goalie-dana",              // stable, human-meaningful, minted at creation.
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
      "effect_key": "ek_9f2a…"      // = hash(node_id, created_by_version). PAYLOAD-INDEPENDENT by design;
                                    //   payload_ref / payload_hash are written at RESERVE, not at authoring
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

| type | What it is | Required beyond `id`, `type`, `label` |
|---|---|---|
| `task` | does one thing. A compensation is a `task` with `compensates: <node_id>` | `instruction`, `effect_class`, `outputs`, `effect` (if pivot/compensatable) |
| `wait` | blocks on something. **A human decision is `match:{kind:"human"}`** — the four decision kinds are `outcome.verdict` values | `match`, `deadline`, `on_timeout` |
| `quorum` | predicate over its blocking in-edges | `predicate`, `on_unsatisfied` |

**Three deleted in pass two (§0.6), each because it was not a *kind of thing*:**

| Deleted | Was | Now |
|---|---|---|
| `gate` | needs a human | `wait` with `match:{kind:"human"}`. The spec already said *"a gate is a wait whose event is a human"* — if that sentence is true, it was never a type |
| `join` | merge point over in-edges | **A property of in-degree.** Any node with >1 blocking in-edge is a join; `merge: all\|any` moves onto that node |
| `group` | fan-out container | Edges plus a `group` label on the children. It existed so the viewer could collapse, and §0.5 deleted collapse |

> **⚠ Types are for the store; vocabulary is for the model — they need not be the same list.** The probes were unambiguous that a *closed, named vocabulary* is what makes LLM output reliable (AFlow's `operator.json`, Self-Discover's seed modules, FlowMind's vetted API set). So the authoring prompt may still say "gate" and "join" as **words**, while the store knows three types. Deleting the types is a code simplification; deleting the words would be a reliability regression, and they are different decisions.

**Edges — three kinds.** `blocks` (with an optional `condition`), `supersedes`, `compensates`.

**Five deleted in pass two (§0.6):**

| Deleted | Why |
|---|---|
| `conditional-blocks` | It was `blocks` carrying a `condition` field. Two kinds for one concept |
| `waits-for` | A quorum's population **is** its blocking in-edges. A second name for the same edge |
| `parent-child` | With `group` gone, membership is a `group` label on the child |
| `discovered-from`, `caused-by` | Pure provenance, and the mutation log already records `trigger` and `ops`. Two ways to say the same thing — and the review found both **inverted in 3 of 4 briefs**, so the second way was actively costing accuracy |

`supersedes` and `compensates` survive because you have to *find* them; the rest was narration the log already carries.

**⚠ The two edge lanes use OPPOSITE direction conventions, and this must be stated as loudly as the blocking one.**

| Lane | `{from: A, to: B}` means | Read it as |
|---|---|---|
| **blocking** | **B requires A** | "B needs A" |
| **annotating** | **A is about B** (subject → object) | "A supersedes / compensates B" |

The authoring probe mitigated the blocking-edge footgun successfully (7/8 correct) and then found it had simply **migrated one edge-kind over: annotating edges were inverted in 3 of 4 briefs** — which is why §0.6 deleted the two purely narrative ones and kept only the two you have to *find*. One inverted `caused-by` gave `cancel_booking` blocking in-degree 0 — making "cancel the booking" a **second root `kona next` could dispatch before anything was ever booked.** Hence lint rule 8 (§6.8.1).

**A `blocks` edge may carry a `condition`**, and a set of branches leaving one node carries a mutual-exclusivity declaration. Five branch points per authored graph were otherwise unnameable — at exactly the irreversible choices.

**Status — a small enum plus an open `conditions[]` list.** Kubernetes deprecated its `phase` enum in writing precisely because *"adding new enum values breaks backward compatibility"* (see 06).

`active | sending | done | failed | dropped`

**Five deleted in pass two (§0.6):**

| Deleted | Why |
|---|---|
| `blocked`, `ready` | **Derived, never stored.** §6.7.4 says the frontier is "computed, never stored" two sections from an enum that contained both. A stored derived value is how you get the bug where the two disagree |
| `running`, `waiting` | Merged into **`active`** — the node's *type* already says which kind of in-progress it is |
| `stale` | Never fired in any probe. Add it back when it bites |
| `superseded` | Merged into **`dropped`**: both mean "no longer live, not an error", and the mutation record already says which. The distinction was redundant with the rationale |

**Terminal = `done | failed | dropped`.** Non-terminal: `active | sending`. **`sending` is non-terminal** so `record_output` is not caught by the no-mutation-of-terminal rule — it is the state meaning *the real world's answer is unknown*, not a resolution.

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
  "schema_version": 1,

  "observed_at": "…",            // when Kona learned      } bi-temporal, ENGINE-stamped, never LLM-stamped
  "occurred_at": "…",            // when it actually happened }   deadlines use the second, log order the first

  "actor": { "kind": "orchestrator|subagent|human", "id": "exec-3" },   // the AGENT, not the process

  "trigger": { "relation": "Trigger|Invalidate|Derive|Approve|Timeout", "event_ref": "evt_118" },

  "ops": [ … ],                  // the closed six, applied atomically in array order

  "rationale": {
    "why": "<=2 sentences",                                  // CAPPED
    "expected_effect": "quorum(goalie) satisfiable by Fri",
    "alternatives_rejected": ["cancel the game", "play without a goalie"],
    "reason_code": "COUNTERPARTY_DECLINED | DEADLINE_PASSED | NEW_CONSTRAINT | MISSING_STEP | QUORUM_MET | CONTRADICTION | WITHDRAWN | OTHER"
  },

  "outcome": null                // WRITTEN LATER, ON EVIDENCE
}
```

**Six fields deleted in pass two (§0.6) — every one existed for more than one writer, or for an adversary:**

| Deleted | Was for |
|---|---|
| `parents[]` | I justified it as *"the only thing that lets two concurrent mutations be reconciled later."* There is one writer |
| `hash` (Merkle chain) | Tamper-evidence on your own local file |
| `client_id` | Idempotency for a replayed mutation — but append is atomic and CAS guards the version |
| `context_snapshot_ref`, `prior_context_ref` | YAWL's cornerstone diff. Elegant, and used by exactly zero probe proposals |
| `migration`, `conflict` | Never set, never read |

Four calls that are not obvious, each argued:

1. **`outcome` starts `null` and is filled by a later real-world event.** AFlow computes `succeed = after > before` against a benchmark; Kona has no benchmark, no counterfactual, and N=1 — you cannot re-run "email 12 hockey parents" five times and take the mean. Write the rationale synchronously, leave the outcome null, let a WAIT resolution fill it in. *Rationale without outcome is a changelog; rationale with outcome is training data.* (05 — AFlow, ADAS)
2. **A rationale is never edited.** Append a new version referencing the old. A-MEM's evolution loop rewrites old notes in place and destroys the record of what the agent believed at the time. (07; 04 — RDR)
3. **Suppression rule — version mutations, not snapshots.** If a re-plan produces a fragment semantically equal to the existing one, do **not** write a version: hash each node's semantic content and make `mutate` a no-op-with-revalidation on an unchanged hash. The counter-case is Airflow #54337 — naive version-on-every-structural-change produced **hundreds of DAG versions per day**. Without this the log fills with "the agent thought about it again" and the procedural-memory claim is worthless. (14 — Salsa's backdating; 03 — Airflow)
4. **`why` is capped.** Reflexion's sliding window and ExpeL's own token-limit caveat are the warning. (07, 05)

**Pre-concede loudly:** ADEPT2's change logs already carried *"change reason and change performer"*; ProCycle already retrieved similar past changes for reuse; Mailgun ships a `description` field beside a production routing rule. Versioned-mutation-with-rationale is **not novel in kind**. What is new: in ProCycle a human typed the reason into a dialog and a human decided whether to reuse it; in Kona the LLM emits it as a side effect of deciding and a fresh-context subagent consumes it as its only briefing. (04, 13)

### 6.4. The mutation op set — six ops, id-addressed, batched into one commit

```
add_node(scope, spec)                                        -> $id
add_edge(from, to, kind, {condition?})                       -> $edge_id
set_status(node, status, evidence_ref)
record_outcome(node, verdict, evidence_ref, attrs?)          confirmed|declined|tentative|timed_out|bounced
record_output(node, output_name, value_or_ref, evidence_ref) satisfies a declared `outputs` entry
supersede_node(node, by?)                                    (never delete)
```

**Five ops were deleted in the simplification pass (§0.5). The reasoning is identical for all five: the atomic unit is the commit, not the op.**

| Deleted | Was | Why it was safe |
|---|---|---|
| `fan_out` | atomic group + join + N children | `add_node` × N + `add_edge` × N **in one batch**, which is already all-or-nothing. It guaranteed atomicity the commit boundary already provides, and dodged hot-node write contention that does not exist with one writer |
| `add_wait` | minted a wait and auto-wired it | `add_node(type:"wait")`. It existed only for auto-wiring convenience — which was itself the cause of *every* orphan in the v2 probe |
| `insert_compensation` | minted a compensation + edge | `add_node` + `add_edge`. Invariant 1 still requires it in the same batch |
| `reroute_edge` | retargeted an edge | It took an `edge_id` the graph view never exposed, so four probe scenarios fabricated ids. Supersede-and-rewire instead |
| `resolve_gate` | recorded a human decision | `set_status` on the gate + `record_outcome` for the decision |

Deleting them deletes the auto-wiring table with them — the single largest source of ambiguity in the contract.

**`record_output` is what makes `inputs[].ref` mean anything.** A node declares `outputs`; `record_output` fills one in; `kona brief` resolves a downstream node's `inputs[].ref` against it. Without this pair the reference-by-node-id design is decorative — proven, not theorised: 0/8 fresh subagents could execute, because every upstream ref resolved to nothing (`probes/authoring-briefing.md`). The store rejects a `record_output` whose `output_name` is not in that node's declared `outputs`.

**Fix 5 — `record_outcome` is the tenth op, and it closes the deepest hole the probe found.** All ten scenarios independently hit it: `roster_quorum` reads `count(confirmed)` and `count(role=goalie, confirmed)`, and **nothing in the 9-op vocabulary could write either field.** `set_status` moves a lifecycle enum; `evidence_ref` is free text. So an ACCEPT and a DECLINE emitted *identical ops* and the quorum predicate — the thing the whole pursuit turns on — was unevaluable. A 10-op closed schema is still closed. `verdict` is typed and closed; `attrs` carries predicate-visible facts (`{role: "goalie"}`) and nothing else.

**Node id minting, and one character that would have aliased two nodes into one mailbox.** Ids are stable and human-meaningful, and callers may not supply them (Fix 3) — so the store mints them: `fan_out` produces `<group_slug>-<key>`; `add_node` produces `<scope_slug>-<label_slug>`, suffixed `-2`, `-3` on collision. **The separator is `-`, never `/`.** §6.2's original example was `goalie/dana`, and `correlation` derives from the node id — so `goalie/dana` and `goalie-dana` would both normalise into `kona+goalie-dana@…` and two nodes would share one reply address, silently satisfying the wrong wait. Ids match `[a-z0-9][a-z0-9-]*` and nothing else.

**The edge record, and why `add_edge` needs a `condition`.** The edge was the least-specified object here: no record shape existed anywhere, so `fold()` — the second-priority test suite — had no target to build. Worse, **Fix 8 makes `condition` mandatory on every out-edge of a `gate`/`wait` and `add_edge` had no parameter for it — so the closed op set literally could not author a legal gate out-edge**, which is the mechanism that stops an irreversible send firing with no approval.

```jsonc
{ "id": "e_7f2a", "from": "shortfall_gate", "to": "recruit_goalie",
  "kind": "blocks",
  "condition": { "on": "accept" },   // closed: accept|edit|respond|ignore|timeout|bounced|satisfied
  "created_by_version": 42 }         //   = gate.decision_kinds union wait.resolution
```

No `lane` field — derivable from `kind`. Graph envelope: `{schema_version, v, nodes[], edges[]}`.

**The store fires the out-edge whose `condition.on` matches the terminal resolution, and marks every other out-edge's target `dropped`** (Fix 7). That sentence wires Fix 8 to Fix 7 and makes both implementable.

**Enforced by invariant 1, not by lint.** `kona lint` is an author-time read verb and the cut-order deletes it — so `add_node($0,{type:'gate'})` + `add_edge($0, send_offer, 'blocks')` would commit with all seven invariants green, the gate would time out, `blocks` would clear, and the pivot would send unapproved. That is the v2 probe's worst-safety class re-entering through the very path the store is meant to guard.

**`fan_out`'s expansion rule** — *removed by §0.5 along with the op. A fan-out is now `add_node` × N + `add_edge` × N in one batch, and the caller writes the child specs directly, so there is no template to expand and nothing to substitute.*

**Fix 3 — intra-batch symbolic references.** Ops return ids, but a batch is static JSON, so a batch cannot name what it just created. Nine of ten scenarios fabricated ids to work around this. Ops therefore return **`$0`, `$1`, … positionally**, referencing the op's index in this batch; `fan_out` returns a structured handle (`$2.children.dana`). The store resolves symbols at commit and rejects any unresolved or forward reference. Caller-supplied ids are **not** accepted — that was the other workaround and it risks colliding with a live node and writing to the wrong one.

**Fix 2 — the auto-wiring table** — *removed by §0.5.* Every op that auto-wired edges (`fan_out`, `add_wait`, `insert_compensation`) is gone, so **no op creates an edge you did not write.** `add_node` and `add_edge` do exactly what they say. This deletes the largest single ambiguity in the contract and, with it, every orphan the v2 probe produced.

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
| ~~Every op carries a `client_id`~~ | **Deleted in §0.6** — append is atomic and CAS guards the version, so a replay cannot double-append. First thing back if a retry loop ever does. (13, 03) |
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
  "resolution": null    // satisfied | timeout | bounced | dropped
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

**The quorum predicate — one closed form, because invariant 2 is otherwise uncodeable.** "Quorum stays satisfiable" is one of the four enforced checks and the one §7.2's premise-break beat turns on, and the spec never showed what a predicate contains. §6.8 also says "no query language" while five expression strings were floating around. One form, for `quorum.predicate` only:

```jsonc
{ "count": { "verdict": "confirmed", "attrs": { "role": "goalie" } }, "op": ">=", "n": 1 }
```

Evaluated **only** over the population (the quorum's **blocking in-edges** — §0.6 deleted `waits-for` as a second name for exactly that set), reading **only** `status.outcome.verdict` and `status.outcome.attrs`; attrs matched as subset-equality on literals; no other names resolve; unknown keys rejected. Invariant 2 then codes in one line:

> satisfiable iff `matching_confirmed + still_live_population >= n`

The other four expression strings collapse with it: **`obviated_if` becomes a reference**, `{"quorum": "<node_id>", "satisfied": true}`, which deletes the undefined bare token (`"quorum:goalie >= 1"` — what did `goalie` resolve to?) without a second evaluator. **`if_part` is deleted** — optional, unused, CMMN residue. **Deadline `expr` is restricted** to `<inputs[].ref> ± <duration>` resolving through `record_output` and falling back to `backstop`, which makes lint rule 4's "parses, is future, chain monotone" finite. And from the v2 probe: **`record_outcome` overwrites** a node's outcome, and the quorum count is **recomputed from the population on every read, never stored** — so two agents cannot both increment it.

**Three states the contract had no vocabulary for — and the retry loop never converged on any of them.** v3's convergence was bimodal: **82% on seven scenarios, 10% on three.** The three were late-reply-after-timeout, ambiguous reply, and quorum-met-with-waits-still-armed. More attempts do not help, because these are vocabulary gaps rather than legality errors. Each gets a rule:

| State | Rule |
|---|---|
| **A reply arrives after its wait already resolved** (timeout fired, follow-up sent) | The event is recorded on the terminal wait via `record_outcome(verdict: "late")` — legal under invariant 1, which whitelists `record_outcome` on a terminal node. It **never reopens the closed wait.** It **never reopens the closed wait.** It may trigger a *new* node; it may not resurrect an old one |
| **A reply that is neither yes nor no** ("maybe, let me check") | `record_outcome(verdict: tentative)` writes the fact but **does not resolve the wait.** The wait stays armed on its original deadline. `tentative` never counts toward a quorum's `confirmed` |
| **A quorum becomes satisfied while N waits are still armed** | **The store obviates them** — same mechanism as branch resolution (Fix 7): every still-armed wait in a satisfied quorum's population is marked `dropped` with a system rationale, transitively per the drop rule. **No set-selector op is needed**, and no agent has to remember. In v3 this was left to the mutator, which named three of nine and left six pivot-class sends live — validly |

The pattern is the same one Fix 7 established and it is worth stating as a principle: **when the housekeeping is derivable, the store does it.** Every time the contract asked the model to tidy up, the model either forgot, did it partially, or was rejected for doing it.

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
| **`effect_key = hash(node_id, created_by_version)`**, minted at node creation and **deliberately payload-independent** | ⚠ The formula was `hash(node_id, recipient, resolved_body, v)` until 2026-08-21, and it **inverted its own guarantee**. Neither input exists at creation — §6.2 requires the recipient be a `ref` ("never a literal address") and the body resolves from `record_output` at dispatch. Worse: with the body inside the key, a *rewritten* body yields a *different* key, so the parameter-comparison rule below was unreachable by construction, dedup passed, and the second email sent. That is the D3 double-send, caused by the guard against it |
| **`payload_hash = hash(resolved_recipient, resolved_body)`**, computed at **reserve** and stored beside the key | Bazel's law applies to the *comparison*, not the key: **the key names the slot; the payload hash proves the bytes are the ones that were approved.** `kona effect reserve` refuses any reserve on a node that already holds a reservation or a non-empty `effect_log` |
| Store the **result**, not a flag — `{message_id, sent_at, provider, sandbox_or_real, outcome}` | Downstream waits must match replies against **which** send they correspond to, after fan-out produced several near-identical emails. (11 — Stripe) |
| **Parameter-comparison rule:** key matches but body differs ⇒ **loud error in the viewer** | Never a silent no-op and never a second email. A genuine Kona-specific hazard precisely because the mutator rewrites node payloads. (11 — Stripe) |
| A node with a non-empty `effect_log` is **never re-executed** — the CLI refuses | Structural, not a convention. XState's corollary: `invoke`s *do* restart, so classify effects and only auto-restart `pure`/`reversible`. (11, 06) |
| `attempted_at` ≠ `completed_at`; attempted-without-completion = **needs human adjudication**, not retry | Make's mtime footgun maps exactly onto "the node has an output, so it's done." (06, 14) |
| Multi-step compensation persists a **step cursor after each step** | Or resume replays an already-sent email. (04 — YAWL's `ExletRunner._actionIndex`) |
| The **`effect_log` `outcome` field** — *not* `status.state` — distinguishes `queued → sent → delivered → bounced` | `sent` is not `delivered` and the graph must say which. These are effect outcomes; the node's own `status.state` stays inside the closed enum, or invariant 1 would reject the CLI's own effect path. (13) |
| **Restart budget:** `max_reattempts` within `window`; on exhaustion escalate to a gate, never loop | Without a budget an LLM mutator retries forever and burns a mailbox. (12 — Erlang/OTP) |

Every action node is typed by reversibility — `pure | reversible | compensatable | pivot` — and the invariant follows: **compensatable nodes require a declared compensation** (invariant 1, enforced). **Pivot nodes require an upstream gate — and "upstream" is satisfied by the root plan approval**, which is what §6.9 means by "approve once, not thirty times". So this is a *property of the approved plan*, checked by `kona lint` at author time, **not** a per-commit invariant; the per-commit guard on pivots is invariant 3 (budget) plus invariant 4 (evidenced recipient). Stated plainly because asserting it as enforced when nothing enforces it is worse than not claiming it. That turns "Kona has no rollback" from an apology into an enforced schema invariant. (see 11 — Revisable by Design; 09 — Sagas)

### 6.7. Invariants and concurrency

#### 6.7.1. Enforce — four checks, and a parser

Real verification is off the table — soundness of workflow nets is EXPSPACE-complete, and undecidable for reset nets. So the store ships a cheap linear-time floor. The simplification pass (§0.5) cut it from nine checks to four, on the grounds that **five of the nine were not invariants at all**.

**Not invariants — the parser does these, free.** Schema validity (every node has a legal type and its required fields; every edge a legal kind and a `condition` on gate/wait out-edges) and *every wait/gate has a deadline and an `on_timeout`* are **shape**, not graph properties. A zod schema at the CLI boundary rejects both before any graph logic runs. They were invariants 1 and 4; they are now a parse step, and nothing is lost.

**Deleted outright, with the reason:**

| Was | Deleted because |
|---|---|
| no cycles among `blocks` | **Never fired in 40 probe proposals.** Five lines to add back the first time it bites |
| reachability both ways | Every one of its six firings was an orphan caused by auto-wiring ambiguity — and §6.4 just deleted the auto-wiring |
| rationale fidelity | Fired 37× in v3, but it costs real implementation to derive `expected_effect` from ops, and it protects a human reading prose *at a scale this build no longer has*. With six arms and one gate, the human reads the actual diff |

**ENFORCE — rejects the commit, names the offending node.**

| # | Invariant | Why it survives |
|---|---|---|
| 1 | **Terminal & effect protection.** An **op-delta predicate**, per-op against pre-commit head state: for a node terminal at commit time, no op may add or reroute a *blocking* edge into it, or target it at all except `supersede_node`/`record_outcome`/`record_output`. No supersede of a node with a non-empty `effect_log` unless the same batch carries its compensation. Existing blocking edges into terminal nodes are untouched | This **is** the no-rollback guarantee. Written as a post-state predicate it rejected every commit once any node reached `done` |
| 2 | **Quorum stays satisfiable** — population is its set of **blocking in-edges** | The only check that ever caught a genuine *reasoning* error rather than a shape slip |
| 3 | **Effect budget** — cumulative irreversible sends ≤ the budget in the approved plan | §6.9 removed every human gate on topology and named this as the replacement. Without it, automatic mutation has no backstop |
| 4 | **Recipients must be evidenced** — no op may create or retarget an irreversible effect whose `recipient_ref` does not resolve to an entity already in the graph carrying an `evidence_ref`. A recipient that exists only in the proposing batch is rejected | The v3 probe's headline failure: unable to satisfy a quorum, the mutator **invented counterparties and queued email to them** while everything else passed — because the old suite *rewarded* it |

Plus the write protocol, which is not a graph property: **`parent_v` must equal head, else exit 3 → re-read → re-decide, never blind-merge.**

**Terminal = `done | failed | dropped`.** Non-terminal: `active | sending`. `sending` is non-terminal so `record_output` is not caught by rule 1.

**Scope constraint, retained.** A batch may not touch a node currently `waiting` with an outstanding real-world commitment outside its declared change region. And the line for the 1995 dynamic change bug: *"we don't migrate state, we recompute it."* Kona has no tokens.

#### 6.7.2. Log, don't block

Write a `conflict` annotation with a reason and surface it in the viewer for: a mutation touching a region containing `done`/`sending` nodes; whether a rationale is *good*; whether a fan-out was *warranted*; conformance drift between the approved graph and what ran (render as a ribbon — **observability, never a runtime gate**, because a checker that "fails" a divergent run has nothing to do under no-rollback).

**Do not implement ADEPT2's compliance gating** — it exists to protect a reversible transactional world, still strands instances as "progressed too far", and needed a whole follow-up paper of Adjustment Strategies. **Do** steal Strategy 2: when a new step should have gone before something already done, insert it at the first still-reachable successor position and log the displacement. **Explicitly refuse Strategy 3** (trace rewriting) — Kona's event log is append-only and never edited. (see 04)

#### 6.7.3. Concurrency — four rules, in order of how much they buy

1. **Role-scoped write authority.** Only the orchestrator mutates topology; subagents only `set_status` and write their own node's output. *This single rule removes most of the need for locking.* Steal ReWOO's Planner/Worker/Solver split and Akka's one-active-writer-per-entity guarantee. (05, 12)
2. ~~**Atomic claim with a TTL lease.**~~ **Deleted by §0.5 — one writer, nothing to claim.** Was: `kona next --agent X --lease 30m` via `O_EXCL`/atomic rename, exactly one winner. Linda proves this is sufficient, and it is the only mechanism preventing two subagents emailing the same goalie. Expose the *eligible set* through the CLI rather than letting a subagent pick — the blackboard KS-activation-record pattern. (12)
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
| `kona validate <plan>` | read | dry-run the 4 enforced invariants; the LLM must pass this before proposing |
| `kona lint` | read | post-authoring checks: inverted edge direction, sequence-implied-by-numbering, unreachable nodes |
| `kona graph --json [--version N]` | read | **the one supported read contract.** Powers the viewer and the scrubber |
| `kona status [--json]` | read | head version, counts by state, ready nodes, armed waits + time remaining, open gates, `sending` unknowns |
| `kona next` | read | the ready frontier — nodes whose every blocking in-edge is terminal-success. **Computed, never stored.** No leases (§0.5); with one writer there is nothing to claim |
| `kona brief <node>` | read | **the fresh subagent's entire world: its subgraph + identity, correlation, preconditions — see §6.8.1.** Refuses rather than returning a partial brief |
| `kona why <node>` | read | the rationale chain for one node |
| `kona set-status <node> --state … --why "…"` | mutate | executor status transition + conditions |
| `kona effect reserve\|record` | effect | the §6.6 outbox sequence |
| `kona event add --kind … --evidence <ref>` | ingest | append to `events.jsonl`; **also the demo's injection path and the live-failure fallback** |
| `kona resume` | reconcile | the §6.7.4 reconcile-then-repair |
| `kona history [--node <id>]` | read | the rationale timeline — feeds the viewer's second panel and the agent's self-query |
| `kona view [--port]` | viewer | start the localhost viewer. **User-run, never plugin-spawned** (§6.10) |

#### 6.8.1. `kona brief` — the subgraph plus three · `kona lint` — eleven rules

**`kona brief <node>` returns the node's subgraph plus three things the graph cannot know, or it refuses.**

The v1 probe found 0/8 fresh subagents could execute; the v2 fix added nine required blocks and got 10/10. **The simplification pass observes that six of those nine were derivable all along** — once `outputs` is declared and `record_output` fills it, `resolved_inputs`, `node_status`, `gate_decisions`, `recipient`, `time` and `effect_ledger` are all just a walk over the folded graph. They were blocks because the graph could not answer them, and now it can.

**Three genuinely are not in the graph:**

| Block | Contents | Why the graph cannot know it |
|---|---|---|
| `identity` | sending mailbox, display name, signature, **and an authority statement** ("you may commit up to £X" / "you may not commit funds") | Missing in 4/4 v1 briefs; in three the only identity available was a personal Gmail, wrong for a bid desk |
| `correlation` | the **fully-expanded literal** reply-to address and subject tag | One trial emitted `kona+offsite-booking@<kona-inbox>` verbatim — a perfect send that could never correlate |
| `preconditions_satisfied` | computed by the CLI, **fails CLOSED**: every declared input resolved · every upstream gate returned · budget remaining · this node's `effect_key` reserved-and-unfired | 7/8 v1 HIGH-risk cases were "send exactly what was approved at `<gate>`" where the gate had not returned. In v2 this block failed **open** |

Plus `disclosable` — a per-field marking of what may appear in outbound content. The v2 probe's one repeated behavioural defect (2/2) was the agent reading a wait's internal timeout and turning it into an outbound promise nobody authorised.

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

**Exit status is small; the reason is in the message.** `0` ok · `1` refused · `3` stale base version · `4` invariant violation. *(`5` node-leased was removed with leases in §0.5 — with one writer there is nothing to lease.)*

⚠ **`409`/`422`/`423` cannot be exit statuses** — they are 8-bit, so Bun/Node truncate: `process.exit(409)` yields `$?` = 153. The concurrency contract is consumed by an LLM orchestrator and by subagents shelling out to `kona`, and every one of them would branch on a code that never appears. Where §6.7.3 and §7 say "409", they mean the **symbolic** code below, not `$?`.

**Every non-zero exit writes one line to stderr beginning with a symbolic reason code:** `STALE_BASE_VERSION` (+ current head) · `INVARIANT_VIOLATION` (+ invariant number and node id) · `REFUSED` (+ reason). The mandated refusals that otherwise have no code — network-FS refusal, partial-brief refusal, uninstantiated-template refusal, budget exhaustion, the `sending`-crash human ask, scope-constraint refusal, payload-mismatch — all land under `1` + `REFUSED` + reason. Said here because four windows will otherwise each invent a shape. No JSON error envelope: `--json` is deliberately scoped to reads.

**Hardcode the five queries the viewer needs** — ready nodes, blocked-on-wait, waits past deadline, recent mutations, rationale chain. **No query language.** (see 09 — Neo4j)

### 6.8.2. ⚖ The determinism law — Kona contains no model

**The `kona` binary never calls a language model. Not once, not anywhere, not as a fallback.** Every verb is a pure function of three inputs: `mutations.jsonl`, the wall clock, and the mailbox cursor. Given the same three it returns the same answer, forever.

| Question | Who answers it | How |
|---|---|---|
| What is ready? | **kona** | every blocking in-edge terminal-success. A graph walk |
| Did a reply arrive for this wait? | **kona** | plus-tag match, then `In-Reply-To`. String comparison |
| Has this deadline passed? | **kona** | clock comparison |
| Is this quorum still satisfiable? | **kona** | `matching + still_live >= n`. Arithmetic |
| Which branches did the resolution not take? | **kona** | the untaken `condition` arms. Set difference |
| Is this batch legal? | **kona** | the four invariants |
| **Did Dana say yes or no?** | **the plugin** | a model reads the mail and calls `record_outcome` |
| **What should the plan become now?** | **the plugin** | a model emits ops; `kona mutate` stores them |
| **What does this node's work actually involve?** | **the plugin** | an executor subagent |

**Why it is a law and not a preference — four consequences that all follow from it:**

1. **The store is testable to 100%.** §7's mutation-score target on `validate()` and `fold()` is only affordable because there is nothing stochastic to mock. A single model call anywhere in the binary would make every one of those tests a flake.
2. **Crash-resume is decidable.** `kona resume` produces one answer, not a plausible one. If it needed judgment it could resume differently twice from the same file, and property (f) would be a claim rather than a guarantee.
3. **Cost is bounded by events, not by turns.** The pursuit costs one model call per *decision*, not per loop iteration.
4. **It is the honest positioning.** Beads is a deterministic CLI that agents drive; its state is an issue graph. Kona is a deterministic CLI that agents drive; its state is an **execution** graph with waits, effects and irreversibility — **plus the plugin Beads never had.** That sentence is the whole product, and the law is what makes the first half true.

**The corollary for the loop.** The plugin owns the loop, because only a Claude Code session can spawn subagents. But the loop carries no bookkeeping: it asks `kona next` what is runnable and `kona events --since <v>` what changed, dispatches verbatim, and calls a model **only** when an event needs a decision. Today's design has the orchestrator reasoning about its own progress on every turn — roughly six model turns per cycle, of which one is a decision. That contradicts the product's own thesis: **Kona exists so a model need not hold pursuit state in its context, and an LLM orchestrator holds loop state in its context.**

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
| `/kona:run` | **The loop, carrying no bookkeeping.** `kona next` → dispatch verbatim → `kona events --since <v>` → **call a model only when an event needs a decision** → `kona mutate`. Repeat. ~1 model call per cycle, not ~6 (§6.8.2) |

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
| **DECIDED 2026-08-21, then AMENDED by the v3 probe. Mid-run mutation is automatic — with exactly one gate, on exactly one thing.**

> **Automatic:** every topology mutation. Fan-out over a known roster, reroutes, follow-ups, obviation, supersede-with-compensation, re-plan after a premise break. No approval, no modal, no stall.
>
> **Gated:** a mutation that creates a *new irreversible effect targeting a recipient not already evidenced in the graph.* That is the whole gate.

**Why the amendment.** The original decision was "no approval gates on topology, ever." The v3 probe (n=60, `probes/q4-mutator-v3.md`) falsified it: **0 of 60 accepted commits were clean**, and the specific failure was that the mutator, unable to satisfy a quorum, **invented counterparties and queued irreversible email to them** — passing every invariant, because the cheapest way to make a quorum satisfiable was to add candidates and nothing required them to be real. Five harness security warnings fired on that run for exactly this.

The gate is narrow on purpose. It does not reintroduce the adaptive-BPM failure mode (change being expensive and blameful), because **changing the plan stays free** — 78% of proposals converge to structurally valid within three attempts. What now costs a human decision is *inventing a person to email*, which is the one thing the data says a model should not do unattended. Invariant 8 makes the same rule enforceable at commit time; the gate is what happens when the agent legitimately needs a new counterparty and can cite one.

**The sentence to keep:** the plan changes freely; the world does not; and nobody new enters the world without a human. Gate on irreversible *effects*, not on *mutations*: a mutation is versioned, rationale-carrying data in a file that the viewer shows the instant it lands, and it is never itself dangerous. Sending an email is. Those are already separate events (§6.6), so the gate belongs on the effect | Adaptive BPM died because change was **expensive and blameful**; putting a human back in the mutation path re-creates the exact failure Kona claims to have removed (04 — Reijers). It also breaks the demo's own claim: a pursuit cannot survive an overnight crash if a modal is waiting for a human at 2am. Terraform is the precedent — it does not ask you to approve plan *revisions*, only `apply` (06) |
| **Approval is scoped to the plan, not to the action.** The single pre-execution approval (property a) authorises the *class* of effects the plan declares — "will email up to 30 players from this roster" — exactly as `terraform plan` shows "will create 30 resources" and you approve once, not thirty times | 06 — Terraform |
| **A declared effect budget is the circuit breaker, and it replaces every gate we removed.** **Invariant 7** caps `max_fanout` and total irreversible sends against the budget declared in the approved plan. Exceeding it pauses the pursuit and asks. It fires approximately never — and it is the honest answer to "so it can just email anyone?" | 03 — Airflow's `max_map_length` |
| **`gate` nodes survive, but only when the *plan* declares a human decision** ("Ilya picks the final date"). Authored into the graph by the model at planning time, never injected by the system at mutation time | 01 — Linear's `elicitation` activity |

> **⚠ Read §6.6 and §6.9 together.** §6.9 leaves *mutations* — changing the plan — ungated. §6.6 governs *effects*: a `pivot` node requires an upstream gate, the effect budget bounds the rest, and invariant 4 refuses any effect aimed at an unevidenced recipient. An authoring trial reasoned through exactly this ambiguity, chose the §6.9 reading, and **shipped a graph with 12 irreversible sends and no upstream gate**; another dodged the rule by classifying an email send as `compensatable`. The sentence to hold on to: **the plan changes freely; the world does not.**

**What actually carries the safety, stated precisely** (§6.7.1) — because the honest version is narrower than "an invariant handles it":

| Guard | Where it lives | Strength |
|---|---|---|
| Superseding a node that already emailed someone requires a compensation in the same commit | **invariant 1**, enforced | hard |
| A quorum must remain satisfiable | **invariant 2**, enforced | hard |
| Cumulative irreversible sends ≤ the approved budget | **invariant 3**, enforced | hard — this is the circuit breaker that replaced the gates |
| A new precondition may not contradict an already-executed action | **report-only** (§6.7.2) | *soft — annotated in the viewer, does not block* |
| The executing node's preconditions actually hold | `kona brief`'s fail-closed `preconditions_satisfied` (§6.8.1) | hard, at execution rather than at commit |

So: **mid-run, the store enforces structure and the budget; it does not adjudicate whether a mutation is *wise*.** The mutation path's real floor is invariant 3 plus the brief's fail-closed check — not a general contradiction detector. Say it that way rather than claiming more. Net effect on the demo: one approval at the start, then it runs untouched — and the goalie re-plan becomes a moment you *watch* rather than a modal you dismiss.
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

### 6.12. Repository layout — a Bun workspace, one package per boundary

```
kona/
  package.json            # workspaces: ["packages/*"], bun
  packages/
    schema/     ← types, the closed vocabularies, JSON-schema validators. ZERO deps.
    engine/     ← the 6 ops · 4 invariants · branch resolution.    PURE: no fs, no clock.
    store/      ← fold, .kona/ layout, flock + CAS, waits, outbox, resume.
                  (was store + effects — both are I/O over the same file; merged in §0.6)
    cli/        ← the ~10 verbs, brief.  The only thing that writes.
    viewer/     ← React + xyflow + dagre.  Depends on `schema` ONLY.
    demo/       ← MailboxProvider impls, personas, divergence script.
  plugin/                 # .claude-plugin/plugin.json · skills/ · hooks/ · bin/
```

**The dependency graph is the architecture, enforced rather than documented:**

```
schema ──┬── engine ──┐
         ├── store  ──┴── cli ──────> plugin/bin/kona
         ├── viewer   ┘                        (bun build --compile)
         └── demo
```

| Boundary | Why it is a package and not a folder |
|---|---|
| **`schema` is a leaf with zero dependencies** | §6.10 requires the viewer hold *zero* authoritative state and read only through `kona graph --json`. As a package boundary that is **structural**: `viewer` cannot import `store`, because it does not depend on it. Today that rule is a sentence someone can violate in one import |
| **`engine` is pure — no `fs`, no `Date.now()`** | It takes `(graph, batch)` and returns a new graph or a rejection. That is what makes the 100% mutation-score target on `validate()` cheap rather than heroic (§7), and it is why the per-module Stryker floors map onto packages one-for-one |
| **`store` owns every byte written** | The single-writer rule (§6.7.3) is enforceable by inspection: exactly one package calls `writeFile`, and `cli` is the only caller of `store` |
| **`demo` depends on `schema` + the port, never on internals** | §6.11's whole claim is that the mailbox layer is commoditised and swappable. If `demo` can reach into `store`, that stops being true within a day |
| **`plugin/` is not a package** | It is a Claude Code plugin directory with its own manifest shape. The build drops the compiled binary into `plugin/bin/`, which Claude Code adds to PATH automatically (§6.9, verified) |

**It also maps onto the four windows exactly**, which is the practical payoff during the build:

| Window | Owns |
|---|---|
| W1 | `schema` → `engine` |
| W2 | `store` → `effects` |
| W3 | `viewer` (starts the moment `schema` compiles — it needs types, not a working store) |
| W4 | `demo` (needs `schema` and the port interface only) |
| Operator | `cli`, `plugin/`, integration |

W3 and W4 previously had to wait for a working `kona graph --json`. Against a package boundary they only need `schema` to compile — which is T1.2, at ~50 minutes.

**Cost: about 30 minutes on T1.1**, and one rule to hold: no cyclic dependencies, checked by `bun run build` failing rather than by discipline.

### 6.13. Pros, Cons, Consequences

**Pros**
- D1–D5 are enforced by schema and CLI, not by prompts — the only durable way to constrain an LLM mutator.
- Zero infrastructure. Four windows build in parallel behind one JSON contract.
- The mutation log is simultaneously the audit trail, the viewer's scrubber, the procedural memory and the pitch. One mechanism, four claims.
- Every choice has a named precedent, so the concessions ledger (PRD R3) writes itself and the novelty claim narrows to something true.

**Cons**
- No semantic merge. Conflicting proposals get a `409` and one agent re-decides — correct, but it burns a model call.
- Fold cost is O(history). Irrelevant at demo scale; compaction is future work and must compact *state* while keeping *rationale*, never the reverse.
- The invariant set is a floor, not soundness. Four cheap linear-time checks; everything else is a logged judgment call. Say this proactively — it is the honest "hard problem for the product, not the prototype" line (PRD R4).
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
| `validate()` — the 4 enforced invariants (§6.7.1) | **100** | Pure, branch-heavy, and a surviving mutant is **a bad graph that commits**. Highest-value target in the codebase |
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
| `validate(graph, ops)` | one test per invariant #1–#4, each asserting **rejection with the right reason** |
| Suppression rule | a semantically-equal re-plan writes **no** version |
| `effect_key` lifecycle | minted at creation, payload-independent; **same key + different `payload_hash` ⇒ loud error, not a second send**; the three crash windows (§6.6) resolve to retry / retry / **ask-human**; key match + payload mismatch ⇒ loud error; `done` never re-fires |
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
| **Premise break** | goalie declines ⇒ quorum unsatisfiable ⇒ **invariant 2** forces a re-plan branch rather than a silent bad graph |
| **Divergent arms** — *the end-to-end acceptance test for the whole product claim* | Run the pursuit to completion from an approved v1 plan in which every arm has the identical shape `invite → wait → {yes\|no\|silent}`. Then assert against the final graph: **(a)** ≥1 node exists that no v1 node's shape describes; **(b)** ≥1 counterparty node whose `group` label was not in the v1 roster input; **(c)** at least three arms have **pairwise different node counts**; **(d)** ≥1 arm has an edge leaving its own `group` label into another sub-flow. If (a)–(d) pass, the run produced structure no parameterised fan-out could. If they fail, the system demonstrably behaved as `withParam` regardless of how the code is written |
| **Fold determinism** | folding the same log twice yields an identical graph; a torn final line is tolerated |
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
- [ ] `kona --help` documents every verb; every read supports `--json`; **a shell-level test asserts `$?` for each failure class equals the §6.8 value and is ≤ 125**, and asserts the stderr reason code
- [ ] `schema_version` in every on-disk file
- [ ] SPEC updated wherever the implementation diverged

### Feature-specific

- [ ] **`--why` is a required argument on every mutating verb.** A commit without a rationale is impossible, not discouraged *(D4)*
- [ ] All 4 enforced invariants checked pre-commit; the parser rejects malformed shape before graph logic runs, each with a distinct human-readable rejection naming the node
- [ ] **Rejected mutations are logged**, not silently dropped — a refused mutation is procedural memory too *(§6.7.2)*
- [ ] No `delete_node` verb and no `rollback` opcode anywhere in code or schema
- [ ] `deadline` and `on_timeout` schema-required on every `wait`; a wait without them fails validation
- [ ] The suppression rule works: a semantically-equal re-plan writes no version
- [ ] There is no derived snapshot — every read folds `mutations.jsonl` *(§0.5)*
- [ ] Nothing outside the CLI reads or writes `.kona/`
- [ ] `kona resume` on a fresh terminal prints correct status in **< 60 s** with no session state *(US5)*
- [ ] Every irreversible node carries an `effect_key` minted at creation; the three crash windows behave per §6.6 *(D3)*
- [ ] **No approval gate exists on any topology mutation** — the whole pursuit runs on one pre-execution approval *(§6.9)*
- [ ] The plan declares an effect budget; exceeding it pauses the pursuit rather than sending *(invariant 3)*
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
| **Q4** | ~~Is the mutator premise validated?~~ — **CLOSED 2026-08-21, answer: NO as originally specified; YES with one narrow gate** | v3 at n=60: raw accept 47%, converging to **78%** over three attempts — so the retry loop works — but **silent defects on 47 of 47 accepted commits, 0/60 accepted-and-clean**, and 36% of accepted commits permanently stuck. The decisive failure: the mutator **invented counterparties and queued irreversible email to them**, passing every invariant, because the suite rewarded it. Resolution: **an evidenced-recipient invariant** (now #4) + rationale fidelity (later cut again by §0.5 — see there) + **one gate** in §6.9 on new irreversible effects to unevidenced recipients + **three vocabulary rules** (§6.5) for the states retry never converged on. Full data in `probes/q4-mutator-v3.md` |

**What the retry loop is actually worth.** Read carefully, because the headline number misleads: retry only ever addresses *loud* failures, and a silent defect never triggers one. Across 60 events, no-retry produced 30 defective commits; three attempts produced **47** — 53 extra attempts converted 19 loud rejections into 19 silent commits, ~7 of them permanently stuck graphs the store would otherwise have rejected out loud. **Under the pre-v3 invariant suite the retry loop had negative expected value.** The evidenced-recipient invariant is what makes it positive; re-measure before trusting it.

### Open — need a decision

| # | Question | Status | Default |
|---|---|---|---|
| **Q9** | **Five contract bugs the v2 probe found**, all cheap: (a) **the on-timeout invariant punished tidying** — retiring a timeout branch that can never fire leaves `on_timeout` naming a terminal node, and this is **5 of the 10 rejections**; relax it to apply only while the wait is non-terminal. (b) **`quorum.over="invite@*"` is an id glob** and symbolic refs mean the server mints ids, so a new invite cannot be proven in-population — declare membership explicitly. (c) **Unfired conditional branches are undefined** — the root cause of the dominant silent deadlock; agents invented an assumption and built on it. (d) **`add_wait` has no label slot** though `label` is required. (e) **A gate is "deadlock or toothless"** — no accept-only edge kind exists | Specified, not applied | Apply all five, then v3 at n≥60 |

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

- What fills `outcome` for a **diffuse** mutation — a reroute, a re-parenting — whose effect never gets its own wait.
- Whether the rationale log is reusable as memory *within one pursuit*. AWM is the closest published work and reports offline workflows *impairing* online ones. Asserted, not evidenced.
- **Accept = "no invariant fired," exactly 1:1 across both runs.** Everything the suite does not name passes by construction. Rationale fidelity was deliberately held back to keep v1↔v2 comparable, then enabled for v3, and now lives as lint rule **L5** — 3/20 v2 rationales were machine-checkably false.
