import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, lstat, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { CAPABILITY_REGISTRY, validateCapabilityRegistry } from "./capability-registry.mjs";

const VERBS = new Set(["install", "update", "verify", "disable", "enable", "remove"]);
const HOST_SCOPES = {
  opencode: new Set(["project", "user"]),
  codex: new Set(["project", "user"]),
  claude: new Set(["project", "local", "user"]),
  pi: new Set(["project", "user"]),
};
const CLAUDE_MARKETPLACE = "kona";
const CLAUDE_PLUGIN = "kona";
const CLAUDE_SOURCE = "https://github.com/open-treasury/kona";
const PI_SOURCE = "git:github.com/open-treasury/kona";
const SCHEMA = 4;
const LEGACY_SCHEMA = 1;
const RELEASED_SCHEMA = 2;
const PREVIOUS_SCHEMA = 3;
const LEGACY_VERSION = "0.1.1";
const RELEASED_VERSION = "0.2.0";
const PREVIOUS_VERSION = "0.3.0";
const CURRENT_VERSION = "0.4.0";
const BUNDLE = "authoring";
const CAPABILITIES = CAPABILITY_REGISTRY.map(({ name }) => name);
const SCHEMA_CAPABILITIES = new Map([
  [LEGACY_SCHEMA, ["prd"]],
  [RELEASED_SCHEMA, ["prd", "spec"]],
  [PREVIOUS_SCHEMA, ["copy", "prd", "spec"]],
  [SCHEMA, CAPABILITIES],
]);
const SCHEMA_VERSIONS = new Map([
  [LEGACY_SCHEMA, LEGACY_VERSION],
  [RELEASED_SCHEMA, RELEASED_VERSION],
  [PREVIOUS_SCHEMA, PREVIOUS_VERSION],
  [SCHEMA, CURRENT_VERSION],
]);
const MANIFEST = "manifest.json";
const JOURNAL = "journal.json";
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);

class LifecycleError extends Error {
  constructor(code, message, exitCode = 1, details = {}) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const pathExists = async (path) => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const modeOf = (value) => `0${(value & 0o777).toString(8)}`;

async function durableWrite(path, content, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function parseArguments(argv, cwd, env) {
  const verb = argv[0];
  if (!VERBS.has(verb)) {
    throw new LifecycleError(
      "USAGE",
      "expected lifecycle verb: install, update, verify, disable, enable, or remove",
      2,
    );
  }
  const options = { verb, json: false, approve: false, confirmations: [] };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--approve") {
      options.approve = true;
      continue;
    }
    if (
      !["--host", "--scope", "--project-root", "--confirm-replace", "--source"].includes(argument)
    ) {
      throw new LifecycleError("USAGE", `unknown argument: ${argument}`, 2);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--"))
      throw new LifecycleError("USAGE", `missing value for ${argument}`, 2);
    if (argument === "--confirm-replace") options.confirmations.push(value);
    else {
      const key = argument.slice(2).replace("-root", "Root");
      if (options[key] !== undefined)
        throw new LifecycleError("USAGE", `${argument} may be specified only once`, 2);
      options[key] = value;
    }
  }
  if (!options.host || !HOST_SCOPES[options.host])
    throw new LifecycleError("USAGE", "--host must be opencode, codex, claude, or pi", 2);
  if (!options.scope || !HOST_SCOPES[options.host].has(options.scope)) {
    throw new LifecycleError("USAGE", `invalid --scope for ${options.host}`, 2);
  }
  for (const digest of options.confirmations) {
    if (!/^[a-f0-9]{64}$/.test(digest))
      throw new LifecycleError("USAGE", "--confirm-replace requires an exact SHA-256 digest", 2);
  }
  options.home = resolve(env.HOME || homedir());
  options.projectRoot = resolve(options.projectRoot || cwd);
  options.stateRoot = resolve(
    env.KONA_STATE_HOME ||
      join(env.XDG_STATE_HOME || join(options.home, ".local", "state"), "kona"),
  );
  options.sourceRoot = resolve(env.KONA_PLUGIN_ROOT || pluginRoot);
  options.environment = env;
  if (options.source && !["claude", "pi"].includes(options.host))
    throw new LifecycleError("USAGE", "--source is valid only for Claude or Pi", 2);
  if (options.host === "claude") {
    if (options.source && !isAbsolute(options.source))
      throw new LifecycleError("INVALID_SOURCE", "Claude local --source must be absolute", 2);
    options.claudeSource = options.source || CLAUDE_SOURCE;
  }
  return options;
}

function resourcePlan(options, capabilities = CAPABILITY_REGISTRY) {
  const copiedHostRoot =
    options.scope === "project"
      ? options.host === "opencode"
        ? join(options.projectRoot, ".opencode")
        : join(options.projectRoot, ".agents")
      : options.host === "opencode"
        ? join(options.home, ".config", "opencode")
        : join(options.home, ".agents");
  const resources = capabilities.flatMap((capability) =>
    capability.canonical.map((source) => ({
      source: join(options.sourceRoot, source),
      target: join(copiedHostRoot, source),
      mode: "0644",
    })),
  );
  if (options.host === "opencode") {
    resources.push(
      ...capabilities
        .filter(({ adapter }) => adapter)
        .map((capability) => ({
          source: join(options.sourceRoot, capability.adapter),
          target: join(copiedHostRoot, "agents", `${capability.name}-writer.md`),
          mode: "0644",
        })),
    );
  }
  return resources;
}

function descriptorsForSchema(schema) {
  const names = SCHEMA_CAPABILITIES.get(schema);
  if (!names)
    throw new LifecycleError("INVALID_STATE", "ownership manifest schema is unsupported", 4);
  return CAPABILITY_REGISTRY.filter(({ name }) => names.includes(name));
}

function resourcesForManifest(manifest, options) {
  return resourcePlan(options, descriptorsForSchema(manifest.schema));
}

function capabilitiesForResources(resources) {
  return CAPABILITY_REGISTRY.filter(({ name }) =>
    resources.some(({ target }) => target.endsWith(join("skills", name, "SKILL.md"))),
  );
}

function codexConfig(options, resources) {
  if (options.host !== "codex") return null;
  const path = join(options.home, ".codex", "config.toml");
  const skillPaths = capabilitiesForResources(resources)
    .map(({ name }) =>
      resources.find((resource) => resource.target.endsWith(join(name, "SKILL.md"))),
    )
    .map(({ target }) => target);
  const start = `# >>> kona prd ${options.scope}`;
  const end = `# <<< kona prd ${options.scope}`;
  const entries = skillPaths
    .map((skillPath) => `[[skills.config]]\npath = ${JSON.stringify(skillPath)}\nenabled = false`)
    .join("\n");
  const block = `${start}\n${entries}\n${end}\n`;
  return { path, start, end, block };
}

function protectedPaths(options) {
  const hostRoot = join(options.stateRoot, options.host);
  const scopeRoot =
    options.scope === "user"
      ? join(hostRoot, "user")
      : join(hostRoot, "projects", sha256(options.projectRoot), options.scope);
  return {
    hostRoot,
    scopeRoot,
    manifest: join(scopeRoot, MANIFEST),
    journal: join(hostRoot, JOURNAL),
    lock: join(options.stateRoot, `${options.host}.lock`),
  };
}

async function assertProtectedDirectory(path, label) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new LifecycleError("INVALID_STATE", `${label} must be a real directory`, 4);
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new LifecycleError("INVALID_STATE", `${label} is not owned by the current user`, 4);
  if ((info.mode & 0o022) !== 0)
    throw new LifecycleError("INVALID_STATE", `${label} is writable by another user`, 4);
}

async function prepareProtectedState(options) {
  await mkdir(options.stateRoot, { recursive: true, mode: 0o700 });
  await assertProtectedDirectory(options.stateRoot, "Kona state root");
  const paths = protectedPaths(options);
  let cursor = options.stateRoot;
  for (const part of relative(options.stateRoot, paths.scopeRoot).split(sep)) {
    cursor = join(cursor, part);
    if (!(await pathExists(cursor))) break;
    await assertProtectedDirectory(cursor, "Kona protected state ancestor");
  }
}

async function assertProtectedFile(path, label) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0)
    throw new LifecycleError("INVALID_STATE", `${label} permissions are unsafe`, 4);
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new LifecycleError("INVALID_STATE", `${label} is not owned by the current user`, 4);
}

async function assertSafeTarget(path, boundary) {
  const rel = relative(boundary, path);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))
    throw new LifecycleError("UNSAFE_PATH", `target escapes fixed host root: ${path}`, 4);
  let cursor = boundary;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    if (!(await pathExists(cursor))) continue;
    const info = await lstat(cursor);
    if (info.isSymbolicLink())
      throw new LifecycleError(
        "UNSAFE_LINK",
        `symbolic links are not allowed in managed paths: ${cursor}`,
        4,
      );
  }
  if (await pathExists(path)) {
    const info = await lstat(path);
    if (!info.isFile() || (info.mode & 0o022) !== 0)
      throw new LifecycleError(
        "UNSAFE_FILE",
        `managed destination must be a regular, non-writable-by-others file: ${path}`,
        4,
      );
  }
}

function targetBoundary(options) {
  if (options.scope === "project") return options.projectRoot;
  return options.home;
}

async function sourceResources(options, registry = CAPABILITY_REGISTRY) {
  if (registry === CAPABILITY_REGISTRY) validateCapabilityRegistry(registry);
  const capabilities = await Promise.all(
    registry.map(({ manifest }) => readJson(join(options.sourceRoot, manifest))),
  );
  for (const [index, capability] of capabilities.entries()) {
    if (
      capability.schemaVersion !== 1 ||
      capability.name !== registry[index].name ||
      !/^\d+\.\d+\.\d+$/.test(capability.version) ||
      capability.version !== capabilities[0].version
    ) {
      throw new LifecycleError("INVALID_SOURCE", "capability manifest is malformed", 4);
    }
  }
  const resources = resourcePlan(options, registry);
  for (const resource of resources) {
    resource.content = await readFile(resource.source);
    resource.sha256 = sha256(resource.content);
  }
  if (options.host === "opencode") {
    for (const capability of capabilitiesForResources(resources).filter(({ adapter }) => adapter)) {
      const adapter = resources.find((resource) =>
        resource.target.endsWith(`${capability.name}-writer.md`),
      );
      const content = adapter?.content.toString("utf8") || "";
      const permissionContract =
        capability.name === "copy"
          ? /permission:\n  edit: ask\n  bash: ask\n  webfetch: deny\n/
          : /permission:\n  edit:\n    "\*": deny\n    "\*\.md": allow\n  bash: deny\n/;
      const boundaryContract =
        capability.name === "copy"
          ? /Use the `copy` skill/
          : new RegExp(`Edit only the agreed ${capability.name.toUpperCase()}`);
      if (
        !/^---\n[\s\S]*?mode: subagent\n[\s\S]*?---\n/m.test(content) ||
        !permissionContract.test(content) ||
        !new RegExp(`Use the \`${capability.name}\` skill for the complete procedure\\.`).test(
          content,
        ) ||
        !boundaryContract.test(content)
      ) {
        throw new LifecycleError(
          "INVALID_SOURCE",
          `OpenCode ${capability.name} adapter violates its delegated permission or write boundary`,
          4,
        );
      }
    }
  }
  for (const capability of capabilities) {
    for (const entry of Object.values(capability.canonical)) {
      const actual = resources.find(
        (resource) => resource.source === join(options.sourceRoot, entry.path),
      );
      if (!actual || actual.sha256 !== entry.sha256 || actual.mode !== entry.mode) {
        throw new LifecycleError(
          "INVALID_SOURCE",
          `canonical source does not match capability manifest: ${entry.path}`,
          4,
        );
      }
    }
  }
  return { capability: capabilities[0], resources };
}

async function verifyOpenCodeDiscovery(options, resources, enabled = true) {
  try {
    const commandOptions = {
      cwd: options.projectRoot,
      env: options.environment,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    };
    // OpenCode opens a per-home database even for discovery; serialize reads to avoid lock races.
    const { stdout: agents } = await execute("opencode", ["agent", "list"], commandOptions);
    const { stdout: skillsOutput } = await execute("opencode", ["debug", "skill"], commandOptions);
    const skills = JSON.parse(skillsOutput);
    for (const capability of capabilitiesForResources(resources)) {
      if (capability.adapter) {
        const agentDiscovered = new RegExp(`^${capability.name}-writer \\(subagent\\)$`, "m").test(
          agents,
        );
        if (agentDiscovered !== enabled)
          throw new LifecycleError(
            "DISCOVERY_FAILED",
            `OpenCode reported the ${capability.name}-writer subagent as ${agentDiscovered ? "enabled" : "disabled"}`,
            4,
          );
      }
      const skillPath = resources.find((resource) =>
        resource.target.endsWith(join(capability.name, "SKILL.md")),
      )?.target;
      const expectedSkillPath = await realpath(skillPath).catch(() => resolve(skillPath));
      let discovered = null;
      for (const skill of Array.isArray(skills) ? skills : []) {
        if (skill?.name !== capability.name || typeof skill.location !== "string") continue;
        const location = await realpath(skill.location).catch(() => resolve(skill.location));
        if (location === expectedSkillPath) {
          discovered = skill;
          break;
        }
      }
      if (Boolean(discovered) !== enabled)
        throw new LifecycleError(
          "DISCOVERY_FAILED",
          `OpenCode reported the canonical ${capability.name.toUpperCase()} skill as ${discovered ? "enabled" : "disabled"}`,
          4,
        );
    }
    return {
      static: true,
      native: "verified",
      invocation: capabilitiesForResources(resources)[0].hosts.opencode.invocation,
      invocations: Object.fromEntries(
        capabilitiesForResources(resources).map(({ name, hosts }) => [
          name,
          hosts.opencode.invocation,
        ]),
      ),
    };
  } catch (error) {
    if (error.code === "ENOENT")
      throw new LifecycleError("HOST_UNAVAILABLE", "OpenCode CLI is not available on PATH", 4);
    if (error instanceof LifecycleError) throw error;
    throw new LifecycleError(
      "DISCOVERY_FAILED",
      `OpenCode native discovery failed: ${error.message || String(error)}`,
      4,
    );
  }
}

async function codexSkillsList(options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      cwd: options.projectRoot,
      env: options.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let output = "";
    let errors = "";
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      if (error) reject(error);
      else resolvePromise(result);
    };
    const timeout = setTimeout(
      () => finish(new Error("Codex app-server discovery timed out")),
      10_000,
    );
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (!settled)
        finish(new Error(`Codex app-server exited before discovery (${code}): ${errors.trim()}`));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      while (output.includes("\n")) {
        const newline = output.indexOf("\n");
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(new Error("Codex app-server returned invalid JSON"));
          return;
        }
        if (message.id === 1) {
          if (message.error) {
            finish(new Error(message.error.message || "Codex initialization failed"));
            return;
          }
          child.stdin.write(
            `${JSON.stringify({ method: "initialized" })}\n${JSON.stringify({
              method: "skills/list",
              id: 2,
              params: { cwds: [options.projectRoot], forceReload: true },
            })}\n`,
          );
        } else if (message.id === 2) {
          if (message.error) finish(new Error(message.error.message || "Codex skills/list failed"));
          else finish(null, message.result);
          return;
        }
      }
    });
    child.stdin.on("error", (error) => finish(error));
    child.stdin.write(
      `${JSON.stringify({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: { name: "kona", title: "Kona lifecycle verifier", version: CURRENT_VERSION },
        },
      })}\n`,
    );
  });
}

async function verifyCodexDiscovery(options, resources, enabled) {
  try {
    const result = await codexSkillsList(options);
    const expectedCwd = await realpath(options.projectRoot);
    for (const capability of capabilitiesForResources(resources)) {
      const skillPath = resources.find((resource) =>
        resource.target.endsWith(join(capability.name, "SKILL.md")),
      )?.target;
      const expectedSkillPath = await realpath(skillPath);
      let discovered = null;
      for (const entry of Array.isArray(result?.data) ? result.data : []) {
        if ((await realpath(entry.cwd).catch(() => resolve(entry.cwd))) !== expectedCwd) continue;
        for (const skill of Array.isArray(entry.skills) ? entry.skills : []) {
          if (
            skill?.name === capability.name &&
            (await realpath(skill.path).catch(() => resolve(skill.path))) === expectedSkillPath
          ) {
            discovered = skill;
            break;
          }
        }
      }
      if (!discovered || discovered.enabled !== enabled)
        throw new LifecycleError(
          "DISCOVERY_FAILED",
          `Codex did not discover ${capability.hosts.codex.invocation} as ${enabled ? "enabled" : "disabled"} at the selected scope`,
          4,
        );
    }
    return {
      static: true,
      native: "verified",
      invocation: capabilitiesForResources(resources)[0].hosts.codex.invocation,
      invocations: Object.fromEntries(
        capabilitiesForResources(resources).map(({ name, hosts }) => [
          name,
          hosts.codex.invocation,
        ]),
      ),
    };
  } catch (error) {
    if (error.code === "ENOENT")
      throw new LifecycleError("HOST_UNAVAILABLE", "Codex CLI is not available on PATH", 4);
    if (error instanceof LifecycleError) throw error;
    throw new LifecycleError(
      "DISCOVERY_FAILED",
      `Codex native discovery failed: ${error.message || String(error)}`,
      4,
    );
  }
}

function validateManifest(manifest, options, resources) {
  if (!manifest || !SCHEMA_CAPABILITIES.has(manifest.schema))
    throw new LifecycleError("INVALID_STATE", "ownership manifest is malformed", 4);
  if (manifest.version !== SCHEMA_VERSIONS.get(manifest.schema))
    throw new LifecycleError("INVALID_STATE", "ownership manifest version is invalid", 4);
  if (manifest.schema === LEGACY_SCHEMA && manifest.capability !== "prd")
    throw new LifecycleError("INVALID_STATE", "legacy ownership manifest is malformed", 4);
  if (
    manifest.schema !== LEGACY_SCHEMA &&
    (manifest.bundle !== BUNDLE ||
      JSON.stringify(manifest.capabilities) !==
        JSON.stringify(SCHEMA_CAPABILITIES.get(manifest.schema)))
  )
    throw new LifecycleError("INVALID_STATE", "ownership bundle identity is invalid", 4);
  if (
    manifest.host !== options.host ||
    manifest.scope !== options.scope ||
    (options.scope === "project" &&
      (typeof manifest.projectRoot !== "string" ||
        resolve(manifest.projectRoot) !== options.projectRoot)) ||
    !["active", "disabled"].includes(manifest.state)
  ) {
    throw new LifecycleError("INVALID_STATE", "ownership manifest identity is invalid", 4);
  }
  const expected = resources.map((resource) => resource.target);
  if (JSON.stringify(manifest.paths) !== JSON.stringify(expected))
    throw new LifecycleError(
      "INVALID_STATE",
      "ownership manifest contains paths outside the fixed allowlist",
      4,
    );
  if (
    !Array.isArray(manifest.resources) ||
    manifest.resources.length !== resources.length ||
    !manifest.resources.every(
      (item, index) =>
        item.path === expected[index] && /^[a-f0-9]{64}$/.test(item.sha256) && item.mode === "0644",
    )
  ) {
    throw new LifecycleError("INVALID_STATE", "ownership resource records are invalid", 4);
  }
  if (!Array.isArray(manifest.backups))
    throw new LifecycleError("INVALID_STATE", "ownership backup records are invalid", 4);
  const backupRoot = join(protectedPaths(options).scopeRoot, "backups");
  const backupPaths = new Set();
  for (const backup of manifest.backups) {
    const expectedBackup =
      typeof backup.path === "string" && typeof backup.sha256 === "string"
        ? join(backupRoot, `${sha256(backup.path)}-${backup.sha256}`)
        : "";
    if (
      !expected.includes(backup.path) ||
      !/^[a-f0-9]{64}$/.test(backup.sha256) ||
      !/^0[0-7]{3}$/.test(backup.mode) ||
      backup.backup !== expectedBackup ||
      backupPaths.has(backup.path)
    )
      throw new LifecycleError("INVALID_STATE", "ownership backup records are invalid", 4);
    backupPaths.add(backup.path);
  }
  const config = codexConfig(options, resources);
  if (
    manifest.host === "codex" &&
    manifest.state === "disabled" &&
    (manifest.managedConfig?.path !== config.path ||
      ![config.block, `\n${config.block}`].includes(manifest.managedConfig?.block) ||
      typeof manifest.managedConfig?.created !== "boolean" ||
      !/^0[0-7]{3}$/.test(manifest.managedConfig?.mode) ||
      (manifest.managedConfig.created && manifest.managedConfig.block !== config.block))
  )
    throw new LifecycleError("INVALID_STATE", "managed Codex configuration record is invalid", 4);
  if ((manifest.host !== "codex" || manifest.state === "active") && manifest.managedConfig != null)
    throw new LifecycleError("INVALID_STATE", "unexpected managed configuration record", 4);
}

async function readManifest(options) {
  const paths = protectedPaths(options);
  if (!(await pathExists(paths.manifest))) return null;
  await assertProtectedFile(paths.manifest, "ownership manifest");
  const manifest = await readJson(paths.manifest).catch(() => {
    throw new LifecycleError("INVALID_STATE", "ownership manifest is unreadable", 4);
  });
  validateManifest(manifest, options, resourcesForManifest(manifest, options));
  return manifest;
}

async function inspectOwned(manifest) {
  for (const resource of manifest.resources) {
    if (!(await pathExists(resource.path)))
      throw new LifecycleError("DRIFT", `owned resource is missing: ${resource.path}`, 4);
    const info = await lstat(resource.path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      modeOf(info.mode) !== resource.mode ||
      sha256(await readFile(resource.path)) !== resource.sha256
    ) {
      throw new LifecycleError("DRIFT", `owned resource has changed: ${resource.path}`, 4);
    }
  }
}

async function inspectBackups(manifest) {
  for (const backup of manifest.backups) {
    const info = await lstat(backup.backup).catch(() => null);
    if (
      !info?.isFile() ||
      info.isSymbolicLink() ||
      sha256(await readFile(backup.backup)) !== backup.sha256
    ) {
      throw new LifecycleError(
        "BACKUP_DRIFT",
        `replacement backup cannot be verified: ${backup.backup}`,
        4,
      );
    }
  }
}

async function inspectDisabled(manifest, options, resources) {
  await inspectBackups(manifest);
  if (manifest.host === "codex") {
    await inspectOwned(manifest);
    const config = codexConfig(options, resources);
    await assertSafeTarget(config.path, options.home);
    const content = await readFile(config.path, "utf8").catch(() => null);
    const block = manifest.managedConfig.block;
    const first = content?.indexOf(block) ?? -1;
    if (first < 0 || content.indexOf(block, first + 1) >= 0)
      throw new LifecycleError("DRIFT", "Kona's bounded Codex configuration block has changed", 4);
    return;
  }
  for (const resource of manifest.resources) {
    const backup = manifest.backups.find((item) => item.path === resource.path);
    if (backup) {
      const info = await lstat(resource.path).catch(() => null);
      if (
        !info?.isFile() ||
        info.isSymbolicLink() ||
        modeOf(info.mode) !== backup.mode ||
        sha256(await readFile(resource.path)) !== backup.sha256
      )
        throw new LifecycleError("DRIFT", `restored replacement has changed: ${resource.path}`, 4);
    } else if (await pathExists(resource.path)) {
      throw new LifecycleError("DRIFT", `disabled managed path is occupied: ${resource.path}`, 4);
    }
  }
}

async function acquireLock(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(path, { mode: 0o700, recursive: false });
      await durableWrite(
        join(path, "owner.json"),
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      );
      return async () => rm(path, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EEXIST") {
        await rm(path, { recursive: true, force: true });
        throw error;
      }
      await assertProtectedDirectory(path, "host lock");
      await assertProtectedFile(join(path, "owner.json"), "host lock owner").catch(() => {
        throw new LifecycleError("LOCKED", "host lock owner cannot be verified");
      });
      const owner = await readJson(join(path, "owner.json")).catch(() => null);
      if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0)
        throw new LifecycleError("LOCKED", "host lock owner cannot be verified");
      try {
        process.kill(owner.pid, 0);
        throw new LifecycleError("LOCKED", "another lifecycle operation holds the host lock");
      } catch (lockError) {
        if (lockError instanceof LifecycleError || lockError.code !== "ESRCH") throw lockError;
      }
      await rm(path, { recursive: true, force: true });
    }
  }
  throw new LifecycleError("LOCKED", "host lock could not be acquired");
}

async function snapshot(path, transactionRoot, index) {
  if (!(await pathExists(path))) return { path, exists: false };
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new LifecycleError("UNSAFE_FILE", `cannot transact non-regular file: ${path}`, 4);
  const content = await readFile(path);
  const backup = join(transactionRoot, `${index}.preimage`);
  await durableWrite(backup, content, info.mode & 0o777);
  return { path, exists: true, backup, sha256: sha256(content), mode: modeOf(info.mode) };
}

async function beginTransaction(paths, affected, options) {
  const root = join(paths.hostRoot, `transaction-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const preimages = [];
  for (let index = 0; index < affected.length; index += 1)
    preimages.push(await snapshot(affected[index], root, index));
  const journal = {
    schema: SCHEMA,
    host: options.host,
    scope: options.scope,
    projectRoot: options.scope === "project" ? options.projectRoot : undefined,
    root,
    preimages,
  };
  await durableWrite(paths.journal, `${JSON.stringify(journal, null, 2)}\n`);
  return journal;
}

async function recover(paths, options) {
  if (!(await pathExists(paths.journal))) return false;
  await assertProtectedFile(paths.journal, "transaction journal").catch((error) => {
    throw new LifecycleError("RECOVERY_PARTIAL", error.message, 4);
  });
  const journal = await readJson(paths.journal).catch(() => {
    throw new LifecycleError("RECOVERY_PARTIAL", "transaction journal is unreadable", 4);
  });
  if (
    !SCHEMA_CAPABILITIES.has(journal.schema) ||
    journal.host !== options.host ||
    !HOST_SCOPES[options.host].has(journal.scope) ||
    (journal.scope === "project" && typeof journal.projectRoot !== "string") ||
    !Array.isArray(journal.preimages) ||
    dirname(journal.root) !== paths.hostRoot ||
    !journal.root.startsWith(join(paths.hostRoot, "transaction-"))
  )
    throw new LifecycleError("RECOVERY_PARTIAL", "transaction journal is invalid", 4);
  const recoveryOptions = {
    ...options,
    scope: journal.scope,
    projectRoot: journal.projectRoot || options.projectRoot,
  };
  const recoveryPaths = protectedPaths(recoveryOptions);
  if (recoveryPaths.hostRoot !== paths.hostRoot)
    throw new LifecycleError("RECOVERY_PARTIAL", "transaction journal host root is invalid", 4);
  await assertProtectedDirectory(journal.root, "transaction journal directory").catch((error) => {
    throw new LifecycleError("RECOVERY_PARTIAL", error.message, 4);
  });
  const plannedResources = resourcePlan(recoveryOptions);
  const allowed = new Set([
    ...plannedResources.map((resource) => resource.target),
    ...[...SCHEMA_CAPABILITIES.keys()].flatMap((schema) =>
      resourcePlan(recoveryOptions, descriptorsForSchema(schema)).map(
        (resource) => resource.target,
      ),
    ),
    recoveryPaths.manifest,
  ]);
  const recoveryConfig = codexConfig(recoveryOptions, resourcePlan(recoveryOptions));
  if (recoveryConfig) allowed.add(recoveryConfig.path);
  const backupRoot = join(recoveryPaths.scopeRoot, "backups");
  for (const preimage of journal.preimages) {
    const backupRelative = relative(backupRoot, preimage.path);
    const isReplacementBackup =
      backupRelative !== "" &&
      !backupRelative.startsWith(`..${sep}`) &&
      backupRelative !== ".." &&
      !isAbsolute(backupRelative);
    const transactionRelative = relative(journal.root, preimage.backup || "");
    if (
      (!allowed.has(preimage.path) && !isReplacementBackup) ||
      (preimage.exists &&
        (transactionRelative.startsWith(`..${sep}`) ||
          transactionRelative === ".." ||
          isAbsolute(transactionRelative)))
    )
      throw new LifecycleError(
        "RECOVERY_PARTIAL",
        "transaction journal contains a path outside the fixed allowlist",
        4,
      );
    if (preimage.exists) {
      await assertProtectedFile(preimage.backup, "transaction preimage").catch((error) => {
        throw new LifecycleError("RECOVERY_PARTIAL", error.message, 4);
      });
      const content = await readFile(preimage.backup).catch(() => null);
      if (!content || sha256(content) !== preimage.sha256)
        throw new LifecycleError(
          "RECOVERY_PARTIAL",
          "transaction preimage cannot be verified; evidence retained",
          4,
        );
    }
  }
  for (const preimage of journal.preimages) {
    if (preimage.exists) {
      await durableWrite(
        preimage.path,
        await readFile(preimage.backup),
        Number.parseInt(preimage.mode, 8),
      );
      await chmod(preimage.path, Number.parseInt(preimage.mode, 8));
    } else {
      await rm(preimage.path, { force: true });
    }
  }
  await rm(paths.journal, { force: true });
  await rm(journal.root, { recursive: true, force: true });
  return true;
}

async function commit(paths, journal) {
  await rm(paths.journal, { force: true });
  await rm(journal.root, { recursive: true, force: true });
}

async function writeResource(resource) {
  await durableWrite(resource.target, resource.content, 0o644);
  await chmod(resource.target, 0o644);
}

async function addCodexBlock(config) {
  await assertSafeTarget(config.path, dirname(dirname(config.path)));
  const exists = await pathExists(config.path);
  const content = exists ? await readFile(config.path, "utf8") : "";
  if (content.includes(config.start) || content.includes(config.end))
    throw new LifecycleError(
      "CONFIG_CONFLICT",
      "an unowned Kona Codex configuration marker already exists",
      4,
    );
  const mode = exists ? modeOf((await stat(config.path)).mode) : "0600";
  const block = content === "" || content.endsWith("\n") ? config.block : `\n${config.block}`;
  await durableWrite(config.path, `${content}${block}`, Number.parseInt(mode, 8));
  await chmod(config.path, Number.parseInt(mode, 8));
  return { path: config.path, block, created: !exists, mode };
}

async function removeCodexBlock(managedConfig) {
  const content = await readFile(managedConfig.path, "utf8");
  const first = content.indexOf(managedConfig.block);
  if (first < 0 || content.indexOf(managedConfig.block, first + 1) >= 0)
    throw new LifecycleError("DRIFT", "Kona's bounded Codex configuration block has changed", 4);
  const next = content.slice(0, first) + content.slice(first + managedConfig.block.length);
  if (managedConfig.created && next === "") await rm(managedConfig.path, { force: true });
  else {
    await durableWrite(managedConfig.path, next, Number.parseInt(managedConfig.mode, 8));
    await chmod(managedConfig.path, Number.parseInt(managedConfig.mode, 8));
  }
}

async function activeOtherScope(options) {
  for (const scope of HOST_SCOPES[options.host]) {
    if (scope === options.scope) continue;
    const otherOptions = { ...options, scope };
    const path = protectedPaths(otherOptions).manifest;
    if (!(await pathExists(path))) {
      if (options.host === "codex" || options.host === "opencode") {
        const unowned = resourcePlan(otherOptions).filter(
          (resource) =>
            resource.target.endsWith("SKILL.md") || resource.target.endsWith("-writer.md"),
        );
        const occupied = [];
        for (const resource of unowned)
          if (await pathExists(resource.target)) occupied.push(resource.target);
        if (occupied.length)
          throw new LifecycleError(
            "CROSS_SCOPE_AMBIGUITY",
            `unowned ${options.host} authoring installation exists at ${scope} scope`,
            4,
            { conflictingScope: scope, paths: occupied },
          );
      }
      continue;
    }
    await assertProtectedFile(path, `${scope} ownership`);
    const other = await readJson(path).catch(() => {
      throw new LifecycleError("INVALID_STATE", `cannot inspect ${scope} ownership`, 4);
    });
    const otherResources = resourcesForManifest(other, otherOptions);
    validateManifest(other, otherOptions, otherResources);
    if (options.host === "codex" || options.host === "opencode") {
      if (other.state === "active") await inspectOwned(other);
      else await inspectDisabled(other, otherOptions, otherResources);
    }
    if (other.state === "active") return scope;
  }
  return null;
}

function nativeClaudeManifest(options, version, state = "active") {
  return {
    schema: SCHEMA,
    bundle: BUNDLE,
    capabilities: CAPABILITIES,
    version,
    host: "claude",
    scope: options.scope,
    state,
    projectRoot:
      options.scope === "project" || options.scope === "local" ? options.projectRoot : undefined,
    nativeIdentity: {
      plugin: CLAUDE_PLUGIN,
      marketplace: CLAUDE_MARKETPLACE,
      source: options.claudeSource,
      invocation: CAPABILITY_REGISTRY[0].hosts.claude.invocation,
    },
  };
}

function nativeCapabilities(manifest) {
  return manifest ? SCHEMA_CAPABILITIES.get(manifest.schema) || [] : CAPABILITIES;
}

function nativeDiscovery(host, capabilities) {
  const invocations = Object.fromEntries(
    CAPABILITY_REGISTRY.filter(({ name }) => capabilities.includes(name)).map(({ name, hosts }) => [
      name,
      hosts[host].invocation,
    ]),
  );
  return {
    static: true,
    native: "verified",
    invocation: CAPABILITY_REGISTRY.find(({ name }) => capabilities.includes(name)).hosts[host]
      .invocation,
    invocations,
    capabilities: capabilities.map((name) => ({
      id: name,
      invocation: invocations[name],
      integrity: { canonical: "verified", native: "verified" },
    })),
  };
}

function validateClaudeManifest(manifest, options) {
  const legacy = manifest?.schema === LEGACY_SCHEMA;
  if (
    !manifest ||
    !SCHEMA_CAPABILITIES.has(manifest.schema) ||
    manifest.version !== SCHEMA_VERSIONS.get(manifest.schema) ||
    (legacy
      ? manifest.capability !== "prd"
      : manifest.bundle !== BUNDLE ||
        JSON.stringify(manifest.capabilities) !==
          JSON.stringify(SCHEMA_CAPABILITIES.get(manifest.schema))) ||
    manifest.host !== "claude" ||
    manifest.scope !== options.scope ||
    !["active", "disabled"].includes(manifest.state) ||
    manifest.nativeIdentity?.plugin !== CLAUDE_PLUGIN ||
    manifest.nativeIdentity?.marketplace !== CLAUDE_MARKETPLACE ||
    (manifest.nativeIdentity?.source !== CLAUDE_SOURCE &&
      !isAbsolute(manifest.nativeIdentity?.source || "")) ||
    (options.source && manifest.nativeIdentity?.source !== options.claudeSource) ||
    manifest.nativeIdentity?.invocation !==
      CAPABILITY_REGISTRY.find(({ name }) => nativeCapabilities(manifest).includes(name))?.hosts
        .claude.invocation ||
    ((options.scope === "project" || options.scope === "local") &&
      (typeof manifest.projectRoot !== "string" ||
        resolve(manifest.projectRoot) !== options.projectRoot))
  ) {
    throw new LifecycleError("INVALID_STATE", "Claude ownership manifest is malformed", 4);
  }
}

async function readClaudeManifest(options) {
  const path = protectedPaths(options).manifest;
  if (!(await pathExists(path))) return null;
  await assertProtectedFile(path, "Claude ownership manifest");
  const manifest = await readJson(path).catch(() => {
    throw new LifecycleError("INVALID_STATE", "Claude ownership manifest is unreadable", 4);
  });
  validateClaudeManifest(manifest, options);
  return manifest;
}

async function runClaude(options, args) {
  try {
    return await execute("claude", args, {
      cwd: options.projectRoot,
      env: options.environment,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    if (error.code === "ENOENT")
      throw new LifecycleError("HOST_UNAVAILABLE", "Claude Code CLI is not available on PATH", 4);
    throw new LifecycleError(
      "NATIVE_COMMAND_FAILED",
      `claude ${args.join(" ")} failed: ${(error.stderr || error.message || String(error)).trim()}`,
      4,
      { command: ["claude", ...args] },
    );
  }
}

async function claudeJson(options, args, label) {
  const { stdout } = await runClaude(options, args);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new LifecycleError("DISCOVERY_FAILED", `Claude ${label} returned invalid JSON`, 4);
  }
}

function normalizedClaudeSource(value) {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .replace(/\.git\/?$/i, "")
    .replace(/\/$/, "");
  if (/^git@github\.com:/i.test(normalized))
    return `https://github.com/${normalized.slice(normalized.indexOf(":") + 1).toLowerCase()}`;
  if (/^github\.com\//i.test(normalized)) return `https://${normalized.toLowerCase()}`;
  if (/^[^/:]+\/[^/]+$/.test(normalized)) return `https://github.com/${normalized.toLowerCase()}`;
  try {
    const url = new URL(normalized);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return `https://github.com${url.pathname.toLowerCase()}`;
  } catch {
    return null;
  }
}

function marketplaceHasApprovedSource(entry, expectedSource) {
  const source = entry?.source;
  const candidates = [];
  const discriminators = [];
  const add = (present, value) => {
    if (present) candidates.push(value);
  };
  if (typeof source === "string") {
    if (["github", "directory", "local"].includes(source)) discriminators.push(source);
    else candidates.push(source);
  }
  add(source && Object.hasOwn(source, "url"), source?.url);
  add(source && Object.hasOwn(source, "repo"), source?.repo);
  add(Object.hasOwn(entry ?? {}, "url"), entry?.url);
  add(Object.hasOwn(entry ?? {}, "repo"), entry?.repo);
  add(Object.hasOwn(entry ?? {}, "path"), entry?.path);
  add(Object.hasOwn(entry ?? {}, "installLocation"), entry?.installLocation);
  for (const value of [source?.source, source?.type, entry?.type])
    if (value !== undefined) discriminators.push(value);

  if (candidates.length === 0) return false;

  if (isAbsolute(expectedSource)) {
    if (discriminators.some((value) => !["directory", "local"].includes(value))) return false;
    return candidates.every(
      (value) =>
        typeof value === "string" && isAbsolute(value) && resolve(value) === expectedSource,
    );
  }
  if (discriminators.some((value) => value !== "github")) return false;
  return candidates.every((value) => normalizedClaudeSource(value) === expectedSource);
}

function installedClaudePlugins(value) {
  const entries = Array.isArray(value)
    ? value
    : Array.isArray(value?.installed)
      ? value.installed
      : [];
  return entries.filter((entry) => {
    const id = typeof entry?.id === "string" ? entry.id : "";
    const name = typeof entry?.name === "string" ? entry.name : id.split("@")[0];
    return name === CLAUDE_PLUGIN;
  });
}

async function inspectClaude(options) {
  const marketplaces = await claudeJson(
    options,
    ["plugin", "marketplace", "list", "--json"],
    "marketplace listing",
  );
  if (!Array.isArray(marketplaces))
    throw new LifecycleError(
      "DISCOVERY_FAILED",
      "Claude marketplace listing has an unexpected shape",
      4,
    );
  const namedMarketplaces = marketplaces.filter((entry) => entry?.name === CLAUDE_MARKETPLACE);
  if (namedMarketplaces.length > 1)
    throw new LifecycleError(
      "MARKETPLACE_AMBIGUITY",
      "multiple kona marketplace registrations exist; remove duplicates before continuing",
      4,
    );
  if (
    namedMarketplaces.length === 1 &&
    !marketplaceHasApprovedSource(namedMarketplaces[0], options.claudeSource)
  )
    throw new LifecycleError(
      "MARKETPLACE_SOURCE_CONFLICT",
      `marketplace kona is registered from a source other than ${options.claudeSource}`,
      4,
    );

  let catalogue = await claudeJson(
    options,
    ["plugin", "list", "--json", "--available"],
    "plugin listing",
  );
  if (namedMarketplaces.length === 1 && !catalogue?.available?.length) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    catalogue = await claudeJson(
      options,
      ["plugin", "list", "--json", "--available"],
      "plugin listing",
    );
  }
  const installed = installedClaudePlugins(catalogue);
  const available = Array.isArray(catalogue?.available) ? catalogue.available : [];
  const sameName = available.filter((entry) => entry?.name === CLAUDE_PLUGIN);
  if (
    sameName.some(
      (entry) =>
        entry.marketplaceName !== CLAUDE_MARKETPLACE ||
        entry.pluginId !== `${CLAUDE_PLUGIN}@${CLAUDE_MARKETPLACE}`,
    ) ||
    installed.some((entry) => entry.id !== `${CLAUDE_PLUGIN}@${CLAUDE_MARKETPLACE}`)
  ) {
    throw new LifecycleError(
      "PLUGIN_SOURCE_CONFLICT",
      "a kona plugin from a different marketplace is visible; refusing ambiguous unqualified commands",
      4,
    );
  }
  if (namedMarketplaces.length === 1 && sameName.length !== 1 && !isAbsolute(options.claudeSource))
    throw new LifecycleError(
      "PLUGIN_SOURCE_CONFLICT",
      "the kona marketplace must expose exactly one structurally identified kona plugin",
      4,
      { available },
    );
  return {
    marketplaceRegistered: namedMarketplaces.length === 1,
    installed,
    available: sameName,
  };
}

async function sameProject(left, right) {
  const [canonicalLeft, canonicalRight] = await Promise.all([
    realpath(left).catch(() => resolve(left)),
    realpath(right).catch(() => resolve(right)),
  ]);
  return canonicalLeft === canonicalRight;
}

async function claudeAtScope(inspection, options) {
  const matches = [];
  for (const entry of inspection.installed) {
    if (entry.scope !== options.scope) continue;
    if (
      options.scope === "user" ||
      !entry.projectPath ||
      (await sameProject(entry.projectPath, options.projectRoot))
    )
      matches.push(entry);
  }
  if (matches.length > 1)
    throw new LifecycleError(
      "PLUGIN_SOURCE_CONFLICT",
      "Claude reports duplicate Kona installations at the selected scope",
      4,
    );
  return matches[0] || null;
}

async function verifyClaudeCommands(options, installed, manifest) {
  const capabilities = nativeCapabilities(manifest);
  const installPath = installed?.installPath;
  if (typeof installPath !== "string" || !isAbsolute(installPath))
    throw new LifecycleError(
      "DISCOVERY_FAILED",
      "Claude did not report an absolute install path for the managed Kona plugin",
      4,
    );

  const { stdout } = await runClaude(options, [
    "plugin",
    "details",
    `${CLAUDE_PLUGIN}@${CLAUDE_MARKETPLACE}`,
  ]);
  if (!/^\s*Source:\s+kona@kona\s*$/m.test(stdout))
    throw new LifecycleError(
      "DISCOVERY_FAILED",
      "Claude plugin details reported the Kona commands from an unexpected source",
      4,
    );
  const inventory = stdout.match(/^\s*Skills \((\d+)\)\s*(.*)$/m);
  if (!inventory)
    throw new LifecycleError(
      "DISCOVERY_FAILED",
      "Claude plugin details did not report a skill inventory for Kona",
      4,
    );
  const names = inventory[2]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (Number(inventory[1]) !== names.length)
    throw new LifecycleError("DISCOVERY_FAILED", "Claude reported a malformed skill inventory", 4);
  const portableNames = names.filter((name) => CAPABILITIES.includes(name));
  if (
    manifest.schema === SCHEMA &&
    (portableNames.length !== capabilities.length ||
      capabilities.some((name) => !portableNames.includes(name)))
  )
    throw new LifecycleError(
      "DISCOVERY_FAILED",
      "Claude reported a capability inventory that does not match protected Kona state",
      4,
    );

  for (const name of capabilities) {
    const matches = names.filter((candidate) => candidate === name);
    const descriptor = CAPABILITY_REGISTRY.find((candidate) => candidate.name === name);
    const expectedPath = join(installPath, "skills", name, "SKILL.md");
    const validPayload = await Promise.all(
      descriptor.canonical.map(async (path) => {
        const installedPath = join(installPath, path);
        const info = await lstat(installedPath).catch(() => null);
        if (!info?.isFile() || info.isSymbolicLink()) return false;
        const capability = await readJson(join(options.sourceRoot, descriptor.manifest));
        const expected = Object.values(capability.canonical).find((entry) => entry.path === path);
        return expected && sha256(await readFile(installedPath)) === expected.sha256;
      }),
    );
    if (matches.length !== 1 || validPayload.some((valid) => !valid))
      throw new LifecycleError(
        "DISCOVERY_FAILED",
        `Claude did not discover exactly one integrity-verified /kona:${name} command from ${expectedPath}`,
        4,
      );
  }
  return nativeDiscovery("claude", capabilities);
}

async function activeClaudeOtherScope(inspection, options) {
  for (const entry of inspection.installed) {
    if (entry.enabled === false) continue;
    if (entry.scope === "user") {
      if (options.scope !== "user") return entry;
      continue;
    }
    if (!entry.projectPath || !(await sameProject(entry.projectPath, options.projectRoot)))
      continue;
    if (entry.scope !== options.scope) return entry;
  }
  return null;
}

function claudeMutationPlan(options, inspection) {
  const commands = [];
  if (options.verb === "install" && !inspection.marketplaceRegistered)
    commands.push(["claude", "plugin", "marketplace", "add", options.claudeSource]);
  const command =
    options.verb === "remove" ? "uninstall" : options.verb === "install" ? "install" : options.verb;
  commands.push(["claude", "plugin", command, CLAUDE_PLUGIN, "--scope", options.scope]);
  return commands;
}

async function writeClaudeJournal(paths, journal) {
  await durableWrite(paths.journal, `${JSON.stringify(journal, null, 2)}\n`);
}

async function compensateClaude(paths, options, journal) {
  const commands = [];
  for (const step of journal.completed.toReversed()) {
    if (step === "install")
      commands.push(["plugin", "uninstall", CLAUDE_PLUGIN, "--scope", journal.scope]);
    else if (step === "disable")
      commands.push(["plugin", "enable", CLAUDE_PLUGIN, "--scope", journal.scope]);
    else if (step === "enable")
      commands.push(["plugin", "disable", CLAUDE_PLUGIN, "--scope", journal.scope]);
    else if (step === "marketplace-add")
      commands.push(["plugin", "marketplace", "remove", CLAUDE_MARKETPLACE]);
    else
      throw new LifecycleError(
        "RECOVERY_PARTIAL",
        `Claude ${step} cannot be rolled back automatically; evidence retained at ${paths.journal}`,
        4,
      );
  }
  for (const command of commands) await runClaude(options, command);
  if (journal.manifestPreimage) {
    await durableWrite(paths.manifest, journal.manifestPreimage, 0o600);
  } else {
    await rm(paths.manifest, { force: true });
  }
  await rm(paths.journal, { force: true });
}

async function recoverClaude(paths, options) {
  if (!(await pathExists(paths.journal))) return false;
  await assertProtectedFile(paths.journal, "Claude transaction journal").catch((error) => {
    throw new LifecycleError("RECOVERY_PARTIAL", error.message, 4);
  });
  const journal = await readJson(paths.journal).catch(() => {
    throw new LifecycleError("RECOVERY_PARTIAL", "Claude transaction journal is unreadable", 4);
  });
  if (
    !SCHEMA_CAPABILITIES.has(journal.schema) ||
    journal.host !== "claude" ||
    !HOST_SCOPES.claude.has(journal.scope) ||
    !["install", "update", "disable", "enable", "remove"].includes(journal.operation) ||
    ((journal.scope === "project" || journal.scope === "local") &&
      (typeof journal.projectRoot !== "string" || !isAbsolute(journal.projectRoot))) ||
    !Array.isArray(journal.completed) ||
    !journal.completed.every((step) =>
      ["marketplace-add", "install", "update", "disable", "enable", "uninstall"].includes(step),
    )
  )
    throw new LifecycleError("RECOVERY_PARTIAL", "Claude transaction journal is invalid", 4);
  const recoveryOptions = {
    ...options,
    scope: journal.scope,
    projectRoot: journal.projectRoot || options.projectRoot,
  };
  const recoveryPaths = protectedPaths(recoveryOptions);
  if (journal.manifestPreimage) {
    let previous;
    try {
      previous = JSON.parse(journal.manifestPreimage);
    } catch {
      throw new LifecycleError(
        "RECOVERY_PARTIAL",
        "Claude manifest preimage is invalid; evidence retained",
        4,
      );
    }
    validateClaudeManifest(previous, recoveryOptions);
  }
  await compensateClaude(recoveryPaths, recoveryOptions, journal);
  return true;
}

async function claudeLifecycle(options) {
  const paths = protectedPaths(options);
  const release = await acquireLock(paths.lock);
  try {
    const recovered = await recoverClaude(paths, options);
    let manifest = await readClaudeManifest(options);
    if (manifest && !options.source) options.claudeSource = manifest.nativeIdentity.source;
    let inspection = await inspectClaude(options);
    const selected = await claudeAtScope(inspection, options);

    if (manifest && !selected)
      throw new LifecycleError("DRIFT", "Claude no longer reports Kona at the managed scope", 4);
    if (manifest && (selected.enabled !== false) !== (manifest.state === "active"))
      throw new LifecycleError("DRIFT", "Claude enablement differs from Kona's protected state", 4);
    if (manifest && manifest.schema !== SCHEMA && ["install", "verify"].includes(options.verb)) {
      if (!inspection.marketplaceRegistered)
        throw new LifecycleError(
          "MARKETPLACE_MISSING",
          `register ${options.claudeSource} before installing Kona`,
          1,
          { command: ["claude", "plugin", "marketplace", "add", options.claudeSource] },
        );
      if (!selected) throw new LifecycleError("DRIFT", "Claude no longer reports Kona", 4);
      const discovery = await verifyClaudeCommands(options, selected, manifest);
      throw new LifecycleError(
        "UPDATE_REQUIRED",
        "the installed capability bundle requires an explicit update",
        1,
        { discovery },
      );
    }
    if (options.verb === "verify") {
      if (!inspection.marketplaceRegistered)
        throw new LifecycleError(
          "MARKETPLACE_MISSING",
          `register ${options.claudeSource} before installing Kona`,
          1,
          { command: ["claude", "plugin", "marketplace", "add", options.claudeSource] },
        );
      if (!selected) throw new LifecycleError("NOT_INSTALLED", "scope is not installed");
      const discovery = await verifyClaudeCommands(options, selected, manifest);
      return {
        status: selected.enabled === false ? "disabled" : "active",
        message: `${selected.version || manifest?.version || "unknown version"} ${selected.enabled === false ? "disabled" : "active"} and verified`,
        recovered,
        details: {
          discovery,
          managed: Boolean(manifest),
        },
      };
    }

    if (selected && !manifest)
      throw new LifecycleError(
        "UNMANAGED_NATIVE_INSTALL",
        "Claude reports Kona at the selected scope without matching protected Kona state",
        4,
      );

    if (options.verb === "install" && selected) {
      if (selected.enabled === false)
        throw new LifecycleError(
          "DISABLED",
          "enable the selected scope instead of reinstalling it",
        );
      const discovery = await verifyClaudeCommands(options, selected, manifest);
      return {
        status: "unchanged",
        message: "already installed and native discovery verified",
        recovered,
        details: { discovery },
      };
    }
    if (options.verb !== "install" && !selected)
      throw new LifecycleError("NOT_INSTALLED", "scope is not installed");
    if (options.verb === "update" && manifest.state !== "active")
      throw new LifecycleError("DISABLED", "enable the selected Claude scope before updating");
    if (options.verb === "disable" && selected.enabled === false)
      return { status: "unchanged", message: "already disabled", recovered };
    if (options.verb === "enable" && selected.enabled !== false)
      return { status: "unchanged", message: "already enabled", recovered };
    if (["install", "enable"].includes(options.verb)) {
      const other = await activeClaudeOtherScope(inspection, options);
      if (other)
        throw new LifecycleError(
          "ACTIVE_SCOPE",
          `claude is already active at ${other.scope} scope`,
          4,
          { activeScope: other.scope },
        );
    }

    if (manifest && ["update", "disable", "enable", "remove"].includes(options.verb))
      await verifyClaudeCommands(options, selected, manifest);

    const plan = claudeMutationPlan(options, inspection);
    if (!options.approve)
      throw new LifecycleError(
        "APPROVAL_REQUIRED",
        "review the native command plan and rerun with --approve",
        1,
        { plan },
      );

    const manifestPreimage = manifest ? await readFile(paths.manifest, "utf8") : null;
    const journal = {
      schema: SCHEMA,
      host: "claude",
      scope: options.scope,
      projectRoot: options.projectRoot,
      operation: options.verb,
      completed: [],
      manifestPreimage,
    };
    await writeClaudeJournal(paths, journal);
    try {
      if (options.verb === "install" && !inspection.marketplaceRegistered) {
        await runClaude(options, ["plugin", "marketplace", "add", options.claudeSource]);
        journal.completed.push("marketplace-add");
        await writeClaudeJournal(paths, journal);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        inspection = await inspectClaude(options);
        if (
          !inspection.marketplaceRegistered ||
          (!isAbsolute(options.claudeSource) && inspection.available.length !== 1)
        )
          throw new LifecycleError(
            "DISCOVERY_FAILED",
            "the approved marketplace did not expose exactly one kona plugin",
            4,
          );
      }
      const nativeVerb = options.verb === "remove" ? "uninstall" : options.verb;
      await runClaude(options, ["plugin", nativeVerb, CLAUDE_PLUGIN, "--scope", options.scope]);
      journal.completed.push(nativeVerb);
      await writeClaudeJournal(paths, journal);

      const after = await inspectClaude(options);
      const installed = await claudeAtScope(after, options);
      const expectedPresent = options.verb !== "remove";
      const expectedEnabled = !["disable", "remove"].includes(options.verb);
      if (
        Boolean(installed) !== expectedPresent ||
        (installed && (installed.enabled !== false) !== expectedEnabled)
      )
        throw new LifecycleError(
          "DISCOVERY_FAILED",
          "Claude did not report the requested lifecycle state",
          4,
          { installed: after.installed },
        );

      if (installed) {
        const version =
          installed.version ||
          manifest?.version ||
          (await readJson(join(options.sourceRoot, ".claude-plugin", "plugin.json"))).version;
        const nextManifest =
          manifest?.schema !== SCHEMA && ["disable", "enable"].includes(options.verb)
            ? { ...manifest, state: expectedEnabled ? "active" : "disabled" }
            : nativeClaudeManifest(options, version, expectedEnabled ? "active" : "disabled");
        const discovery = await verifyClaudeCommands(options, installed, nextManifest);
        manifest = nextManifest;
        await durableWrite(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
        await rm(paths.journal, { force: true });
        return {
          status:
            options.verb === "install"
              ? "installed"
              : options.verb === "update"
                ? "updated"
                : `${options.verb}d`,
          message: `Claude ${options.verb} completed and native discovery verified`,
          recovered,
          details: { discovery, plan },
        };
      } else {
        await rm(paths.scopeRoot, { recursive: true, force: true });
      }
      await rm(paths.journal, { force: true });
      return {
        status: "removed",
        message: `Claude ${options.verb} completed and native discovery verified`,
        recovered,
        details: { plan },
      };
    } catch (error) {
      try {
        await compensateClaude(paths, options, journal);
      } catch (rollbackError) {
        if (rollbackError instanceof LifecycleError && rollbackError.code === "RECOVERY_PARTIAL")
          throw rollbackError;
        throw new LifecycleError(
          "RECOVERY_PARTIAL",
          `Claude operation failed and rollback could not be verified: ${rollbackError.message || String(rollbackError)}`,
          4,
          { journal: paths.journal },
        );
      }
      throw error;
    }
  } finally {
    await release();
  }
}

function parsePiSource(value, options) {
  if (typeof value !== "string" || value.trim() !== value || value === "" || /[\0\r\n]/.test(value))
    throw new LifecycleError("INVALID_SOURCE", "Pi source must be one non-empty argument", 2);
  if (value.startsWith("-"))
    throw new LifecycleError("INVALID_SOURCE", "Pi source cannot begin with an option", 2);

  if (value.startsWith("npm:")) {
    const specification = value.slice(4);
    const match = specification.match(/^(@[^/]+\/[^@]+|[^@/]+)(?:@(.+))?$/);
    if (!match) throw new LifecycleError("INVALID_SOURCE", `invalid Pi npm source: ${value}`, 2);
    return {
      source: value,
      identity: `npm:${match[1]}`,
      kind: "npm",
      pinned: Boolean(match[2]),
      pin: match[2] || null,
    };
  }

  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) {
    const absolute = resolve(options.projectRoot, value);
    return {
      source: value,
      identity: `local:${absolute}`,
      kind: "local",
      pinned: false,
      pin: null,
    };
  }

  if (!value.startsWith("git:") && !/^(https?|ssh|git):\/\//.test(value))
    throw new LifecycleError(
      "INVALID_SOURCE",
      "Pi source must be npm:, git:, an HTTP/SSH/git URL, or a local path",
      2,
    );
  const separator = value.lastIndexOf("@");
  const pathBoundary = Math.max(value.lastIndexOf("/"), value.lastIndexOf(":"));
  const pinned = separator > pathBoundary;
  const identity = pinned ? value.slice(0, separator) : value;
  return {
    source: value,
    identity: `git:${identity.replace(/^git:/, "")}`,
    kind: "git",
    pinned,
    pin: pinned ? value.slice(separator + 1) : null,
  };
}

function nativePiManifest(options, version, source, state = "active") {
  const parsed = parsePiSource(source, options);
  return {
    schema: SCHEMA,
    bundle: BUNDLE,
    capabilities: CAPABILITIES,
    version,
    host: "pi",
    scope: options.scope,
    state,
    projectRoot: options.scope === "project" ? options.projectRoot : undefined,
    nativeIdentity: {
      source: parsed.source,
      package: parsed.identity,
      kind: parsed.kind,
      pinned: parsed.pinned,
      pin: parsed.pin,
      invocation: CAPABILITY_REGISTRY[0].hosts.pi.invocation,
    },
  };
}

function validatePiManifest(manifest, options) {
  let parsed;
  try {
    parsed = parsePiSource(manifest?.nativeIdentity?.source, options);
  } catch {
    throw new LifecycleError("INVALID_STATE", "Pi ownership manifest is malformed", 4);
  }
  const legacy = manifest?.schema === LEGACY_SCHEMA;
  if (
    !manifest ||
    !SCHEMA_CAPABILITIES.has(manifest.schema) ||
    manifest.version !== SCHEMA_VERSIONS.get(manifest.schema) ||
    (legacy
      ? manifest.capability !== "prd"
      : manifest.bundle !== BUNDLE ||
        JSON.stringify(manifest.capabilities) !==
          JSON.stringify(SCHEMA_CAPABILITIES.get(manifest.schema))) ||
    manifest.host !== "pi" ||
    manifest.scope !== options.scope ||
    !["active", "disabled"].includes(manifest.state) ||
    manifest.nativeIdentity.package !== parsed.identity ||
    manifest.nativeIdentity.kind !== parsed.kind ||
    manifest.nativeIdentity.pinned !== parsed.pinned ||
    manifest.nativeIdentity.pin !== parsed.pin ||
    manifest.nativeIdentity.invocation !==
      CAPABILITY_REGISTRY.find(({ name }) => nativeCapabilities(manifest).includes(name))?.hosts.pi
        .invocation ||
    (options.scope === "project" &&
      (typeof manifest.projectRoot !== "string" ||
        resolve(manifest.projectRoot) !== options.projectRoot))
  )
    throw new LifecycleError("INVALID_STATE", "Pi ownership manifest is malformed", 4);
}

async function readPiManifest(options) {
  const path = protectedPaths(options).manifest;
  if (!(await pathExists(path))) return null;
  await assertProtectedFile(path, "Pi ownership manifest");
  const manifest = await readJson(path).catch(() => {
    throw new LifecycleError("INVALID_STATE", "Pi ownership manifest is unreadable", 4);
  });
  validatePiManifest(manifest, options);
  return manifest;
}

function piScopedArgs(options, args) {
  if (options.scope !== "project") return args;
  return [...args, "-l", "--approve"];
}

async function runPi(options, args, interactive = false) {
  if (!interactive) {
    try {
      return await execute("pi", args, {
        cwd: options.projectRoot,
        env: options.environment,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      if (error.code === "ENOENT")
        throw new LifecycleError("HOST_UNAVAILABLE", "Pi CLI is not available on PATH", 4);
      throw new LifecycleError(
        "NATIVE_COMMAND_FAILED",
        `pi ${args.join(" ")} failed: ${(error.stderr || error.message || String(error)).trim()}`,
        4,
        { command: ["pi", ...args] },
      );
    }
  }
  await new Promise((resolvePromise, reject) => {
    const scriptedKeys = options.environment.KONA_PI_CONFIG_KEYS;
    const child = spawn("pi", args, {
      cwd: options.projectRoot,
      env: options.environment,
      stdio: scriptedKeys ? ["pipe", "ignore", "pipe"] : "inherit",
    });
    let errors = "";
    if (scriptedKeys) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      setTimeout(() => child.stdin.end(scriptedKeys), 100);
    }
    child.on("error", (error) => reject(error));
    child.on("close", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`Pi exited with status ${code}: ${errors.trim()}`)),
    );
  }).catch((error) => {
    if (error.code === "ENOENT")
      throw new LifecycleError("HOST_UNAVAILABLE", "Pi CLI is not available on PATH", 4);
    throw new LifecycleError(
      "NATIVE_COMMAND_FAILED",
      `pi ${args.join(" ")} failed: ${error.message || String(error)}`,
      4,
      { command: ["pi", ...args] },
    );
  });
}

async function piCommands(options) {
  return new Promise((resolvePromise, reject) => {
    const args = ["--mode", "rpc", "--no-session"];
    if (options.scope === "project") args.push("--approve");
    const child = spawn("pi", args, {
      cwd: options.projectRoot,
      env: options.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let output = "";
    let errors = "";
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      if (error) reject(error);
      else resolvePromise(result);
    };
    const timeout = setTimeout(() => finish(new Error("Pi RPC discovery timed out")), 10_000);
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (!settled) finish(new Error(`Pi RPC exited before discovery (${code}): ${errors.trim()}`));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      while (output.includes("\n")) {
        const newline = output.indexOf("\n");
        const line = output.slice(0, newline).replace(/\r$/, "");
        output = output.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(new Error("Pi RPC returned invalid JSON"));
          return;
        }
        if (message.type === "response" && message.command === "get_commands") {
          if (!message.success) finish(new Error(message.error || "Pi get_commands failed"));
          else finish(null, message.data?.commands || []);
          return;
        }
      }
    });
    child.stdin.on("error", (error) => finish(error));
    child.stdin.write(`${JSON.stringify({ type: "get_commands" })}\n`);
  });
}

async function inspectPi(options, manifest, expectedEnabled) {
  const source = manifest.nativeIdentity.source;
  const packages = await piPackagesAtScope(options, source);
  if (packages.length !== 1)
    throw new LifecycleError(
      "DISCOVERY_FAILED",
      "Pi list did not report exactly one managed package with the expected source and scope",
      4,
    );
  let commands;
  try {
    commands = await piCommands(options);
  } catch (error) {
    if (error.code === "ENOENT")
      throw new LifecycleError("HOST_UNAVAILABLE", "Pi CLI is not available on PATH", 4);
    throw new LifecycleError(
      "DISCOVERY_FAILED",
      `Pi RPC discovery failed: ${error.message || String(error)}`,
      4,
    );
  }
  const capabilities = nativeCapabilities(manifest);
  for (const name of CAPABILITIES) {
    const named = commands.filter((command) => command?.name === `skill:${name}`);
    const discovered = named.length === 1 && piCommandMatches(options, manifest, named[0], name);
    const expected = expectedEnabled && capabilities.includes(name);
    const unexpectedCurrent = manifest.schema === SCHEMA && !expected && named.length !== 0;
    if ((expected && !discovered) || unexpectedCurrent || (!expectedEnabled && named.length !== 0))
      throw new LifecycleError(
        "DISCOVERY_FAILED",
        `Pi did not report exactly one valid /skill:${name} command in the expected lifecycle state at ${options.scope} scope`,
        4,
      );
  }
  return nativeDiscovery("pi", capabilities);
}

function piCommandMatches(options, manifest, command, name) {
  const info = command?.sourceInfo;
  if (
    command?.source !== "skill" ||
    info?.scope !== options.scope ||
    info?.origin !== "package" ||
    typeof info?.source !== "string" ||
    typeof info?.baseDir !== "string" ||
    !isAbsolute(info.baseDir) ||
    typeof info?.path !== "string" ||
    resolve(info.path) !== resolve(info.baseDir, "plugin", "skills", name, "SKILL.md")
  )
    return false;

  if (info.source === manifest.nativeIdentity.source) return true;
  if (manifest.nativeIdentity.kind !== "local") return false;
  return `local:${resolve(info.baseDir)}` === manifest.nativeIdentity.package;
}

async function listedPiPackages(options) {
  const { stdout } = await runPi(options, [
    "list",
    ...(options.scope === "project" ? ["--approve"] : []),
  ]);
  let scope = null;
  const packages = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "User packages:") scope = "user";
    else if (line === "Project packages:") scope = "project";
    else if (scope && rawLine.startsWith("  ") && rawLine[2] !== " ") {
      const source = line.replace(/\s+\(filtered\)$/, "");
      packages.push({ scope, source });
    }
  }
  return packages;
}

async function piPackagesAtScope(options, source) {
  const requested = parsePiSource(source, options);
  const matches = [];
  for (const entry of await listedPiPackages(options)) {
    if (entry.scope !== options.scope) continue;
    let installed;
    try {
      installed = parsePiSource(entry.source, options);
    } catch {
      continue;
    }
    if (installed.identity === requested.identity) matches.push(entry);
  }
  return matches;
}

async function piDiscoveredAtScope(options, capabilities = CAPABILITIES) {
  let commands;
  try {
    commands = await piCommands(options);
  } catch (error) {
    if (error.code === "ENOENT")
      throw new LifecycleError("HOST_UNAVAILABLE", "Pi CLI is not available on PATH", 4);
    throw new LifecycleError(
      "DISCOVERY_FAILED",
      `Pi RPC discovery failed: ${error.message || String(error)}`,
      4,
    );
  }
  return commands.some(
    (command) =>
      capabilities.includes(command?.name?.replace(/^skill:/, "")) &&
      (command?.sourceInfo?.scope ?? command?.location) === options.scope,
  );
}

async function refuseUnmanagedPi(options, source) {
  for (const scope of HOST_SCOPES.pi) {
    const otherOptions = { ...options, scope };
    const packages = await piPackagesAtScope(otherOptions, source);
    if (packages.length === 0) continue;
    const manifest = await readPiManifest(otherOptions);
    const requested = parsePiSource(source, otherOptions);
    if (!manifest || manifest.nativeIdentity.package !== requested.identity)
      throw new LifecycleError(
        "UNMANAGED_NATIVE_INSTALL",
        `Pi reports the Kona package at ${scope} scope without matching protected Kona state`,
        4,
        { scope, sources: packages.map((entry) => entry.source) },
      );
  }
}

async function activePiOtherScope(options) {
  for (const scope of HOST_SCOPES.pi) {
    if (scope === options.scope) continue;
    const otherOptions = { ...options, scope };
    const other = await readPiManifest(otherOptions);
    if (!other) continue;
    const packages = await piPackagesAtScope(otherOptions, other.nativeIdentity.source);
    if (packages.length === 0)
      throw new LifecycleError(
        "DRIFT",
        `Pi no longer reports the protected Kona package at ${scope} scope`,
        4,
      );
    if (await piDiscoveredAtScope(otherOptions, nativeCapabilities(other))) return scope;
  }
  return null;
}

function piMutationPlan(options, manifest, source) {
  let args;
  if (options.verb === "install") args = piScopedArgs(options, ["install", source]);
  else if (options.verb === "remove")
    args = piScopedArgs(options, ["remove", manifest.nativeIdentity.source]);
  else if (options.verb === "disable" || options.verb === "enable")
    args = piScopedArgs(options, ["config"]);
  else if (manifest.nativeIdentity.pinned) args = piScopedArgs(options, ["install", source]);
  else
    args = [
      "update",
      manifest.nativeIdentity.source,
      ...(options.scope === "project" ? ["--approve"] : []),
    ];
  return [["pi", ...args]];
}

async function writePiJournal(paths, journal) {
  await durableWrite(paths.journal, `${JSON.stringify(journal, null, 2)}\n`);
}

async function compensatePi(paths, options, journal) {
  if (journal.started && journal.completed.length === 0)
    throw new LifecycleError(
      "RECOVERY_PARTIAL",
      `Pi command completion is unknown; evidence retained at ${paths.journal}`,
      4,
    );
  for (const step of journal.completed.toReversed()) {
    let args;
    let interactive = false;
    if (step === "install") args = piScopedArgs(options, ["remove", journal.source]);
    else if (step === "remove") args = piScopedArgs(options, ["install", journal.source]);
    else if (step === "pinned-reinstall")
      args = piScopedArgs(options, ["install", journal.previousSource]);
    else if (step === "disable" || step === "enable") {
      args = piScopedArgs(options, ["config"]);
      interactive = true;
    } else
      throw new LifecycleError(
        "RECOVERY_PARTIAL",
        `Pi ${step} cannot be rolled back automatically; evidence retained at ${paths.journal}`,
        4,
      );
    await runPi(options, args, interactive);
  }
  if (journal.manifestPreimage) await durableWrite(paths.manifest, journal.manifestPreimage, 0o600);
  else await rm(paths.manifest, { force: true });
  await rm(paths.journal, { force: true });
}

async function recoverPi(paths, options) {
  if (!(await pathExists(paths.journal))) return false;
  const info = await lstat(paths.journal);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0)
    throw new LifecycleError("RECOVERY_PARTIAL", "Pi transaction journal is unsafe", 4);
  const journal = await readJson(paths.journal).catch(() => {
    throw new LifecycleError("RECOVERY_PARTIAL", "Pi transaction journal is unreadable", 4);
  });
  if (
    !SCHEMA_CAPABILITIES.has(journal.schema) ||
    journal.host !== "pi" ||
    !HOST_SCOPES.pi.has(journal.scope) ||
    !["install", "update", "disable", "enable", "remove"].includes(journal.operation) ||
    (journal.scope === "project" &&
      (typeof journal.projectRoot !== "string" || !isAbsolute(journal.projectRoot))) ||
    typeof journal.started !== "boolean" ||
    !Array.isArray(journal.completed) ||
    !journal.completed.every((step) =>
      ["install", "remove", "pinned-reinstall", "update", "disable", "enable"].includes(step),
    )
  )
    throw new LifecycleError("RECOVERY_PARTIAL", "Pi transaction journal is invalid", 4);
  const recoveryOptions = {
    ...options,
    scope: journal.scope,
    projectRoot: journal.projectRoot || options.projectRoot,
  };
  const recoveryPaths = protectedPaths(recoveryOptions);
  try {
    parsePiSource(journal.source, recoveryOptions);
    if (journal.previousSource) parsePiSource(journal.previousSource, recoveryOptions);
  } catch {
    throw new LifecycleError(
      "RECOVERY_PARTIAL",
      "Pi transaction journal contains an invalid source; evidence retained",
      4,
    );
  }
  if (journal.manifestPreimage) {
    let previous;
    try {
      previous = JSON.parse(journal.manifestPreimage);
    } catch {
      throw new LifecycleError(
        "RECOVERY_PARTIAL",
        "Pi manifest preimage is invalid; evidence retained",
        4,
      );
    }
    validatePiManifest(previous, recoveryOptions);
  }
  await compensatePi(recoveryPaths, recoveryOptions, journal);
  return true;
}

async function piLifecycle(options) {
  const paths = protectedPaths(options);
  const release = await acquireLock(paths.lock);
  try {
    const recovered = await recoverPi(paths, options);
    let manifest = await readPiManifest(options);
    const capability = await readJson(join(options.sourceRoot, "capabilities", "prd.json"));
    let source = options.source;

    if (options.verb === "install") {
      source ||= manifest?.nativeIdentity.source || PI_SOURCE;
      const parsed = parsePiSource(source, options);
      if (manifest) {
        if (manifest.nativeIdentity.package !== parsed.identity)
          throw new LifecycleError(
            "SOURCE_CONFLICT",
            "selected Pi scope manages a different package",
          );
        if (manifest.nativeIdentity.source !== source)
          throw new LifecycleError("SOURCE_CONFLICT", "use update to change a pinned Pi source");
        const discovery = await inspectPi(options, manifest, manifest.state === "active");
        if (manifest.schema !== SCHEMA)
          throw new LifecycleError(
            "UPDATE_REQUIRED",
            "the installed capability bundle requires an explicit update",
            1,
            {
              discovery,
              source: manifest.nativeIdentity.source,
            },
          );
        if (manifest.state === "disabled")
          throw new LifecycleError(
            "DISABLED",
            "enable the selected Pi scope instead of reinstalling",
          );
        return { status: "unchanged", message: "already installed", recovered };
      }
      await refuseUnmanagedPi(options, source);
      const other = await activePiOtherScope(options);
      if (other)
        throw new LifecycleError("ACTIVE_SCOPE", `pi is already active at ${other} scope`, 4, {
          activeScope: other,
        });
    } else {
      if (!manifest) throw new LifecycleError("NOT_INSTALLED", "scope is not installed");
      if (options.verb !== "update" && source && source !== manifest.nativeIdentity.source)
        throw new LifecycleError(
          "SOURCE_CONFLICT",
          "--source does not match protected Pi state",
          2,
        );
      if (options.verb === "update") {
        if (manifest.state === "disabled")
          throw new LifecycleError("DISABLED", "enable the selected Pi scope before updating");
        if (manifest.schema !== SCHEMA) await inspectPi(options, manifest, true);
        if (manifest.nativeIdentity.pinned) {
          if (!source)
            throw new LifecycleError(
              "NEW_PIN_REQUIRED",
              "pinned Pi sources update by reinstalling a new --source pin",
              2,
            );
          const next = parsePiSource(source, options);
          if (
            !next.pinned ||
            next.identity !== manifest.nativeIdentity.package ||
            source === manifest.nativeIdentity.source
          )
            throw new LifecycleError(
              "NEW_PIN_REQUIRED",
              "--source must be a different pin for the same Pi package",
              2,
            );
        } else if (source) {
          throw new LifecycleError(
            "SOURCE_NOT_ALLOWED",
            "unpinned Pi sources use native update without --source",
            2,
          );
        }
      }
    }

    if (options.verb === "verify") {
      const discovery = await inspectPi(options, manifest, manifest.state === "active");
      if (manifest.schema !== SCHEMA)
        throw new LifecycleError(
          "UPDATE_REQUIRED",
          "the installed capability bundle requires an explicit update",
          1,
          { discovery, source: manifest.nativeIdentity.source },
        );
      return {
        status: manifest.state,
        message: `${manifest.version} ${manifest.state} and verified`,
        recovered,
        details: { discovery, source: manifest.nativeIdentity.source },
      };
    }
    if (options.verb === "disable" && manifest.state === "disabled")
      return { status: "unchanged", message: "already disabled", recovered };
    if (options.verb === "enable" && manifest.state === "active")
      return { status: "unchanged", message: "already enabled", recovered };
    if (options.verb === "enable") {
      await refuseUnmanagedPi(options, manifest.nativeIdentity.source);
      const other = await activePiOtherScope(options);
      if (other)
        throw new LifecycleError("ACTIVE_SCOPE", `pi is already active at ${other} scope`, 4, {
          activeScope: other,
        });
    }

    const effectiveSource = source || manifest?.nativeIdentity.source;
    const plan = piMutationPlan(options, manifest, effectiveSource);
    if (!options.approve)
      throw new LifecycleError(
        "APPROVAL_REQUIRED",
        "review the native command plan and rerun with --approve",
        1,
        { plan },
      );

    const manifestPreimage = manifest ? await readFile(paths.manifest, "utf8") : null;
    const journal = {
      schema: SCHEMA,
      host: "pi",
      scope: options.scope,
      projectRoot: options.projectRoot,
      operation: options.verb,
      source: effectiveSource,
      previousSource: manifest?.nativeIdentity.source,
      started: false,
      completed: [],
      manifestPreimage,
    };
    await writePiJournal(paths, journal);
    try {
      journal.started = true;
      await writePiJournal(paths, journal);
      const command = plan[0].slice(1);
      await runPi(options, command, options.verb === "disable" || options.verb === "enable");
      const step =
        options.verb === "update"
          ? manifest.nativeIdentity.pinned
            ? "pinned-reinstall"
            : "update"
          : options.verb;
      journal.completed.push(step);
      await writePiJournal(paths, journal);

      if (options.verb === "remove") {
        const removedState = nativePiManifest(
          options,
          capability.version,
          manifest.nativeIdentity.source,
          "disabled",
        );
        const remainingPackages = await piPackagesAtScope(options, manifest.nativeIdentity.source);
        if (remainingPackages.length > 0)
          throw new LifecycleError(
            "DISCOVERY_FAILED",
            "Pi still lists the package at the removed scope",
            4,
            { sources: remainingPackages.map((entry) => entry.source) },
          );
        if (await piDiscoveredAtScope(options, nativeCapabilities(manifest)))
          throw new LifecycleError(
            "DISCOVERY_FAILED",
            "Pi still discovers a managed skill at the removed scope",
            4,
          );
        validatePiManifest(removedState, options);
        await rm(paths.scopeRoot, { recursive: true, force: true });
      } else {
        const nextState =
          options.verb === "disable"
            ? "disabled"
            : options.verb === "enable"
              ? "active"
              : manifest?.state || "active";
        manifest =
          manifest?.schema !== SCHEMA && ["disable", "enable"].includes(options.verb)
            ? { ...manifest, state: nextState }
            : nativePiManifest(options, capability.version, effectiveSource, nextState);
        const discovery = await inspectPi(options, manifest, nextState === "active");
        await durableWrite(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
        await rm(paths.journal, { force: true });
        return {
          status:
            options.verb === "install"
              ? "installed"
              : options.verb === "update"
                ? "updated"
                : `${options.verb}d`,
          message: `Pi ${options.verb} completed and native discovery verified`,
          recovered,
          details: { discovery, source: effectiveSource, plan },
        };
      }
      await rm(paths.journal, { force: true });
      return {
        status: "removed",
        message: "Pi remove completed and native discovery verified",
        recovered,
        details: { plan },
      };
    } catch (error) {
      try {
        await compensatePi(paths, options, journal);
      } catch (rollbackError) {
        if (rollbackError instanceof LifecycleError && rollbackError.code === "RECOVERY_PARTIAL")
          throw rollbackError;
        throw new LifecycleError(
          "RECOVERY_PARTIAL",
          `Pi operation failed and rollback could not be verified: ${rollbackError.message || String(rollbackError)}`,
          4,
          { journal: paths.journal },
        );
      }
      throw error;
    }
  } finally {
    await release();
  }
}

const compareVersions = (left, right) => {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
};

async function installOrUpdate(options, manifest, capability, resources, discover) {
  if (options.verb === "update" && !manifest)
    throw new LifecycleError("NOT_INSTALLED", "scope is not installed");
  if (manifest) {
    if (manifest.state === "active") await inspectOwned(manifest);
    else await inspectDisabled(manifest, options, resources);
    if (options.verb === "install") {
      const discovery = await discover(true);
      return {
        status: "unchanged",
        message: "already installed and native discovery verified",
        details: operationDetails(capability.version, options, discovery),
      };
    }
    if (compareVersions(capability.version, manifest.version) < 0)
      throw new LifecycleError(
        "DOWNGRADE",
        `refusing downgrade from ${manifest.version} to ${capability.version}`,
      );
    if (manifest.state === "disabled")
      throw new LifecycleError("DISABLED", "enable the scope before updating");
  } else {
    const other = await activeOtherScope(options);
    if (other)
      throw new LifecycleError(
        "ACTIVE_SCOPE",
        `${options.host} is already active at ${other} scope`,
        4,
        { activeScope: other },
      );
  }

  const paths = protectedPaths(options);
  const backups = manifest?.backups ? [...manifest.backups] : [];
  const conflicts = [];
  for (const resource of resources) {
    await assertSafeTarget(resource.target, targetBoundary(options));
    if (await pathExists(resource.target)) {
      const digest = sha256(await readFile(resource.target));
      const owned = manifest?.resources.find((item) => item.path === resource.target);
      if (!owned) conflicts.push({ path: resource.target, digest });
    }
  }
  const unconfirmed = conflicts.filter(
    (conflict) => !options.confirmations.includes(conflict.digest),
  );
  if (unconfirmed.length)
    throw new LifecycleError(
      "REPLACEMENT_CONFIRMATION_REQUIRED",
      "unowned files require digest-bound confirmation",
      1,
      { conflicts: unconfirmed },
    );

  const replacementBackups = [];
  for (const conflict of conflicts) {
    const content = await readFile(conflict.path);
    const backupPath = join(
      paths.scopeRoot,
      "backups",
      `${sha256(conflict.path)}-${conflict.digest}`,
    );
    const info = await stat(conflict.path);
    const backup = {
      path: conflict.path,
      backup: backupPath,
      sha256: conflict.digest,
      mode: modeOf(info.mode),
    };
    backups.push(backup);
    replacementBackups.push({ ...backup, content });
  }
  await inspectBackups({ backups: manifest?.backups || [] });
  const affected = [
    ...resources.map((resource) => resource.target),
    paths.manifest,
    ...replacementBackups.map((backup) => backup.backup),
  ];
  const journal = await beginTransaction(paths, affected, options);
  try {
    for (const backup of replacementBackups) {
      await durableWrite(backup.backup, backup.content, 0o600);
      if (sha256(await readFile(backup.backup)) !== backup.sha256)
        throw new LifecycleError(
          "BACKUP_FAILED",
          `replacement backup verification failed: ${backup.path}`,
          4,
        );
    }
    for (const resource of resources) await writeResource(resource);
    const next = {
      schema: SCHEMA,
      bundle: BUNDLE,
      capabilities: CAPABILITIES,
      version: capability.version,
      host: options.host,
      scope: options.scope,
      state: "active",
      projectRoot: options.scope === "project" ? options.projectRoot : undefined,
      paths: resources.map((resource) => resource.target),
      resources: resources.map((resource) => ({
        path: resource.target,
        sha256: resource.sha256,
        mode: resource.mode,
      })),
      backups,
    };
    await durableWrite(paths.manifest, `${JSON.stringify(next, null, 2)}\n`);
    const discovery = await discover(true);
    await commit(paths, journal);
    return {
      status: manifest ? "updated" : "installed",
      message: `${manifest ? "updated to" : "installed"} ${capability.version} and native discovery verified`,
      details: operationDetails(capability.version, options, discovery),
    };
  } catch (error) {
    await recover(paths, options);
    throw error;
  }
}

async function setEnabled(options, manifest, resources, enabled, discover) {
  if (!manifest) throw new LifecycleError("NOT_INSTALLED", "scope is not installed");
  if (enabled && manifest.state === "active") {
    const discovery = await discover(true);
    return {
      status: "unchanged",
      message: "already enabled and native discovery verified",
      details: operationDetails(manifest.version, options, discovery),
    };
  }
  if (!enabled && manifest.state === "disabled")
    return { status: "unchanged", message: "already disabled" };
  if (enabled) {
    await inspectDisabled(manifest, options, resources);
    const other = await activeOtherScope(options);
    if (other)
      throw new LifecycleError(
        "ACTIVE_SCOPE",
        `${options.host} is already active at ${other} scope`,
        4,
        { activeScope: other },
      );
  } else await inspectOwned(manifest);
  await inspectBackups(manifest);
  const paths = protectedPaths(options);
  const config = codexConfig(options, resources);
  if (config) await assertSafeTarget(config.path, options.home);
  const journal = await beginTransaction(
    paths,
    [
      ...resources.map((resource) => resource.target),
      paths.manifest,
      ...(config ? [config.path] : []),
    ],
    options,
  );
  try {
    if (config && enabled) {
      await removeCodexBlock(manifest.managedConfig);
      manifest.managedConfig = null;
    } else if (config) {
      manifest.managedConfig = await addCodexBlock(config);
    } else if (enabled) {
      for (const resource of resources) await writeResource(resource);
    } else {
      for (const resource of resources) {
        const backup = manifest.backups.find((item) => item.path === resource.target);
        if (backup) {
          await durableWrite(
            resource.target,
            await readFile(backup.backup),
            Number.parseInt(backup.mode, 8),
          );
          await chmod(resource.target, Number.parseInt(backup.mode, 8));
        } else await rm(resource.target, { force: true });
      }
    }
    manifest.state = enabled ? "active" : "disabled";
    await durableWrite(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    const discovery = await discover(enabled);
    await commit(paths, journal);
    return {
      status: enabled ? "enabled" : "disabled",
      message: `scope ${enabled ? "enabled" : "disabled"} and native discovery verified`,
      details: operationDetails(manifest.version, options, discovery),
    };
  } catch (error) {
    await recover(paths, options);
    throw error;
  }
}

function operationDetails(version, options, discovery) {
  return {
    version,
    scope: options.scope,
    invocation: discovery.invocation,
    invocations: discovery.invocations,
    verification: discovery,
    discovery,
    capabilities: Object.entries(discovery.invocations).map(([id, invocation]) => ({
      id,
      invocation,
      integrity: { canonical: "verified", native: "verified" },
    })),
  };
}

async function removeInstall(options, manifest, resources) {
  if (!manifest) return { status: "absent", message: "scope is not installed" };
  if (manifest.state === "active") await inspectOwned(manifest);
  else await inspectDisabled(manifest, options, resources);
  await inspectBackups(manifest);
  const paths = protectedPaths(options);
  const config = manifest.state === "disabled" ? codexConfig(options, resources) : null;
  const journal = await beginTransaction(
    paths,
    [
      ...resources.map((resource) => resource.target),
      paths.manifest,
      ...manifest.backups.map((backup) => backup.backup),
      ...(config ? [config.path] : []),
    ],
    options,
  );
  try {
    if (manifest.state === "active" || manifest.host === "codex") {
      for (const resource of resources) {
        const backup = manifest.backups.find((item) => item.path === resource.target);
        if (backup) {
          await durableWrite(
            resource.target,
            await readFile(backup.backup),
            Number.parseInt(backup.mode, 8),
          );
          await chmod(resource.target, Number.parseInt(backup.mode, 8));
        } else await rm(resource.target, { force: true });
      }
    }
    if (config) await removeCodexBlock(manifest.managedConfig);
    await rm(paths.scopeRoot, { recursive: true, force: true });
    await commit(paths, journal);
  } catch (error) {
    await recover(paths, options);
    throw error;
  }
  return { status: "removed", message: "scope removed" };
}

async function copiedLifecycle(options) {
  const paths = protectedPaths(options);
  const release = await acquireLock(paths.lock);
  try {
    const recovered = await recover(paths, options);
    const manifest = await readManifest(options);
    const sourceRegistry =
      manifest && manifest.schema !== SCHEMA && options.verb !== "update"
        ? descriptorsForSchema(manifest.schema)
        : CAPABILITY_REGISTRY;
    const { capability, resources } = await sourceResources(options, sourceRegistry);
    const ownedResources =
      manifest && options.verb === "update" ? resourcesForManifest(manifest, options) : resources;
    const discoverWith = (discoveryResources, enabled) =>
      options.host === "opencode"
        ? verifyOpenCodeDiscovery(options, discoveryResources, enabled)
        : verifyCodexDiscovery(options, discoveryResources, enabled);
    const discover = (enabled) => discoverWith(ownedResources, enabled);
    for (const resource of options.verb === "update" ? resources : ownedResources)
      await assertSafeTarget(resource.target, targetBoundary(options));
    if (manifest && manifest.schema !== SCHEMA && ["install", "verify"].includes(options.verb)) {
      if (manifest.state === "active") await inspectOwned(manifest);
      else await inspectDisabled(manifest, options, ownedResources);
      await inspectBackups(manifest);
      const discovery = await discover(manifest.state === "active");
      throw new LifecycleError(
        "UPDATE_REQUIRED",
        "the installed capability bundle requires an explicit update",
        1,
        operationDetails(manifest.version, options, discovery),
      );
    }
    if (
      manifest &&
      manifest.schema !== SCHEMA &&
      options.verb === "update" &&
      manifest.state !== "active"
    ) {
      await inspectDisabled(manifest, options, ownedResources);
      await inspectBackups(manifest);
      throw new LifecycleError("DISABLED", "enable the scope before updating");
    }
    let outcome;
    if (options.verb === "install" || options.verb === "update")
      outcome = await installOrUpdate(options, manifest, capability, resources, (enabled) =>
        discoverWith(resources, enabled),
      );
    else if (options.verb === "verify") {
      if (!manifest) throw new LifecycleError("NOT_INSTALLED", "scope is not installed");
      if (manifest.state === "active") await inspectOwned(manifest);
      else await inspectDisabled(manifest, options, ownedResources);
      await inspectBackups(manifest);
      outcome = {
        status: manifest.state,
        message: `${manifest.version} ${manifest.state} and verified`,
        details: operationDetails(
          manifest.version,
          options,
          await discover(manifest.state === "active"),
        ),
      };
    } else if (options.verb === "disable")
      outcome = await setEnabled(options, manifest, ownedResources, false, discover);
    else if (options.verb === "enable")
      outcome = await setEnabled(options, manifest, ownedResources, true, discover);
    else outcome = await removeInstall(options, manifest, ownedResources);
    return { ...outcome, recovered };
  } finally {
    await release();
  }
}

export async function runLifecycle(argv, context = {}) {
  let options;
  try {
    options = parseArguments(argv, context.cwd || process.cwd(), context.env || process.env);
    options.projectRoot = await realpath(options.projectRoot).catch(() => options.projectRoot);
    await prepareProtectedState(options);
    if (Number.parseInt(process.versions.node.split(".")[0], 10) < 20)
      throw new LifecycleError(
        "UNSUPPORTED_NODE",
        "lifecycle commands require Node.js 20 or newer",
      );
    const outcome =
      options.host === "claude"
        ? await claudeLifecycle(options)
        : options.host === "pi"
          ? await piLifecycle(options)
          : await copiedLifecycle(options);
    return {
      exitCode: 0,
      json: options.json,
      body: {
        ok: true,
        verb: options.verb,
        host: options.host,
        scope: options.scope,
        code: "OK",
        status: outcome.status,
        message: outcome.message,
        recovered: outcome.recovered,
        details: outcome.details || {},
      },
    };
  } catch (error) {
    const failure =
      error instanceof LifecycleError
        ? error
        : new LifecycleError("INTERNAL", error.message || String(error), 4);
    return {
      exitCode: failure.exitCode,
      json: options?.json || argv.includes("--json"),
      body: {
        ok: false,
        verb: options?.verb || argv[0] || null,
        host: options?.host || null,
        scope: options?.scope || null,
        code: failure.code,
        status: "refused",
        message: failure.message,
        recovered: false,
        details: failure.details,
      },
    };
  }
}
