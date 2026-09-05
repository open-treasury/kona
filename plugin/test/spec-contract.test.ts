import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const pluginRoot = join(import.meta.dir, "..");
const skillPath = join(pluginRoot, "skills", "spec", "SKILL.md");
const templatePath = join(pluginRoot, "skills", "spec", "templates", "spec.md");
const adapterPath = join(pluginRoot, "hosts", "opencode", "agents", "spec-writer.md");
const localAdapterPath = join(pluginRoot, "..", ".opencode", "agents", "spec-writer.md");
const skill = readFileSync(skillPath, "utf8");
const template = readFileSync(templatePath, "utf8");
const adapter = readFileSync(adapterPath, "utf8");
const frontmatterPattern = /^---\n([\s\S]*?)\n---/;

const requiredSections = [
  "TL;DR",
  "Meta Information",
  "Context",
  "Key Technical Drivers",
  "Current State",
  "Considered Options",
  "Proposed Solution",
  "Testing Strategy",
  "Definition of Done",
  "Alternatives Not Chosen",
  "References",
];

const markdownFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });

describe("canonical SPEC skill", () => {
  test("has portable Agent Skills frontmatter", () => {
    const block = frontmatterPattern.exec(skill)?.[1] ?? "";
    const frontmatter = Bun.YAML.parse(block) as Record<string, unknown>;

    expect(block).not.toBe("");
    expect(frontmatter.name).toBe("spec");
    expect(typeof frontmatter.description).toBe("string");
    expect(String(frontmatter.description)).toMatch(/create or refine/i);
  });

  test("defines create, refinement, destination, and overwrite behavior", () => {
    for (const contract of [
      /explicit path[\s\S]*repository convention[\s\S]*specs\/<feature-slug>\/spec\.md/i,
      /lowercase ASCII kebab-case/i,
      /do not overwrite[\s\S]*confirmation/i,
      /preserve unaffected confirmed decisions/i,
      /consequential changes to architecture, interfaces, data, operations, tests, or Definition/i,
      /do not replace the document merely to impose/i,
    ]) {
      expect(skill).toMatch(contract);
    }
  });

  test("defines evidence and material-question handling", () => {
    for (const contract of [
      /governing PRD or equivalent confirmed requirements/i,
      /source code, tests, configuration, and technical documentation/i,
      /do not ask[\s\S]*facts that can be verified locally/i,
      /Confirmed:[\s\S]*Recommended:[\s\S]*Unresolved:/,
      /Never present inference as confirmed fact/i,
      /one grouped set of concise questions/i,
      /materially change architecture, interfaces, data behavior, security, operability, testing, scope, or\s+acceptance/i,
      /validated source[\s\S]*omit the claim or mark it Unresolved/i,
    ]) {
      expect(skill).toMatch(contract);
    }
  });

  test("requires meaningful decisions, solution detail, TDD, and repository-derived DoD", () => {
    for (const contract of [
      /at least two credible,[\s\S]*meaningfully distinct options/i,
      /Do not manufacture a straw option/i,
      /Select one option explicitly as Confirmed or Recommended/i,
      /rejection rationale/i,
      /component responsibilities[\s\S]*traceability from\s+drivers to decisions/i,
      /advantages, limitations, consequences/i,
      /RED-GREEN-REFACTOR[\s\S]*unit and integration\s+test boundaries/i,
      /repository-wide checks discovered from repository\s+instructions and scripts/i,
      /feature-specific, objectively verifiable completion criteria/i,
      /Do not invent commands, checks, compliance requirements/i,
      /alternatives not chosen and references/i,
    ]) {
      expect(skill).toMatch(contract);
    }
  });

  test("enforces validation and the SPEC-only write boundary", () => {
    for (const contract of [
      /strict SPEC-only write boundary[\s\S]*edit only the\s+agreed SPEC/i,
      /Do not implement[\s\S]*task DAG[\s\S]*beads issues/i,
      /missing decisions, contradictions, duplicated content, unresolved template\s+placeholders/i,
      /broken references[\s\S]*acceptance criteria that cannot be objectively verified/i,
      /no file other than the agreed SPEC was changed/i,
      /report the written path[\s\S]*unresolved decisions/i,
    ]) {
      expect(skill).toMatch(contract);
    }
  });

  test("uses its bundled template and has no source-tree runtime dependency", () => {
    expect(skill).toContain("[`templates/spec.md`](templates/spec.md)");

    for (const source of [skill, template, adapter, readFileSync(localAdapterPath, "utf8")]) {
      expect(source).not.toMatch(/guidelines[\\/]/i);
    }
  });
});

describe("canonical SPEC template", () => {
  test("contains the required decision sections in order", () => {
    let previousIndex = -1;
    for (const section of requiredSections) {
      const index = template.indexOf(section);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
  });

  test("captures option quality, the solution, consequences, testing, and DoD", () => {
    for (const content of [
      "Confirmed, Recommended, or Unresolved",
      "`file:line`",
      "credible, meaningfully distinct choices",
      "State the selected option explicitly",
      "### 6.1. Components",
      "### 6.2. Pros, Cons, and Consequences",
      "RED-GREEN-REFACTOR",
      "### 7.1. Unit Tests",
      "### 7.2. Integration Tests",
      "Derive universal checks from actual repository instructions",
      "### Universal",
      "### Feature-Specific",
      "Why rejected",
      "validated external source",
    ]) {
      expect(template).toContain(content);
    }
  });

  test("is the only complete SPEC procedure under plugin", () => {
    const duplicates = markdownFiles(pluginRoot).filter((path) => {
      if (path === skillPath || path === templatePath) return false;
      const source = readFileSync(path, "utf8");
      return requiredSections.every((section) => source.includes(section));
    });

    expect(duplicates).toEqual([]);
  });
});

describe("OpenCode SPEC adapter", () => {
  test("is a thin canonical-skill delegate with Markdown-only permissions", () => {
    expect(adapter).toContain('edit:\n    "*": deny\n    "*.md": allow');
    expect(adapter).toContain("bash: deny");
    expect(adapter).toContain("Use the `spec` skill for the complete procedure.");
    expect(adapter).toContain("Edit only the agreed SPEC");
    expect(adapter.split("\n").length).toBeLessThan(15);
    for (const section of requiredSections) expect(adapter).not.toContain(section);
  });

  test("matches the contributor-local adapter byte for byte", () => {
    expect(readFileSync(localAdapterPath)).toEqual(readFileSync(adapterPath));
  });
});
