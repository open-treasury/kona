/**
 * `kona view` — the localhost server behind the viewer (§6.8, §6.10).
 *
 * Two properties carry the weight: it serves the SAME payload the CLI prints, so rule 10's
 * "one read contract" is literally true rather than aspirational; and it binds loopback
 * only, because a graph full of real names and real addresses must not be reachable from
 * whatever network the machine is on.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { GraphProjection, MutationRecord } from "@kona/core";
import { run } from "../src/cli.ts";
import { type RunningView, DEFAULT_VIEW_PORT, startView } from "../src/commands/view.ts";
import { harness, type Harness } from "./harness.ts";

let h: Harness;
let view: RunningView | null = null;

const PLAN = [
  {
    op: "add_node",
    label: "Confirm roster",
    type: "task",
    spec: { instruction: "Read the roster.", effect_class: "pure" },
  },
];

/**
 * Port 0 — the OS picks a free one and `startView` reports it back.
 *
 * A fixed port here is not merely flaky: Stryker runs eight sandboxes at once, all of them
 * `bun test`, so a fixed port makes every concurrent run fail, every mutant look killed,
 * and the mutation score read a meaningless 100%. A broken suite scores perfectly.
 */
const EPHEMERAL = 0;

function portOf(url: string): number {
  return Number(new URL(url).port);
}

beforeEach(async () => {
  h = harness();
  expect(await run(["init"], h.io)).toBe(0);
  const ops = h.writeOps("ops.json", PLAN);
  expect(
    await run(["mutate", "--ops", ops, "--base-version", "0", "--why", "plan", "--reason-code", "MISSING_STEP"], h.io),
  ).toBe(0);
  h.reset();
});

afterEach(async () => {
  await view?.stop();
  view = null;
  h.cleanup();
});

async function serve(port = EPHEMERAL): Promise<RunningView> {
  const started = await startView(h.io, { port, json: false });
  if (started === null) throw new Error(`view refused to start: ${h.err.join("; ")}`);
  view = started;
  return started;
}

type State = GraphProjection & { history: MutationRecord[]; torn_tail: boolean; damaged: unknown[] };

describe("it serves the one read contract", () => {
  test("/graph is the same payload the CLI prints", async () => {
    const running = await serve();
    const served = (await (await fetch(`${running.url}/graph`)).json()) as State;

    h.reset();
    expect(await run(["graph", "--json", "--history"], h.io)).toBe(0);
    const printed = JSON.parse(h.out[0] ?? "{}") as State;

    expect(served).toEqual(printed);
  });

  test("it carries the history, which is what the timeline panel renders", async () => {
    const running = await serve();
    const state = (await (await fetch(`${running.url}/graph`)).json()) as State;
    expect(state.history.map((r) => r.v)).toEqual([0, 1]);
    expect(state.history[1]?.rationale.why).toBe("plan");
    expect(state.history[1]?.rationale.reason_code).toBe("MISSING_STEP");
  });

  test("nothing is cached — the whole point is that it changes", async () => {
    const running = await serve();
    const response = await fetch(`${running.url}/graph`);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("the diagnostic page is served at the root, and says it is not the viewer", async () => {
    const running = await serve();
    const html = await (await fetch(running.url)).text();
    expect(html).toContain("diagnostic view");
    expect(html).toContain("viewer package is not built");
  });

  test("anything else is 404, because there is no query language", async () => {
    const running = await serve();
    expect((await fetch(`${running.url}/nodes/ask-dana`)).status).toBe(404);
    expect((await fetch(`${running.url}/query?q=1`)).status).toBe(404);
  });
});

describe("file-watch pushes the change", () => {
  test("a commit reaches an open /events stream", async () => {
    const running = await serve();
    const response = await fetch(`${running.url}/events`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = (response.body ?? new ReadableStream()).getReader();
    // Drain until the version we are waiting for arrives. A client must tolerate an
    // extra push; asserting on exactly the first one would test the debounce, not the feed.
    const pushed = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
        let end = buffer.indexOf("\n\n");
        while (end !== -1) {
          const frame = buffer.slice("data: ".length, end);
          buffer = buffer.slice(end + 2);
          if ((JSON.parse(frame) as State).version === 2) return frame;
          end = buffer.indexOf("\n\n");
        }
      }
    })();

    const ops = h.writeOps("more.json", [
      { op: "set_status", node: "confirm-roster", status: "done", evidence_ref: "e" },
    ]);
    expect(
      await run(["mutate", "--ops", ops, "--base-version", "1", "--why", "read it", "--reason-code", "OTHER"], h.io),
    ).toBe(0);

    const payload = await pushed;
    expect(payload).not.toBeNull();
    const state = JSON.parse(payload ?? "{}") as State;
    expect(state.version).toBe(2);
    expect(state.nodes[0]?.status.state).toBe("done");

    await reader.cancel();
  });
});

describe("localhost only (rule 9)", () => {
  test("it reports a loopback URL, never a routable one", async () => {
    const running = await serve();
    expect(running.url).toStartWith("http://127.0.0.1:");
    expect(portOf(running.url)).toBeGreaterThan(0);
    expect(h.out[0]).toContain("localhost only, zero outbound calls");
  });

  test("--json reports the endpoints a viewer needs", async () => {
    const started = await startView(h.io, { port: EPHEMERAL, json: true });
    if (started === null) throw new Error("refused");
    view = started;
    expect(JSON.parse(h.out[0] ?? "{}")).toEqual({
      ok: true,
      url: started.url,
      graph: `${started.url}/graph`,
      events: `${started.url}/events`,
    });
  });

  test("the default port is fixed, so the viewer can assume it", () => {
    expect(DEFAULT_VIEW_PORT).toBe(7373);
  });
});

describe("it refuses rather than serving nothing", () => {
  test("outside a pursuit", async () => {
    const outside = harness();
    try {
      expect(await startView(outside.io, { port: EPHEMERAL, json: false })).toBeNull();
      expect(outside.err[0]).toContain("NO_PURSUIT");
    } finally {
      outside.cleanup();
    }
  });

  test("when the port is taken", async () => {
    const first = await serve();
    h.reset();
    expect(await startView(h.io, { port: portOf(first.url), json: false })).toBeNull();
    expect(h.err[0]).toContain("PORT_UNAVAILABLE");
  });

  test("a nonsense --port is refused by the flag check", async () => {
    h.reset();
    expect(await run(["view", "--port", "not-a-port"], h.io)).toBe(1);
    expect(h.err[0]).toContain("BAD_FLAG");
  });
});

describe("a damaged log is served as damaged, not hidden", () => {
  test("the payload says so rather than pretending the graph is whole", async () => {
    const log = join(h.dir, ".kona", "mutations.jsonl");
    const lines = (await Bun.file(log).text()).trim().split("\n");
    writeFileSync(log, `${lines[0]}\n{"v":1,"broken":true}\n${lines[1]}\n`);
    const running = await serve();
    const state = (await (await fetch(`${running.url}/graph`)).json()) as State;
    expect(state.damaged).toHaveLength(1);
  });
});
