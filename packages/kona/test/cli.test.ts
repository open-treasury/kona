/**
 * The end-to-end slice: `init` -> `mutate` -> `graph`, driven through the real verb
 * dispatcher against a real temp directory and a real log file. Only the clock, the cwd,
 * the pid and the two streams are injected; everything else is the shipping code path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DamagedLine, GraphProjection } from "@kona/core";
import { run } from "../src/cli.ts";
import { acquireLock } from "../src/lock.ts";
import { fixedClock } from "../src/clock.ts";
import { ASK_DANA, harness, seedRoster, type Harness } from "./harness.ts";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

const T0 = "2026-08-21T12:00:00.000Z";
const WHY = ["--why", "Dana is the only goalie on the roster", "--reason-code", "MISSING_STEP"];

function logLines(dir = h.dir): string[] {
  return readFileSync(join(dir, ".kona", "mutations.jsonl"), "utf8").trim().split("\n");
}

async function init(): Promise<void> {
  expect(await run(["init"], h.io)).toBe(0);
  // ASK_DANA carries a pivot addressed to `roster.contacts#dana`, and invariant 3(b) wants
  // the graph to have heard of her BEFORE the batch that emails her. Head lands at v2.
  await seedRoster(h, ["dana"]);
}

async function commitAskDana(): Promise<number> {
  const ops = h.writeOps("ops.json", ASK_DANA);
  return await run(["mutate", "--ops", ops, "--base-version", "2", ...WHY], h.io);
}

describe("dispatch", () => {
  test("help lists all nine verbs and marks the unbuilt ones", async () => {
    expect(await run([], h.io)).toBe(0);
    const help = h.out.join("\n");
    for (const verb of ["init", "mutate", "graph", "next", "brief", "poll", "resume", "effect", "view"]) {
      expect(help).toContain(verb);
    }
    expect(help).toContain("never calls a language model");
  });

  test("an unknown verb is refused", async () => {
    expect(await run(["rollback"], h.io)).toBe(1);
    expect(h.err[0]).toContain("UNKNOWN_VERB");
  });

  test("all nine verbs dispatch — none is listed and then missing", async () => {
    // Every one refuses for a REASON OF ITS OWN outside a pursuit, which is the proof that
    // dispatch reached the verb rather than falling through to "not a kona verb".
    for (const verb of ["mutate", "graph", "next", "brief", "poll", "resume", "effect", "view"]) {
      h.reset();
      await run([verb], h.io);
      expect(h.err[0] ?? "").not.toContain("UNKNOWN_VERB");
    }
    h.reset();
    expect(await run(["init", "--json"], h.io)).toBe(0);
  });

  test("an unknown flag is refused rather than ignored", async () => {
    expect(await run(["init", "--yolo"], h.io)).toBe(1);
    expect(h.err[0]).toContain("BAD_FLAG");
  });
});

describe("kona init", () => {
  test("creates the log with a genesis record at version 0", async () => {
    expect(await run(["init", "--json"], h.io)).toBe(0);
    const genesis = JSON.parse(logLines()[0] ?? "");
    expect(genesis.v).toBe(0);
    expect(genesis.schema_version).toBe(1);
    expect(genesis.ops).toEqual([]);
    expect(genesis.rationale.why).toBe("pursuit initialised");
    expect(genesis.observed_at).toBe(T0);
  });

  test("every line has the same shape, so fold needs no special case for line 1", async () => {
    await init();
    await commitAskDana();
    for (const line of logLines()) {
      const record = JSON.parse(line);
      expect(Object.keys(record)).toContain("rationale");
      expect(record.outcome).toBeNull();
    }
  });

  test("refuses to re-initialise — the log is never re-created", async () => {
    await init();
    expect(await run(["init"], h.io)).toBe(1);
    expect(h.err[0]).toContain("ALREADY_INITIALISED");
  });

  test("refuses a network filesystem, and --force overrides", async () => {
    const dropbox = join(h.dir, "Dropbox", "pursuit");
    mkdirSync(dropbox, { recursive: true });
    const io = { ...h.io, cwd: dropbox };
    expect(await run(["init"], io)).toBe(1);
    expect(h.err[0]).toContain("NETWORK_FILESYSTEM");
    expect(h.err[0]).toContain("Dropbox");
    expect(await run(["init", "--force"], io)).toBe(0);
  });
});

describe("kona mutate — the only write path", () => {
  test("commits, mints ids from labels, and reports them", async () => {
    await init();
    expect(await commitAskDana()).toBe(0);
    expect(h.out[0]).toContain("committed v3");
    expect(h.out[0]).toContain("minted ask-dana-to-play-thursday, wait-for-dana");
    const graph = await runGraphJson();
    expect(graph.version).toBe(3);
    // `roster-on-file` is the seed that attests to Dana; §6.7 wants her named before the
    // batch that emails her.
    expect(graph.nodes.map((n) => n.id)).toEqual([
      "roster-on-file",
      "ask-dana-to-play-thursday",
      "wait-for-dana",
    ]);
  });

  test("writes the COMMITTED form: refs resolved, ids present, no $N survives", async () => {
    await init();
    await commitAskDana();
    const line = logLines().at(-1) ?? "";
    expect(line).not.toContain("$0");
    const ops = JSON.parse(line).ops;
    expect(ops[0].id).toBe("ask-dana-to-play-thursday");
    expect(ops[2]).toEqual({
      op: "add_edge",
      from: "ask-dana-to-play-thursday",
      to: "wait-for-dana",
    });
  });

  test("--why is required: a commit without a rationale is impossible", async () => {
    await init();
    const ops = h.writeOps("ops.json", ASK_DANA);
    expect(
      await run(["mutate", "--ops", ops, "--base-version", "2", "--reason-code", "OTHER"], h.io),
    ).toBe(1);
    expect(h.err[0]).toContain("MISSING_FLAG");
    expect(h.err[0]).toContain("--why");
    expect(logLines()).toHaveLength(3);
  });

  test("--reason-code is required and closed", async () => {
    await init();
    const ops = h.writeOps("ops.json", ASK_DANA);
    expect(await run(["mutate", "--ops", ops, "--base-version", "2", "--why", "x"], h.io)).toBe(1);
    h.reset();
    expect(
      await run(["mutate", "--ops", ops, "--base-version", "2", "--why", "x", "--reason-code", "BECAUSE"], h.io),
    ).toBe(1);
    expect(h.err[0]).toContain("BAD_FLAG");
  });

  test("a stale base version exits 3 and names head", async () => {
    await init();
    await commitAskDana();
    h.reset();
    expect(await commitAskDana()).toBe(3);
    expect(h.err[0]).toStartWith("STALE_BASE_VERSION head=3 base=2");
    expect(logLines()).toHaveLength(4);
  });

  test("an invariant violation exits 4 and names the node", async () => {
    await init();
    await commitAskDana();
    h.reset();
    const ops = h.writeOps("done.json", [
      { op: "set_status", node: "ask-dana-to-play-thursday", status: "done", evidence_ref: "e" },
    ]);
    expect(
      await run(["mutate", "--ops", ops, "--base-version", "3", "--why", "sent", "--reason-code", "OTHER"], h.io),
    ).toBe(0);
    h.reset();
    const again = h.writeOps("again.json", [
      { op: "set_status", node: "ask-dana-to-play-thursday", status: "active", evidence_ref: "e" },
    ]);
    expect(
      await run(["mutate", "--ops", again, "--base-version", "4", "--why", "reopen", "--reason-code", "OTHER"], h.io),
    ).toBe(4);
    expect(h.err[0]).toStartWith("TERMINAL_NODE_PROTECTED");
    expect(h.err[0]).toContain("node=ask-dana-to-play-thursday");
  });

  test("a subagent attempting topology is refused", async () => {
    await init();
    const ops = h.writeOps("ops.json", ASK_DANA);
    expect(
      await run(
        ["mutate", "--ops", ops, "--base-version", "2", ...WHY, "--actor-kind", "subagent", "--actor-id", "exec-3"],
        h.io,
      ),
    ).toBe(1);
    expect(h.err[0]).toContain("UNAUTHORIZED_ACTOR");
    expect(logLines()).toHaveLength(3);
  });

  test("a malformed ops file is refused before anything is written", async () => {
    await init();
    const bad = join(h.dir, "bad.json");
    writeFileSync(bad, "{not json");
    expect(await run(["mutate", "--ops", bad, "--base-version", "2", ...WHY], h.io)).toBe(1);
    expect(h.err[0]).toContain("UNREADABLE_OPS");

    h.reset();
    const wrong = h.writeOps("wrong.json", [{ op: "add_node", label: "x" }]);
    expect(await run(["mutate", "--ops", wrong, "--base-version", "2", ...WHY], h.io)).toBe(1);
    expect(h.err[0]).toContain("MALFORMED_OPS");
    expect(logLines()).toHaveLength(3);
  });

  test("refuses when another writer holds the lock", async () => {
    await init();
    const held = await acquireLock(join(h.dir, ".kona", "lock"), fixedClock(T0), 1);
    expect(held.ok).toBe(true);
    expect(await commitAskDana()).toBe(1);
    expect(h.err[0]).toContain("LOCK_HELD");
    expect(logLines()).toHaveLength(3);
  });

  test("releases the lock after a successful commit", async () => {
    await init();
    await commitAskDana();
    expect(existsSync(join(h.dir, ".kona", "lock"))).toBe(false);
  });

  test("refuses to write onto a corrupt log", async () => {
    await init();
    await commitAskDana();
    const log = join(h.dir, ".kona", "mutations.jsonl");
    const lines = readFileSync(log, "utf8").trim().split("\n");
    writeFileSync(log, `${lines[0]}\n{"v":1,"broken":true}\n${lines[1]}\n`);
    h.reset();
    const ops = h.writeOps("more.json", ASK_DANA);
    expect(await run(["mutate", "--ops", ops, "--base-version", "3", ...WHY], h.io)).toBe(1);
    expect(h.err[0]).toContain("CORRUPT_LOG");
    expect(logLines()).toHaveLength(3);
  });

  test("a non-integer --base-version is refused before the lock is taken", async () => {
    await init();
    const ops = h.writeOps("ops.json", ASK_DANA);
    expect(await run(["mutate", "--ops", ops, "--base-version", "one", ...WHY], h.io)).toBe(1);
    expect(h.err[0]).toContain("BAD_FLAG");
    expect(existsSync(join(h.dir, ".kona", "lock"))).toBe(false);
  });

  test("refuses outside a pursuit", async () => {
    const ops = h.writeOps("ops.json", ASK_DANA);
    expect(await run(["mutate", "--ops", ops, "--base-version", "2", ...WHY], h.io)).toBe(1);
    expect(h.err[0]).toContain("NO_PURSUIT");
  });
});

type GraphJson = GraphProjection & { torn_tail: boolean; damaged: DamagedLine[] };

async function runGraphJson(args: string[] = []): Promise<GraphJson> {
  h.reset();
  const code = await run(["graph", "--json", ...args], h.io);
  expect(code).toBe(0);
  return JSON.parse(h.out[0] ?? "{}") as GraphJson;
}

describe("kona graph — the only read contract", () => {
  test("finds the pursuit from a subdirectory, the way git finds .git", async () => {
    await init();
    await commitAskDana();
    const nested = join(h.dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    h.reset();
    expect(await run(["graph", "--json"], { ...h.io, cwd: nested })).toBe(0);
    expect(JSON.parse(h.out[0] ?? "{}").version).toBe(3);
  });

  test("reports a torn tail as a crash, not as damage", async () => {
    await init();
    await commitAskDana();
    const log = join(h.dir, ".kona", "mutations.jsonl");
    writeFileSync(log, `${readFileSync(log, "utf8")}{"v":2,"schema_ve`);
    const graph = await runGraphJson();
    expect(graph.torn_tail).toBe(true);
    expect(graph.damaged).toEqual([]);
    expect(graph.version).toBe(3);
  });

  test("a damaged mid-file record is surfaced and exits non-zero", async () => {
    await init();
    await commitAskDana();
    const log = join(h.dir, ".kona", "mutations.jsonl");
    const lines = readFileSync(log, "utf8").trim().split("\n");
    writeFileSync(log, `${lines[0]}\n{"v":1,"broken":true}\n${lines[1]}\n`);
    h.reset();
    expect(await run(["graph", "--json"], h.io)).toBe(1);
    expect(h.err[0]).toContain("UNPARSEABLE_RECORD");
  });

  test("--version is read-only time travel and removes nothing", async () => {
    await init();
    await commitAskDana();
    expect((await runGraphJson(["--version", "0"])).nodes).toEqual([]);
    expect((await runGraphJson()).version).toBe(3);
  });

  test("rejects a nonsense --version rather than folding to head", async () => {
    await init();
    h.reset();
    expect(await run(["graph", "--json", "--version", "-1"], h.io)).toBe(1);
    expect(h.err[0]).toContain("BAD_FLAG");
  });

  test("a non-integer --version is refused by the flag check, not by the arg parser", async () => {
    await init();
    for (const bad of ["abc", "1.5", ""]) {
      h.reset();
      expect(await run(["graph", "--json", "--version", bad], h.io)).toBe(1);
      expect(h.err[0]).toContain("BAD_FLAG");
    }
  });

  test("refuses outside a pursuit", async () => {
    expect(await run(["graph", "--json"], h.io)).toBe(1);
    expect(h.err[0]).toContain("NO_PURSUIT");
  });

  test("the human rendering states the edge in the direction the spec defines", async () => {
    await init();
    await commitAskDana();
    h.reset();
    await run(["graph"], h.io);
    expect(h.out.join("\n")).toContain("wait-for-dana requires ask-dana-to-play-thursday");
  });
});

describe("the architecture, asserted", () => {
  /** 8: folding the log twice yields an identical graph. There is no snapshot to keep coherent. */
  test("the graph is a fold: two reads of the same log are byte-identical", async () => {
    await init();
    await commitAskDana();
    const first = JSON.stringify(await runGraphJson());
    const second = JSON.stringify(await runGraphJson());
    expect(second).toBe(first);
  });

  test("nothing but the log exists in .kona/ — no derived snapshot to go stale", async () => {
    await init();
    await commitAskDana();
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(h.dir, ".kona"))).toEqual(["mutations.jsonl"]);
  });

  /**
   * The determinism law, at the CLI boundary: same log, same clock, same bytes. If any
   * verb ever reached for a model, a timestamp or a random id, this is what would catch it.
   */
  test("the same inputs produce a byte-identical log in two independent directories", async () => {
    const other = harness();
    try {
      for (const target of [h, other]) {
        expect(await run(["init"], target.io)).toBe(0);
        await seedRoster(target, ["dana"]);
        const ops = target.writeOps("ops.json", ASK_DANA);
        expect(
          await run(["mutate", "--ops", ops, "--base-version", "2", ...WHY], target.io),
        ).toBe(0);
      }
      expect(logLines(other.dir)).toEqual(logLines(h.dir));
    } finally {
      other.cleanup();
    }
  });
});

describe("6.8: every non-zero exit writes one symbolic stderr line", () => {
  /**
   * The contract a caller depends on. `demo/kona.ts` throws a `KonaError` carrying stderr,
   * and a shell script greps the first token — so a verb that fails SILENTLY leaves both
   * with nothing to report but the number. Checked across every refusal reachable from
   * argument handling, since that is where a `return EXIT_REFUSED` is easiest to add
   * without a message beside it.
   */
  const REFUSALS: [string, string[]][] = [
    ["unknown verb", ["rollback"]],
    ["unknown flag", ["graph", "--yolo"]],
    ["graph outside a pursuit", ["graph"]],
    ["next outside a pursuit", ["next"]],
    ["resume outside a pursuit", ["resume"]],
    ["poll outside a pursuit", ["poll"]],
    ["view outside a pursuit", ["view"]],
    ["brief with no node", ["brief"]],
    ["brief outside a pursuit", ["brief", "some-node"]],
    ["effect with no subcommand", ["effect", "--why", "x"]],
    ["effect with an unknown subcommand", ["effect", "cancel", "n", "--why", "x"]],
    ["effect with no node", ["effect", "reserve", "--why", "x", "--payload-hash", "h"]],
    ["reserve outside a pursuit", ["effect", "reserve", "n", "--why", "x", "--payload-hash", "h"]],
    ["mutate with no --ops", ["mutate", "--base-version", "2", "--why", "x", "--reason-code", "OTHER"]],
    ["mutate with no --why", ["mutate", "--ops", "/tmp/nope.json", "--base-version", "2"]],
    ["mutate with an empty --why", ["mutate", "--ops", "/tmp/nope.json", "--base-version", "2", "--why", ""]],
    ["mutate with a bad --reason-code", ["mutate", "--ops", "/tmp/nope.json", "--base-version", "2", "--why", "x", "--reason-code", "NOPE"]],
    ["mutate with a bad --base-version", ["mutate", "--ops", "/tmp/nope.json", "--base-version", "one", "--why", "x", "--reason-code", "OTHER"]],
    ["a bad --version", ["graph", "--version", "abc"]],
    ["a bad --port", ["view", "--port", "abc"]],
  ];

  test.each(REFUSALS)("%s", async (_name, argv) => {
    h.reset();
    const code = await run(argv, h.io);
    expect(code).not.toBe(0);
    expect(h.err.length).toBeGreaterThan(0);
    // Symbolic reason first, so `cut -d' ' -f1` is a stable contract.
    expect(h.err[0] ?? "").toMatch(/^[A-Z][A-Z_]+ /);
  });

  test("and a zero exit writes nothing to stderr", async () => {
    h.reset();
    expect(await run(["init"], h.io)).toBe(0);
    expect(h.err).toEqual([]);
    h.reset();
    expect(await run(["graph"], h.io)).toBe(0);
    expect(h.err).toEqual([]);
  });

  test("the exit code is always one of the four 6.8 defines", async () => {
    for (const [, argv] of REFUSALS) {
      h.reset();
      expect([0, 1, 3, 4]).toContain(await run(argv, h.io));
    }
  });
});
