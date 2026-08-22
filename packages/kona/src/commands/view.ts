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

const loadViewerPackage: LoadViewer = async () => (await import("@kona/viewer")).serveViewer;

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
