import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..", "..");
const pluginRoot = join(repositoryRoot, "plugin");
const readJson = (path: string): Record<string, any> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const capability = readJson(join(pluginRoot, "capabilities", "prd.json"));
const marketplace = readJson(join(repositoryRoot, ".claude-plugin", "marketplace.json"));
const rootManifest = readJson(join(repositoryRoot, "package.json"));
const packageManifest = readJson(join(pluginRoot, "package.json"));
const claudePlugin = readJson(join(pluginRoot, ".claude-plugin", "plugin.json"));

describe("PRD capability manifest", () => {
  test("records aligned identity, modes, canonical hashes, and file modes", () => {
    expect(capability.name).toBe("prd");
    expect(capability.version).toBe("0.1.1");
    expect(capability.version).toBe(claudePlugin.version);
    expect(capability.version).toBe(packageManifest.version);
    expect(capability.modes).toEqual(["create", "refine"]);

    for (const file of Object.values(capability.canonical) as Array<{
      path: string;
      sha256: string;
      mode: string;
    }>) {
      expect(file.sha256).toBe(sha256(join(pluginRoot, file.path)));
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(file.mode).toBe("0644");
    }
  });

  test("declares every host with its exact invocation and scopes", () => {
    expect(capability.hosts).toEqual({
      opencode: { scopes: ["project", "user"], invocation: "@prd-writer" },
      codex: { scopes: ["project", "user"], invocation: "$prd" },
      claude: { scopes: ["project", "local", "user"], invocation: "/kona:prd" },
      pi: { scopes: ["project", "user"], invocation: "/skill:prd" },
    });
  });
});

describe("distribution manifests", () => {
  test("publishes the unqualified kona plugin from the approved marketplace", () => {
    expect(marketplace.name).toBe("kona");
    expect(marketplace.owner.url).toBe("https://github.com/open-treasury/kona");
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0]).toMatchObject({
      name: "kona",
      source: "./plugin",
      version: capability.version,
      repository: "https://github.com/open-treasury/kona",
    });
    expect(marketplace.plugins[0].name).not.toContain("@");
  });

  test("keeps the release package private and exposes only the Node 20 kona executable", () => {
    expect(packageManifest.private).toBe(true);
    expect(packageManifest.engines).toEqual({ node: ">=20" });
    expect(packageManifest.bin).toEqual({ kona: "./bin/kona.mjs" });
    expect(packageManifest.dependencies).toEqual({});
    expect(packageManifest.optionalDependencies).toBeUndefined();
    expect(packageManifest.peerDependencies).toBeUndefined();
    expect(packageManifest.pi).toBeUndefined();
    expect(packageManifest.keywords).toBeUndefined();
  });

  test("discovers the canonical Pi skill from the repository-root package manifest", () => {
    expect(rootManifest.private).toBe(true);
    expect(rootManifest.keywords).toContain("pi-package");
    expect(rootManifest.pi).toEqual({ skills: ["./plugin/skills/prd"] });
  });

  test("preserves existing Claude workflow and hook discovery", () => {
    expect(claudePlugin).toMatchObject({
      name: "kona",
      version: "0.1.1",
      skills: "./skills/",
    });
    expect(claudePlugin.hooks).toBe("./hooks/hooks.json");
  });
});
