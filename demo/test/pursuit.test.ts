/**
 * T8.1 — one full pursuit, end to end, as an automated test.
 *
 * The claim under test is the one no other artefact in this repo makes: **a pursuit finishes.**
 * `divergence.ts` proves the graph diverges in ways a parameterised fan-out cannot, and it is
 * a scripted replay — it stops where its author decided to stop. This one stops when
 * `kona next` has nothing left to offer, or it fails.
 *
 * Every test here is a fact about a run that was driven by the binary's own frontier. If
 * readiness were wrong in either direction, or a wait could never resolve, or the dead arm
 * were never dropped, the loop would stall and every one of these would go red at once.
 */

import { describe, expect, test } from "bun:test";

import { steppingClock } from "../mailbox/clock.ts";
import { MemoryMailboxProvider } from "../mailbox/memory.ts";
import * as kona from "../kona.ts";
import { runPursuit } from "../script/pursuit.ts";
import type { PursuitResult } from "../script/pursuit.ts";
import { persona } from "../personas/cast.ts";

const T0 = "2026-08-20T09:00:00.000Z";

function run(): Promise<PursuitResult> {
  return runPursuit({
    provider: new MemoryMailboxProvider({ clock: steppingClock(T0) }),
    narrate: false,
  });
}

/** One run, shared. It spawns the binary about forty times and takes a few seconds. */
const RESULT = await run();

describe("the pursuit finishes", () => {
  test("nothing is ready, and that is what ended the loop rather than a step cap", () => {
    expect(RESULT.resume.frontier).toEqual([]);
    // The last iteration is the one that found nothing. A cap-terminated run would not have
    // it, and would look identical in every other assertion here.
    expect(RESULT.iterations.at(-1)?.ready).toEqual([]);
  });

  test("every node reached a terminal state — none left active or sending", () => {
    const open = RESULT.head.nodes.filter(
      (node) => node.status.state === "active" || node.status.state === "sending",
    );
    expect(open.map((node) => `${node.id}:${node.status.state}`)).toEqual([]);
  });

  test("no wait is still armed and no send is still in flight", () => {
    // The two things that mean "come back later". Both empty is what `done` actually means,
    // and it is the same sentence a fresh terminal gets from `kona resume` with no session
    // state anywhere.
    expect(RESULT.resume.waits.filter((wait) => !wait.overdue)).toEqual([]);
    expect(RESULT.resume.unknown_sends).toEqual([]);
  });

  test("the dead arm is DROPPED, which is what let the loop stop", () => {
    // `escalate-no-goalie-found` hangs off the quorum's `timeout` edge. A goalie confirming
    // makes that edge dead, and the store drops the node behind it. Left `active` it would
    // sit in the frontier forever — so branch resolution is not a nicety here, it is the
    // difference between a pursuit that ends and one that does not.
    const escalation = RESULT.head.nodes.find((node) => node.id === "escalate-no-goalie-found");
    expect(escalation?.status.state).toBe("dropped");
  });

  test("it ends with an answer, not merely with an empty frontier", () => {
    const announced = RESULT.head.nodes.find((node) => node.id === "announce-the-goalie");
    expect(announced?.status.state).toBe("done");
    expect(announced?.status.output).toEqual({ goalie: "marcus" });
  });
});

describe("the loop took its work from the binary", () => {
  test("every iteration acted only on nodes `kona next` offered", () => {
    // The property that makes this an end-to-end test rather than a longer script: the rig
    // never picks a node. Anything it did was to something the frontier named.
    for (const iteration of RESULT.iterations) {
      const named = new Set(iteration.ready);
      const touched = iteration.did
        .flatMap((line) => /\b((?:ask|wait|check|confirm|announce|escalate)-[a-z-]+)\b/.exec(line) ?? [])
        .slice(1);
      for (const id of touched) {
        // A wait resolved this iteration was on the frontier as an armed wait; a node planned
        // this iteration is new and appears on the NEXT frontier, so only the acted-on ones
        // are checked here.
        if (!id.startsWith("wait-") && !named.has(id)) {
          expect(`${String(iteration.n)}:${id}`).toBe(`${String(iteration.n)}:on the frontier`);
        }
      }
    }
  });

  test("the story took eight iterations and sixteen versions", () => {
    // Pinned so a change in how many commits a beat costs is visible rather than absorbed.
    // Sixteen for eight iterations because a send is three commits and the two refusals
    // below each cost a retry.
    expect(RESULT.iterations).toHaveLength(8);
    expect(RESULT.head.version).toBe(16);
  });
});

describe("the premise broke and the store made the recovery atomic", () => {
  test("invariant 2 refused BOTH the refusal and the approval, and said why", () => {
    // Not one refusal but two, and they are different beats. Sam's decline empties the
    // quorum; the human ruling resolves the last live member of the replacement. Each time
    // the loop proposed the plain outcome, was told it would strand the predicate, and came
    // back with a plan in the same batch.
    expect(RESULT.refusals.map((refusal) => refusal.reason)).toEqual([
      "PREDICATE_UNSATISFIABLE",
      "PREDICATE_UNSATISFIABLE",
    ]);
    expect(RESULT.refusals.map((refusal) => refusal.subject)).toEqual([
      "recording sam's answer",
      "recording the human ruling on wait-for-eligibility-ruling",
    ]);
  });

  test("§8: both refusals are in the rejections log, in the mutator's own words", async () => {
    const logged = await kona.rejections(RESULT.cwd);
    expect(logged).toHaveLength(2);
    for (const refusal of logged) {
      expect(refusal.rejection.reason).toBe("PREDICATE_UNSATISFIABLE");
      // The pair §6.3 calls training data: what was meant, and what the store said about it.
      expect(refusal.rationale?.why.length ?? 0).toBeGreaterThan(0);
      expect(refusal.rejection.message).toContain("goalie-confirmed");
    }
    expect(logged[0]?.rationale?.why).toContain("sam answered");
  });

  test("the approval and the arm it authorises are ONE commit", () => {
    // You cannot approve and then decide later what the approval was for. The retried batch
    // carries the ruling and `ask-marcus` together, so there is no version of this log in
    // which Marcus is contactable and nobody has said he may be.
    const history = RESULT.head.nodes;
    const ask = history.find((node) => node.id === "ask-marcus-to-play-in-goal");
    const ruling = history.find((node) => node.id === "wait-for-eligibility-ruling");
    expect(ask?.provenance.created_by_version).toBe(ruling?.status.observed_at_version);
  });
});

describe("§6.9's one gate", () => {
  test("Marcus is contacted only after a human ruled, and never before", async () => {
    const ask = RESULT.head.nodes.find((node) => node.id === "ask-marcus-to-play-in-goal");
    expect(ask?.spec.effect?.recipient_ref).toBe(persona("marcus").recipient_ref);

    // At the version before the ruling, nothing in the graph is addressed to him.
    const before = (await kona.graph(RESULT.cwd, (ask?.provenance.created_by_version ?? 0) - 1)) as {
      nodes: { spec: { effect?: { recipient_ref?: string } } }[];
    };
    const addressed = before.nodes
      .map((node) => node.spec.effect?.recipient_ref)
      .filter((ref): ref is string => ref !== undefined);
    expect(addressed.some((ref) => ref.includes("marcus"))).toBe(false);
  });

  test("what evidences Marcus is Sam naming him, not the ruling in the same batch", () => {
    // Invariant 3(b) resolves a recipient against PRE-COMMIT head, so the ruling committed
    // alongside `ask-marcus` cannot be what makes him legal. Sam's refusal, several versions
    // earlier, is — a person named by a counterparty in a message with an id.
    const sam = RESULT.head.nodes.find((node) => node.id === "wait-for-sam");
    expect(sam?.status.outcomes?.[0]?.attrs?.["referral"]).toBe("marcus");
    expect(sam?.status.outcomes?.[0]?.evidence_ref).toContain("@");
  });
});

describe("the correlation round trip", () => {
  test("what `kona brief` hands out is what `kona poll` watches for", async () => {
    // THE REGRESSION GUARD for the bug this whole test found. `brief` derived the reply
    // address from the SENDING node's id while `poll` derived it from the WAIT's, so every
    // reply in a real run would have arrived correlated to nothing. Both halves had passing
    // unit tests; only driving a pursuit through both showed it.
    //
    // Checked against a LIVE pursuit rather than a hand-built graph, because the bug was
    // precisely that two self-consistent halves disagreed.
    const brief = await kona.brief(RESULT.cwd, "ask-marcus-to-play-in-goal");
    expect(brief.correlation?.reply_to).toBe("ilya+kona-wait-for-marcus@kona.demo");
  });

  test("every wait that got an answer got it through `kona poll --inbound`", () => {
    // The verdicts came from matches, so a wait carrying an outcome whose evidence is a
    // message id is a wait `poll` routed. Nothing here recorded an answer it routed itself.
    const answered = RESULT.head.nodes.filter(
      (node) => node.type === "wait" && (node.status.outcomes?.length ?? 0) > 0,
    );
    const byMail = answered.filter((node) =>
      (node.status.outcomes ?? []).some((outcome) => outcome.evidence_ref.includes("@")),
    );
    expect(byMail.map((node) => node.id).toSorted()).toEqual([
      "wait-for-dana",
      "wait-for-marcus",
      "wait-for-sam",
    ]);
  });
});

describe("every send came from a slot the store issued (§6.6)", () => {
  test("three sends, each closed against the key it reserved", () => {
    expect(RESULT.sends.map((send) => send.node)).toEqual([
      "ask-dana-to-play-in-goal",
      "ask-sam-to-play-in-goal",
      "ask-marcus-to-play-in-goal",
    ]);
    for (const send of RESULT.sends) {
      const node = RESULT.head.nodes.find((candidate) => candidate.id === send.node);
      const entry = node?.status.effect_log?.[0];
      expect(`${send.node}:${entry?.effect_key ?? "MISSING"}`).toBe(`${send.node}:${send.effect_key}`);
      expect(entry?.outcome).toBe("sent");
      expect(entry?.completed_at).not.toBeNull();
    }
  });

  test("nothing moved bytes that the run did not account for", () => {
    const spent = RESULT.head.nodes.flatMap((node) => node.status.effect_log ?? []);
    expect(spent).toHaveLength(RESULT.sends.length);
  });
});

/** Everything about a run that must not vary between two identical executions. */
function shapeOf(result: PursuitResult): unknown {
  return {
    version: result.head.version,
    nodes: result.head.nodes.map((node) => `${node.id}:${node.status.state}`),
    edges: result.head.edges.map((edge) => `${edge.from}->${edge.to}:${edge.condition?.on ?? ""}`),
    iterations: result.iterations.map((it) => `${String(it.n)}:${it.did.join("|")}`),
    refusals: result.refusals,
  };
}

describe("the run is deterministic", () => {
  // A whole pursuit is about forty subprocess spawns, so the default 5s is not enough.
  test("a second run produces the same shape, version for version", async () => {
    expect(shapeOf(await run())).toEqual(shapeOf(RESULT));
  }, 60_000);
});
