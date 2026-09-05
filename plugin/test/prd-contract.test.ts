import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const pluginRoot = join(import.meta.dir, "..");
const skillPath = join(pluginRoot, "skills", "prd", "SKILL.md");
const templatePath = join(pluginRoot, "skills", "prd", "templates", "prd.md");
const skill = readFileSync(skillPath, "utf8");
const template = readFileSync(templatePath, "utf8");
const adapterPath = join(pluginRoot, "hosts", "opencode", "agents", "prd-writer.md");
const adapter = readFileSync(adapterPath, "utf8");
const frontmatterPattern = /^---\n([\s\S]*?)\n---/;

const requiredSections = [
  "TL;DR",
  "What",
  "Motivation",
  "User Stories",
  "User Flow",
  "Definition of Done",
  "Out of Scope",
];

const markdownFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });

describe("canonical PRD skill", () => {
  test("has portable Agent Skills frontmatter", () => {
    const block = frontmatterPattern.exec(skill)?.[1] ?? "";
    const frontmatter = Bun.YAML.parse(block) as Record<string, unknown>;

    expect(block).not.toBe("");
    expect(frontmatter.name).toBe("prd");
    expect(typeof frontmatter.description).toBe("string");
    expect(String(frontmatter.description)).toMatch(/create or refine/i);
  });

  test("defines the complete create and targeted-refinement contract", () => {
    for (const contract of [
      /explicit path[\s\S]*repository convention[\s\S]*specs\/<feature-slug>\/prd\.md/i,
      /lowercase ASCII kebab-case/i,
      /one grouped set of concise questions/i,
      /do not ask[\s\S]*facts that can be verified locally/i,
      /Confirmed:[\s\S]*Recommended:[\s\S]*Unresolved:/,
      /do not overwrite[\s\S]*confirmation/i,
      /preserve unaffected confirmed decisions/i,
      /do not replace the document merely to impose/i,
      /edit only the agreed PRD/i,
      /PRD authoring is offline[\s\S]*do not access the network[\s\S]*analytics or telemetry/i,
      /not application code, schemas,[\s\S]*implementation task plan/i,
      /contradictions[\s\S]*duplicated content[\s\S]*unresolved template placeholders[\s\S]*invented claims/i,
      /report the written path[\s\S]*unresolved decisions/i,
    ]) {
      expect(skill).toMatch(contract);
    }
  });

  test("uses its bundled template and has no external Kona runtime dependency", () => {
    expect(skill).toContain("[`templates/prd.md`](templates/prd.md)");

    const canonical = `${skill}\n${template}`;
    for (const forbiddenReference of [
      "guidelines/docs/prd.md",
      "docs/agent-toolkit/",
      "docs/pm/",
      "docs/compliance/",
      "writing-prds",
      "write-prd",
      "/kona:plan",
      "/kona:run",
    ]) {
      expect(canonical).not.toContain(forbiddenReference);
    }
  });
});

describe("canonical PRD template", () => {
  test("contains the lean sections in order", () => {
    let previousIndex = -1;
    for (const section of requiredSections) {
      const index = template.indexOf(section);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
  });

  test("captures the required product decisions and testable outcomes", () => {
    for (const content of [
      "### In Scope",
      "### Problem",
      "### Goals",
      "### Users",
      "### Functional Requirements",
      "### Non-Functional Requirements",
      "### Acceptance Criteria",
      "Given <precondition>, When <action>, Then <observable outcome>",
      "### Risks",
    ]) {
      expect(template).toContain(content);
    }
  });

  test("does not make optional ceremony part of the fallback scaffold", () => {
    for (const optionalHeading of [
      "Meta Information",
      "References",
      "FAQs",
      "Appendix",
      "Success Metrics",
      "Instrumentation",
      "Compliance",
      "Branch",
      "Epic",
    ]) {
      expect(template).not.toMatch(new RegExp(`^#{2,3} \\d*\\.? ?${optionalHeading}`, "m"));
    }
  });

  test("is the only complete PRD procedure under plugin", () => {
    const duplicates = markdownFiles(pluginRoot).filter((path) => {
      if (path === skillPath || path === templatePath) return false;
      const source = readFileSync(path, "utf8");
      return requiredSections.every((section) => source.includes(section));
    });

    expect(duplicates).toEqual([]);
  });
});

describe("OpenCode PRD adapter", () => {
  test("is a thin canonical-skill delegate with documentation-only permissions", () => {
    expect(adapter).toContain('edit:\n    "*": deny\n    "*.md": allow');
    expect(adapter).toContain("bash: deny");
    expect(adapter).toContain("Use the `prd` skill for the complete procedure.");
    expect(adapter).toContain("Edit only the agreed PRD");
    expect(adapter.split("\n").length).toBeLessThan(15);
    for (const section of requiredSections) expect(adapter).not.toContain(section);
  });

  test("matches the contributor-local adapter byte for byte", () => {
    expect(readFileSync(join(pluginRoot, "..", ".opencode", "agents", "prd-writer.md"))).toEqual(
      readFileSync(adapterPath),
    );
  });
});
