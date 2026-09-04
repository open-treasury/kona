/**
 * Matching inbound mail to armed waits (§6.5).
 *
 * The rule that carries the most weight is **first-match-wins**, in both directions: one
 * reply advances one guard, and one reply advances one acceptEvent. Evaluate-all would let a
 * single message resolve two fanned-out arms, which is unrecoverable under no-rollback.
 */

import { describe, expect, test } from "bun:test";
import type { AuthoredOp, Graph, InboundMessage } from "../src/index.ts";
import { matchInbound, matchWait, waitAddresses } from "../src/index.ts";
import { commit, seeded, action, acceptEvent, activityAt, nid, slugOf } from "./fixtures.ts";

const MAILBOX = "ilya@example.com";

/**
 * A plausible inbound reply.
 *
 * The default `to` used to be spelled out, because a slug id was predictable. It is a hash
 * now, so the caller passes the address it wants — every test that depends on which acceptEvent the
 * message is for was already doing that.
 */
function message(over: Partial<InboundMessage> & { message_id: string }): InboundMessage {
  return {
    from: "Dana <dana@example.com>",
    to: ["ilya@example.com"],
    subject: "Re: Thursday",
    received_at: "2026-08-22T10:00:00.000Z",
    ...over,
  };
}

/** `escalate` (action) then one event-acceptEvent per name. */
function waiting(...names: string[]): Graph {
  return seeded([
    action("Escalate"),
    ...names.map((name) =>
      acceptEvent(name, {
                deadline: { at: "2026-08-30T12:00:00.000Z" },
        match: {
          kind: "event",
          conditions: [
            { kind: "reply", on: "satisfied" },
            { kind: "deadline", on: "timeout" },
          ],
        },
      }),
    ),
  ]);
}

function activityOf(graph: Graph, id: string) {
  const activity = activityAt(graph, id);
  if (activity === undefined) throw new Error(`no activity ${id}`);
  return activity;
}

describe("which addresses are worth polling", () => {
  test("an armed event-acceptEvent, with its fully expanded reply address", () => {
    const graph = waiting("Await Dana");
    const id = nid(graph, "await-dana");
    expect(waitAddresses(graph, MAILBOX)).toEqual([
      {
        activity_id: id,
        name: "Await Dana",
        // The reply address is built from the activity id, so it moves with it.
        address: `ilya+kona-${id}@example.com`,
        armed: true,
      },
    ]);
  });

  test("a RESOLVED acceptEvent stays pollable — §6.5 requires a late reply to be recorded", () => {
    const resolved = commit(waiting("Await Dana"), [
      { op: "record_outcome", node: "await-dana", verdict: "confirmed", evidence_ref: "<m-1>" },
      { op: "set_status", node: "await-dana", status: "completed", evidence_ref: "<m-1>" },
    ]);
    const id = nid(resolved, "await-dana");
    expect(waitAddresses(resolved, MAILBOX)).toEqual([
      {
        activity_id: id,
        name: "Await Dana",
        address: `ilya+kona-${id}@example.com`,
        armed: false,
      },
    ]);
  });

  test("a action is never polled, however much it looks like one", () => {
    expect(waitAddresses(seeded([action("Ask Dana")]), MAILBOX)).toEqual([]);
  });

  test("a predicate or human acceptEvent has no inbox to poll", () => {
    const graph = seeded([
      action("Escalate"),
      acceptEvent("Quorum", {
                match: {
          kind: "predicate",
          conditions: [
            {
              kind: "predicate",
              on: "satisfied",
              // A predicate acceptEvent must carry one: without it nothing counts against the acceptEvent
              // and invariant 2 can never judge it satisfiable.
              predicate: { count: { verdict: "confirmed", attrs: { role: "goalie" } }, op: ">=", n: 1 },
            },
          ],
        },
      }),
    ]);
    expect(waitAddresses(graph, MAILBOX)).toEqual([]);
  });

  test("an abandoned or superseded acceptEvent is not polled", () => {
    const dropped = commit(waiting("Await Dana"), [
      { op: "set_status", node: "await-dana", status: "terminated", evidence_ref: "e" },
    ]);
    expect(waitAddresses(dropped, MAILBOX)).toEqual([]);
  });

  test("an unusable mailbox yields nothing rather than a broken address", () => {
    expect(waitAddresses(waiting("Await Dana"), "not-an-address")).toEqual([]);
  });

  test("each arm of a fan-out gets its own tag on the one inbox", () => {
    const graph = waiting("Await Dana", "Await Sam", "Await Priya");
    const addresses = waitAddresses(graph, MAILBOX).map((target) => target.address);
    // Each arm's address is built from its own activity id, so three arms give three addresses.
    expect(addresses).toEqual(
      ["await-dana", "await-sam", "await-priya"].map(
        (slug) => `ilya+kona-${nid(graph, slug)}@example.com`,
      ),
    );
    expect(new Set(addresses).size).toBe(3);
  });
});

describe("matching one acceptEvent", () => {
  const graph = waiting("Await Dana");
  const address = `ilya+kona-${nid(graph, "await-dana")}@example.com`;
  const options = { ownMailbox: MAILBOX };

  test("a reply to the acceptEvent's own address matches", () => {
    const match = matchWait(activityOf(graph, "await-dana"), [message({ message_id: "<m-1>", to: [address] })], address, options);
    expect(match?.message_id).toBe("<m-1>");
    expect(match?.on).toBe("satisfied");
    expect(match?.late).toBe(false);
  });

  test("OUR OWN outbound copy is not a reply", () => {
    // A thread carries both halves of the conversation; both implementations of the port
    // are capture sinks over one store. Matching our own send would resolve the acceptEvent the
    // instant it was armed.
    const own = message({ message_id: "<own-1>", from: "Ilya <ilya@example.com>", to: [address] });
    expect(matchWait(activityOf(graph, "await-dana"), [own], address, options)).toBeNull();
  });

  test("mail to a different tag belongs to a different acceptEvent", () => {
    // Some other acceptEvent's tag. It does not have to exist — the point is that it is not this
    // activity's address, and correlation is what decides.
    const other = message({ message_id: "<m-2>", to: ["ilya+kona-someone-else@example.com"] });
    expect(matchWait(activityOf(graph, "await-dana"), [other], address, options)).toBeNull();
  });

  test("mail to the untagged mailbox matches nothing — correlation is the whole point", () => {
    const untagged = message({ message_id: "<m-3>", to: [MAILBOX] });
    expect(matchWait(activityOf(graph, "await-dana"), [untagged], address, options)).toBeNull();
  });

  test("the tag is found in reply_to as well as to", () => {
    const viaReplyTo = message({ message_id: "<m-4>", to: [MAILBOX], reply_to: [address] });
    expect(matchWait(activityOf(graph, "await-dana"), [viaReplyTo], address, options)?.message_id).toBe("<m-4>");
  });

  test("addresses compare case-insensitively, as mail does", () => {
    const shouted = message({ message_id: "<m-5>", to: [address.toUpperCase()] });
    expect(matchWait(activityOf(graph, "await-dana"), [shouted], address, options)?.message_id).toBe("<m-5>");
  });

  test("a message already recorded against this acceptEvent is skipped", () => {
    // The dedupe set costs nothing: it is the acceptEvent's own outcomes. No cursor to persist,
    // and none to lose.
    const seen = commit(graph, [
      { op: "record_outcome", node: "await-dana", verdict: "tentative", evidence_ref: "<m-1>" },
    ]);
    const messages = [message({ message_id: "<m-1>", to: [address] }), message({ message_id: "<m-6>", to: [address] })];
    expect(matchWait(activityOf(seen, "await-dana"), messages, address, options)?.message_id).toBe("<m-6>");
  });

  test("a tentative reply leaves the acceptEvent armed, so the next one still matches", () => {
    const tentative = commit(graph, [
      { op: "record_outcome", node: "await-dana", verdict: "tentative", evidence_ref: "<m-1>" },
    ]);
    const match = matchWait(activityOf(tentative, "await-dana"), [message({ message_id: "<m-7>", to: [address] })], address, options);
    expect(match?.late).toBe(false);
  });

  test("once resolved, a straggler is matched and flagged LATE", () => {
    const resolved = commit(graph, [
      { op: "record_outcome", node: "await-dana", verdict: "confirmed", evidence_ref: "<m-1>" },
      { op: "set_status", node: "await-dana", status: "completed", evidence_ref: "<m-1>" },
    ]);
    const match = matchWait(activityOf(resolved, "await-dana"), [message({ message_id: "<m-8>", to: [address] })], address, options);
    expect(match?.late).toBe(true);
  });

  test("FIRST match wins within the or-group", () => {
    const twoWays = seeded([
      action("Escalate"),
      acceptEvent("Await Dana", {
                deadline: { at: "2026-08-30T12:00:00.000Z" },
        match: {
          kind: "event",
          conditions: [
            { kind: "reply", on: "respond" },
            { kind: "reply", on: "satisfied" },
          ],
        },
      }),
    ]);
    expect(matchWait(activityOf(twoWays, "await-dana"), [message({ message_id: "<m-9>", to: [address] })], address, options)?.on)
      .toBe("respond");
  });

  test("a guard scoped to one sender ignores everybody else", () => {
    const fromDana = seeded([
      action("Escalate"),
      acceptEvent("Await Dana", {
                deadline: { at: "2026-08-30T12:00:00.000Z" },
        match: {
          kind: "event",
          conditions: [{ kind: "reply", on: "satisfied", from: "dana@example.com" }],
        },
      }),
    ]);
    const activity = activityOf(fromDana, "await-dana");
    const sam = message({ message_id: "<m-10>", from: "sam@example.com" , to: [address] });
    const dana = message({ message_id: "<m-11>", from: "DANA@example.com" , to: [address] });
    expect(matchWait(activity, [sam], address, options)).toBeNull();
    expect(matchWait(activity, [dana], address, options)?.message_id).toBe("<m-11>");
  });

  test("a guard scoped to a thread ignores replies to anything else", () => {
    const threaded = seeded([
      action("Escalate"),
      acceptEvent("Await Dana", {
                deadline: { at: "2026-08-30T12:00:00.000Z" },
        match: {
          kind: "event",
          conditions: [{ kind: "reply", on: "satisfied", in_reply_to: ["<sent-1>"] }],
        },
      }),
    ]);
    const activity = activityOf(threaded, "await-dana");
    expect(matchWait(activity, [message({ message_id: "<a>", in_reply_to: "<other>", to: [address] })], address, options)).toBeNull();
    expect(matchWait(activity, [message({ message_id: "<b>", to: [address] })], address, options)).toBeNull();
    expect(matchWait(activity, [message({ message_id: "<c>", in_reply_to: "<sent-1>", to: [address] })], address, options)?.message_id)
      .toBe("<c>");
  });

  test("a DEADLINE guard never matches a message — that is the clock's job", () => {
    const clockOnly = seeded([
      action("Escalate"),
      acceptEvent("Await Dana", {
                deadline: { at: "2026-08-30T12:00:00.000Z" },
        match: { kind: "event", conditions: [{ kind: "deadline", on: "timeout" }] },
      }),
    ]);
    expect(matchWait(activityOf(clockOnly, "await-dana"), [message({ message_id: "<m-12>", to: [address] })], address, options))
      .toBeNull();
  });

  test("messages are considered oldest first", () => {
    const messages = [message({ message_id: "<first>", to: [address] }), message({ message_id: "<second>", to: [address] })];
    expect(matchWait(activityOf(graph, "await-dana"), messages, address, options)?.message_id).toBe("<first>");
  });
});

describe("matching a batch across waits", () => {
  test("ONE reply advances ONE acceptEvent, never two", () => {
    // Evaluate-all would let a single message resolve two fanned-out arms, and there is no
    // rollback to undo the second.
    const graph = waiting("Await Dana", "Await Sam");
    const shared = message({
      message_id: "<m-1>",
      to: [`ilya+kona-${nid(graph, "await-dana")}@example.com`, `ilya+kona-${nid(graph, "await-sam")}@example.com`],
    });
    const matches = matchInbound(graph, MAILBOX, [shared]);
    expect(matches).toHaveLength(1);
    expect(slugOf(matches[0]?.activity_id ?? "")).toBe("await-dana");
  });

  test("distinct replies advance their own arms", () => {
    const graph = waiting("Await Dana", "Await Sam");
    const matches = matchInbound(graph, MAILBOX, [
      message({ message_id: "<m-sam>", to: [`ilya+kona-${nid(graph, "await-sam")}@example.com`] }),
      message({ message_id: "<m-dana>", to: [`ilya+kona-${nid(graph, "await-dana")}@example.com`] }),
    ]);
    expect(matches.map((m) => [slugOf(m.activity_id), m.message_id])).toEqual([
      ["await-dana", "<m-dana>"],
      ["await-sam", "<m-sam>"],
    ]);
  });

  test("one acceptEvent takes at most one message per poll", () => {
    const graph = waiting("Await Dana");
    const to = [`ilya+kona-${nid(graph, "await-dana")}@example.com`];
    const matches = matchInbound(graph, MAILBOX, [
      message({ message_id: "<m-1>", to }),
      message({ message_id: "<m-2>", to }),
    ]);
    expect(matches).toHaveLength(1);
  });

  test("an empty inbox and an empty graph both yield nothing", () => {
    expect(matchInbound(waiting("Await Dana"), MAILBOX, [])).toEqual([]);
    // A graph with no waits matches nothing, whatever the message is addressed to.
    expect(
      matchInbound(seeded([action("A")]), MAILBOX, [
        message({ message_id: "<m-1>", to: ["ilya+kona-nobody@example.com"] }),
      ]),
    ).toEqual([]);
  });

  test("it is idempotent once the orchestrator has recorded the outcome", () => {
    const graph = waiting("Await Dana");
    const inbox = [
      message({ message_id: "<m-1>", to: [`ilya+kona-${nid(graph, "await-dana")}@example.com`] }),
    ];
    expect(matchInbound(graph, MAILBOX, inbox)).toHaveLength(1);

    const recorded = commit(graph, [
      { op: "record_outcome", node: "await-dana", verdict: "confirmed", evidence_ref: "<m-1>" },
      { op: "set_status", node: "await-dana", status: "completed", evidence_ref: "<m-1>" },
    ] as AuthoredOp[]);
    expect(matchInbound(recorded, MAILBOX, inbox)).toEqual([]);
  });
});
