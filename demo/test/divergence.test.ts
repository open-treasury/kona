/**
 * Spec §7 *Divergent arms*, as an automated test — `prd.md` §9.3: "Same assertions run as an
 * automated test."
 *
 * The whole rig runs offline here: no Mailpit, no network, no install step. Whatever this file
 * proves, it proves on any machine.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { steppingClock } from "../mailbox/clock.ts";
import { MemoryMailboxProvider } from "../mailbox/memory.ts";
import type { InboundMessage, MailboxProvider } from "../mailbox/port.ts";
import * as kona from "../kona.ts";
import { arms, asGraph, assertDivergentArms, recordedRoster } from "../script/assertions.ts";
import type { GraphJson, GraphNode } from "../script/assertions.ts";
import { runDivergence } from "../script/divergence.ts";
import type { RunResult } from "../script/divergence.ts";
import { persona } from "../personas/cast.ts";

const T0 = "2026-08-20T09:00:00.000Z";

/** Blank a node's recorded output, so the graph carries no roster at all. */
function stripOutput(node: GraphNode): GraphNode {
  return Object.assign({}, node, { status: Object.assign({}, node.status, { output: null }) });
}

/** Deliver a reply to an address that is not the node's correlation tag. */
function misroute(message: InboundMessage): InboundMessage {
  return Object.assign({}, message, { to: ["someone-else@kona.demo"] });
}

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

/**
 * ONE run, shared by everything that only reads it.
 *
 * Each `run()` spawns the binary about thirty times, so twelve of them was thirty-odd seconds
 * of identical work — and, under a loaded machine, twelve chances to exceed bun's 5s default
 * and be killed. That is the whole of `kona-atq`: a timed-out test makes the runner SIGTERM
 * the `kona` subprocesses still in flight, and the NEXT test sees `exited 143` with an empty
 * stderr, because a process killed by a signal never got to say anything. The rare, spooky
 * empty-stderr failure was a timeout cascade wearing a mystery's clothes.
 *
 * The two tests that genuinely need an independent run — reproducibility, and the stub
 * provider — still make their own, and say so.
 */
const RESULT = await run();

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
    const result = RESULT;
    const failed = result.assertions.filter((assertion) => !assertion.passed);
    // Print the witness on failure — an assertion that fails without saying which node it
    // looked at costs an hour.
    expect(failed.map((assertion) => `${assertion.id}: ${assertion.witness}`)).toEqual([]);
    expect(result.assertions).toHaveLength(4);
  });

  test("keeps every fixture node id, so the demo and the fixture stay one story", async () => {
    const result = RESULT;
    const live = new Set(result.head.nodes.map((node) => node.id));
    const missing = FIXTURE_NODE_IDS.filter((id) => !live.has(id));
    expect(missing).toEqual([]);
  });

  test("every send was spent from a reservation the store issued (§6.6)", async () => {
    // THE REGRESSION GUARD for the bypass this run used to have. It called `provider.send`
    // directly and hand-wrote `set_status done`, so the artefact whose whole job is to
    // demonstrate the product never touched `effect reserve`, the payload-hash check, or the
    // duplicate-send refusal. It passed all four §7 assertions the entire time.
    //
    // A rig that regressed to a bare send cannot fill `effect_key` — there would be no key to
    // fill it with — so this fails on the shape rather than on a convention.
    const result = RESULT;
    const byId = new Map(result.head.nodes.map((node) => [node.id, node]));

    expect(result.sends.length).toBeGreaterThan(0);
    for (const send of result.sends) {
      const log = byId.get(send.node)?.status.effect_log ?? [];
      const entry = log.find((candidate) => candidate.effect_key === send.effect_key);
      expect(`${send.node}:${send.effect_key}`).toBe(`${send.node}:${entry?.effect_key ?? "MISSING"}`);
      // The store approved a hash; these are the bytes that left. Equal, or the reservation
      // was for something other than what was sent.
      expect(entry?.payload_hash).toBe(send.payload_hash);
      expect(entry?.outcome).toBe("sent");
      expect(entry?.message_id).not.toBeNull();
      // Closed. An open reservation is crash window 2 — a `sending` node nobody can resolve.
      expect(entry?.completed_at).not.toBeNull();
      // And the STATE came from `effect record`, not from a hand-written set_status.
      expect(byId.get(send.node)?.status.state).toBe("done");
    }

    // Nothing moved bytes that this run did not account for, in either direction. Priya is
    // the one extra slot: reserved, attempted, refused, closed as `failed`.
    const spent = result.head.nodes.flatMap((node) => node.status.effect_log ?? []);
    expect(spent).toHaveLength(result.sends.length + 1);
    const priya = byId.get("ask-priya-to-play-in-goal");
    expect(priya?.status.state).toBe("failed");
    expect(priya?.status.effect_log?.[0]?.outcome).toBe("failed");
    expect(priya?.status.effect_log?.[0]?.completed_at).not.toBeNull();
  });

  test("Priya's slot stays open across four versions — crash window 2, held on purpose", async () => {
    // The window §6.6 says nothing on disk can distinguish from window 3: a `sending` node
    // with an open reservation, no message id, and no way to know whether the bytes moved.
    // The run holds it open from v7 to v11 so the state is real rather than described.
    const result = RESULT;
    for (const version of [7, 8, 9, 10]) {
      const graph = asGraph(await kona.graph(result.cwd, version));
      const priya = graph.nodes.find((node) => node.id === "ask-priya-to-play-in-goal");
      expect(`v${version}:${priya?.status.state ?? "?"}`).toBe(`v${version}:in_flight`);
      const open = priya?.status.effect_log?.[0];
      expect(open?.completed_at).toBeNull();
      expect(open?.outcome).toBeNull();
      expect(open?.message_id).toBeNull();
    }
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

  test("the arms start diverging at v9, and reach three distinct sizes only by v16", async () => {
    const result = RESULT;
    const sizesAt = async (version: number): Promise<Set<number>> =>
      new Set(
        [...arms(asGraph(await kona.graph(result.cwd, version))).values()].map((n) => n.length),
      );

    // Uniform while every arm is still the same ask→wait couplet — and it stays uniform
    // through all three sends, because a reservation and a receipt change a node's STATUS,
    // never the graph's shape. That is worth pinning: if threading the outbox through the run
    // had moved an arm, the outbox would be authoring plan rather than recording effects.
    expect((await sizesAt(8)).size).toBe(1);
    // v9 is Sam's referral edge, which pulls the Marcus nodes into Sam's arm.
    expect((await sizesAt(9)).size).toBe(2);
    expect((await sizesAt(14)).size).toBe(2);
    // The third distinct size arrives only at v16, when Pat's silence sprouts a follow-up.
    expect((await sizesAt(16)).size).toBeGreaterThanOrEqual(3);
    expect((await sizesAt(19)).size).toBeGreaterThanOrEqual(3);
  });

  test("(b) is not satisfiable by anyone the roster already named", async () => {
    // The trap: "collect every recipient_ref at head, subtract v1's, assert non-empty" returns
    // sam, priya and pat — exactly what a parameterised fan-out over the recorded roster would
    // produce. So the roster the graph itself recorded must contain them, and not Marcus.
    const result = RESULT;
    const roster = recordedRoster(result.head);
    expect(roster).toEqual(["dana", "sam", "priya", "pat"]);
    expect(roster).not.toContain("marcus");

    const b = result.assertions.find((assertion) => assertion.id === "b");
    expect(b?.witness).toContain("marcus");
  });

  test("the run is well-formed against invariant 3(b) — nothing addresses unevidenced Marcus", async () => {
    // NOT a test that the STORE gates anything — the test below is. The version ordering here
    // is chosen by divergence.ts, so asserting `15 > 9` would only be asserting that this
    // repo's own source says what it says.
    //
    // What IS checkable from the graph alone: at v9, the version where Sam names Marcus,
    // NOTHING is addressed to him; and the node that eventually is names an `evidence_ref`
    // the graph already carried.
    const result = RESULT;

    const atReferral = asGraph(await kona.graph(result.cwd, 9));
    const addressedAtReferral = atReferral.nodes
      .map((node) => node.spec.effect?.recipient_ref)
      .filter((ref): ref is string => ref !== undefined);
    expect(addressedAtReferral.some((ref) => ref.includes("marcus"))).toBe(false);

    const byId = new Map(result.head.nodes.map((node) => [node.id, node]));
    const contact = byId.get("ask-marcus-to-play-in-goal");
    const ruling = byId.get("wait-for-eligibility-ruling");
    expect(contact?.spec.effect?.recipient_ref).toBe(persona("marcus").recipient_ref);
    // The ref resolves to a node that is in the graph and has actually returned — which is
    // what "resolves to an entity already in the graph carrying an evidence_ref" means.
    expect(contact?.spec.effect?.recipient_ref).toContain("wait-for-eligibility-ruling");
    expect(ruling?.status.state).toBe("done");
  });

  test("the store REFUSES a recipient nobody evidenced — no longer narrated", async () => {
    // This replaces a PENDING marker that asserted the opposite and said so: "when E2 lands
    // 3(b), this test goes RED. That is the signal: delete it, and the claim 'nobody new
    // enters the world without a human' becomes enforceable rather than narrated." It went
    // red. The demo no longer has to narrate the gate as the plan's shape.
    const cwd = await mkdtemp(join(tmpdir(), "kona-3b-"));
    await kona.init(cwd, "ilya");

    const outcome = await kona
      .mutate(cwd, {
        baseVersion: 0,
        why: "email a person the graph has never heard of",
        reasonCode: "OTHER",
        ops: [
          {
            op: "add_node",
            label: "Ask a stranger to play in goal",
            type: "task",
            scope: "goalies",
            spec: {
              instruction: "Email someone nobody evidenced.",
              outputs: [{ name: "sent_message_id", type: "string" }],
              effect_class: "pivot",
              effect: { channel: "email", recipient_ref: "nowhere#nobody" },
            },
          },
        ],
      })
      .then(() => ({ refused: false, reason: "" }))
      .catch((error: unknown) => ({
        refused: true,
        reason: (error as { reason?: string }).reason ?? "",
      }));

    expect(outcome.refused).toBe(true);
    // The token §6.9's one human gate keys on, and it must not be shared with "the model
    // wrote a bad string" — the plugin routes on this alone.
    expect(outcome.reason).toBe("UNEVIDENCED_RECIPIENT");
  });

  test("no mail is sent to Priya — a refused send did not happen", async () => {
    const result = RESULT;
    const priya = persona("priya").address;
    expect(result.sends.map((send) => send.to)).not.toContain(priya);

    // ...and the graph still records the failure, because the world did refuse it.
    const askPriya = result.head.nodes.find((node) => node.id === "ask-priya-to-play-in-goal");
    expect(askPriya?.status.state).toBe("failed");
  });

  test("every send records its provider and realm (§6.11)", async () => {
    const result = RESULT;
    expect(result.sends.length).toBeGreaterThan(0);
    for (const send of result.sends) {
      expect(send.provider).toBe("memory");
      expect(send.sandbox_or_real).toBe("sandbox");
    }
  });

  test("Pat's silence is recorded as an act, not as an absence", async () => {
    const result = RESULT;
    const silent = result.events.filter((event) => event.kind === "silent");
    expect(silent.map((event) => event.persona)).toEqual(["pat"]);

    const followUp = result.head.nodes.find((node) => node.id === "chase-pat-after-silence");
    expect(followUp).toBeDefined();
    const edge = result.head.edges.find((candidate) => candidate.to === "chase-pat-after-silence");
    expect(edge?.from).toBe("wait-for-pat");
    expect(edge?.condition?.on).toBe("timeout");
  });

  test("the run reproduces — twice over, the same topology and the same message ids", async () => {
    // Two FRESH runs, necessarily: comparing the shared one to itself would prove nothing.
    // Sixty seconds because this is the one test in the file that pays the cost twice.
    const [first, second] = await Promise.all([run(), run()]);
    expect(shapeOfRun(second)).toEqual(shapeOfRun(first));
  }, 60_000);

  test("(b) fails closed when no roster was recorded", async () => {
    // The hazard is an absent fact read as a permissive one: with an empty roster, every
    // addressed counterparty is trivially "absent" from it, so the assertion would pass at its
    // loudest exactly when it knows least — and would name Dana as the off-roster witness.
    const result = RESULT;
    const rosterless: GraphJson = {
      ...result.head,
      nodes: result.head.nodes.map(stripOutput),
    };
    expect(recordedRoster(rosterless)).toEqual([]);

    const b = assertDivergentArms(rosterless, result.v1).find((a) => a.id === "b");
    expect(b?.passed).toBe(false);
    expect(b?.witness).toContain("no roster was recorded");
  });

  test("a provider whose pollThread returns nothing FAILS the run", async () => {
    // The guard on `poll-thread` being load-bearing. It was not, once: the run took each
    // reply's id off the simulator's own send receipt, so a provider whose third method did
    // nothing at all still produced four green assertions — measured. The correlation round
    // trip §6.11 exists for was exercised by no path of the deliverable.
    //
    // Now the evidence comes from what the mailbox hands back, so a broken poll stops the run.
    const inner = new MemoryMailboxProvider({ clock: steppingClock(T0) });
    const blind: MailboxProvider = {
      name: inner.name,
      sandbox_or_real: inner.sandbox_or_real,
      provision: (request) => inner.provision(request),
      send: (envelope) => inner.send(envelope),
      pollThread: () => Promise.resolve({ messages: [], cursor: null }),
    };

    let thrown: unknown;
    try {
      await runDivergence({ provider: blind, narrate: false });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("correlation round trip is broken");
  });

  test("a reply addressed to the wrong correlation tag FAILS the run", async () => {
    // The other half: polling that returns *something* is not enough. The reply has to come
    // back on `ilya+kona-<node_id>@…`, the tag that routes it to this node and no other.
    const inner = new MemoryMailboxProvider({ clock: steppingClock(T0) });
    const misrouted: MailboxProvider = {
      name: inner.name,
      sandbox_or_real: inner.sandbox_or_real,
      provision: (request) => inner.provision(request),
      send: (envelope) => inner.send(envelope),
      pollThread: async (request) => {
        const page = await inner.pollThread(request);
        return { ...page, messages: page.messages.map(misroute) };
      },
    };

    let thrown: unknown;
    try {
      await runDivergence({ provider: misrouted, narrate: false });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error | undefined)?.message).toContain("did not survive");
  });

  test("folding the log twice yields the same graph (§8)", async () => {
    const result = RESULT;
    const again = asGraph(await kona.graph(result.cwd));
    expect(JSON.stringify(again)).toBe(JSON.stringify(result.head));
  });
});
