#!/usr/bin/env node

import { runLifecycle } from "../lib/plugin-lifecycle.mjs";
import { formatLifecycleHuman } from "../lib/lifecycle-output.mjs";

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
`);
  process.exit(0);
}

const result = await runLifecycle(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
});

const output = result.json ? JSON.stringify(result.body) : formatLifecycleHuman(result.body);
(result.body.ok ? process.stdout : process.stderr).write(`${output}\n`);
process.exitCode = result.exitCode;
