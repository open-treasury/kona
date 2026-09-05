import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateStaticContracts } from "../scripts/contracts.mjs";
import { CAPABILITY_REGISTRY, validateCapabilityRegistry } from "../lib/capability-registry.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function copyContractFixture() {
  const fixture = await mkdtemp(join(tmpdir(), "kona-static-contract-"));
  await Promise.all([
    cp(join(root, "plugin"), join(fixture, "plugin"), { recursive: true }),
    cp(join(root, ".opencode"), join(fixture, ".opencode"), { recursive: true }),
    mkdir(join(fixture, ".claude-plugin"), { recursive: true }),
    cp(join(root, "install.sh"), join(fixture, "install.sh")),
    cp(join(root, "package.json"), join(fixture, "package.json")),
  ]);
  await cp(
    join(root, ".claude-plugin/marketplace.json"),
    join(fixture, ".claude-plugin/marketplace.json"),
  );
  return fixture;
}

test("recursive runtime and contributor mirrors have no guidelines dependency", async () => {
  const result = await validateStaticContracts(root);
  assert.equal(result.capabilityVersion, "0.3.0");
  assert.deepEqual(result.capabilities, ["copy", "prd", "spec"]);
  assert.deepEqual(result.hosts, ["opencode", "codex", "claude", "pi"]);
});

for (const control of [
  {
    name: "capability name",
    mutate: (registry) => {
      registry[1].name = registry[0].name;
    },
    error: /duplicate capability name/,
  },
  {
    name: "canonical path",
    mutate: (registry) => {
      registry[1].canonical[0] = registry[0].canonical[0];
    },
    error: /duplicate canonical path/,
  },
  {
    name: "adapter path",
    mutate: (registry) => {
      registry[1].adapter = registry[0].adapter;
    },
    error: /duplicate adapter path/,
  },
  {
    name: "host invocation",
    mutate: (registry) => {
      registry[1].hosts.opencode.invocation = registry[0].hosts.opencode.invocation;
    },
    error: /duplicate host invocation/,
  },
]) {
  test(`registry negative control rejects duplicate ${control.name}`, () => {
    const registry = structuredClone(CAPABILITY_REGISTRY);
    control.mutate(registry);
    assert.throws(() => validateCapabilityRegistry(registry), control.error);
  });
}

for (const control of [
  {
    name: "missing capability discriminator",
    path: "plugin/capabilities/copy.json",
    mutate: (value) => value.replace('  "type": "capability",\n', ""),
    error: /capability identity is invalid/,
  },
  {
    name: "copy canonical hash drift",
    path: "plugin/skills/copy/references/components.md",
    mutate: (value) => `${value}\nchanged\n`,
    error: /canonical hash drift/,
  },
  {
    name: "canonical hash drift",
    path: "plugin/skills/prd/SKILL.md",
    mutate: (value) => `${value}\nchanged\n`,
    error: /canonical hash drift/,
  },
  {
    name: "SPEC canonical hash drift",
    path: "plugin/skills/spec/templates/spec.md",
    mutate: (value) => `${value}\nchanged\n`,
    error: /canonical hash drift/,
  },
  {
    name: "expanded adapter procedure",
    path: "plugin/hosts/opencode/agents/prd-writer.md",
    mutate: (value) =>
      `${value}\n## TL;DR\n## Motivation\n## User Stories\n## Definition of Done\n`,
    error: /adapter is not thin|duplicates the canonical procedure/,
  },
  {
    name: "invalid Pi manifest",
    path: "package.json",
    mutate: (value) => value.replace('"./plugin/skills/copy"', '"./copied-copy"'),
    error: /root Pi package metadata/,
  },
  {
    name: "duplicate manifest capability name",
    path: "plugin/capabilities/spec.json",
    mutate: (value) => value.replace('"name": "spec"', '"name": "prd"'),
    error: /duplicate capability name/,
  },
  {
    name: "duplicate manifest canonical path",
    path: "plugin/capabilities/spec.json",
    mutate: (value) => value.replace("skills/spec/SKILL.md", "skills/prd/SKILL.md"),
    error: /duplicate canonical path/,
  },
  {
    name: "duplicate manifest invocation",
    path: "plugin/capabilities/spec.json",
    mutate: (value) => value.replace("@spec-writer", "@prd-writer"),
    error: /duplicate host invocation/,
  },
  {
    name: "altered SPEC adapter",
    path: "plugin/hosts/opencode/agents/spec-writer.md",
    mutate: (value) => value.replace("Use the `spec` skill", "Use the `prd` skill"),
    error: /adapter contract is missing/,
  },
  {
    name: "forbidden guidelines runtime reference",
    path: "plugin/hosts/opencode/agents/spec-writer.md",
    mutate: (value) =>
      value.replace(
        "Edit only the agreed SPEC",
        "Do not read `guidelines/docs/spec.md`. Edit only the agreed SPEC",
      ),
    error: /forbidden dependency: guidelines\//,
  },
  {
    name: "forbidden guidelines contributor-mirror reference",
    path: ".opencode/skills/copy/SKILL.md",
    mutate: (value) => `${value}\nRead guidelines/copy.md.\n`,
    error: /forbidden dependency: guidelines\//,
  },
  {
    name: "runtime network client",
    path: "plugin/lib/plugin-lifecycle.mjs",
    mutate: (value) => `${value}\nfetch("https://example.invalid");\n`,
    error: /network client/,
  },
  {
    name: "existing workflow drift",
    path: "plugin/skills/run/SKILL.md",
    mutate: (value) => `${value}\nchanged\n`,
    error: /existing workflow behavior drifted/,
  },
]) {
  test(`negative control rejects ${control.name}`, async () => {
    const fixture = await copyContractFixture();
    try {
      const path = join(fixture, control.path);
      await writeFile(path, control.mutate(await readFile(path, "utf8")));
      await assert.rejects(validateStaticContracts(fixture), control.error);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
}
