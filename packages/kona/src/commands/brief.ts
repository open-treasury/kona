/**
 * `kona brief <node>` — §6.9. What an executor needs, and nothing it must not disclose.
 *
 * Measured, not assumed: 0 of 8 fresh subagents could execute a node without these blocks,
 * and 10 of 10 could once they were required.
 */

import { type PursuitConfig, buildBrief, pursuitConfig } from "@kona/core";
import { effectKey } from "../hash.ts";
import { EXIT_OK, EXIT_REFUSED } from "../exit.ts";
import { openPursuit, reportDamage } from "../pursuit.ts";
import type { Io } from "../io.ts";

export interface BriefOptions {
  node: string;
  json: boolean;
}

export async function runBrief(io: Io, options: BriefOptions): Promise<number> {
  const opened = await openPursuit(io);
  if (!opened.ok) return EXIT_REFUSED;
  if (reportDamage(io, opened.folded)) return EXIT_REFUSED;

  const config: PursuitConfig = pursuitConfig(opened.folded.records);
  const result = buildBrief(opened.folded.graph, options.node, config);
  if (!result.ok) {
    io.err(`REFUSED ${result.reason} ${result.message}`);
    return EXIT_REFUSED;
  }

  // `core` owns which fields make the key and stays free of crypto, so the value is
  // filled in here. The executor passes it straight to `kona effect record`.
  const resolved = result.brief;
  if (resolved.node.spec.effect !== undefined) {
    resolved.effect_key = effectKey(resolved.node.id, resolved.node.provenance.created_by_version);
  }

  if (options.json) {
    io.out(JSON.stringify(resolved));
    return resolved.preconditions_satisfied.ok ? EXIT_OK : EXIT_REFUSED;
  }

  io.out(`${resolved.node.type} ${resolved.node.id} — ${resolved.node.label}`);
  io.out("");
  io.out(`  instruction  ${resolved.node.spec.instruction}`);
  io.out(`  as           ${resolved.identity.display_name} <${resolved.identity.mailbox}>`);
  io.out(`  authority    ${resolved.identity.authority}`);
  if (resolved.correlation !== null) {
    io.out(`  reply-to     ${resolved.correlation.reply_to}`);
    io.out(`  subject tag  ${resolved.correlation.subject_tag}`);
  }
  if (resolved.effect_key !== null) io.out(`  effect key   ${resolved.effect_key}`);

  if (resolved.subgraph.upstream.length > 0) {
    io.out("");
    io.out("  depends on");
    for (const up of resolved.subgraph.upstream) {
      const on = up.condition === undefined ? "" : ` [on:${up.condition}]`;
      io.out(`    ${up.state.padEnd(8)} ${up.id}${on}`);
    }
  }

  io.out("");
  io.out(`  preconditions ${resolved.preconditions_satisfied.ok ? "SATISFIED" : "NOT SATISFIED"}`);
  for (const check of resolved.preconditions_satisfied.checks) {
    io.out(`    ${check.ok ? "ok  " : "FAIL"} ${check.name.padEnd(22)} ${check.detail}`);
  }

  io.out("");
  io.out(`  may disclose  ${resolved.disclosure.disclosable.join(", ")}`);
  io.out(`  NEVER         ${resolved.disclosure.withheld.join(", ")}`);

  return resolved.preconditions_satisfied.ok ? EXIT_OK : EXIT_REFUSED;
}
