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

If the brief says "email the goalies on the roster", you need to know what the roster *is*
and where it lives. "I'll look it up later" is how a pursuit ends up addressing people who
do not exist.

---

## 1. The op catalogue

These six are the entire vocabulary. There is no seventh, and no opcode is reserved for
one. Write a JSON **array** of them.

```jsonc
// ── add_node ── the only op that creates anything. Returns $N, its index in the array.
{
  "op": "add_node",
  "name": "Ask Dana to play Thursday",   // REQUIRED. The id is minted from this.
  "type": "task",                         // REQUIRED. task | wait
  "scope": "goalies",                     // optional. The fan-out arm this belongs to.
  "spec": {
    "instruction": "Email Dana asking if she can play in goal Thursday.",  // REQUIRED
    "effect_class": "pivot",              // REQUIRED. pure | reversible | compensatable | pivot
    "inputs":  [{ "ref": "confirm-roster.availability" }],   // <node-id>.<output-name>
    "outputs": [{ "name": "reply", "type": "string" }],
    "merge": "all",                       // all | any. REQUIRED when >1 blocking in-edge.
    "effect": {                           // REQUIRED on pivot and compensatable, forbidden otherwise
      "channel": "email",
      "recipient_ref": "roster.contacts#dana"   // a REFERENCE, never a literal address
    },
    "compensates": "some-node-id",        // this node offsets one that already ran
    "obviated_if": { "wait": "roster-quorum", "satisfied": true }
  }
}

// ── add_edge ── {from: A, to: B} means **B REQUIRES A**. Read section 2 before writing one.
{ "op": "add_edge", "from": "$0", "to": "$1", "condition": { "on": "satisfied" } }

// ── set_status ──
{ "op": "set_status", "node": "ask-dana", "status": "done", "evidence_ref": "<m-101@mail>" }

// ── record_outcome ── what a counterparty DECIDED
{ "op": "record_outcome", "node": "wait-for-dana", "verdict": "confirmed",
  "evidence_ref": "<m-201@mail>", "attrs": { "role": "goalie" } }

// ── record_output ── what a node PRODUCED. output_name must be one it DECLARED.
{ "op": "record_output", "node": "confirm-roster", "output_name": "availability",
  "value": ["dana", "sam"], "evidence_ref": "roster.csv#v3" }

// ── supersede_node ── never delete
{ "op": "supersede_node", "node": "confirm-roster", "by": "$0" }
```

**Closed vocabularies.** Anything outside these is rejected.

| | |
|---|---|
| `type` | `task` · `wait` |
| `status` | `active` · `in_flight` · `done` · `failed` · `dropped` |
| `verdict` | `confirmed` · `declined` · `tentative` · `timed_out` · `bounced` · `late` · `accept` · `edit` · `respond` · `ignore` |
| `condition.on` | `accept` · `edit` · `respond` · `ignore` · `timeout` · `bounced` · `satisfied` |
| `effect_class` | `pure` · `reversible` · `compensatable` · `pivot` |

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
inverts it**. "First ask Dana, then wait for her reply" makes you want to write
`from: ask-dana, to: wait-for-dana` because ask comes first — and that happens to be right.
But "chase her if she goes quiet" makes you want `from: chase, to: wait` because chasing
comes second, and that is **backwards**.

The reliable trick: for every edge, say the sentence **"Y needs X"** out loud, then write
`from: X, to: Y`. Never think in time. Think in dependency.

**Numbering your steps does not create sequence.** Writing "1. do this 2. then that"
produces a graph with two unconnected nodes that both run immediately. Sequence exists only
where you wrote an edge.

---

## 3. Waits, and the rule that stops silent multi-day hangs

A `wait` blocks on something. Every wait **requires all three of these** or the batch is
rejected:

```jsonc
{
  "op": "add_node", "name": "Wait for Dana", "type": "wait",
  "spec": {
    "instruction": "Await Dana's reply.",
    "effect_class": "pure",
    "deadline": { "at": "2026-08-22T17:00:00.000Z" },   // REQUIRED
    "on_timeout": "$0",                                  // REQUIRED — where a blown deadline goes
    "match": {                                           // REQUIRED
      "kind": "event",                                   // event | human | predicate
      "conditions": [                                    // or-group, FIRST MATCH WINS
        { "kind": "reply",    "on": "satisfied" },
        { "kind": "deadline", "on": "timeout" }
      ]
    }
  }
}
```

**Why this is mandatory:** a message sitting in someone's spam folder is *sent*. No bounce,
no reply, no error, forever. The clock is the only thing that ever ends that wait.

`on_timeout` must point at a node that **does something about it** — an escalation, a
fallback, a person. Pointing it at the thing that just timed out is a loop.

**Deadlines take one of exactly three shapes:**

```jsonc
{ "at": "2026-08-22T17:00:00.000Z" }                  // a fixed instant
{ "after": "$0", "duration": "48h" }                  // measured from when $0 settles
{ "expr": "game_date - 24h", "backstop": "2026-08-22T17:00:00.000Z", "after_unknown": true }
```

The `expr` form is **not evaluated** — its `backstop` is what actually fires.

**Every out-edge of a wait must carry a `condition`.** Without one, an ignored or timed-out
wait clears a plain edge and whatever is downstream fires unapproved.

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

## 5. Fan-out

A fan-out is `add_node` × N plus `add_edge` × N **in one batch**. There is no loop
construct and no template — and that is the point. Each arm is a real node with its own
instruction, its own deadline, and its own recipient, so arms can diverge later. Give each
arm a `scope` so the viewer can group them.

---

## 6. Submitting the batch

Write the array to a file and commit it:

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

| | |
|---|---|
| `0` | committed |
| `1` | refused — read the stderr line, fix the batch |
| `3` | **stale base version** — someone else committed. Re-read `kona graph --json`, re-decide, then rewrite the batch. Never resubmit unchanged. |
| `4` | invariant violation — the batch would corrupt the graph. The message names the node. |

---

## 7. Then stop, and show the human

For a **first** plan, do not run anything afterwards. Print the graph and let the user
approve it:

```bash
kona graph            # human-readable
kona view             # then open the URL it prints
```

Nothing in this pursuit sends anything until a human has seen the shape of it.
