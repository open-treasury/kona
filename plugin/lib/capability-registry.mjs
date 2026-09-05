const scopes = {
  opencode: ["project", "user"],
  codex: ["project", "user"],
  claude: ["project", "local", "user"],
  pi: ["project", "user"],
};

const hosts = (name, opencodeInvocation) =>
  Object.fromEntries(
    Object.entries(scopes).map(([host, hostScopes]) => [
      host,
      {
        scopes: hostScopes,
        invocation:
          host === "opencode"
            ? opencodeInvocation
            : host === "codex"
              ? `$${name}`
              : host === "claude"
                ? `/kona:${name}`
                : `/skill:${name}`,
      },
    ]),
  );

const authoringCapability = (name) => ({
  name,
  kind: "authoring",
  modes: ["create", "refine"],
  manifest: `capabilities/${name}.json`,
  canonical: [`skills/${name}/SKILL.md`, `skills/${name}/templates/${name}.md`],
  copiedHostDirectory: `skills/${name}`,
  adapter: `hosts/opencode/agents/${name}-writer.md`,
  hosts: hosts(name, `@${name}-writer`),
});

const copyCapability = {
  name: "copy",
  kind: "copywriting",
  modes: ["generate", "revise", "source-edit"],
  manifest: "capabilities/copy.json",
  canonical: [
    "skills/copy/SKILL.md",
    "skills/copy/references/components.md",
    "skills/copy/references/style-and-safety.md",
  ],
  copiedHostDirectory: "skills/copy",
  adapter: "hosts/opencode/agents/copy-writer.md",
  hosts: hosts("copy", "@copy-writer"),
};

export const CAPABILITY_REGISTRY = [
  copyCapability,
  authoringCapability("prd"),
  authoringCapability("spec"),
];

export function validateCapabilityRegistry(registry) {
  for (const [label, values] of [
    ["capability name", registry.map(({ name }) => name)],
    ["manifest path", registry.map(({ manifest }) => manifest)],
    ["canonical path", registry.flatMap(({ canonical }) => canonical)],
    ["copied-host directory", registry.map(({ copiedHostDirectory }) => copiedHostDirectory)],
    ["adapter path", registry.flatMap(({ adapter }) => (adapter ? [adapter] : []))],
    [
      "host invocation",
      registry.flatMap(({ hosts: capabilityHosts }) =>
        Object.values(capabilityHosts).map(({ invocation }) => invocation),
      ),
    ],
  ]) {
    if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`);
  }

  for (const descriptor of registry) {
    if (!new Set(["authoring", "copywriting"]).has(descriptor.kind))
      throw new Error(`invalid capability kind: ${descriptor.name}`);
    if (!descriptor.adapter || descriptor.canonical.length < 2)
      throw new Error(`invalid capability: ${descriptor.name}`);
  }

  if (JSON.stringify(registry.map(({ name }) => name)) !== JSON.stringify(["copy", "prd", "spec"]))
    throw new Error("capability registry order must be copy, prd, then spec");
}
