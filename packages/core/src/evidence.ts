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
      // An empty string would be a key that `recipient_ref` could match with an empty key,
      // which is a fabrication passing as evidence.
      if (value.length > 0) keys.add(value.toLowerCase());
      return;
    }
    // `Object.values` throws on `null` and `undefined`, yields nothing for every other
    // primitive, and yields an array's elements — so this one branch covers objects, arrays
    // and the rest. An explicit `Array.isArray` case was only a slower spelling of it, and
    // mutation testing said so: deleting the branch changed no answer anywhere.
    if (value === null || value === undefined) return;
    for (const entry of Object.values(value)) harvest(entry);
  };

  for (const node of graph.nodes.values()) {
    // An output counts because `record_output` CANNOT be committed without an
    // `evidence_ref` — the schema makes it mandatory and non-empty, and `MutationRecordSchema`
    // re-parses every historical line on every fold, so the guarantee is retroactive too.
    //
    // An earlier version re-checked it here, per output field. Every one of those branches
    // was an unkillable mutant, because `applyOps` writes `output` and `output_evidence` in
    // one statement and no graph can have the key sets disagree. Enforcing an invariant twice
    // is the same mistake as storing a fact twice: the copies can only ever diverge, and the
    // second one reads as caution while being noise. `evidence.test.ts` pins the guarantee
    // instead, so a schema that relaxed would fail there rather than silently here.
    harvest(node.status.output);
    // Outcomes carry an `evidence_ref` by the same rule, so their attrs are attested by
    // construction — and they are the half that makes a referral chain work.
    for (const outcome of node.status.outcomes) harvest(outcome.attrs);
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
