import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const skill = readFileSync(join(import.meta.dir, "..", "skills", "issues", "SKILL.md"), "utf8");

const scenarios = [
  {
    name: "missing installation",
    evidence: [
      /`br` is unavailable/i,
      /exact command, source, and expected system effect/i,
      /explicit confirmation/i,
    ],
  },
  {
    name: "uninitialized project",
    evidence: [/project is not\s+initialized/i, /before running\s+`br init`/i],
  },
  { name: "small work", evidence: [/small bounded change, use one issue/i] },
  {
    name: "substantial feature",
    evidence: [/substantial feature[\s\S]*one epic/i, /child issues before implementing a child/i],
  },
  {
    name: "dependency graph",
    evidence: [/dependent work depend on its blocker/i, /dependencies are acyclic/i],
  },
  {
    name: "claim conflict",
    evidence: [/another active actor/i, /age\s+alone does not authorize takeover/i],
  },
  {
    name: "discovered work",
    evidence: [/newly discovered required work/i, /before undertaking it/i],
  },
  {
    name: "failed verification",
    evidence: [/verification fails[\s\S]*accurately non-closed/i],
  },
  {
    name: "successful closure",
    evidence: [/Close only when the criteria pass/i, /outcome and evidence/i],
  },
  {
    name: "bounded continuation",
    evidence: [/do not automatically start[\s\S]*another issue/i],
  },
];

describe("issues workflow scenarios", () => {
  for (const scenario of scenarios) {
    test(scenario.name, () => {
      for (const evidence of scenario.evidence) expect(skill).toMatch(evidence);
    });
  }

  test("contains no executable prohibited backend commands", () => {
    expect(skill).not.toMatch(/(?:^|\n)\s*(?:\$\s*)?bd\s+\w+/m);
    expect(skill).not.toMatch(/(?:^|\n)\s*(?:\$\s*)?dolt\s+\w+/im);
  });

  test("keeps issue semantics separate from the current backend", () => {
    expect(skill).toMatch(/public capability is `issues`/i);
    expect(skill).toMatch(/`br` is its required backend for this release/i);
    expect(skill).toMatch(/future Kona backend can replace `br`/i);
  });
});
