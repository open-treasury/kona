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
import { readFileSync, readdirSync, rmSync } from "node:fs";
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
  });

  test("the bundle carries a utility if and only if `src/` mentions it", () => {
    // NOT a fixed list of forbidden class names. That was the first version of this test and
    // it decayed exactly as you would expect: `.grow` and `.transition` are now used by real
    // components, so asserting their absence began failing for the right reason in the wrong
    // test.
    //
    // The invariant that does not decay: for any single-word utility, it is in the bundle IF
    // AND ONLY IF `src/` mentions it somewhere. Test prose cannot put one in; a component
    // using one cannot leave it out. Comments in `src/` count, and should — the scanner reads
    // them too, and scoping it to `src/` was the whole fix, not teaching it to skip comments.
    const styles = readFileSync(join(PACKAGE, "src", "styles.css"), "utf8");
    const source = readdirSync(join(PACKAGE, "src"), { recursive: true, encoding: "utf8" })
      .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))
      .map((entry) => readFileSync(join(PACKAGE, "src", entry), "utf8"))
      .join("\n");

    // Single-word utilities that need no arbitrary value, so presence is unambiguous. Some
    // are used today and some are not; the test does not care which, only that the two
    // answers agree.
    for (const utility of ["static", "grow", "transition", "isolate", "contents", "collapse", "invisible", "italic", "truncate"]) {
      const inBundle = styles.includes(`\n  .${utility} {`);
      const inSource = new RegExp(`\\b${utility}\\b`).test(source);
      expect(`${utility}: bundle=${String(inBundle)}`).toBe(`${utility}: bundle=${String(inSource)}`);
    }
  });
});
