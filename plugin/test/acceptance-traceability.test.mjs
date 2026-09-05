import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const matrix = JSON.parse(
  await readFile(join(import.meta.dirname, "ac-traceability.json"), "utf8"),
);

test("PRD AC1-AC22 distinguish automated assertions from manual release evidence", async () => {
  assert.deepEqual(
    Object.keys(matrix),
    Array.from({ length: 22 }, (_, index) => `AC${index + 1}`),
  );
  for (const [acceptanceCriterion, entry] of Object.entries(matrix)) {
    const references = Array.isArray(entry) ? [entry] : [entry.automated, entry.manual];
    for (const [file, evidence] of references) {
      const source = await readFile(join(import.meta.dirname, file), "utf8");
      assert.ok(
        source.includes(evidence),
        `${acceptanceCriterion} evidence ${JSON.stringify(evidence)} is absent from ${file}`,
      );
    }
    if (!Array.isArray(entry)) assert.match(entry.remaining, /before release/);
  }
});
