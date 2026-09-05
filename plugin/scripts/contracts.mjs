import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const fail = (message) => {
  throw new Error(message);
};
const requireMatch = (source, pattern, message) => {
  if (!pattern.test(source)) fail(message);
};

export async function validateStaticContracts(root) {
  const pluginRoot = join(root, "plugin");
  const [capability, rootManifest, packageManifest, claudeManifest, marketplace, baseline] =
    await Promise.all([
      json(join(pluginRoot, "capabilities/prd.json")),
      json(join(root, "package.json")),
      json(join(pluginRoot, "package.json")),
      json(join(pluginRoot, ".claude-plugin/plugin.json")),
      json(join(root, ".claude-plugin/marketplace.json")),
      json(join(pluginRoot, "capabilities/workflow-baseline.json")),
    ]);
  const [skill, template, adapter, lifecycle, launcher, installer] = await Promise.all([
    readFile(join(pluginRoot, "skills/prd/SKILL.md"), "utf8"),
    readFile(join(pluginRoot, "skills/prd/templates/prd.md"), "utf8"),
    readFile(join(pluginRoot, "hosts/opencode/agents/prd-writer.md"), "utf8"),
    readFile(join(pluginRoot, "lib/plugin-lifecycle.mjs"), "utf8"),
    readFile(join(pluginRoot, "bin/kona.mjs"), "utf8"),
    readFile(join(root, "install.sh"), "utf8"),
  ]);

  if (capability.schemaVersion !== 1 || capability.name !== "prd")
    fail("capability identity is invalid");
  if (!/^\d+\.\d+\.\d+$/.test(capability.version)) fail("capability version is not SemVer");
  if (
    capability.version !== packageManifest.version ||
    capability.version !== claudeManifest.version ||
    capability.version !== marketplace.plugins?.[0]?.version
  )
    fail("distribution versions are not aligned");
  if (JSON.stringify(capability.modes) !== JSON.stringify(["create", "refine"]))
    fail("capability modes must be create and refine");

  const canonicalPaths = ["skills/prd/SKILL.md", "skills/prd/templates/prd.md"];
  const canonical = Object.values(capability.canonical ?? {});
  if (
    canonical.length !== canonicalPaths.length ||
    canonical.some((entry, index) => entry.path !== canonicalPaths[index] || entry.mode !== "0644")
  )
    fail("canonical manifest paths or modes are invalid");
  for (const entry of canonical) {
    const bytes = await readFile(join(pluginRoot, entry.path));
    if (entry.sha256 !== sha256(bytes)) fail(`canonical hash drift: ${entry.path}`);
  }

  const hosts = {
    opencode: { scopes: ["project", "user"], invocation: "@prd-writer" },
    codex: { scopes: ["project", "user"], invocation: "$prd" },
    claude: { scopes: ["project", "local", "user"], invocation: "/kona:prd" },
    pi: { scopes: ["project", "user"], invocation: "/skill:prd" },
  };
  if (JSON.stringify(capability.hosts) !== JSON.stringify(hosts))
    fail("host scope or invocation contract drifted");

  if (
    packageManifest.name !== "@open-treasury/kona-unpublished" ||
    packageManifest.private !== true ||
    packageManifest.engines?.node !== ">=20" ||
    JSON.stringify(packageManifest.bin) !== JSON.stringify({ kona: "./bin/kona.mjs" }) ||
    Object.keys(packageManifest.dependencies ?? {}).length !== 0 ||
    packageManifest.pi !== undefined ||
    packageManifest.keywords?.includes("pi-package")
  )
    fail("portable package metadata is invalid");
  if (
    rootManifest.private !== true ||
    !rootManifest.keywords?.includes("pi-package") ||
    JSON.stringify(rootManifest.pi?.skills) !== JSON.stringify(["./plugin/skills/prd"])
  )
    fail("root Pi package metadata is invalid");
  if (claudeManifest.skills !== "./skills/" || claudeManifest.hooks !== "./hooks/hooks.json")
    fail("Claude workflow discovery regressed");
  if (
    marketplace.name !== "kona" ||
    marketplace.owner?.url !== "https://github.com/open-treasury/kona" ||
    marketplace.plugins?.length !== 1 ||
    marketplace.plugins[0]?.name !== "kona" ||
    marketplace.plugins[0]?.source !== "./plugin"
  )
    fail("Claude marketplace identity is invalid");

  requireMatch(
    skill,
    /^---\nname: prd\ndescription: .*create or refine/im,
    "skill frontmatter is invalid",
  );
  for (const contract of [
    /explicit path[\s\S]*repository convention[\s\S]*specs\/<feature-slug>\/prd\.md/i,
    /one grouped set of concise questions/i,
    /preserve unaffected confirmed decisions/i,
    /edit only the agreed PRD/i,
    /PRD authoring is offline[\s\S]*do not access the network/i,
    /not application code, schemas,[\s\S]*implementation task plan/i,
  ])
    requireMatch(skill, contract, `canonical procedure contract is missing: ${contract}`);
  for (const section of [
    "TL;DR",
    "What",
    "Motivation",
    "User Stories",
    "User Flow",
    "Definition of Done",
    "Out of Scope",
  ])
    if (!template.includes(section)) fail(`canonical template is missing ${section}`);

  if (adapter.split("\n").length >= 15) fail("OpenCode adapter is not thin");
  for (const contract of [
    /mode: subagent/,
    /"\*": deny[\s\S]*"\*\.md": allow/,
    /bash: deny/,
    /Use the `prd` skill for the complete procedure\./,
  ])
    requireMatch(adapter, contract, `OpenCode adapter contract is missing: ${contract}`);
  for (const heading of ["TL;DR", "Motivation", "User Stories", "Definition of Done"])
    if (adapter.includes(heading)) fail("OpenCode adapter duplicates the canonical procedure");

  const canonicalText = `${skill}\n${template}\n${adapter}`;
  for (const forbidden of [
    "guidelines/docs/prd.md",
    "docs/agent-toolkit/",
    "docs/pm/",
    "docs/compliance/",
    "writing-prds",
    "write-prd",
  ])
    if (canonicalText.includes(forbidden)) fail(`runtime has forbidden dependency: ${forbidden}`);
  for (const source of [skill, template, adapter, lifecycle, launcher]) {
    if (/\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/.test(source))
      fail("plugin runtime contains a network client");
  }
  if (/from ["']node:(?:http|https|net|tls|dgram)["']/.test(`${lifecycle}\n${launcher}`))
    fail("plugin runtime imports a network module");

  for (const contract of [
    /assertSafeTarget/,
    /acquireLock/,
    /inspectOwned/,
    /inspectBackups/,
    /beginTransaction/,
    /recover/,
    /--confirm-replace/,
    /ACTIVE_SCOPE/,
  ])
    requireMatch(lifecycle, contract, `ownership or recovery contract is missing: ${contract}`);
  requireMatch(
    launcher,
    /install\|update\|verify\|disable\|enable\|remove/,
    "launcher verbs drifted",
  );

  if (baseline.schemaVersion !== 1) fail("workflow baseline schema is invalid");
  for (const [path, expected] of Object.entries(baseline.files ?? {})) {
    if (sha256(await readFile(join(pluginRoot, path))) !== expected)
      fail(`existing workflow behavior drifted: ${path}`);
  }

  if (installer.includes("sudo")) fail("installer must not use sudo");
  if (/\.(?:bashrc|zshrc|profile)|\/etc\//.test(installer))
    fail("installer must not edit startup or system configuration");
  return { capabilityVersion: capability.version, hosts: Object.keys(hosts) };
}
