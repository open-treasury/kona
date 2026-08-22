/**
 * `kona resume` — §6.7's reconcile-then-repair, and the §8 line that says a fresh terminal
 * prints correct status in under 60 seconds with no session state.
 *
 * Order matters: **report first, repair second, and never repair a `sending`.** The world's
 * answer to an open reservation is genuinely unknown, and the only safe move is to hand it
 * to a human — §6.5 makes reconciliation against the mailbox the source of truth, and that
 * arrives with the mailbox provider.
 */

import { type ResumePlan, planResume } from "@kona/core";
import { type BuildResult, commitBatch } from "../commit.ts";
import { EXIT_OK, EXIT_REFUSED } from "../exit.ts";
import { openPursuit } from "../pursuit.ts";
import type { Io } from "../io.ts";

export interface ResumeOptions {
  json: boolean;
  /** Report without writing. The repairs are still shown, so you can see what it would do. */
  dryRun: boolean;
}

function render(io: Io, plan: ResumePlan): void {
  const { report } = plan;
  const states = Object.entries(report.counts)
    .map(([state, count]) => `${count} ${state}`)
    .join(" · ");
  io.out(`version ${report.version} · ${states}`);

  if (report.damaged > 0) {
    io.out(`  ${report.damaged} damaged record(s) — the graph below is partial`);
  }

  io.out("");
  io.out(
    report.frontier.length === 0
      ? "  ready       nothing"
      : `  ready       ${report.frontier.join(", ")}`,
  );

  if (report.waits.length > 0) {
    io.out("");
    io.out("  armed waits");
    for (const wait of report.waits) {
      const when = wait.deadline ?? "unknown";
      io.out(`    ${wait.overdue ? "OVERDUE" : "waiting"}  ${wait.node_id}  ${when}  (${wait.basis})`);
    }
    // §6.7's step 3 — "reconcile waits against the world" — from the operator's side.
    //
    // `resume` cannot take that step itself, and the reason is the determinism law: reaching
    // a mailbox is a network call, and no verb makes one. So the honest thing is to name the
    // verb that CAN. Without this line a fresh terminal is told the pursuit's state and left
    // to guess the next action, which is precisely the moment somebody reaches for the graph
    // and starts hand-editing.
    io.out("");
    io.out("  Next: `kona poll` for the addresses to fetch, then `kona poll --inbound <file>`");
    io.out("  to route what came back. Reconciliation is truth; a deadline is only a backstop.");
  }

  if (report.unknown_sends.length > 0) {
    io.out("");
    io.out("  NEEDS A HUMAN — reserved, never resolved. The world's answer is unknown.");
    for (const send of report.unknown_sends) {
      io.out(`    ${send.node_id}  ${send.effect_key}  attempted ${send.attempted_at}`);
      io.out(`      to ${send.recipient_ref ?? "(no recipient)"} — check the mailbox before doing anything`);
    }
  }
}

export async function runResume(io: Io, options: ResumeOptions): Promise<number> {
  const opened = await openPursuit(io);
  if (!opened.ok) return EXIT_REFUSED;

  const { graph, records, damaged } = opened.folded;
  const plan = planResume(records, graph, io.now(), damaged.length);

  if (options.json) {
    io.out(JSON.stringify({ ...plan.report, repairs: plan.repairs, dry_run: options.dryRun }));
  } else {
    render(io, plan);
  }

  for (const entry of damaged) {
    io.err(`REFUSED ${entry.reason} line=${entry.line} ${entry.detail}`);
  }
  if (damaged.length > 0) return EXIT_REFUSED;

  if (plan.repairs.length === 0) {
    if (!options.json) {
      io.out("");
      io.out("  nothing to repair");
    }
    return EXIT_OK;
  }

  if (options.dryRun) {
    if (!options.json) {
      io.out("");
      io.out(`  would repair: ${plan.rationale}`);
    }
    return EXIT_OK;
  }

  // Every repair is a logged mutation carrying its own rationale (§6.7). A resume that
  // fixed things silently would leave the next agent reading a graph nobody explains.
  const committed = await commitBatch(io, (): BuildResult => ({
    commit: {
      ops: plan.repairs,
      rationale: { why: plan.rationale, reasonCode: "DEADLINE_PASSED" },
      actor: { kind: "orchestrator", id: "resume" },
    },
  }));
  if (!committed.ok) return committed.code;

  if (!options.json) {
    io.out("");
    io.out(`  repaired at v${committed.value.version}: ${plan.rationale}`);
  }
  return EXIT_OK;
}
