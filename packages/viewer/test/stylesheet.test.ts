/**
 * `src/styles.css` is generated from `src/theme.css`, and it is committed. This test is the
 * price of that.
 *
 * It is committed because `serveViewer` bundles straight from source — there is no build step
 * between a checkout and `kona view`, exactly as there is none between a checkout and `kona
 * mutate`. The cost is the usual one for a generated file in version control: it can drift,
 * silently, and the failure mode is the worst kind — a viewer that renders with last week's
 * classes and looks merely a bit wrong.
 *
 * So the rule is mechanized rather than remembered. Tailwind v4 scans the components for class
 * names, which means editing any `.tsx` can change the output as surely as editing the theme;
 * `bun run css` is what fixes a failure here, and it takes about thirty milliseconds.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("the compiled stylesheet is not stale", () => {
  test("`bun run css` would produce the file that is checked in", async () => {
    const out = join(tmpdir(), `kona-viewer-styles-${String(process.pid)}.css`);
    try {
      const built = Bun.spawnSync({
        cmd: ["bunx", "@tailwindcss/cli", "-i", "src/theme.css", "-o", out],
        cwd: PACKAGE,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(built.exitCode).toBe(0);

      const fresh = readFileSync(out, "utf8");
      const committed = readFileSync(join(PACKAGE, "src", "styles.css"), "utf8");
      // A diff of 30k of CSS is unreadable, so the assertion says what to do about it instead.
      if (fresh !== committed) {
        throw new Error(
          "packages/viewer/src/styles.css is stale — run `bun run css` in packages/viewer",
        );
      }
    } finally {
      rmSync(out, { force: true });
    }
  });
});
