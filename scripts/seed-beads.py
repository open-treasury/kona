#!/usr/bin/env python3
"""Seed the Kona beads tracker from docs/plan.md.

Drives `br create` / `br dep add` — never writes .beads/issues.jsonl directly.
Rebuild from scratch:  rm -rf .beads && br init && python3 scripts/seed-beads.py
"""
import json, subprocess, sys, tempfile, os

def br(*args, desc=None):
    """Run br, optionally passing a multi-line description via a temp file."""
    argv = ["br", *args]
    tmp = None
    if desc is not None:
        tmp = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False)
        tmp.write(desc); tmp.close()
        argv += ["--description-file", tmp.name]
    argv += ["--json"]
    r = subprocess.run(argv, capture_output=True, text=True)
    if tmp: os.unlink(tmp.name)
    if r.returncode != 0:
        sys.exit(f"FAILED: {' '.join(argv)}\n{r.stderr}\n{r.stdout}")
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return {"raw": r.stdout.strip()}

def issue_id(res):
    for k in ("id", "issue_id"):
        if isinstance(res, dict) and k in res: return res[k]
    d = res.get("data") or res.get("issue") or {}
    if isinstance(d, dict):
        for k in ("id", "issue_id"):
            if k in d: return d[k]
    sys.exit(f"could not find an id in br output: {res}")

# ── epics ────────────────────────────────────────────────────────────────────
EPICS = [
 ("E1","Graph store core — types, on-disk layout, fold",0,
  "The substrate. Everything blocks on this and nothing in it is optional.\n\n"
  "**Gate:** `rm .kona/graph.json` -> the next command rebuilds it byte-identically. "
  "That single test proves the architecture.\n\nspec.md §6.1, §6.2, §6.12 · 10.5h human / 2.75h AI"),
 ("E2","Mutation engine — 11 ops, 9 invariants, CAS",0,
  "The code that stands between the LLM and the file. Builds a candidate graph in memory, "
  "checks every invariant, and only then touches disk — so a bad batch is never half-applied.\n\n"
  "Carries every probe finding. T2.6 is never-cut.\n\nspec.md §6.4, §6.7 · 20h human / 5.05h AI"),
 ("E3","Wait & effect engine — waits, outbox, resume",0,
  "Where the \"nobody who can rewrite their own plan has a clock or a counterparty\" claim actually lives.\n\n"
  "**Gate:** `kill -9` mid-send -> resume finds `sending`, re-sends nothing, surfaces it for a human.\n\n"
  "spec.md §6.5, §6.6, §6.7.4 · 17h human / 4.3h AI"),
 ("E4","CLI surface — 17 verbs, brief, lint",1,
  "The one interface every other block builds against. Nothing outside the CLI reads or writes `.kona/`.\n\n"
  "spec.md §6.8, §6.8.1 · 13.5h human / 3.3h AI"),
 ("E5","Claude Code plugin — orchestrator + executor",1,
  "Harness constraints verified 2026-08-21: subagents get genuinely fresh context, 20 concurrent max, "
  "`bin/` is auto-added to PATH, `SessionStart` can run `kona resume`, no plugin-managed server.\n\n"
  "spec.md §6.9 · 12.5h human / 3.2h AI"),
 ("E6","Viewer — React Flow + dagre, read-only",1,
  "Holds zero authoritative state. Reads only `kona graph --json`. The anti-spaghetti rules are "
  "demo-critical, not polish.\n\nspec.md §6.10 · 15.5h human / 3.9h AI"),
 ("E7","Demo rig — mailbox, personas, divergence",2,
  "One plus-addressed Gmail plus a persona sender, $0. Mailpit is the offline fallback behind the "
  "same port.\n\nspec.md §6.11 · 10.5h human / 2.7h AI"),
 ("E8","Integration & rehearsal",1,
  "One full pursuit end-to-end, the divergent-arms acceptance test, and kill-resume rehearsed twice.\n\n"
  "spec.md §7.2 · 7h human / 1.75h AI"),
]

# ── tickets: (key, epic, title, priority, cx, hours, deps, cut, body) ────────
T = [
 # E1
 ("T1.1","E1","Monorepo scaffold — Bun workspace, 7 packages",0,"M","1.5h / 30m",[], None,
  "Bun workspace per spec §6.12: schema, engine, store, effects, cli, viewer, demo + plugin/.\n"
  "tsconfig strict + project refs, lint, test runner, and a cycle check that fails `bun run build`.\n\n"
  "**Done when:** every package builds, no cycles, `bun run lint` and `typecheck` clean."),
 ("T1.2","E1","packages/schema — node types, edges, deadlines",0,"M","2h / 30m",["T1.1"], None,
  "6 node types, 4+4 edge kinds, the edge record `{id,from,to,kind,condition?,created_by_version}`, "
  "`status`/`outcome`/`output`, typed deadlines in 3 shapes.\n\n"
  "**Zero dependencies — this is what unblocks W3 and W4.**\n\n"
  "**Done when:** viewer and demo can import types without touching store."),
 ("T1.3","E1","`.kona/` init + network-filesystem refusal",1,"S","1.5h / 25m",["T1.2"], None,
  "Create the dot-dir, write `schema_version`, refuse to run on a network filesystem "
  "(WAL/rename semantics corrupt on Dropbox/iCloud/NFS)."),
 ("T1.4","E1","fold(mutations) -> graph — pure, torn-line tolerant",0,"L","3h / 45m",["T1.2"], None,
  "Pure and deterministic. Full fold must equal snapshot+tail. Tolerates a truncated final line "
  "(torn write) and an unknown node type (partial-tolerant loader).\n\n"
  "**Folding is not replay** — it is a pure function over data and executes nothing.\n\n"
  "Second-highest Stryker target after validate()."),
 ("T1.5","E1","graph.json materialization — temp + atomic rename",0,"M","2h / 30m",["T1.4"], None,
  "Write-temp then atomic rename, head check, rebuild-on-mismatch. No partially-written graph is "
  "ever observable on disk."),
 ("T1.6","E1","blobs/ — content-addressed store",2,"S","1h / 15m",["T1.3"], None,
  "sha256-addressed. Node payloads hold handles and summaries, never bodies — the graph must stay "
  "small enough for an LLM to re-read whole on resume."),
 # E2
 ("T2.1","E2","The 11 ops — apply functions, fixed internal order",0,"L","4h / 1h",["T1.4"], None,
  "add_node · add_edge · fan_out · reroute_edge · set_status · record_outcome · record_output · "
  "supersede_node · add_wait · insert_compensation · resolve_gate.\n\n"
  "Internal order: additions and rewires BEFORE cancellations (Zeebe). A batch violating that order "
  "is rejected, never silently reordered.\n\n"
  "No `delete_node`. No `rollback` opcode, not even reserved."),
 ("T2.2","E2","Symbolic intra-batch references ($0, $2.children.dana)",0,"M","2h / 30m",["T2.1"], None,
  "Ops return ids; a batch is static JSON. Positional symbols resolve at commit; forward and "
  "unresolved refs are rejected. Client-assigned ids are forbidden.\n\n"
  "Probe evidence: 9/10 scenarios fabricated ids before this existed; 20/20 used symbols after."),
 ("T2.3","E2","Auto-wiring per op (the §6.4 table)",0,"M","2h / 30m",["T2.1"], None,
  "Each op's implicit edges, stated and implemented exactly. Ambiguity here caused every orphan in "
  "the v2 probe and all five invariant-3 firings."),
 ("T2.4","E2","The 9 enforced invariants + CAS check",0,"L","3.5h / 50m",["T2.1"], None,
  "1 schema (incl. edges) · 2 no cycles · 3 reachability both ways · 4 wait/gate deadline+timeout · "
  "5 terminal & effect protection (OP-DELTA, pre-commit) · 6 quorum satisfiable · 7 effect budget · "
  "8 recipients must be evidenced · 9 rationale fidelity.\n\n"
  "**#8 is the highest-value check in the codebase** — it is what stops the mutator inventing people "
  "to email. **#5 is an op-delta predicate**, not a post-state scan; as a state predicate it rejected "
  "every commit once any node reached `done`.\n\n"
  "Stryker target: 100."),
 ("T2.6","E2","Branch resolution — store drops untaken branches",0,"L","3h / 45m",["T2.1"], None,
  "**NEVER CUT.** On terminal resolution the store marks untaken branch targets `dropped`, "
  "transitively, stopping at any node still held by a live blocking in-edge. An in-edge whose SOURCE "
  "is dropped is excluded from merge evaluation.\n\n"
  "Readiness fails safe and does NOT inherit the exclusion — otherwise the second node on an untaken "
  "branch has no blocker, lands on the frontier, and gets dispatched.\n\n"
  "Without this, v2's dominant silent deadlock returns."),
 ("T2.7","E2","flock + compare-and-swap on parent_v",0,"M","2h / 30m",["T1.5"], None,
  "Exit 3 + `STALE_BASE_VERSION` + current head on mismatch. Re-read and re-decide, never blind-merge.\n\n"
  "Beads #5898: 54 cross-actor overwrites, median 31 min apart — the enemy is hand-offs, not races."),
 ("T2.8","E2","Mutation record write — rationale required",0,"S","1.5h / 25m",["T2.7"], None,
  "`--why` is a required argument. `outcome` starts null and is filled later on evidence. "
  "Bi-temporal stamps (`observed_at`/`occurred_at`) are engine-set, never LLM-set."),
 ("T2.9","E2","Suppression rule — semantic hash, no-op on unchanged",3,"M","2h / 30m",["T2.8"], 1,
  "**Cut-order 1.** A re-plan producing a semantically equal fragment writes no version. "
  "Without it the log fills with \"the agent thought about it again\"."),
 # E3
 ("T3.1","E3","Wait schema — or-group conditions, deadline evaluation",0,"L","3h / 45m",["T2.1"], None,
  "First-wins or-group. `deadline` non-nullable, `on_timeout` required. Four-way resolution "
  "(satisfied|timeout|bounced|superseded). `last_checked_at` so the viewer can tell patient from stuck.\n\n"
  "Plus the three states retry never converged on: late reply, tentative, quorum-met bulk."),
 ("T3.2","E3","Correlation derivation + inbound matching",0,"L","3h / 45m",["T3.1"], None,
  "`ilya+kona-<node_id>@…` in Kona's own Reply-To. First-match-wins routing, dedupe on provider "
  "message-id. Two independent correlation keys: the plus-tag and In-Reply-To.\n\n"
  "Reconciliation against a durable cursor is the source of truth; webhooks are a latency optimisation."),
 ("T3.3","E3","Outbox — reserve, fsync, send, record",0,"L","3h / 45m",["T2.8"], None,
  "`effect_key = hash(node_id, created_by_version)` — **payload-independent by design**. "
  "`payload_hash` computed at reserve. Same key + different payload_hash = loud error, never a second send.\n\n"
  "Three crash windows: before fsync (safe), fsync-to-send (safe to retry), "
  "**send-to-record (must ask a human)** — the one everybody forgets and every demo hits.\n\n"
  "Stryker target: 100."),
 ("T3.4","E3","Effect ledger + budget enforcement",1,"S","1.5h / 25m",["T3.3"], None,
  "Invariant 7's circuit breaker. Budget total/consumed/reserved/remaining, visible in `kona brief`."),
 ("T3.5","E3","Leases + `kona next` eligibility",0,"M","2.5h / 40m",["T2.7"], None,
  "`O_EXCL`/atomic rename, TTL, reclaim on expiry. Subagents never pick their own node — the CLI "
  "hands out the eligible set. This is the only mechanism stopping two agents emailing the same person.\n\n"
  "Must never return an uninstantiated branch template inside an unexpanded group."),
 ("T3.6","E3","`kona resume` — reconcile then repair",0,"L","4h / 1h",["T3.1","T3.3"], None,
  "Six steps: fold, verify head, fire overdue timeouts, reconcile waits against the world, expire "
  "stale leases, report `sending` unknowns. **Each repair is itself a logged mutation with a rationale.**\n\n"
  "Never re-executes a `done` node. Enforced in the store, not in a prompt."),
 # E4
 ("T4.1","E4","Verb scaffolding, --json, exit codes",0,"M","2h / 30m",["T1.3"], None,
  "Exit status is 8-bit: 0 ok · 1 refused · 3 stale · 4 invariant · 5 leased, each with a symbolic "
  "reason code on stderr. `409` would truncate to `153`."),
 ("T4.2","E4","`kona brief` — the 9 required blocks",0,"L","4h / 1h",["T3.1","T2.4"], None,
  "resolved_inputs · node_status+gate_decisions (incl. `approved_payload`) · recipient · identity · "
  "correlation · time · effect_ledger · disclosable · preconditions_satisfied.\n\n"
  "**Returns all nine or refuses.** `preconditions_satisfied` FAILS CLOSED — in the v2 probe it read "
  "true while an input was UNRESOLVED.\n\n"
  "Probe: 0/8 executable before, 10/10 after."),
 ("T4.3","E4","`kona lint` — 11 author-time rules + L1-L4",2,"L","3.5h / 50m",["T2.4"], 2,
  "**Cut-order 2.** Runs before a human is asked to approve. Carries the checks moved down from the "
  "invariant set: merge declared, refs resolve, effects complete and funded, liveness.\n\n"
  "Never trust a self-reported lint pass — `kona validate` is the gate."),
 ("T4.4","E4","`kona plan` / `apply` — frozen content-hashed artifact",2,"M","2h / 30m",["T2.4"], 3,
  "**Cut-order 3.** Passing the artifact IS the approval (Terraform). Execution consumes that object "
  "and must not re-derive or re-prompt."),
 ("T4.5","E4","`kona status` / `history` / `why`",1,"M","2h / 30m",["T4.1"], None,
  "Five hardcoded queries, no query language: ready nodes, blocked-on-wait, waits past deadline, "
  "recent mutations, rationale chain."),
 # E5
 ("T5.1","E5","Plugin skeleton — manifest, bin/, hooks/",1,"S","1.5h / 25m",["T4.1"], None,
  "`.claude-plugin/plugin.json`, `bin/` (auto-added to PATH, so the plugin IS the distribution), "
  "`hooks/hooks.json`. Additive and trivially removable — no git hooks, no daemon, no writes to "
  "`~/.claude/settings.json`."),
 ("T5.2","E5","`/kona:plan` authoring skill",2,"L","3h / 45m",["T4.4"], 7,
  "**Cut-order 7.** Ships the §6.2 catalogue VERBATIM (three probe trials believed `gate` has no "
  "deadline field). States the annotating-edge direction convention as loudly as the blocking one. "
  "Requires a premise check, a worst-case pivot count vs budget, and a <=10-line plain-language header."),
 ("T5.3","E5","`/kona:run` orchestrator loop + the new-counterparty gate",0,"L","4h / 1h",["T4.2","T3.5"], None,
  "read -> dispatch -> merge, one macro-step per external event. Only the orchestrator mutates topology.\n\n"
  "**Carries the single §6.9 gate:** a mutation creating a new irreversible effect to a recipient not "
  "already evidenced in the graph. Everything else commits automatically.\n\n"
  "Subagents are for judgment, not execution — 30 templated sends do not need 30 subagents."),
 ("T5.4","E5","Executor subagent skill",0,"L","3h / 45m",["T4.2"], None,
  "Consumes `kona brief`. Returns EXECUTED (bytes moved) | COMPOSED (payload ready, not dispatched) | "
  "REFUSED (with `refusal_reason` mandatory).\n\n"
  "Context is a subgraph walk, never a transcript."),
 ("T5.5","E5","SessionStart hook -> `kona resume`",1,"S","1h / 15m",["T3.6"], None,
  "Verified available. Makes the kill-and-resume beat automatic — you do not type `continue`, "
  "it reconciles and reports."),
 # E6
 ("T6.1","E6","Viewer scaffold — Vite, React, @xyflow/react",1,"M","2.5h / 40m",["T1.2"], None,
  "Fully controlled mode; the file always wins. Poll/SSE on `kona graph --json` — the one supported "
  "read contract. Zero authoritative state. **User-started (`kona view`), never plugin-spawned.**"),
 ("T6.6","E6","Diff animation prototype — BUILD THIS FIRST",1,"M","2h / 30m",["T6.1"], None,
  "§6.10 rule 16. File change -> re-layout -> tween -> flash the new subtree. Kona's core claim is "
  "only *visible* if the viewer shows topology changing. Build it before styling anything."),
 ("T6.2","E6","Node types + inline state rendering",1,"L","3h / 45m",["T6.1"], None,
  "Status chip, wait predicate, deadline countdown, quorum counter, and for a blocked node **the "
  "reason as text**. Dify's biggest UX complaint is having to leave the graph to see what happened.\n\n"
  "Three-colour wait state: fulfilled / awaiting-within-deadline / deadline-blown."),
 ("T6.3","E6","dagre layout memoized on graph_version",0,"M","2h / 30m",["T6.1"], None,
  "Positions derived every version, never stored. **Re-layout only on topology change, never on a "
  "status tick** — Burr #834 froze this exact view until July 2026, and the fan-out moment is where "
  "it bites."),
 ("T6.4","E6","Group collapse + edge redirection to container",0,"L","3h / 45m",["T6.3"], None,
  "**NEVER CUT.** One container node with an aggregate status, edges from hidden children redirected "
  "to it. Thirty naked arms read as chaos, not intelligence (R2).\n\n"
  "Lay out flat and draw group boxes from child bounds — not React Flow sub-flows (#3393)."),
 ("T6.5a","E6","Rationale timeline panel",0,"M","2h / 30m",["T6.2"], None,
  "**NEVER CUT.** Version + op + rationale, newest first. This panel, not the canvas, is the "
  "differentiator — nothing in the tracing category can show it because they have nothing to show it from."),
 ("T6.5b","E6","Version scrubber",3,"S","1h / 15m",["T6.5a"], 5,
  "**Cut-order 5.** Read-only time travel through the record. Must look nothing like undo — "
  "explicitly not React Flow Pro's Undo/Redo, explicitly not Kestra's revert-to-revision."),
 # E7
 ("T7.1","E7","MailboxProvider port + Mailpit implementation",1,"M","2.5h / 40m",["T1.1"], None,
  "`provision / send / poll-thread`. Depends on the toolchain only — **not on correlation logic**, "
  "which is what previously made the demo rig gate integration.\n\n"
  "Mailpit is deterministic, offline, free and zero stage risk."),
 ("T7.2","E7","Gmail plus-addressing implementation",2,"M","2h / 30m",["T7.1"], 6,
  "**Cut-order 6.** Two ordinary Gmail accounts, $0. Aliases are capped (~30/user); "
  "**plus-addressing is uncapped** and we need ~31 tags and zero aliases."),
 ("T7.3","E7","Persona generation + reply simulator",1,"L","3h / 45m",["T7.1"], None,
  "Thirty players plus a rival captain. Distinct From: display names, varied bodies so 30 near-identical "
  "messages do not trip bulk heuristics."),
 ("T7.4","E7","Divergence script — Priya / Pat / Sam->Marcus",0,"M","2h / 30m",["T7.3"], None,
  "The beat that answers the `withParam` objection. Priya conditional (grows a constraint node reaching "
  "into the rival-captain sub-flow) · Pat silent (the deliberately boring control) · **Sam refers Marcus, "
  "who is not on the roster** — the recovery from Dana's withdrawal.\n\n"
  "Feeds T8.2's assertions."),
 ("T7.5","E7","`kona event add` injection path",1,"S","1h / 15m",["T4.1"], None,
  "Doubles as the live-failure fallback for every external hop (R5)."),
 # E8
 ("T8.1","E8","One full pursuit end-to-end",0,"L","3h / 45m",["T5.3","T5.4","T7.1","T7.4","T7.5"], None,
  "Brief -> authored graph -> approve -> fan out -> replies -> premise break -> recovery -> done."),
 ("T8.2","E8","Divergent-arms acceptance test",0,"M","2h / 30m",["T8.1"], None,
  "**The end-to-end acceptance test for the whole product claim.** From a v1 plan where every arm is "
  "identical, assert: (a) a node whose template_id appears nowhere in v1; (b) a counterparty whose "
  "instance_key was not in the v1 roster; (c) three arms with pairwise different node counts; "
  "(d) an arm with an edge leaving its own group.\n\n"
  "Pass and the run produced structure no parameterised fan-out could. Fail and the system behaved as "
  "`withParam` regardless of how the code is written."),
 ("T8.3","E8","Kill-and-resume rehearsed twice",0,"M","2h / 30m",["T8.1"], None,
  "`kill -9` mid-pursuit and mid-send. Fresh terminal states pursuit status in <60s with no session "
  "state, re-sends nothing, and surfaces `sending` unknowns for a human."),
]

def main():
    print("seeding kona beads…\n")
    eid, tid = {}, {}

    for key, title, prio, body in EPICS:
        r = br("create", f"{key} — {title}", "-t", "epic", "-p", f"P{prio}",
               "-l", f"{key},epic", "--slug", key.lower(), desc=body)
        eid[key] = issue_id(r)
        print(f"  epic  {eid[key]:<28} {key} — {title}")

    print()
    for key, epic, title, prio, cx, hours, deps, cut, body in T:
        labels = [epic, "feature", f"cx-{cx}"]
        labels.append(f"cut-{cut}" if cut else "ship")
        full = f"{body}\n\n---\n**Effort:** {hours} · **Epic:** {epic} · **Spec:** docs/spec.md · **Plan:** docs/plan.md {key}"
        r = br("create", f"{key} — {title}", "-t", "task", "-p", f"P{prio}",
               "-l", ",".join(labels), "--parent", eid[epic],
               "--slug", key.lower().replace(".", "-"), desc=full)
        tid[key] = issue_id(r)
        print(f"  task  {tid[key]:<28} {key} — {title}")

    print()
    n = 0
    for key, epic, *_rest in ((t[0], t[1], t) for t in T):
        pass
    for row in T:
        key, deps = row[0], row[6]
        for d in deps:
            br("dep", "add", tid[key], tid[d], "-t", "blocks")
            n += 1
    print(f"  {n} blocking dependencies wired\n")

    print("done. next:  br ready")

if __name__ == "__main__":
    main()
