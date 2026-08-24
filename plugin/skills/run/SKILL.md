---
name: run
description: Run a Kona pursuit forward — dispatch what is ready, take in replies, and mutate the graph as reality answers. Use after /kona:plan has been approved, or to pick up a pursuit that was left running.
argument-hint: [how many cycles, or "until quiet"]
# This loop dispatches irreversible sends. A human starts it; nothing auto-triggers it.
disable-model-invocation: true
---

# Running a pursuit

You are the orchestrator. **You hold no state.** Everything you need is in
`.kona/mutations.jsonl`, and every verb below reads it fresh — so a crash, a new terminal
or a week's gap costs you nothing.

⚖ **The `kona` binary never calls a model.** It answers *what is ready*, *did a reply
arrive*, *has the deadline passed*, *is this batch legal*. You answer *did Dana say yes*,
*what should the plan become*, *what does this activity's work involve*. Keep that line sharp:
if you find yourself doing arithmetic the CLI could do, ask the CLI.

---

## The cycle

Run this loop. **One macro-step per external event** — one reply in, one lock, one cascade,
one version.

That is a rule about *commits*, not about *work*: it keeps the rationale chain readable by
refusing to batch unrelated events into one version. Dispatching a wide frontier to many
executors at once is not batching unrelated events — it is one decision, taken once, about
what is ready.

### 1. Reconcile

```bash
kona resume
```

Fires any deadline that has passed, and prints anything that needs a human. Read the whole
output. If it says **NEEDS A HUMAN**, stop and see step 6.

### 2. Dispatch what is ready

```bash
kona next --json
```

**`next` returns the whole frontier, not one activity — dispatch all of it at once.** §6.7's
role-scoped write authority is what makes that safe: you own topology, each executor writes
only its own activity's status and output, so concurrent executors never touch the same region.
A frontier of thirty invitations is thirty executors, not thirty turns.

For each activity it returns:

```bash
kona brief <activity-id>
```

`brief` exits **non-zero** when the activity is not actually dispatchable — that is not advice,
it is a refusal. Do not dispatch an activity whose brief exited non-zero.

**Claim the whole frontier in one batch before you dispatch any of it**, so the graph says
what is being worked rather than only what is ready, and so a second orchestrator cannot
hand the same activity to a second executor:

```jsonc
[
  { "op": "set_status", "activity": "ask-dana", "status": "in_flight", "evidence_ref": "claim" },
  { "op": "set_status", "activity": "ask-sam",  "status": "in_flight", "evidence_ref": "claim" }
]
```

One batch, because one commit is cheaper than N and the whole frontier is one decision. A
activity already claimed refuses with `ALREADY_CLAIMED` — somebody else is on it; take the rest
and move on. If you believe the holder is gone, `kona resume` returns abandoned claims to
the frontier: nothing was sent, so nothing needs a human.

Hand each brief to the **`kona-executor`** subagent, verbatim, and **run them concurrently**.
Do not summarise a brief, do not add to it, and do not paste the graph around it. The brief
contains an `authority` statement and a `disclosure` block naming what must never reach a
counterparty — a summary loses exactly those.

Each executor returns one of `EXECUTED`, `COMPOSED`, or `REFUSED`. Handle each per step 4.

> **Work parallelises; commits do not.** Every write takes the lock and CAS's against head,
> so executors finishing together commit one after another and some will exit `3`. That is
> the design working — re-read and re-decide, never blind-merge. It costs nothing, because
> the work takes minutes and the commit takes milliseconds.

### 3. Take in what came back

```bash
kona poll --json                     # which addresses to fetch
# fetch those addresses with whatever reads mail here — an MCP server, a client, a script —
# and write the messages to /tmp/inbound.json. ⚖ The binary never fetches: it has no network
# and no credentials, and a store that could reach a mailbox could not be a pure fold.
kona poll --inbound /tmp/inbound.json --json
```

`poll` tells you **which wait** each message belongs to. It will never tell you what the
message *says* — that is the judgement you are here for.

For each match, read the message, then commit the outcome:

```jsonc
[
  { "op": "record_outcome", "activity": "wait-for-dana", "verdict": "confirmed",
    "evidence_ref": "<m-201@mail>", "attrs": { "role": "goalie" } },
  { "op": "set_status", "activity": "wait-for-dana", "status": "done",
    "evidence_ref": "<m-201@mail>" }
]
```

Substitute the wait's real id and the reply's real `message_id`. Both examples above are
literal, valid ops — an activity id must match `[a-z0-9][a-z0-9-]*`, so a placeholder like
`<the wait>` is rejected on arrival.

**`evidence_ref` must be the literal `message_id`.** It is also the dedupe key — get it
wrong and `poll` hands you the same message forever.

Three cases the contract names, because a retry loop never converges on them:

| | |
|---|---|
| the match says **`late: true`** | record `verdict: "late"` and **nothing else**. It does not reopen the wait. |
| the reply is **non-committal** | record `verdict: "tentative"` and do **not** set the status. The wait stays armed. |
| the reply is **a decision** | `confirmed` / `declined`, and set the status `done`. |

### 4. Handle what the executor said

| | |
|---|---|
| `EXECUTED` | bytes moved. It already called `kona effect record`. Nothing for you to do. |
| `COMPOSED` | a payload is ready and **was not sent**. Read it. If it is right, tell the executor to send; if not, say what to change. |
| `REFUSED` | it will carry a `refusal_reason`. **This is information, not an error.** A refusal usually means the plan is wrong — go to step 5. |

### 5. Change the plan

This is the part that matters, and **it is automatic**. You do not ask permission to change
the shape of the graph. Fan out, reroute, add a follow-up, obviate a branch, supersede a
activity with its compensation, re-plan a whole arm — commit it with `kona mutate` and a
rationale that says why.

Adaptive workflow systems died because changing the plan was expensive and blameful.
Changing the plan here is free. Use it.

The rationale is not a formality. It is what the next agent — possibly you, next week —
reads to understand a graph that no longer looks like the one a human approved:

```bash
kona mutate --ops /tmp/ops.json --base-version <head> \
  --why "Dana is away that week, so the only goalie on the roster is gone" \
  --reason-code COUNTERPARTY_DECLINED \
  --expected-effect "quorum(goalie) satisfiable by Friday" \
  --alternative "cancel the game"
```

Use `/kona:plan`'s catalogue for the op shapes — the edge-direction rule in particular. On
exit `3`, re-read the graph and **re-decide**; never resubmit the same batch.

### 6. Stop when

- `kona next` returns nothing and every wait is armed with a live deadline → the pursuit is
  waiting on the world. Say so and stop.
- `kona resume` reports **NEEDS A HUMAN** → an irreversible send was reserved and never
  resolved. **Do not retry it and do not send anything.** The log genuinely cannot say
  whether those bytes reached anybody; only the mailbox can. Show the operator the activity,
  the `effect_key` and the recipient, and stop.
- Something is refused twice for the same reason → stop and explain. A third attempt is a
  loop.

---

## THE ONE GATE

Everything above is automatic. Exactly one thing is not:

> **A mutation that creates a new irreversible effect targeting a recipient the graph has
> never seen.**

Concretely: you are about to add an activity with `effect_class` of `pivot` or `compensatable`
whose `recipient_ref` does not resolve to something already in the graph with evidence
behind it.

**Stop and ask the human. In plain words, naming the person.**

This is narrow on purpose. The plan changes freely; the world does not; and **nobody new
enters the world without a human.** It is not a hypothetical: in a measured run of 60, when
the graph became unsatisfiable, the mutator's most common repair was to **invent
counterparties** — plausible names, plausible addresses — and queue email to them. It
passed every other check, because the suite rewarded a satisfiable graph and nothing asked
whether the people were real.

The store enforces this too and will reject the batch. But you should never make it say no:
find the person's actual reference in the graph first, or ask.

Gate the **class**, never the individual mutation. Once a human has said "yes, Marcus is
real, here is his address", Marcus is evidenced and subsequent activities addressing him are
automatic like everything else.

---

## What not to do

- **Do not keep a to-do list.** `kona next` is the only source of work. A list you maintain
  in your head goes stale the moment the graph changes, and the graph changes constantly.
- **Do not re-derive readiness.** If it is not in `kona next`, it is not ready — even if it
  looks ready to you. Readiness fails safe on purpose.
- **Do not re-execute anything.** An activity with a recorded send is never dispatched again;
  the CLI refuses. If you find yourself wanting to, read `kona brief` and believe it.
- **Do not summarise a brief before handing it over.**
- **Do not batch unrelated events.** One external event, one commit. It keeps the rationale
  chain readable and the version history meaningful.
