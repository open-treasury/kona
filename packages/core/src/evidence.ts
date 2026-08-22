/**
 * What the graph can vouch for — invariant 3(b)'s resolution half (§6.7).
 *
 * > "`recipient_ref` resolves to an entity already in the graph carrying an `evidence_ref`.
 * > **A recipient existing only in the proposing batch is rejected.**"
 *
 * The grammar half already refuses a ref that is not `<scope>#<key>`, which catches the
 * *shape* of the n=60 fabrications. This is the half that catches the fabrication itself:
 * at n=60 the mutator, unable to satisfy a constraint, invented counterparties — plausible
 * names, plausible addresses — and queued real email to them, passing every other check,
 * roughly twenty times. Spelling `roster.contacts#marcus` correctly is not knowing who
 * Marcus is.
 *
 * ## What counts as evidence
 *
 * Two carriers, and both are things somebody outside the model put there:
 *
 * 1. **A recorded output that cited its source.** `record_output(confirm-roster,
 *    availability, ["dana","sam"], evidence_ref: "roster.csv#v3")` — a real roster, read
 *    from a real file, with the version it was read at.
 * 2. **An outcome's `attrs`.** Every outcome carries an `evidence_ref` by schema, so a
 *    counterparty naming somebody — `record_outcome(wait-for-sam, declined,
 *    evidence_ref: "<m-202@mail>", attrs: {referral: "marcus"})` — is a person vouched for
 *    by a message that exists.
 *
 * The second is what lets a referral chain work at all. Sam cannot play, names Marcus, and
 * Marcus becomes contactable — *because Sam said so, in a message with an id*, not because
 * the model thought of him.
 *
 * ## Read against PRE-COMMIT HEAD
 *
 * "Existing only in the proposing batch is rejected" is precisely a statement about head, so
 * the evidence set is built from the graph as it stood BEFORE the batch. A batch that
 * records a roster and emails it in one commit is refused, and rightly: nothing outside the
 * batch attests to any of it.
 */

import type { Graph } from "./graph.ts";

import type { RecipientRef } from "./validate.ts";

/**
 * Every string the graph can vouch for, lowercased.
 *
 * Deliberately a flat set of string LEAVES rather than a structured lookup. An output is
 * `unknown` by schema — a roster is as likely to be `["dana"]` as `[{name:"dana"}]` — and a
 * rule that only understood one shape would refuse honest work for being differently
 * shaped, which is the failure mode the v2 probe measured when an invariant rejected
 * correct work five times in ten.
 */
export function evidencedKeys(graph: Graph): Set<string> {
  const keys = new Set<string>();

  const harvest = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.length > 0) keys.add(value.toLowerCase());
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) harvest(entry);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const entry of Object.values(value)) harvest(entry);
    }
  };

  for (const node of graph.nodes.values()) {
    // An output counts only where its evidence was retained. `record_output` has always
    // required an `evidence_ref`; a value with none behind it is the model's own word.
    const evidence = node.status.output_evidence;
    if (evidence !== null && node.status.output !== null) {
      for (const [name, value] of Object.entries(node.status.output)) {
        if (typeof evidence[name] === "string") harvest(value);
      }
    }
    // Outcomes carry an evidence_ref by schema, so their attrs are attested by construction.
    for (const outcome of node.status.outcomes) {
      if (outcome.attrs !== undefined) harvest(outcome.attrs);
    }
  }

  return keys;
}

/**
 * Is this recipient somebody the graph has heard of?
 *
 * Matched on the KEY alone, not the whole ref. The scope is an author's filing decision —
 * `roster.contacts#dana` and `players#dana` name one person — and refusing on it would
 * reject a correct recipient for being filed differently. What must be attested is *the
 * person*.
 */
export function isEvidencedRecipient(ref: RecipientRef, evidenced: ReadonlySet<string>): boolean {
  return evidenced.has(ref.key.toLowerCase());
}
