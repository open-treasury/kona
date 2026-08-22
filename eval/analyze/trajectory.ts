/**
 * T2 — the mechanism probe. Costs nothing: it re-reads trajectories the A/B already wrote.
 *
 * At six tasks and one attempt each, the reward delta is a weak signal. This is the stronger
 * one, and the reason is sample size: every run contributes HUNDREDS of actions, so redo rate
 * and looping are far less noisy than a single score per task. `docs/eval.md` §4 (T2) predicts
 * both should fall in the Kona arm, and names the mechanism — `kona next` never offers a node
 * that is already terminal, and invariant 1 refuses to reopen one. If they do not fall, the
 * thesis is in trouble regardless of what the rewards say.
 *
 *   bun eval/analyze/trajectory.ts eval/jobs [--job-prefix ab-2026...]
 *
 * Harbor's trajectory layout is not contractual, so this discovers command-like fields rather
 * than assuming a schema, and says so plainly when it finds nothing it can read.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const root = args[0] ?? "eval/jobs";
const prefixIdx = args.indexOf("--job-prefix");
const jobPrefix = prefixIdx >= 0 ? args[prefixIdx + 1] : undefined;

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
    else if (e.endsWith(".json") || e.endsWith(".jsonl")) out.push(p);
  }
  return out;
};

/** Pull anything that looks like a shell command out of an arbitrary nested record. */
const COMMAND_KEYS = new Set(["command", "cmd", "keystrokes", "action", "input", "bash"]);
const harvest = (node: unknown, into: string[], depth = 0): void => {
  if (depth > 12 || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const v of node) harvest(v, into, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (COMMAND_KEYS.has(k) && typeof v === "string" && v.trim().length > 0) into.push(v.trim());
    else harvest(v, into, depth + 1);
  }
};

/**
 * Collapse noise that makes two identical actions look different — whitespace and embedded
 * timestamps, and nothing else.
 *
 * Deliberately NOT collapsing temp-file paths. An earlier draft mapped `/tmp/<anything>` to a
 * single token, which would have counted `kona mutate --ops /tmp/a.json` and `--ops /tmp/b.json`
 * as the same action. Those are different ops files carrying different mutations, and the Kona
 * arm writes many of them — so the rule would have manufactured redo in exactly the arm the
 * probe is testing. Over-normalising is not a neutral convenience; it biases the result.
 */
const normalise = (cmd: string): string =>
  cmd
    .replaceAll(/\s+/g, " ")
    .replaceAll(/\d{4}-\d{2}-\d{2}[T ][\d:.]+/g, "<ts>")
    .trim()
    .toLowerCase();

type Run = { file: string; arm: "kona" | "baseline"; task: string; commands: string[] };
const runs: Run[] = [];

for (const file of walk(root)) {
  if (jobPrefix !== undefined && !file.includes(jobPrefix)) continue;
  let parsed: unknown;
  const raw = readFileSync(file, "utf8");
  try {
    parsed = file.endsWith(".jsonl")
      ? raw
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l))
      : JSON.parse(raw);
  } catch {
    continue;
  }
  const commands: string[] = [];
  harvest(parsed, commands);
  if (commands.length < 3) continue;
  runs.push({
    file,
    arm: /kona/i.test(file) ? "kona" : "baseline",
    task: file.split("/").at(-2) ?? "unknown",
    commands,
  });
}

if (runs.length === 0) {
  console.error(
    `no readable trajectories under ${root}.\n` +
      `This probe reads whatever the A/B already wrote — run eval/run/02-ab.sh first.\n` +
      `If the A/B did run, Harbor's trajectory layout differs from what this expects:\n` +
      `inspect a job directory and widen COMMAND_KEYS in this file.`,
  );
  process.exit(1);
}

/** Fraction of actions that repeat an action already taken in the same run. */
const redoRate = (commands: string[]): number => {
  const seen = new Set<string>();
  let repeats = 0;
  for (const c of commands) {
    const n = normalise(c);
    if (seen.has(n)) repeats += 1;
    else seen.add(n);
  }
  return commands.length > 0 ? repeats / commands.length : 0;
};

/** Cycles: a normalised action repeating with >=1 distinct action between occurrences. */
const loopCount = (commands: string[]): number => {
  const positions = new Map<string, number[]>();
  commands.forEach((c, i) => {
    const n = normalise(c);
    positions.set(n, [...(positions.get(n) ?? []), i]);
  });
  let loops = 0;
  for (const idxs of positions.values()) {
    for (let i = 1; i < idxs.length; i += 1) {
      const gap = (idxs[i] ?? 0) - (idxs[i - 1] ?? 0);
      if (gap >= 2) loops += 1;
    }
  }
  return loops;
};

/**
 * ADOPTION. The Kona arm only OFFERS the skill — Terminus-2 advertises it in an
 * <available_skills> block and the model decides whether to read and use it. If it never does,
 * the arm is the baseline plus an unused binary, both arms score alike, and the run reads as
 * "Kona does not help" when the truth is "Kona was never used". Those are opposite findings.
 *
 * So adoption is a PRECONDITION for reading anything else. Zero adoption voids the comparison
 * rather than producing a negative result.
 */
const konaCalls = (commands: string[]): number =>
  commands.filter((c) => /(^|[\s;|&(])kona\s+(init|mutate|graph|next|brief|effect|resume|poll)\b/.test(c)).length;
const readTheSkill = (commands: string[]): boolean =>
  commands.some((c) => /skills\/kona\/SKILL\.md/.test(c));

const rows = runs.map((r) => ({
  arm: r.arm,
  task: r.task,
  actions: r.commands.length,
  redo: redoRate(r.commands),
  loops: loopCount(r.commands),
  kona: konaCalls(r.commands),
  readSkill: readTheSkill(r.commands),
}));

console.log(`\n=== trajectories: ${rows.length} runs ===`);
console.log("  arm       actions   redo%   loops   kona  skill   task");
for (const r of rows.toSorted((a, b) => a.task.localeCompare(b.task) || a.arm.localeCompare(b.arm))) {
  console.log(
    `  ${r.arm.padEnd(8)} ${String(r.actions).padStart(7)}  ${(r.redo * 100).toFixed(1).padStart(5)}  ${String(r.loops).padStart(6)}  ${String(r.kona).padStart(5)}  ${(r.readSkill ? "yes" : "no").padStart(5)}   ${r.task}`,
  );
}

// Adoption gate, before any comparison is worth reading.
const konaRuns = rows.filter((r) => r.arm === "kona");
const adopted = konaRuns.filter((r) => r.kona > 0);
console.log(`\n=== adoption ===`);
if (konaRuns.length === 0) {
  console.log("  no Kona-arm runs found.");
} else {
  const opened = konaRuns.filter((r) => r.readSkill).length;
  console.log(`  read the SKILL.md   ${opened}/${konaRuns.length}`);
  console.log(`  invoked kona        ${adopted.length}/${konaRuns.length}`);
  console.log(`  median kona calls   ${adopted.length > 0 ? adopted.map((r) => r.kona).toSorted((a, b) => a - b)[Math.floor(adopted.length / 2)] : 0}`);
  if (adopted.length === 0) {
    console.log(
      `\n  ! VOID, not negative. The model never invoked kona, so the Kona arm was the\n` +
        `    baseline plus an unused binary. Any reward difference is noise, and "Kona does\n` +
        `    not help" is NOT a supported reading. The finding is about DISCOVERABILITY —\n` +
        `    the skill's description is what the model sees first; fix that and re-run.`,
    );
  } else if (adopted.length < konaRuns.length) {
    console.log(
      `\n  ! PARTIAL adoption. Report the comparison over the ${adopted.length} adopting run(s)\n` +
        `    separately from the rest; averaging them hides the thing that actually varied.`,
    );
  }
}

const agg = (arm: "kona" | "baseline") => {
  const xs = rows.filter((r) => r.arm === arm);
  if (xs.length === 0) return null;
  return {
    n: xs.length,
    actions: xs.reduce((a, b) => a + b.actions, 0) / xs.length,
    redo: xs.reduce((a, b) => a + b.redo, 0) / xs.length,
    loops: xs.reduce((a, b) => a + b.loops, 0) / xs.length,
  };
};

const base = agg("baseline");
const kona = agg("kona");
console.log(`\n=== mechanism ===`);
if (base === null || kona === null) {
  console.log("  only one arm present — nothing to compare.");
  process.exit(0);
}
console.log(`  baseline  n=${base.n}  actions ${base.actions.toFixed(0)}  redo ${(base.redo * 100).toFixed(1)}%  loops ${base.loops.toFixed(1)}`);
console.log(`  kona      n=${kona.n}  actions ${kona.actions.toFixed(0)}  redo ${(kona.redo * 100).toFixed(1)}%  loops ${kona.loops.toFixed(1)}`);

const redoDrop = base.redo > 0 ? (base.redo - kona.redo) / base.redo : 0;
console.log(`\n  redo-rate change  ${redoDrop >= 0 ? "-" : "+"}${Math.abs(redoDrop * 100).toFixed(1)}%  (pre-registered secondary bar: a >=20% reduction)`);

// Gate the verdict on adoption. Without this the tool cheerfully reported "Kona is
// measurably re-doing less work" from a run in which kona was never once invoked — the two
// arms were the same agent, and the difference was noise. A mechanism claim requires the
// mechanism to have been present.
if (adopted.length === 0) {
  console.log(
    "  NOT A RESULT — kona was never invoked, so both arms ran the same agent and this\n" +
      "  difference is run-to-run noise. No mechanism claim is available from this data.",
  );
} else if (adopted.length < konaRuns.length) {
  console.log(
    `  PARTIAL — only ${adopted.length}/${konaRuns.length} Kona runs used kona; recompute over those before reading this.`,
  );
} else if (redoDrop >= 0.2) {
  console.log("  CLEARS the mechanism bar — Kona is measurably re-doing less work.");
} else if (redoDrop <= -0.2) {
  console.log("  INVERTED — Kona re-does MORE. That is a finding, and it belongs in the write-up.");
} else {
  console.log("  FLAT — the mechanism did not move. Weigh this against the reward delta honestly:");
  console.log("  a reward win with a flat redo rate is not the long-horizon story the PRD tells.");
}
