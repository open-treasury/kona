import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..", "..");
const pluginRoot = join(repositoryRoot, "plugin");
const skillRoot = join(pluginRoot, "skills", "copy");
const localSkillRoot = join(repositoryRoot, ".opencode", "skills", "copy");
const skillPath = join(skillRoot, "SKILL.md");
const stylePath = join(skillRoot, "references", "style-and-safety.md");
const componentsPath = join(skillRoot, "references", "components.md");
const adapterPath = join(pluginRoot, "hosts", "opencode", "agents", "copy-writer.md");
const localAdapterPath = join(repositoryRoot, ".opencode", "agents", "copy-writer.md");
const skill = readFileSync(skillPath, "utf8");
const style = readFileSync(stylePath, "utf8");
const components = readFileSync(componentsPath, "utf8");
const adapter = readFileSync(adapterPath, "utf8");
const payload = `${skill}\n${style}\n${components}`;
const frontmatterPattern = /^---\n([\s\S]*?)\n---/;

describe("canonical copy skill", () => {
  test("has portable frontmatter and all three modes", () => {
    const block = frontmatterPattern.exec(skill)?.[1] ?? "";
    const frontmatter = Bun.YAML.parse(block) as Record<string, unknown>;

    expect(frontmatter.name).toBe("copy");
    expect(String(frontmatter.description)).toMatch(/generate/i);
    expect(String(frontmatter.description)).toMatch(/revise/i);
    expect(String(frontmatter.description)).toMatch(/source-edit/i);
    for (const mode of ["Generate", "Revise", "Source-edit"]) {
      expect(skill).toContain(`**${mode}:**`);
    }
  });

  test("enforces context discovery, precedence, and grouped material questions", () => {
    expect(skill).toMatch(
      /Read only local context needed[\s\S]*terminology[\s\S]*source structure/i,
    );
    expect(skill).toMatch(/Do not ask[\s\S]*facts available in authoritative local context/i);

    const precedence = [
      "explicit user requirements",
      "authoritative repository or product terminology and style conventions",
      "the bundled default in the style reference",
    ].map((value) => skill.indexOf(value));
    expect(precedence.every((index) => index >= 0)).toBe(true);
    expect(precedence).toEqual(precedence.toSorted((left, right) => left - right));
    expect(skill).toMatch(/state the conflict[\s\S]*following the user's direction/i);
    expect(skill).toMatch(
      /one grouped, concise question set[\s\S]*Pause for\s+blocking decisions/i,
    );
  });

  test("defines safe generate destination and overwrite behavior without a fallback path", () => {
    const destinations = [
      "the user's explicit destination",
      "a clear repository convention for copy documents",
      "conversation output",
    ].map((value) => skill.indexOf(value));
    expect(destinations.every((index) => index >= 0)).toBe(true);
    expect(destinations).toEqual(destinations.toSorted((left, right) => left - right));
    expect(skill).toMatch(/If file output was not requested, respond in conversation/i);
    expect(skill).toMatch(/Never invent a generic file path/i);
    expect(skill).toMatch(
      /exists without explicit overwrite or revision intent[\s\S]*make no\s+change/i,
    );
    expect(skill).toMatch(/one recommended draft by default/i);
    expect(skill).toMatch(/small labeled set only when alternatives\s+materially help/i);
  });

  test("defines revision classification and preservation", () => {
    expect(skill).toMatch(/Preserve intended meaning and user-provided or required terminology/i);
    expect(skill).toMatch(/Required corrections:[\s\S]*objective constraint/i);
    expect(skill).toMatch(/Optional suggestions:[\s\S]*taste-based changes/i);
  });

  test("bounds source edits and preserves source structures", () => {
    expect(skill).toMatch(/explicitly agreed files and strings[\s\S]*bounded edit scope/i);
    expect(skill).toMatch(/Change only the agreed copy[\s\S]*Do not refactor/i);
    for (const structure of [
      "placeholders and interpolation tokens",
      "markup and links",
      "accessibility semantics",
      "localization keys",
    ]) {
      expect(skill).toContain(structure);
    }
    expect(skill).toMatch(/Preserve formatting, framework syntax[\s\S]*exactly/i);
    expect(skill).toMatch(/proportionate local\s+syntax checks or targeted tests/i);
    expect(skill).toMatch(/never claim successful validation after a failed or unrun check/i);
    expect(skill).toMatch(/target\s+is ambiguous[\s\S]*make no edit/i);
  });

  test("provides contextual tone, accessibility, localization, and component rules", () => {
    for (const contract of [
      /concise American English[\s\S]*active voice[\s\S]*sentence\s+case/i,
      /natural contractions[\s\S]*verb-led action labels/i,
      /Support, negative, sensitive, and error copy[\s\S]*non-blaming[\s\S]*actionable/i,
      /Apologize only when[\s\S]*responsible/i,
      /Marketing may use restrained personality or wit/i,
      /inclusive language/i,
      /localization-ready/i,
      /date, number, and currency formats[\s\S]*runtime locale\s+conventions/i,
      /Do not invent facts, metrics[\s\S]*product capabilities/i,
    ]) {
      expect(style).toMatch(contract);
    }

    for (const heading of [
      "Titles and headers",
      "Buttons and links",
      "Errors, support, and recovery",
      "Confirmations and notifications",
      "Empty states and hint text",
      "Alt text",
      "Marketing",
    ]) {
      expect(components).toContain(`## ${heading}`);
    }
    expect(components).toMatch(/Identify the problem specifically[\s\S]*Do not blame/i);
    expect(components).toMatch(/use "click here"/i);
  });

  test("is offline, self-contained, and has exactly two progressively loaded references", () => {
    expect(skill).toMatch(/Normal\s+authoring is offline[\s\S]*do not access the network/i);
    expect(skill).toMatch(/Before authoring or judging wording[\s\S]*style-and-safety\.md/i);
    expect(skill).toMatch(/components\.md[\s\S]*only for the applicable component/i);
    expect(readdirSync(join(skillRoot, "references")).toSorted()).toEqual([
      "components.md",
      "style-and-safety.md",
    ]);
    expect(readdirSync(skillRoot).toSorted()).toEqual(["SKILL.md", "references"]);
    expect(payload).not.toContain(["guide", "lines/"].join(""));
    expect(payload).not.toMatch(/https?:\/\//i);
  });
});

describe("copy payload and OpenCode adapter parity", () => {
  test("matches every contributor-local payload file byte for byte", () => {
    for (const relativePath of [
      "SKILL.md",
      join("references", "style-and-safety.md"),
      join("references", "components.md"),
    ]) {
      expect(readFileSync(join(localSkillRoot, relativePath))).toEqual(
        readFileSync(join(skillRoot, relativePath)),
      );
    }
  });

  test("uses supported approval defaults and delegates all behavior", () => {
    const block = frontmatterPattern.exec(adapter)?.[1] ?? "";
    const frontmatter = Bun.YAML.parse(block) as Record<string, any>;

    expect(frontmatter.mode).toBe("subagent");
    expect(frontmatter.permission).toEqual({ edit: "ask", bash: "ask", webfetch: "deny" });
    expect(adapter).toContain("Use the `copy` skill for the complete procedure.");
    expect(adapter.split("\n").length).toBeLessThan(15);
    expect(readFileSync(localAdapterPath)).toEqual(readFileSync(adapterPath));
    for (const duplicatedBehavior of ["American English", "source-edit", "conversation output"]) {
      expect(adapter).not.toContain(duplicatedBehavior);
    }
  });
});
