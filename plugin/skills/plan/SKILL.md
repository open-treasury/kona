---
name: plan
description: Author a Kona pursuit graph from a plain-language brief — a batch of typed ops the CLI validates before anything is committed. Use when the user describes a goal that needs multiple steps, several people, or waiting on replies.
argument-hint: <what you are trying to get done>
---

# Authoring a pursuit

You are turning a goal into a **graph of typed operations**. The `kona` CLI validates the
batch and refuses anything malformed — you never write the log yourself.

`$ARGUMENTS` is the brief.

---

## 0. Check the premises first, before you author anything

**This is the step most likely to be skipped, and skipping it is the most likely way this
goes wrong.** In measured runs, 2 of 4 briefs referenced entities that did not exist — a
roster, a mailbox, a person — and every single run produced a confident, approvable graph
anyway. Nothing downstream catches it. The graph is well-formed; it is just about a world
that isn't there.

So, out loud, before any ops:

1. **List every entity the brief assumes** — every person, list, document, address,
   deadline, and system.
2. **Say which of them you have actually seen**, and where.
3. **Ask the user about the rest.** Do not proceed on the unverified ones.

If the brief says "email the goalies on the roster", you need to know what the roster _is_
and where it lives. "I'll look it up later" is how a pursuit ends up addressing people who
do not exist.

---

## 1. The op catalogue

These six are the entire vocabulary. There is no seventh, and no opcode is reserved for
one. Write a JSON **array** of them.

```jsonc
// ── add_node ── the only op that creates anything. Returns $N, its index in the array.
//
// NINE types, in two families. The family decides what the node carries, and getting it
// wrong is the commonest way a batch is refused.
//
//   BEHAVIOUR            action        a step an executor does
//   (status + spec)      accept_event  a step the WORLD resolves — a reply or deadline
//
//   CONTROL              initial       where the flow starts. Exactly one, ever.
//   (spec: {} and        decision      one in, many out, every out-edge explicitly guarded
//    no status)          merge         many in, one out. ANY of them is enough
//                       join          many in, one out. ALL of them are needed
//                       fork          one in, many out. All arms run at once
//                       final         the pursuit is over
//                       flow_final    THIS PATH is over, and the pursuit continues

// An action behaviour spec:
{
  "op": "add_node",
  "name": "Ask Dana to play Thursday",   // REQUIRED. The id is minted from this.
  "type": "action",
  "spec": {
    "instruction": "Email Dana asking if she can play in goal Thursday.",  // REQUIRED
    "effect_class": "pivot",              // REQUIRED. pure | reversible | compensatable | pivot
    "inputs":  [{ "ref": "confirm-roster.availability" }],   // <node-id>.<output-name>
    "outputs": [{ "name": "reply", "type": "string" }],
    "effect": {                           // REQUIRED on pivot and compensatable, forbidden otherwise
      "channel": "email",
      "recipient_ref": "roster.contacts#dana"   // a REFERENCE, never a literal address
    }
  }
}

// An accept_event behaviour spec. Same required fields, plus a clock and a match — see section 3.
{
  "op": "add_node",
  "name": "Dana replies",
  "type": "accept_event",
  "spec": {
    "instruction": "Wait for Dana's answer.",
    "effect_class": "pure",
    "deadline": { "at": "2026-08-22T17:00:00.000Z" },
    "match": { "kind": "event", "conditions": [{ "kind": "reply", "on": "satisfied" }] }
  }
}

// A control spec is exactly {}. A control node has no status; any behaviour field such as
// `instruction`, `effect_class`, `deadline`, `match` or `effect` is refused.
{ "op": "add_node", "name": "Did Dana keep the slot", "type": "decision", "spec": {} }

// ── add_edge ── {from: A, to: B} means **B REQUIRES A**. Read section 2 before writing one.
// A `guard` belongs only on an out-edge of a `decision`. It names a verdict — `confirmed`,
// `declined`, `timed_out` — or a resolution like `satisfied`. Every decision has exactly one
// explicit else arm, written `"guard": "else"`; an omitted guard is not an else arm.
{ "op": "add_edge", "from": "$0", "to": "$1", "guard": { "on": "confirmed" } }
{ "op": "add_edge", "from": "$0", "to": "$2", "guard": "else" }

// ── set_status ──
{ "op": "set_status", "node": "ask-dana", "status": "completed", "evidence_ref": "<m-101@mail>" }

// ── record_outcome ── what a counterparty DECIDED
{ "op": "record_outcome", "node": "dana-replies", "verdict": "confirmed",
  "evidence_ref": "<m-201@mail>", "attrs": { "role": "goalie" } }

// ── record_output ── what a node PRODUCED. output_name must be one it DECLARED.
{ "op": "record_output", "node": "confirm-roster", "output_name": "availability",
  "value": ["dana", "sam"], "evidence_ref": "roster.csv#v3" }

// ── supersede_node ── never delete
{ "op": "supersede_node", "node": "confirm-roster", "by": "$0" }
```

**Closed vocabularies.** Anything outside these is rejected.

```text
| `type` | `action` · `accept_event` · `initial` · `decision` · `merge` · `fork` · `join` · `final` · `flow_final` |
| `status` | `inactive` · `ready` · `active` · `completed` · `failed` · `withdrawn` · `terminated` |
| `verdict` | `confirmed` · `declined` · `tentative` · `timed_out` · `bounced` · `late` · `accept` · `edit` · `respond` · `ignore` |
| `guard.on` | `confirmed` · `declined` · `tentative` · `timed_out` · `bounced` · `late` · `accept` · `edit` · `respond` · `ignore` · `timeout` · `satisfied` |
| `effect_class` | `pure` · `reversible` · `compensatable` · `pivot` |
```

Statuses belong only to behaviour nodes. `inactive` means dependencies are not satisfied;
`ready` is the derived, unclaimed frontier; `active` is claimed work; `completed` is terminal
success and the only status that satisfies a downstream edge; `failed` is terminal failure;
`withdrawn` is unclaimed work removed by control flow; and `terminated` is claimed work stopped
before completion. The store alone writes `ready` and `withdrawn`; authors may write the rest.

**Forbidden, with no opcode reserved:** `delete_node` · `rollback` · `replace_graph` ·
`edit_rationale` · `reparent` · any write to a terminal node · coordinates · executable
payloads · **client-assigned ids**.

**Referring to nodes.**

- A node created **earlier in this same batch** is `$0`, `$1`, … — its index in your array.
- A node that **already exists** is its committed id, e.g. `"confirm-roster"`.
- **Never invent an id.** Forward references (`$3` from op 1) are rejected. If you have not
  seen an id in `kona graph --json`, and you did not create it earlier in this array, it
  does not exist.

---

## 2. Edge direction — read this even if you think you know it

```
{ "from": "A", "to": "B" }   means   B REQUIRES A
```

That is the opposite of how you will be tempted to write it, because **temporal phrasing
inverts it**. "First ask Dana, then accept her reply" makes you want to write
`from: ask-dana, to: dana-replies` because asking comes first — and that happens to be right.
But "chase her if she goes quiet" makes you want `from: chase, to: dana-replies` because chasing
comes second, and that is **backwards**.

The reliable trick: for every edge, say the sentence **"Y needs X"** out loud, then write
`from: X, to: Y`. Never think in time. Think in dependency.

**Numbering your steps does not create sequence.** Writing "1. do this 2. then that"
produces a graph with two unconnected nodes that both run immediately. Sequence exists only
where you wrote an edge.

**One exception, and it is the only one: an in-edge to a `merge` is a disjunct.** Everywhere
else "B REQUIRES A" is exact. Into a merge it means _A is ONE WAY to reach B_ — any one arm is
enough. That is precisely what a merge is for, and it is why you must not reach for one when
you mean "all of these": that is a `join`.

---

## 3. Accept events, and the rule that stops silent multi-day hangs

An `accept_event` blocks on the world. Its behaviour spec requires the normal `instruction`
and `effect_class` fields plus both `deadline` and `match`; no timeout target lives in the spec.
Route every result, including timeout, through the following `decision`:

```json
{
  "op": "add_node",
  "name": "Dana replies",
  "type": "accept_event",
  "spec": {
    "instruction": "Await Dana's reply.",
    "effect_class": "pure",
    "deadline": { "at": "2026-08-22T17:00:00.000Z" },
    "match": {
      "kind": "event",
      "conditions": [
        { "kind": "reply", "on": "satisfied" },
        { "kind": "deadline", "on": "timeout" }
      ]
    }
  }
}
```

**Why this is mandatory:** a message sitting in someone's spam folder is _sent_. No bounce,
no reply, no error, forever. The clock is the only thing that ever ends that wait.

The timeout path is an out-edge of the following `decision` with
`"guard": { "on": "timeout" }`. Other outcomes get their own guarded arms, and exactly one
out-edge is the explicit `"guard": "else"` fallback.

**Deadlines take one of exactly three shapes:**

```jsonc
{ "at": "2026-08-22T17:00:00.000Z" }                  // a fixed instant
{ "after": "$0", "duration": "48h" }                  // measured from when $0 settles
{ "expr": "game_date - 24h", "backstop": "2026-08-22T17:00:00.000Z", "after_unknown": true }
```

The `expr` form is **not evaluated** — its `backstop` is what actually fires.

An `accept_event` has one plain out-edge to a `decision`. Every out-edge of that decision must
carry a `guard`, including the required explicit `"else"` arm. Never route an event directly
to work: a declined or timed-out event must not clear an unguarded path to an action.

---

## 4. Inputs and outputs are a pair

`inputs[].ref` is `<node-id>.<output-name>`, and it only means something if that node
**declared** that output.

This is not bookkeeping. Measured: with no node declaring an `output`, **0 of 8** fresh
agents could execute a single node — every ref dangled and there was nothing to resolve it
against. With the pair required, **10 of 10** could.

So: if node B consumes something from node A, node A needs
`"outputs": [{ "name": "...", "type": "..." }]`, and B needs `"inputs": [{ "ref": "a.that-name" }]`.

---

## 5. Fan-out — and the only shape that says "at the same time"

Two steps with no edge between them both run immediately, which is _concurrency by accident_.
A `fork` says it on purpose, and the difference matters to a reader: an accident looks the
same as an oversight.

**Ask yourself two questions in this order.**

1. _Do these steps need each other?_ If yes, chain them. An edge is a claim about what must be
   true first — never about the order you intend to work.
2. _If not — do I need them all, or just one?_ All of them meet at a **join**. Any one of them
   is enough: a **merge**.

Here is the whole thing, in one batch. This is what a fan-out looks like; copy the shape.

```json
[
  { "op": "add_node", "name": "Start", "type": "initial", "spec": {} },
  { "op": "add_node", "name": "Ask both goalies at once", "type": "fork", "spec": {} },

  {
    "op": "add_node",
    "name": "Ask Dana",
    "type": "action",
    "spec": {
      "instruction": "Email Dana.",
      "effect_class": "pivot",
      "effect": { "channel": "email", "recipient_ref": "roster.contacts#dana" },
      "outputs": [{ "name": "sent", "type": "string" }]
    }
  },
  {
    "op": "add_node",
    "name": "Dana replies",
    "type": "accept_event",
    "spec": {
      "instruction": "Wait for Dana.",
      "effect_class": "pure",
      "deadline": { "at": "2026-08-22T17:00:00.000Z" },
      "match": { "kind": "event", "conditions": [{ "kind": "reply", "on": "satisfied" }] }
    }
  },
  { "op": "add_node", "name": "Did Dana say yes", "type": "decision", "spec": {} },
  { "op": "add_node", "name": "Dana is out", "type": "flow_final", "spec": {} },

  {
    "op": "add_node",
    "name": "Ask Pat",
    "type": "action",
    "spec": {
      "instruction": "Email Pat.",
      "effect_class": "pivot",
      "effect": { "channel": "email", "recipient_ref": "roster.contacts#pat" },
      "outputs": [{ "name": "sent", "type": "string" }]
    }
  },
  {
    "op": "add_node",
    "name": "Pat replies",
    "type": "accept_event",
    "spec": {
      "instruction": "Wait for Pat.",
      "effect_class": "pure",
      "deadline": { "at": "2026-08-22T17:00:00.000Z" },
      "match": { "kind": "event", "conditions": [{ "kind": "reply", "on": "satisfied" }] }
    }
  },
  { "op": "add_node", "name": "Did Pat say yes", "type": "decision", "spec": {} },
  { "op": "add_node", "name": "Pat is out", "type": "flow_final", "spec": {} },

  { "op": "add_node", "name": "Either goalie will do", "type": "merge", "spec": {} },
  {
    "op": "add_node",
    "name": "Lock the roster",
    "type": "action",
    "spec": {
      "instruction": "Publish the roster.",
      "effect_class": "pure",
      "outputs": [{ "name": "roster", "type": "string" }]
    }
  },
  { "op": "add_node", "name": "Thursday is settled", "type": "final", "spec": {} },

  { "op": "add_edge", "from": "$0", "to": "$1" },
  { "op": "add_edge", "from": "$1", "to": "$2" },
  { "op": "add_edge", "from": "$1", "to": "$6" },
  { "op": "add_edge", "from": "$2", "to": "$3" },
  { "op": "add_edge", "from": "$3", "to": "$4" },
  { "op": "add_edge", "from": "$4", "to": "$10", "guard": { "on": "confirmed" } },
  { "op": "add_edge", "from": "$4", "to": "$5", "guard": "else" },
  { "op": "add_edge", "from": "$6", "to": "$7" },
  { "op": "add_edge", "from": "$7", "to": "$8" },
  { "op": "add_edge", "from": "$8", "to": "$10", "guard": { "on": "confirmed" } },
  { "op": "add_edge", "from": "$8", "to": "$9", "guard": "else" },
  { "op": "add_edge", "from": "$10", "to": "$11" },
  { "op": "add_edge", "from": "$11", "to": "$12" }
]
```

Read what that says. Both goalies are asked **at once**, not one after the other. Either
answering is enough to lock the roster. Neither answering ends both paths at a `flow_final`,
which stops that path without ending the pursuit — and the roster step is then unreachable,
which the store works out for itself and records.

**Three rules that batch obeys, and every batch must.**

- **Terminate every branch.** Every node must reach a `final` or a `flow_final`. A branch that
  just stops is a dead end, and the store refuses the batch rather than letting you find out in
  three days that nothing was ever going to happen.
- **An accept event routes through a decision.** Never wire an `accept_event` straight to the next step.
  It can end by being answered, by being declined, or by running out of clock, and an
  unguarded edge fires on all three — which is how an unapproved email gets sent.
- **Every decision has an explicit else arm.** Exactly one out-edge uses `"guard": "else"`.
  Omitting `guard` does not mean else; without the explicit arm, an answer you did not
  anticipate stops the flow silently.

There is no loop construct and no template, and that is the point: each arm is a real node with
its own instruction, its own deadline and its own recipient, so arms can diverge later.

---

## 6. Submitting the batch

**For a plain sequence, do not write JSON at all.** `--steps` builds the initial node, the
chain, and the final node for you:

```bash
kona mutate --steps "Read the failing test" --steps "Fix the parser" \
  --why "the parser drops the trailing brace" --reason-code MISSING_STEP
```

That is the whole batch. Reach for the array when you need shape a chain cannot express — a
fork, an `accept_event`, a decision — which is most real plans, but not the first commit of one.

Otherwise write the array to a file and commit it:

```bash
kona graph --json                       # read head first; you need its version
cat > /tmp/ops.json                     # your array
kona mutate --ops /tmp/ops.json \
  --base-version <the version you just read> \
  --why "one or two sentences, in your own words" \
  --reason-code MISSING_STEP
```

`--why` and `--reason-code` are **required**. A commit without a rationale is impossible,
not discouraged — the rationale is what the next agent reads to understand why the graph
looks like this.

`--reason-code` is one of: `COUNTERPARTY_DECLINED` · `DEADLINE_PASSED` · `NEW_CONSTRAINT` ·
`MISSING_STEP` · `QUORUM_MET` · `CONTRADICTION` · `WITHDRAWN` · `OTHER`.

**Exit codes mean things.** Do not retry blindly:

|     |                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `0` | committed                                                                                                                                  |
| `1` | refused — read the stderr line, fix the batch                                                                                              |
| `3` | **stale base version** — someone else committed. Re-read `kona graph --json`, re-decide, then rewrite the batch. Never resubmit unchanged. |
| `4` | invariant violation — the batch would corrupt the graph. The message names the node.                                                       |

**Shape refusals, and what each one means.** These are the ones you will actually hit. Every
message names the offending node, so read it before changing anything.

| reason                   | what you did                                                                                 | the repair                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ARITY`                  | a node has the wrong number of edges for its type — most often an `action` with two in-edges | you meant a `merge` (any) or a `join` (all). Put one in and route both edges through it                |
| `WAIT_MUST_ROUTE`        | an `accept_event` wired straight to the next step                                            | put a `decision` between them and guard the arms                                                       |
| `NO_ELSE_ARM`            | a decision has an unguarded edge or no explicit else guard                                   | put a guard on every edge and make exactly one `"else"`                                                |
| `AMBIGUOUS_ELSE`         | more than one out-edge uses `"guard": "else"`                                                | keep exactly one explicit else arm                                                                     |
| `GUARD_OUTSIDE_DECISION` | a `guard` on an edge that does not leave a decision                                          | drop the guard, or introduce the decision you meant                                                    |
| `DERIVED_STATUS`         | you wrote `ready` or `withdrawn`                                                             | those are the store's to write. It decides what is ready and what the flow abandoned                   |
| `INITIAL_NODE`           | no initial node, or more than one                                                            | exactly one, and everything reachable from it                                                          |
| `UNREACHABLE_NODE`       | a node nothing leads to                                                                      | wire it in, or you did not mean to add it                                                              |
| `DEAD_END`               | a node that reaches no `final` or `flow_final`                                               | terminate the branch                                                                                   |
| `CYCLE`                  | an edge routes backwards                                                                     | there are no loops. Iteration is expressed by ADDING nodes later, which is what the whole store is for |

---

## 7. Then stop, and show the human

For a **first** plan, do not run anything afterwards. Print the graph and let the user
approve it:

```bash
kona graph            # human-readable
kona view             # then open the URL it prints
```

Nothing in this pursuit sends anything until a human has seen the shape of it.
