/**
 * The viewer's server: two read routes and a bundled front end, on the loopback interface.
 *
 * §6.10 rule 9 is the whole design here. A pursuit log carries counterparty names, message
 * ids and the reasons somebody gave for what they did; it is the most sensitive file in the
 * repository. So this process makes no outbound call of any kind, and it binds 127.0.0.1
 * rather than 0.0.0.0 — on a laptop on a café network those two differ by "the room can read
 * your negotiation". Convenience is not a reason to widen it, and there is no option to:
 * `ssh -L` is the answer for a remote pursuit.
 *
 * Binding loopback is not the whole of it, and thinking it was is precisely the bug. "It is on
 * 127.0.0.1" keeps the room out; it does not keep a *browser* out, and the browser is on this
 * machine. A page on any domain the attacker controls can point that domain's DNS at
 * 127.0.0.1, at which point the page is same-origin with this server and reads `/api/log` at
 * its leisure — DNS rebinding, and a fixed default port makes it one guess rather than a scan.
 * The same-origin policy is what normally stops that page, and rebinding exists to dodge it:
 * a script that asks for `127.0.0.1` by name is cross-origin, and since nothing here ever
 * sends an `access-control-allow-origin`, the browser refuses to hand over the bytes. Under
 * rebinding the browser thinks it is talking to the attacker's own origin, so it hands them
 * over happily. The one thing the attacker cannot forge is the name in the `Host` header — it
 * is whatever is in the URL bar, and for their page that is their domain. So `guardHost`
 * checks it on every route that can read the log, and that is the check that makes "localhost
 * only" true rather than merely intended.
 *
 * There is no non-GET route, and nothing below opens a file for writing. An editable canvas
 * would be a second mutator with no rationale attached (§6.10, "do not build a graph editor"),
 * and the cheapest way to never build one by accident is to have no write path at all.
 */

import index from "../../index.html";
import { readLog, watchLog } from "./logFeed.ts";

export interface ServeOptions {
  /** The pursuit root — the directory holding `.kona/` — or a log file directly. */
  root: string;
  port?: number;
  /**
   * Hot reloading and Bun's error overlay. **Off by default**, because the default caller is
   * `kona view` in front of an audience.
   *
   * React Flow's node measuring trips the browser's benign "ResizeObserver loop completed with
   * undelivered notifications" warning whenever several nodes mount at once — which is exactly
   * the fan-out moment. The overlay reports that through `window.onerror` as a full-width
   * *Runtime Error*, so the one beat the viewer exists to show would be covered by a red box
   * saying the viewer had crashed. It had not. A production bundle has no overlay.
   */
  development?: boolean;
}

export interface ServedViewer {
  url: string;
  stop: () => Promise<void>;
}

const DEFAULT_PORT = 4747;

/**
 * Loopback, never `0.0.0.0`, and not a caller's choice — `ServeOptions` deliberately has no
 * `hostname`. A knob for it reads as configuration and is not: every value other than this one
 * publishes the pursuit log to whatever network the laptop is on. See the module comment.
 */
const HOSTNAME = "127.0.0.1";

/** The three names loopback answers to. Matched against `Host`, with our real port appended. */
const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"] as const;

/**
 * A proxy, a corporate VPN or a laptop that slept will drop an idle stream without telling
 * either end. A comment line costs two bytes and keeps the connection provably alive.
 */
const KEEPALIVE_MS = 25_000;

const encoder = new TextEncoder();
const KEEPALIVE_FRAME = encoder.encode(": keepalive\n\n");

/** Every plain-text answer here — the log, the refusals, the one failure. */
const TEXT_HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "no-store",
} as const;

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-store",
  connection: "keep-alive",
} as const;

/** RFC 9110 wants an `Allow` on a 405, and it happens to state the whole contract. */
const ALLOW_GET = { allow: "GET", "content-type": "text/plain; charset=utf-8" } as const;

/**
 * The bundled front end, behind a GET-only route.
 *
 * Bun's HTML import is what bundles `index.html` and everything it reaches — no Vite, no build
 * step, and the bundle registers its own asset routes (`/_bun/client/…`) alongside whatever
 * path we mount it at. Mounting it at `/*` means a GET to any path serves the app.
 *
 * The assertion is the price of the method map, and it is worth naming. Measured on Bun 1.3.14:
 * a method a route does not declare falls through to `fetch`, and `fetch` is where the 405
 * lives — but a bare `"/*": index` declares no methods at all and answers `POST /api/log` with
 * the front end. `{ GET: index }` gets the behaviour we want and Bun honours it; the published
 * types (bun-types 1.4.0) allow a bundle only as a whole-route value, so TypeScript has to be
 * told. If a later Bun stops honouring it the page simply stops loading, which is loud.
 *
 * This is the one route `guardHost` cannot wrap, for the same reason: a bundle has to BE the
 * route value, and a handler that returns one gets Bun's built-in "Welcome to Bun!" page
 * instead (measured, 1.3.14). That is tolerable here and nowhere else — the bundle is the
 * app's own HTML, JS and CSS, byte-identical in every copy of the viewer, and it carries no
 * pursuit data. The routes that carry the log are guarded, and the app without them is an
 * empty canvas.
 */
const FRONT_END = index as unknown as Response;

/**
 * Every message carries the WHOLE log, not a byte offset from the last one.
 *
 * That is deliberate. The log is append-only but not append-only-at-the-end forever: a torn
 * tail can be rewritten, and an offset-based feed has to be right about a file that changed
 * under it between the watch event and the read. Sending the whole thing is atomic, cannot
 * race an append, and is trivially correct after a reconnect — the client throws away what it
 * had and folds again, which it can do in a millisecond.
 *
 * This stops being true at roughly a megabyte of log, which is order 10^4 mutations: a
 * pursuit that big wants a `since:` cursor and an incremental fold, and the place to add it is
 * here, not in the client. A Thursday-afternoon pursuit is eight lines.
 *
 * JSON-encoding the text also makes the frame safe: SSE terminates a message on a blank line,
 * and a log is nothing but newlines.
 */
function logFrame(text: string): Uint8Array {
  return encoder.encode(`event: log\ndata: ${JSON.stringify({ text })}\n\n`);
}

/**
 * Why a read failed, with no filesystem path in it.
 *
 * `node:fs` puts the absolute path it tried into the message — `ENOENT: no such file or
 * directory, open '/Users/…/pursuits/acme-renewal/.kona/mutations.jsonl'` — and this string
 * ends up on a screen. The viewer's whole job is to be projected at a room, and the path names
 * the operator's home directory, the customer and the deal. The errno alone is the part that
 * says what went wrong; who it happened to is not the reader's business, and the operator
 * knows the path already because they typed it.
 */
function describe(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.message : String(error);
}

/** One connected `EventSource`, as the thing we can write bytes into. */
type Client = ReadableStreamDefaultController<Uint8Array>;

export async function serveViewer(options: ServeOptions): Promise<ServedViewer> {
  const { root } = options;

  /** Every open stream. Held so `stop()` can close them; a leaked one hangs the process. */
  const clients = new Set<Client>();

  function sendTo(client: Client, frame: Uint8Array): void {
    try {
      client.enqueue(frame);
    } catch {
      // The reader went away between the watch event and this write. Nothing to report:
      // a closed tab is the normal end of a stream, not a fault.
      clients.delete(client);
    }
  }

  function broadcast(frame: Uint8Array): void {
    for (const client of clients) sendTo(client, frame);
  }

  /** Read the log once and hand it to `targets` — every open stream, or just a new one. */
  async function pushLog(targets: Iterable<Client>): Promise<void> {
    let text: string;
    try {
      text = await readLog(root);
    } catch {
      // Mid-write, or gone. Hold the last good state on the canvas rather than blanking it,
      // and let the next watch event — or `GET /api/log` — say what went wrong.
      return;
    }
    const frame = logFrame(text);
    for (const client of targets) {
      if (clients.has(client)) sendTo(client, frame);
    }
  }

  const unwatch = watchLog(root, () => {
    void pushLog(clients);
  });

  const keepalive = setInterval(() => {
    broadcast(KEEPALIVE_FRAME);
  }, KEEPALIVE_MS);
  // A heartbeat is not a reason for the process to stay up.
  keepalive.unref();

  /**
   * The one place the loopback claim is enforced. Returns the refusal, or null when the
   * request really did come to us by one of our own names.
   *
   * It is one function on purpose. The interesting property is not "the fallback checks the
   * host", it is "no route answers without checking", and that is only readable if there is a
   * single thing to read. See the module comment for why the bind is not enough on its own.
   *
   * `server.port` rather than the requested one: `port: 0` asks the OS to pick, and the guard
   * has to know the port we actually got or every request fails its own check.
   */
  function guardHost(request: Request): Response | null {
    const host = (request.headers.get("host") ?? "").toLowerCase();
    const ours = LOOPBACK_NAMES.some((name) => host === `${name}:${server.port}`);
    if (ours) return null;
    // Deliberately says nothing about what is here. A page that reached this line is not
    // entitled to know whether a pursuit exists, let alone which one.
    return new Response("the viewer answers on loopback only\n", {
      status: 403,
      headers: TEXT_HEADERS,
    });
  }

  function eventStream(request: Request): Response {
    const refusal = guardHost(request);
    if (refusal !== null) return refusal;

    let mine: Client | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        mine = controller;
        clients.add(controller);
        // Send the current log immediately, so a viewer that connects between mutations sees
        // the pursuit rather than an empty canvas waiting for someone to change something.
        void pushLog([controller]);
      },
      cancel() {
        if (mine !== null) clients.delete(mine);
      },
    });
    return new Response(body, { headers: SSE_HEADERS });
  }

  /**
   * The log, as bytes, for anyone who would rather read it than watch it.
   *
   * The front end never calls this — `src/feed/useLog.ts` opens `/api/events` and nothing else
   * — and that is not a reason to delete it. §6.10 rule 10 names the log plus a watch on it as
   * the one read contract, and this route is that contract in the form a person can check:
   * `curl 127.0.0.1:4747/api/log | kona graph --json -` against the file on disk. It is also
   * how `test/server.test.ts` asserts, byte for byte, that the server serves the pursuit it
   * was pointed at rather than something it composed.
   */
  async function serveLog(request: Request): Promise<Response> {
    const refusal = guardHost(request);
    if (refusal !== null) return refusal;

    try {
      return new Response(await readLog(root), { headers: TEXT_HEADERS });
    } catch (error) {
      // No path in the body: see `describe`. The reader knows where they pointed it.
      return new Response(`cannot read the log: ${describe(error)}\n`, {
        status: 500,
        headers: TEXT_HEADERS,
      });
    }
  }

  const server = Bun.serve({
    hostname: HOSTNAME,
    port: options.port ?? DEFAULT_PORT,
    development: options.development ?? false,
    // `Bun.serve` closes an idle connection after 10 seconds by default, and an SSE stream
    // between mutations is idle by definition. Left alone the feed is torn down every ten
    // seconds for the whole of a demo — the browser reconnects, so it looks like it works,
    // and what you actually see is the status pill flicking to `lost` on a loop and a
    // reconnect window in which an append lands unseen. Observed as
    // `[Bun.serve]: request timed out after 10 seconds` on the server's own stdout.
    //
    // The keepalive comment below is the tempting fix and it is not one: a heartbeat shorter
    // than the timeout papers over it and leaves the viewer's liveness resting on a race. This
    // is a loopback, read-only, single-operator server. There is nothing here for a timeout to
    // protect against.
    idleTimeout: 0,
    routes: {
      "/api/log": { GET: serveLog },
      "/api/events": { GET: eventStream },
      "/*": { GET: FRONT_END },
    },
    // Nothing but GET matches anything above, so this is reached only by a method the viewer
    // does not have. There is no write path to fall back TO; saying so is the point. The host
    // is checked first even here: a 405 is a small thing to tell a stranger, but the rule is
    // that no route answers a request that did not come to us by our own name.
    fetch: (request) =>
      guardHost(request) ??
      new Response("the viewer is read-only\n", { status: 405, headers: ALLOW_GET }),
  });

  async function stop(): Promise<void> {
    unwatch();
    clearInterval(keepalive);
    for (const client of clients) {
      try {
        client.close();
      } catch {
        // Already closed by the reader. Fine — we only need it gone from the set.
      }
    }
    clients.clear();
    await server.stop(true);
  }

  return { url: server.url.href, stop };
}
