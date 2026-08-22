/**
 * Node identity. §6.2: ids are store-minted, `[a-z0-9][a-z0-9-]*`, and never contain `/`.
 *
 * The separator rule is not cosmetic. A node id becomes a correlation address
 * (`ilya+kona-<node_id>@gmail.com`), so `goalie/dana` and `goalie-dana` would alias into
 * one reply address and two nodes would share an inbox.
 */

export const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Long enough to stay readable in a viewer; short enough to survive an email header. */
export const MAX_NODE_ID_LENGTH = 48;

export function isValidNodeId(id: string): boolean {
  // No emptiness check: the pattern already requires a leading `[a-z0-9]`, so `""` fails
  // it. A redundant `id.length > 0` would be an equivalent mutant by construction.
  return id.length <= MAX_NODE_ID_LENGTH && NODE_ID_PATTERN.test(id);
}

/**
 * Reduce a human label to the id alphabet. Deterministic and total: every input yields a
 * valid id, so minting never has to fail.
 */
export function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    // `+` collapses each run in one pass, so no separate de-duplication step is needed —
    // and after it there is at most one leading and one trailing separator to trim.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    // Truncation can land mid-slug and leave the one separator the trim just removed.
    .slice(0, MAX_NODE_ID_LENGTH)
    .replace(/-$/, "");
  return slug.length > 0 ? slug : "node";
}

/**
 * Mint an id that is free in `taken`.
 *
 * Pure in (label, taken), which is what lets `fold` and `mutate` agree without either
 * consulting the other: minting happens once, at commit, and the log stores the result.
 */
export function mintNodeId(label: string, taken: ReadonlySet<string>): string {
  const base = slugify(label);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, MAX_NODE_ID_LENGTH - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}
