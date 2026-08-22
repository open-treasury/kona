/**
 * The server's half of §6.10 rules 9 and 10, exercised over a real socket.
 *
 * Everything here is a claim that only a running server can be asked about. "Localhost only"
 * is not a property of a constant — a laptop with `hostname: "0.0.0.0"` and a laptop bound to
 * loopback pass identical unit tests — and neither is "the bytes on the wire are the bytes on
 * disk". The interesting failure is the quiet one: a viewer that still renders perfectly while
 * serving somebody else's browser, so the assertions below are about who gets an answer at
 * all, not about what the answer looks like.
 *
 * Every server is started with `port: 0` and stopped in a `finally`. A leaked `fs.watch` or a
 * live SSE stream holds the event loop open and `bun test` hangs with every test already
 * green, which is the least debuggable way for this file to fail.
 */

import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldLog } from "@kona/core";
import type { ServeOptions, ServedViewer } from "../src/server/index.ts";
import { serveViewer } from "../src/server/index.ts";
import { LOG_PATH, headVersion, logText } from "./fixture.ts";

/**
 * A viewer pointed at the committed fixture, for the length of one test.
 *
 * `LOG_PATH` is a log file, not a pursuit root: the fixture lives where the binary wrote it
 * and `readLog` takes a log path directly rather than making us fake a `.kona/` around it.
 * That the served bytes match it is the proof that this is still true.
 */
async function withViewer(run: (served: ServedViewer) => Promise<void>): Promise<void> {
  const served = await serveViewer({ root: LOG_PATH, port: 0 });
  try {
    await run(served);
  } finally {
    await served.stop();
  }
}

/** The URL a legitimate client would use: our own address, port and all. */
function at(served: ServedViewer, path: string): URL {
  return new URL(path, served.url);
}

describe("the interface it binds", () => {
  test("loopback, and the URL it hands back says so", async () => {
    await withViewer(async (served) => {
      const url = new URL(served.url);

      expect(url.hostname).toBe("127.0.0.1");
      // Not vacuous: a server bound to 0.0.0.0 reports `0.0.0.0` here, which is how this
      // assertion catches the one-word change that publishes the pursuit to the room.
      expect(Number(url.port)).toBeGreaterThan(0);

      // And the address it reported is the one that answers.
      const response = await fetch(at(served, "/api/log"));
      await response.text();
      expect(response.status).toBe(200);
    });
  });

  test("a hostname handed to it is not honoured, because there is no such option", async () => {
    // `ServeOptions` has no `hostname` — that is the fix, and the cast is what tests it. A
    // deleted option stays deleted at compile time by itself; this is the only way to ask the
    // question of a running process, and it fails the moment somebody re-adds the knob.
    const widened = { root: LOG_PATH, port: 0, hostname: "0.0.0.0" } as unknown as ServeOptions;
    const served = await serveViewer(widened);
    try {
      expect(new URL(served.url).hostname).toBe("127.0.0.1");
    } finally {
      await served.stop();
    }
  });
});

describe("GET /api/log — the curl-able read contract", () => {
  test("serves the pursuit byte for byte, and it is still a pursuit", async () => {
    await withViewer(async (served) => {
      const response = await fetch(at(served, "/api/log"));
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toBe(logText());
      // The bytes being equal is the contract; folding to the fixture's own head version is
      // what makes the comparison mean something rather than "two empty strings match".
      expect(foldLog(body).graph.version).toBe(headVersion());
    });
  });

  test("is plain text and uncacheable — a log is never stale-able", async () => {
    await withViewer(async (served) => {
      const response = await fetch(at(served, "/api/log"));
      await response.text();

      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(response.headers.get("cache-control")).toBe("no-store");
      // The other half of the rebinding story: no CORS header, ever. A script on another
      // origin that asks for us by name gets an answer the browser will not let it read.
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });
  });
});

describe("the methods it does not have", () => {
  test("POST /api/log is 405, and the Allow header states the whole contract", async () => {
    await withViewer(async (served) => {
      const response = await fetch(at(served, "/api/log"), { method: "POST" });
      const body = await response.text();

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET");
      expect(body).toBe("the viewer is read-only\n");
    });
  });

  test("POST / is 405 too — the front-end route is no way in either", async () => {
    await withViewer(async (served) => {
      const response = await fetch(at(served, "/"), { method: "POST" });
      await response.text();

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET");
    });
  });
});

describe("the Host guard — DNS rebinding is the attack the bind does not stop", () => {
  /**
   * A browser will not let a page set `Host`, and it does not have to: under rebinding the
   * browser sets it to the attacker's own domain, because that is what is in the URL bar.
   * Setting it here by hand reproduces exactly the request such a page produces.
   */
  const FOREIGN = { host: "evil.example.com" };

  test("/api/log refuses a foreign Host and hands over nothing", async () => {
    await withViewer(async (served) => {
      const response = await fetch(at(served, "/api/log"), { headers: FOREIGN });
      const body = await response.text();

      expect(response.status).toBe(403);
      expect(body).not.toContain(logText());
      // One line, and it names nothing: whether a pursuit exists here is not their business.
      expect(body.trimEnd().split("\n")).toHaveLength(1);
      expect(body).not.toContain(LOG_PATH);
    });
  });

  test("/api/events refuses a foreign Host, so the stream is not the way around it", async () => {
    await withViewer(async (served) => {
      const response = await fetch(at(served, "/api/events"), { headers: FOREIGN });
      const body = await response.text();

      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).not.toContain("text/event-stream");
      expect(body).not.toContain(logText());
    });
  });

  test("the fallback refuses it as well — the guard is not one route's knowledge", async () => {
    await withViewer(async (served) => {
      const response = await fetch(at(served, "/api/log"), { method: "POST", headers: FOREIGN });
      await response.text();

      expect(response.status).toBe(403);
    });
  });

  test("all three names loopback goes by are ours, not just the one we bound", async () => {
    await withViewer(async (served) => {
      const { port } = new URL(served.url);

      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
        const response = await fetch(at(served, "/api/log"), { headers: { host } });
        expect({ host, status: response.status, body: await response.text() }).toEqual({
          host,
          status: 200,
          body: logText(),
        });
      }
    });
  });

  test("the right name on the wrong port is not us", async () => {
    await withViewer(async (served) => {
      // A second viewer, or an unrelated dev server, is a different origin — and a page that
      // reached us by guessing 4747 is exactly the thing being kept out.
      const response = await fetch(at(served, "/api/log"), { headers: { host: "127.0.0.1:1" } });
      const body = await response.text();

      expect(response.status).toBe(403);
      expect(body).not.toContain(logText());
    });
  });
});

describe("GET /api/events — the watch half of the read contract", () => {
  test("the first frame carries the whole log, JSON-encoded so newlines cannot end it", async () => {
    await withViewer(async (served) => {
      const response = await fetch(at(served, "/api/events"));
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      const stream = response.body;
      if (stream === null) throw new Error("the event stream arrived with no body");
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!buffer.includes("\n\n")) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      } finally {
        // Cancel before the server stops. A reader still attached to a stream that is being
        // torn down is the other way this file could hang.
        await reader.cancel();
      }

      const frame = buffer.slice(0, buffer.indexOf("\n\n"));
      const lines = frame.split("\n");
      // Two lines for a log with eight of its own: the JSON encoding is what stops a blank
      // line inside a rationale from terminating the message halfway through the pursuit.
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe("event: log");

      const payload = JSON.parse((lines[1] ?? "").replace(/^data: /, "")) as { text?: unknown };
      expect(payload.text).toBe(logText());
    });
  });
});

/**
 * A cursor over one open SSE stream, handing back the payload of each `event: log` frame.
 *
 * "The next thing the server said" is not "the next chunk that arrived": a frame ends at a
 * blank line and may be split across reads, and a keepalive is a bare comment carrying no
 * message at all. This buffers until a whole frame is there and steps over anything that is
 * not a log.
 */
function logFrames(stream: ReadableStream<Uint8Array>): {
  next: () => Promise<string>;
  cancel: () => Promise<void>;
} {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function next(): Promise<string> {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("the stream ended before the next log frame arrived");
        buffer += decoder.decode(chunk.value, { stream: true });
        continue;
      }
      const lines = buffer.slice(0, boundary).split("\n");
      buffer = buffer.slice(boundary + 2);
      if (lines[0] !== "event: log") continue;

      const payload = JSON.parse((lines[1] ?? "").replace(/^data: /, "")) as { text?: unknown };
      if (typeof payload.text !== "string") throw new Error("a log frame with no text in it");
      return payload.text;
    }
  }

  return {
    next,
    cancel: async () => {
      try {
        await reader.cancel();
      } catch {
        // The socket is already gone — which is the thing under test below, and reporting it
        // a second time out of a `finally` would bury the assertion that caught it first.
      }
    },
  };
}

/** Past the ten-second cliff with room to spare, and short enough to still be a test. */
const IDLE_HOLD_MS = 12_000;

describe("an idle /api/events stream — the connection has to outlive the silence", () => {
  /**
   * The slowest test in this repository by an order of magnitude, on purpose: a ten-second
   * cliff can only be observed by standing past it.
   *
   * `Bun.serve` closes an idle connection after ten seconds unless it is told not to, and an
   * SSE feed between mutations is idle by definition — nobody appends to a pursuit while
   * somebody is explaining the graph it already shows. `idleTimeout: 0` is the whole of the
   * fix and nothing else here would notice it changing back, because every other test in this
   * file finishes in milliseconds and the teardown lands long after the last assertion.
   *
   * What the regression costs is quiet, which is what makes it worth twelve seconds. The
   * browser reconnects, so it still looks like it works; what the room actually sees is the
   * status pill dropping to `reconnecting` on a ten-second loop, and a window between the
   * teardown and the reconnect in which the append the viewer exists to show lands with
   * nobody watching. `KEEPALIVE_MS` is 25s — on the wrong side of the cliff — so the
   * heartbeat cannot mask it either.
   *
   * The timeout is deliberately far larger than the wait, so a loaded machine makes this slow
   * rather than red.
   */
  test("holds past ten seconds of silence and still delivers the append that follows", async () => {
    // A real pursuit, one mutation short of the fixture's head. What gets appended below is
    // the fixture's own last line, so the mutation the stream has to deliver is one the
    // binary actually wrote rather than a line invented for the occasion.
    const full = logText();
    const lastBreak = full.trimEnd().lastIndexOf("\n");
    const beforeHead = full.slice(0, lastBreak + 1);
    const headLine = full.slice(lastBreak + 1);
    const priorVersion = foldLog(beforeHead).graph.version;
    expect(priorVersion).toBeLessThan(headVersion());

    const base = mkdtempSync(join(tmpdir(), "kona-viewer-idle-"));
    const root = join(base, "pursuit");
    const log = join(root, ".kona", "mutations.jsonl");
    mkdirSync(join(root, ".kona"), { recursive: true });
    writeFileSync(log, beforeHead);

    const served = await serveViewer({ root, port: 0 });
    const response = await fetch(at(served, "/api/events"));
    const stream = response.body;
    if (stream === null) throw new Error("the event stream arrived with no body");
    const frames = logFrames(stream);
    try {
      // Connected, and following this pursuit — not an empty canvas waiting for a change.
      const opening = await frames.next();
      expect(opening).toBe(beforeHead);
      expect(foldLog(opening).graph.version).toBe(priorVersion);
      // The mutation this test is about has genuinely not happened yet.
      expect(opening).not.toContain(headLine);

      // Now do nothing whatsoever. No request, no append, nothing that a timeout could count
      // as traffic — the connection has to survive on its own terms or not at all.
      await Bun.sleep(IDLE_HOLD_MS);

      appendFileSync(log, headLine);

      // Read until the picture changes. `fs.watch` fires more than once per logical change and
      // every frame carries the whole log, so a byte-identical re-send is noise the design
      // explicitly allows for; what has to arrive is a frame that says something new.
      let arrived = opening;
      while (arrived === opening) {
        arrived = await frames.next().catch((error: unknown) => {
          const cause = error instanceof Error ? error.message : String(error);
          throw new Error(
            `the live feed died during ${IDLE_HOLD_MS}ms of silence, so the mutation appended ` +
              `after it was never delivered — this is the demo going quiet mid-sentence, not a ` +
              `slow test. Look at \`idleTimeout\` in the \`Bun.serve\` config, which is the one ` +
              `thing standing between an SSE stream and Bun's ten-second idle cliff. ` +
              `Underlying: ${cause}`,
          );
        });
      }

      // Still the whole log every time, and now the whole log is the pursuit at head.
      expect(arrived).toBe(full);
      expect(foldLog(arrived).graph.version).toBe(headVersion());
    } finally {
      await frames.cancel();
      await served.stop();
      rmSync(base, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("a pursuit that is not there yet", () => {
  test("the server still starts, and the log route explains without naming the path", async () => {
    // `kona view` before `kona init` is a normal Thursday, not a crash. It used to be one:
    // `fs.watch` threw before `Bun.serve` was reached, so the 500 written for this exact case
    // could not be reached in this exact case. Getting a response at all is half the test.
    const base = mkdtempSync(join(tmpdir(), "kona-viewer-"));
    const missing = join(base, "not-a-pursuit");
    const served = await serveViewer({ root: missing, port: 0 });
    try {
      const response = await fetch(at(served, "/api/log"));
      const body = await response.text();

      expect(response.status).toBe(500);
      // The reason survives — this is a missing file, not "something went wrong" —
      expect(body).toContain("ENOENT");
      // — but the path does not. This string lands on a screen the viewer is projecting, and
      // an absolute path names the operator's home directory, the customer and the deal. The
      // person running it typed the path; they do not need it read back to the room.
      expect(body).not.toContain(missing);
      expect(body).not.toContain(base);
      expect(body.trimEnd().split("\n")).toHaveLength(1);
    } finally {
      await served.stop();
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("stop()", () => {
  test("really stops it: the next request has nothing to connect to", async () => {
    const served = await serveViewer({ root: LOG_PATH, port: 0 });
    let live = true;
    try {
      const before = await fetch(at(served, "/api/log"));
      await before.text();
      expect(before.status).toBe(200);

      await served.stop();
      live = false;

      await expect(fetch(at(served, "/api/log"))).rejects.toThrow();
    } finally {
      // Only if an assertion above threw before the stop under test ran. Stopping twice is
      // not the contract, so it is not what this test relies on.
      if (live) await served.stop();
    }
  });
});
