/**
 * One full pursuit, end to end — plan T8.1.
 *
 * Brief → authored graph → approve → fan out → replies → premise break → recovery → **done**.
 * The last word is the one that makes this a different artefact from `divergence.ts`.
 *
 * ## What this proves that the divergence run does not
 *
 * `divergence.ts` is a **replay**: a scripted sequence of eleven batches with hand-written
 * `baseVersion`s, which is exactly right for what it proves — that the graph diverges in ways
 * a parameterised fan-out cannot — and useless for proving that a pursuit ever finishes,
 * because the script decides when it stops.
 *
 * This one decides nothing about order. Every iteration asks **`kona next`** what is ready and
 * acts on the answer, the way `/kona:run` does; head is read rather than predicted; and the
 * run ends when the frontier is empty, or it fails. Three things follow that a replay cannot
 * check:
 *
 * 1. **The frontier is a sufficient work list.** If readiness were wrong in either direction —
 *    a node ready before its dependencies, or one that never becomes ready — this stalls or
 *    dispatches something it should not. A replay names its own nodes and would not notice.
 * 2. **The pursuit terminates.** Not "reached eleven versions": nothing is ready, no wait is
 *    armed, no reservation is open. `kona resume --dry-run` says so at the end, which is the
 *    same sentence a fresh terminal would get with no session state anywhere.
 * 3. **Branch resolution actually drops the dead arm.** `escalate-no-goalie-found` is wired
 *    behind a `timeout` edge, so a goalie confirming is what kills it. If it were still
 *    `active` at the end, the loop would never stop — which turns "readiness fails safe" from
 *    a claim into something the run cannot survive being wrong about.
 *
 * ## The three kinds of judgement, kept apart
 *
 * The loop is the orchestrator, and the orchestrator is a model. Everything it decides is
 * scripted here so the run is deterministic, but the KINDS are kept visibly separate, because
 * the whole architecture is about which of them the binary is allowed to make:
 *
 * | | who decides | where it lives |
 * |---|---|---|
 * | what is ready | `kona next` | the binary — pure function of the log |
 * | which wait a reply belongs to | `kona poll --inbound` | the binary — correlation, not content |
 * | what a reply MEANS | the orchestrator | `VERDICTS` below |
 * | may a stranger be contacted | **a human** | `RULINGS` below |
 *
 * `kona` makes the first two and refuses the last two. That refusal is the product.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MailboxProvider } from "../mailbox/port.ts";
import { steppingClock } from "../mailbox/clock.ts";
import { MemoryMailboxProvider } from "../mailbox/memory.ts";
import { MailpitProvider } from "../mailbox/mailpit.ts";
import { KONA_MAILBOX, firstPassRoster, persona } from "../personas/cast.ts";
import type { PersonaSlug } from "../personas/cast.ts";
import type { Outbound } from "../personas/simulator.ts";
import { replyAs, replyAddressOf } from "../personas/simulator.ts";
import * as kona from "../kona.ts";
import type { GraphJson } from "./assertions.ts";
import { asGraph } from "./assertions.ts";

/** Fixed, so a run reproduces byte for byte and can be diffed against the last one. */
const RUN_START = "2026-08-20T09:00:00.000Z";

/**
 * A stall is a bug, so the cap is a backstop rather than a schedule. It is deliberately far
 * above the eight iterations this story needs: a cap tight enough to be load-bearing would
 * turn "the pursuit finished" into "the loop ran out", which is the opposite claim.
 */
const MAX_ITERATIONS = 40;

/* ── what the orchestrator decides ───────────────────────────────────────────────────── */

/**
 * What each reply MEANS. The bodies live in `personas/simulator.ts` and say nothing about
 * verdicts; reading prose and concluding `declined` is the model's job, and §6.8 is explicit
 * that the binary must not do it.
 *
 * `attrs` is not colour. `role: "goalie"` is what `goalie-confirmed`'s predicate counts, and
 * `referral: "marcus"` is the ONLY thing that will later make Marcus contactable at all —
 * invariant 3(b) resolves a recipient against what the graph already carries, and this is
 * where he enters it. A verdict recorded without its attrs is a fact the graph cannot use.
 */
const VERDICTS: Partial<
  Record<PersonaSlug, { verdict: string; reasonCode: string; attrs: Record<string, string> }>
> = {
  dana: {
    verdict: "declined",
    reasonCode: "COUNTERPARTY_DECLINED",
    attrs: { role: "goalie", reason: "away that week" },
  },
  sam: {
    verdict: "declined",
    reasonCode: "COUNTERPARTY_DECLINED",
    attrs: { role: "goalie", referral: "marcus" },
  },
  marcus: { verdict: "confirmed", reasonCode: "QUORUM_MET", attrs: { role: "goalie" } },
};

/**
 * What to do when recording a verdict is REFUSED because it would strand a predicate.
 *
 * Invariant 2 (§6.7): a batch may not leave a predicate-wait unreachable. Sam is the second
 * of two goalies asked, so recording his refusal on its own leaves `goalie-confirmed` at
 * `0 matching + 0 still live` and the store answers `PREDICATE_UNSATISFIABLE` — "add a live
 * member in this batch, or supersede the wait".
 *
 * The loop does not know that in advance, and deliberately: it proposes the plain outcome,
 * is refused, and only then brings a plan. That is the invariant doing its actual job, which
 * is not blocking a bad write but forcing the model to have thought about the consequence
 * before it records the bad news. The refusal is logged to `.kona/rejections.jsonl` on the
 * way past (§8) — "what the mutator meant to do, in its own words, and what the store said
 * about it".
 *
 * The recovery ops come FIRST in the retried batch so their `$N` refs count from zero.
 */
interface Recovery {
  why: string;
  reasonCode: string;
  ops: () => unknown[];
}

const RECOVERIES: Partial<Record<PersonaSlug, Recovery>> = {
  sam: {
    reasonCode: "NEW_CONSTRAINT",
    why:
      "Sam cannot play but referred Marcus, who is not on the roster. Recording the refusal " +
      "alone would strand the quorum, so the eligibility check lands with it.",
    ops: () => [
      node("Check Marcus is eligible", "task", "marcus", {
        instruction: "Marcus is not on the roster. Confirm he is eligible before contacting him.",
        outputs: [{ name: "eligible", type: "boolean" }],
        effect_class: "pure",
      }),
      {
        op: "add_node",
        label: "Wait for eligibility ruling",
        type: "wait",
        scope: "marcus",
        spec: {
          instruction: "A human must rule on an unrostered player.",
          effect_class: "pure",
          deadline: { at: "2026-08-21T12:00:00.000Z" },
          on_timeout: "escalate-no-goalie-found",
          match: {
            kind: "human",
            conditions: [
              { kind: "decision", on: "accept" },
              { kind: "decision", on: "ignore" },
            ],
          },
        },
      },
      { op: "add_edge", from: "$0", to: "$1" },
      // The referral becomes TOPOLOGY rather than a string in a rationale: the arm hangs off
      // the refusal that produced it, so the graph records where Marcus came from.
      { op: "add_edge", from: "wait-for-sam", to: "$0", condition: { on: "satisfied" } },
      // And this is the edge that makes the quorum reachable again — the live member the
      // refusal above demands.
      { op: "add_edge", from: "$1", to: "goalie-confirmed", condition: { on: "accept" } },
    ],
  },
};

/**
 * What a HUMAN ruled, and the evidence they ruled on.
 *
 * §6.9's one gate: "The plan changes freely; the world does not; and nobody new enters the
 * world without a human." A `match.kind: "human"` wait cannot be resolved by mail, by a
 * deadline, or by the loop — so the loop stops at it and reads this table, which stands in
 * for the moment somebody was actually asked.
 *
 * The `evidence_ref` is a URI naming who ruled and when, because an approval nobody can trace
 * back to a person is indistinguishable from the model approving itself.
 */
const RULINGS: Record<
  string,
  { verdict: string; why: string; evidence_ref: string; attrs: Record<string, string> }
> = {
  "wait-for-eligibility-ruling": {
    verdict: "accept",
    why: "Ilya ruled Marcus eligible as Sam's registered substitute.",
    evidence_ref: "ruling://ilya/2026-08-20#marcus-eligible",
    attrs: { role: "goalie", counterparty: "marcus" },
  },
};

/**
 * What an approval must bring with it.
 *
 * The ruling resolves the last live member of the quorum, so recording it alone strands
 * `goalie-confirmed` exactly as Sam's refusal did — and the store says so. The recovery is the
 * arm the approval authorises, which makes the shape of the retried batch worth pausing on:
 * **the approval and the thing it approves are one commit.** You cannot approve, and then
 * decide later what the approval was for.
 *
 * Note what makes it legal at all. `ask-marcus` carries a `recipient_ref` naming him, and
 * invariant 3(b) resolves that against PRE-COMMIT head — so the ruling being in this same
 * batch does NOT evidence him. What does is Sam's refusal, committed several versions ago
 * with `attrs.referral: "marcus"`: a person named by a counterparty, in a message with an id.
 */
const RULING_RECOVERIES: Record<string, Recovery> = {
  "wait-for-eligibility-ruling": {
    why:
      "Ilya ruled Marcus eligible, which is what lets us contact him at all — so the ask goes " +
      "in the same commit as the ruling that authorises it.",
    reasonCode: "NEW_CONSTRAINT",
    ops: () => [
      askNode("Marcus", "marcus"),
      waitNode("Wait for Marcus", "$0", "escalate-no-goalie-found"),
      { op: "add_edge", from: "wait-for-eligibility-ruling", to: "$0", condition: { on: "accept" } },
      { op: "add_edge", from: "$0", to: "$1" },
      { op: "add_edge", from: "$1", to: "goalie-confirmed", condition: { on: "satisfied" } },
    ],
  },
};

/**
 * What each pure task produces, and what it read to produce it.
 *
 * Every entry carries an `evidence_ref` naming a thing outside the model — a roster file at a
 * version, a registration document at a page. That is not decoration either: `record_output`
 * requires one, and invariant 3(b) counts an output as evidence ONLY where its evidence was
 * retained. An output the model simply asserted vouches for nobody.
 */
const WORK: Record<string, { output_name: string; value: unknown; evidence_ref: string }> = {
  "confirm-roster-availability": {
    output_name: "availability",
    value: firstPassRoster(),
    evidence_ref: "roster.csv#v3",
  },
  "check-marcus-is-eligible": {
    output_name: "eligible",
    value: true,
    evidence_ref: "club-registration.pdf#p3",
  },
  "announce-the-goalie": {
    output_name: "goalie",
    value: "marcus",
    evidence_ref: "ruling://ilya/2026-08-20#marcus-eligible",
  },
};

/* ── the run ─────────────────────────────────────────────────────────────────────────── */

export interface PursuitOptions {
  provider: MailboxProvider;
  cwd?: string;
  narrate?: boolean;
}

export interface Iteration {
  /** 1-based, and it is the LOOP's count, not a version. Most iterations commit several. */
  n: number;
  version: number;
  ready: string[];
  did: string[];
}

export interface PursuitResult {
  cwd: string;
  head: GraphJson;
  iterations: Iteration[];
  sends: { node: string; to: string; effect_key: string }[];
  /** Batches the store refused, and what it said. Empty would mean a beat did not happen. */
  refusals: { subject: string; reason: string }[];
  /** What a fresh terminal is told once the loop stops. */
  resume: kona.ResumeReport;
}

export async function runPursuit(options: PursuitOptions): Promise<PursuitResult> {
  const cwd = options.cwd ?? (await mkdtemp(join(tmpdir(), "kona-pursuit-")));
  const narrate = options.narrate ?? true;
  const say = (line: string): void => {
    if (narrate) console.log(line);
  };
  const { provider } = options;

  const iterations: Iteration[] = [];
  const sends: PursuitResult["sends"] = [];
  /** Every batch the store refused. §8: a refused mutation is procedural memory too. */
  const refusals: { subject: string; reason: string }[] = [];
  /** Outbound sends by node id, so a persona can reply onto the right thread. */
  const outbound = new Map<string, Outbound>();
  /** Messages already handed to `kona poll`, so the world is not re-delivered every pass. */
  const delivered = new Set<string>();
  /** Reactions that have already fired. A re-plan is authored once or it is a loop. */
  const authored = new Set<string>();

  const konaBox = await provider.provision({
    address: `${KONA_MAILBOX.local}@${KONA_MAILBOX.domain}`,
    display_name: KONA_MAILBOX.display_name,
  });

  const graphNow = async (): Promise<GraphJson> => asGraph(await kona.graph(cwd));

  /** Commit, reading head rather than predicting it — which is what an orchestrator does. */
  const commit = async (why: string, reasonCode: string, ops: unknown[]): Promise<number> => {
    const { version } = await graphNow();
    return kona.mutate(cwd, { baseVersion: version, why, reasonCode, ops });
  };

  /**
   * Propose a batch; if the store refuses because it would strand a predicate, retry with the
   * recovery in front of it.
   *
   * The two-step is the point, not an optimisation. The loop does not know in advance which
   * answer breaks the quorum — invariant 2 is what tells it — and the retried batch is the
   * plan it was made to produce. A rig that pre-attached every recovery would pass without
   * the invariant existing at all.
   *
   * Recovery ops go FIRST so their `$N` refs count from zero.
   */
  const proposeOrRecover = async (
    why: string,
    reasonCode: string,
    ops: unknown[],
    recovery: Recovery | undefined,
    subject: string,
  ): Promise<"committed" | "recovered"> => {
    const { version } = await graphNow();
    const proposed = await kona.tryMutate(cwd, { baseVersion: version, why, reasonCode, ops });
    if (proposed.ok) return "committed";
    // The only refusal this rig knows how to answer. Anything else means the pursuit is in a
    // state nobody planned for, and stopping is the honest response.
    if (proposed.reason !== "PREDICATE_UNSATISFIABLE") {
      throw new Error(`${subject} was refused: ${proposed.stderr.trim()}`);
    }
    if (recovery === undefined) {
      throw new Error(
        `${subject} strands a predicate and this rig has no recovery for it: ${proposed.stderr.trim()}`,
      );
    }
    refusals.push({ subject, reason: proposed.reason });
    await commit(recovery.why, recovery.reasonCode, [...recovery.ops(), ...ops]);
    return "recovered";
  };

  await kona.init(cwd, "ilya", {
    identity: {
      mailbox: `${KONA_MAILBOX.local}@${KONA_MAILBOX.domain}`,
      display_name: KONA_MAILBOX.display_name,
      signature: "— Ilya",
      authority:
        "You may ask whether someone can play on Thursday and record their answer. " +
        "You may NOT commit funds, move the date or the venue, or contact anyone this brief does not name.",
    },
    effect_budget: 8,
  });
  say(`kona init ${cwd}`);

  // ── the authored graph ────────────────────────────────────────────────────────────────
  // ONE node, and no plan at all. The fan-out cannot be authored yet, and that is invariant
  // 3(b) deciding the shape rather than merely policing it: a recipient must resolve to
  // something ALREADY in the graph, and right now the graph has never heard of Dana.
  //
  // The escalation is not here either, and that is the frontier deciding the shape. A node
  // with no in-edges is READY — so an escape hatch authored before the thing it escapes from
  // is a node the loop would dispatch immediately, telling Ilya no goalie was found before
  // anyone had been asked. It arrives with the quorum it is the timeout arm of.
  await commit("Find out who is available before contacting anyone.", "MISSING_STEP", [
    node("Confirm roster availability", "task", "setup", {
      instruction: "Read the roster and list who has not yet answered.",
      outputs: [{ name: "availability", type: "string[]" }],
      effect_class: "pure",
    }),
  ]);
  say("authored: read the roster");

  // ── the loop ──────────────────────────────────────────────────────────────────────────
  for (let n = 1; n <= MAX_ITERATIONS; n += 1) {
    const ready = await kona.readyNodes(cwd);
    const graph = await graphNow();
    const did: string[] = [];

    if (ready.length === 0) {
      iterations.push({ n, version: graph.version, ready: [], did: ["nothing ready — done"] });
      say(`  ${n}. nothing ready at v${graph.version} — the pursuit is finished`);
      break;
    }

    // 1. DISPATCH every ready task. Waits are not dispatched: a wait is something the world
    //    has to do, and the only honest thing the loop can do with one is wait.
    for (const target of ready) {
      if (target.type !== "task") continue;
      if (target.spec.effect === undefined) {
        const work = WORK[target.id];
        if (work === undefined) {
          throw new Error(
            `kona next says '${target.id}' is ready and this rig has no work for it. ` +
              "Either the frontier is wrong or the script is incomplete; both are bugs.",
          );
        }
        await commit(`${target.label} is done; recording what it produced.`, "OTHER", [
          {
            op: "record_output",
            node: target.id,
            output_name: work.output_name,
            value: work.value,
            evidence_ref: work.evidence_ref,
          },
          { op: "set_status", node: target.id, status: "done", evidence_ref: work.evidence_ref },
        ]);
        did.push(`did ${target.id}`);
        continue;
      }
      const sent = await dispatch(target.id);
      outbound.set(target.id, sent.out);
      sends.push({ node: target.id, to: sent.to, effect_key: sent.key });
      did.push(`sent ${target.id}`);
    }

    // 2. THE WORLD ANSWERS. Every armed wait's address is asked for, the personas reply to
    //    whatever literal `Reply-To` the outbound carried, and the replies are read back out
    //    of the mailbox — never off the send receipt, which would let a broken `pollThread`
    //    pass.
    const inbound: unknown[] = [];
    for (const target of await kona.pollTargets(cwd)) {
      if (!target.armed) continue;
      const slug = personaOf(target.node_id, graph);
      if (slug === null) continue;
      const sentFor = outbound.get(askNodeFor(target.node_id, graph) ?? "");
      if (sentFor === undefined) continue;
      if (!delivered.has(target.node_id)) {
        const scripted = VERDICTS[slug];
        if (scripted === undefined) continue;
        await replyAs(provider, sentFor, slug);
        delivered.add(target.node_id);
      }
      const page = await provider.pollThread({ thread: sentFor.receipt.thread, cursor: null });
      const replyTo = replyAddressOf(sentFor);
      for (const message of page.messages) {
        if (!message.to.includes(replyTo)) continue;
        inbound.push(message);
      }
    }

    // 3. `kona poll --inbound` decides WHICH wait each message belongs to. It refuses to
    //    decide what any of them says, which is why step 4 exists at all.
    const matches = inbound.length === 0 ? [] : await kona.pollInbound(cwd, inbound);
    for (const match of matches) {
      if (match.late) continue;
      const wait = graph.nodes.find((candidate) => candidate.id === match.node_id);
      if (wait !== undefined && wait.status.state !== "active") continue;
      const slug = personaOf(match.node_id, graph);
      const scripted = slug === null ? undefined : VERDICTS[slug];
      if (scripted === undefined || slug === null) continue;

      const answer = [
        {
          op: "record_outcome",
          node: match.node_id,
          verdict: scripted.verdict,
          evidence_ref: match.message_id,
          attrs: scripted.attrs,
        },
        { op: "set_status", node: match.node_id, status: "done", evidence_ref: match.message_id },
      ];
      const why = `${slug} answered: ${scripted.verdict}.`;

      const outcome = await proposeOrRecover(
        why,
        scripted.reasonCode,
        answer,
        RECOVERIES[slug],
        `recording ${slug}'s answer`,
      );
      did.push(
        outcome === "committed"
          ? `${match.node_id} ${scripted.verdict}`
          : `${match.node_id} ${scripted.verdict} — REFUSED, then recorded with a plan`,
      );
    }

    // 4. THE HUMAN GATE. A `human` wait cannot be answered by mail or by a clock, so the loop
    //    stops here and reads what a person ruled.
    for (const target of ready) {
      if (target.type !== "wait") continue;
      const ruling = RULINGS[target.id];
      if (ruling === undefined) continue;
      if (authored.has(`ruled:${target.id}`)) continue;
      authored.add(`ruled:${target.id}`);
      const outcome = await proposeOrRecover(
        ruling.why,
        "NEW_CONSTRAINT",
        [
          {
            op: "record_outcome",
            node: target.id,
            verdict: ruling.verdict,
            evidence_ref: ruling.evidence_ref,
            attrs: ruling.attrs,
          },
          { op: "set_status", node: target.id, status: "done", evidence_ref: ruling.evidence_ref },
        ],
        RULING_RECOVERIES[target.id],
        `recording the human ruling on ${target.id}`,
      );
      did.push(
        outcome === "committed"
          ? `HUMAN ruled ${target.id} ${ruling.verdict}`
          : `HUMAN ruled ${target.id} ${ruling.verdict} — REFUSED, then recorded with the arm it authorises`,
      );
    }

    // 5. A PREDICATE is a judgement about a population, and the population only settles when
    //    every member has answered. `count(confirmed, role=goalie) >= 1` is checked here from
    //    the graph the binary handed over — never from what this script remembers doing.
    for (const target of ready) {
      if (target.type !== "wait") continue;
      const after = await graphNow();
      const confirmed = goaliesConfirmed(after, target.id);
      if (confirmed.length === 0) continue;
      await commit(
        `${confirmed.join(", ")} confirmed in goal, so the quorum is met.`,
        "QUORUM_MET",
        [
          {
            op: "record_outcome",
            node: target.id,
            verdict: "confirmed",
            evidence_ref: `predicate://${target.id}#${confirmed.join("+")}`,
            attrs: { role: "goalie" },
          },
          {
            op: "set_status",
            node: target.id,
            status: "done",
            evidence_ref: `predicate://${target.id}#${confirmed.join("+")}`,
          },
        ],
      );
      did.push(`${target.id} satisfied by ${confirmed.join(", ")}`);
    }

    // 6. RE-PLAN. What the world said changes what the plan should be, and this is the only
    //    place the graph grows. Each reaction fires once — a re-plan that could fire twice is
    //    a loop that never terminates.
    for (const reaction of REACTIONS) {
      if (authored.has(reaction.id)) continue;
      const latest = await graphNow();
      if (!reaction.when(latest)) continue;
      authored.add(reaction.id);
      await commit(reaction.why, reaction.reasonCode, reaction.ops(latest));
      did.push(`planned ${reaction.id}`);
    }

    const settled = await graphNow();
    iterations.push({ n, version: settled.version, ready: ready.map((r) => r.id), did });
    say(`  ${n}. v${graph.version}→v${settled.version}  ready [${ready.map((r) => r.id).join(", ")}]`);
    for (const line of did) say(`       ${line}`);

    if (settled.version === graph.version) {
      throw new Error(
        `iteration ${String(n)} moved nothing while ${String(ready.length)} node(s) were ready ` +
          `— [${ready.map((r) => r.id).join(", ")}]. The loop is stuck, which is a bug in the ` +
          "frontier or in this rig, never a reason to stop quietly.",
      );
    }
  }

  const head = await graphNow();
  const report = await kona.resume(cwd);

  if (narrate) {
    console.log("");
    console.log(`finished at v${head.version} · ${head.nodes.length} nodes`);
    for (const [state, count] of Object.entries(report.counts).toSorted(([a], [b]) => a.localeCompare(b))) {
      console.log(`  ${state.padEnd(10)} ${String(count)}`);
    }
    console.log(`  ready      ${report.frontier.length === 0 ? "nothing" : report.frontier.join(", ")}`);
    console.log(`  in flight  ${report.unknown_sends.length === 0 ? "nothing" : String(report.unknown_sends.length)}`);
  }

  return { cwd, head, iterations, sends, refusals, resume: report };

  /* ── the outbox dance, in the one place that sends ─────────────────────────────────── */

  async function dispatch(nodeId: string): Promise<{ out: Outbound; to: string; key: string }> {
    const slug = slugFromAskNode(nodeId);
    const who = persona(slug);
    // ASK THE BINARY for the correlation address. §6.5 puts that derivation in `kona`, and a
    // rig with its own copy of the rule can pass while the product is broken.
    const brief = await kona.brief(cwd, nodeId);
    const replyTo = brief.correlation?.reply_to;
    if (replyTo === undefined) {
      throw new Error(`kona brief gave '${nodeId}' no correlation address; it sends nothing`);
    }
    if (!brief.preconditions_satisfied.ok) {
      const failed = brief.preconditions_satisfied.checks.filter((check) => !check.ok);
      throw new Error(
        `kona next offered '${nodeId}' but kona brief refuses it: ` +
          failed.map((check) => `${check.name} — ${check.detail}`).join("; "),
      );
    }
    const envelope = {
      from: konaBox,
      to: [who.address],
      subject: "Thursday — can you play?",
      body_text:
        `Hi ${who.display_name.split(" ")[0] ?? who.display_name},\n\n` +
        "We're a player short for Thursday. Can you make it? A yes or no is plenty.\n\n" +
        "— Ilya",
      reply_to: replyTo,
    };
    const key = await kona.effectReserve(
      cwd,
      nodeId,
      kona.payloadHash(envelope.body_text),
      `inviting ${who.display_name} to play in goal on Thursday`,
    );
    const receipt = await provider.send(envelope);
    await kona.effectRecord(
      cwd,
      nodeId,
      key,
      "sent",
      receipt.message_id,
      `${receipt.provider} accepted it as ${receipt.message_id}`,
    );
    return { out: { envelope, receipt }, to: who.address, key };
  }
}

/* ── the re-plans, and what makes each one legal ─────────────────────────────────────── */

interface Reaction {
  id: string;
  why: string;
  reasonCode: string;
  when: (graph: GraphJson) => boolean;
  ops: (graph: GraphJson) => unknown[];
}

const REACTIONS: Reaction[] = [
  {
    id: "fan-out",
    why: "The roster named four; ask the two who might keep goal, and converge on a predicate.",
    reasonCode: "NEW_CONSTRAINT",
    // ONLY once the roster is committed. Authoring this in the same batch that reads the
    // roster is refused with UNEVIDENCED_RECIPIENT, and rightly: nothing outside that batch
    // would attest to Dana existing.
    when: (graph) => stateOf(graph, "confirm-roster-availability") === "done",
    // The escalation is `$0` and comes FIRST, because `on_timeout` on the waits below has to
    // name it and `$N` resolves only against an EARLIER op in the same batch. Naming it by
    // the slug it is about to be given is refused with `UNKNOWN_NODE`, and correctly — at
    // parse time it does not exist yet.
    ops: () => [
      node("Escalate: no goalie found", "task", "setup", {
        instruction: "Tell Ilya no goalie was found and the game needs a decision.",
        outputs: [{ name: "escalated", type: "boolean" }],
        effect_class: "pure",
      }),
      askNode("Dana", "dana"),
      waitNode("Wait for Dana", "$1", "$0"),
      askNode("Sam", "sam"),
      waitNode("Wait for Sam", "$3", "$0"),
      {
        op: "add_node",
        label: "Goalie confirmed",
        type: "wait",
        scope: "setup",
        spec: {
          instruction: "At least one goalie has confirmed.",
          effect_class: "pure",
          deadline: { at: "2026-08-21T17:00:00.000Z" },
          on_timeout: "$0",
          match: {
            kind: "predicate",
            conditions: [
              {
                kind: "predicate",
                on: "satisfied",
                predicate: { count: { verdict: "confirmed", attrs: { role: "goalie" } }, op: ">=", n: 1 },
              },
            ],
          },
        },
      },
      node("Announce the goalie", "task", "setup", {
        instruction: "Tell Ilya who is keeping goal on Thursday.",
        outputs: [{ name: "goalie", type: "string" }],
        effect_class: "pure",
      }),
      { op: "add_edge", from: "confirm-roster-availability", to: "$1" },
      { op: "add_edge", from: "$1", to: "$2" },
      { op: "add_edge", from: "$3", to: "$4" },
      { op: "add_edge", from: "$2", to: "$5", condition: { on: "satisfied" } },
      { op: "add_edge", from: "$4", to: "$5", condition: { on: "satisfied" } },
      { op: "add_edge", from: "$5", to: "$6", condition: { on: "satisfied" } },
      // THE EDGE THAT LETS THIS TERMINATE. The escalation is not a node sitting ready
      // forever; it is the timeout arm of the quorum, so a goalie confirming kills it and the
      // store drops it. Without this edge it stays in the frontier and no pursuit finishes.
      { op: "add_edge", from: "$5", to: "$0", condition: { on: "timeout" } },
    ],
  },
];

/* ── reading the graph the binary handed over ────────────────────────────────────────── */

function stateOf(graph: GraphJson, id: string): string | null {
  return graph.nodes.find((candidate) => candidate.id === id)?.status.state ?? null;
}

/**
 * The predicate, evaluated the way an orchestrator would: over the wait's own in-edges.
 *
 * Deliberately NOT `countPredicate` from `@kona/core`. Judging a predicate is the model's
 * job, and a rig that borrowed the store's implementation would prove the store agrees with
 * itself. Returning the names rather than a boolean is what lets the rationale say WHO.
 */
function goaliesConfirmed(graph: GraphJson, waitId: string): string[] {
  const quorum = graph.nodes.find((candidate) => candidate.id === waitId);
  if (quorum?.spec.match?.kind !== "predicate") return [];
  if (quorum.status.state !== "active") return [];
  const sources = graph.edges.filter((edge) => edge.to === waitId).map((edge) => edge.from);
  return sources.flatMap((id) => {
    const source = graph.nodes.find((candidate) => candidate.id === id);
    const met = (source?.status.outcomes ?? []).some(
      (outcome) => outcome.verdict === "confirmed" && outcome.attrs?.["role"] === "goalie",
    );
    return met ? [id.replace(/^wait-for-/, "")] : [];
  });
}

/** Which persona a wait is waiting on, via the ask node that feeds it. */
function personaOf(waitId: string, graph: GraphJson): PersonaSlug | null {
  const ask = askNodeFor(waitId, graph);
  if (ask === null) return null;
  try {
    return slugFromAskNode(ask);
  } catch {
    return null;
  }
}

function askNodeFor(waitId: string, graph: GraphJson): string | null {
  const source = graph.edges.find(
    (edge) => edge.to === waitId && edge.from.startsWith("ask-"),
  );
  return source?.from ?? null;
}

function slugFromAskNode(nodeId: string): PersonaSlug {
  const slug = /^ask-([a-z]+)-to-play-in-goal$/.exec(nodeId)?.[1];
  if (slug === undefined) throw new Error(`'${nodeId}' is not an ask node this rig can address`);
  return slug as PersonaSlug;
}

/* ── op builders ─────────────────────────────────────────────────────────────────────── */

function node(
  label: string,
  type: "task" | "wait",
  scope: string,
  spec: Record<string, unknown>,
): Record<string, unknown> {
  return { op: "add_node", label, type, scope, spec };
}

/** No declared output: what a send produced is the `effect_log` entry, and only that (§6.6). */
function askNode(name: string, slug: PersonaSlug): Record<string, unknown> {
  const who = persona(slug);
  return node(`Ask ${name} to play in goal`, "task", who.slug === "marcus" ? "marcus" : "goalies", {
    instruction: `Email ${name} asking if they can play in goal Thursday.`,
    effect_class: "pivot",
    effect: { channel: "email", recipient_ref: who.recipient_ref },
  });
}

/**
 * A wait on a reply, with §6.5's mandatory deadline and a timeout that routes somewhere real.
 *
 * `onTimeout` is a parameter rather than the constant it looks like it should be: inside the
 * batch that creates the escalation it has to be `$0`, and from the next batch on the slug is
 * the right reference.
 */
function waitNode(label: string, after: string, onTimeout: string): Record<string, unknown> {
  return node(label, "wait", label.includes("Marcus") ? "marcus" : "goalies", {
    instruction: `Await the reply to ${after}.`,
    effect_class: "pure",
    deadline: { after, duration: "48h" },
    on_timeout: onTimeout,
    match: {
      kind: "event",
      conditions: [
        { kind: "reply", on: "satisfied" },
        { kind: "deadline", on: "timeout" },
      ],
    },
  });
}

/* ── entry point ─────────────────────────────────────────────────────────────────────── */

export function providerFor(argv: readonly string[]): MailboxProvider {
  const clock = steppingClock(RUN_START);
  if (!argv.includes("--mailpit")) return new MemoryMailboxProvider({ clock });
  const flagIndex = argv.indexOf("--mailpit-url");
  const baseUrl = flagIndex === -1 ? undefined : argv[flagIndex + 1];
  return new MailpitProvider({ clock, ...(baseUrl === undefined ? {} : { baseUrl }) });
}

if (import.meta.main) {
  const result = await runPursuit({ provider: providerFor(process.argv.slice(2)) });
  const stuck = result.resume.frontier.length > 0 || result.resume.unknown_sends.length > 0;
  console.log("");
  console.log(`pursuit: ${result.cwd}`);
  console.log(`sends:   ${result.sends.length}, each from a slot the store issued`);
  process.exit(stuck ? 1 : 0);
}
