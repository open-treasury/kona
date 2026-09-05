#!/usr/bin/env node

import { resolve } from "node:path";

import { buildRelease } from "./release-lib.mjs";

const args = process.argv.slice(2);
if (args.length > 2 || (args.length === 2 && args[0] !== "--out-dir")) {
  process.stderr.write("usage: node plugin/scripts/build.mjs [--out-dir <directory>]\n");
  process.exit(2);
}

try {
  const result = await buildRelease({ outDir: args[1] && resolve(args[1]) });
  process.stdout.write(`built ${result.tag} release assets in ${result.releaseDir}\n`);
} catch (error) {
  process.stderr.write(`plugin build failed: ${error.message}\n`);
  process.exit(1);
}
