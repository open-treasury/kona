---
name: kona
description: "Read this before you start work on any task needing more than about five steps. `kona` is a command-line tool already installed here that keeps your plan outside your context window, so a long task does not decay into re-reading files you already read and re-running commands you already ran. You write the steps and their dependencies once, then run `kona next` to be told what is ready instead of remembering; finished steps become terminal and the tool refuses to hand them back. When the work proves the plan wrong, you rewrite the plan and record why. Costs one command to start."
---

# Kona — the plan lives in a file, not in your context

You are working a long task. Your context will fill, compact, and lose the thread; the
graph will not. `.kona/mutations.jsonl` is the plan, the state, the progress and the reason
for every change, and **every verb below re-reads it fresh** — so losing your place costs
you nothing.

⚖ **The `kona` binary never calls a model.** It answers *what is ready* and *is this batch
legal*. You answer *what the work is* and *what the plan should become*. If you catch
yourself tracking state the CLI could track, ask the CLI.

`kona` is on your `PATH`. `.kona/` is already initialised in the working directory.

---

## 1. Author the plan, before doing the work

Decompose the task into nodes with dependencies. Every node is `"type":"task"` and
`"effect_class":"pure"` — nothing here contacts anybody.

```bash
cat > /tmp/v1.json <<'EOF'
[
  {"op":"add_node","label":"Read the failing test","type":"task",
   "spec":{"instruction":"Run the suite and record which assertions fail.",
           "outputs":[{"name":"failures","type":"string[]"}],"effect_class":"pure"}},
  {"op":"add_node","label":"Fix the parser","type":"task",
   "spec":{"instruction":"Make the failing assertions pass without changing the tests.",
           "outputs":[{"name":"patch","type":"string"}],"effect_class":"pure"}},
  {"op":"add_edge","from":"$0","to":"$1"}
]
EOF
kona mutate --ops /tmp/v1.json --base-version 0 \
  --why "Read the failure before changing anything." --reason-code MISSING_STEP
```

`$0`, `$1` … refer to nodes minted earlier **in the same batch**. An edge `from A to B`
means **B depends on A**. `--why` is required: no rationale, no commit.

## 2. Ask what is ready — never decide for yourself

```bash
kona next --json
kona brief <node-id>
```

`kona next` is the **only** source of work. `brief` exits non-zero when a node is not
dispatchable; that is a refusal, not advice. Do the node's work with your normal tools.

## 3. Record what happened

```bash
cat > /tmp/done.json <<'EOF'
[
  {"op":"record_output","node":"read-the-failing-test","output_name":"failures",
   "value":["test_parse_empty"],"evidence_ref":"pytest.log"},
  {"op":"set_status","node":"read-the-failing-test","status":"done",
   "evidence_ref":"pytest.log"}
]
EOF
kona mutate --ops /tmp/done.json --base-version <head> --why "Suite run; one assertion fails." --reason-code OTHER
```

`evidence_ref` is what you actually looked at — a file, a log, a command. A done node is
**terminal**: the store refuses to reopen it, so record it only when it is really done.

## 4. Change the plan — automatically, and say why

This is the part that matters. When the work tells you something the plan did not know —
a dependency you missed, a premise that broke, a branch that turned out to be pointless —
**change the graph**. You do not ask permission.

```bash
kona mutate --ops /tmp/replan.json --base-version <head> \
  --why "The parser is fine; the fixture is stale, so fixing the parser cannot help" \
  --reason-code PREMISE_BROKEN --alternative "patch the parser anyway"
```

Use `supersede_node` to retire a node whose premise is gone, `add_node`/`add_edge` to grow
the plan. On exit code `3` the head moved: **re-read the graph and re-decide**, never
resubmit the same batch.

## 5. Stop when

`kona next` returns nothing. That means the plan is complete — or the plan is wrong, in
which case step 4 applies and you keep going.

---

## What not to do

- **Do not keep a to-do list.** `kona next` is the only source of work. A list in your head
  goes stale the moment the graph changes, and the graph changes constantly.
- **Do not re-derive readiness.** If it is not in `kona next`, it is not ready — even if it
  looks ready to you.
- **Do not re-do anything.** A node recorded `done` is terminal and the CLI will refuse to
  reopen it. If you want to, read `kona brief` and believe it.
- **Do not batch unrelated events.** One thing learned, one commit. It keeps the rationale
  chain readable.
