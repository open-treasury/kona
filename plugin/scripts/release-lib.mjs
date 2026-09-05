import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

export const SEMVER = /^\d+\.\d+\.\d+$/;
export const RELEASE_FILES = [
  [".claude-plugin/plugin.json", 0o444],
  ["capabilities/prd.json", 0o444],
  ["hosts/opencode/agents/prd-writer.md", 0o444],
  ["lib/plugin-lifecycle.mjs", 0o444],
  ["package.json", 0o444],
  ["skills/prd/SKILL.md", 0o444],
  ["skills/prd/templates/prd.md", 0o444],
];

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function put(buffer, offset, length, value) {
  const bytes = Buffer.from(value);
  if (bytes.length > length) throw new Error(`tar field is too long: ${value}`);
  bytes.copy(buffer, offset);
}

function octal(value, length) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length >= length) throw new Error(`tar numeric field overflow: ${value}`);
  return `${encoded}\0`;
}

function tarEntry(path, content, mode, type = "0") {
  const header = Buffer.alloc(512);
  put(header, 0, 100, path);
  put(header, 100, 8, octal(mode, 8));
  put(header, 108, 8, octal(0, 8));
  put(header, 116, 8, octal(0, 8));
  put(header, 124, 12, octal(content.length, 12));
  put(header, 136, 12, octal(0, 12));
  header.fill(0x20, 148, 156);
  put(header, 156, 1, type);
  put(header, 257, 6, "ustar\0");
  put(header, 263, 2, "00");
  let sum = 0;
  for (const byte of header) sum += byte;
  put(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, content, padding]);
}

function createTar(files) {
  const directories = new Set(["kona/"]);
  for (const file of files) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index += 1)
      directories.add(`${parts.slice(0, index).join("/")}/`);
  }
  const entries = [...directories]
    .toSorted()
    .map((path) => tarEntry(path, Buffer.alloc(0), 0o555, "5"));
  for (const file of files.toSorted((left, right) => left.path.localeCompare(right.path)))
    entries.push(tarEntry(file.path, file.content, file.mode));
  entries.push(Buffer.alloc(1024));
  return Buffer.concat(entries);
}

export async function releaseIdentity(root) {
  const pluginRoot = join(root, "plugin");
  const [packageJson, capability, claude, marketplace] = await Promise.all([
    readFile(join(pluginRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(join(pluginRoot, "capabilities/prd.json"), "utf8").then(JSON.parse),
    readFile(join(pluginRoot, ".claude-plugin/plugin.json"), "utf8").then(JSON.parse),
    readFile(join(root, ".claude-plugin/marketplace.json"), "utf8").then(JSON.parse),
  ]);
  const version = packageJson.version;
  if (!SEMVER.test(version)) throw new Error(`plugin version must be SemVer X.Y.Z: ${version}`);
  const versions = [capability.version, claude.version, marketplace.plugins?.[0]?.version];
  if (versions.some((candidate) => candidate !== version))
    throw new Error(`release versions are not aligned with plugin/package.json ${version}`);
  return { version, tag: `v${version}`, packageJson };
}

export async function buildRelease({ root = resolve(import.meta.dirname, "../.."), outDir } = {}) {
  const identity = await releaseIdentity(root);
  const releaseDir = resolve(outDir || join(root, "dist/plugin-release"));
  const requestedTag = process.env.KONA_RELEASE_TAG;
  if (requestedTag && requestedTag !== identity.tag)
    throw new Error(`KONA_RELEASE_TAG ${requestedTag} does not match ${identity.tag}`);

  const installer = await readFile(join(root, "install.sh"));
  if (!installer.toString("utf8").includes(`KONA_VERSION='${identity.version}'`))
    throw new Error(`install.sh does not embed release version ${identity.version}`);

  const payload = [];
  for (const [relativePath, mode] of RELEASE_FILES) {
    let content;
    if (relativePath === "package.json") {
      content = Buffer.from(
        json({ ...identity.packageJson, bin: { kona: "./bin/kona" }, dependencies: {} }),
      );
    } else {
      content = await readFile(join(root, "plugin", relativePath));
    }
    payload.push({ path: `kona/${relativePath}`, content, mode });
  }
  const launcher = await readFile(join(root, "plugin/bin/kona.mjs"));
  payload.push({ path: "kona/bin/kona", content: launcher, mode: 0o555 });

  const manifest = {
    schemaVersion: 1,
    name: "kona",
    version: identity.version,
    tag: identity.tag,
    files: payload
      .map((file) => ({
        path: file.path.slice("kona/".length),
        sha256: sha256(file.content),
        mode: `0${file.mode.toString(8)}`,
      }))
      .toSorted((left, right) => left.path.localeCompare(right.path)),
  };
  payload.push({
    path: "kona/MANIFEST.json",
    content: Buffer.from(json(manifest)),
    mode: 0o444,
  });

  const archiveName = `kona-${identity.tag}-portable.tar.gz`;
  const archive = gzipSync(createTar(payload), { level: 9, mtime: 0 });
  const checksums = [`${sha256(installer)}  install.sh`, `${sha256(archive)}  ${archiveName}`].join(
    "\n",
  );

  await rm(releaseDir, { recursive: true, force: true });
  await mkdir(releaseDir, { recursive: true });
  await Promise.all([
    writeFile(join(releaseDir, "install.sh"), installer, { mode: 0o755 }),
    writeFile(join(releaseDir, archiveName), archive, { mode: 0o644 }),
    writeFile(join(releaseDir, "SHA256SUMS"), `${checksums}\n`, { mode: 0o644 }),
  ]);
  return { ...identity, releaseDir, archiveName, archiveSha256: sha256(archive) };
}

export async function filesEqual(left, right) {
  const [leftBytes, rightBytes] = await Promise.all([readFile(left), readFile(right)]);
  return leftBytes.equals(rightBytes);
}
