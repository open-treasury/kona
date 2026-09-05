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
  opencode: "@prd-writer",
  codex: "$prd",
  claude: "/kona:prd",
  pi: "/skill:prd",
};

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
      const contracts = [
        await loadAdapterPayloadContract(
          host,
          host === "pi" ? repositoryRoot : pluginRoot,
          pluginRoot,
          "distributed",
        ),
        await loadAdapterPayloadContract(
          host,
          await installPayload(root, host),
          pluginRoot,
          "installed",
        ),
      ];
      for (const contract of contracts) {
        assert.equal(contract.invocation, invocations[host]);
        assert.deepEqual(contract.modes, ["create", "refine"]);
        assert.equal(contract.writeBoundary, "agreed-prd-only");
      }
      assert.deepEqual(contracts[0].canonicalBytes, contracts[1].canonicalBytes);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adapter payload/contract parity rejects altered resolution and canonical bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "kona-adapter-contract-negative-"));
  try {
    const opencode = await installPayload(root, "opencode");
    await writeFile(join(opencode, "agents/prd-writer.md"), "Do something else.\n");
    await assert.rejects(
      loadAdapterPayloadContract("opencode", opencode, pluginRoot, "installed"),
      /does not delegate/,
    );

    const codex = await installPayload(root, "codex");
    await writeFile(join(codex, "skills/prd/SKILL.md"), "altered\n");
    await assert.rejects(
      loadAdapterPayloadContract("codex", codex, pluginRoot, "installed"),
      /resolved canonical skill is missing or altered/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
