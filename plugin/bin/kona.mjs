#!/usr/bin/env node

import { runLifecycle, validateLifecycleArguments } from "../lib/plugin-lifecycle.mjs";
import { formatLifecycleHuman } from "../lib/lifecycle-output.mjs";
import { prepareSelfUpdate } from "../lib/self-update.mjs";
import { fileURLToPath } from "node:url";

if (process.argv.slice(2).some((argument) => argument === "--help" || argument === "-h")) {
  process.stdout
    .write(`Usage: kona <install|update|verify|disable|enable|remove> --host <opencode|codex|claude|pi> --scope <project|user|local> [options]

Options:
  --project-root <path>       Project root (defaults to the current directory)
  --source <source>           Override the canonical Pi git source or use a local Claude marketplace
  --confirm-replace <sha256> Confirm replacement of one exact existing digest; repeatable
  --approve                  Approve the exact native Claude/Pi command plan
  --json                      Emit stable machine-readable output
  --help                      Show this help

Claude and Pi mutations first print their native command plan and require --approve. Pi defaults
to git:github.com/open-treasury/kona; --source supports explicit local test sources. Pi project
commands pass Pi's one-run project trust override. Local scope is valid only for Claude. Native
verification uses list/discovery commands and never calls a model.
Update authenticates and activates the latest Kona CLI before re-executing the selected host update.
`);
  process.exit(0);
}

const argv = process.argv.slice(2);
const validation = validateLifecycleArguments(argv, { cwd: process.cwd(), env: process.env });
if (validation.result) {
  const output = validation.result.json
    ? JSON.stringify(validation.result.body)
    : formatLifecycleHuman(validation.result.body);
  (validation.result.body.ok ? process.stdout : process.stderr).write(`${output}\n`);
  process.exit(validation.result.exitCode);
}
if (argv[0] === "update") {
  try {
    const prepared = await prepareSelfUpdate(argv, {
      cwd: process.cwd(),
      env: process.env,
      launcherPath: fileURLToPath(import.meta.url),
    });
    if (prepared.reexecuted) {
      process.exitCode = prepared.exitCode;
      process.exit();
    }
  } catch (error) {
    const body = {
      ok: false,
      verb: "update",
      host: validation.options.host,
      scope: validation.options.scope,
      code: "SELF_UPDATE_FAILED",
      status: "refused",
      message: "Kona CLI self-update failed before host update",
      recovered: false,
      details: { reason: String(error?.message || error).slice(0, 8192) },
    };
    const output = argv.includes("--json") ? JSON.stringify(body) : formatLifecycleHuman(body);
    process.stderr.write(`${output}\n`);
    process.exit(1);
  }
}

const result = await runLifecycle(argv, {
  cwd: process.cwd(),
  env: process.env,
});

const output = result.json ? JSON.stringify(result.body) : formatLifecycleHuman(result.body);
(result.body.ok ? process.stdout : process.stderr).write(`${output}\n`);
process.exitCode = result.exitCode;
