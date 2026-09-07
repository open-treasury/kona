import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const runtime = join(import.meta.dir, "..", "runtime");
const images = join(import.meta.dir, "..", "images");

test("derived images use FeatureBench's supported Python runtime", () => {
  for (const dockerfile of ["inference.Dockerfile", "grader.Dockerfile"]) {
    const source = readFileSync(join(images, dockerfile), "utf8");
    expect(source).toContain("python=3.12.11");
    expect(source).toContain("apt-get install --yes --no-install-recommends tmux asciinema");
    expect(source).not.toContain("--ignore-requires-python");
  }
});

test("workspace preparation disables background Git object pruning", () => {
  expect(readFileSync(join(runtime, "prepare.py"), "utf8")).toContain(
    '["git", "config", "--global", "gc.auto", "0"]',
  );
});

test("direct-container workers load without paid or external dependencies", async () => {
  for (const script of ["common.py", "prepare.py", "infer.py", "grade.py", "worker.py"]) {
    const process = Bun.spawn(["python3", join(runtime, script), "--self-test"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await process.exited).toBe(0);
  }
});
