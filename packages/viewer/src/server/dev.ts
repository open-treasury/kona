/**
 * `bun run dev` — the viewer pointed at whatever pursuit is to hand.
 *
 * It exists so that working on the front end never requires inventing a pursuit. Three
 * sources, in order: `KONA_LOG` names a log file outright, otherwise the walk up from
 * `KONA_ROOT` or the working directory finds a real `.kona/`, and failing both it falls back
 * to the committed fixture.
 *
 * The fixture is served WHERE IT LIVES. Copying it into a scratch `.kona/` to satisfy a path
 * shape would make the viewer's input a file the binary never wrote, which is precisely the
 * property `fixtures/README.md` exists to protect — so `readLog` accepts a log path directly
 * instead.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findPursuitRoot } from "./logFeed.ts";
import { serveViewer } from "./index.ts";

/** `packages/viewer/src/server` → the repo root, the same four hops `test/fixture.ts` makes. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const FIXTURE_LOG = join(REPO_ROOT, "fixtures", "thursday.mutations.jsonl");

interface Source {
  root: string;
  why: string;
}

function resolveSource(): Source {
  const explicitLog = process.env["KONA_LOG"];
  if (explicitLog !== undefined && explicitLog !== "") {
    return { root: resolve(explicitLog), why: "KONA_LOG" };
  }

  const from = process.env["KONA_ROOT"] ?? process.cwd();
  const found = findPursuitRoot(from);
  if (found !== null) {
    return { root: found, why: `pursuit found from ${from}` };
  }

  return { root: FIXTURE_LOG, why: "no pursuit here — falling back to the committed fixture" };
}

const source = resolveSource();
// The one caller that wants hot reloading and the error overlay. `kona view` does not.
const served = await serveViewer({ root: source.root, development: true });

// oxlint bans `console` outside `packages/kona/src/bin.ts`, and it is right to: a library that
// prints is a side effect nobody asked for, and `console` is the easiest one to leave behind.
// This file is not a library — it is a program, and a program's banner belongs on its stdout —
// so it writes to the stream directly rather than asking for the rule to be relaxed.
process.stdout.write(
  `kona viewer\n  source: ${source.why}\n  log:    ${source.root}\n  url:    ${served.url}\n`,
);
