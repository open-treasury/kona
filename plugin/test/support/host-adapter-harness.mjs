import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function resolvedPayload(host, root, layout, capabilityName) {
  if (host === "opencode") {
    const adapterPath = join(
      root,
      layout === "distributed"
        ? `hosts/opencode/agents/${capabilityName}-writer.md`
        : `agents/${capabilityName}-writer.md`,
    );
    const adapter = await readFile(adapterPath, "utf8");
    if (!adapter.includes(`Use the \`${capabilityName}\` skill for the complete procedure.`))
      throw new Error(`OpenCode adapter does not delegate to the resolved ${capabilityName} skill`);
    const permissions =
      capabilityName === "copy"
        ? /permission:\n  edit: ask\n  bash: ask\n  webfetch: deny\n/
        : /edit:\n\s+"\*": deny\n\s+"\*\.md": allow[\s\S]*bash: deny/;
    if (!permissions.test(adapter))
      throw new Error(`OpenCode ${capabilityName} adapter has an invalid permission boundary`);
    return join(root, `skills/${capabilityName}`);
  }
  if (host === "codex") return join(root, `skills/${capabilityName}`);
  if (host === "claude") {
    const manifest = JSON.parse(await readFile(join(root, ".claude-plugin/plugin.json"), "utf8"));
    if (manifest.skills !== "./skills/")
      throw new Error("Claude manifest does not resolve the canonical skills directory");
    return join(root, manifest.skills, capabilityName);
  }
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (
    JSON.stringify(manifest.pi?.skills) !==
    JSON.stringify(["./plugin/skills/copy", "./plugin/skills/prd", "./plugin/skills/spec"])
  )
    throw new Error("Pi manifest does not resolve the canonical skills in registry order");
  const skillRoot = manifest.pi.skills.find((path) => path.endsWith(`/skills/${capabilityName}`));
  if (!skillRoot) throw new Error(`Pi manifest does not resolve the ${capabilityName} skill`);
  return resolve(root, skillRoot);
}

export async function loadAdapterPayloadContract(
  host,
  root,
  canonicalRoot,
  layout,
  capabilityName,
) {
  const payload = await resolvedPayload(host, root, layout, capabilityName);
  const capability = JSON.parse(
    await readFile(join(canonicalRoot, `capabilities/${capabilityName}.json`), "utf8"),
  );
  const canonicalBytes = {};
  for (const [name, resource] of Object.entries(capability.canonical)) {
    const relativePath = relative(`skills/${capabilityName}`, resource.path);
    const [resolvedBytes, sourceBytes] = await Promise.all([
      readFile(join(payload, relativePath)),
      readFile(join(canonicalRoot, resource.path)),
    ]);
    if (!resolvedBytes.equals(sourceBytes) || sha256(resolvedBytes) !== resource.sha256)
      throw new Error(`${host}: resolved canonical ${name} is missing or altered`);
    canonicalBytes[name] = resolvedBytes.toString("hex");
  }

  const skill = await readFile(join(payload, "SKILL.md"), "utf8");
  const boundaryContracts =
    capabilityName === "copy"
      ? [/explicitly agreed files and strings/i, /Change only the agreed copy/i]
      : [
          new RegExp(`edit only the\\s+agreed ${capabilityName.toUpperCase()}`),
          new RegExp(`no file other than the agreed ${capabilityName.toUpperCase()} was changed`),
        ];
  if (boundaryContracts.some((contract) => !contract.test(skill)))
    throw new Error(`${host}: installed ${capabilityName} payload has an invalid write boundary`);
  const hostContract = capability.hosts?.[host];
  if (!hostContract) throw new Error(`${host}: capability host contract is missing`);
  return {
    host,
    layout,
    invocation: hostContract.invocation,
    modes: capability.modes,
    writeBoundary: `agreed-${capabilityName}-only`,
    canonicalBytes,
  };
}
