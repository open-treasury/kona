import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateStaticContracts } from "../scripts/contracts.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function copyContractFixture() {
  const fixture = await mkdtemp(join(tmpdir(), "kona-static-contract-"));
  await Promise.all([
    cp(join(root, "plugin"), join(fixture, "plugin"), { recursive: true }),
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

test("static validator enforces canonical, adapter, manifest, ownership, privacy, and workflow contracts", async () => {
  const result = await validateStaticContracts(root);
  assert.equal(result.capabilityVersion, "0.1.1");
  assert.deepEqual(result.hosts, ["opencode", "codex", "claude", "pi"]);
});

for (const control of [
  {
    name: "canonical hash drift",
    path: "plugin/skills/prd/SKILL.md",
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
    mutate: (value) => value.replace('"./plugin/skills/prd"', '"./copied-prd"'),
    error: /root Pi package metadata/,
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
