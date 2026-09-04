---
name: kona
description: "Read this while you are still working — at your first command or your fortieth, it is never too late and starting late costs nothing. `kona` is a command-line tool already installed here that keeps your plan outside your context window, so a long task does not decay into re-reading files you already read and re-running commands you already ran. You write the steps once and say what each one truly needs before it can start; then `kona next` tells you what is ready instead of you remembering, and it hands you everything that is ready at the same time rather than one thing at a time. Finished steps become terminal and the tool refuses to hand them back. When the work proves the plan wrong, you rewrite the plan and record why. One command starts it — `kona mutate --steps 'first thing' --steps 'second thing'` — and you grow it as you learn."
---

# Kona — the plan lives in a file, not in your context

You are working a long task. Your context will fill, compact, and lose the thread; the
graph will not. `.kona/mutations.jsonl` is the plan, the state, the progress and the reason
for every change, and **every verb below re-reads it fresh** — so losing your place costs
you nothing.

⚖ **The `kona` binary never calls a model.** It answers _what is ready_ and _is this batch
legal_. You answer _what the work is_ and _what the plan should become_. If you catch
yourself tracking state the CLI could track, ask the CLI.

`kona` is on your `PATH`. `.kona/` is already initialised in the working directory.

## 0. The `plan` field in your response is not the plan

Your response format makes you write a `plan` string every turn. That string is scratch: it
dies with the turn, nothing reads it back, and it is not what `kona next` consults. Do not
plan twice. Write the plan into the graph once, then let the `plan` field be a one-line echo
of what `kona next` just told you. When the two disagree, the graph is right.

---

## 1. Author the plan, before doing the work

**Start with one command.** `--steps` takes names and chains them, each depending on the one
before it:

```bash
kona mutate --steps "Read the failing test" --steps "Fix the parser" \
  --base-version 0 --why "Read the failure before changing anything." --reason-code MISSING_STEP
```

That is a whole first commit. It costs about what an `echo` costs, so there is no version of
"I will plan later" that is cheaper than planning now. But **`--steps` chains what you give
it**, and a chain is the one shape that says nothing a to-do list did not already say. Use it
to get off the blank page; author the ops yourself the moment the work has any shape at all,
which is most of the time.

### The nine types, and what each one is for

**Two are behaviour nodes and carry a status plus a behaviour spec.** `action` is a step you
do; `accept_event` is a step the _world_ resolves — a reply or deadline. An action spec has
`instruction`, `effect_class`, and optional inputs/outputs/effect fields. An accept-event spec
adds required `deadline` and `match` fields. This work contacts nobody, so its worked nodes are
actions with `"effect_class":"pure"`.

**Seven are control nodes derived by the store.** A control spec is exactly `"spec":{}`; control
nodes have no status, instruction, or work to do:

|              |                                                                     |
| ------------ | ------------------------------------------------------------------- |
| `initial`    | where the flow starts. Exactly one, ever                            |
| `fork`       | one in, many out — the arms all run **at once**                     |
| `join`       | many in, one out — waits for **all** of them                        |
| `merge`      | many in, one out — **any one** of them is enough                    |
| `decision`   | one in, many out, each arm guarded on what the step before recorded |
| `final`      | the plan is over                                                    |
| `flow_final` | **this path** is over, and the rest of the plan continues           |

The seven behaviour statuses are `inactive`, `ready`, `active`, `completed`, `failed`,
`withdrawn`, and `terminated`. `ready` and `withdrawn` are store-derived. Only `completed`
satisfies a downstream edge; `completed`, `failed`, `withdrawn`, and `terminated` are terminal.

`kona next` returns ready `action` nodes only. It never returns an `accept_event`: external
events are polled with `kona poll` and deadlines are resolved with `kona resume`.

A `decision` routes every arm with a `guard`. Exactly one arm must be the explicit fallback
`"guard":"else"`; omitting `guard` is not an else arm. Other arms use forms such as
`"guard":{"on":"confirmed"}` or `"guard":{"on":"timeout"}`.

**An `action` has exactly one in-edge and exactly one out-edge.** That single rule is what
decides the shape of everything you author: you cannot hang a second step off a step, so two
things happening at once is never something you leave implicit. You draw it — a `fork` where
the work splits, and a `join` (I need both) or a `merge` (either will do) where it comes back
together.

### An edge is a claim about what must be true first — not the order you intend to work

This is the single most common way a plan comes out wrong. Ask of every edge: _does the target
actually need the source to be finished?_ If the honest answer is "no, I just planned to do it
afterwards", there is no edge — those two steps belong on the arms of a fork.

Here is a whole first plan, in one batch. **Copy this shape, not the chain above.**

```bash
cat > /tmp/plan.json <<'EOF'
[
  {"op":"add_node","name":"Start","type":"initial","spec":{}},
  {"op":"add_node","name":"Read both systems at once","type":"fork","spec":{}},
  {"op":"add_node","name":"Read the ERP tables","type":"action",
   "spec":{"instruction":"Dump the work orders and the SKU lines.","effect_class":"pure",
           "outputs":[{"name":"orders","type":"string[]"}]}},
  {"op":"add_node","name":"Read the MES queue","type":"action",
   "spec":{"instruction":"Dump the dispatch queue and the WIP rows.","effect_class":"pure",
           "outputs":[{"name":"queue","type":"string[]"}]}},
  {"op":"add_node","name":"Both reads are in","type":"join","spec":{}},
  {"op":"add_node","name":"Build the schedule","type":"action",
   "spec":{"instruction":"Place every released order inside its window.","effect_class":"pure",
           "outputs":[{"name":"schedule","type":"string"}]}},
  {"op":"add_node","name":"The schedule stands","type":"final","spec":{}},
  {"op":"add_edge","from":"$0","to":"$1"},
  {"op":"add_edge","from":"$1","to":"$2"},
  {"op":"add_edge","from":"$1","to":"$3"},
  {"op":"add_edge","from":"$2","to":"$4"},
  {"op":"add_edge","from":"$3","to":"$4"},
  {"op":"add_edge","from":"$4","to":"$5"},
  {"op":"add_edge","from":"$5","to":"$6"}
]
EOF
kona mutate --ops /tmp/plan.json --base-version 0 \
  --why "The two reads do not need each other, so they are one fork." --reason-code MISSING_STEP
```

Read what that says. The two reads happen **at the same time** — `kona next` hands you both,
and you work both before you come back. The schedule waits for **both**, because the join is
where "I need all of these" lives. Had those two been chained, the plan would have claimed
something false — that you cannot read the MES until you have read the ERP — and you would
have worked them one at a time for no reason.

`$0`, `$1` … refer to nodes minted earlier **in the same batch**, and only earlier: a forward
reference is refused. An edge `from A to B` means **B depends on A**. `--why` is required: no
rationale, no commit.

**Three rules that batch obeys, and every batch must.**

- **One `initial`, and everything reachable from it.** A node nothing leads to is refused
  (`UNREACHABLE_NODE`), so there is no such thing as a step you added and forgot to wire in.
- **Terminate every branch.** Every node must reach a `final` or a `flow_final`, or the batch
  is refused (`DEAD_END`). A branch that just stops is a plan that quietly never finishes, and
  the store would rather refuse it now than let you discover it at the end.
- **Nothing loops.** A backward edge is refused (`CYCLE`). Iteration is expressed by adding
  nodes later, which is what §4 is for and is the normal case.

**Your first commit does not have to be the whole plan, and it does not have to be first.**
Two actions between an `initial` and a `final` is a plan — commit it before you know the rest,
and commit it even if you are already twenty commands in. Recording what you have learned so
far is worth more than the plan you would have written at the start. §4 is how the remainder
arrives, and it is the normal case, not a fallback. Waiting until you can see the whole
decomposition is how you end up never starting.

## 2. Ask what is ready — never decide for yourself

```bash
kona next --json
kona brief <node-id>
```

`kona next` is the **only** source of work, and it returns the **whole frontier, not one
node**. If it hands you three, the plan is saying all three are ready right now — that is the
fork you drew, saying so — and working them one at a time throws away the only claim the plan
makes about concurrency. `brief` exits non-zero when a node is not dispatchable; that is a
refusal, not advice.

Ids are minted by the store — `kn-a1b2`, not a slug of the name. Copy them out of `kona next`
or `kona graph --json`; never guess one or invent one.

**Claim it before you start**, so the plan says what is being worked and not merely what is
ready — and so `kona next` stops offering it to you:

```bash
printf '[{"op":"set_status","node":"<node-id>","status":"active","evidence_ref":"claim"}]' > /tmp/claim.json
kona mutate --ops /tmp/claim.json --base-version <head> --why "Starting this step." --reason-code OTHER
```

Then do the node's work with your normal tools. If you never come back, `kona resume` puts it
back on the frontier — nothing was sent, so nothing needs a human.

## 3. Record what happened

```bash
cat > /tmp/done.json <<'EOF'
[
  {"op":"record_output","node":"<node-id>","output_name":"orders",
   "value":["WO-1141","WO-1142"],"evidence_ref":"erp-dump.log"},
  {"op":"set_status","node":"<node-id>","status":"completed","evidence_ref":"erp-dump.log"}
]
EOF
kona mutate --ops /tmp/done.json --base-version <head> --why "The ERP dump is in." --reason-code OTHER
```

`evidence_ref` is what you actually looked at — a file, a log, a command. `output_name` must be
one the node **declared**. `completed` is **terminal**: the store refuses to reopen it, and it
is the only state that satisfies the edge out of it, so record it only when it is really done.

## 4. Change the plan — automatically, and say why

This is the part that matters. When the work tells you something the plan did not know —
a dependency you missed, a premise that broke, a branch that turned out to be pointless —
**change the graph**. You do not ask permission.

**Growing a plan means replacing a node, not appending to one.** Every `action` already holds
its one out-edge, so an `add_edge` off a step that is already wired is refused with `ARITY`.
The sanctioned move is to supersede the node and commit what replaces it, wired to that node's
neighbours, **in the same batch**:

```bash
cat > /tmp/replan.json <<'EOF'
[
  {"op":"add_node","name":"Two queries at once","type":"fork","spec":{}},
  {"op":"add_node","name":"Write the ERP query","type":"action",
   "spec":{"instruction":"Select the released work orders.","effect_class":"pure"}},
  {"op":"add_node","name":"Write the MES query","type":"action",
   "spec":{"instruction":"Select the dispatch queue.","effect_class":"pure"}},
  {"op":"add_node","name":"Both queries written","type":"join","spec":{}},
  {"op":"supersede_node","node":"<the placeholder>","by":"$0"},
  {"op":"add_edge","from":"<its predecessor>","to":"$0"},
  {"op":"add_edge","from":"$0","to":"$1"},
  {"op":"add_edge","from":"$0","to":"$2"},
  {"op":"add_edge","from":"$1","to":"$3"},
  {"op":"add_edge","from":"$2","to":"$3"},
  {"op":"add_edge","from":"$3","to":"<its successor>"}
]
EOF
kona mutate --ops /tmp/replan.json --base-version <head> \
  --why "The work is two independent queries, not one step." --reason-code MISSING_STEP
```

**A supersede with nothing wired in its place abandons the whole tail of the plan.** The store
withdraws everything that can no longer be reached, so retiring a node in the middle and
stopping there does not leave a gap — it deletes the rest. Commit the replacement in the same
batch.

`--reason-code` is one of `COUNTERPARTY_DECLINED` · `DEADLINE_PASSED` · `NEW_CONSTRAINT` ·
`MISSING_STEP` · `QUORUM_MET` · `CONTRADICTION` · `WITHDRAWN` · `OTHER` — anything else is
refused. `--alternative` records what you considered and rejected. The same batch again, when
the reason is that a premise broke rather than that a step was missing:

```bash
kona mutate --ops /tmp/replan.json --base-version <head> \
  --why "The parser is fine; the fixture is stale, so fixing the parser cannot help." \
  --reason-code CONTRADICTION --alternative "patch the parser anyway"
```

On exit code `3` the head moved: **re-read the graph and re-decide**, never resubmit the same
batch.

## 5. Stop when

`kona next` returns nothing and the plan reached its `final`. An empty frontier on its own is
not the same thing — it also happens when a branch was abandoned or a step failed, and
`kona graph` says which. If the plan is simply wrong, §4 applies and you keep going.

---

## What not to do

- **Do not write a chain by reflex.** A plan that is one long line is usually claiming
  dependencies that are not real. Check every edge by asking whether the target genuinely needs
  the source; what is left over goes on the arms of a fork.
- **Do not work the frontier one node at a time.** `kona next` returning three nodes means the
  plan says all three are ready now.
- **Do not keep a to-do list.** `kona next` is the only source of work. A list in your head
  goes stale the moment the graph changes, and the graph changes constantly.
- **Do not re-derive readiness.** If it is not in `kona next`, it is not ready — even if it
  looks ready to you.
- **Do not re-do anything.** A node recorded `completed` is terminal and the CLI will refuse to
  reopen it. If you want to, read `kona brief` and believe it.
- **Do not invent an id.** Ids are minted by the store; copy them from `kona next` or
  `kona graph --json`.
- **Do not batch unrelated events.** One thing learned, one commit. It keeps the rationale
  chain readable.
