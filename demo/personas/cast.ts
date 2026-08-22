/**
 * The cast — spec §6.11, plan T7.3.
 *
 * **Six players plus a rival captain**, cut down from thirty by `plan.md` §0.5. `spec.md`
 * §6.11 gives the count and the reason in one line — "6 players + a rival captain. The claim
 * is divergence, not volume" — and the beads issue for T7.3 adds the rest of it: "a collapsed
 * container of thirty looks identical to one of six". Nothing here scales with cast size;
 * adding names back is a data change.
 *
 * ## The mailbox arithmetic this encodes
 *
 * Two mailboxes, not fourteen. §6.11: the correlation token goes in **Kona's own**
 * `Reply-To` — `ilya+kona-<node_id>@…` — so a fan-out needs **N tags on one inbox**, not N
 * inboxes. The personas answer from a second ordinary account, one tag each, because
 * send-as *aliases* cap at about thirty per user while plus-addressing is uncapped.
 *
 * Both halves use the sandbox domain here. Swapping in the real pair is `T7.2` and two
 * constants; nothing else in the rig knows the difference.
 *
 * ## Who is on the roster and who is not
 *
 * `rostered` is the load-bearing field. `confirm-roster-availability` returns exactly the
 * four rostered players, and **Marcus is deliberately not among them** — he arrives by
 * Sam's referral, which is the beat that answers the `withParam` objection (`prd.md` §9.3)
 * and the reason invariant 3(b) exists at all: a recipient must resolve to an entity
 * already in the graph carrying an `evidence_ref`, so Marcus cannot be emailed until a
 * human rules on him.
 */

/** Slugs are the join key: they appear in node ids, in `recipient_ref`s, and in tags. */
export const PLAYER_SLUGS = ["dana", "sam", "priya", "pat", "marcus", "nadia"] as const;
export type PlayerSlug = (typeof PLAYER_SLUGS)[number];

export const RIVAL_CAPTAIN_SLUG = "rowan";
export type PersonaSlug = PlayerSlug | typeof RIVAL_CAPTAIN_SLUG;

/** Kona's own mailbox. One inbox; the node id goes in the tag. */
export const KONA_MAILBOX = {
  local: "ilya",
  domain: "kona.demo",
  display_name: "Ilya Vorobiev (via Kona)",
} as const;

/** The persona simulator's mailbox. Also one inbox; the persona slug goes in the tag. */
export const PERSONA_MAILBOX = {
  local: "personas",
  domain: "kona.demo",
} as const;

/**
 * How this person entered the pursuit. The distinction is load-bearing twice over.
 *
 * `first_pass` is exactly the four names `confirm-roster-availability` returns at v2, and
 * `fixtures/thursday.mutations.jsonl` pins that list — so nothing may quietly widen it.
 *
 * `superseded_step` is what makes v6 worth doing. The fixture supersedes the roster step
 * with one that also "flags anyone unrostered" and then never shows what the better step
 * found; Nadia is what it found. §6.7's rule is that nothing is rewritten — the original
 * step keeps its trace and the improved one produces a longer list.
 */
export const DISCOVERY = ["first_pass", "superseded_step", "referral", "challenge"] as const;
export type Discovery = (typeof DISCOVERY)[number];

export interface Persona {
  slug: PersonaSlug;
  display_name: string;
  /** The address that answers. One mailbox, one tag each — see the note above. */
  address: string;
  /** On the roster document at all. Marcus is the one who is not. */
  rostered: boolean;
  /** Which step turned this person up. */
  discovery: Discovery;
  /** Plays in goal. Scarcity here is what makes losing Dana a crisis (`prd.md` §9). */
  goalie: boolean;
  /**
   * How `spec.effect.recipient_ref` names this person.
   *
   * Rostered players resolve against the roster document. **Marcus resolves against the
   * outcome of the human eligibility ruling**, because that ruling is the only thing in the
   * graph that evidences him — which is precisely the form invariant 3(b) demands, and the
   * reason "a recipient existing only in the proposing batch is rejected".
   */
  recipient_ref: string;
  /** One line on temperament, for anyone reading the transcript later. */
  temperament: string;
}

function personaAddress(slug: PersonaSlug): string {
  return `${PERSONA_MAILBOX.local}+${slug}@${PERSONA_MAILBOX.domain}`;
}

export const CAST: readonly Persona[] = [
  {
    slug: "dana",
    display_name: "Dana Whitfield",
    address: personaAddress("dana"),
    rostered: true,
    discovery: "first_pass",
    goalie: true,
    recipient_ref: "roster.contacts#dana",
    temperament: "Answers fast and plainly. The only goalie on the roster, so her no is the premise break.",
  },
  {
    slug: "sam",
    display_name: "Sam Okonkwo",
    address: personaAddress("sam"),
    rostered: true,
    discovery: "first_pass",
    goalie: false,
    recipient_ref: "roster.contacts#sam",
    temperament: "Cannot play, and says so — then offers a name the plan had never heard of. The rescue.",
  },
  {
    slug: "priya",
    display_name: "Priya Raman",
    address: personaAddress("priya"),
    rostered: true,
    discovery: "first_pass",
    goalie: false,
    recipient_ref: "roster.contacts#priya",
    temperament: "Never receives the mail at all. Her address is stale and the send bounces 550.",
  },
  {
    slug: "pat",
    display_name: "Pat Lindqvist",
    address: personaAddress("pat"),
    rostered: true,
    discovery: "first_pass",
    goalie: false,
    recipient_ref: "roster.contacts#pat",
    temperament: "Silent. The deliberately boring control, kept so the other arms have something to differ from.",
  },
  {
    slug: "marcus",
    display_name: "Marcus Okonkwo",
    address: personaAddress("marcus"),
    rostered: false,
    discovery: "referral",
    goalie: true,
    recipient_ref: "wait-for-eligibility-ruling.outcome#marcus",
    temperament: "Sam's brother. Off-roster, plays in goal, and cannot be contacted until a human rules him eligible.",
  },
  {
    slug: "nadia",
    display_name: "Nadia Ferreira",
    address: personaAddress("nadia"),
    rostered: true,
    discovery: "superseded_step",
    goalie: false,
    recipient_ref: "roster.contacts#nadia",
    temperament: "A non-responder the first roster step missed; the superseded step finds her.",
  },
  {
    slug: RIVAL_CAPTAIN_SLUG,
    display_name: "Rowan Beck (Ravens)",
    address: personaAddress(RIVAL_CAPTAIN_SLUG),
    rostered: false,
    discovery: "challenge",
    goalie: false,
    recipient_ref: "ravens.contacts#rowan",
    temperament: "Opened the pursuit with the challenge, and holds the date. Not a player; a counterparty.",
  },
];

const BY_SLUG = new Map<PersonaSlug, Persona>(CAST.map((entry) => [entry.slug, entry]));

export function persona(slug: PersonaSlug): Persona {
  const found = BY_SLUG.get(slug);
  if (found === undefined) throw new Error(`no persona: ${slug}`);
  return found;
}

/**
 * Exactly what `confirm-roster-availability` returns at v2, and the set §7.2 assertion (b)
 * checks Marcus against. Pinned by `fixtures/thursday.mutations.jsonl` — widening it is a
 * fixture change, not a cast change.
 */
export function firstPassRoster(): PlayerSlug[] {
  return PLAYER_SLUGS.filter((slug) => persona(slug).discovery === "first_pass");
}

/** What the superseded step returns: the first pass plus whoever it missed. */
export function fullRoster(): PlayerSlug[] {
  return PLAYER_SLUGS.filter((slug) => persona(slug).rostered);
}
