import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateFastManifest } from "../contracts.ts";

test("the pinned v1.1 Fast manifest has 100 tasks and 18 image families", () => {
  const path = join(import.meta.dir, "..", "manifests", "fast-v1.1.json");
  const manifest = validateFastManifest(JSON.parse(readFileSync(path, "utf8")));
  expect(manifest.datasetRevision).toBe("76b4a4566e04f4bcc13c35125d4f301791efa736");
  expect(manifest.tasks).toHaveLength(100);
  expect(manifest.imageFamilies).toHaveLength(18);
});
