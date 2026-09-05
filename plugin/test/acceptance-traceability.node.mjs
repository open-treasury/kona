import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import test from "node:test";

const matrix = JSON.parse(
  await readFile(join(import.meta.dirname, "ac-traceability.json"), "utf8"),
);
const expectedCriteria = (count) => Array.from({ length: count }, (_, index) => `AC${index + 1}`);
const testFilePattern = /(?:\.test\.ts|\.node\.mjs)$/;

async function requireReference(acceptanceCriterion, reference, kind, exactTestName = false) {
  assert.ok(Array.isArray(reference), `${acceptanceCriterion} ${kind} evidence must be a pair`);
  const [file, evidence] = reference;
  assert.equal(typeof file, "string", `${acceptanceCriterion} ${kind} file is missing`);
  assert.equal(typeof evidence, "string", `${acceptanceCriterion} ${kind} evidence is missing`);
  if (kind === "automated") {
    assert.match(file, testFilePattern, `${acceptanceCriterion} automated evidence is not a test`);
  } else {
    assert.doesNotMatch(file, testFilePattern, `${acceptanceCriterion} manual evidence is a test`);
  }
  const source = await readFile(join(import.meta.dirname, file), "utf8");
  if (exactTestName) {
    assert.ok(
      source.includes(`test("${evidence}"`),
      `${acceptanceCriterion} automated test ${JSON.stringify(evidence)} is stale in ${file}`,
    );
  }
  assert.ok(
    source.includes(evidence),
    `${acceptanceCriterion} ${kind} evidence ${JSON.stringify(evidence)} is absent from ${file}`,
  );
}

test("existing PRD AC1-AC22 traceability remains complete", async () => {
  assert.deepEqual(Object.keys(matrix.prd), expectedCriteria(22));
  for (const [acceptanceCriterion, entry] of Object.entries(matrix.prd)) {
    const references = Array.isArray(entry) ? [entry] : [entry.automated, entry.manual];
    for (const reference of references) {
      await requireReference(
        `PRD ${acceptanceCriterion}`,
        reference,
        reference === entry.manual ? "manual" : "automated",
      );
    }
    if (!Array.isArray(entry)) assert.match(entry.remaining, /before release/);
  }
});

test("copy PRD AC1-AC19 have concrete automated or explicit manual evidence", async () => {
  assert.deepEqual(Object.keys(matrix.copy), expectedCriteria(19));
  for (const [acceptanceCriterion, entry] of Object.entries(matrix.copy)) {
    assert.ok(
      entry.automated?.length || entry.manual,
      `Copy ${acceptanceCriterion} has no evidence`,
    );
    for (const reference of entry.automated ?? []) {
      await requireReference(`Copy ${acceptanceCriterion}`, reference, "automated", true);
      assert.ok(extname(reference[0]), `Copy ${acceptanceCriterion} has an invalid test path`);
    }
    if (entry.manual) {
      const evidence = matrix.manualEvidence[entry.manual];
      assert.ok(evidence, `Copy ${acceptanceCriterion} manual evidence is undefined`);
      assert.doesNotMatch(evidence.file, testFilePattern, "manual evidence cannot be a test file");
      assert.ok(
        ["pending", "complete"].includes(evidence.status),
        "invalid manual evidence status",
      );
      const source = await readFile(join(import.meta.dirname, evidence.file), "utf8");
      assert.ok(
        source.includes(`### ${evidence.heading}`),
        `manual heading is absent: ${evidence.heading}`,
      );
    }
  }
});

test("issues PRD AC1-AC8 have concrete automated or explicit manual evidence", async () => {
  assert.deepEqual(Object.keys(matrix.issues), expectedCriteria(8));
  for (const [acceptanceCriterion, entry] of Object.entries(matrix.issues)) {
    const references = entry.automated ?? (Array.isArray(entry) ? [entry] : []);
    assert.ok(references.length || entry.manual, `Issues ${acceptanceCriterion} has no evidence`);
    for (const reference of references)
      await requireReference(`Issues ${acceptanceCriterion}`, reference, "automated");
    if (entry.manual)
      assert.ok(
        matrix.manualEvidence[entry.manual],
        `Issues ${acceptanceCriterion} manual evidence is undefined`,
      );
  }
});

test("copy real-model evidence ledger has exactly twelve explicitly pending host-mode runs", async () => {
  const evidence = matrix.manualEvidence["copy-runs"];
  assert.deepEqual(Object.keys(matrix.manualEvidence), ["copy-runs", "issues-runs"]);
  assert.equal(evidence.status, "pending");
  assert.equal(evidence.requiredRuns, 12);
  const source = await readFile(join(import.meta.dirname, evidence.file), "utf8");
  const section = source.split(`### ${evidence.heading}`)[1]?.split("\n## ")[0] ?? "";
  const rows = section
    .split("\n")
    .filter((line) => /^\| (?:OpenCode|Codex|Claude Code|Pi)\s+\|/.test(line));
  assert.equal(rows.length, evidence.requiredRuns);
  for (const host of ["OpenCode", "Codex", "Claude Code", "Pi"]) {
    for (const mode of ["Generate", "Revise", "Source-edit"]) {
      const row = rows.find((line) => line.includes(`| ${host}`) && line.includes(`| ${mode}`));
      assert.ok(row, `missing manual run: ${host}/${mode}`);
      assert.match(row, /\| Pending \|/, `manual run is not pending: ${host}/${mode}`);
    }
  }
});

test("issues real-model evidence ledger records one deferred run per host", async () => {
  const evidence = matrix.manualEvidence["issues-runs"];
  assert.equal(evidence.status, "deferred");
  assert.equal(evidence.requiredRuns, 4);
  const source = await readFile(join(import.meta.dirname, evidence.file), "utf8");
  const section = source.split(`## ${evidence.heading}`)[1]?.split("\n## ")[0] ?? "";
  const rows = section
    .split("\n")
    .filter((line) => /^\| (?:OpenCode|Codex|Claude Code|Pi)\s+\|/.test(line));
  assert.equal(rows.length, evidence.requiredRuns);
  for (const host of ["OpenCode", "Codex", "Claude Code", "Pi"]) {
    const row = rows.find((line) => line.includes(`| ${host}`));
    assert.ok(row, `missing manual issues run: ${host}`);
    assert.match(row, /\| Deferred \|/, `manual issues run is not deferred: ${host}`);
  }
});
