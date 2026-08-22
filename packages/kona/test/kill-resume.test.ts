/**
 * Kill and resume (7's integration table, 8's Definition of Done).
 *
 * A process cannot kill itself mid-syscall inside a test, so what is simulated here is the
 * exact *state a crash leaves behind* — which is the thing that actually has to be
 * survivable:
 *
 *   - a torn final line   crash between append and fsync
 *   - a stale lockfile    crash while holding the write lock
 *   - a `sending` node    crash between reserve and record
 *
 * Every assertion is made through a FRESH `Io` against the same directory: no session
 * state, nothing carried in memory, exactly what "a fresh terminal" means in 8.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphProjection } from "@kona/core";
import { run } from "../src/cli.ts";
import { effectKey } from "../src/hash.ts";
import { harness, seedRoster, type Harness } from "./harness.ts";

let h: Harness;

const T0 = "2026-08-21T12:00:00.000Z";
const AFTER_DEADLINE = "2026-08-30T12:00:00.000Z";

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
    label: "Escalate",
    type: "task",
    spec: { instruction: "Tell Ilya nobody replied.", effect_class: "pure" },
  },
  {
    op: "add_node",
    label: "Ask Dana",
    type: "task",
    spec: {
      instruction: "Email Dana.",
      outputs: [{ name: "sent", type: "string" }],
      effect_class: "pivot",
      effect: { channel: "email", recipient_ref: "roster#dana" },
    },
  },
  {
    op: "add_node",
    label: "Wait for Dana",
    type: "wait",
    spec: {
      instruction: "Await Dana's reply.",
      effect_class: "pure",
      deadline: { at: "2026-08-23T12:00:00.000Z" },
      on_timeout: "$0",
      match: { kind: "event", conditions: [{ kind: "reply", on: "satisfied" }] },
    },
  },
  { op: "add_edge", from: "$1", to: "$2" },
];

/** `ask-dana` is created at v3 now: the roster seed takes v1 and v2. */
const KEY = effectKey("ask-dana", 3);

/** A brand-new process, same directory. No session state crosses this boundary. */
function freshTerminal(now = T0): Harness {
  const fresh = harness(now);
  return { ...fresh, io: { ...fresh.io, cwd: h.dir, pid: fresh.io.pid + 1 } };
}

function logPath(): string {
  return join(h.dir, ".kona", "mutations.jsonl");
}

function logLines(): string[] {
  return readFileSync(logPath(), "utf8").trim().split("\n");
}

async function graphOf(term: Harness): Promise<GraphProjection> {
  term.reset();
  expect(await run(["graph", "--json"], term.io)).toBe(0);
  return JSON.parse(term.out[0] ?? "{}") as GraphProjection;
}

beforeEach(async () => {
  h = harness(T0);
  const config = join(h.dir, "config.json");
  writeFileSync(config, JSON.stringify(CONFIG));
  expect(await run(["init", "--config", config], h.io)).toBe(0);
  await seedRoster(h, ["dana"]);
  const ops = h.writeOps("ops.json", PLAN);
  expect(
    await run(["mutate", "--ops", ops, "--base-version", "2", "--why", "plan", "--reason-code", "MISSING_STEP"], h.io),
  ).toBe(0);
  h.reset();
});
afterEach(() => h.cleanup());

describe("crash between append and fsync — a torn final line", () => {
  test("a fresh terminal reads the pursuit and makes progress", async () => {
    appendFileSync(logPath(), '{"v":2,"schema_ver');
    const term = freshTerminal();
    expect(await run(["resume"], term.io)).toBe(0);
    expect(term.out.join("\n")).toContain("version 3");
    // And the next write lands at the version the torn record never reached.
    const ops = h.writeOps("more.json", [
      { op: "set_status", node: "escalate", status: "done", evidence_ref: "e" },
    ]);
    expect(
      await run(["mutate", "--ops", ops, "--base-version", "3", "--why", "done", "--reason-code", "OTHER"], term.io),
    ).toBe(0);
    expect(JSON.parse(logLines().at(-1) ?? "").v).toBe(4);
  });

  test("the torn bytes are neither folded nor silently kept", async () => {
    appendFileSync(logPath(), '{"v":2,"schema_ver');
    const graph = await graphOf(freshTerminal());
    expect(graph.version).toBe(3);
    expect((graph as unknown as { torn_tail: boolean }).torn_tail).toBe(true);
    expect((graph as unknown as { damaged: unknown[] }).damaged).toEqual([]);
  });
});

describe("crash while holding the write lock", () => {
  function leaveStaleLock(): void {
    writeFileSync(join(h.dir, ".kona", "lock"), JSON.stringify({ pid: 999, started_at: T0 }));
  }

  async function tryWrite(term: Harness): Promise<number> {
    const ops = h.writeOps("more.json", [
      { op: "set_status", node: "escalate", status: "done", evidence_ref: "e" },
    ]);
    return await run(
      ["mutate", "--ops", ops, "--base-version", "3", "--why", "after crash", "--reason-code", "OTHER"],
      term.io,
    );
  }

  test("reading still works — a stale lock blocks writes, never reads", async () => {
    leaveStaleLock();
    const term = freshTerminal(AFTER_DEADLINE);
    expect(await run(["graph", "--json"], term.io)).toBe(0);
    term.reset();
    expect(await run(["next"], term.io)).toBe(0);
  });

  test("a write is refused, and NOT by silently taking the lock", async () => {
    // Reclaiming automatically cannot be made safe: the check that judges a lock stale
    // and the removal that takes it are two operations, so a second writer can move a
    // FRESH lock aside and both end up appending to one log.
    leaveStaleLock();
    const term = freshTerminal(AFTER_DEADLINE);
    expect(await tryWrite(term)).toBe(1);
    expect(term.err[0]).toContain("STALE_LOCK");
    expect(logLines()).toHaveLength(4);
  });

  test("the refusal tells the operator what to check and what to do", async () => {
    leaveStaleLock();
    const term = freshTerminal(AFTER_DEADLINE);
    await tryWrite(term);
    expect(term.err[0]).toContain("no longer running");
    expect(term.err[0]?.toLowerCase()).toContain("delete the file");
    expect(term.err[0]).toContain("999");
  });

  test("a holder that is gone is STALE at once, without waiting out the timer", async () => {
    // The kill rehearsal's finding. Pid 999 is not a running process, and until the liveness
    // probe existed the answer for the first thirty seconds was "another writer holds it" —
    // naming a corpse in exactly the window a crash gets discovered in.
    leaveStaleLock();
    const term = freshTerminal(T0); // the same instant the lock was taken: age says fresh
    expect(await tryWrite(term)).toBe(1);
    expect(term.err[0]).toContain("STALE_LOCK");
    expect(term.err[0]).toContain("that process is gone");
  });

  test("and once it is cleared, the pursuit continues exactly where it was", async () => {
    leaveStaleLock();
    const term = freshTerminal(AFTER_DEADLINE);
    expect(await tryWrite(term)).toBe(1);
    rmSync(join(h.dir, ".kona", "lock"));
    term.reset();
    expect(await tryWrite(term)).toBe(0);
    expect(JSON.parse(logLines().at(-1) ?? "").v).toBe(4);
  });

  test("a lock held right now is a different message — a slow peer is not a dead one", async () => {
    // A lock claiming THIS process, which is unarguably running. That is what separates the
    // two messages now: not the clock, but whether anybody is there.
    writeFileSync(join(h.dir, ".kona", "lock"), JSON.stringify({ pid: process.pid, started_at: T0 }));
    const term = freshTerminal(T0);
    expect(await tryWrite(term)).toBe(1);
    expect(term.err[0]).toContain("LOCK_HELD");
    expect(term.err[0]).toContain("still running");
    expect(term.err[0]?.toLowerCase()).not.toContain("delete the file");
  });
});

describe("crash between reserve and record — the send is unknown", () => {
  async function reserveThenCrash(): Promise<void> {
    expect(
      await run(["effect", "reserve", "ask-dana", "--payload-hash", "sha256:aaa", "--why", "send"], h.io),
    ).toBe(0);
    h.reset();
  }

  test("resume surfaces it for a human and RE-SENDS NOTHING", async () => {
    await reserveThenCrash();
    const term = freshTerminal();
    expect(await run(["resume"], term.io)).toBe(0);
    const text = term.out.join("\n");
    expect(text).toContain("NEEDS A HUMAN");
    expect(text).toContain("ask-dana");
    expect(text).toContain(KEY);
    expect(text).toContain("check the mailbox");
  });

  test("resume does not repair it — the log cannot tell sent from unsent", async () => {
    await reserveThenCrash();
    const before = logLines().length;
    const term = freshTerminal();
    expect(await run(["resume"], term.io)).toBe(0);
    expect(logLines().length).toBe(before);
  });

  test("the node is not offered as work", async () => {
    await reserveThenCrash();
    const term = freshTerminal();
    expect(await run(["next", "--json"], term.io)).toBe(0);
    const payload = JSON.parse(term.out[0] ?? "{}") as { nodes: { id: string }[] };
    expect(payload.nodes.map((n) => n.id)).not.toContain("ask-dana");
  });

  test("and re-reserving after the crash sends nothing new", async () => {
    await reserveThenCrash();
    const term = freshTerminal();
    const before = logLines().length;
    expect(
      await run(["effect", "reserve", "ask-dana", "--payload-hash", "sha256:aaa", "--why", "retry"], term.io),
    ).toBe(0);
    expect(term.out[0]).toContain("already reserved");
    expect(logLines().length).toBe(before);
  });

  test("once a human resolves it, the pursuit continues normally", async () => {
    await reserveThenCrash();
    const term = freshTerminal();
    expect(
      await run(
        ["effect", "record", "ask-dana", "--key", KEY, "--outcome", "sent", "--message-id", "<m-1>", "--why", "found it in Sent"],
        term.io,
      ),
    ).toBe(0);
    expect((await graphOf(term)).nodes.find((n) => n.id === "ask-dana")?.status.state).toBe("done");
    term.reset();
    expect(await run(["resume"], term.io)).toBe(0);
    expect(term.out.join("\n")).not.toContain("NEEDS A HUMAN");
  });
});

describe("a fresh terminal is told what to DO, not only what is true", () => {
  test("an armed wait names the verb that reconciles it", async () => {
    // §6.7's step 3 is "reconcile waits against the world", and `resume` cannot take it: a
    // mailbox is a network call and no verb makes one. Naming `kona poll` is how the step
    // survives the split. Without it the operator is told the state and left to guess the
    // action — which is the moment somebody reaches for the graph and starts hand-editing.
    const term = freshTerminal(T0);
    expect(await run(["resume", "--dry-run"], term.io)).toBe(0);
    const text = term.out.join("\n");
    expect(text).toContain("armed waits");
    expect(text).toContain("kona poll");
    expect(text).toContain("kona poll --inbound");
  });

  test("and says nothing about polling when nothing is waiting", async () => {
    // Advice nobody can act on is noise, and this report is read at the worst moment.
    const term = freshTerminal(AFTER_DEADLINE);
    expect(await run(["resume"], term.io)).toBe(0);
    term.reset();
    expect(await run(["resume", "--dry-run"], term.io)).toBe(0);
    const text = term.out.join("\n");
    expect(text).not.toContain("armed waits");
    expect(text).not.toContain("kona poll");
  });
});

describe("resume fires overdue deadlines, and says why", () => {
  test("a blown deadline resolves the wait and opens its escape route", async () => {
    const term = freshTerminal(AFTER_DEADLINE);
    expect(await run(["resume"], term.io)).toBe(0);
    expect(term.out.join("\n")).toContain("OVERDUE");
    expect(term.out.join("\n")).toContain("repaired at v4");

    const graph = await graphOf(term);
    const gate = graph.nodes.find((n) => n.id === "wait-for-dana");
    expect(gate?.status.state).toBe("done");
    expect(gate?.status.outcome?.verdict).toBe("timed_out");
    expect(graph.edges).toContainEqual({
      from: "wait-for-dana",
      to: "escalate",
      condition: { on: "timeout" },
    });
  });

  test("the repair is a logged mutation carrying its own rationale", async () => {
    const term = freshTerminal(AFTER_DEADLINE);
    expect(await run(["resume"], term.io)).toBe(0);
    const repair = JSON.parse(logLines().at(-1) ?? "");
    expect(repair.actor).toEqual({ kind: "orchestrator", id: "resume" });
    expect(repair.rationale.reason_code).toBe("DEADLINE_PASSED");
    expect(repair.rationale.why).toContain("wait-for-dana");
    expect(repair.outcome).toBeNull();
  });

  test("it is idempotent — running it twice repairs once", async () => {
    const term = freshTerminal(AFTER_DEADLINE);
    expect(await run(["resume"], term.io)).toBe(0);
    const after = logLines().length;
    term.reset();
    expect(await run(["resume"], term.io)).toBe(0);
    expect(logLines().length).toBe(after);
    expect(term.out.join("\n")).toContain("nothing to repair");
  });

  test("--dry-run shows the repair without writing it", async () => {
    const term = freshTerminal(AFTER_DEADLINE);
    const before = logLines().length;
    expect(await run(["resume", "--dry-run"], term.io)).toBe(0);
    expect(term.out.join("\n")).toContain("would repair");
    expect(logLines().length).toBe(before);
  });

  test("nothing is repaired before the deadline", async () => {
    const term = freshTerminal(T0);
    expect(await run(["resume"], term.io)).toBe(0);
    expect(term.out.join("\n")).toContain("nothing to repair");
    expect(term.out.join("\n")).not.toContain("OVERDUE");
  });
});

describe("a done node is never re-executed", () => {
  test("resume does not touch it, whatever the clock says", async () => {
    const ops = h.writeOps("done.json", [
      { op: "set_status", node: "escalate", status: "done", evidence_ref: "e" },
    ]);
    expect(
      await run(["mutate", "--ops", ops, "--base-version", "3", "--why", "did it", "--reason-code", "OTHER"], h.io),
    ).toBe(0);
    const term = freshTerminal(AFTER_DEADLINE);
    expect(await run(["resume"], term.io)).toBe(0);
    const graph = await graphOf(term);
    expect(graph.nodes.find((n) => n.id === "escalate")?.status.state).toBe("done");
    expect(await run(["next", "--json"], term.io)).toBe(0);
  });
});

describe("a damaged log is reported, not read through", () => {
  test("resume refuses rather than reporting a status it cannot vouch for", async () => {
    const lines = logLines();
    writeFileSync(logPath(), `${lines[0]}\n{"v":1,"broken":true}\n${lines[1]}\n`);
    const term = freshTerminal();
    expect(await run(["resume"], term.io)).toBe(1);
    expect(term.err[0]).toContain("UNPARSEABLE_RECORD");
    expect(term.out.join("\n")).toContain("damaged record");
  });
});
