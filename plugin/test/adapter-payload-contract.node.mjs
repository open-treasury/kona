import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { loadAdapterPayloadContract } from "./support/host-adapter-harness.mjs";

const pluginRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(pluginRoot, "..");
const hosts = ["opencode", "codex", "claude", "pi"];
const invocations = {
  prd: { opencode: "@prd-writer", codex: "$prd", claude: "/kona:prd", pi: "/skill:prd" },
  spec: {
    opencode: "@spec-writer",
    codex: "$spec",
    claude: "/kona:spec",
    pi: "/skill:spec",
  },
};
const writeBoundaries = { prd: "agreed-prd-only", spec: "agreed-spec-only" };

async function installPayload(root, host) {
  const destination = join(root, host);
  await mkdir(destination, { recursive: true });
  if (host === "opencode") {
    await cp(join(pluginRoot, "skills"), join(destination, "skills"), { recursive: true });
    await cp(join(pluginRoot, "hosts/opencode/agents"), join(destination, "agents"), {
      recursive: true,
    });
  } else if (host === "codex") {
    await cp(join(pluginRoot, "skills"), join(destination, "skills"), { recursive: true });
  } else if (host === "claude") {
    await cp(pluginRoot, destination, { recursive: true, force: true });
  } else {
    await cp(join(repositoryRoot, "package.json"), join(destination, "package.json"));
    await mkdir(join(destination, "plugin"), { recursive: true });
    await cp(join(pluginRoot, "skills"), join(destination, "plugin/skills"), { recursive: true });
  }
  return destination;
}

test("adapter payload/contract parity resolves exact canonical bytes and host contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "kona-adapter-contract-"));
  try {
    for (const host of hosts) {
      const installedRoot = await installPayload(root, host);
      for (const capability of ["prd", "spec"]) {
        const contracts = [
          await loadAdapterPayloadContract(
            host,
            host === "pi" ? repositoryRoot : pluginRoot,
            pluginRoot,
            "distributed",
            capability,
          ),
          await loadAdapterPayloadContract(
            host,
            installedRoot,
            pluginRoot,
            "installed",
            capability,
          ),
        ];
        for (const contract of contracts) {
          assert.equal(contract.invocation, invocations[capability][host]);
          assert.deepEqual(contract.modes, ["create", "refine"]);
          assert.equal(contract.writeBoundary, writeBoundaries[capability]);
        }
        assert.deepEqual(contracts[0].canonicalBytes, contracts[1].canonicalBytes);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adapter payload/contract parity rejects altered resolution and canonical bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "kona-adapter-contract-negative-"));
  try {
    const alteredAdapter = await installPayload(join(root, "altered-adapter"), "opencode");
    await writeFile(join(alteredAdapter, "agents/spec-writer.md"), "Do something else.\n");
    await assert.rejects(
      loadAdapterPayloadContract("opencode", alteredAdapter, pluginRoot, "installed", "spec"),
      /does not delegate/,
    );

    for (const host of hosts) {
      for (const relativePath of ["SKILL.md", "templates/spec.md"]) {
        const installed = await installPayload(join(root, `${host}-${relativePath}`), host);
        const skillRoot = host === "pi" ? "plugin/skills/spec" : "skills/spec";
        await writeFile(join(installed, skillRoot, relativePath), "altered SPEC payload\n");
        await assert.rejects(
          loadAdapterPayloadContract(host, installed, pluginRoot, "installed", "spec"),
          /resolved canonical (?:skill|template) is missing or altered/,
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
