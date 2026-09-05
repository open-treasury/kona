import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { runLifecycle } from "../lib/plugin-lifecycle.mjs";

const execute = promisify(execFile);
const pluginRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(pluginRoot, "..");
const pins = JSON.parse(await readFile(join(import.meta.dirname, "host-versions.json"), "utf8"));
const releaseValidation = process.env.KONA_RELEASE_VALIDATION === "1";

async function isolatedHost(host) {
  const root = await mkdtemp(join(tmpdir(), `kona-real-${host}-`));
  const home = join(root, "home");
  const project = host.startsWith("claude") ? join(root, "source") : join(root, "project");
  const state = join(root, "state");
  await Promise.all([mkdir(home), mkdir(project), mkdir(state)]);
  if (host.startsWith("claude")) {
    await cp(join(repositoryRoot, ".claude-plugin"), join(project, ".claude-plugin"), {
      recursive: true,
    });
    await cp(pluginRoot, join(project, "plugin"), { recursive: true });
  }
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local/state"),
    KONA_STATE_HOME: state,
    KONA_PLUGIN_ROOT: pluginRoot,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    KONA_PI_CONFIG_KEYS: " \u001b",
    NO_COLOR: "1",
  };
  if (host.startsWith("claude")) {
    await execute("claude", ["plugin", "marketplace", "add", project], {
      cwd: project,
      env,
      timeout: 30_000,
    });
    const catalogue = JSON.parse(
      (
        await execute("claude", ["plugin", "list", "--json", "--available"], {
          cwd: project,
          env,
          timeout: 30_000,
        })
      ).stdout,
    );
    assert.equal(catalogue.available?.filter((entry) => entry.pluginId === "kona@kona").length, 1);
  }
  return { root, project, env };
}

async function installedVersion(pin) {
  try {
    const { stdout, stderr } = await execute(pin.command, ["--version"], {
      env: process.env,
      timeout: 15_000,
    });
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function requirePinnedHost(context, host, pin) {
  const actual = await installedVersion(pin);
  if (actual === null) {
    const reason = `${host} ${pin.version} is not installed on PATH (${pin.evidence})`;
    if (releaseValidation) assert.fail(`release validation cannot skip: ${reason}`);
    context.skip(reason);
    return false;
  }
  assert.match(
    actual,
    new RegExp(`(^|[^0-9])${pin.version.replaceAll(".", "\\.")}([^0-9]|$)`),
    `${host} host version mismatch: expected ${pin.version}, received ${actual}`,
  );
  return true;
}

const scopesByHost = {
  opencode: ["project", "user"],
  codex: ["project", "user"],
  claude: ["project", "local", "user"],
  pi: ["project", "user"],
};

function mutation(host, verb, scope, localSource) {
  const args = [verb, "--host", host, "--scope", scope];
  if (verb === "install" && host === "claude") args.push("--source", localSource);
  if (verb === "install" && host === "pi") args.push("--source", repositoryRoot);
  if (["claude", "pi"].includes(host)) args.push("--approve");
  return args;
}

function conflictingScope(host, scope) {
  if (host === "claude") return scope === "project" ? "local" : "project";
  return scope === "project" ? "user" : "project";
}

for (const [host, pin] of Object.entries(pins.hosts)) {
  test(
    `real-host ${host} ${pin.version} runs the isolated lifecycle matrix without a model`,
    { timeout: 120_000 },
    async (context) => {
      if (!(await requirePinnedHost(context, host, pin))) return;
      for (const scope of scopesByHost[host]) {
        const fixture = await isolatedHost(`${host}-${scope}`);
        try {
          const run = (args) => runLifecycle(args, { cwd: fixture.project, env: fixture.env });
          const installed = await run(mutation(host, "install", scope, fixture.project));
          assert.equal(
            installed.exitCode,
            0,
            `${host}/${scope}: ${JSON.stringify(installed.body)}`,
          );
          assert.equal(installed.body.details.discovery.native, "verified");

          const verified = await run(["verify", "--host", host, "--scope", scope]);
          assert.equal(verified.exitCode, 0, `${host}/${scope}: ${JSON.stringify(verified.body)}`);
          assert.equal(verified.body.details.discovery.native, "verified");

          const updated = await run(mutation(host, "update", scope, fixture.project));
          assert.equal(updated.exitCode, 0, `${host}/${scope}: ${JSON.stringify(updated.body)}`);
          assert.equal(updated.body.details.discovery.native, "verified");

          const disabled = await run(mutation(host, "disable", scope, fixture.project));
          assert.equal(disabled.exitCode, 0, `${host}/${scope}: ${JSON.stringify(disabled.body)}`);
          assert.equal(
            (await run(["verify", "--host", host, "--scope", scope])).body.status,
            "disabled",
          );

          const enabled = await run(mutation(host, "enable", scope, fixture.project));
          assert.equal(enabled.exitCode, 0, `${host}/${scope}: ${JSON.stringify(enabled.body)}`);
          assert.equal(enabled.body.details.discovery.native, "verified");

          const otherScope = conflictingScope(host, scope);
          const conflict = await run(mutation(host, "install", otherScope, fixture.project));
          assert.equal(
            conflict.body.code,
            "ACTIVE_SCOPE",
            `${host}/${scope}: ${JSON.stringify(conflict.body)}`,
          );

          const removed = await run(mutation(host, "remove", scope, fixture.project));
          assert.equal(removed.exitCode, 0, `${host}/${scope}: ${JSON.stringify(removed.body)}`);
          const verifyAbsent = ["verify", "--host", host, "--scope", scope];
          if (host === "claude") verifyAbsent.push("--source", fixture.project);
          assert.equal((await run(verifyAbsent)).body.code, "NOT_INSTALLED");
        } finally {
          await rm(fixture.root, { recursive: true, force: true });
        }
      }
    },
  );
}

test("host pin manifest has one evidenced strict pin for every supported host", () => {
  assert.equal(pins.schemaVersion, 1);
  assert.deepEqual(Object.keys(pins.hosts), ["opencode", "codex", "claude", "pi"]);
  for (const [host, pin] of Object.entries(pins.hosts)) {
    assert.equal(pin.command, host);
    assert.match(pin.version, /^\d+\.\d+\.\d+$/);
    assert.ok(pin.evidence.length > 10);
  }
  assert.equal(pins.hosts.pi.package, `@earendil-works/pi-coding-agent@${pins.hosts.pi.version}`);
});
