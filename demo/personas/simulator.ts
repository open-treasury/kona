/**
 * The reply simulator — plan T7.3.
 *
 * It produces **the world's bytes and nothing else.** A persona replying is an ordinary
 * `send` from the persona mailbox through the same `MailboxProvider` the pursuit sends
 * through, which is what it is against a real Gmail too.
 *
 * ## What is deliberately not here
 *
 * The verdict. "Did Dana say yes" is the plugin's question, not the binary's (§6.8), and
 * mirroring that split in the file layout is worth one extra hop for a reader: the email
 * text lives here, and what the orchestrator concluded from it lives in the beat table in
 * `demo/script/divergence.ts`. Nothing in this file decides anything.
 *
 * Correlation is also not here. A reply goes to whatever literal address the outbound put in
 * `Reply-To`, copied verbatim. This file never splits an address on `+`, and the fact that
 * the tag happens to encode a node id is knowledge it does not have.
 *
 * ## Silence is a scripted act
 *
 * Pat is the deliberately boring arm, and `silence()` exists so that "Pat was asked and did
 * not answer" is a line in the transcript rather than an absence a reader has to notice.
 * §6.5 makes the deadline the plan for exactly this case.
 */

import type { Envelope, MailboxProvider, SendReceipt } from "../mailbox/port.ts";
import type { Persona, PersonaSlug } from "./cast.ts";
import { persona } from "./cast.ts";

/** An outbound send, paired with the receipt it produced, so a reply can thread onto it. */
export interface Outbound {
  envelope: Envelope;
  receipt: SendReceipt;
}

/** What a persona says when they answer. `null` means they do not. */
export const REPLY_BODIES: Readonly<Record<PersonaSlug, string | null>> = {
  dana:
    "Ah, I'm sorry — I'm away that whole week, visiting my sister. I won't be back until " +
    "the Sunday. Really wish I could; ask me for the next one.",
  sam:
    "I can't make Thursday, sorry. But my brother Marcus plays goalie and he's around — " +
    "want me to ask him?",
  // Priya never receives the mail at all, so there is nothing for her to answer. Her beat
  // is a `550` at send time, not a reply. See `rejectRecipient` in `mailbox/memory.ts`.
  priya: null,
  // Pat is the control. Silence is the point.
  pat: null,
  marcus:
    "Sam mentioned it — yes, I can play. I have my own kit. Where and what time?",
  nadia:
    "Sorry for the slow reply. I can play out but I'm no goalie, if that's what you need.",
  rowan:
    "Thursday works for us. Ravens will bring a full bench. Confirm the sheet and we'll " +
    "see you there.",
};

/**
 * Priya's bounce, as a provider would report it.
 *
 * `550 5.1.1` is "user unknown" — the address is stale, not the mailbox full. It matters
 * that this is a *hard* failure: a soft one would be retried, and §6.6's whole point is
 * that "attempted-without-completion is human adjudication, not retry".
 */
export const PRIYA_BOUNCE = {
  code: 550,
  enhanced: "5.1.1",
  diagnostic: "550 5.1.1 user unknown",
} as const;

/** What the simulator did, in a form a transcript can print and a test can assert on. */
export type SimulatedEvent =
  | { kind: "replied"; persona: PersonaSlug; receipt: SendReceipt; to: string }
  | { kind: "silent"; persona: PersonaSlug; asked_at: string };

/**
 * Send `slug`'s scripted reply to whatever address the outbound asked replies to go to.
 *
 * Throws if the persona has no scripted reply — silence is `silence()`, and conflating the
 * two would let a missing script pass as a deliberate non-answer.
 */
export async function replyAs(
  provider: MailboxProvider,
  outbound: Outbound,
  slug: PersonaSlug,
): Promise<SimulatedEvent> {
  const who = persona(slug);
  const body = REPLY_BODIES[slug];
  if (body === null) {
    throw new Error(`${slug} has no scripted reply; use silence() if that is the beat`);
  }

  const from = await provider.provision({ address: who.address, display_name: who.display_name });

  // The literal reply-to, copied. This is the correlation token doing its job, and the
  // simulator's total ignorance of what is inside it is the point (§6.5).
  const to = replyAddressOf(outbound);
  const references = [...(outbound.envelope.references ?? []), outbound.receipt.message_id];

  const receipt = await provider.send({
    from,
    to: [to],
    subject: reSubject(outbound.envelope.subject),
    body_text: body,
    in_reply_to: outbound.receipt.message_id,
    references,
  });

  return { kind: "replied", persona: slug, receipt, to };
}

/** Record that a persona was asked and will not answer. Sends nothing, by design. */
export function silence(outbound: Outbound, slug: PersonaSlug): SimulatedEvent {
  return { kind: "silent", persona: slug, asked_at: outbound.receipt.accepted_at };
}

/**
 * Where a reply goes.
 *
 * `Reply-To` when the outbound set one, and the sending address otherwise — which is the
 * ordinary mail-client rule. Kona always sets one, so the fallback is for hand-built
 * envelopes in tests rather than for the pursuit.
 */
export function replyAddressOf(outbound: Outbound): string {
  return outbound.envelope.reply_to ?? outbound.envelope.from.address;
}

function reSubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

export function personaFor(slug: PersonaSlug): Persona {
  return persona(slug);
}
