/**
 * Activity identity. §6.2: ids are store-minted, `[a-z0-9][a-z0-9-]*`, and never contain `/`.
 *
 * The separator rule is not cosmetic. An activity id becomes a correlation address
 * (`ilya+kona-<activity_id>@gmail.com`), so `goalie/dana` and `goalie-dana` would alias into
 * one reply address and two activities would share an inbox.
 *
 * Ids are `<prefix>-<hash>`: every activity in a pursuit opens with the same prefix, chosen once
 * at `kona init`, followed by four base36 characters derived from the label and the commit
 * it lands in. Two properties come out of that which the old label-slug ids did not have:
 *
 *   - **Fixed width.** A slug ran to the 48-character cap and was routinely truncated
 *     mid-word in a viewer rail — `build-production-schedule-respecting-all-constra`. An id
 *     is now at most 13 characters and never clipped.
 *   - **Stability under relabelling.** A slug encoded the label it was minted from, so a
 *     corrected label left an id that disagreed with it. A hash encodes nothing a human
 *     later edits.
 *
 * What it gives up is legibility, deliberately: `kona next` no longer reads as a sentence.
 * The label carries the meaning and the viewer shows it as the headline; the id is an
 * address.
 */

export const ACTIVITY_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Long enough to stay readable in a viewer; short enough to survive an email header. */
export const MAX_ACTIVITY_ID_LENGTH = 48;

/**
 * The prefix every id in a pursuit shares. One to eight lowercase characters, opening with a
 * letter, and no `-`: the dash is the boundary between prefix and hash, so allowing one
 * inside the prefix would make the boundary unreadable.
 */
export const PREFIX_PATTERN = /^[a-z][a-z0-9]{0,7}$/;

/** Four base36 characters: 36^4 = 1,679,616 per pursuit, and `taken` settles the rest. */
const HASH_LENGTH = 4;

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

export function isValidActivityId(id: string): boolean {
  // No emptiness check: the pattern already requires a leading `[a-z0-9]`, so `""` fails
  // it. A redundant `id.length > 0` would be an equivalent mutant by construction.
  return id.length <= MAX_ACTIVITY_ID_LENGTH && ACTIVITY_ID_PATTERN.test(id);
}

export function isValidPrefix(prefix: string): boolean {
  return PREFIX_PATTERN.test(prefix);
}

/**
 * Reduce a human label to the id alphabet. Deterministic and total: every input yields a
 * valid id, so minting never has to fail.
 *
 * No longer used for activity ids. It is kept because it is the right way to turn a directory
 * name into a candidate prefix, and because the plugin still slugs labels for display.
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    // `+` collapses each run in one pass, so no separate de-duplication step is needed —
    // and after it there is at most one leading and one trailing separator to trim.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    // Truncation can land mid-slug and leave the one separator the trim just removed.
    .slice(0, MAX_ACTIVITY_ID_LENGTH)
    .replace(/-$/, "");
  return slug.length > 0 ? slug : "activity";
}

/**
 * FNV-1a over the seed, rendered base36 and left-padded to a fixed width.
 *
 * Deliberately not a cryptographic hash: nothing here is adversarial, the output is 20 bits
 * wide before truncation, and `core` has no dependencies and no `node:crypto` — the purity
 * gate makes that a compile error rather than a preference.
 */
function hash36(seed: string, length: number): string {
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    // The FNV prime, as shifts: `h * 16777619` overflows to a float and loses the low bits.
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  let out = "";
  let n = h;
  for (let i = 0; i < length; i += 1) {
    out = BASE36[n % 36] + out;
    n = Math.floor(n / 36);
  }
  return out;
}

/**
 * Mint an id that is free in `taken`.
 *
 * Pure in every argument, which is what lets `fold` and `mutate` agree without either
 * consulting the other: minting happens once, at commit, and the log stores the result.
 *
 * `version` and `opIndex` join the label in the seed so that two activities with the same label
 * in different commits do not both hash to the same four characters and then both need the
 * collision loop. A collision is still possible, and `nonce` resolves it deterministically —
 * the same way Beads does, and for the same reason: re-seeding is reproducible where
 * re-rolling randomness is not.
 */
export function mintActivityId(
  prefix: string,
  name: string,
  version: number,
  opIndex: number,
  taken: ReadonlySet<string>,
): string {
  for (let nonce = 0; ; nonce += 1) {
    const candidate = `${prefix}-${hash36(`${name}|${version}|${opIndex}|${nonce}`, HASH_LENGTH)}`;
    if (!taken.has(candidate)) return candidate;
  }
}
