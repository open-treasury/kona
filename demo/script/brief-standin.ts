/**
 * **A temporary stand-in for `kona brief <node>`, to be deleted when that verb lands.**
 *
 * §6.9 says `brief` returns a `correlation` block holding "the **fully-expanded literal**
 * reply-to and subject tag", and §6.5 says "Correlation derives from the node id, never
 * minted per run". **The `kona` binary owns that derivation.** `kona brief` is not built yet
 * — `kona --help` still lists it under "not built yet" — so the rig has nothing to ask, and
 * a demo that cannot address a reply cannot run at all.
 *
 * So this file exists, and it is deliberately the ONLY place in `demo/` that knows the shape
 * of a correlation token. It is quarantined here rather than in `demo/mailbox/` for the
 * reason the operator gave: the port is exactly provision / send / poll-thread, and if it
 * were parsing a reply-to tag it would be the wrong package.
 *
 * Note the asymmetry, which is the whole discipline:
 *
 * - **Deriving** an address from a node id happens here, once, marked temporary.
 * - **Parsing** one back into a node id happens NOWHERE in `demo/`. The persona simulator
 *   copies the literal `Reply-To` it was given and never looks inside it, which is exactly
 *   what a real counterparty's mail client does.
 *
 * When `kona brief` ships, delete this file and read the `correlation` block instead. The
 * call sites are in `demo/script/divergence.ts` and nowhere else.
 */

import { KONA_MAILBOX } from "../personas/cast.ts";

/**
 * `ilya+kona-<node_id>@gmail.com` — §6.11.
 *
 * N tags on ONE inbox, not N inboxes: send-as aliases cap at about thirty per user, and
 * plus-addressing is uncapped. The token is a pure function of the node id, so a crash-resumed
 * run recomputes the same address rather than stranding a stale one in someone's inbox.
 */
export function correlationAddress(nodeId: string): string {
  return `${KONA_MAILBOX.local}+kona-${nodeId}@${KONA_MAILBOX.domain}`;
}

/** The sending identity. §6.9 puts this in `brief`'s `identity` block for the same reason. */
export function konaAddress(): string {
  return `${KONA_MAILBOX.local}@${KONA_MAILBOX.domain}`;
}
