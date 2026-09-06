import { expect, test } from "bun:test";
import { imageBuildPlan } from "../images.ts";
import type { FastManifest } from "../contracts.ts";

test("image plan creates digest-based inference and grader builds for all families", () => {
  const manifest: FastManifest = {
    schemaVersion: 1,
    datasetRepo: "LiberCoders/FeatureBench",
    dataVersion: "v1.1",
    datasetRevision: "b".repeat(40),
    split: "fast",
    tasks: Array.from({ length: 100 }, (_, index) => `task-${index}`),
    imageFamilies: Array.from({ length: 18 }, (_, index) => `image-${index}`),
  };
  const images = Object.fromEntries(
    manifest.imageFamilies.map((family) => [
      family,
      `docker.io/${family}@sha256:${"a".repeat(64)}`,
    ]),
  );
  const plan = imageBuildPlan(
    manifest,
    { schemaVersion: 1, platform: "linux/amd64", images },
    { inference: "ecr/inference", grader: "ecr/grader" },
  );
  expect(plan).toHaveLength(36);
  expect(plan.filter((build) => build.kind === "inference")).toHaveLength(18);
  expect(plan[0]?.argv).toContain("linux/amd64");
  expect(plan[0]?.source).toContain("@sha256:");
});
