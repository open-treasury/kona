/**
 * `kona next` and `kona brief` through the real verbs.
 *
 * Both are read verbs, and both are what the plugin loop actually consumes — `next` is its
 * only source of work and `brief` is the whole interface to a node. Their exit codes carry
 * meaning: `brief` exits non-zero when preconditions are unmet, so a shell cannot dispatch
 * a node the CLI has just told it is not ready.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Brief } from "@kona/core";
import { run } from "../src/cli.ts";
import { harness, type Harness } from "./harness.ts";

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
    label: "Confirm roster",
    type: "task",
    spec: {
      instruction: "Read the roster.",
      outputs: [{ name: "availability", type: "string[]" }],
      effect_class: "pure",
    },
  },
  {
    op: "add_node",
    label: "Ask Dana",
    type: "task",
    spec: {
      instruction: "Email Dana asking if she can play Thursday.",
      inputs: [{ ref: "confirm-roster.availability" }],
      outputs: [{ name: "sent", type: "string" }],
      effect_class: "pivot",
      effect: { channel: "email", recipient_ref: "roster#dana" },
    },
  },
  { op: "add_edge", from: "$0", to: "$1" },
];

async function initWith(config: unknown): Promise<void> {
  h = harness();
  if (config === null) {
    expect(await run(["init"], h.io)).toBe(0);
  } else {
    const path = join(h.dir, "config.json");
    writeFileSync(path, JSON.stringify(config));
    expect(await run(["init", "--config", path], h.io)).toBe(0);
  }
  const ops = h.writeOps("ops.json", PLAN);
  expect(
    await run(["mutate", "--ops", ops, "--base-version", "0", "--why", "plan", "--reason-code", "MISSING_STEP"], h.io),
  ).toBe(0);
  h.reset();
}

beforeEach(async () => {
  await initWith(CONFIG);
});
afterEach(() => h.cleanup());

async function briefJson(node: string): Promise<{ code: number; brief: Brief }> {
  h.reset();
  const code = await run(["brief", node, "--json"], h.io);
  return { code, brief: JSON.parse(h.out[0] ?? "{}") as Brief };
}

/**
 * Corrupt a line that is NOT the last one. A torn FINAL line is the expected shape of a
 * crash and is not damage (§6.1) — only a mangled record in the middle is.
 */
function corruptMidLog(): void {
  const log = join(h.dir, ".kona", "mutations.jsonl");
  const lines = readFileSync(log, "utf8").trim().split("\n");
  writeFileSync(log, `${lines[0]}\n{"v":1,"broken":true}\n${lines[1]}\n`);
}

describe("kona next", () => {
  test("reports only what is ready, and says which version it read", async () => {
    expect(await run(["next"], h.io)).toBe(0);
    expect(h.out[0]).toBe("version 1 · 1 ready");
    expect(h.out.join("\n")).toContain("confirm-roster");
    expect(h.out.join("\n")).not.toContain("ask-dana");
  });

  test("marks a node that will move bytes, so the loop can gate on it", async () => {
    const ops = h.writeOps("done.json", [
      { op: "record_output", node: "confirm-roster", output_name: "availability", value: ["dana"], evidence_ref: "e" },
      { op: "set_status", node: "confirm-roster", status: "done", evidence_ref: "e" },
    ]);
    expect(
      await run(["mutate", "--ops", ops, "--base-version", "1", "--why", "read", "--reason-code", "OTHER"], h.io),
    ).toBe(0);
    h.reset();
    expect(await run(["next"], h.io)).toBe(0);
    expect(h.out.join("\n")).toContain("[pivot]");
  });

  test("says so plainly when nothing is ready", async () => {
    const ops = h.writeOps("stop.json", [
      { op: "set_status", node: "confirm-roster", status: "dropped", evidence_ref: "e" },
    ]);
    expect(
      await run(["mutate", "--ops", ops, "--base-version", "1", "--why", "stop", "--reason-code", "WITHDRAWN"], h.io),
    ).toBe(0);
    h.reset();
    expect(await run(["next"], h.io)).toBe(0);
    expect(h.out[0]).toBe("version 2 · nothing ready");
  });

  test("--json carries the whole node, not just an id", async () => {
    h.reset();
    expect(await run(["next", "--json"], h.io)).toBe(0);
    const payload = JSON.parse(h.out[0] ?? "{}") as { version: number; nodes: { id: string }[] };
    expect(payload.version).toBe(1);
    expect(payload.nodes.map((n) => n.id)).toEqual(["confirm-roster"]);
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
  test("exits 0 when preconditions are met", async () => {
    const { code, brief } = await briefJson("confirm-roster");
    expect(code).toBe(0);
    expect(brief.preconditions_satisfied.ok).toBe(true);
  });

  test("exits NON-ZERO when they are not, so a shell cannot dispatch anyway", async () => {
    const { code, brief } = await briefJson("ask-dana");
    expect(code).toBe(1);
    expect(brief.preconditions_satisfied.ok).toBe(false);
    const failing = brief.preconditions_satisfied.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failing).toEqual(["dependencies_satisfied", "inputs_resolved"]);
  });

  test("carries the effect key the executor will need to record against", async () => {
    const { brief } = await briefJson("ask-dana");
    expect(brief.effect_key).toMatch(/^ek_[0-9a-f]{16}$/);
  });

  test("a node that sends nothing carries no key and no reply address", async () => {
    const { brief } = await briefJson("confirm-roster");
    expect(brief.effect_key).toBeNull();
    expect(brief.correlation).toBeNull();
  });

  test("the human rendering shows identity, authority and every check", async () => {
    h.reset();
    expect(await run(["brief", "confirm-roster"], h.io)).toBe(0);
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
    expect(await run(["brief", "ask-dana"], h.io)).toBe(1);
    const text = h.out.join("\n");
    expect(text).toContain("ilya+kona-ask-dana@example.com");
    expect(text).toContain("[kona-ask-dana]");
    expect(text).toContain("depends on");
    expect(text).toContain("confirm-roster");
    expect(text).toContain("preconditions NOT SATISFIED");
    expect(text).toContain("FAIL");
  });

  test("it always states what may NOT be disclosed", async () => {
    h.reset();
    expect(await run(["brief", "confirm-roster"], h.io)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("NEVER");
    expect(text).toContain("deadline");
    expect(text).toContain("rationale");
  });

  test("refuses a node that does not exist", async () => {
    h.reset();
    expect(await run(["brief", "ghost"], h.io)).toBe(1);
    expect(h.err[0]).toContain("UNKNOWN_NODE");
  });

  test("needs a node id", async () => {
    h.reset();
    expect(await run(["brief"], h.io)).toBe(1);
    expect(h.err[0]).toContain("MISSING_NODE");
  });

  test("refuses outright when the pursuit has no identity", async () => {
    h.cleanup();
    await initWith(null);
    h.reset();
    expect(await run(["brief", "confirm-roster"], h.io)).toBe(1);
    expect(h.err[0]).toContain("NO_IDENTITY");
  });

  test("an unconfigured budget blocks a send — an unknown cap is not an unlimited one", async () => {
    h.cleanup();
    await initWith({ identity: CONFIG.identity });
    const { brief } = await briefJson("ask-dana");
    const budget = brief.preconditions_satisfied.checks.find((c) => c.name === "budget_remaining");
    expect(budget?.ok).toBe(false);
    expect(budget?.detail).toContain("unknown cap");
  });

  test("surfaces a damaged log rather than briefing from it", async () => {
    corruptMidLog();
    h.reset();
    expect(await run(["brief", "confirm-roster"], h.io)).toBe(1);
    expect(h.err[0]).toContain("UNPARSEABLE_RECORD");
  });
});

describe("kona init --config", () => {
  test("writes the config onto the genesis record, where it is versioned", async () => {
    const { brief } = await briefJson("confirm-roster");
    expect(brief.identity.display_name).toBe("Ilya Vorobiev");
  });

  test("refuses an unreadable config rather than starting without one", async () => {
    const fresh = harness();
    try {
      const path = join(fresh.dir, "config.json");
      writeFileSync(path, "{not json");
      expect(await run(["init", "--config", path], fresh.io)).toBe(1);
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
      expect(await run(["init", "--config", path], fresh.io)).toBe(1);
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
      expect(await run(["init", "--config", path], fresh.io)).toBe(1);
      expect(fresh.err[0]).toContain("effect_budgets");
    } finally {
      fresh.cleanup();
    }
  });
});
