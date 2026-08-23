/**
 * The eval skill's frontmatter must parse as YAML.
 *
 * This test exists because of a run that cost real money and measured nothing. Terminus-2
 * discovers skills by reading `SKILL.md`, matching `^---\n(.*?)\n---`, and calling
 * `yaml.safe_load` on the result — and on `YAMLError` it returns `None` and **silently drops
 * the skill**. No warning, no log line, no failure. The agent simply never sees an
 * `<available_skills>` block, the arm degrades into "baseline plus an unused binary", and the
 * run looks exactly like a real zero-adoption result.
 *
 * That is what happened: a `description:` was edited to include a shell example, the example
 * contained double quotes, the scalar was already double-quoted, the YAML broke, and the
 * failure was invisible until someone read the trajectory and noticed the skill block missing.
 *
 * So: parse it here, in a test that fails loudly, rather than discovering it an hour and a
 * couple of dollars into a run.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Bun ships a YAML parser, so this guard costs the eval package no dependency.
const parse = (source: string): unknown => Bun.YAML.parse(source);

const SKILL = join(import.meta.dir, "..", "skills", "kona", "SKILL.md");

/** The exact regex Terminus-2 uses, so this test fails when Terminus would fail. */
const FRONTMATTER = /^---\n([\s\S]*?)\n---/;

describe("eval skill frontmatter", () => {
  const source = readFileSync(SKILL, "utf8");

  test("has a frontmatter block Terminus-2's regex can find", () => {
    expect(FRONTMATTER.test(source)).toBe(true);
  });

  test("parses as YAML — a YAMLError silently unpublishes the skill", () => {
    const block = FRONTMATTER.exec(source)?.[1] ?? "";
    // `parse` throws on malformed YAML, which is the whole point: Terminus swallows that
    // exception and drops the skill, so the loud failure has to happen here instead.
    expect(() => parse(block)).not.toThrow();
  });

  test("carries both keys Terminus requires, or the skill is dropped", () => {
    const frontmatter = parse(FRONTMATTER.exec(source)?.[1] ?? "") as Record<string, unknown>;
    // `if not isinstance(fm, dict) or "name" not in fm or "description" not in fm: return None`
    expect(typeof frontmatter["name"]).toBe("string");
    expect(typeof frontmatter["description"]).toBe("string");
  });

  test("the description is what the model reads before deciding, so it is not empty", () => {
    const frontmatter = parse(FRONTMATTER.exec(source)?.[1] ?? "") as Record<string, string>;
    // Adoption is decided on this string alone — the body is only read after the model has
    // already chosen to read it. An empty or stub description is a silent adoption failure.
    expect((frontmatter["description"] ?? "").length).toBeGreaterThan(80);
  });
});
