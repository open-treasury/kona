import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { formatLifecycleHuman } from "../lib/lifecycle-output.mjs";
import { RELEASE_FILES } from "../scripts/release-lib.mjs";

const execute = promisify(execFile);
const pluginRoot = resolve(import.meta.dirname, "..");
const success = (verb, host, scope, status, version = "0.4.2") => ({
  ok: true,
  verb,
  host,
  scope,
  code: "OK",
  status,
  message: "internal machine message",
  details: { version },
});

test("human lifecycle successes use consistent host-aware sentences", () => {
  const cases = [
    [
      success("install", "opencode", "project", "installed"),
      "Installed Kona v0.4.2 for OpenCode (project).",
    ],
    [success("update", "codex", "user", "updated"), "Updated Kona to v0.4.2 for Codex (user)."],
    [
      success("verify", "claude", "local", "active"),
      "Verified Kona v0.4.2 for Claude Code (local).",
    ],
    [success("disable", "pi", "project", "disabled"), "Disabled Kona for Pi (project)."],
    [success("enable", "opencode", "user", "enabled"), "Enabled Kona for OpenCode (user)."],
    [success("remove", "claude", "project", "removed"), "Removed Kona from Claude Code (project)."],
    [
      success("install", "pi", "user", "unchanged"),
      "Already up to date: Kona v0.4.2 for Pi (user).",
    ],
    [
      success("disable", "codex", "project", "unchanged"),
      "Already disabled: Kona for Codex (project).",
    ],
    [
      success("enable", "claude", "user", "unchanged"),
      "Already enabled: Kona for Claude Code (user).",
    ],
    [
      success("remove", "opencode", "project", "absent"),
      "Already absent: Kona is not installed for OpenCode (project).",
    ],
  ];
  for (const [body, expected] of cases) assert.equal(formatLifecycleHuman(body), expected);
});

test("human lifecycle failures retain error codes and exact approval plans", () => {
  assert.equal(
    formatLifecycleHuman({
      ok: false,
      verb: "update",
      host: "opencode",
      scope: "project",
      code: "NOT_INSTALLED",
      message: "scope is not installed",
      details: {},
    }),
    "Update refused for OpenCode (project): scope is not installed. [NOT_INSTALLED]",
  );
  assert.equal(
    formatLifecycleHuman({
      ok: false,
      verb: "install",
      host: "claude",
      scope: "project",
      code: "APPROVAL_REQUIRED",
      message: "review the native command plan and rerun with --approve",
      details: {
        plan: [["claude", "plugin", "marketplace", "add", "a'b"]],
      },
    }),
    "Install refused for Claude Code (project): review the native command plan and rerun with --approve. [APPROVAL_REQUIRED]\n" +
      `'claude' 'plugin' 'marketplace' 'add' 'a'"'"'b'`,
  );
});

test("JSON CLI output remains the unwrapped lifecycle body", async () => {
  let output;
  try {
    await execute(process.execPath, [resolve(pluginRoot, "bin/kona.mjs"), "install", "--json"]);
    assert.fail("invalid usage should fail");
  } catch (error) {
    output = error.stderr;
  }
  const body = JSON.parse(output);
  assert.equal(output, `${JSON.stringify(body)}\n`);
  assert.deepEqual(body, {
    ok: false,
    verb: "install",
    host: null,
    scope: null,
    code: "USAGE",
    status: "refused",
    message: "--host must be opencode, codex, claude, or pi",
    recovered: false,
    details: {},
  });
});

test("portable releases include the human lifecycle formatter", () => {
  assert.ok(RELEASE_FILES.some(([path]) => path === "lib/lifecycle-output.mjs"));
});
