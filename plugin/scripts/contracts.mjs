import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { CAPABILITY_REGISTRY, validateCapabilityRegistry } from "../lib/capability-registry.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const fail = (message) => {
  throw new Error(message);
};
const requireMatch = (source, pattern, message) => {
  if (!pattern.test(source)) fail(message);
};

async function runtimeText(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const contents = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) contents.push(await runtimeText(path));
    else if (entry.isFile()) contents.push(await readFile(path, "utf8"));
  }
  return contents.join("\n");
}

export async function validateStaticContracts(root) {
  const pluginRoot = join(root, "plugin");
  validateCapabilityRegistry(CAPABILITY_REGISTRY);
  const [capabilities, rootManifest, packageManifest, claudeManifest, marketplace, baseline] =
    await Promise.all([
      Promise.all(CAPABILITY_REGISTRY.map(({ manifest }) => json(join(pluginRoot, manifest)))),
      json(join(root, "package.json")),
      json(join(pluginRoot, "package.json")),
      json(join(pluginRoot, ".claude-plugin/plugin.json")),
      json(join(root, ".claude-plugin/marketplace.json")),
      json(join(pluginRoot, "capabilities/workflow-baseline.json")),
    ]);
  const [resources, lifecycle, launcher, installer] = await Promise.all([
    Promise.all(
      CAPABILITY_REGISTRY.map(async (descriptor) => ({
        skill: await readFile(join(pluginRoot, descriptor.canonical[0]), "utf8"),
        supporting: await Promise.all(
          descriptor.canonical.slice(1).map((path) => readFile(join(pluginRoot, path), "utf8")),
        ),
        adapter: descriptor.adapter
          ? await readFile(join(pluginRoot, descriptor.adapter), "utf8")
          : undefined,
      })),
    ),
    readFile(join(pluginRoot, "lib/plugin-lifecycle.mjs"), "utf8"),
    readFile(join(pluginRoot, "bin/kona.mjs"), "utf8"),
    readFile(join(root, "install.sh"), "utf8"),
  ]);

  const requireUnique = (label, values) => {
    if (new Set(values).size !== values.length) fail(`duplicate ${label}`);
  };
  requireUnique(
    "capability name",
    capabilities.map(({ name }) => name),
  );
  requireUnique(
    "canonical path",
    capabilities.flatMap(({ canonical }) => Object.values(canonical ?? {}).map(({ path }) => path)),
  );
  requireUnique(
    "host invocation",
    capabilities.flatMap(({ hosts }) =>
      Object.values(hosts ?? {}).map(({ invocation }) => invocation),
    ),
  );

  for (const [index, descriptor] of CAPABILITY_REGISTRY.entries()) {
    const capability = capabilities[index];
    if (
      capability.type !== "capability" ||
      capability.schemaVersion !== 1 ||
      capability.name !== descriptor.name
    )
      fail(`capability identity is invalid: ${descriptor.name}`);
    if (!/^\d+\.\d+\.\d+$/.test(capability.version))
      fail(`capability version is not SemVer: ${descriptor.name}`);
    if (
      capability.version !== packageManifest.version ||
      capability.version !== claudeManifest.version ||
      capability.version !== marketplace.plugins?.[0]?.version
    )
      fail(`distribution versions are not aligned: ${descriptor.name}`);
    if (JSON.stringify(capability.modes) !== JSON.stringify(descriptor.modes))
      fail(`capability modes are invalid: ${descriptor.name}`);

    const canonical = Object.values(capability.canonical ?? {});
    if (
      canonical.length !== descriptor.canonical.length ||
      canonical.some(
        (entry, canonicalIndex) =>
          entry.path !== descriptor.canonical[canonicalIndex] || entry.mode !== "0644",
      )
    )
      fail(`canonical manifest paths or modes are invalid: ${descriptor.name}`);
    for (const entry of canonical) {
      const path = join(pluginRoot, entry.path);
      const [bytes, metadata] = await Promise.all([readFile(path), stat(path)]);
      if (entry.sha256 !== sha256(bytes)) fail(`canonical hash drift: ${entry.path}`);
      const actualMode = (metadata.mode & 0o777).toString(8).padStart(4, "0");
      if (actualMode !== entry.mode) fail(`canonical file mode drift: ${entry.path}`);
    }

    if (JSON.stringify(capability.hosts) !== JSON.stringify(descriptor.hosts))
      fail(`host scope or invocation contract drifted: ${descriptor.name}`);
  }

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
    JSON.stringify(rootManifest.pi?.skills) !==
      JSON.stringify(
        CAPABILITY_REGISTRY.map(({ copiedHostDirectory }) => `./plugin/${copiedHostDirectory}`),
      )
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

  for (const [index, descriptor] of CAPABILITY_REGISTRY.entries()) {
    const { skill, adapter } = resources[index];
    requireMatch(
      skill,
      new RegExp(`^---\\nname: ${descriptor.name}\\ndescription: .+`, "im"),
      `skill frontmatter is invalid: ${descriptor.name}`,
    );
    if (descriptor.kind === "authoring")
      requireMatch(
        skill,
        /description: .*create or refine/im,
        `authoring skill description is invalid: ${descriptor.name}`,
      );
    if (adapter) {
      if (adapter.split("\n").length >= 15)
        fail(`OpenCode adapter is not thin: ${descriptor.name}`);
      const permissionContracts =
        descriptor.name === "copy"
          ? [/edit: ask/, /bash: ask/, /webfetch: deny/]
          : [/"\*": deny[\s\S]*"\*\.md": allow/, /bash: deny/];
      for (const contract of [
        /mode: subagent/,
        ...permissionContracts,
        new RegExp("Use the `" + descriptor.name + "` skill for the complete procedure\\."),
      ])
        requireMatch(
          adapter,
          contract,
          `OpenCode adapter contract is missing for ${descriptor.name}: ${contract}`,
        );
    }
  }

  const issuesSkill = resources.find(
    (_, index) => CAPABILITY_REGISTRY[index].name === "issues",
  )?.skill;
  if (!issuesSkill) fail("issues runtime skill is missing");
  for (const contract of [
    /sole todo and task\s+tracker/i,
    /reuse an existing issue or create one/i,
    /substantial feature[\s\S]*epic[\s\S]*child issues/i,
    /ready work contains only genuinely[\s\S]*actionable issues/i,
    /Claim or mark it active before substantive implementation/i,
    /Close only when the criteria pass/i,
    /If `br` is unavailable[\s\S]*ask for explicit confirmation/i,
    /not\s+initialized[\s\S]*explicit confirmation[\s\S]*`br init`/i,
    /Never invoke, install, recommend, or fall back[\s\S]*`bd`/i,
    /Never install,[\s\S]*depend on Dolt/i,
    /future Kona backend can replace `br`/i,
  ])
    requireMatch(issuesSkill, contract, `issues workflow contract is missing: ${contract}`);
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
    if (issuesSkill.includes(forbidden))
      fail(`issues runtime has a destination repository assumption: ${forbidden}`);
  if (/(?:^|\n)\s*(?:\$\s*)?bd\s+\w+/m.test(issuesSkill))
    fail("issues runtime contains an executable bd command");
  if (/(?:^|\n)\s*(?:\$\s*)?dolt\s+\w+/im.test(issuesSkill))
    fail("issues runtime contains an executable Dolt command");

  const { skill, supporting, adapter } = resources.find(
    (_, index) => CAPABILITY_REGISTRY[index].name === "prd",
  );
  const [template] = supporting;
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

  for (const heading of ["TL;DR", "Motivation", "User Stories", "Definition of Done"])
    if (adapter.includes(heading)) fail("OpenCode adapter duplicates the canonical procedure");

  const canonicalText = resources
    .flatMap(
      ({ skill: capabilitySkill, supporting: capabilitySupporting, adapter: capabilityAdapter }) =>
        [capabilitySkill].concat(capabilitySupporting, capabilityAdapter ?? ""),
    )
    .join("\n");
  const recursiveRuntimeText = (
    await Promise.all([
      runtimeText(join(pluginRoot, "skills")),
      runtimeText(join(pluginRoot, "hosts")),
      runtimeText(join(pluginRoot, "lib")),
      runtimeText(join(pluginRoot, "bin")),
      runtimeText(join(root, ".opencode/skills")),
      runtimeText(join(root, ".opencode/agents")),
    ])
  ).join("\n");
  if (/guidelines[\\/]/i.test(recursiveRuntimeText))
    fail("runtime has forbidden dependency: guidelines/");
  for (const forbidden of [
    "guidelines/docs/prd.md",
    "docs/agent-toolkit/",
    "docs/pm/",
    "docs/compliance/",
    "writing-prds",
    "write-prd",
  ])
    if (canonicalText.includes(forbidden)) fail(`runtime has forbidden dependency: ${forbidden}`);
  for (const source of [canonicalText, lifecycle, launcher]) {
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

  if (baseline.type !== "workflow-baseline" || baseline.schemaVersion !== 1)
    fail("workflow baseline schema is invalid");
  for (const [path, expected] of Object.entries(baseline.files ?? {})) {
    if (sha256(await readFile(join(pluginRoot, path))) !== expected)
      fail(`existing workflow behavior drifted: ${path}`);
  }

  if (installer.includes("sudo")) fail("installer must not use sudo");
  if (/\.(?:bashrc|zshrc|profile)|\/etc\//.test(installer))
    fail("installer must not edit startup or system configuration");
  return {
    capabilityVersion: capabilities[0].version,
    capabilities: capabilities.map(({ name }) => name),
    hosts: Object.keys(CAPABILITY_REGISTRY[0].hosts),
  };
}
