/**
 * Kill and resume (7's integration table, 8's Definition of Done).
 *
 * A process cannot kill itself mid-syscall inside a test, so what is simulated here is the
 * exact *state a crash leaves behind* — which is the thing that actually has to be
 * survivable:
 *
 *   - a torn final line   crash between append and fsync
 *   - a stale lockfile    crash while holding the write lock
 *   - an `active` activity    crash between reserve and record
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
    name: "Ask Dana",
    type: "action",
    spec: {
      instruction: "Email Dana.",
      outputs: [{ name: "sent", type: "string" }],
      effect_class: "pivot",
      effect: { channel: "email", recipient_ref: "roster#dana" },
    },
  },
  {
    op: "add_node",
    name: "Wait for Dana",
    type: "accept_event",
    spec: {
      instruction: "Await Dana's reply.",
      effect_class: "pure",
      deadline: { at: "2026-08-23T12:00:00.000Z" },
      match: { kind: "event", conditions: [{ kind: "reply", on: "satisfied" }] },
    },
  },
  { op: "add_node", name: "Route Dana reply", type: "decision", spec: {} },
  { op: "add_node", name: "Dana replied", type: "flow_final", spec: {} },
  {
    op: "add_node",
    name: "Escalate",
    type: "action",
    spec: { instruction: "Tell Ilya nobody replied.", effect_class: "pure" },
  },
  { op: "add_node", name: "Escalated", type: "final", spec: {} },
  { op: "add_node", name: "Dana reply ignored", type: "flow_final", spec: {} },
  { op: "supersede_node", node: "roster-recorded", by: "$5" },
  { op: "add_edge", from: "roster-on-file", to: "$0" },
  { op: "add_edge", from: "$0", to: "$1" },
  { op: "add_edge", from: "$1", to: "$2" },
  { op: "add_edge", from: "$2", to: "$3", guard: { on: "satisfied" } },
  { op: "add_edge", from: "$2", to: "$4", guard: { on: "timeout" } },
  { op: "add_edge", from: "$2", to: "$6", guard: "else" },
  { op: "add_edge", from: "$4", to: "$5" },
];

/** `ask-dana` is created at v3 now: the roster seed takes v1 and v2. */
// The effect key is derived from the activity id, and the id is minted — so this cannot be
// computed until a pursuit exists. A function, evaluated inside the test.
const KEY = (): string => effectKey(h.id("ask-dana"), 3);

/**
 * Cross the send, so that the wait behind it is ARMED.
 *
 * A wait is armed only in `ready`, and readiness is DERIVED at commit — so `wait-for-dana`
 * sits `inactive` until `ask-dana` completes. Under the old vocabulary an unclaimed wait was
 * `active` from the moment it was authored, so its deadline could fire on a message that had
 * never gone anywhere. Two commits, v4 and v5: reserve, then record the outcome.
 */
async function crossTheSend(): Promise<void> {
  expect(
    await run(
      ["effect", "reserve", h.id("ask-dana"), "--payload-hash", "sha256:aaa", "--why", "send"],
      h.io,
    ),
  ).toBe(0);
  expect(
    await run(
      [
        "effect",
        "record",
        h.id("ask-dana"),
        "--key",
        KEY(),
        "--outcome",
        "sent",
        "--message-id",
        "<m-1>",
        "--why",
        "Dana has it",
      ],
      h.io,
    ),
  ).toBe(0);
  h.reset();
}

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
  expect(await run(["init", "--config", config, "--prefix", "t"], h.io)).toBe(0);
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
      { op: "set_status", node: h.id("escalate"), status: "completed", evidence_ref: "e" },
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
          "completed",
          "--reason-code",
          "OTHER",
        ],
        term.io,
      ),
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
  /**
   * A pid that is genuinely GONE — probed, not picked.
   *
   * These tests go through the CLI, so the liveness check is the real `process.kill(pid, 0)`
   * with nothing to inject through. A literal is therefore a bet on the machine's process
   * table, and this file bet on 999, which on macOS is a live system daemon. Losing that bet
   * makes the crashed writer answer "still running" — the exact wrong answer this describe
   * exists to catch, arriving as a failure that looks like a bug in the lock.
   */
  const DEAD_PID = ((): number => {
    for (let pid = 99_000; pid > 1; pid -= 1) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        // ESRCH alone means gone; EPERM means it exists and belongs to somebody else.
        if ((error as { code?: string } | null)?.code === "ESRCH") return pid;
      }
    }
    throw new Error("no free pid to impersonate a crashed writer");
  })();

  function leaveStaleLock(): void {
    writeFileSync(join(h.dir, ".kona", "lock"), JSON.stringify({ pid: DEAD_PID, started_at: T0 }));
  }

  async function tryWrite(term: Harness): Promise<number> {
    const ops = h.writeOps("more.json", [
      { op: "set_status", node: h.id("escalate"), status: "completed", evidence_ref: "e" },
    ]);
    return await run(
      [
        "mutate",
        "--ops",
        ops,
        "--base-version",
        "3",
        "--why",
        "after crash",
        "--reason-code",
        "OTHER",
      ],
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
    expect(term.err[0]).toContain(String(DEAD_PID));
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
    writeFileSync(
      join(h.dir, ".kona", "lock"),
      JSON.stringify({ pid: process.pid, started_at: T0 }),
    );
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
      await run(
        ["effect", "reserve", h.id("ask-dana"), "--payload-hash", "sha256:aaa", "--why", "send"],
        h.io,
      ),
    ).toBe(0);
    h.reset();
  }

  test("resume surfaces it for a human and RE-SENDS NOTHING", async () => {
    await reserveThenCrash();
    const term = freshTerminal();
    expect(await run(["resume"], term.io)).toBe(0);
    const text = term.out.join("\n");
    expect(text).toContain("NEEDS A HUMAN");
    expect(text).toContain(h.id("ask-dana"));
    expect(text).toContain(KEY());
    expect(text).toContain("check the mailbox");
  });

  test("resume does not repair it — the log cannot tell sent from unsent", async () => {
    await reserveThenCrash();
    const before = logLines().length;
    const term = freshTerminal();
    expect(await run(["resume"], term.io)).toBe(0);
    expect(logLines().length).toBe(before);
  });

  test("the activity is not offered as work", async () => {
    await reserveThenCrash();
    const term = freshTerminal();
    expect(await run(["next", "--json"], term.io)).toBe(0);
    const payload = JSON.parse(term.out[0] ?? "{}") as { nodes: { id: string }[] };
    expect(payload.nodes.map((n) => n.id)).not.toContain(h.id("ask-dana"));
  });

  test("and re-reserving after the crash sends nothing new", async () => {
    await reserveThenCrash();
    const term = freshTerminal();
    const before = logLines().length;
    expect(
      await run(
        ["effect", "reserve", h.id("ask-dana"), "--payload-hash", "sha256:aaa", "--why", "retry"],
        term.io,
      ),
    ).toBe(0);
    expect(term.out[0]).toContain("already reserved");
    expect(logLines().length).toBe(before);
  });

  test("once a human resolves it, the pursuit continues normally", async () => {
    await reserveThenCrash();
    const term = freshTerminal();
    expect(
      await run(
        [
          "effect",
          "record",
          h.id("ask-dana"),
          "--key",
          KEY(),
          "--outcome",
          "sent",
          "--message-id",
          "<m-1>",
          "--why",
          "found it in Sent",
        ],
        term.io,
      ),
    ).toBe(0);
    expect((await graphOf(term)).nodes.find((n) => n.id === h.id("ask-dana"))?.status?.state).toBe(
      "completed",
    );
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
    await crossTheSend();
    const term = freshTerminal(T0);
    expect(await run(["resume", "--dry-run"], term.io)).toBe(0);
    const text = term.out.join("\n");
    expect(text).toContain("armed waits");
    expect(text).toContain("kona poll");
    expect(text).toContain("kona poll --inbound");
  });

  test("and says nothing about polling when nothing is waiting", async () => {
    // Advice nobody can act on is noise, and this report is read at the worst moment.
    await crossTheSend();
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
  // The deadline belongs to a wait, and a wait only counts once it is armed — so the send in
  // front of it has to have gone out. That is the state a crash is being simulated on top of.
  beforeEach(crossTheSend);

  test("a blown deadline resolves the wait and opens its escape route", async () => {
    const term = freshTerminal(AFTER_DEADLINE);
    expect(await run(["resume"], term.io)).toBe(0);
    expect(term.out.join("\n")).toContain("OVERDUE");
    // v4 reserved the send and v5 recorded it, so the repair is v6.
    expect(term.out.join("\n")).toContain("repaired at v6");

    const graph = await graphOf(term);
    const gate = graph.nodes.find((n) => n.id === h.id("wait-for-dana"));
    expect(gate?.status?.state).toBe("completed");
    expect(gate?.status?.outcome?.verdict).toBe("timed_out");
    expect(graph.edges).toContainEqual({
      from: h.id("route-dana-reply"),
      to: h.id("escalate"),
      guard: { on: "timeout" },
    });
  });

  test("the repair is a logged mutation carrying its own rationale", async () => {
    const term = freshTerminal(AFTER_DEADLINE);
    expect(await run(["resume"], term.io)).toBe(0);
    const repair = JSON.parse(logLines().at(-1) ?? "");
    expect(repair.actor).toEqual({ kind: "orchestrator", id: "resume" });
    expect(repair.rationale.reason_code).toBe("DEADLINE_PASSED");
    expect(repair.rationale.why).toContain(h.id("wait-for-dana"));
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

describe("a completed activity is never re-executed", () => {
  test("resume does not touch it, whatever the clock says", async () => {
    const ops = h.writeOps("done.json", [
      { op: "set_status", node: h.id("escalate"), status: "completed", evidence_ref: "e" },
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
          "did it",
          "--reason-code",
          "OTHER",
        ],
        h.io,
      ),
    ).toBe(0);
    const term = freshTerminal(AFTER_DEADLINE);
    expect(await run(["resume"], term.io)).toBe(0);
    const graph = await graphOf(term);
    expect(graph.nodes.find((n) => n.id === h.id("escalate"))?.status?.state).toBe("completed");
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
