/**
 * Hashing lives here, not in `core`. §6.12 keeps `core` at zero dependencies and no
 * ambient runtime; `core` owns the DECISION of what goes into the key
 * (`effectKeyPreimage`), which is the part with the bug history, and this owns the bytes.
 */

import { createHash } from "node:crypto";
import { effectKeyPreimage } from "@kona/core";

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * §6.6 — `effect_key = hash(node_id, created_by_version)`. Payload-independent: the key
 * names the slot, and `payload_hash` proves the bytes were the ones approved.
 *
 * Truncated to 16 hex characters because this identifies a slot within one pursuit, not a
 * value in a global namespace, and it has to stay readable in a viewer and an error line.
 */
export function effectKey(nodeId: string, createdByVersion: number): string {
  return `ek_${sha256(effectKeyPreimage(nodeId, createdByVersion)).slice(0, 16)}`;
}
