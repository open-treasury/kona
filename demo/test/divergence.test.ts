/**
 * Spec §7 *Divergent arms*, as an automated test — `prd.md` §9.3: "Same assertions run as an
 * automated test."
 *
 * The whole rig runs offline here: no Mailpit, no network, no install step. Whatever this file
 * proves, it proves on any machine.
 */

import { describe, expect, test } from "bun:test";

import { steppingClock } from "../mailbox/clock.ts";
import { MemoryMailboxProvider } from "../mailbox/memory.ts";
import * as kona from "../kona.ts";
import { arms, asGraph, assertDivergentArms, recordedRoster } from "../script/assertions.ts";
import { runDivergence } from "../script/divergence.ts";
import type { RunResult } from "../script/divergence.ts";
import { persona } from "../personas/cast.ts";

const T0 = "2026-08-20T09:00:00.000Z";

/** Everything about a run that must not vary between two identical executions. */
function shapeOfRun(result: RunResult): unknown {
  return {
    nodes: result.head.nodes.map((node) => node.id),
    edges: result.head.edges.map((edge) => `${edge.from}->${edge.to}:${edge.condition?.on ?? ""}`),
    arms: [...arms(result.head)].map(([root, nodes]) => `${root}=${nodes.length}`),
    witnesses: result.assertions.map((assertion) => `${assertion.id}:${assertion.witness}`),
    sends: result.sends,
  };
}

function run(): Promise<RunResult> {
  return runDivergence({
    provider: new MemoryMailboxProvider({ clock: steppingClock(T0) }),
    narrate: false,
  });
}

/** Every node id the committed fixture carries at head. The demo and it are one story. */
const FIXTURE_NODE_IDS = [
  "confirm-roster-availability",
  "escalate-no-goalie-found",
  "ask-dana-to-play-in-goal",
  "wait-for-dana",
  "ask-sam-to-play-in-goal",
  "wait-for-sam",
  "ask-priya-to-play-in-goal",
  "wait-for-priya",
  "goalie-confirmed",
  "check-marcus-is-eligible",
  "wait-for-eligibility-ruling",
  "confirm-roster-availability-and-eligibility",
  "ask-pat-to-play-in-goal",
  "wait-for-pat",
];

describe("the divergence run", () => {
  test("satisfies all four §7 divergent-arms assertions", async () => {
    const result = await run();
    const failed = result.assertions.filter((assertion) => !assertion.passed);
    // Print the witness on failure — an assertion that fails without saying which node it
    // looked at costs an hour.
    expect(failed.map((assertion) => `${assertion.id}: ${assertion.witness}`)).toEqual([]);
    expect(result.assertions).toHaveLength(4);
  });

  test("keeps every fixture node id, so the demo and the fixture stay one story", async () => {
    const result = await run();
    const live = new Set(result.head.nodes.map((node) => node.id));
    const missing = FIXTURE_NODE_IDS.filter((id) => !live.has(id));
    expect(missing).toEqual([]);
  });

  test("the COMMITTED fixture does not satisfy (c) — which is why the run goes past it", async () => {
    // The reason v8..v11 exist, pinned against the artifact actually in the repo. Every arm in
    // `fixtures/thursday.graph.json` is the same task→wait couplet, so the multiset of arm
    // sizes has exactly one distinct value and cannot supply the three the assertion wants.
    //
    // If someone regenerates the fixture so that it does satisfy (c), this test goes red — and
    // that is the signal that the demo's extension past v7 may no longer be needed.
    const fixture = asGraph(
      await Bun.file(new URL("../../fixtures/thursday.graph.json", import.meta.url)).json(),
    );
    const fixtureSizes = new Set([...arms(fixture).values()].map((nodes) => nodes.length));
    expect([...fixtureSizes]).toEqual([2]);

    const onFixture = assertDivergentArms(fixture, fixture);
    expect(onFixture.find((assertion) => assertion.id === "c")?.passed).toBe(false);
  });

  test("the live run's arms diverge in size only after it passes the fixture's ending", async () => {
    const result = await run();
    const sizesAt = async (version: number): Promise<Set<number>> =>
      new Set([...arms(asGraph(await kona.graph(result.cwd, version))).values()].map((n) => n.length));

    // At the fixture's last version the run has two distinct sizes: Sam's arm already reaches
    // into Marcus's, but nothing has grown a third shape yet.
    expect((await sizesAt(7)).size).toBe(2);
    expect((await sizesAt(11)).size).toBeGreaterThanOrEqual(3);
  });

  test("(b) is not satisfiable by anyone the roster already named", async () => {
    // The trap: "collect every recipient_ref at head, subtract v1's, assert non-empty" returns
    // sam, priya and pat — exactly what a parameterised fan-out over the recorded roster would
    // produce. So the roster the graph itself recorded must contain them, and not Marcus.
    const result = await run();
    const roster = recordedRoster(result.head);
    expect(roster).toEqual(["dana", "sam", "priya", "pat"]);
    expect(roster).not.toContain("marcus");

    const b = result.assertions.find((assertion) => assertion.id === "b");
    expect(b?.witness).toContain("marcus");
  });

  test("Marcus cannot be emailed until a human has ruled on him", async () => {
    const result = await run();
    const byId = new Map(result.head.nodes.map((node) => [node.id, node]));
    const referral = byId.get("check-marcus-is-eligible");
    const ruling = byId.get("wait-for-eligibility-ruling");
    const contact = byId.get("ask-marcus-to-play-in-goal");

    expect(referral).toBeDefined();
    expect(contact).toBeDefined();
    // §6.9's one gate: the plan may name him the moment Sam does, but the node that MOVES
    // BYTES to him may only exist after the ruling.
    expect(contact?.provenance.created_by_version).toBeGreaterThan(
      referral?.provenance.created_by_version ?? 0,
    );
    expect(ruling?.status.state).toBe("done");
    expect(contact?.spec.effect?.recipient_ref).toBe(persona("marcus").recipient_ref);
  });

  test("no mail is sent to Priya — a refused send did not happen", async () => {
    const result = await run();
    const priya = persona("priya").address;
    expect(result.sends.map((send) => send.to)).not.toContain(priya);

    // ...and the graph still records the failure, because the world did refuse it.
    const askPriya = result.head.nodes.find((node) => node.id === "ask-priya-to-play-in-goal");
    expect(askPriya?.status.state).toBe("failed");
  });

  test("every send records its provider and realm (§6.11)", async () => {
    const result = await run();
    expect(result.sends.length).toBeGreaterThan(0);
    for (const send of result.sends) {
      expect(send.provider).toBe("memory");
      expect(send.sandbox_or_real).toBe("sandbox");
    }
  });

  test("Pat's silence is recorded as an act, not as an absence", async () => {
    const result = await run();
    const silent = result.events.filter((event) => event.kind === "silent");
    expect(silent.map((event) => event.persona)).toEqual(["pat"]);

    const followUp = result.head.nodes.find((node) => node.id === "chase-pat-after-silence");
    expect(followUp).toBeDefined();
    const edge = result.head.edges.find((candidate) => candidate.to === "chase-pat-after-silence");
    expect(edge?.from).toBe("wait-for-pat");
    expect(edge?.condition?.on).toBe("timeout");
  });

  test("the run reproduces — twice over, the same topology and the same message ids", async () => {
    const [first, second] = await Promise.all([run(), run()]);
    expect(shapeOfRun(second)).toEqual(shapeOfRun(first));
  });

  test("folding the log twice yields the same graph (§8)", async () => {
    const result = await run();
    const again = asGraph(await kona.graph(result.cwd));
    expect(JSON.stringify(again)).toBe(JSON.stringify(result.head));
  });
});
