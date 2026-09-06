import { expect, test } from "bun:test";
import { join } from "node:path";

const runtime = join(import.meta.dir, "..", "runtime");

test("direct-container workers load without paid or external dependencies", async () => {
  for (const script of ["prepare.py", "infer.py", "grade.py"]) {
    const process = Bun.spawn(["python3", join(runtime, script), "--self-test"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await process.exited).toBe(0);
  }
});
