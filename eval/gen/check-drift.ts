/**
 * The eval's skill is an ADAPTATION of `plugin/skills/run/SKILL.md`, not a copy: the plugin
 * loop is written around counterparties, replies and irreversible sends, and a benchmark task
 * has none of those. So it is authored by hand — and that is exactly why it can rot silently.
 *
 * If the plugin's loop changes and this file does not, the experiment quietly starts measuring
 * a Kona that no longer ships. This test makes that loud. `docs/eval.md` §9 calls prompt drift
 * the one risk in the rig that needs a gate; this is the gate.
 *
 * When it fails: re-read the plugin skill, decide whether the change matters for a solo
 * effect-free task, update `eval/skills/kona/SKILL.md` if it does, then re-stamp with
 *   bun eval/gen/check-drift.ts --accept
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..");
const SOURCE = join(REPO, "plugin", "skills", "run", "SKILL.md");
const DERIVED = join(REPO, "eval", "skills", "kona", "SKILL.md");
const STAMP = join(here, "provenance.json");

const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

const current = { source: sha(SOURCE), derived: sha(DERIVED) };

if (process.argv.includes("--accept")) {
  writeFileSync(
    STAMP,
    `${JSON.stringify({ ...current, accepted_at: new Date().toISOString().slice(0, 10) }, null, 2)}\n`,
  );
  console.log("stamped:", current.source.slice(0, 12), "->", current.derived.slice(0, 12));
  process.exit(0);
}

if (!existsSync(STAMP)) {
  console.error("REFUSED NO_STAMP run: bun eval/gen/check-drift.ts --accept");
  process.exit(1);
}

const stamped = JSON.parse(readFileSync(STAMP, "utf8")) as { source: string; derived: string };
const problems: string[] = [];
if (stamped.source !== current.source) {
  problems.push(
    `plugin/skills/run/SKILL.md changed since the eval skill was derived from it.\n` +
      `    stamped ${stamped.source.slice(0, 12)} · now ${current.source.slice(0, 12)}`,
  );
}
if (stamped.derived !== current.derived) {
  problems.push(
    `eval/skills/kona/SKILL.md changed without re-stamping.\n` +
      `    stamped ${stamped.derived.slice(0, 12)} · now ${current.derived.slice(0, 12)}`,
  );
}

if (problems.length > 0) {
  console.error("SKILL DRIFT — the Kona arm may no longer reflect the shipped plugin:\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nReview, then re-stamp: bun eval/gen/check-drift.ts --accept");
  process.exit(1);
}
console.log("skill provenance ok");
