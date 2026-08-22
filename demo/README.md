# `demo/` — the rig

Spec §6.11 · plan E7. **A directory, not a package** (§6.12), so nothing here is importable
by `core`, `kona` or `viewer`, and the dependency graph keeps it that way.

## Why there is no `@kona/cli` path in `tsconfig.json`

`demo/tsconfig.json` maps `@kona/core` and **deliberately does not map `@kona/cli`.**

`demo/` is not a workspace, so Bun creates no `node_modules/@kona` symlink reachable from
here — the only one in the repo is `packages/kona/node_modules/@kona/`. Mapping a package
is therefore what makes it importable at all, and omitting `@kona/cli` means

```ts
import { something } from "@kona/cli";   // TS2307, and a runtime resolution failure
```

fails both gates rather than merely violating a convention. §6.12 buys one property with
the package graph — "exactly one package calls `writeFile`" — and the rig talks to `kona`
the way a human on stage does: as a subprocess, through `demo/kona.ts`.

## Layout

```
mailbox/     the MailboxProvider port (provision / send / poll-thread) and its two
             implementations. Knows nothing about nodes, tags, or correlation.
personas/    the cast and the reply simulator. Produces the world's bytes, decides nothing.
script/      three runs — see below — and the §7.2 assertions one of them has to pass.
kona.ts      the subprocess seam.
```

## The three runs, and why there are three

| | `divergence.ts` (T7.4) | `pursuit.ts` (T8.1) | `kill-resume.ts` (T8.3) |
|---|---|---|---|
| proves | the graph diverges in ways `withParam` cannot | **a pursuit finishes** | **a killed pursuit is recoverable** |
| shape | a scripted replay: eleven batches, hand-written `baseVersion`s | a loop: `kona next` decides what happens, head is read not predicted | `SIGKILL` to a detached process group, then a fresh process |
| ends | where its author decided to stop | when the frontier is empty | when a human could have carried on |
| exercises | CAS, branch topology, the §7 assertions | readiness, `poll`, the human gate, invariant 2's refusal | the outbox's crash windows, the lock, torn tails, restart-from-log |

None of them subsumes another. A replay proves things about *structure* that a loop cannot
make happen on cue; a loop proves things about *termination* that a replay assumes; and only
a real signal proves that the state a crash leaves is the state the tests simulate.

Between them, `--base-version` is exercised both ways: pinned to a literal, which catches an
unexpected writer, and read from head, which is what a real orchestrator does.

Each of the last two found a bug the others could not see.

- **The correlation mismatch.** `kona brief` handed out the sender's reply address while
  `kona poll` watched for the wait's, so every reply in a real run would have correlated to
  nothing. Both halves had passing unit tests. It took a loop that sent mail and then went
  looking for the answer.
- **The lock naming a corpse.** `kill -9` a writer mid-write and the next command said
  "another writer holds it (pid N)" for thirty seconds — in exactly the window a crash gets
  discovered in. `acquireLock` now asks whether the pid is running. It still never reclaims;
  what changed is only what a human is told.

## Running it

```bash
bun demo/script/divergence.ts            # offline, deterministic, no install step
bun demo/script/divergence.ts --mailpit  # against a running Mailpit
bun demo/script/pursuit.ts               # the full loop; exits non-zero if anything is left open
bun demo/script/kill-resume.ts           # kill -9 eleven times, and recover from each
```

`kill-resume.ts` spawns and destroys a pursuit per kill point, so the full eight-point sweep
takes about a minute. `bun test` runs the same rehearsal with three points — the property
asserted is identical and the coverage of it is thinner. Run the script for the full sweep.

`--mailpit` expects Mailpit on `http://localhost:8025`. It is **not** installed by this repo
and is **not** needed for the assertions to run — `bun test` uses the in-process provider and
a stubbed `fetch`, so `bun run check` is green on a machine that has never heard of Mailpit.

```bash
brew install mailpit
mailpit --max 0                          # and NOTHING else. See below.
```

Three flags, and the reasoning matters more than the flags:

| | |
|---|---|
| `--max 0` | The default is **500**, and pruning is periodic and silent. A long run loses its oldest mail with no error, and the poll cursor then names a message that no longer exists |
| **no `--database`** | The default database is a temp file that auto-deletes on exit, and here that is exactly what you want: every run starts clean. Persisting it collides with the next row |
| **no `--ignore-duplicate-ids`** | Off by default, and it must stay off. This rig **pins its own `Message-ID`s** so a run reproduces — and that flag makes Mailpit *silently drop* a message whose id it has seen before, which is every replay against a persisted database |

Pin the version rather than tracking `latest`: everything in `mailbox/mailpit.ts` was verified
against **v1.31.0**, and `restrictedHeaders` — the list that decides whether pinning a
`Message-ID` is allowed at all — has been refactored more than once upstream.

## What the offline path cannot prove

Mailpit is a catch-all. It accepts every address there is, so it **cannot refuse a
recipient** — which means Priya's `550` is not transported on that path, it is narrated. The
in-process provider *can* refuse, and the run uses a real rejection there. Two things tell a
reader which they are looking at: `sandbox_or_real` on every receipt, and the run's own line
saying the bounce was staged. Do not narrate it as a transport bounce on stage.
