# SPEC — Kona

**Status: Approved** (Ilya, 2026-08-21) · **Owner:** Ilya Vorobiev
**PRD:** [`prd.md`](./prd.md) · **Plan:** [`plan.md`](./plan.md)

> This says what Kona *is*. How it got here — four simplification passes, six probe runs, an eight-lens review — lives in git and in an evidence base that is **not published** (see §11). Decisions carry a one-clause reason only where re-introducing the mistake is likely, and every measurement they rest on is quoted here rather than merely cited.

---

## 0. TL;DR

**Kona is Beads with state machines, plus the plugin Beads never had.** A deterministic CLI over an append-only log; a Claude Code plugin holding all the judgment.

- **One file.** `.kona/mutations.jsonl` is the system of record; the graph is a **fold** over it — a pure data operation, not replay, which is what lets crash-resume and mid-run mutation coexist.
- **⚖ The law: the `kona` binary never calls a model.** Every verb is a pure function of the log + the clock + the mailbox cursor.
- **2 activity types · 6 ops · 1 edge kind · 5 statuses · 3 invariants · 9 verbs · 3 packages.**
- **`--why` is required on every mutating verb.** No rationale, no commit.
- **No rollback.** Emails are sent. Activities are superseded and compensated, never deleted.
- **One gate:** a mutation creating a new irreversible effect to a recipient the graph has never seen.

---

## 1. Meta

| | |
|---|---|
| Branch | `spec/block-0-graph-store` · Epic: Block 0 (PRD §14) |
| Stack | **TypeScript 7** (native) on Bun · React + `@xyflow/react` + dagre · JSONL on disk |
| Budget | 12–14 h, one operator, four parallel windows |

**Toolchain — TypeScript 7.0 (native Go port, released 2026-07-08).** Bun transpiles and runs TS itself, so `bun test` and `bun build --compile` are unaffected by which `tsc` is installed; `tsc` is the **typecheck gate only**, and there it is 8–12× faster than the JS compiler.

| | |
|---|---|
| **Free wins** | `strict: true` and `module: esnext` are now **defaults** — §7's gate and the Bun target both come for nothing. `--checkers` parallelises the check |
| **Config it forces** | `types: []` is the new default, so Bun's globals need an explicit `"types": ["bun"]`. No `baseUrl` — use `paths`. No `target: es5`, `moduleResolution: activity`, `module: amd\|umd\|systemjs` |
| **⚠ No programmatic API until 7.1** | Anything consuming the compiler API needs TS 6 side-by-side via `@typescript/typescript6` (ships a `tsc6`). **typescript-eslint is named in the announcement as needing it** — so `bun run lint` with typed rules wants that package installed |
| **⚠ Unverified** | Whether StrykerJS's TypeScript checker works against 7.0. It is the same class of dependency. §7 already makes mutation score a *target, not a gate*, so the downside is bounded — but **check it before relying on the 100% target**, and fall back to `tsc6` if it bites |

*Source: [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).*

**Platform — macOS is the tested target; Windows and Linux are designed for, not verified.** Most of the design is already portable by accident: §0.5 deleted the derived snapshot, which took **atomic rename** — the single worst Windows footgun — with it, and activity ids are `[a-z0-9-]` so macOS's case-insensitive filesystem cannot collide with Linux's case-sensitive one. Four things need a deliberate choice, and all four are cheap **now** and annoying later:

| | Decision |
|---|---|
| **The lock** | **An `O_EXCL` lockfile, not `flock`.** `fs.open(path, 'wx')` fails atomically if the file exists — on all three platforms. `flock` is POSIX-only and Windows has no equivalent. Same amount of code; write the portable one first. Store `{pid, started_at}` inside, written via `link` from a staged file so it never exists empty. A lock older than the longest legal write is **reported, not reclaimed** — see below |
| **Never auto-reclaim** | A stale lock is refused with `STALE_LOCK` and the operator clears it, the way git handles `index.lock`. Reclaiming cannot be made safe: the check that judges a lock stale and the removal that takes it are two operations, so a second writer can read the old holder, watch the first writer complete its whole reclaim, then move that **fresh** lock aside and append too. There is no POSIX compare-and-delete. §6.7 gives write authority to the orchestrator alone, so reclaiming was solving a problem this design does not have, at the cost of one it would. **Which message the operator gets is decided by a liveness probe, not by the clock**: `kill(pid, 0)` on the holder, where `EPERM` means alive-and-someone-else's and only `ESRCH` means gone. Age alone was a poor proxy for the first thirty seconds — precisely the window a crash is discovered in — and a fresh terminal was told "another writer holds it" while naming a corpse. PID reuse can make a dead holder look alive, which errs toward "someone may be writing"; the dangerous direction cannot happen. Cross-host pids are meaningless, which is one more thing §1's network-filesystem refusal buys |
| **Network-FS refusal** | Detecting a network mount properly needs `statfs` magic numbers on Linux, `statfs` flags on macOS and `GetDriveType` on Windows — none exposed by Bun. **Use a path heuristic** (Dropbox · iCloud · OneDrive · Google Drive) plus a `--force` escape. The risk is lower than it was, since only the append path remains |
| **`kona view`** | Three commands for one job: `open` · `xdg-open` · `start`. Or print the URL and let the user click it, which is what a localhost tool should probably do anyway |
| **The fold** | **Strip a trailing `\r` per line.** One line of code that covers both CRLF (git `autocrlf` on Windows, if a pursuit is ever committed) and part of the torn-line case §7 already tests |

Distribution: `bun build --compile` emits a platform-specific binary, so shipping `plugin/bin/` cross-platform means a target per OS. **For Friday, ship the TS and require Bun** — one artifact, no matrix.

---

## 2. Context

An LLM authors a workflow graph from a plain-language goal, a human approves it, and then **the model mutates its topology mid-run** as reality answers — fan-outs sprout, follow-ups appear on silence, paths reroute when a premise breaks. Every mutation is versioned with its rationale. Any fresh session reads the file and continues.

Runtime structural mutation is 2005–2012 prior art (ADEPT2), *including* rationale-carrying change logs. It failed commercially because the mutator was an expert human with a BPMN editor. **The claim is the mutator, the irreversible timeline, and history-as-briefing** — never the mechanism.

---

## 3. Drivers

| | Driver | Concretely |
|---|---|---|
| **D1** | Resurrection | Fully reconstructible from `.kona/` alone. No session state. |
| **D2** | Safe mutability | An LLM changes topology without orphans, cycles or unsatisfiable predicates. |
| **D3** | Irreversibility | No rollback. Exactly-once external effects across crashes. Compensate forward. |
| **D4** | Mandatory rationale | Every change carries a machine-readable *why*, queryable by the next agent. |
| **D5** | Legibility | A human reads the graph and the diff, live, on a projector. |
| **D6** | Build cost | Fits 12–14 h. Anything needing a server, a migration or a merge algorithm is out. |

**D1+D2 rule out deterministic replay** — determinism forbids mutation. **D3 rules out CRDTs** — they guarantee convergence, not validity, and these invariants must be *rejectable*.

---

## 4. Current state

Greenfield: `docs/` only. No source, no toolchain, no CI. Block 0's output is this document.

---

## 5. Options considered

| Decision | Chosen | Rejected, and why |
|---|---|---|
| **Substrate** | Append-only JSONL, folded on read | **Temporal / LangGraph / Burr** — replay forbids mutation; LangGraph checkpoints carry state and *zero* topology; Burr refuses to rewrite its own graph. **Dolt** — cost Beads two dozen bugs. **SQLite** — honest runner-up and the migration path, but costs the `cat`-able file. **CRDT** — convergence ≠ validity. |
| **Resume model** | Level-triggered reconciliation (K8s, Terraform) | **Replay** re-executes side effects. **Reactive tick** halts work mid-flight — catastrophic once an email is sent. |
| **Mutation authority** | Typed closed op set, CLI-validated | **Regenerating the plan** destroys activity identity, and with it the binding between an activity and the email it already sent. **Select-from-catalogue** (YAWL worklets) is the ceiling this breaks. |
| **Viewer** | React Flow + dagre, read-only | **Mermaid** re-renders whole; identity, animation and camera die on every mutation. |

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
- **`rejections.jsonl` is a third file and deliberately not a third system of record.** §8 requires a refused mutation to be remembered, and it cannot live in the log: `fold` needs versions to increment by one, and a refused batch changed nothing. Nothing folds this file, nothing decides anything from it, and deleting it loses memory rather than state — so the two-file rule's actual purpose, one system of record and no snapshot that can go stale against it, is intact. A stale base version is *not* recorded: that is contention, not a defect in the batch.
- Activity payloads hold **handles and summaries, never bodies** — the read budget of an LLM re-reading the graph on resume is the real ceiling.
- JSON only, never pickle. `schema_version` on line 1.
- Refuse to run on a network filesystem; rename semantics corrupt on Dropbox/iCloud/NFS.

### 6.2 Activities and edges

```jsonc
{
  "id": "goalie-dana",              // store-minted, [a-z0-9][a-z0-9-]*, never `/`
  "type": "task",                   // task | wait
  "label": "Ask Dana to play Thursday",

  "spec": {                         // AUTHORED — changed only by a mutation op
    "instruction": "…",
    "inputs":  [{ "ref": "roster.availability" }],   // resolves to a DECLARED output
    "outputs": [{ "name": "reply", "type": "string" }],
    "merge": "all",                 // all | any — required when >1 blocking in-edge
    "effect_class": "pure",         // pure | reversible | compensatable | pivot
    "effect": {                     // required on pivot / compensatable
      "channel": "email",
      "recipient_ref": "roster.contacts#dana",   // a ref, never a literal address
      "correlation": "ilya+kona-goalie-dana@…",  // FULLY EXPANDED
      "effect_key": "ek_9f2a…"
    },
    "compensates": null,            // activity id, if this task offsets an executed one
    "obviated_if": { "wait": "roster-quorum", "satisfied": true }
  },

  "status": {                       // OBSERVED — written by executors
    "state": "active",              // WHERE we are
    "outcome": null,                // WHAT was decided  (record_outcome)
    "output": null,                 // WHAT was produced (record_output)
    "conditions": [],               // open list: {type, status, reason, at}
    "effect_log": [],
    "observed_at_version": 41
  },

  "provenance": { "created_by_version": 12, "group": "goalies", "supersedes": null }
}
```

**Two activity types.**

| type | What it is |
|---|---|
| `task` | does one thing |
| `wait` | blocks on something. **Three match kinds:** `{kind:"event"}` an inbound reply · `{kind:"human"}` a decision (the four kinds are `outcome.verdict` values) · `{kind:"predicate"}` a condition over its own blocking in-edges |

Every `wait` requires a **`deadline` and an `on_timeout`** — the schema rule that most directly prevents a silent multi-day hang. A message in someone's spam folder is *sent*: no bounce, no reply, no error.

**Three observed fields, three questions.** Conflating any two is how the worst probe bugs happened.

| Field | Answers | Written by |
|---|---|---|
| `status.state` | where are we | `set_status` |
| `status.outcome` | what was decided | `record_outcome` |
| `status.output` | what did this activity produce | `record_output` |

`outputs` is what makes `inputs[].ref` mean anything — without the pair every ref dangles and a fresh subagent cannot execute (measured 0/8).

**Statuses:** `active | sending | done | failed | dropped`. **Terminal** = `done | failed | dropped`.
**`sending` is non-terminal** — it means *the real world's answer is unknown*, not a resolution. `failed` ≠ `dropped`: "tried, didn't work" vs "we stopped wanting this."

**One edge kind:** `{from, to, condition?}` — no identity. `{from: A, to: B}` means **B requires A**. `condition.on ∈ accept|edit|respond|ignore|timeout|bounced|satisfied`, and the store fires the out-edge whose condition matches the resolution. **Every out-edge of a `wait` must carry a condition** — otherwise an ignored or timed-out wait clears a plain edge and a pivot fires unapproved. Provenance is a **activity field** (`supersedes`, `compensates`), never an edge.

**Deadlines, one of three shapes:**

```jsonc
{"at": "2026-08-22T17:00:00Z"}
{"after": "invite-dana", "duration": "48h"}
{"expr": "game_date - 24h", "backstop": "…", "after_unknown": true}
```

### 6.3 The mutation record

One line per commit. This is the differentiator; the schema makes omitting it impossible.

```jsonc
{
  "v": 42,
  "schema_version": 1,
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

- **`outcome` starts null.** No benchmark, N=1 — you cannot re-run "email twelve parents" and take the mean. A wait's resolution fills it in. *Rationale without outcome is a changelog; rationale with outcome is training data.*
- **A rationale is never edited.** Append a new version referencing the old.
- **Suppression:** a re-plan producing a semantically equal fragment writes **no version**. Version mutations, not snapshots.

### 6.4 The six ops

```
add_activity(scope, spec)                                        -> $id
add_edge(from, to, {condition?})
set_status(activity, status, evidence_ref)
record_outcome(activity, verdict, evidence_ref, attrs?)          confirmed|declined|tentative|timed_out|bounced
record_output(activity, output_name, value_or_ref, evidence_ref)
supersede_activity(activity, by?)                                    (never delete)
```

**Forbidden, no opcode reserved:** `delete_node` · `rollback` · `replace_graph` · `edit_rationale` · `reparent` · any write to a terminal activity · coordinates · executable payloads · client-assigned ids.

- **Batch semantics pinned.** Ops apply in array order; invariants check once against post-commit state — **except invariant 1**, an op-delta predicate against pre-commit head. Internal order: additions and rewires before cancellations.
- **Intra-batch references:** `$0`, `$1` — the id returned by `ops[N]`. Forward and unresolved refs rejected. Never invent an id.
- **No op creates an edge you did not write.** Auto-wiring was the cause of every orphan a probe produced.
- **Fan-out** is `add_activity` × N + `add_edge` × N in one batch. The atomic unit is the commit.

**Branch resolution — the store does the housekeeping, never the agent.**

> When a `wait` resolves, the store marks the target of every untaken out-edge `dropped`, **transitively**: any activity whose *every* blocking in-edge originates at a dropped activity is dropped too. It stops at an activity still held by a live in-edge — a shared descendant, which survives.
>
> An in-edge whose **source** is dropped is **excluded from merge evaluation** — it neither satisfies nor blocks. A merge whose remaining live in-edges are all terminal is satisfied; one with **zero** live in-edges routes to `on_timeout` and never hangs.
>
> **Readiness fails safe and does not inherit the exclusion.** An activity is ready iff it is not dropped and every blocking in-edge has a terminal-*success* source with its condition true. A dropped source never satisfies readiness — otherwise the second activity on an untaken branch has no blocker, lands on the frontier, and gets dispatched, pivot send included.

Every time the contract asked the model to tidy up, it forgot, half-did it, or was rejected for trying. **When the housekeeping is derivable, the store does it.**

### 6.5 Waits

```jsonc
"match": {
  "kind": "event",
  "conditions": [                                  // or-group, first-wins
    {"kind":"reply",    "in_reply_to":["<m-101>"], "from":"dana@…", "on":"satisfied"},
    {"kind":"deadline", "at":"2026-08-22T17:00Z",                   "on":"timeout"}
  ],
  "correlation": "ilya+kona-goalie-dana@…",        // DERIVED from the activity id
  "cursor": {"last_seen":"…","last_checked_at":"…"},
  "memory": true,
  "resolution": null                               // satisfied | timeout | bounced | dropped
}
```

- **Correlation derives from the activity id**, never minted per run — a token that changes across executions goes stale in someone's inbox. Specifically **the WAIT's id**, not the sender's: the two carry the same literal because they are one conversation, and the wait is the end that owns it. `record_outcome` targets the wait, so a reply has to route there; and a send can be superseded while the wait behind it survives, which is exactly the case where a sender-derived token would be reissued for a conversation already sitting in somebody's mail client. `kona brief` therefore looks *forward* from the sending activity to the event-wait it feeds — and **fails closed on more than one**, since guessing which wait a reply belongs to would advance the wrong arm under no-rollback. A send with no wait behind it gets no reply address at all; nothing is listening.
- **Reconciliation is truth; webhooks are a latency optimisation.** No provider offers a delivery guarantee strong enough to be state.
- **First-match-wins**, deduped on provider message-id. Evaluate-all would let one reply advance two fanned-out waits — unrecoverable under no-rollback.
- **Three states the contract must name**, because a retry loop never converges on them: a reply arriving after its wait resolved is `record_outcome(verdict:"late")` and **never reopens** it; a tentative reply records without resolving; a satisfied predicate-wait has the **store** drop its still-armed siblings.

### 6.6 Irreversible effects

You cannot make a local write and an external effect atomic. The outbox is the admission of that.

```
1. kona effect reserve <activity> --payload-hash <h>   → append intent, status: sending, FSYNC
2. executor sends
3. kona effect record <activity> --key <k> --outcome sent --message-id <id>
```

| Crash between | Resume finds | Action |
|---|---|---|
| append and fsync | nothing | safe — nothing happened |
| fsync and send | `sending` | **safe to retry with the same key** |
| **send and record** | `sending` | **must ask a human.** The world's state is genuinely unknown |

- **`effect_key = hash(activity_id, created_by_version)`** — **payload-independent by design**; `payload_hash` is computed at reserve. *The key names the slot; the hash proves the bytes were the ones approved.* Putting the body in the key makes the mismatch check unreachable, and the second email sends.
- Same key, **different payload_hash** ⇒ loud error in the viewer. Never a silent no-op, never a second send.
- An activity with a non-empty `effect_log` is **never re-executed** — the CLI refuses.
- `attempted_at` ≠ `completed_at`; attempted-without-completion is **human adjudication**, not retry.
- **No per-activity retry budget** — and the absence is load-bearing, not an omission. One activity has exactly one slot, because the key is a function of `(activity_id, created_by_version)`; a failed send makes the activity terminal and invariant 1 forbids reopening it. So **retrying is superseding and replacing**: a new activity, a new key, and a graph mutation the model must justify. A `max_reattempts` field was specified here and deleted — nothing could ever spend it, and a budget nothing can spend reads as a safety net that is not there.
- **What that moves, and where.** The research's actual demand — *"without a budget, an LLM mutator will retry forever"* — is now carried entirely by **invariant 3(a)**, the pursuit-wide cap on cumulative irreversible sends. Which makes 3(a)'s budget, still undefined in §6.7, the only thing standing between a mutator and two hundred emails. **It is no longer optional.**

### 6.7 Invariants, concurrency, resume

**The parser first, free.** A zod schema at the CLI boundary rejects malformed shape — legal type and required fields, a condition on every wait out-edge, a deadline and `on_timeout` on every wait — before any graph logic runs.

**Then three invariants. Reject the commit, name the activity.**

| # | Invariant |
|---|---|
| **1** | **Terminal & effect protection** — an **op-delta** predicate, per-op against **pre-commit head**. For an activity terminal at commit time: no new blocking edge into it, and no op targets it except `supersede_activity` / `record_outcome` / `record_output`. No supersede of an activity with a non-empty `effect_log` unless the same batch carries its compensation. **Existing** blocking edges into terminal activities are untouched — they record how it became reachable. |
| **2** | **Predicate-waits stay satisfiable** — population is the wait's blocking in-edges. `satisfiable iff matching_confirmed + still_live >= n` |
| **3** | **Effects are bounded and addressed** — (a) cumulative irreversible ATTEMPTS ≤ the approved budget, enforced at `effect reserve` and failing closed when no budget is configured. *Attempts, not confirmed sends: the two crash windows leave a reservation whose outcome is genuinely unknown, so a cap that only counted confirmed sends would be spendable without limit by crashing;* (b) `recipient_ref` resolves to an entity already in the graph carrying an `evidence_ref`. **A recipient existing only in the proposing batch is rejected.** |

3(b) is not theoretical: at n=60 the mutator met an unsatisfiable predicate by **inventing counterparties and queueing email to them**, passing every other check — because the suite rewarded it.

**Predicate grammar**, one closed form: `{"count": {"verdict":"confirmed","attrs":{"role":"goalie"}}, "op": ">=", "n": 1}`. Reads only `outcome.verdict` and `outcome.attrs`; no other names resolve.

**Log, don't block:** a mutation touching a region containing `done` or `sending` activities gets a `conflict` annotation surfaced in the viewer. When a new step should have preceded something already done, insert it at the first still-reachable successor and log the displacement. **Never rewrite the trace.**

**Concurrency, in order of what it buys:**

1. **Role-scoped write authority.** Only the orchestrator mutates topology; subagents `set_status` and write their own activity's output. This removes most of the need for locking.
2. **CAS on `--base-version` against head.** Exit 3 → re-read → re-decide, never blind-merge. *(54 cross-actor overwrites in Beads' data were median 31 minutes apart — the enemy is hand-offs, not races, so the fix is rejection.)*
3. **One macro-step per external event.** One inbound reply = one lock, one cascade, one version.
4. **Judgment-bearing fields are append-only** with actor + timestamp + rationale; the current value is a projection.

**Crash-resume — derivable from the file alone:** topology and per-activity status · the frontier, **computed never stored** · every open wait's predicate, deadline, correlation and cursor · every irreversible activity's `effect_key` and `effect_log` · every unresolved gate · the rationale chain for any activity · which version the human approved.

**Resume is reconcile-then-repair:** fold → fire overdue timeouts → reconcile waits against the world → report `sending` unknowns. **Each repair is itself a logged mutation with a rationale.** Never re-execute a `done` activity — enforced in the store, not in a prompt. The loader is partial-tolerant: a damaged graph reports which activities failed rather than dying.

### 6.8 The CLI — and the law

> **⚖ The `kona` binary never calls a language model.** Not once, not as a fallback. Every verb is a pure function of `mutations.jsonl` + the clock + the mailbox cursor.

| kona answers | The plugin answers |
|---|---|
| what's ready · did a reply arrive · has the deadline passed · is the predicate satisfiable · which branches weren't taken · is this batch legal | **did Dana say yes** · **what should the plan become** · **what does this activity's work involve** |

Four things follow, which is why it is a law: §7's 100% mutation-score target is only affordable with nothing stochastic to mock; `kona resume` produces *one* answer rather than a plausible one, which makes D1 a guarantee; cost is bounded by decisions rather than turns; and it is the positioning.

| Verb | Contract |
|---|---|
| `kona init` | create `.kona/`, write `schema_version`, refuse on a network filesystem |
| `kona mutate --ops <f> --base-version N --why "…"` | **the only write path.** validate → lock → CAS → append → fsync |
| `kona graph --json [--version N]` | **the only read contract.** Status, history and the rationale chain are projections |
| `kona next` | the ready frontier. Computed, never stored |
| `kona brief <activity>` | §6.9 |
| `kona poll` | scan each armed wait's cursor; report what changed |
| `kona resume` | reconcile-then-repair |
| `kona effect reserve\|record` | the §6.6 outbox — the only verbs that touch the world |
| `kona view [--port]` | start the localhost viewer. **User-run, never plugin-spawned** |

**Exit status is 8-bit** (`409` truncates to `153`): `0` ok · `1` refused · `3` stale base version · `4` invariant violation. Every non-zero exit writes one stderr line beginning with a symbolic reason — `STALE_BASE_VERSION` (+ head), `INVARIANT_VIOLATION` (+ invariant and activity), `REFUSED` (+ reason).

**The reason token is the API; the code is a coarse class.** Exit `4` means precisely "the stderr line begins with `INVARIANT_VIOLATION`", which is invariants 1 and 2. **Invariant 3 exits `1`**, both halves, because neither is a transition guard: 3(b) is parser-class — does this string name somebody the graph already knew — and 3(a) is a ledger read at `effect reserve`, where the send actually happens. They carry `UNEVIDENCED_RECIPIENT` and `EFFECT_BUDGET_EXHAUSTED`, and §6.9's one human gate keys on those tokens rather than on the number. Worth stating because the trap is silent: a script branching on `-eq 4` alone misses the fabricated-counterparty case, which is the one it most wants to catch.

Hardcode the five queries the viewer needs. **No query language.**

### 6.9 The plugin

| Command | Does |
|---|---|
| `/kona:plan <brief>` | LLM authors the graph as a batch of typed ops → CLI validates → viewer renders → human approves |
| `/kona:run` | **The loop, carrying no bookkeeping.** `kona next` → dispatch verbatim → `kona poll` → **call a model only when an event needs a decision** → `kona mutate`. ~1 model call per cycle |
| executor skill | consumes `kona brief`; returns `EXECUTED` (bytes moved) / `COMPOSED` (payload ready, not dispatched) / `REFUSED` (with `refusal_reason` **mandatory**) |

**`kona brief <activity>` returns the activity's subgraph plus three things the graph cannot know, or it refuses:**

| Block | Why the graph cannot know it |
|---|---|
| `identity` | sending mailbox, display name, signature, **and an authority statement** ("you may not commit funds") |
| `correlation` | the **fully-expanded literal** reply-to and subject tag — a template variable that reaches a counterparty can never correlate |
| `preconditions_satisfied` | computed by the CLI, **fails CLOSED**: every input resolved · every upstream gate returned · budget remaining · `effect_key` reserved-and-unfired |

Plus `disclosable` — a per-field marking of what may appear in outbound content, or an agent will read a wait's internal timeout and turn it into a promise nobody authorised.

**Mutation is automatic — with exactly one gate.**

> **Automatic:** every topology mutation. Fan-out, reroute, follow-up, obviation, supersede-with-compensation, re-plan.
> **Gated:** a mutation creating a new irreversible effect targeting **a recipient not already evidenced in the graph.**

Narrow on purpose. Adaptive BPM died because change was expensive and blameful, so **changing the plan stays free**; what costs a human decision is *inventing a person to email*. **The plan changes freely; the world does not; and nobody new enters the world without a human.**

The approval object is a **frozen, content-hashed plan artifact** — the only defensible answer to "what exactly did the human approve?" A denial is a mutation: the human's verbatim text becomes its rationale. No timed auto-proceed. Gate op *classes*, never individual mutations.

**Two prompt rules, free from Beads' docs:** temporal phrasing inverts edge direction (force "Y needs X"), and numbering steps does not create sequence. Ship the §6.2 catalogue **verbatim** into the plan prompt — a paraphrase produced four stuck-gate defects. Require a premise check: 2 of 4 briefs referenced entities that do not exist and produced confident, approvable graphs anyway.

The plugin is **additive and trivially removable** — no git hooks, no daemon, no writes to `~/.claude/settings.json`.

### 6.10 The viewer

React Flow (fully controlled) + dagre `rankdir:'LR'`, positions derived every version, never stored. Read-only for topology; status intervention routes through the CLI so it lands in the log.

| # | Rule |
|---|---|
| 1 | **Build the diff animation first.** File change → re-layout → tween → flash the new subtree. The claim is only *visible* if the viewer shows topology changing |
| 2 | **Memoize dagre on a TOPOLOGY SIGNATURE; never re-layout on a status tick.** Burr's graph view froze on exactly this until July 2026, and the fan-out is where it bites. *(Corrected during E6: this rule originally said "memoize on `graph_version`", which defeats its own second clause — `graph_version` bumps on a status tick too, so keying on it re-runs dagre for every reservation, receipt and reply. The signature is `{activity id, type, superseded_by}` per activity and `{from, to, condition}` per edge; eight of the fixture's thirteen versions change none of it, and five of those eight are the outbox. `packages/viewer/test/layout.test.ts` asserts the cache returns the IDENTICAL object across a reserve→record pair, because React re-renders on identity and an equal-but-fresh layout would defeat the memo at the only layer where it pays.)* |
| 3 | **Collapse fan-out groups by default** — one container, aggregate status, edges redirected to it |
| 4 | **Every activity renders its own state inline** — status chip, wait predicate, deadline countdown, predicate counter, and for a blocked activity **the reason as text** |
| 5 | **The second panel is the mutation timeline** — version + op + rationale. *That panel, not the canvas, is the differentiator* |
| 6 | **The scrubber must look nothing like undo.** Read-only time travel, never revert-to-version-N |
| 7 | Deterministic layout; **animate, don't snap.** Pin visual order by insertion order |
| 8 | Three-colour waits: fulfilled / awaiting-within-deadline / deadline-blown |
| 9 | **Localhost only, zero outbound calls**, message bodies behind an explicit reveal |
| 10 | `kona graph --json` + file-watch is the **one** read contract |

**Do not build a graph editor.** An editable canvas is a second, unversioned mutator with no rationale.

### 6.11 The evaluation rig

The demo is **one task from Terminal-Bench 3** — `production-planning`, a supply-chain
problem that must reconcile ERP, MES and WMS and emit three SQL writebacks against twenty
constraint checks. `eval/` runs it twice, same model both sides, with and without Kona.
See [`eval.md`](./eval.md) for the design, the costings and the frozen pre-registration.

| | |
|---|---|
| Harness | Terminus-2, inside Harbor — the harness the benchmark's own leaderboard uses |
| Arms | stock Terminus-2 vs the same plus `kona` on `PATH` and one `SKILL.md` |
| Isolation | one container per arm; the store is a compiled `kona-bin`, no Bun in the image |
| Scoring | reward is **binary** on this suite, so the comparison reads the per-check CTRF |

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

Per-package Stryker floors where mutation testing pays: **`validate()` and `fold()` at 100** — pure, branch-heavy, and a surviving mutant is a bad graph reaching the file — outbox 100 · CAS/lock 95 · the rest 90 · viewer excluded. If only one suite gets written, write `validate()`. *Equivalent mutants are unkillable by construction; exclude them with a written reason, reviewed like code.*

**Unit, written first:** `fold` determinism and torn-line tolerance · one test per invariant asserting **rejection with the right reason** · the suppression rule · `effect_key` across all three crash windows · CAS and lock release on crash · op ordering · branch-drop transitivity.

**Integration:**

| Test | Asserts |
|---|---|
| `kill -9` mid-mutation | restart makes progress with zero session state; **nothing re-sent** |
| Duplicate-send guard | crash between reserve and record ⇒ `sending`, no re-send, human surfaced |
| Fan-out → predicate | replies out of order; the predicate flips once; siblings auto-dropped with a rationale |
| Premise break | the only goalie declines ⇒ invariant 2 forces a re-plan rather than a silent bad graph |
| **Divergent arms** | from a v1 plan where every arm is identical, assert **(a)** an activity no v1 activity's shape describes · **(b)** a counterparty absent from the v1 roster · **(c)** three arms with pairwise different activity counts · **(d)** an arm with an edge leaving its own group. *Pass and the run produced structure no parameterised fan-out could. Fail and the system behaved as `withParam` regardless of the code.* |
| Untaken arm, two deep | both activities end `dropped`, neither appears in `next`, neither reserves an effect, the merge satisfies rather than hanging |
| Late reply after timeout | lands as a logged outcome; does **not** reopen a closed wait |

Six of these seven survive as unit tests in `core` and `kona` — branch drops, the crash
windows, the predicate flip, the timeout. **Two do not.** *Divergent arms* was asserted by the
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
- [x] Every irreversible activity carries a payload-independent `effect_key`; the three crash windows behave per §6.6 — the key is `hash(activity_id, created_by_version)` and the `payload_hash` proves the bytes, so re-reserving the same slot with different bytes is `EFFECT_PAYLOAD_MISMATCH` rather than a second send
- [x] Only the orchestrator mutates topology; a subagent attempting it is refused — and invariant 2 EXEMPTS a subagent from the satisfiability check, because an actor that cannot author the repair must not be blocked for failing to include one
- [x] Viewer holds zero authoritative state; dagre memoized on a **topology signature** (see §6.10 rule 2 — the original wording named `graph_version`, which re-layouts on the status ticks the same rule forbids); zero outbound calls
- [x] Startup refuses on a network filesystem — path heuristic for Dropbox / iCloud / OneDrive / Google Drive / UNC, with `--force`
- [ ] Repo public before the demo. **`probes/` and `research/` are withheld** — reversed from the original "with `probes/` and `research/`", which read the receipts as the deliverable. They are not: the findings are, and those are in §11, in the three design documents, and in a comment at every decision they justify. The concessions ledger in §11 is public, which is the part that names what this owes to prior art

---

## 9. Alternatives not chosen

| | Why |
|---|---|
| **Temporal / Cadence / Restate** | Deterministic replay forbids mid-flight mutation and re-executes side effects. Their own framing concedes it: *"deterministic in execution… but not predetermined"* |
| **LangGraph** | Checkpoints carry state and **zero** topology. `Send` fans out N invocations of one *pre-declared* activity; Kona's fan-out creates N activities with distinct types, waits and deadlines |
| **Burr** | Closest shipped neighbour and the source of the viewer stack — but its writer refuses to rewrite `graph.json`, the human sits *outside* the graph, and it performs no validation |
| **BPMN engines** | Runtime modification ships — as a *privileged human repair tool*. Camunda: *"an activity which tries to modify its own process instance can cause undefined behavior"* |
| **CRDTs** | Convergence ≠ validity. Nothing can *reject* a merge |
| **Dolt / SQLite** | SQLite is the documented migration path; both cost the `cat`-able file and the readable diff |
| **Mermaid for the live view** | Full re-render destroys activity identity, animation and camera |
| **Select-from-catalogue** | Precisely the ceiling Kona breaks: *worklets chose from a catalogue a human wrote; Kona writes the sub-flow* |
| **MCP server in v1** | Design for it, don't build it. A large tool surface costs ~21k tokens/turn |
| **Compacting the log** | Beads' `compact` made 42 of 43 sampled version addresses vanish. The history is the product |

---

## 10. Open questions

| | | |
|---|---|---|
| **Q1** | **Nothing verifies the pursuit's premises.** 2 of 4 authoring briefs referenced entities that do not exist and 8/8 runs produced confident, approvable graphs anyway | Mitigated by a prompt requirement, enforced by nothing. The failure most likely to survive into real use |
| **Q2** | **The irreversible send has never been exercised.** Both execute arms of the brief probe composed a correct payload and stopped at the transport | First integration test after Block 1 |
| **Q3** | **Re-measure the retry loop.** At n=60 it converted 19 loud rejections into 19 silent commits — **negative expected value** under the old suite. Invariants 1 and 3(b) are what flip it, and that is asserted, not measured | The natural next probe |

**Recorded for honesty:** what fills `outcome` for a diffuse mutation whose effect never gets its own wait; whether the rationale log is genuinely reusable as memory *within* one pursuit (AWM, the closest published work, reports offline workflows *impairing* online ones); and that the probes ruled out catastrophes without producing reliability numbers — brief-v2's 10/10 is effectively n≈5, consistent with a true failure rate up to 26%.

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

**Concessions ledger:** Reichert & Dadam, *ADEPTflex* (1998) / *ADEPT2* (ICDE 2005) · Schonenberg et al., *Taxonomy of Process Flexibility* (CAiSE'08) · Ellis, Keddara & Rozenberg (1995), the dynamic change bug · Adams et al., YAWL worklets & exlets · Reijers, *Workflow Flexibility: The Forlorn Promise* (2006) · Zhang et al., *AFlow* (ICLR 2025) · Wu et al., *StateFlow* (COLM 2024) · Garcia-Molina & Salem, *Sagas* (1987).

⚠ **Cite Beads accurately:** it is Dolt-backed and `issues.jsonl` is an export, *"not the source of truth."* The frozen SQLite+JSONL architecture Kona imitates is `beads_rust`/`br`.
