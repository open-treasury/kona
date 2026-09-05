import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { CAPABILITY_REGISTRY } from "../lib/capability-registry.mjs";

const repositoryRoot = join(import.meta.dir, "..", "..");
const pluginRoot = join(repositoryRoot, "plugin");
const readJson = (path: string): Record<string, any> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const capabilities = CAPABILITY_REGISTRY.map(({ manifest }) =>
  readJson(join(pluginRoot, manifest)),
);
const marketplace = readJson(join(repositoryRoot, ".claude-plugin", "marketplace.json"));
const rootManifest = readJson(join(repositoryRoot, "package.json"));
const packageManifest = readJson(join(pluginRoot, "package.json"));
const claudePlugin = readJson(join(pluginRoot, ".claude-plugin", "plugin.json"));

describe("capability registry and manifests", () => {
  test("orders prd then spec and resolves each distribution surface", () => {
    expect(CAPABILITY_REGISTRY.map(({ name }) => name)).toEqual(["prd", "spec"]);
    expect(
      CAPABILITY_REGISTRY.map(({ manifest, copiedHostDirectory, adapter }) => ({
        manifest,
        copiedHostDirectory,
        adapter,
      })),
    ).toEqual([
      {
        manifest: "capabilities/prd.json",
        copiedHostDirectory: "skills/prd",
        adapter: "hosts/opencode/agents/prd-writer.md",
      },
      {
        manifest: "capabilities/spec.json",
        copiedHostDirectory: "skills/spec",
        adapter: "hosts/opencode/agents/spec-writer.md",
      },
    ]);
  });

  test("records aligned identity, modes, canonical hashes, and exact file modes", () => {
    for (const [index, capability] of capabilities.entries()) {
      expect(capability.schemaVersion).toBe(1);
      expect(capability.name).toBe(CAPABILITY_REGISTRY[index].name);
      expect(capability.version).toBe("0.2.0");
      expect(capability.version).toBe(claudePlugin.version);
      expect(capability.version).toBe(packageManifest.version);
      expect(capability.version).toBe(marketplace.plugins[0].version);
      expect(capability.modes).toEqual(CAPABILITY_REGISTRY[index].modes);

      const files = Object.values(capability.canonical) as Array<{
        path: string;
        sha256: string;
        mode: string;
      }>;
      expect(files.map(({ path }) => path)).toEqual(CAPABILITY_REGISTRY[index].canonical);
      for (const file of files) {
        const path = join(pluginRoot, file.path);
        expect(file.sha256).toBe(sha256(path));
        expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(file.mode).toBe("0644");
        expect(statSync(path).mode & 0o777).toBe(0o644);
      }
    }
  });

  test("declares every host with its exact invocation and scopes", () => {
    for (const [index, capability] of capabilities.entries()) {
      expect(capability.hosts).toEqual(CAPABILITY_REGISTRY[index].hosts);
    }
    expect(capabilities.map(({ hosts }) => hosts.opencode.invocation)).toEqual([
      "@prd-writer",
      "@spec-writer",
    ]);
    expect(capabilities.map(({ hosts }) => hosts.codex.invocation)).toEqual(["$prd", "$spec"]);
    expect(capabilities.map(({ hosts }) => hosts.claude.invocation)).toEqual([
      "/kona:prd",
      "/kona:spec",
    ]);
    expect(capabilities.map(({ hosts }) => hosts.pi.invocation)).toEqual([
      "/skill:prd",
      "/skill:spec",
    ]);
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
      version: capabilities[0].version,
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

  test("discovers both canonical Pi skills in registry order", () => {
    expect(rootManifest.private).toBe(true);
    expect(rootManifest.keywords).toContain("pi-package");
    expect(rootManifest.pi).toEqual({
      skills: ["./plugin/skills/prd", "./plugin/skills/spec"],
    });
  });

  test("preserves existing Claude workflow and hook discovery", () => {
    expect(claudePlugin).toMatchObject({
      name: "kona",
      version: "0.2.0",
      skills: "./skills/",
    });
    expect(claudePlugin.hooks).toBe("./hooks/hooks.json");
  });
});
