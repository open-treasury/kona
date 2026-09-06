#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { canonicalJson, sha256, validateFastManifest } from "./contracts.ts";

export type SourceImageLock = {
  schemaVersion: 1;
  platform: "linux/amd64";
  images: Record<string, string>;
};

export type ImageBuild = {
  family: string;
  kind: "inference" | "grader";
  source: string;
  tag: string;
  argv: string[];
};

export const imageBuildPlan = (
  manifestValue: unknown,
  lock: SourceImageLock,
  repositories: { inference: string; grader: string },
): ImageBuild[] => {
  const manifest = validateFastManifest(manifestValue);
  if (lock.schemaVersion !== 1 || lock.platform !== "linux/amd64") {
    throw new Error("source image lock must target linux/amd64 schema version 1");
  }
  if (Object.keys(lock.images).length !== 18)
    throw new Error("source image lock must contain 18 images");
  return manifest.imageFamilies.flatMap((family) => {
    const source = lock.images[family];
    if (!source || !/@sha256:[a-f0-9]{64}$/.test(source)) {
      throw new Error(`source image ${family} is not digest-pinned`);
    }
    const key = sha256(family).slice(0, 12);
    return (["inference", "grader"] as const).map((kind) => {
      const tag = `${repositories[kind]}:${key}`;
      return {
        family,
        kind,
        source,
        tag,
        argv: [
          "docker",
          "buildx",
          "build",
          "--platform",
          "linux/amd64",
          "--build-arg",
          `BASE_IMAGE=${source}`,
          "--file",
          `eval/featurebench/images/${kind}.Dockerfile`,
          "--tag",
          tag,
          "--push",
          ".",
        ],
      };
    });
  });
};

const main = async (): Promise<void> => {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      manifest: { type: "string" },
      "source-lock": { type: "string" },
      "inference-repo": { type: "string" },
      "grader-repo": { type: "string" },
      out: { type: "string" },
      execute: { type: "boolean", default: false },
    },
  });
  const required = (name: keyof typeof parsed.values): string =>
    (parsed.values[name] as string | undefined) ??
    (() => {
      throw new Error(`--${name} is required`);
    })();
  const manifest = JSON.parse(readFileSync(required("manifest"), "utf8")) as unknown;
  const lock = JSON.parse(readFileSync(required("source-lock"), "utf8")) as SourceImageLock;
  const builds = imageBuildPlan(manifest, lock, {
    inference: required("inference-repo"),
    grader: required("grader-repo"),
  });

  if (parsed.values.execute) {
    for (const build of builds) {
      const directory = mkdtempSync(join(tmpdir(), "kona-image-"));
      const metadata = join(directory, "metadata.json");
      const argv = [
        ...build.argv.slice(0, -1),
        "--metadata-file",
        metadata,
        build.argv.at(-1) ?? ".",
      ];
      const process = Bun.spawn(argv, {
        cwd: resolve(import.meta.dir, "..", ".."),
        stdout: "inherit",
        stderr: "inherit",
      });
      if ((await process.exited) !== 0)
        throw new Error(`image build failed for ${build.family} ${build.kind}`);
      const detail = JSON.parse(readFileSync(metadata, "utf8")) as Record<string, unknown>;
      const digest = detail["containerimage.digest"];
      if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
        throw new Error(`build returned no digest for ${build.family} ${build.kind}`);
      }
      build.tag = `${build.tag.slice(0, build.tag.lastIndexOf(":"))}@${digest}`;
      rmSync(directory, { recursive: true, force: true });
    }
  }

  writeFileSync(
    required("out"),
    canonicalJson({ schemaVersion: 1, platform: "linux/amd64", builds }),
  );
};

if (import.meta.main) {
  await main();
}
