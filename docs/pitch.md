# Demo deck — content brief

**For:** a design pass that turns this into slides.
**Talk:** 3 minutes, hackathon demo, judges are technical but have seen forty pitches today.
**Deliverable:** 8 slides, 16:9.

The speaker notes below are the actual script and total **459 words ≈ 3:03 at 150 wpm**. That is the constraint, not a suggestion — if a slide grows, the talk overruns.
On-screen text is deliberately tiny: judges either read the slide or listen to me, never both.

## The spine

The talk makes **one claim in three parts**, and the deck's job is to make the three legible
as a set. Slides 3–5 are one beat each; slide 8 repeats them as the close.

| beat | eyebrow label | the claim |
|---|---|---|
| 1 | **SEE IT** | the plan is a live graph, not a chat scroll |
| 2 | **BOUND BY IT** | the graph constrains the agent — enforcement, not advice |
| 3 | **OUTLIVES IT** | kill the session, a fresh one continues from the file |

Beat 2 is the one that separates this from a dashboard and it is the one a viewer screenshot
cannot carry alone — give it its own visual language (terminal, refusal, exit code), not
another picture of the graph.

Use the eyebrow words, **not** numbers `01 / 02 / 03`. These are three parallel properties,
not a sequence, and numbering them would assert an order the content doesn't have.

---

## Visual direction

- **Hero asset:** `docs/img/viewer.png` — a real run at v31. Full-bleed on slide 3, the single
  most persuasive object in the deck. Embed it; do not recreate it.
- **Register:** technical, restrained, dark. This is instrumentation, not a landing page.
- **Type:** a real display face for headlines paired with a monospace for anything literal from
  the system (`in_flight`, `CONTRADICTION`, `kona next`, `UNEVIDENCED_RECIPIENT`). The line
  between prose and machine vocabulary should be visible at a glance.
- **Colour:** one accent, spent on the claimed/in-flight state and on refusals — so the eye
  learns it on slide 3 and recognises it on slide 4.
- **Avoid:** gradient hero, centered everything, emoji section markers, a grid of invented
  metrics. There is one honest number story on this deck and it is not a score.

---

## Slide 1 — The problem
**Timing:** 0:00–0:22

**On screen:** `Your agent made a plan today. You never saw it.`

**Speaker notes:**
> Every agent you ran today made a plan. You couldn't see it. It lived in the context window,
> it couldn't constrain what the agent did next, and it died with the session. Three problems,
> one cause: the plan was never anywhere you could point at.

**Visual:** a chat scroll fading into nothing. Suggestion only — restraint beats cleverness.
The line "three separate problems, one cause" sets up the spine; if the design can foreshadow
three, do it quietly.

---

## Slide 2 — What it is
**Timing:** 0:22–0:40

**On screen:** `Kona — a living workflow graph` / `Beads, with state machines.`

**Speaker notes:**
> Kona puts the plan in a file. A graph the model authors itself, works against, and rewrites
> as reality answers — carrying the reason for every change. Beads, with state machines. Three
> things follow, and I'll show you all three.

---

## Slide 3 — SEE IT
**Timing:** 0:40–1:15 · **35s**

**On screen:** eyebrow `SEE IT`. The viewer screenshot, full-bleed, minimal chrome. Two
callouts revealed in sequence with the script, not both at once:
1. the spinning claimed node → `in_flight`
2. the blocked node → `3 of 3 dependencies unmet`

**Speaker notes:**
> First — you can see it. A live plan, version thirty-one, inside a benchmark container. The
> four grey steps at the bottom are the skeleton we handed it; everything above, the agent
> wrote — fifteen nodes, twenty-two edges, one commit.
>
> This node is spinning because it's claimed: the agent took it before starting work, so if the
> run goes quiet you know which step it's quiet inside. And this one says three of three
> dependencies unmet — it knows what it's waiting for.

---

## Slide 4 — BOUND BY IT
**Timing:** 1:15–1:53 · **38s — the longest slide, deliberately**

**On screen:** eyebrow `BOUND BY IT`. **Not** another graph picture. Render a terminal: a
`kona mutate` command, then the refusal, in mono, accent-coloured:

```
UNEVIDENCED_RECIPIENT  node=ask-the-supplier-to-expedite
nothing in the graph attests to 'acme'
exit 1
```

Beneath it, small: `enforcement in the store, not advice in a prompt`

**Speaker notes:**
> Second — and this is the part people miss. The agent isn't just watched by the graph, it's
> bound by it. Work only comes from `kona next`, computed from the log, never remembered. A
> finished step is terminal — the store won't reopen it, so nothing is silently redone. A
> claimed step leaves the frontier, so nothing is done twice.
>
> We ran the mutator sixty times. When it couldn't satisfy a constraint, it invented
> counterparties and emailed them — passing every other check. So now the store refuses a
> recipient the graph has never seen. A rule in the binary, not a line in a prompt.

---

## Slide 5 — OUTLIVES IT
**Timing:** 1:53–2:11 · **18s**

**On screen:** eyebrow `OUTLIVES IT` / `The graph is a fold over the log — there is no
snapshot to rebuild.`

**Visual:** two process boxes, one dead, one alive, reading the same single file. Simple.

**Speaker notes:**
> Third — kill the session. A fresh one reads the file and carries on. There's no snapshot to
> rebuild, because the graph is a fold over the log. Same file, same state, new process.

---

## Slide 6 — Why this isn't already solved
**Timing:** 2:11–2:39 · **28s**

**On screen:** three rows, one line each. The only dense slide, and it earns it.

| | |
|---|---|
| **The mutator is a machine** | Adaptive BPM, 2008 — died because the mutator was a human with a BPMN editor |
| **The timeline is irreversible** | AFlow / ADAS / DSPy optimise *between* runs, by re-executing them |
| **Waits outlive the process** | Temporal · Golem · Trigger.dev — all forbid mutating a running workflow |

**Speaker notes:**
> Every one of those exists somewhere; the intersection doesn't. Adaptive BPM solved runtime
> workflow change in 2008 — it died because the mutator had to be a human. LLMs removed that.
> The topology optimisers re-execute the plan to score it; you can't email thirty people five
> times and take the average. And every durable engine buys crash-resume by forbidding
> mutation.

---

## Slide 7 — Why it holds up
**Timing:** 2:39–2:53 · **14s**

**On screen:** `The binary never calls a model.` — beneath it, small: `1,238 tests · 9 verbs ·
3 invariants · benchmark rig, both arms`

**Speaker notes:**
> The binary never calls a model — every verb is a pure function of an append-only log. That's
> why it's testable: twelve hundred tests. The benchmark rig is in the repo, both arms — and
> we're not claiming a score, because one run per arm measures noise.

---

## Slide 8 — Close
**Timing:** 2:53–3:01 · **8s**

**On screen:** `See it. Bound by it. Outlives the session.` + repo URL + QR code.
Echo the three eyebrow words in the same treatment they had on slides 3–5 — this is the payoff
of the spine, so the visual rhyme matters more than the words.

**Speaker notes:**
> See it. Bound by it. Outlives the session. It's open source — clone it.

---

## Guardrails for the design pass

**Do not invent metrics.** No benchmark score, win rate, percentage improvement, speedup, or
"3× faster" anywhere. We ran a controlled A/B and deliberately do not report the result: with
one attempt per arm, the within-arm variance was as large as the gap between arms. Slide 7
says so out loud, and in front of technical judges that reads as rigour — don't let a design
flourish quietly contradict it.

**Numbers that are true and may be used verbatim:** 15 nodes and 22 edges in one commit · 20
constraint checks in the benchmark task · 1,238 tests · 9 verbs · 3 invariants · version 31 in
the screenshot · the mutator run at n=60.

**The n=60 story is real, not a hypothetical.** It is recorded in `docs/prd.md` and
`docs/spec.md`: an empirical run found the mutator satisfying an unsatisfiable constraint by
inventing counterparties and queueing real email to them. It is the reason the rule exists.
Don't soften it into "could theoretically" — the past tense is the point.

**Vocabulary is literal.** `in_flight`, `CONTRADICTION`, `kona next`, `supersede_node`,
`UNEVIDENCED_RECIPIENT`, `--why` are exact strings from the system. Set them in mono; do not
paraphrase, retitle, or prettify.

## Production notes

- **Do not live-run anything.** Slide 3 is a screenshot; the viewer can be pre-loaded at
  `127.0.0.1:4747` on a second display as a backstop. A benchmark container takes ~80 minutes
  and will not cooperate on stage.
- Rehearse against a timer. The script is at budget with zero slack. Slides 3 and 4 are the
  first things that expand under pressure and the last things that should.
- If asked for the score in Q&A: *we ran it, the variance swamped the effect at n=1, and the
  rig is in the repo so it can be run properly.*
