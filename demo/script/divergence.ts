/**
 * The divergence run — plan T7.4, and the beat that answers the `withParam` objection.
 *
 * It replays `fixtures/thursday.mutations.jsonl` as a **live run** — same node ids, same
 * rationale, same story — and then carries it four versions further, to where the arms stop
 * matching each other. Every mutation goes through `kona mutate` as a subprocess; every email
 * goes through a `MailboxProvider`. Nothing here imports `@kona/cli`.
 *
 * ## Why it does not stop where the fixture stops
 *
 * The fixture ends at v7 with five arms of exactly two nodes each — `{2,2,2,2,2}`. Spec §7's
 * *Divergent arms* test wants **three arms with pairwise different node counts**, and a
 * multiset with one distinct value cannot supply three.
 *
 * Measured against `demo/script/assertions.ts`, the committed fixture at head versus its own
 * v1 passes **(a) only**, and fails (b), (c) and (d). (b) fails because the fixture stops at
 * the eligibility ruling and never actually addresses Marcus, so no node is aimed at anyone
 * off the roster. That is a fact about the fixture, not about this script, and it is why the
 * run continues past it:
 *
 * | v | | arm sizes after |
 * |---|---|---|
 * | 5 | Sam's referral is wired, pulling the Marcus nodes into Sam's arm | sam 2 -> 4 |
 * | 8 | Pat's invitation lands; his wait is armed | unchanged |
 * | 9 | a human rules Marcus eligible, and only then may he be emailed | sam 4 -> 6 |
 * | 10 | Pat stays silent; the deadline fires and a follow-up sprouts | pat 2 -> 3 |
 * | 11 | Marcus confirms; the goalie predicate is satisfiable again | — |
 *
 * Which ends at `dana 2 · priya 2 · pat 3 · sam 6` — three pairwise different, produced
 * because the arms genuinely diverged rather than because anything was padded to make a test
 * pass. Note the first divergence lands at **v5**, not v8: the referral edge below starts it,
 * so the fixture's own last version already carries two distinct arm sizes.
 *
 * ## The one edge the fixture is missing
 *
 * The fixture records Sam's referral only as `attrs.referral: "marcus"` and a rationale
 * string; the Marcus nodes sit in the graph as a disconnected root. So this run also wires
 * `wait-for-sam → check-marcus-is-eligible`, which makes the referral *topology* rather than
 * prose. It is also what satisfies (d): an edge into a group that did not exist at v1.
 *
 * ## The gate, and what it is not
 *
 * Marcus is named at v5 and cannot be emailed until v9, after a human rules. That is the shape
 * invariant 3(b) demands — "a recipient existing only in the proposing batch is rejected" —
 * and §6.9's one gate: "The plan changes freely; the world does not; and nobody new enters the
 * world without a human."
 *
 * **The store does not enforce this yet.** `validate.ts` runs `checkInvariant1` and nothing
 * else, so a node addressed to an unevidenced counterparty commits happily today. There is a
 * test in `demo/test/divergence.test.ts` pinning that, which will go red when 3(b) lands.
 * Until then the beat is the plan's shape, and narrating it as something the binary refused
 * would be a lie.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MailboxProvider, SendReceipt } from "../mailbox/port.ts";
import { MailboxError, canScriptRejections } from "../mailbox/port.ts";
import { steppingClock } from "../mailbox/clock.ts";
import { MemoryMailboxProvider } from "../mailbox/memory.ts";
import { MailpitProvider } from "../mailbox/mailpit.ts";
import { KONA_MAILBOX, firstPassRoster, persona } from "../personas/cast.ts";
import type { Outbound, SimulatedEvent } from "../personas/simulator.ts";
import { PRIYA_BOUNCE, replyAddressOf, replyAs, silence } from "../personas/simulator.ts";
import * as kona from "../kona.ts";
import type { Assertion, GraphJson } from "./assertions.ts";
import { asGraph, assertDivergentArms } from "./assertions.ts";

/** Fixed, so a run reproduces byte for byte and can be diffed against the last one. */
const RUN_START = "2026-08-20T09:00:00.000Z";

export interface RunOptions {
  provider: MailboxProvider;
  /** The pursuit directory. One is made under the OS temp dir when omitted. */
  cwd?: string;
  /** Set false to run silently, which is what the test does. */
  narrate?: boolean;
}

export interface RunResult {
  cwd: string;
  head: GraphJson;
  v1: GraphJson;
  assertions: Assertion[];
  events: SimulatedEvent[];
  /** Every send the run made, with the provider and realm each was handled by (§6.11). */
  sends: { node: string; to: string; provider: string; sandbox_or_real: string }[];
}

export async function runDivergence(options: RunOptions): Promise<RunResult> {
  const cwd = options.cwd ?? (await mkdtemp(join(tmpdir(), "kona-demo-")));
  const narrate = options.narrate ?? true;
  const say = (line: string): void => {
    if (narrate) console.log(line);
  };
  const provider = options.provider;
  const events: SimulatedEvent[] = [];
  const sends: RunResult["sends"] = [];

  const konaBox = await provider.provision({
    address: `${KONA_MAILBOX.local}@${KONA_MAILBOX.domain}`,
    display_name: KONA_MAILBOX.display_name,
  });

  /**
   * Send the invitation a node stands for.
   *
   * `Reply-To` carries the correlation token for THIS node, fully expanded — §6.9 is explicit
   * that "a template variable that reaches a counterparty can never correlate".
   */
  const invite = async (nodeId: string, slug: Parameters<typeof persona>[0]): Promise<Outbound> => {
    const who = persona(slug);
    // ASK THE BINARY. §6.5 puts the correlation derivation in `kona`, and until `kona
    // brief` shipped this rig derived it itself from a quarantined stand-in. Reading it
    // here is what makes "the demo works" and "the system works" the same statement — a
    // rig with its own copy of the rule can pass while the product is broken.
    const nodeBrief = await kona.brief(cwd, nodeId);
    const replyTo = nodeBrief.correlation?.reply_to;
    if (replyTo === undefined) {
      throw new Error(`kona brief gave '${nodeId}' no correlation address; it sends nothing`);
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
    const receipt = await provider.send(envelope);
    sends.push({
      node: nodeId,
      to: who.address,
      provider: receipt.provider,
      sandbox_or_real: receipt.sandbox_or_real,
    });
    say(`    → ${nodeId}: sent to ${who.address}, reply-to ${envelope.reply_to}`);
    return { envelope, receipt };
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
    effect_budget: 12,
  });
  say(`kona init ${cwd}`);

  // ── v1 ── the approved plan. Dana is the only goalie on the roster.
  await kona.mutate(cwd, {
    baseVersion: 0,
    why: "Dana is the only goalie on the roster; ask her first.",
    reasonCode: "MISSING_STEP",
    ops: [
      node("Confirm roster availability", "task", "setup", {
        instruction: "Read the roster and list who has not yet answered.",
        outputs: [{ name: "availability", type: "string[]" }],
        effect_class: "pure",
      }),
      node("Escalate: no goalie found", "task", "setup", {
        instruction: "Tell Ilya no goalie was found and the game needs a decision.",
        outputs: [{ name: "escalated", type: "boolean" }],
        effect_class: "pure",
      }),
      askNode("Dana", "dana", { inputs: [{ ref: "confirm-roster-availability.availability" }] }),
      waitNode("Wait for Dana", "Await Dana's reply.", "$2", "$1"),
      { op: "add_edge", from: "$0", to: "$2" },
      { op: "add_edge", from: "$2", to: "$3" },
    ],
  });
  say("v1  the approved plan: confirm the roster, ask Dana, wait");
  const v1 = asGraph(await kona.graph(cwd));

  // ── v2 ── the roster came back with four names. Fan out, converge on a predicate.
  await kona.mutate(cwd, {
    baseVersion: 1,
    why: "Roster returned four names; ask all three goalies in parallel rather than serially.",
    reasonCode: "NEW_CONSTRAINT",
    ops: [
      {
        op: "record_output",
        node: "confirm-roster-availability",
        output_name: "availability",
        value: firstPassRoster(),
        evidence_ref: "roster.csv#v3",
      },
      {
        op: "set_status",
        node: "confirm-roster-availability",
        status: "done",
        evidence_ref: "roster.csv#v3",
      },
      askNode("Sam", "sam"),
      waitNode("Wait for Sam", "Await Sam's reply.", "$2"),
      askNode("Priya", "priya"),
      waitNode("Wait for Priya", "Await Priya's reply.", "$4"),
      {
        op: "add_node",
        label: "Goalie confirmed",
        type: "wait",
        scope: "setup",
        spec: {
          instruction: "At least one goalie has confirmed.",
          effect_class: "pure",
          deadline: { at: "2026-08-21T17:00:00.000Z" },
          on_timeout: "escalate-no-goalie-found",
          match: {
            kind: "predicate",
            conditions: [
              {
                kind: "predicate",
                on: "satisfied",
                predicate: {
                  count: { verdict: "confirmed", attrs: { role: "goalie" } },
                  op: ">=",
                  n: 1,
                },
              },
            ],
          },
        },
      },
      { op: "add_edge", from: "$2", to: "$3" },
      { op: "add_edge", from: "$4", to: "$5" },
      { op: "add_edge", from: "wait-for-dana", to: "$6", condition: { on: "satisfied" } },
      { op: "add_edge", from: "$3", to: "$6", condition: { on: "satisfied" } },
      { op: "add_edge", from: "$5", to: "$6", condition: { on: "satisfied" } },
    ],
  });
  say("v2  roster returns four names; fan out to Sam and Priya, converge on a predicate");

  // ── v3 ── the sends go out. Priya's is reserved but not yet dispatched (§6.6's outbox
  //          order: reserve and fsync BEFORE handing bytes to the world).
  const danaOut = await invite("ask-dana-to-play-in-goal", "dana");
  const samOut = await invite("ask-sam-to-play-in-goal", "sam");
  await kona.mutate(cwd, {
    baseVersion: 2,
    why: "Dana and Sam dispatched; Priya's send is reserved and in flight.",
    reasonCode: "OTHER",
    ops: [
      ...dispatched("ask-dana-to-play-in-goal", danaOut.receipt),
      ...dispatched("ask-sam-to-play-in-goal", samOut.receipt),
      {
        op: "set_status",
        node: "ask-priya-to-play-in-goal",
        status: "sending",
        evidence_ref: "ek_priya_v3",
      },
    ],
  });
  say("v3  Dana and Sam dispatched; Priya reserved and in flight");

  // ── v4 ── Dana declines. The premise breaks: the only goalie is out.
  const danaReply = await replyAs(provider, danaOut, "dana");
  events.push(danaReply);
  const danaEvidence = await evidenceFromMailbox(provider, danaOut, danaReply);
  await kona.mutate(cwd, {
    baseVersion: 3,
    why: "Dana is away that week. Her arm cannot satisfy the quorum.",
    reasonCode: "COUNTERPARTY_DECLINED",
    ops: [
      {
        op: "record_outcome",
        node: "wait-for-dana",
        verdict: "declined",
        evidence_ref: danaEvidence,
        attrs: { role: "goalie", reason: "away that week" },
      },
      { op: "set_status", node: "wait-for-dana", status: "done", evidence_ref: danaEvidence },
    ],
  });
  say("v4  Dana declines — away that week. The only goalie is gone");

  // ── v5 ── Sam declines and names someone the plan never heard of.
  const samReply = await replyAs(provider, samOut, "sam");
  events.push(samReply);
  const samEvidence = await evidenceFromMailbox(provider, samOut, samReply);
  await kona.mutate(cwd, {
    baseVersion: 4,
    why: "Sam cannot play but referred Marcus, who is not on the roster; eligibility needs a human.",
    reasonCode: "NEW_CONSTRAINT",
    ops: [
      {
        op: "record_outcome",
        node: "wait-for-sam",
        verdict: "declined",
        evidence_ref: samEvidence,
        attrs: { role: "goalie", referral: "marcus" },
      },
      { op: "set_status", node: "wait-for-sam", status: "done", evidence_ref: samEvidence },
      {
        op: "add_node",
        label: "Check Marcus is eligible",
        type: "task",
        scope: "marcus",
        spec: {
          instruction:
            "Marcus is not on the roster. Confirm he is eligible before contacting him.",
          outputs: [{ name: "eligible", type: "boolean" }],
          effect_class: "pure",
        },
      },
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
      { op: "add_edge", from: "$2", to: "$3" },
      { op: "add_edge", from: "$3", to: "goalie-confirmed", condition: { on: "accept" } },
      // Beyond the fixture, and the point of the beat: the referral becomes topology rather
      // than a string in a rationale. This is the edge that leaves `goalies` for `marcus` — a
      // group that did not exist at v1, which is what makes it evidence rather than labelling.
      { op: "add_edge", from: "wait-for-sam", to: "$2", condition: { on: "satisfied" } },
    ],
  });
  say("v5  Sam declines but refers MARCUS, who is not on the roster");

  // ── v6 ── the step that let an unrostered referral through is superseded, not rewritten.
  await kona.mutate(cwd, {
    baseVersion: 5,
    why: "The roster step missed eligibility, which is what let an unrostered referral through.",
    reasonCode: "MISSING_STEP",
    ops: [
      {
        op: "add_node",
        label: "Confirm roster availability and eligibility",
        type: "task",
        scope: "setup",
        spec: {
          instruction: "Read the roster, list non-responders, and flag anyone unrostered.",
          outputs: [{ name: "availability", type: "string[]" }],
          effect_class: "pure",
        },
      },
      { op: "supersede_node", node: "confirm-roster-availability", by: "$0" },
    ],
  });
  say("v6  the roster step is superseded by one that also checks eligibility");

  // ── v7 ── Priya's address is stale.
  //
  // Where the provider can refuse, it refuses, and the rejection travels the same path a real
  // one would: `send` throws and NOTHING is recorded as sent. Where it cannot — Mailpit is a
  // catch-all and accepts every address there is — the run says so out loud rather than
  // narrating a bounce that did not happen.
  const priyaAddress = persona("priya").address;
  let priyaBounce: string;
  if (canScriptRejections(provider)) {
    provider.rejectRecipient(priyaAddress, PRIYA_BOUNCE.code, PRIYA_BOUNCE.diagnostic);
    priyaBounce = await expectRejection(
      () => invite("ask-priya-to-play-in-goal", "priya"),
      (error) => {
        say(`    ✗ ${priyaAddress} refused by ${provider.name}: ${PRIYA_BOUNCE.diagnostic}`);
        return `smtp://${error.smtp_code ?? PRIYA_BOUNCE.code}#${PRIYA_BOUNCE.enhanced}`;
      },
    );
  } else {
    priyaBounce = `staged://${PRIYA_BOUNCE.code}#${PRIYA_BOUNCE.enhanced}`;
    say(
      `    ✗ ${priyaAddress} — ${provider.name} is a catch-all and cannot refuse a recipient,` +
        " so this 550 is STAGED, not transported. No mail was sent to Priya.",
    );
  }
  await kona.mutate(cwd, {
    baseVersion: 6,
    why: "Priya bounced with 550, so the pool is down to Marcus pending a ruling; ask Pat too.",
    reasonCode: "CONTRADICTION",
    ops: [
      {
        op: "set_status",
        node: "ask-priya-to-play-in-goal",
        status: "failed",
        evidence_ref: priyaBounce,
      },
      {
        op: "record_outcome",
        node: "wait-for-priya",
        verdict: "bounced",
        evidence_ref: priyaBounce,
        attrs: { role: "goalie", smtp: PRIYA_BOUNCE.diagnostic },
      },
      { op: "supersede_node", node: "wait-for-priya" },
      askNode("Pat", "pat"),
      waitNode(
        "Wait for Pat",
        "Await Pat's reply. Pat is often silent; the deadline is the plan.",
        "$3",
      ),
      { op: "add_edge", from: "$3", to: "$4" },
      { op: "add_edge", from: "$4", to: "goalie-confirmed", condition: { on: "satisfied" } },
      { op: "set_status", node: "$3", status: "sending", evidence_ref: "ek_pat_v7" },
    ],
  });
  say("v7  Priya bounces 550; her wait is dropped, and Pat's arm is planned");

  // ONLY NOW may Pat be emailed. The node has to exist before anything is sent for it —
  // §6.6's order is append, fsync, THEN the side effect, and `kona effect reserve` is what
  // makes that literal. The reservation moves the node to `sending` with a real key; the
  // hand-written `ek_pat_v7` this replaced was a slot the outbox had never issued.
  const patOut = await invite("ask-pat-to-play-in-goal", "pat");
  say("v8  Pat is asked");

  // ═══ past the fixture ═══════════════════════════════════════════════════════════════
  // Everything above is `fixtures/thursday.mutations.jsonl`, live. Everything below is where
  // the arms stop matching each other.

  // ── v8 ── Pat's invitation actually lands. The outbox's record step.
  await kona.mutate(cwd, {
    baseVersion: 7,
    why: "Pat's invitation is out; his wait is armed and the deadline is now the plan.",
    reasonCode: "OTHER",
    ops: dispatched("ask-pat-to-play-in-goal", patOut.receipt),
  });
  say("v8  Pat's invitation lands; his wait is armed");

  // ── v9 ── the gate. A human rules on the unrostered player, and ONLY THEN may he be
  //          emailed. Invariant 3(b): a recipient must resolve to an entity already in the
  //          graph carrying an `evidence_ref`.
  const ruling = "ruling://ilya/2026-08-20#marcus-eligible";
  await kona.mutate(cwd, {
    baseVersion: 8,
    why: "Ilya ruled Marcus eligible as Sam's registered substitute, which is what lets us contact him at all.",
    reasonCode: "NEW_CONSTRAINT",
    ops: [
      {
        op: "record_output",
        node: "check-marcus-is-eligible",
        output_name: "eligible",
        value: true,
        evidence_ref: ruling,
      },
      { op: "set_status", node: "check-marcus-is-eligible", status: "done", evidence_ref: ruling },
      {
        op: "record_outcome",
        node: "wait-for-eligibility-ruling",
        verdict: "accept",
        evidence_ref: ruling,
        attrs: { role: "goalie", counterparty: "marcus" },
      },
      {
        op: "set_status",
        node: "wait-for-eligibility-ruling",
        status: "done",
        evidence_ref: ruling,
      },
      askNode("Marcus", "marcus"),
      waitNode("Wait for Marcus", "Await Marcus's reply.", "$4"),
      { op: "add_edge", from: "wait-for-eligibility-ruling", to: "$4", condition: { on: "accept" } },
      { op: "add_edge", from: "$4", to: "$5" },
      { op: "add_edge", from: "$5", to: "goalie-confirmed", condition: { on: "satisfied" } },
    ],
  });
  say("v9  a human rules Marcus eligible — and only now may he be emailed");

  // ── v10 ── Pat's deadline passes. The deliberately boring arm grows the one thing silence
  //           can produce: a follow-up.
  events.push(silence(patOut, "pat"));
  await kona.mutate(cwd, {
    baseVersion: 9,
    why: "Pat has not answered and his deadline passed; chase once before writing the slot off.",
    reasonCode: "DEADLINE_PASSED",
    ops: [
      {
        op: "record_outcome",
        node: "wait-for-pat",
        verdict: "timed_out",
        evidence_ref: `deadline://wait-for-pat@${patOut.receipt.accepted_at}`,
        attrs: { role: "skater" },
      },
      {
        op: "set_status",
        node: "wait-for-pat",
        status: "done",
        evidence_ref: `deadline://wait-for-pat@${patOut.receipt.accepted_at}`,
      },
      {
        op: "add_node",
        label: "Chase Pat after silence",
        type: "task",
        scope: "goalies",
        spec: {
          instruction: "Pat did not answer the first ask. Send one short follow-up, then stop.",
          outputs: [{ name: "sent_message_id", type: "string" }],
          effect_class: "pivot",
          effect: { channel: "email", recipient_ref: persona("pat").recipient_ref },
        },
      },
      { op: "add_edge", from: "wait-for-pat", to: "$2", condition: { on: "timeout" } },
    ],
  });
  say("v10 Pat stays silent; the deadline fires and a follow-up sprouts");

  // ── v11 ── Marcus confirms. The predicate is satisfiable again.
  const marcusOut = await invite("ask-marcus-to-play-in-goal", "marcus");
  const marcusReply = await replyAs(provider, marcusOut, "marcus");
  events.push(marcusReply);
  const marcusEvidence = await evidenceFromMailbox(provider, marcusOut, marcusReply);
  await kona.mutate(cwd, {
    baseVersion: 10,
    why: "Marcus confirmed, so the goalie predicate is satisfiable from an arm that did not exist at v1.",
    reasonCode: "QUORUM_MET",
    ops: [
      ...dispatched("ask-marcus-to-play-in-goal", marcusOut.receipt),
      {
        op: "record_outcome",
        node: "wait-for-marcus",
        verdict: "confirmed",
        evidence_ref: marcusEvidence,
        attrs: { role: "goalie" },
      },
      { op: "set_status", node: "wait-for-marcus", status: "done", evidence_ref: marcusEvidence },
    ],
  });
  say("v11 Marcus confirms — from an arm that had no node and no template at v1");

  const head = asGraph(await kona.graph(cwd));
  const assertions = assertDivergentArms(head, v1);

  if (narrate) {
    console.log("");
    console.log(`§7 Divergent arms — v1 had ${v1.nodes.length} nodes, head has ${head.nodes.length}`);
    for (const assertion of assertions) {
      console.log(`  ${assertion.passed ? "PASS" : "FAIL"}  (${assertion.id}) ${assertion.claim}`);
      console.log(`        ${assertion.witness}`);
    }
  }

  return { cwd, head, v1, assertions, events, sends };
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

/** An invitation node. Every one carries a pivot effect addressed to an evidenced recipient. */
function askNode(
  name: string,
  slug: Parameters<typeof persona>[0],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const who = persona(slug);
  return node(`Ask ${name} to play in goal`, "task", who.slug === "marcus" ? "marcus" : "goalies", {
    instruction: `Email ${name} asking if they can play in goal Thursday.`,
    outputs: [{ name: "sent_message_id", type: "string" }],
    effect_class: "pivot",
    effect: { channel: "email", recipient_ref: who.recipient_ref },
    ...extra,
  });
}

/**
 * A wait on a reply, with the mandatory deadline and a timeout that routes somewhere real.
 *
 * `onTimeout` is a parameter rather than the constant it looks like it should be, because a
 * reference INSIDE a batch has to be symbolic: at v1 the escalation node is being created in
 * the same commit and is `$1`, and naming it by the slug it is about to get is refused with
 * `UNKNOWN_NODE`. From v2 on it exists at head and the slug is the right reference.
 */
function waitNode(
  label: string,
  instruction: string,
  after: string,
  onTimeout = "escalate-no-goalie-found",
): Record<string, unknown> {
  return node(label, "wait", label.includes("Marcus") ? "marcus" : "goalies", {
    instruction,
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

/** §6.6's record step: the bytes moved, and here is the id that proves it. */
function dispatched(nodeId: string, receipt: SendReceipt): Record<string, unknown>[] {
  return [
    { op: "set_status", node: nodeId, status: "done", evidence_ref: receipt.message_id },
    {
      op: "record_output",
      node: nodeId,
      output_name: "sent_message_id",
      value: receipt.message_id,
      evidence_ref: receipt.message_id,
    },
  ];
}

/**
 * Read the reply back OUT of the mailbox, and use what the world holds as the evidence.
 *
 * Taking the id off the simulator's own send receipt is the obvious shortcut and it hollows
 * the whole rig out: `poll-thread` is one of the port's three methods, and if nothing in the
 * deliverable calls it, a provider whose polling is broken still produces four green
 * assertions. Measured — a stub provider whose `pollThread` returns nothing at all passed the
 * entire run. So the run polls, and a broken `pollThread` now stops it here.
 *
 * It also asserts the thing §6.11's correlation scheme exists for: the reply came back
 * addressed to `ilya+kona-<node_id>@…`, the tag that routes it to this node and no other.
 *
 * A real consumer persists the cursor on the wait node (§6.5) rather than re-reading from
 * `null`; the rig re-reads because a version-by-version script has nowhere durable to keep one
 * until `kona poll` lands.
 */
async function evidenceFromMailbox(
  provider: MailboxProvider,
  outbound: Outbound,
  event: SimulatedEvent,
): Promise<string> {
  if (event.kind !== "replied") return `silence://${event.persona}`;

  const page = await provider.pollThread({ thread: outbound.receipt.thread, cursor: null });
  const reply = page.messages.find((message) => message.message_id === event.receipt.message_id);
  if (reply === undefined) {
    throw new Error(
      `${event.persona} replied, but ${provider.name} did not return it on thread ` +
        `${JSON.stringify(outbound.receipt.thread)} — the correlation round trip is broken`,
    );
  }

  const correlation = replyAddressOf(outbound);
  if (!reply.to.includes(correlation)) {
    throw new Error(
      `${event.persona}'s reply came back addressed to [${reply.to.join(", ")}], not to ` +
        `${correlation} — the tag that routes it to its node did not survive`,
    );
  }
  return reply.message_id;
}

/**
 * Run something that MUST be refused, and fail loudly if it succeeds.
 *
 * A send that was expected to bounce and did not is a broken beat, and quietly carrying on
 * would leave the graph recording a failure the world never produced — which is precisely the
 * divergence between the log and reality the whole system exists to prevent.
 */
async function expectRejection(
  attempt: () => Promise<unknown>,
  onRejected: (error: MailboxError) => string,
): Promise<string> {
  try {
    await attempt();
  } catch (error) {
    if (error instanceof MailboxError && error.reason === "SEND_REJECTED") return onRejected(error);
    throw error;
  }
  throw new Error("the send was ACCEPTED but the beat requires a refusal — the rig is broken");
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
  const result = await runDivergence({ provider: providerFor(process.argv.slice(2)) });
  const failed = result.assertions.filter((assertion) => !assertion.passed);
  console.log("");
  console.log(`pursuit: ${result.cwd}`);
  console.log(`sends:   ${result.sends.length}, all ${result.sends[0]?.sandbox_or_real ?? "n/a"}`);
  process.exit(failed.length === 0 ? 0 : 1);
}
