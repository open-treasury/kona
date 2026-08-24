/**
 * §6.3's `reason_code`, put into words.
 *
 * The code is the queryable half of the rationale and it is written for a machine:
 * `MISSING_STEP` is a value you can filter a log by, not a thing you say to a person. The
 * panel was rendering it raw, so the one field on the row that is supposed to say *what kind
 * of thing happened* was the least legible thing on it.
 *
 * Two functions, because the row and its tooltip want different amounts. `reasonLabel` is what
 * fits in a tag; `reasonGloss` is the sentence that says what the category actually means, and
 * lives in the tooltip because the row already has a sentence — §6.3's `why`, in serif, written
 * by whoever made the change. The gloss explains the *category*; `why` explains *this commit*.
 * Putting both inline would put them in competition, and `why` has to win.
 *
 * **Unknown codes render, they do not throw and they do not switch (D5).** `reasonLabel` falls
 * back to de-underscoring whatever it was handed, so a ninth code added to core reaches the
 * screen as words on the day it is added, with no viewer change. `reasonGloss` returns null and
 * the tooltip simply carries the raw code — an admission of ignorance rather than a wrong gloss.
 */

/**
 * One sentence per code, in the vocabulary a reader of the pursuit has rather than the
 * vocabulary the schema has. Deliberately about the CAUSE, not about the mechanics of the
 * mutation: "someone said no" rather than "an activity was superseded".
 */
const GLOSS: Readonly<Record<string, string>> = {
  COUNTERPARTY_DECLINED: "someone the pursuit asked said no",
  DEADLINE_PASSED: "a wait ran out of time before anything answered it",
  NEW_CONSTRAINT: "something outside the plan changed what it has to satisfy",
  MISSING_STEP: "the plan was incomplete — work that had to happen was not in it",
  QUORUM_MET: "enough answers arrived to settle a predicate",
  CONTRADICTION: "two things the plan was holding could not both be true",
  WITHDRAWN: "work that was planned is no longer wanted",
  OTHER: "none of the named causes fit — the sentence beside it is the whole answer",
};

/**
 * The tag's text: the code as words.
 *
 * The tag renders `uppercase` from the kit's `Tag` style, so this returns the words and lets
 * the stylesheet decide the case — `MISSING STEP` rather than `MISSING_STEP`. The underscore
 * is the entire difference between "a constant leaked onto the screen" and "a label".
 */
export function reasonLabel(code: string): string {
  return code.replaceAll("_", " ").toLowerCase();
}

/** What the category means, or null when this build has never heard of the code. */
export function reasonGloss(code: string): string | null {
  return GLOSS[code] ?? null;
}
