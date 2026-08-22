# Fixtures

`thursday.*` is one pursuit — "find a goalie for Thursday" — carried through eight
versions by the real binary. **Regenerate with `./scripts/make-fixture.sh`**; never hand-edit,
because the point is that it cannot drift from what the CLI actually emits.

| | |
|---|---|
| `thursday.mutations.jsonl` | the log. The system of record. Point a viewer at this, or `kona init` a directory and drop it in |
| `thursday.graph.json` | `kona graph --json` at head. The **only** read contract (spec §6.8) |

## What it deliberately exercises

Built so a viewer, a demo rig or a plugin can be developed against it without waiting for
the wait engine or the outbox.

- **All five statuses at head** — `active` `sending` `done` `failed` `dropped`. `sending`
  is not terminal: it means the real world's answer is unknown.
- **Both node types**, and all three wait match kinds — `event`, `human`, `predicate`.
- **A fan-out that is not `withParam`** — four goalie arms with pairwise different shapes,
  and an arm (`marcus`) whose nodes no v1 shape describes, reached through a referral to
  someone absent from the v1 roster.
- **Conditional edges** — `satisfied` and `accept` alongside plain ones, converging on a
  predicate wait. Also a **merge with four in-edges** where two are already dead.
- **A supersede chain**, both directions wired: `confirm-roster-availability` →
  `…-and-eligibility`. Nothing is ever deleted.
- **Two deadline shapes**, `{at}` and `{after, duration}`, plus `on_timeout` on every wait.
- **Three scopes** (`setup`, `goalies`, `marcus`) for group rendering.
- **Eight versions with real rationale** — every one carries a `why` and a `reason_code`,
  which is what the timeline panel renders. That panel, not the canvas, is the differentiator.

## The story, version by version

| v | |
|---|---|
| 0 | genesis |
| 1 | the approved plan: confirm the roster, ask Dana, wait |
| 2 | roster returns four names; fan out to Sam and Priya, converge on a predicate |
| 3 | Dana and Sam dispatched; Priya's send is reserved and in flight |
| 4 | Dana declines — away that week |
| 5 | Sam declines but refers **Marcus, who is not on the roster**; eligibility needs a human |
| 6 | the roster step is superseded by one that also checks eligibility |
| 7 | Priya's address bounces `550`; her wait is dropped, and Pat is asked |

## Caveats

The wait engine and the outbox are not built, so **`status.effect_log` is empty
everywhere** and no wait carries a cursor or resolution. Those fields will appear; treat
the JSON as **additive** and do not switch exhaustively on the current field set. The two
things that are frozen are the ones the visual vocabulary needs: **2 node types and 5
statuses.**

`dropped` here was written by an explicit `supersede_node`. Once branch resolution (T2.6)
lands, the store will also drop untaken branches transitively, on its own.
