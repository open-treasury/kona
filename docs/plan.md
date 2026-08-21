# Kona — Execution Plan

**Status:** Draft · **Date:** 2026-08-21 · **Source:** [`spec.md`](./spec.md) v-current, [`prd.md`](./prd.md) v4.3
**Convention:** one module = one epic · every task ≤ 4h human effort · AI effort estimated separately and more atomically.

---

## 0. TL;DR

| | |
|---|---|
| **Full spec, human effort** | **~105 h** (≈ 13 solo working days) |
| **Full spec, AI effort** | **~27 h** of agent-time |
| **Critical path (AI, serial — cannot be parallelised away)** | **~6.1 h** spine, ~10 h if the durability chain is serialised |
| **Wall clock, 4 windows + operator review** | **~16–20 h** |
| **PRD §14 budget** | **12–14 h** |

**The full spec does not fit Friday**, but it is closer than it was: cutting the invariant set from 16 enforced to 7 (§6.7.1) took ~5 h out of E2 and shortened the spine to ~6.1 h. §8 defines the cut that fits — **~6 h critical path, ~12 h wall clock** — by shipping E1–E3 whole and trimming everywhere else.

**The serial spine is `fold → ops → invariants → CLI → orchestrator`.** Nothing parallelises around it. Everything else (viewer, demo rig, plugin skills) hangs off `kona graph --json` and `kona brief` and can be built the moment those two verbs exist.

**Sequencing rule that saves the most time:** get `kona mutate` + `kona graph --json` working end-to-end on a *stub* invariant set by hour 4, then unblock three windows at once. Building all seven invariants before anything else can consume the graph is the single biggest scheduling mistake available — and it was worse when there were sixteen.

---

## 1. Epics

| # | Epic | Human | AI | Depends on | Friday |
|---|---|---:|---:|---|---|
| **E1** | Graph store core — types, on-disk, fold | 10.5 h | 2.75 h | — | **full** |
| **E2** | Mutation engine — 11 ops, 9 invariants, CAS | 20 h | 5.05 h | E1 | **partial** |
| **E3** | Wait & effect engine — waits, outbox, resume | 17 h | 4.3 h | E1, E2 | **full** |
| **E4** | CLI surface — 17 verbs, brief, lint | 13 h | 3.25 h | E1–E3 | **partial** |
| **E5** | Claude Code plugin — orchestrator + executor | 12.5 h | 3.2 h | E4 | **partial** |
| **E6** | Viewer — React Flow + dagre | 15.5 h | 3.9 h | E4.1 only | **partial** |
| **E7** | Demo rig — mailbox, personas, divergence | 10.5 h | 2.7 h | T1.1 only | **partial** |
| **E8** | Integration & rehearsal | 7 h | 1.75 h | all | **full** |
| | **Total** | **105.5 h** | **26.8 h** | | |

---

## 2. E1 — Graph store core

*The substrate. Everything blocks on this; nothing here is optional.*

| ID | Task | Human | AI | Deps |
|---|---|---:|---:|---|
| T1.1 | **Monorepo scaffold** — Bun workspace, 7 packages per §6.12, `tsconfig` strict + project refs, lint, test runner, cycle check in `build` | 1.5 h | 30 m | — |
| T1.2 | **`packages/schema`** — 6 node types, 4+4 edge kinds, the edge record, `status`/`outcome`/`output`, typed deadlines (3 shapes). **Zero deps; unblocks W3 and W4** | 2 h | 30 m | T1.1 |
| T1.3 | `.kona/` init: `schema_version`, dir creation, **network-filesystem refusal** | 1.5 h | 25 m | T1.2 |
| T1.4 | **`fold(mutations) → graph`** — pure, deterministic, tolerant of a torn final line | 3 h | 45 m | T1.2 |
| T1.5 | `graph.json` materialization — write-temp + atomic rename, head check, rebuild-on-mismatch | 2 h | 30 m | T1.4 |
| T1.6 | `blobs/` content-addressed store (sha256, pointers-not-payloads) | 1 h | 15 m | T1.3 |

**Gate:** `rm .kona/graph.json` → next command rebuilds it byte-identically. That single test proves the architecture.

---

## 3. E2 — Mutation engine

*Still the largest epic, though 5 h lighter after the invariant cut. Carries every probe finding. **T2.6 is not optional** — it is what four probe runs converged on.*

| ID | Task | Human | AI | Deps |
|---|---|---:|---:|---|
| T2.1 | The 11 ops — apply functions, fixed internal order (additions/rewires → cancellations) | 4 h | 1 h | T1.4 |
| T2.2 | Symbolic ref resolution — `$0`, `$2.children.dana`; reject forward/unresolved refs | 2 h | 30 m | T2.1 |
| T2.3 | Auto-wiring per op (the §6.4 table) — the fix that eliminated every orphan in v2 | 2 h | 30 m | T2.1 |
| T2.4 | **The 9 enforced invariants** (§6.7.1) + CAS check. **#8 recipient-evidence is the highest-value one in the codebase** — it is what stops the mutator inventing people to email | 3.5 h | 50 m | T2.1 |
| ~~T2.5~~ | ~~Invariants 9–16~~ — **cut**; five moved to `kona lint` (T4.3), two dropped | — | — | — |
| T2.6 | **Branch resolution** — store drops untaken branches; dropped edges excluded from merge; zero-live-in-edge → `on_unsatisfied` | 3 h | 45 m | T2.1 |
| T2.7 | `flock` + compare-and-swap on `parent_v` + exit 409 | 2 h | 30 m | T1.5 |
| T2.8 | Mutation record write — rationale required, `outcome: null`, bi-temporal stamps | 1.5 h | 25 m | T2.7 |
| T2.9 | Suppression rule — semantic content hash, no-op-with-revalidation on unchanged | 2 h | 30 m | T2.8 |

---

## 4. E3 — Wait & effect engine

*Where the "nobody else has a clock or a counterparty" claim actually lives.*

| ID | Task | Human | AI | Deps |
|---|---|---:|---:|---|
| T3.1 | Wait schema — or-group conditions, first-wins, deadline evaluation against wall clock | 3 h | 45 m | T2.1 |
| T3.2 | Correlation derivation + inbound matching — `+kona-<node_id>`, first-match-wins, dedupe on `message_id` | 3 h | 45 m | T3.1 |
| T3.3 | **Outbox** — `effect reserve` → fsync → send → `effect record`; the three crash windows | 3 h | 45 m | T2.8 |
| T3.4 | Effect ledger + budget enforcement (invariant 8's circuit breaker) | 1.5 h | 25 m | T3.3 |
| T3.5 | Leases + `kona next` eligibility (`O_EXCL`, TTL, reclaim) | 2.5 h | 40 m | T2.7 |
| T3.6 | **`kona resume`** — the six-step reconcile-then-repair; each repair logged as a mutation | 4 h | 1 h | T3.1, T3.3 |

**Gate:** `kill -9` mid-send → resume finds `sending`, re-sends nothing, surfaces it for a human.

---

## 5. E4 — CLI surface

| ID | Task | Human | AI | Deps |
|---|---|---:|---:|---|
| T4.1 | Verb scaffolding, `--json` on every read, exit codes 0/409/422/423 | 2 h | 30 m | T1.3 |
| T4.2 | **`kona brief`** — the 9 required blocks; refuses rather than returning a partial | 4 h | 1 h | T3.1, T2.4 |
| T4.3 | `kona lint` — 11 author-time rules **+ L1–L5 moved down from the invariant set** | 3.5 h | 50 m | T2.4 |
| T4.4 | `kona plan` / `apply` — frozen content-hashed artifact | 2 h | 30 m | T2.4 |
| T4.5 | `kona status` / `history` / `why` | 2 h | 30 m | T4.1 |

---

## 6. E5–E8

### E5 — Claude Code plugin

| ID | Task | Human | AI | Deps |
|---|---|---:|---:|---|
| T5.1 | Plugin skeleton — `.claude-plugin/plugin.json`, `bin/` (ships the binary), `hooks/` | 1.5 h | 25 m | T4.1 |
| T5.2 | `/kona:plan` authoring skill — §6.2 catalogue **verbatim**, edge-direction convention, premise check | 3 h | 45 m | T4.4 |
| T5.3 | `/kona:run` orchestrator loop — read → dispatch → merge, one macro-step per event, **+ the §6.9 new-counterparty gate** | 4 h | 1 h | T4.2, T3.5 |
| T5.4 | Executor subagent skill — consumes `brief`, returns `EXECUTED`/`COMPOSED`/`REFUSED` | 3 h | 45 m | T4.2 |
| T5.5 | `SessionStart` hook → `kona resume` (makes kill-and-resume automatic) | 1 h | 15 m | T3.6 |

### E6 — Viewer

| ID | Task | Human | AI | Deps |
|---|---|---:|---:|---|
| T6.1 | Vite + React + `@xyflow/react` scaffold; poll/SSE on `kona graph --json` | 2.5 h | 40 m | T4.1 |
| T6.6 | **Diff animation prototype — build this FIRST** (§6.10 rule 16) | 2 h | 30 m | T6.1 |
| T6.2 | Node types + inline state (status chip, deadline countdown, quorum counter, blocked-reason text) | 3 h | 45 m | T6.1 |
| T6.3 | dagre layout **memoized on `graph_version`** (Burr #834) | 2 h | 30 m | T6.1 |
| T6.4 | Group collapse + edge redirection to container | 3 h | 45 m | T6.3 |
| T6.5a | **Rationale timeline panel** (never-cut) | 2 h | 30 m | T6.2 |
| T6.5b | Version scrubber (cut-order 5) | 1 h | 15 m | T6.5a |

### E7 — Demo rig

| ID | Task | Human | AI | Deps |
|---|---|---:|---:|---|
| T7.1 | `MailboxProvider` port + Mailpit implementation | 2.5 h | 40 m | **T1.1** |
| T7.2 | Gmail plus-addressing implementation | 2 h | 30 m | T7.1 |
| T7.3 | Persona generation + reply simulator | 3 h | 45 m | T7.1 |
| T7.4 | **Divergence script** — Priya conditional / Pat silent / Sam→Marcus | 2 h | 30 m | T7.3 |
| T7.5 | `kona event add` injection path (doubles as the live-failure fallback) | 1 h | 15 m | T4.1 |

### E8 — Integration & rehearsal

| ID | Task | Human | AI | Deps |
|---|---|---:|---:|---|
| T8.1 | One full pursuit end-to-end | 3 h | 45 m | T5.3, T5.4, T7.1, T7.4, T7.5 |
| T8.2 | **Divergent-arms acceptance test** (§7.2 assertions a–d) | 2 h | 30 m | T8.1 |
| T8.3 | Kill-and-resume rehearsed ×2 | 2 h | 30 m | T8.1 |

---

## 7. Critical path

```
T1.1 → T1.2 → T1.4 → T2.1 → T2.4 → T4.2 → T5.3 → T8.1
 20m    30m    45m    60m    45m    60m    60m    45m          = 6.1 h AI
                        ↘ T2.7 → T2.8 → T3.3 → T3.6 ──────↗
                           30m    25m    45m    60m           (+2.7 h if serialised)
```

**Critical path ≈ 6.1 h AI-time**, rising to **~11.5 h** if the durability chain (T2.7→T3.6) is not run in a parallel window. Add operator review at roughly 1.5× and the wall clock is **~16–20 h for the full spec**.

**The unblocking moment.** After **T2.1 + T2.7 + T4.1** (≈ 2.5 h AI), `kona mutate` and `kona graph --json` work against a *stub* validator. That is the moment three windows open at once. **Do not build all 16 invariants first** — it is the biggest available scheduling error, and it keeps E6/E7 idle for hours.

### Window allocation after the unblock

| Window | Owns | Runs until |
|---|---|---|
| **W1** | `schema` → `engine` (ops, invariants, branch resolution — pure, no I/O) | the spine is done |
| **W2** | `store` → `effects` (fold, materialize, flock+CAS, waits, outbox, resume) | resume passes `kill -9` |
| **W3** | E6 viewer — starts the moment **`packages/schema` compiles** (T1.2, ~50 min), not when `graph --json` works | timeline panel; scrubber if time |
| **W4** | E7 demo rig — needs **`packages/schema` + the port interface** only | divergence script runs |
| **Operator** | E4 CLI glue, E5 plugin skills, review, integration | — |

---

## 8. Friday cut-line

**Ship (≈ 6 h critical path, ~12 h wall clock):**

E1 whole · E2 minus T2.9 · **all 9 enforced invariants** — #8 recipient-evidence is never-cut · T2.6 branch resolution · E3 whole · T4.1, T4.2, T4.5 · T5.1, T5.3, T5.4, T5.5 · T6.1, T6.6, T6.2, T6.3, T6.4, **T6.5 timeline panel (scrubber only is cut)** · T7.1, T7.3, T7.4, T7.5 · E8 whole.

**Cut, in this order:**

| Order | Cut | Why it survives being cut |
|---|---|---|
| 1 | T2.9 suppression rule | Log gets noisy; nothing breaks |
| 2 | T4.3 `kona lint` | Author-time only; §7.2's test still catches the same defects |
| 3 | T4.4 `plan`/`apply` frozen artifact | Approve interactively instead; loses the audit answer, not the function |
| 4 | `kona lint` rules L1–L5 | They catch *plan* defects before approval; the store still blocks every corruption path |
| 5 | T6.5 **version scrubber only** | **The timeline panel ships** — it is the differentiator and `plan.md` lists rationale-on-click as never-cut. Only the scrub-to-version-N control is cut |
| 6 | T7.2 Gmail impl | Mailpit-only demo; fully deterministic |
| 7 | T5.2 authoring skill polish | Hand-author the initial graph for the demo |

**Never cut** (PRD §14, and the probes agree): live topology mutation · rationale-on-click · kill-and-resume · **T6.4 group collapse** (an unreadable graph kills it regardless of correctness) · **T2.6 branch resolution** (without it, v2's dominant silent deadlock returns).

**Quality gates on the cut path:** lint + typecheck only (§7 — coverage and Stryker are optional). If one test suite gets written, it is `validate()`; second is `fold()`.

---

## 9. Gates and dependencies outside the plan

| Gate | Blocks | Owner |
|---|---|---|
| **Q4 — mutator premise** (v3 run, n=60) | Whether E5.3's orchestrator needs a human gate after all, which would contradict §6.9 | pending result |
| **Gmail `+` round-trip** — 5 min manual | T7.2 only; Mailpit path is unaffected | Ilya |
| **AgentMail `+` support** — 5 min | Nothing. Behind the `MailboxProvider` port | Ilya |

**Two known unknowns that only appear during the build:** dispatch wall-clock per subagent (undocumented; sets the pace of T5.3's loop) and viewer readability at ~97 nodes (T6.4's real test). Neither is estimable in advance; both are cheap to fix once seen.


---

## 10. Review corrections (2026-08-21)

A multi-lens review with adversarial verification (`probes/spec-review.md`, 62 raised / 34 survived) changed two things here:

- **T7.1 now depends on `T1.1`, not `T3.2`.** §6.11 defines `MailboxProvider` as `provision / send / poll-thread` — no correlation logic — so a Mailpit port needs the toolchain, not correlation derivation. As written, E7's chain ran to 360 min and **the demo rig, not the CLI spine, gated T8.1**: the real endpoint was 405 min to T8.1 and 435 min to E8, and *every one of the §8 cuts was off the longest path*, so the Friday cut freed zero critical-path minutes. With this one-cell change, W4 starts at ~20 min instead of idling ~4 hours, and the stated 6.1 h spine becomes literally true.
- **T8.1's dependencies are now task-level, not epic-level.** Epic-granularity deps in a task-granularity table silently pulled in cut-listed T7.2.

- **Invariants went 7 → 9 after the v3 probe.** #8 (recipients must be evidenced) and #9 (rationale fidelity, restored) are both non-negotiable: the first is the only thing standing between the mutator and email to people it invented; the second fired on 28% of all v3 firings. T2.4 grows by 30 min.

- **Monorepo (§6.12).** Seven Bun workspace packages plus `plugin/`. The dependency graph enforces two rules the spec previously only asserted: `viewer` cannot import `store` (it depends on `schema` alone), and exactly one package writes bytes. `engine` is pure — no `fs`, no clock — which is what makes the 100% mutation-score target on `validate()` affordable. Costs ~30 min on T1.1 and moves W3/W4's unblock from "a working CLI" to "`schema` compiles".
