/**
 * `kona view` — start the localhost viewer (§6.8).
 *
 * It serves nothing itself. `packages/viewer` owns the front end AND the server that
 * carries it, and that server's own documentation names this verb as its default caller —
 * so this resolves the pursuit, hands over, and prints the URL.
 *
 * An earlier version of this file served its own `/graph` and `/events` routes plus a text
 * diagnostic page, written while the viewer package did not exist. Once it did, that was
 * two servers over one log with parallel routes, and §6.10 rule 10 allows exactly ONE read
 * contract. The duplicate is gone; the viewer's is the one that survives, because it reads
 * the log and folds it with `core`'s own `foldLog` — which is what makes rule 5's timeline
 * panel possible at all, since the graph projection carries no rationale.
 *
 * The import is DYNAMIC on purpose. The viewer pulls React, dagre and a stylesheet
 * toolchain, and the binary that owns the write path should carry none of that on the path
 * of `kona mutate`. Loading it only when this verb runs also turns "the viewer is not
 * installed" into a sentence rather than a stack trace.
 *
 * §6.8 makes this verb USER-RUN, never plugin-spawned — a server the orchestrator can start
 * is a server nobody remembers to stop. And per §1 it prints the URL rather than shelling
 * out to `open`/`xdg-open`/`start`: one behaviour on three platforms, and a localhost tool
 * should let you click the link.
 */

import { join } from "node:path";
import { findPursuitRoot } from "../paths.ts";
import { EXIT_REFUSED } from "../exit.ts";
import type { Io } from "../io.ts";

export interface ViewOptions {
  /** Absent means the viewer's own default. It owns that number; this verb does not. */
  port?: number;
  json: boolean;
}

export interface RunningView {
  url: string;
  stop: () => Promise<void>;
}

export type ServeViewer = (config: {
  root: string;
  port?: number;
}) => Promise<{ url: string; stop: () => Promise<void> }>;

/**
 * How the viewer gets loaded. Injected so a test can exercise this verb's own job —
 * resolving the pursuit, passing the port through, reporting the URL, refusing clearly —
 * without bundling React to do it.
 */
export type LoadViewer = () => Promise<ServeViewer>;

/**
 * The viewer package's own directory. `import.meta.dir` is `packages/kona/src/commands`.
 */
const VIEWER_PACKAGE = join(import.meta.dir, "..", "..", "..", "viewer");

/**
 * Load the viewer, with the cwd moved to its package first — and left there.
 *
 * ## The blank page this exists to stop
 *
 * Bun computes the bundled HTML's asset hrefs from `process.cwd()`, on the FIRST request, and
 * caches them. `kona view` runs from whatever pursuit the operator is standing in, so from
 * `/tmp/thursday` the page came back asking for
 * `/../../../../../../../private/tmp/thursday/chunk-50chekzd.js` — seven `..` because
 * `packages/viewer` is seven segments deep. That escapes the server root, falls through to the
 * `/*` catch-all, and is answered with the index page as `text/html`. The module script never
 * executes, `#root` stays empty, and a perfectly healthy `/api/log` sits behind a white screen.
 *
 * IT HID BECAUSE OF WHERE EVERYTHING RAN. From any ancestor of `packages/viewer` — the repo
 * root, where `bun test` and `bun run dev` both live — the `..` segments clamp at `/` and
 * resolve correctly. **Verify a change to this from a directory that is not an ancestor.**
 *
 * ## Why here, and why it is not put back
 *
 * The chdir has to precede the import, and a static `import` is hoisted above every statement
 * in its module — so there is no point inside `@kona/viewer` at which it could run first. This
 * dynamic import is the seam.
 *
 * It is also not restored, because restoring it does not work: the href is computed at the
 * first REQUEST, so the cwd has to still be right when the browser arrives, not merely when
 * the server starts. That is a real side effect and it is affordable exactly here — §6.8 makes
 * this verb user-run and foreground, `findPursuitRoot` has already resolved an absolute root
 * by the time this runs, and nothing after it reads the working directory. The process now
 * exists to serve until somebody stops it.
 */
const loadViewerPackage: LoadViewer = async () => {
  process.chdir(VIEWER_PACKAGE);
  return (await import("@kona/viewer")).serveViewer;
};

export async function startView(
  io: Io,
  options: ViewOptions,
  load: LoadViewer = loadViewerPackage,
): Promise<RunningView | null> {
  const root = findPursuitRoot(io.cwd);
  if (root === null) {
    io.err(`REFUSED NO_PURSUIT no .kona/ found at or above ${io.cwd}`);
    return null;
  }

  let serveViewer: ServeViewer;
  try {
    serveViewer = await load();
  } catch (cause) {
    io.err(
      `REFUSED NO_VIEWER the viewer package is not available: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return null;
  }

  let served: { url: string; stop: () => Promise<void> };
  try {
    served = await serveViewer({
      root,
      ...(options.port === undefined ? {} : { port: options.port }),
    });
  } catch (cause) {
    io.err(
      `REFUSED VIEWER_UNAVAILABLE could not start the viewer: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return null;
  }

  io.out(
    options.json
      ? JSON.stringify({ ok: true, url: served.url, root })
      : `kona view on ${served.url}  ·  localhost only, zero outbound calls`,
  );
  return served;
}

export async function runView(
  io: Io,
  options: ViewOptions,
  load: LoadViewer = loadViewerPackage,
): Promise<number> {
  const running = await startView(io, options, load);
  if (running === null) return EXIT_REFUSED;
  // Hold the process open. `kona view` is user-run and ends when the user ends it.
  await new Promise<never>(() => undefined);
  return 0;
}
