/**
 * `kona view` (§6.8).
 *
 * The verb serves nothing of its own any more: `packages/viewer` owns the front end and the
 * server that carries it. So what is tested here is what this verb still does — find the
 * pursuit, pass the port through, report the URL, and refuse in a way somebody can act on.
 *
 * The loader is injected, so none of this bundles React to check an error message.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { run } from "../src/cli.ts";
import { type ServeViewer, startView } from "../src/commands/view.ts";
import { harness, type Harness } from "./harness.ts";

let h: Harness;

const PLAN = [
  {
    op: "add_node",
    name: "Confirm roster",
    type: "task",
    spec: { instruction: "Read the roster.", effect_class: "pure" },
  },
];

/** Records what it was handed, and hands back a server that does nothing. */
function fakeViewer(): { serve: ServeViewer; calls: { root: string; port?: number }[]; stopped: number } {
  const state = { calls: [] as { root: string; port?: number }[], stopped: 0 };
  const serve: ServeViewer = async (config) => {
    state.calls.push(config);
    return {
      url: `http://127.0.0.1:${config.port ?? 4747}/`,
      stop: async () => {
        state.stopped += 1;
      },
    };
  };
  return { serve, ...state, get calls() { return state.calls; }, get stopped() { return state.stopped; } };
}

beforeEach(async () => {
  h = harness();
  expect(await run(["init", "--prefix", "t"], h.io)).toBe(0);
  const ops = h.writeOps("ops.json", PLAN);
  expect(
    await run(["mutate", "--ops", ops, "--base-version", "0", "--why", "plan", "--reason-code", "MISSING_STEP"], h.io),
  ).toBe(0);
  h.reset();
});
afterEach(() => h.cleanup());

describe("it hands the pursuit to the viewer", () => {
  test("passing the resolved ROOT, not the caller's cwd", async () => {
    const viewer = fakeViewer();
    const running = await startView(h.io, { json: false }, async () => viewer.serve);
    expect(running).not.toBeNull();
    expect(viewer.calls).toEqual([{ root: h.dir }]);
  });

  test("finding it from a subdirectory, the way git finds .git", async () => {
    const { mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const nested = join(h.dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    const viewer = fakeViewer();
    await startView({ ...h.io, cwd: nested }, { json: false }, async () => viewer.serve);
    expect(viewer.calls[0]?.root).toBe(h.dir);
  });

  test("omitting the port entirely when none was asked for — the viewer owns that number", async () => {
    const viewer = fakeViewer();
    await startView(h.io, { json: false }, async () => viewer.serve);
    expect(Object.keys(viewer.calls[0] ?? {})).toEqual(["root"]);
  });

  test("and passing one through when it was", async () => {
    const viewer = fakeViewer();
    await startView(h.io, { json: false, port: 4811 }, async () => viewer.serve);
    expect(viewer.calls[0]?.port).toBe(4811);
  });

  test("it reports the URL the viewer chose, never one of its own", async () => {
    const viewer = fakeViewer();
    const running = await startView(h.io, { json: false, port: 4811 }, async () => viewer.serve);
    expect(running?.url).toBe("http://127.0.0.1:4811/");
    expect(h.out[0]).toContain("http://127.0.0.1:4811/");
    expect(h.out[0]).toContain("localhost only, zero outbound calls");
  });

  test("--json gives the URL and the root", async () => {
    const viewer = fakeViewer();
    await startView(h.io, { json: true, port: 4811 }, async () => viewer.serve);
    expect(JSON.parse(h.out[0] ?? "{}")).toEqual({
      ok: true,
      url: "http://127.0.0.1:4811/",
      root: h.dir,
    });
  });

  test("stopping is the viewer's own stop", async () => {
    const viewer = fakeViewer();
    const running = await startView(h.io, { json: false }, async () => viewer.serve);
    await running?.stop();
    expect(viewer.stopped).toBe(1);
  });
});

describe("it refuses in a way somebody can act on", () => {
  test("outside a pursuit, before loading anything", async () => {
    const outside = harness();
    let loaded = false;
    try {
      const result = await startView(outside.io, { json: false }, async () => {
        loaded = true;
        return fakeViewer().serve;
      });
      expect(result).toBeNull();
      expect(outside.err[0]).toContain("NO_PURSUIT");
      // Resolve first: bundling a front end to then say there is nothing to show is waste.
      expect(loaded).toBe(false);
    } finally {
      outside.cleanup();
    }
  });

  test("when the viewer package cannot be loaded at all", async () => {
    const result = await startView(h.io, { json: false }, () => {
      throw new Error("Cannot find module '@kona/viewer'");
    });
    expect(result).toBeNull();
    expect(h.err[0]).toContain("NO_VIEWER");
    expect(h.err[0]).toContain("@kona/viewer");
  });

  test("when it loads but will not start — a taken port, say", async () => {
    const result = await startView(h.io, { json: false }, async () => async () => {
      throw new Error("EADDRINUSE 127.0.0.1:4747");
    });
    expect(result).toBeNull();
    expect(h.err[0]).toContain("VIEWER_UNAVAILABLE");
    expect(h.err[0]).toContain("EADDRINUSE");
  });

  test("a nonsense --port never reaches the viewer", async () => {
    h.reset();
    expect(await run(["view", "--port", "not-a-port"], h.io)).toBe(1);
    expect(h.err[0]).toContain("BAD_FLAG");
  });
});
