/**
 * `kona next` and `kona brief` through the real verbs.
 *
 * Both are read verbs, and both are what the plugin loop actually consumes — `next` is its
 * only source of work and `brief` is the whole interface to an activity. Their exit codes carry
 * meaning: `brief` exits non-zero when preconditions are unmet, so a shell cannot dispatch
 * an activity the CLI has just told it is not ready.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Brief } from "@kona/core";
import { run } from "../src/cli.ts";
import { harness, seedRoster, type Harness } from "./harness.ts";

let h: Harness;

const CONFIG = {
  identity: {
    mailbox: "ilya@example.com",
    display_name: "Ilya Vorobiev",
    signature: "— Ilya",
    authority: "You may not commit funds.",
  },
  effect_budget: 5,
};

const PLAN = [
  {
    op: "add_node",
    name: "Confirm roster",
    type: "action",
    spec: {
      instruction: "Read the roster.",
      outputs: [{ name: "availability", type: "string[]" }],
      effect_class: "pure",
    },
  },
  {
    op: "add_node",
    name: "Ask Dana",
    type: "action",
    spec: {
      instruction: "Email Dana asking if she can play Thursday.",
      inputs: [{ ref: "confirm-roster.availability" }],
      outputs: [{ name: "sent", type: "string" }],
      effect_class: "pivot",
      effect: { channel: "email", recipient_ref: "roster#dana" },
    },
  },
  // The wait behind the send, and it is not decoration: §6.5's correlation token is the
  // WAIT's, so an ask with nothing waiting on it correctly gets no reply address at all.
  {
    op: "add_node",
    name: "Wait for Dana",
    type: "accept_event",
    spec: {
      instruction: "Await Dana's reply.",
      effect_class: "pure",
      deadline: { after: "$1", duration: "48h" },
      match: {
        kind: "event",
        conditions: [
          { kind: "reply", on: "satisfied" },
          { kind: "deadline", on: "timeout" },
        ],
      },
    },
  },
  { op: "add_node", name: "Route Dana reply", type: "decision", spec: {} },
  { op: "add_node", name: "Dana replied", type: "final", spec: {} },
  { op: "add_node", name: "Dana timed out", type: "flow_final", spec: {} },
  { op: "supersede_node", node: "roster-recorded", by: "$4" },
  { op: "add_edge", from: "roster-on-file", to: "$0" },
  { op: "add_edge", from: "$1", to: "$2" },
  { op: "add_edge", from: "$0", to: "$1" },
  { op: "add_edge", from: "$2", to: "$3" },
  { op: "add_edge", from: "$3", to: "$4", guard: { on: "satisfied" } },
  { op: "add_edge", from: "$3", to: "$5", guard: "else" },
];

async function initWith(config: unknown): Promise<void> {
  h = harness();
  if (config === null) {
    expect(await run(["init", "--prefix", "t"], h.io)).toBe(0);
  } else {
    const path = join(h.dir, "config.json");
    writeFileSync(path, JSON.stringify(config));
    expect(await run(["init", "--config", path, "--prefix", "t"], h.io)).toBe(0);
  }
  await seedRoster(h, ["dana"]);
  const ops = h.writeOps("ops.json", PLAN);
  expect(
    await run(
      [
        "mutate",
        "--ops",
        ops,
        "--base-version",
        "2",
        "--why",
        "plan",
        "--reason-code",
        "MISSING_STEP",
      ],
      h.io,
    ),
  ).toBe(0);
  h.reset();
}

beforeEach(async () => {
  await initWith(CONFIG);
});
afterEach(() => h.cleanup());

async function briefJson(activity: string): Promise<{ code: number; brief: Brief }> {
  h.reset();
  const code = await run(["brief", h.id(activity), "--json"], h.io);
  return { code, brief: JSON.parse(h.out[0] ?? "{}") as Brief };
}

/**
 * Corrupt a line that is NOT the last one. A torn FINAL line is the expected shape of a
 * crash and is not damage (6.1) — only a mangled record in the middle is.
 */
function corruptMidLog(): void {
  const log = join(h.dir, ".kona", "mutations.jsonl");
  const lines = readFileSync(log, "utf8").trim().split("\n");
  writeFileSync(log, `${lines[0]}\n{"v":1,"broken":true}\n${lines[1]}\n`);
}

describe("kona next", () => {
  test("reports only what is ready, and says which version it read", async () => {
    expect(await run(["next"], h.io)).toBe(0);
    expect(h.out[0]).toBe("version 3 · 1 ready");
    expect(h.out.join("\n")).toContain(h.id("confirm-roster"));
    expect(h.out.join("\n")).not.toContain(h.id("ask-dana"));
  });

  test("marks an activity that will move bytes, so the loop can gate on it", async () => {
    const ops = h.writeOps("done.json", [
      {
        op: "record_output",
        node: h.id("confirm-roster"),
        output_name: "availability",
        value: ["dana"],
        evidence_ref: "e",
      },
      { op: "set_status", node: h.id("confirm-roster"), status: "completed", evidence_ref: "e" },
    ]);
    expect(
      await run(
        ["mutate", "--ops", ops, "--base-version", "3", "--why", "read", "--reason-code", "OTHER"],
        h.io,
      ),
    ).toBe(0);
    h.reset();
    expect(await run(["next"], h.io)).toBe(0);
    expect(h.out.join("\n")).toContain("[pivot]");
  });

  test("says so plainly when nothing is ready", async () => {
    // `withdrawn` is the store's to write, never an author's (§6.2.1), so an author stops an
    // unclaimed activity by superseding it — the cascade reads "unclaimed" off the state it
    // finds and derives `withdrawn` itself.
    const ops = h.writeOps("stop.json", [
      { op: "set_status", node: h.id("confirm-roster"), status: "active", evidence_ref: "claim" },
      {
        op: "set_status",
        node: h.id("confirm-roster"),
        status: "terminated",
        evidence_ref: "stop",
      },
    ]);
    expect(
      await run(
        [
          "mutate",
          "--ops",
          ops,
          "--base-version",
          "3",
          "--why",
          "stop",
          "--reason-code",
          "WITHDRAWN",
        ],
        h.io,
      ),
    ).toBe(0);
    h.reset();
    expect(await run(["next"], h.io)).toBe(0);
    expect(h.out[0]).toBe("version 4 · nothing ready");
  });

  test("--json carries the whole action plus its fork and completion state", async () => {
    h.reset();
    expect(await run(["next", "--json"], h.io)).toBe(0);
    const payload = JSON.parse(h.out[0] ?? "{}") as {
      version: number;
      complete: boolean;
      nodes: { id: string; type: string; fork: string | null }[];
    };
    expect(payload.version).toBe(3);
    expect(payload.complete).toBe(false);
    expect(payload.nodes).toMatchObject([
      { id: h.id("confirm-roster"), type: "action", fork: null },
    ]);
  });

  test("does not dispatch a ready accept-event", async () => {
    const ops = h.writeOps("reach-wait.json", [
      {
        op: "record_output",
        node: h.id("confirm-roster"),
        output_name: "availability",
        value: ["dana"],
        evidence_ref: "e",
      },
      { op: "set_status", node: h.id("confirm-roster"), status: "completed", evidence_ref: "e" },
      { op: "set_status", node: h.id("ask-dana"), status: "completed", evidence_ref: "e" },
    ]);
    expect(
      await run(
        ["mutate", "--ops", ops, "--base-version", "3", "--why", "sent", "--reason-code", "OTHER"],
        h.io,
      ),
    ).toBe(0);
    h.reset();
    expect(await run(["next", "--json"], h.io)).toBe(0);
    expect(JSON.parse(h.out[0] ?? "{}")).toMatchObject({ nodes: [], complete: false });
  });

  test("reports complete when the final has been reached", async () => {
    const ops = h.writeOps("finish.json", [
      {
        op: "record_output",
        node: h.id("confirm-roster"),
        output_name: "availability",
        value: ["dana"],
        evidence_ref: "e",
      },
      { op: "set_status", node: h.id("confirm-roster"), status: "completed", evidence_ref: "e" },
      { op: "set_status", node: h.id("ask-dana"), status: "completed", evidence_ref: "e" },
      {
        op: "record_outcome",
        node: h.id("wait-for-dana"),
        verdict: "confirmed",
        evidence_ref: "e",
      },
      { op: "set_status", node: h.id("wait-for-dana"), status: "completed", evidence_ref: "e" },
    ]);
    expect(
      await run(
        [
          "mutate",
          "--ops",
          ops,
          "--base-version",
          "3",
          "--why",
          "replied",
          "--reason-code",
          "OTHER",
        ],
        h.io,
      ),
    ).toBe(0);
    h.reset();
    expect(await run(["next", "--json"], h.io)).toBe(0);
    expect(JSON.parse(h.out[0] ?? "{}")).toMatchObject({ nodes: [], complete: true });

    h.reset();
    expect(await run(["next"], h.io)).toBe(0);
    expect(h.out[0]).toEndWith("nothing ready · complete");
  });

  test("graph JSON publishes guards without leaking internal conditions", async () => {
    h.reset();
    expect(await run(["graph", "--json"], h.io)).toBe(0);
    const payload = JSON.parse(h.out[0] ?? "{}") as { edges: Record<string, unknown>[] };
    const guarded = payload.edges.find((edge) => edge.guard !== undefined);
    expect(guarded?.guard).toEqual({ on: "satisfied" });
    expect(payload.edges.some((edge) => "condition" in edge)).toBe(false);
  });

  test("refuses outside a pursuit", async () => {
    const outside = harness();
    try {
      expect(await run(["next"], outside.io)).toBe(1);
      expect(outside.err[0]).toContain("NO_PURSUIT");
    } finally {
      outside.cleanup();
    }
  });

  test("surfaces a damaged log rather than reporting a frontier from it", async () => {
    corruptMidLog();
    h.reset();
    expect(await run(["next"], h.io)).toBe(1);
    expect(h.err[0]).toContain("UNPARSEABLE_RECORD");
  });
});

describe("kona brief", () => {
  test.each(["wait-for-dana", "route-dana-reply"])(
    "refuses non-action node '%s' cleanly",
    async (slug) => {
      h.reset();
      expect(await run(["brief", h.id(slug)], h.io)).toBe(1);
      expect(h.err[0]).toContain("NOT_BRIEFABLE");
    },
  );

  test("exits 0 when preconditions are met", async () => {
    const { code, brief } = await briefJson(h.id("confirm-roster"));
    expect(code).toBe(0);
    expect(brief.preconditions_satisfied.ok).toBe(true);
  });

  test("exits NON-ZERO when they are not, so a shell cannot dispatch anyway", async () => {
    const { code, brief } = await briefJson(h.id("ask-dana"));
    expect(code).toBe(1);
    expect(brief.preconditions_satisfied.ok).toBe(false);
    const failing = brief.preconditions_satisfied.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failing).toEqual(["dependencies_satisfied", "inputs_resolved"]);
  });

  test("carries the effect key the executor will need to record against", async () => {
    const { brief } = await briefJson(h.id("ask-dana"));
    expect(brief.effect_key).toMatch(/^ek_[0-9a-f]{16}$/);
  });

  test("an activity that sends nothing carries no key and no reply address", async () => {
    const { brief } = await briefJson(h.id("confirm-roster"));
    expect(brief.effect_key).toBeNull();
    expect(brief.correlation).toBeNull();
  });

  test("the human rendering shows identity, authority and every check", async () => {
    h.reset();
    expect(await run(["brief", h.id("confirm-roster")], h.io)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("Ilya Vorobiev <ilya@example.com>");
    expect(text).toContain("You may not commit funds.");
    expect(text).toContain("preconditions SATISFIED");
    for (const name of [
      "node_live",
      "dependencies_satisfied",
      "inputs_resolved",
      "effect_slot_unfired",
      "correlation_expanded",
      "budget_remaining",
    ]) {
      expect(text).toContain(name);
    }
  });

  test("the human rendering shows the reply-to and the dependency it waits on", async () => {
    h.reset();
    expect(await run(["brief", h.id("ask-dana")], h.io)).toBe(1);
    const text = h.out.join("\n");
    // The wait's tag, not the sender's — the address `kona poll` will actually watch.
    expect(text).toContain(`ilya+kona-${h.id("wait-for-dana")}@example.com`);
    expect(text).toContain(`[kona-${h.id("wait-for-dana")}]`);
    expect(text).toContain("depends on");
    expect(text).toContain(h.id("confirm-roster"));
    expect(text).toContain("preconditions NOT SATISFIED");
    expect(text).toContain("FAIL");
  });

  test("it always states what may NOT be disclosed", async () => {
    h.reset();
    expect(await run(["brief", h.id("confirm-roster")], h.io)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("NEVER");
    expect(text).toContain("deadline");
    expect(text).toContain("rationale");
  });

  test("refuses an activity that does not exist", async () => {
    h.reset();
    expect(await run(["brief", h.id("ghost")], h.io)).toBe(1);
    expect(h.err[0]).toContain("UNKNOWN_ACTIVITY");
  });

  test("needs an activity id", async () => {
    h.reset();
    expect(await run(["brief"], h.io)).toBe(1);
    expect(h.err[0]).toContain("MISSING_NODE");
  });

  test("refuses a SEND when the pursuit has no identity", async () => {
    h.cleanup();
    await initWith(null);
    h.reset();
    expect(await run(["brief", h.id("ask-dana")], h.io)).toBe(1);
    expect(h.err[0]).toContain("NO_IDENTITY");
  });

  test("but briefs a PURE activity without one, and prints no `as` line to invent", async () => {
    h.cleanup();
    await initWith(null);
    h.reset();
    expect(await run(["brief", h.id("confirm-roster")], h.io)).toBe(0);
    const out = h.out.join("\n");
    expect(out).toContain(h.id("confirm-roster"));
    expect(out).not.toContain("  as  ");
    expect(out).not.toContain("authority");
  });

  test("an unconfigured budget blocks a send — an unknown cap is not an unlimited one", async () => {
    h.cleanup();
    await initWith({ identity: CONFIG.identity });
    const { brief } = await briefJson(h.id("ask-dana"));
    const budget = brief.preconditions_satisfied.checks.find((c) => c.name === "budget_remaining");
    expect(budget?.ok).toBe(false);
    expect(budget?.detail).toContain("unknown cap");
  });

  test("surfaces a damaged log rather than briefing from it", async () => {
    corruptMidLog();
    h.reset();
    expect(await run(["brief", h.id("confirm-roster")], h.io)).toBe(1);
    expect(h.err[0]).toContain("UNPARSEABLE_RECORD");
  });
});

describe("kona effect reserve", () => {
  test("refuses an inactive action rather than claiming blocked work", async () => {
    h.reset();
    expect(
      await run(
        [
          "effect",
          "reserve",
          h.id("ask-dana"),
          "--payload-hash",
          "sha256:blocked",
          "--why",
          "send",
        ],
        h.io,
      ),
    ).toBe(1);
    expect(h.err[0]).toContain("NOT_DISPATCHABLE");
    expect(h.err[0]).toContain("only ready actions may reserve");
  });
});

describe("kona init --config", () => {
  test("writes the config onto the genesis record, where it is versioned", async () => {
    const { brief } = await briefJson(h.id("confirm-roster"));
    expect(brief.identity?.display_name).toBe("Ilya Vorobiev");
  });

  test("refuses an unreadable config rather than starting without one", async () => {
    const fresh = harness();
    try {
      const path = join(fresh.dir, "config.json");
      writeFileSync(path, "{not json");
      expect(await run(["init", "--config", path, "--prefix", "t"], fresh.io)).toBe(1);
      expect(fresh.err[0]).toContain("UNREADABLE_CONFIG");
    } finally {
      fresh.cleanup();
    }
  });

  test("refuses a config that is the wrong shape", async () => {
    const fresh = harness();
    try {
      const path = join(fresh.dir, "config.json");
      writeFileSync(path, JSON.stringify({ identity: { mailbox: "x" } }));
      expect(await run(["init", "--config", path, "--prefix", "t"], fresh.io)).toBe(1);
      expect(fresh.err[0]).toContain("MALFORMED_CONFIG");
    } finally {
      fresh.cleanup();
    }
  });

  test("refuses an unrecognised config key rather than dropping it silently", async () => {
    const fresh = harness();
    try {
      const path = join(fresh.dir, "config.json");
      writeFileSync(path, JSON.stringify({ ...CONFIG, effect_budgets: 500 }));
      expect(await run(["init", "--config", path, "--prefix", "t"], fresh.io)).toBe(1);
      expect(fresh.err[0]).toContain("effect_budgets");
    } finally {
      fresh.cleanup();
    }
  });
});
