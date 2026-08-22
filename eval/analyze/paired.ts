/**
 * Read Harbor's job output and report the paired comparison.
 *
 * The unit is a TASK, not a run: each task appears in both arms, and what is reported is
 * the per-task difference and the SIGN PATTERN across tasks. At six tasks and one attempt
 * each, the sign pattern IS the result — a mean of six numbers has no interval worth
 * printing, and `docs/eval.md` §10 pre-registered it that way before any run.
 *
 *   bun eval/analyze/paired.ts eval/jobs                      # everything found
 *   bun eval/analyze/paired.ts eval/jobs --job-prefix ab-2026 # one A/B
 *   bun eval/analyze/paired.ts eval/jobs --probe              # cost calibration
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type Trial = {
  task_name?: string;
  agent_info?: { name?: string; model_info?: { name?: string } };
  agent_result?: {
    n_input_tokens?: number | null;
    n_cache_tokens?: number | null;
    n_output_tokens?: number | null;
    cost_usd?: number | null;
  } | null;
  verifier_result?: { rewards?: Record<string, number> | null } | null;
  exception_info?: { exception_type?: string } | null;
};

const args = process.argv.slice(2);
const root = args[0] ?? "eval/jobs";
const probeMode = args.includes("--probe");
const prefixIdx = args.indexOf("--job-prefix");
const jobPrefix = prefixIdx >= 0 ? args[prefixIdx + 1] : undefined;

/** Harbor's layout is not contractual, so find results by shape rather than by path. */
const walk = (dir: string, out: string[] = [], depth = 0): string[] => {
  if (depth > 8) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(p, out, depth + 1);
    else if (e.endsWith(".json")) out.push(p);
  }
  return out;
};

const isKona = (name: string): boolean => /kona/i.test(name);
const rewardOf = (t: Trial): number | null => {
  const r = t.verifier_result?.rewards;
  if (!r) return null;
  if (typeof r["reward"] === "number") return r["reward"];
  const vals = Object.values(r).filter((v) => typeof v === "number");
  return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
};

const trials: { task: string; arm: "kona" | "baseline"; trial: Trial; file: string }[] = [];
for (const file of walk(root)) {
  if (jobPrefix !== undefined && !file.includes(jobPrefix)) continue;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  const t = parsed as Trial;
  if (typeof t.task_name !== "string" || t.agent_info === undefined) continue;
  trials.push({
    task: t.task_name,
    arm: isKona(t.agent_info.name ?? "") ? "kona" : "baseline",
    trial: t,
    file,
  });
}

if (trials.length === 0) {
  console.error(`no trial results found under ${root}${jobPrefix ? ` matching ${jobPrefix}` : ""}`);
  process.exit(1);
}

// ---------------------------------------------------------------- cost
const money = trials
  .map((t) => t.trial.agent_result)
  .filter((a): a is NonNullable<typeof a> => a != null);
const sum = (f: (a: NonNullable<Trial["agent_result"]>) => number | null | undefined): number =>
  money.reduce((acc, a) => acc + (f(a) ?? 0), 0);

const totalCost = sum((a) => a.cost_usd);
const inTok = sum((a) => a.n_input_tokens);
const cacheTok = sum((a) => a.n_cache_tokens);
const outTok = sum((a) => a.n_output_tokens);
const perRun = money.length > 0 ? totalCost / money.length : 0;

console.log(`\n=== cost (${money.length} runs) ===`);
console.log(`  total            $${totalCost.toFixed(4)}`);
console.log(`  per run          $${perRun.toFixed(4)}`);
console.log(`  input tokens     ${inTok.toLocaleString()}`);
console.log(`  cached tokens    ${cacheTok.toLocaleString()}  (${inTok > 0 ? ((cacheTok / inTok) * 100).toFixed(1) : "0"}% of input)`);
console.log(`  output tokens    ${outTok.toLocaleString()}`);

if (probeMode) {
  // The probe runs at a fraction of the real budget, so scale before extrapolating.
  const mult = Number(process.env["MULT"] ?? "0.34");
  const fullRun = perRun / (mult > 0 ? mult : 1);
  console.log(`\n=== extrapolation (probe ran at MULT=${mult} of budget) ===`);
  console.log(`  full-length run  ~$${fullRun.toFixed(2)}`);
  console.log(`  6 tasks x 2 arms ~$${(fullRun * 12).toFixed(2)}`);
  for (const cap of [10, 15]) {
    console.log(`  tasks affordable within $${cap}: ${Math.floor(cap / (2 * fullRun))}`);
  }
  if (cacheTok === 0) {
    console.log(
      `\n  ! zero cached tokens — prompt caching is NOT engaging. This is the difference\n` +
        `    between ~$0.5 and ~$1.7 per run. Check the provider prefix and whether the\n` +
        `    harness re-sends a byte-identical prefix each step before spending a slot.`,
    );
  }
  process.exit(0);
}

// ---------------------------------------------------------------- pairs
const tasks = [...new Set(trials.map((t) => t.task))].toSorted();
const fmt = (v: number | null): string => (v === null ? "  n/a " : v.toFixed(3).padStart(6));
type Row = { task: string; base: number | null; kona: number | null; delta: number | null; note: string };
const rows: Row[] = tasks.map((task) => {
  const b = trials.find((t) => t.task === task && t.arm === "baseline");
  const k = trials.find((t) => t.task === task && t.arm === "kona");
  const base = b ? rewardOf(b.trial) : null;
  const kona = k ? rewardOf(k.trial) : null;
  const notes: string[] = [];
  if (b?.trial.exception_info?.exception_type) notes.push(`baseline:${b.trial.exception_info.exception_type}`);
  if (k?.trial.exception_info?.exception_type) notes.push(`kona:${k.trial.exception_info.exception_type}`);
  if (!b) notes.push("baseline MISSING");
  if (!k) notes.push("kona MISSING");
  return {
    task,
    base,
    kona,
    delta: base !== null && kona !== null ? kona - base : null,
    note: notes.join(" "),
  };
});

console.log(`\n=== paired result: ${rows.length} tasks ===`);
console.log("  baseline   kona   delta   task");
for (const r of rows) {
  const d = r.delta === null ? "  n/a " : (r.delta > 0 ? "+" : "") + r.delta.toFixed(3);
  console.log(`  ${fmt(r.base)}  ${fmt(r.kona)}  ${d.padStart(7)}   ${r.task}${r.note ? `   [${r.note}]` : ""}`);
}

const scored = rows.filter((r) => r.delta !== null) as (Row & { delta: number })[];
const pos = scored.filter((r) => r.delta > 0).length;
const neg = scored.filter((r) => r.delta < 0).length;
const tie = scored.filter((r) => r.delta === 0).length;
const mean = scored.length > 0 ? scored.reduce((a, b) => a + b.delta, 0) / scored.length : 0;

console.log(`\n  sign pattern     +${pos} / -${neg} / =${tie}  (of ${scored.length} scored)`);
console.log(`  mean delta       ${mean >= 0 ? "+" : ""}${mean.toFixed(4)}`);

// The pre-registered bar (docs/eval.md §10): consistent sign on >=5 of 6.
const BAR = Math.ceil(scored.length * (5 / 6));
console.log(`\n=== go / no-go (pre-registered, docs/eval.md §10) ===`);
if (scored.length === 0) {
  console.log("  VOID — nothing scored. A harness failure, not a finding.");
} else if (scored.length < 3) {
  // Symmetric on purpose. An earlier version guarded only the all-positive case, so a single
  // task where Kona scored lower printed "NEGATIVE ... it is a result" — a confident readout
  // of one coin flip. Below three tasks there is no pattern to read in EITHER direction.
  console.log(
    `  INCONCLUSIVE — ${scored.length} scored task(s) (+${pos}/-${neg}/=${tie}). Too few to read a\n` +
      `  pattern in either direction. This is the probe/pilot regime: it proves the rig runs and\n` +
      `  prices the run. It cannot support a claim about Kona, favourable or not.`,
  );
} else if (pos >= BAR) {
  console.log(`  GO — ${pos} of ${scored.length} positive (bar: ${BAR}).`);
} else if (neg >= BAR) {
  console.log(`  NEGATIVE — Kona is worse on ${neg} of ${scored.length}. Report it; it is a result.`);
} else if (tie === scored.length) {
  console.log(
    `  ALL TIES — usually means both arms scored 0. Check whether the model moved either\n` +
      `  arm at all before reading anything into it.`,
  );
} else {
  console.log(`  NO-GO — ${pos}/${neg}/${tie} does not clear the bar of ${BAR}. Write it up as a null PoC.`);
}
console.log(
  `\n  Six tasks, one attempt: this reports a DIRECTION, not significance. Any write-up\n` +
    `  says so in its first line.`,
);
