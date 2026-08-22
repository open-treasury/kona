/**
 * `kona view` — the localhost viewer's server (§6.8, §6.10).
 *
 * Rule 10 makes `kona graph --json` **plus file-watch** the ONE read contract, and that is
 * exactly what this serves: the same projection the CLI prints, pushed again whenever the
 * log grows. There is no second query path and no query language (§6.8).
 *
 * Rule 9: **localhost only, zero outbound calls.** It binds 127.0.0.1 explicitly rather
 * than the default any-interface, because a graph carrying real names and real addresses
 * has no business being reachable from the network a café shares.
 *
 * §6.8 also makes this verb USER-RUN, never plugin-spawned — a server the orchestrator can
 * start is a server nobody remembers to stop. And per §1 it prints the URL rather than
 * shelling out to `open`/`xdg-open`/`start`: one behaviour on three platforms, and a
 * localhost tool should let you click the link.
 */

import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { foldLog, projectGraph } from "@kona/core";
import { type KonaPaths, findPursuitRoot, konaPaths } from "../paths.ts";
import { readLogText } from "../store.ts";
import { EXIT_REFUSED } from "../exit.ts";
import type { Io } from "../io.ts";

export const DEFAULT_VIEW_PORT = 7373;

/**
 * Coalesce filesystem events before reading.
 *
 * `fs.watch` can fire when the file is OPENED for append, before the bytes are visible —
 * so reading on the raw event pushes the state the client already had. It also fires more
 * than once per write on some platforms. A short debounce fixes both, and costs a delay
 * nobody watching a graph will notice.
 */
const WATCH_DEBOUNCE_MS = 30;

/**
 * The same principle §6.5 applies to mailboxes: **reconciliation is truth, and the
 * notification is a latency optimisation.**
 *
 * `fs.watch` is documented as unreliable across platforms, and it demonstrably drops
 * events under load — which on stage means the graph simply stops moving while the demo
 * claims to be live. Polling one file's size and mtime costs nothing and makes the feed a
 * guarantee rather than a hope; the watcher just makes it feel instant.
 */
const POLL_INTERVAL_MS = 400;

export interface ViewOptions {
  port: number;
  json: boolean;
}

export interface RunningView {
  url: string;
  stop: () => Promise<void>;
}

/** The one payload. Identical in shape to `kona graph --json --history`. */
async function readState(paths: KonaPaths): Promise<string> {
  const folded = foldLog(await readLogText(paths));
  return JSON.stringify({
    ...projectGraph(folded.graph),
    history: folded.records,
    torn_tail: folded.torn_tail !== null,
    damaged: folded.damaged,
  });
}

/**
 * A deliberately plain diagnostic page, not the viewer.
 *
 * The viewer is React Flow and dagre and lives in its own package (§6.12). This exists so
 * that `kona view` is useful before that ships and so the SSE contract is visibly working
 * — it is text, and it is meant to look like text.
 */
const DIAGNOSTIC_PAGE = `<!doctype html>
<meta charset="utf-8"><title>kona</title>
<style>body{font:13px ui-monospace,monospace;margin:2rem;max-width:60rem}
h1{font-size:1rem}pre{white-space:pre-wrap;word-break:break-all}
.n{color:#666}</style>
<h1>kona &mdash; diagnostic view</h1>
<p class=n>The viewer package is not built. This page exists to show that the read contract
and the change feed are working. Data: <a href="/graph">/graph</a> &middot; changes: <code>/events</code></p>
<pre id=out>connecting&hellip;</pre>
<script>
const out = document.getElementById('out');
function render(state) {
  const lines = ['version ' + state.version + ' \\u00b7 ' + state.nodes.length + ' nodes \\u00b7 ' + state.edges.length + ' edges'];
  for (const n of state.nodes) lines.push('  ' + n.status.state.padEnd(8) + ' ' + n.type.padEnd(5) + ' ' + n.id);
  lines.push('');
  for (const r of state.history) lines.push('  v' + r.v + ' [' + r.rationale.reason_code + '] ' + r.rationale.why);
  out.textContent = lines.join('\\n');
}
fetch('/graph').then(r => r.json()).then(render);
new EventSource('/events').onmessage = e => render(JSON.parse(e.data));
</script>`;

export async function startView(io: Io, options: ViewOptions): Promise<RunningView | null> {
  const root = findPursuitRoot(io.cwd);
  if (root === null) {
    io.err(`REFUSED NO_PURSUIT no .kona/ found at or above ${io.cwd}`);
    return null;
  }
  const paths = konaPaths(root);
  const listeners = new Set<(state: string) => void>();
  let watcher: FSWatcher | null = null;

  const headers = {
    "content-type": "application/json",
    // Nothing here should ever be cached: the whole point is that it changes.
    "cache-control": "no-store",
  };

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      // Rule 9. Explicitly loopback, never the default any-interface.
      hostname: "127.0.0.1",
      port: options.port,
      idleTimeout: 0,
      fetch: async (request) => {
        const { pathname } = new URL(request.url);

        if (pathname === "/graph") {
          return new Response(await readState(paths), { headers });
        }

        if (pathname === "/events") {
          const stream = new ReadableStream({
            start: (controller) => {
              const send = (state: string) => {
                controller.enqueue(new TextEncoder().encode(`data: ${state}\n\n`));
              };
              listeners.add(send);
              request.signal.addEventListener("abort", () => {
                listeners.delete(send);
                controller.close();
              });
            },
          });
          return new Response(stream, {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-store",
              connection: "keep-alive",
            },
          });
        }

        if (pathname === "/") {
          return new Response(DIAGNOSTIC_PAGE, {
            headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
          });
        }

        return new Response("not found", { status: 404 });
      },
    });
  } catch (cause) {
    io.err(
      `REFUSED PORT_UNAVAILABLE could not bind 127.0.0.1:${options.port}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return null;
  }

  // File-watch plus poll, per rule 10. The log only ever grows, so any change is a new
  // version — `size:mtime` is enough to notice one.
  let signature = "";
  let pending: ReturnType<typeof setTimeout> | null = null;

  const check = (): void => {
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      void (async () => {
        let next: string;
        try {
          const info = await stat(paths.log);
          next = `${info.size}:${info.mtimeMs}`;
          if (next === signature) return;
        } catch {
          return;
        }
        let state: string;
        try {
          state = await readState(paths);
        } catch {
          // A read that raced an append; the next tick picks it up.
          return;
        }
        signature = next;
        for (const send of listeners) send(state);
      })();
    }, WATCH_DEBOUNCE_MS);
  };

  watcher = watch(paths.log, check);
  const poller = setInterval(check, POLL_INTERVAL_MS);
  // Never hold a process open just to poll.
  poller.unref?.();

  const url = `http://127.0.0.1:${server.port}`;
  io.out(
    options.json
      ? JSON.stringify({ ok: true, url, graph: `${url}/graph`, events: `${url}/events` })
      : `kona view on ${url}  ·  ${url}/graph  ·  localhost only, zero outbound calls`,
  );

  return {
    url,
    stop: async () => {
      if (pending !== null) clearTimeout(pending);
      clearInterval(poller);
      watcher?.close();
      listeners.clear();
      await server.stop(true);
    },
  };
}

export async function runView(io: Io, options: ViewOptions): Promise<number> {
  const running = await startView(io, options);
  if (running === null) return EXIT_REFUSED;
  // Hold the process open. `kona view` is user-run and ends when the user ends it.
  await new Promise<never>(() => undefined);
  return 0;
}
