#!/usr/bin/env node

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildRelease, filesEqual, releaseIdentity } from "./release-lib.mjs";
import { validateStaticContracts } from "./contracts.mjs";

const root = resolve(import.meta.dirname, "../..");
const temporary = await mkdtemp(join(tmpdir(), "kona-release-validation-"));

try {
  await validateStaticContracts(root);
  const identity = await releaseIdentity(root);
  const installer = await readFile(join(root, "install.sh"), "utf8");
  const required = [
    "https://github.com/open-treasury/kona/releases/latest/download/install.sh",
    "https://github.com/open-treasury/kona/releases/download/v${KONA_VERSION}",
  ];
  for (const value of required) {
    if (!installer.includes(value))
      throw new Error(`installer is missing approved URL contract: ${value}`);
  }
  const approvedHosts = new Set([
    "github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
    "github-releases.githubusercontent.com",
  ]);
  for (const match of installer.matchAll(/https:\/\/([^/\s'"$]+)/g)) {
    if (!approvedHosts.has(match[1]))
      throw new Error(`installer contains unapproved HTTPS host: ${match[1]}`);
  }
  for (const forbidden of [
    "sudo",
    "raw.githubusercontent.com",
    "api.github.com",
    "telemetry",
    "analytics",
  ]) {
    if (installer.includes(forbidden))
      throw new Error(`installer contains forbidden token: ${forbidden}`);
  }

  const first = await buildRelease({ root, outDir: join(temporary, "first") });
  const second = await buildRelease({ root, outDir: join(temporary, "second") });
  const expected = ["SHA256SUMS", "install.sh", first.archiveName].toSorted();
  const [firstFiles, secondFiles] = await Promise.all([
    readdir(first.releaseDir),
    readdir(second.releaseDir),
  ]);
  if (JSON.stringify(firstFiles.toSorted()) !== JSON.stringify(expected))
    throw new Error("release output does not contain exactly the three approved assets");
  if (JSON.stringify(secondFiles.toSorted()) !== JSON.stringify(expected))
    throw new Error("second release output does not contain exactly the three approved assets");
  for (const name of expected) {
    if (!(await filesEqual(join(first.releaseDir, name), join(second.releaseDir, name))))
      throw new Error(`release build is not deterministic: ${name}`);
  }
  process.stdout.write(`validated deterministic ${identity.tag} release contract\n`);
} catch (error) {
  process.stderr.write(`plugin validation failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
