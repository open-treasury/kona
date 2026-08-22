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
script/      the divergence run, and the §7.2 assertions it has to pass.
kona.ts      the subprocess seam.
```

## Running it

```bash
bun demo/script/divergence.ts            # offline, deterministic, no install step
bun demo/script/divergence.ts --mailpit  # against a running Mailpit
```

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
