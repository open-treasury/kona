#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { canonicalJson, validateFastManifest } from "./contracts.ts";

const parsed = parseArgs({
  args: process.argv.slice(2),
  options: { manifest: { type: "string" }, out: { type: "string" } },
});
const manifestPath = parsed.values.manifest;
const outputPath = parsed.values.out;
if (!manifestPath || !outputPath) throw new Error("--manifest and --out are required");
const manifest = validateFastManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
const images: Record<string, string> = {};

for (const image of manifest.imageFamilies) {
  const repository = image;
  const tokenResponse = await fetch(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`,
  );
  if (!tokenResponse.ok) throw new Error(`Docker token request failed for ${image}`);
  const token = ((await tokenResponse.json()) as { token: string }).token;
  const response = await fetch(`https://registry-1.docker.io/v2/${repository}/manifests/latest`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
      ].join(", "),
    },
  });
  if (!response.ok) throw new Error(`Docker manifest request failed for ${image}`);
  const body = (await response.json()) as {
    manifests?: { digest: string; platform?: { os?: string; architecture?: string } }[];
  };
  const amd64 = body.manifests?.find(
    (entry) => entry.platform?.os === "linux" && entry.platform.architecture === "amd64",
  );
  const digest = amd64?.digest ?? response.headers.get("docker-content-digest");
  if (!digest?.match(/^sha256:[a-f0-9]{64}$/))
    throw new Error(`No linux/amd64 digest for ${image}`);
  images[image] = `docker.io/${image}@${digest}`;
}

writeFileSync(outputPath, canonicalJson({ schemaVersion: 1, platform: "linux/amd64", images }));
