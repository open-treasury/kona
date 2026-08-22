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

  test("only `src/` feeds the class scanner — not this file", () => {
    // Tailwind's automatic source detection starts at the PACKAGE root, which made `test/` a
    // source of class names. Its extractor is liberal, so bare words in test prose became
    // real utilities: `.static`, `.grow` and `.transition` shipped in the bundle because
    // sentences here happened to contain those words.
    //
    // Dead CSS was the small half. The real half is that renaming a test could change the
    // product — and the test above, which exists to catch drift, would have reported the
    // change as legitimate.
    const theme = readFileSync(join(PACKAGE, "src", "theme.css"), "utf8");
    expect(theme).toContain("source(none)");
    expect(theme).toMatch(/@source\s+"\.\/\*\*\/\*\.\{ts,tsx\}"/);

    // And the proof it is working: none of the three is in the output any more, and none of
    // them is used by a component either.
    const styles = readFileSync(join(PACKAGE, "src", "styles.css"), "utf8");
    for (const leaked of [".static {", ".grow {", ".transition {"]) {
      expect(`${leaked} in styles.css: ${String(styles.includes(leaked))}`).toBe(
        `${leaked} in styles.css: false`,
      );
    }
  });
});
