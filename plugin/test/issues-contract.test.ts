import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const pluginRoot = join(import.meta.dir, "..");
const skillPath = join(pluginRoot, "skills", "issues", "SKILL.md");
const manifestPath = join(pluginRoot, "capabilities", "issues.json");
const skill = readFileSync(skillPath, "utf8");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, any>;
const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

describe("canonical issues capability", () => {
  test("has broad portable frontmatter", () => {
    const block = /^---\n([\s\S]*?)\n---/.exec(skill)?.[1] ?? "";
    const frontmatter = Bun.YAML.parse(block) as Record<string, unknown>;
    expect(frontmatter.name).toBe("issues");
    expect(String(frontmatter.description)).toMatch(
      /planning, implementation, and task management/i,
    );
    expect(String(frontmatter.description)).toMatch(/issues, tasks, epics/i);
  });

  test("requires issue lifecycle and epic decomposition", () => {
    for (const contract of [
      /sole todo and task\s+tracker/i,
      /reuse an existing issue or create one/i,
      /substantial feature[\s\S]*epic[\s\S]*child issues/i,
      /ready work contains only genuinely[\s\S]*actionable issues/i,
      /Claim or mark it active before substantive implementation/i,
      /newly discovered required work/i,
      /Close only when the criteria pass/i,
      /do not automatically start[\s\S]*another issue/i,
    ])
      expect(skill).toMatch(contract);
  });

  test("requires informed bootstrap consent", () => {
    for (const contract of [
      /If `br` is unavailable[\s\S]*ask for explicit confirmation/i,
      /install only after approval[\s\S]*verify the executable and version/i,
      /not\s+initialized[\s\S]*ask for explicit confirmation[\s\S]*`br init`/i,
      /installation and initialization only when both actions were\s+disclosed/i,
      /declined or fails[\s\S]*tracked work is blocked/i,
    ])
      expect(skill).toMatch(contract);
  });

  test("enforces backend and safety boundaries", () => {
    for (const contract of [
      /Never invoke, install, recommend, or fall back[\s\S]*`bd`/i,
      /Never install,[\s\S]*depend on Dolt/i,
      /Never read or edit tracker storage\s+directly/i,
      /Do not maintain a parallel todo list/i,
      /Tracker work does not authorize commits, pushes, pulls, merges, releases/i,
      /future Kona backend can replace `br`/i,
    ])
      expect(skill).toMatch(contract);
  });

  test("has no destination repository assumptions", () => {
    for (const forbidden of [
      "plugin/",
      "specs/",
      ".opencode/",
      ".agents/",
      ".claude/",
      ".pi/",
      "AGENTS.md",
      ".beads/",
    ])
      expect(skill).not.toContain(forbidden);
  });

  test("has an exact standalone manifest", () => {
    expect(manifest).toMatchObject({
      type: "capability",
      schemaVersion: 1,
      name: "issues",
      version: "0.4.2",
      modes: ["plan", "execute"],
    });
    expect(Object.keys(manifest.canonical)).toEqual(["skill"]);
    expect(manifest.canonical.skill).toEqual({
      path: "skills/issues/SKILL.md",
      sha256: sha256(skillPath),
      mode: "0644",
    });
    expect(statSync(skillPath).mode & 0o777).toBe(0o644);
    expect(manifest.hosts).toEqual({
      opencode: { scopes: ["project", "user"], invocation: "issues" },
      codex: { scopes: ["project", "user"], invocation: "$issues" },
      claude: { scopes: ["project", "local", "user"], invocation: "/kona:issues" },
      pi: { scopes: ["project", "user"], invocation: "/skill:issues" },
    });
  });
});
