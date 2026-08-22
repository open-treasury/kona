/**
 * `kona poll` — §6.8: "scan each armed wait's cursor; report what changed."
 *
 * REPORT is the operative word, and the line it draws is the determinism law. Whether Dana
 * said yes is a judgement about prose, so poll stops at *a reply arrived, and it is this
 * one*. The orchestrator reads the body, decides the verdict, and commits it with
 * `record_outcome` — which is also what builds the dedupe set for the next poll.
 *
 * Two halves, one verb:
 *
 *   kona poll                      what should I fetch? -> the reply address of every
 *                                  pollable wait
 *   kona poll --inbound <file>     here is what I fetched -> which wait each message
 *                                  belongs to
 *
 * The fetching itself lives behind §6.11's `MailboxProvider`, in `demo/`. It has to: §6.12
 * makes `demo/` a directory of throwaway scripts, and the package that owns the write path
 * cannot depend on it. Keeping the transport out also means this verb has no network to
 * mock and no clock to freeze — it is a pure function of the log and the bytes it is given.
 */

import { readFile } from "node:fs/promises";
import { type InboundMessage, matchInbound, pursuitConfig, waitAddresses } from "@kona/core";
import { EXIT_OK, EXIT_REFUSED } from "../exit.ts";
import { openPursuit, reportDamage } from "../pursuit.ts";
import type { Io } from "../io.ts";

export interface PollOptions {
  json: boolean;
  /** A JSON array of provider messages. Absent means "tell me what to fetch". */
  inboundFile?: string;
}

function isMessageArray(value: unknown): value is InboundMessage[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as InboundMessage).message_id === "string" &&
        typeof (entry as InboundMessage).from === "string" &&
        Array.isArray((entry as InboundMessage).to),
    )
  );
}

export async function runPoll(io: Io, options: PollOptions): Promise<number> {
  const opened = await openPursuit(io);
  if (!opened.ok) return EXIT_REFUSED;
  if (reportDamage(io, opened.folded)) return EXIT_REFUSED;

  const { identity } = pursuitConfig(opened.folded.records);
  if (identity === undefined) {
    io.err(
      "REFUSED NO_IDENTITY this pursuit has no mailbox configured, so no reply address can be derived",
    );
    return EXIT_REFUSED;
  }

  const targets = waitAddresses(opened.folded.graph, identity.mailbox);

  if (options.inboundFile === undefined) {
    if (options.json) {
      io.out(JSON.stringify({ version: opened.folded.graph.version, poll: targets }));
    } else if (targets.length === 0) {
      io.out(`version ${opened.folded.graph.version} · no wait is expecting mail`);
    } else {
      io.out(`version ${opened.folded.graph.version} · ${targets.length} address(es) to poll`);
      for (const target of targets) {
        io.out(`  ${target.armed ? "armed   " : "resolved"} ${target.address}  ${target.node_id}`);
      }
    }
    return EXIT_OK;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(options.inboundFile, "utf8"));
  } catch (cause) {
    io.err(
      `REFUSED UNREADABLE_INBOUND ${options.inboundFile}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return EXIT_REFUSED;
  }
  if (!isMessageArray(raw)) {
    io.err(
      `REFUSED MALFORMED_INBOUND ${options.inboundFile} must be an array of messages carrying message_id, from and to`,
    );
    return EXIT_REFUSED;
  }

  const matches = matchInbound(opened.folded.graph, identity.mailbox, raw);

  if (options.json) {
    io.out(JSON.stringify({ version: opened.folded.graph.version, polled: raw.length, matches }));
    return EXIT_OK;
  }

  io.out(`version ${opened.folded.graph.version} · ${raw.length} message(s) · ${matches.length} matched`);
  for (const match of matches) {
    io.out(`  ${match.node_id}  on:${match.on}${match.late ? "  LATE — records, never reopens" : ""}`);
    io.out(`    ${match.message_id}  from ${match.from}`);
  }
  if (matches.length > 0) {
    io.out("");
    io.out("  kona decided WHICH wait each reply belongs to. What the reply SAYS is a");
    io.out("  judgement — read it, then record the verdict with kona mutate.");
  }
  return EXIT_OK;
}
