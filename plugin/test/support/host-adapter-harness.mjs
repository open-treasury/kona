import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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
    if (!/edit:\n\s+"\*": deny\n\s+"\*\.md": allow/.test(adapter) || !/bash: deny/.test(adapter))
      throw new Error("OpenCode adapter does not enforce its documentation-only host boundary");
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
    JSON.stringify(["./plugin/skills/prd", "./plugin/skills/spec"])
  )
    throw new Error(
      "Pi manifest does not resolve the canonical authoring skills in registry order",
    );
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
  for (const [name, relativePath] of [
    ["skill", "SKILL.md"],
    ["template", `templates/${capabilityName}.md`],
  ]) {
    const [resolvedBytes, sourceBytes] = await Promise.all([
      readFile(join(payload, relativePath)),
      readFile(join(canonicalRoot, capability.canonical[name].path)),
    ]);
    if (
      !resolvedBytes.equals(sourceBytes) ||
      sha256(resolvedBytes) !== capability.canonical[name].sha256
    )
      throw new Error(`${host}: resolved canonical ${name} is missing or altered`);
    canonicalBytes[name] = resolvedBytes.toString("hex");
  }

  const skill = await readFile(join(payload, "SKILL.md"), "utf8");
  const document = capabilityName.toUpperCase();
  const pathOrder = [
    /the user's explicit path/,
    new RegExp(`an unambiguous repository convention for ${document}s`),
    new RegExp(`\\\`specs/<feature-slug>/${capabilityName}\\.md\\\``),
  ].map((pattern) => skill.search(pattern));
  if (
    pathOrder.some((index) => index < 0) ||
    pathOrder.some((index, i) => i > 0 && index <= pathOrder[i - 1])
  )
    throw new Error(`${host}: installed payload has invalid destination precedence`);
  if (!/If it exists[\s\S]*do not overwrite it; ask for confirmation\./.test(skill))
    throw new Error(`${host}: installed payload lacks overwrite protection`);
  if (!/Ask one grouped set of concise questions[\s\S]*Pause/.test(skill))
    throw new Error(`${host}: installed payload lacks material-gap behavior`);
  if (
    !new RegExp(`edit only the\\s+agreed ${document}`).test(skill) ||
    !new RegExp(`no file other than the agreed ${document} was changed`).test(skill)
  )
    throw new Error(`${host}: installed payload permits writes outside the ${document}`);
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
