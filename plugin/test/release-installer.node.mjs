import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildRelease, filesEqual, RELEASE_FILES } from "../scripts/release-lib.mjs";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const digest = (value) => createHash("sha256").update(value).digest("hex");

async function makeWritable(path) {
  const stat = await lstat(path).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  await chmod(path, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory())
    for (const name of await readdir(path)) await makeWritable(join(path, name));
}

async function readTree(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const contents = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) contents.push(await readTree(child));
    else if (entry.isFile()) contents.push(await readFile(child, "utf8"));
  }
  return contents.join("\n");
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "kona-installer-test-"));
  const release = join(directory, "release");
  const home = join(directory, "home");
  const bin = join(home, "bin");
  await Promise.all([buildRelease({ root, outDir: release }), mkdir(bin, { recursive: true })]);
  const bootstrapInstaller = join(directory, "install.sh");
  await cp(join(release, "install.sh"), bootstrapInstaller);
  const transport = join(directory, "transport.sh");
  const log = join(directory, "requests.log");
  await writeFile(
    transport,
    `#!/bin/sh
set -eu
url=$1
body=$2
headers=$3
printf '%s\\n' "$url" >> "$KONA_TEST_REQUEST_LOG"
name=\${url##*/}
case "\${KONA_TEST_REDIRECT:-none}:$url" in
  approved:https://github.com/*)
    printf 'HTTP/1.1 302 Found\\r\\nlocation: https://release-assets.githubusercontent.com/%s\\r\\n\\r\\n' "$name" > "$headers"
    : > "$body"
    ;;
  evil:https://github.com/*)
    printf 'HTTP/1.1 302 Found\\r\\nLocation: https://example.invalid/%s\\r\\n\\r\\n' "$name" > "$headers"
    : > "$body"
    ;;
  *)
    printf 'HTTP/1.1 200 OK\\r\\n\\r\\n' > "$headers"
    source_release=$KONA_TEST_RELEASE
    case "$url" in
      */releases/download/v\${KONA_TEST_CURRENT_VERSION:-0.5.2}/*) source_release=\${KONA_TEST_CURRENT_RELEASE:-$source_release} ;;
    esac
    cp "$source_release/$name" "$body"
    ;;
esac
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: join(home, "data"),
    KONA_BIN_DIR: bin,
    KONA_INSTALL_TESTING: "1",
    KONA_INSTALL_TEST_TRANSPORT: transport,
    KONA_TEST_RELEASE: release,
    KONA_TEST_CURRENT_RELEASE: release,
    KONA_TEST_CURRENT_VERSION: "0.5.2",
    KONA_TEST_REQUEST_LOG: log,
  };
  return {
    directory,
    release,
    home,
    bin,
    env,
    installer: bootstrapInstaller,
    cleanup: async () => {
      await makeWritable(directory);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function install(value, overrides = {}, args = []) {
  try {
    const result = await execute("sh", [value.installer, ...args], {
      env: { ...value.env, ...overrides },
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, ...result };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function buildVersion(value, version) {
  const nextRoot = join(value.directory, `source-${version}`);
  await mkdir(join(nextRoot, ".claude-plugin"), { recursive: true });
  await cp(join(root, "plugin"), join(nextRoot, "plugin"), { recursive: true });
  await cp(
    join(root, ".claude-plugin/marketplace.json"),
    join(nextRoot, ".claude-plugin/marketplace.json"),
  );
  const installer = (await readFile(join(root, "install.sh"), "utf8")).replace(
    "KONA_VERSION='0.5.2'",
    `KONA_VERSION='${version}'`,
  );
  await Promise.all([
    writeFile(join(nextRoot, "install.sh"), installer, { mode: 0o755 }),
    writeFile(join(nextRoot, "plugin/install.sh"), installer, { mode: 0o755 }),
  ]);
  for (const path of [
    "plugin/package.json",
    "plugin/capabilities/copy.json",
    "plugin/capabilities/prd.json",
    "plugin/capabilities/spec.json",
    "plugin/capabilities/issues.json",
    "plugin/capabilities/epic-worktree.json",
    "plugin/.claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
  ]) {
    const fullPath = join(nextRoot, path);
    const content = (await readFile(fullPath, "utf8")).replace(
      '"version": "0.5.2"',
      `"version": "${version}"`,
    );
    await writeFile(fullPath, content);
  }
  return buildRelease({ root: nextRoot, outDir: join(value.directory, `release-${version}`) });
}

test("release builds are byte-identical and contain only the approved assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kona-release-test-"));
  try {
    const first = await buildRelease({ root, outDir: join(directory, "first") });
    const second = await buildRelease({ root, outDir: join(directory, "second") });
    const names = ["install.sh", first.archiveName, "SHA256SUMS"];
    for (const name of names)
      assert.equal(
        await filesEqual(join(first.releaseDir, name), join(second.releaseDir, name)),
        true,
      );
    const { stdout } = await execute("tar", ["-tzf", join(first.releaseDir, first.archiveName)]);
    const files = stdout
      .trim()
      .split("\n")
      .filter((path) => !path.endsWith("/"));
    assert.ok(files.includes("kona/skills/epic-worktree/scripts/epic-worktree.mjs"));
    assert.ok(files.includes("kona/install.sh"));
    assert.ok(files.includes("kona/lib/self-update.mjs"));
    assert.ok(
      files.includes(
        "kona/legacy/sha256/4bb86d5415ac9832a763fd3bdd243d4a8ba92456c9a67159f06fb03af032e039",
      ),
    );
    assert.deepEqual(
      files.toSorted((left, right) => left.localeCompare(right)),
      [
        "kona/MANIFEST.json",
        "kona/bin/kona",
        "kona/install.sh",
        ...RELEASE_FILES.map(([path]) => `kona/${path}`),
      ].toSorted((left, right) => left.localeCompare(right)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release assembly rejects an omitted copy resource and copy version skew", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kona-release-negative-test-"));
  try {
    const source = join(directory, "source");
    await mkdir(source);
    await Promise.all([
      cp(join(root, "plugin"), join(source, "plugin"), { recursive: true }),
      mkdir(join(source, ".claude-plugin"), { recursive: true }),
      cp(join(root, "install.sh"), join(source, "install.sh")),
    ]);
    await cp(
      join(root, ".claude-plugin/marketplace.json"),
      join(source, ".claude-plugin/marketplace.json"),
    );

    const copyManifest = join(source, "plugin/capabilities/copy.json");
    const original = await readFile(copyManifest, "utf8");
    await writeFile(copyManifest, original.replace('"version": "0.5.2"', '"version": "9.9.9"'));
    await assert.rejects(buildRelease({ root: source }), /release versions are not aligned/);

    await writeFile(copyManifest, original);
    await rm(join(source, "plugin/skills/copy/references/components.md"));
    await assert.rejects(
      buildRelease({ root: source }),
      /skills\/copy\/references\/components\.md|ENOENT/,
    );

    await cp(
      join(root, "plugin/skills/copy/references/components.md"),
      join(source, "plugin/skills/copy/references/components.md"),
    );
    await rm(join(source, "plugin/skills/issues/SKILL.md"));
    await assert.rejects(buildRelease({ root: source }), /skills\/issues\/SKILL\.md|ENOENT/);

    await cp(
      join(root, "plugin/skills/issues/SKILL.md"),
      join(source, "plugin/skills/issues/SKILL.md"),
    );
    await rm(join(source, "plugin/skills/epic-worktree/scripts/epic-worktree.mjs"));
    await assert.rejects(buildRelease({ root: source }), /epic-worktree\.mjs|ENOENT/);

    await cp(
      join(root, "plugin/skills/epic-worktree/scripts/epic-worktree.mjs"),
      join(source, "plugin/skills/epic-worktree/scripts/epic-worktree.mjs"),
    );
    const legacyPayload = join(
      source,
      "plugin/legacy/sha256/4bb86d5415ac9832a763fd3bdd243d4a8ba92456c9a67159f06fb03af032e039",
    );
    await writeFile(legacyPayload, "tampered legacy payload\n");
    await assert.rejects(buildRelease({ root: source }), /legacy payload hash drift/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release assembly rejects SemVer components with leading zeroes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kona-release-semver-test-"));
  try {
    const source = join(directory, "source");
    await mkdir(join(source, ".claude-plugin"), { recursive: true });
    await Promise.all([
      cp(join(root, "plugin"), join(source, "plugin"), { recursive: true }),
      cp(join(root, "install.sh"), join(source, "install.sh")),
      cp(
        join(root, ".claude-plugin/marketplace.json"),
        join(source, ".claude-plugin/marketplace.json"),
      ),
    ]);
    const packagePath = join(source, "plugin/package.json");
    await writeFile(
      packagePath,
      (await readFile(packagePath, "utf8")).replace('"version": "0.5.2"', '"version": "01.0.0"'),
    );
    await assert.rejects(buildRelease({ root: source }), /SemVer X\.Y\.Z: 01\.0\.0/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release archive extracts into 0755 directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kona-release-extraction-test-"));
  try {
    const release = await buildRelease({ root, outDir: join(directory, "release") });
    const unpacked = join(directory, "unpacked");
    await mkdir(unpacked);
    await execute("tar", ["-xzf", join(release.releaseDir, release.archiveName), "-C", unpacked]);
    for (const path of [
      "kona",
      "kona/.claude-plugin",
      "kona/bin",
      "kona/capabilities",
      "kona/hosts",
      "kona/hosts/opencode",
      "kona/hosts/opencode/agents",
      "kona/lib",
      "kona/legacy",
      "kona/legacy/sha256",
      "kona/skills",
      "kona/skills/copy",
      "kona/skills/copy/references",
      "kona/skills/prd",
      "kona/skills/prd/templates",
      "kona/skills/spec",
      "kona/skills/spec/templates",
      "kona/skills/issues",
    ])
      assert.equal((await lstat(join(unpacked, path))).mode & 0o777, 0o755, path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("staged release archive recursively contains no guidelines dependency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kona-release-guidelines-test-"));
  try {
    const release = await buildRelease({ root, outDir: join(directory, "release") });
    const unpacked = join(directory, "unpacked");
    await mkdir(unpacked);
    await execute("tar", ["-xzf", join(release.releaseDir, release.archiveName), "-C", unpacked]);
    assert.doesNotMatch(await readTree(join(unpacked, "kona")), /guidelines[\\/]/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer verifies and atomically installs an immutable version, then is a no-op", async () => {
  const value = await fixture();
  try {
    value.env.KONA_TEST_REDIRECT = "approved";
    const installed = await install(value);
    assert.equal(installed.code, 0, installed.stderr);
    assert.match(installed.stdout, /installed kona 0\.5\.2/);
    const link = join(value.bin, "kona");
    const target = await readlink(link);
    assert.equal(target, join(value.home, "data/kona/versions/v0.5.2/bin/kona"));
    assert.equal((await lstat(target)).mode & 0o777, 0o555);
    const { stdout: help } = await execute(link, ["--help"], { env: value.env });
    assert.match(help, /^Usage: kona <install\|update\|verify\|disable\|enable\|remove>/);
    assert.equal(
      (await lstat(join(value.home, "data/kona/install-state.json"))).mode & 0o777,
      0o600,
    );
    const stateBefore = await readFile(join(value.home, "data/kona/install-state.json"));
    const repeated = await install(value);
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.match(repeated.stdout, /already installed/);
    assert.deepEqual(await readFile(join(value.home, "data/kona/install-state.json")), stateBefore);
    const requests = await readFile(join(value.directory, "requests.log"), "utf8");
    assert.match(requests, /\/releases\/download\/v0\.5\.2\/SHA256SUMS/);
    assert.match(requests, /\/releases\/download\/v0\.5\.2\/kona-v0\.5\.2-portable\.tar\.gz/);
    assert.doesNotMatch(requests, /releases\/latest/);
  } finally {
    await value.cleanup();
  }
});

test("authenticated --latest verifies the discovered installer and runs normal mode quietly", async () => {
  const value = await fixture();
  try {
    const installed = await install(value, {}, ["--latest"]);
    assert.equal(installed.code, 0, installed.stderr);
    assert.equal(installed.stdout, "");
    assert.equal(
      await readlink(join(value.bin, "kona")),
      join(value.home, "data/kona/versions/v0.5.2/bin/kona"),
    );
    const requests = (await readFile(join(value.directory, "requests.log"), "utf8"))
      .trim()
      .split("\n");
    assert.equal(
      requests.filter((url) => url.includes("/releases/latest/download/install.sh")).length,
      1,
    );
    assert.ok(
      requests.includes(
        "https://github.com/open-treasury/kona/releases/download/v0.5.2/SHA256SUMS",
      ),
    );
  } finally {
    await value.cleanup();
  }
});

test("authenticated --latest rejects malformed discovery and installer checksum records", async () => {
  for (const variant of ["malformed-version", "missing", "duplicate", "malformed", "mismatch"]) {
    const value = await fixture();
    try {
      if (variant === "malformed-version") {
        await writeFile(join(value.release, "install.sh"), "#!/bin/sh\nKONA_VERSION=$(id)\n");
      } else {
        const sums = (await readFile(join(value.release, "SHA256SUMS"), "utf8")).split("\n");
        const installerRecord = sums.find((line) => line.endsWith("  install.sh"));
        const archiveRecord = sums.find((line) => line.includes("portable.tar.gz"));
        const records = {
          missing: `${archiveRecord}\n`,
          duplicate: `${installerRecord}\n${installerRecord}\n${archiveRecord}\n`,
          malformed: `not-a-hash  install.sh\n${archiveRecord}\n`,
          mismatch: `${"0".repeat(64)}  install.sh\n${archiveRecord}\n`,
        };
        await writeFile(join(value.release, "SHA256SUMS"), records[variant]);
      }
      const refused = await install(value, {}, ["--latest"]);
      assert.notEqual(refused.code, 0, variant);
      await assert.rejects(lstat(join(value.bin, "kona")), { code: "ENOENT" });
    } finally {
      await value.cleanup();
    }
  }
});

test("source --latest skips an older candidate while preserving a newer active release", async () => {
  const value = await fixture();
  try {
    assert.equal((await install(value)).code, 0);
    const link = join(value.bin, "kona");

    const newer = await buildVersion(value, "0.6.0");
    value.env.KONA_TEST_RELEASE = newer.releaseDir;
    const upgraded = await install(value, {}, ["--latest"]);
    assert.equal(upgraded.code, 0, upgraded.stderr);
    assert.equal(await readlink(link), join(value.home, "data/kona/versions/v0.6.0/bin/kona"));

    const older = await buildVersion(value, "0.5.1");
    value.env.KONA_TEST_RELEASE = older.releaseDir;
    await writeFile(join(value.directory, "requests.log"), "");
    const skipped = await install(value, {}, ["--latest"]);
    assert.equal(skipped.code, 0, skipped.stderr);
    assert.equal(await readlink(link), join(value.home, "data/kona/versions/v0.6.0/bin/kona"));
    assert.doesNotMatch(
      await readFile(join(value.directory, "requests.log"), "utf8"),
      /kona-v0\.5\.1-portable\.tar\.gz/,
    );
  } finally {
    await value.cleanup();
  }
});

test("authenticated --latest installs bundled current when discovery is older and no binary exists", async () => {
  const value = await fixture();
  try {
    const older = await buildVersion(value, "0.5.1");
    value.env.KONA_TEST_RELEASE = older.releaseDir;
    const installed = await install(value, {}, ["--latest"]);
    assert.equal(installed.code, 0, installed.stderr);
    assert.equal(
      await readlink(join(value.bin, "kona")),
      join(value.home, "data/kona/versions/v0.5.2/bin/kona"),
    );
  } finally {
    await value.cleanup();
  }
});

test("authenticated --latest never executes an incompatible pre-0.5.1 installer", async () => {
  const value = await fixture();
  try {
    const executed = join(value.directory, "older-executed");
    const incompatible = `#!/bin/sh\nKONA_VERSION='0.4.9'\ntouch ${JSON.stringify(executed)}\nprintf 'pre-0.5.1 installer rejects downgrade\\n' >&2\nexit 91\n`;
    await writeFile(join(value.release, "install.sh"), incompatible, { mode: 0o755 });
    const currentSums = await readFile(join(value.release, "SHA256SUMS"), "utf8");
    const archiveRecord = currentSums.split("\n").find((line) => line.includes("portable.tar.gz"));
    await writeFile(
      join(value.release, "SHA256SUMS"),
      `${digest(incompatible)}  install.sh\n${archiveRecord}\n`,
    );

    const installed = await install(value, {}, ["--latest"]);
    assert.equal(installed.code, 0, installed.stderr);
    await assert.rejects(lstat(executed), { code: "ENOENT" });
    assert.equal(
      await readlink(join(value.bin, "kona")),
      join(value.home, "data/kona/versions/v0.5.2/bin/kona"),
    );
  } finally {
    await value.cleanup();
  }
});

test("installer compares huge SemVer components without numeric coercion", async () => {
  const value = await fixture();
  try {
    const currentVersion = `0.${"9".repeat(40)}.0`;
    const olderVersion = `0.${"8".repeat(40)}.0`;
    const newerVersion = `0.${"1".repeat(41)}.0`;
    const current = await buildVersion(value, currentVersion);
    const older = await buildVersion(value, olderVersion);
    value.installer = join(current.releaseDir, "install.sh");
    value.env.KONA_TEST_CURRENT_RELEASE = current.releaseDir;
    value.env.KONA_TEST_CURRENT_VERSION = currentVersion;
    value.env.KONA_TEST_RELEASE = older.releaseDir;

    const installed = await install(value, {}, ["--latest"]);
    assert.equal(installed.code, 0, installed.stderr);
    assert.equal(
      await readlink(join(value.bin, "kona")),
      join(value.home, `data/kona/versions/v${currentVersion}/bin/kona`),
    );

    const newer = await buildVersion(value, newerVersion);
    value.env.KONA_TEST_RELEASE = newer.releaseDir;
    const upgraded = await install(value, {}, ["--latest"]);
    assert.equal(upgraded.code, 0, upgraded.stderr);
    assert.equal(
      await readlink(join(value.bin, "kona")),
      join(value.home, `data/kona/versions/v${newerVersion}/bin/kona`),
    );

    value.env.KONA_TEST_RELEASE = older.releaseDir;
    const preserved = await install(value, {}, ["--latest"]);
    assert.equal(preserved.code, 0, preserved.stderr);
    assert.equal(
      await readlink(join(value.bin, "kona")),
      join(value.home, `data/kona/versions/v${newerVersion}/bin/kona`),
    );
  } finally {
    await value.cleanup();
  }
});

test("installer refuses unapproved redirects before contacting them", async () => {
  const value = await fixture();
  try {
    const result = await install(value, { KONA_TEST_REDIRECT: "evil" });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /refusing unapproved redirect/);
    const requests = (await readFile(join(value.directory, "requests.log"), "utf8"))
      .trim()
      .split("\n");
    assert.equal(requests.length, 1);
    assert.match(
      requests[0],
      /^https:\/\/github\.com\/open-treasury\/kona\/releases\/download\/v0\.5\.2\//,
    );
  } finally {
    await value.cleanup();
  }
});

test("checksum failure and an unowned destination preserve existing files", async () => {
  const value = await fixture();
  try {
    const destination = join(value.bin, "kona");
    await writeFile(destination, "unowned\n", { mode: 0o755 });
    const refused = await install(value);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /unowned destination/);
    assert.equal(await readFile(destination, "utf8"), "unowned\n");

    await rm(destination);
    const archive = join(value.release, "kona-v0.5.2-portable.tar.gz");
    await writeFile(archive, Buffer.concat([await readFile(archive), Buffer.from("changed")]));
    const checksum = await install(value);
    assert.notEqual(checksum.code, 0);
    assert.match(checksum.stderr, /checksum verification failed/);
    await assert.rejects(lstat(destination), { code: "ENOENT" });
  } finally {
    await value.cleanup();
  }
});

test("installer rejects an internally corrupted archive after its external checksum passes", async () => {
  const value = await fixture();
  try {
    const unpacked = join(value.directory, "unpacked");
    const archive = join(value.release, "kona-v0.5.2-portable.tar.gz");
    await mkdir(unpacked);
    await execute("tar", ["-xzf", archive, "-C", unpacked]);
    const skill = join(unpacked, "kona/skills/copy/SKILL.md");
    await chmod(skill, 0o644);
    await writeFile(skill, "corrupted after manifest creation\n");
    await execute("tar", ["-czf", archive, "-C", unpacked, "kona"]);
    const archiveHash = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    const installerHash = createHash("sha256")
      .update(await readFile(join(value.release, "install.sh")))
      .digest("hex");
    await writeFile(
      join(value.release, "SHA256SUMS"),
      `${installerHash}  install.sh\n${archiveHash}  kona-v0.5.2-portable.tar.gz\n`,
    );
    const refused = await install(value);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /internal manifest hash mismatch/);
    await assert.rejects(lstat(join(value.bin, "kona")), { code: "ENOENT" });
  } finally {
    await value.cleanup();
  }
});

test("installer rejects an archive missing the copy manifest after its external checksum passes", async () => {
  const value = await fixture();
  try {
    const unpacked = join(value.directory, "unpacked-missing-copy");
    const archive = join(value.release, "kona-v0.5.2-portable.tar.gz");
    await mkdir(unpacked);
    await execute("tar", ["-xzf", archive, "-C", unpacked]);
    await rm(join(unpacked, "kona/capabilities/copy.json"));
    await execute("tar", ["-czf", archive, "-C", unpacked, "kona"]);
    const archiveHash = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    const installerHash = createHash("sha256")
      .update(await readFile(join(value.release, "install.sh")))
      .digest("hex");
    await writeFile(
      join(value.release, "SHA256SUMS"),
      `${installerHash}  install.sh\n${archiveHash}  kona-v0.5.2-portable.tar.gz\n`,
    );

    const refused = await install(value);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /verified installation failed/);
    await assert.rejects(lstat(join(value.bin, "kona")), { code: "ENOENT" });
  } finally {
    await value.cleanup();
  }
});

test("tampered owned versions are refused without changing the active link", async () => {
  const value = await fixture();
  try {
    assert.equal((await install(value)).code, 0);
    const link = join(value.bin, "kona");
    const active = await readlink(link);
    const skill = join(value.home, "data/kona/versions/v0.5.2/skills/copy/SKILL.md");
    await chmod(skill, 0o644);
    await writeFile(skill, "tampered\n", { mode: 0o444 });
    const refused = await install(value);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /manifest hash mismatch/);
    assert.equal(await readlink(link), active);
  } finally {
    await value.cleanup();
  }
});

test("unsafe ownership state is refused without changing the active link", async () => {
  const value = await fixture();
  try {
    assert.equal((await install(value)).code, 0);
    const link = join(value.bin, "kona");
    const active = await readlink(link);
    const state = join(value.home, "data/kona/install-state.json");
    await chmod(state, 0o644);
    const refused = await install(value);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /ownership state is not protected/);
    assert.equal(await readlink(link), active);
  } finally {
    await value.cleanup();
  }
});

test("a verified upgrade preserves the old immutable version and atomically activates the new one", async () => {
  const value = await fixture();
  try {
    assert.equal((await install(value)).code, 0);
    const previous = await readlink(join(value.bin, "kona"));
    const next = await buildVersion(value, "0.6.0");
    value.installer = join(next.releaseDir, "install.sh");
    value.env.KONA_TEST_RELEASE = next.releaseDir;
    const upgraded = await install(value);
    assert.equal(upgraded.code, 0, upgraded.stderr);
    assert.match(upgraded.stdout, /installed kona 0\.6\.0/);
    assert.equal(
      await readlink(join(value.bin, "kona")),
      join(value.home, "data/kona/versions/v0.6.0/bin/kona"),
    );
    assert.equal((await lstat(previous)).isFile(), true);
  } finally {
    await value.cleanup();
  }
});

test("installer refuses a downgrade and preserves the newer active release", async () => {
  const value = await fixture();
  try {
    assert.equal((await install(value)).code, 0);
    const link = join(value.bin, "kona");
    const active = await readlink(link);
    const state = await readFile(join(value.home, "data/kona/install-state.json"));

    const older = await buildVersion(value, "0.5.0");
    value.installer = join(older.releaseDir, "install.sh");
    value.env.KONA_TEST_RELEASE = older.releaseDir;
    const refused = await install(value);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /refusing downgrade from 0\.5\.2 to 0\.5\.0/);
    assert.equal(await readlink(link), active);
    assert.deepEqual(await readFile(join(value.home, "data/kona/install-state.json")), state);
  } finally {
    await value.cleanup();
  }
});

test("failed newer release verification preserves the prior active version", async () => {
  const value = await fixture();
  try {
    assert.equal((await install(value)).code, 0);
    const link = join(value.bin, "kona");
    const active = await readlink(link);

    const next = await buildVersion(value, "0.6.0");
    const nextArchive = join(next.releaseDir, next.archiveName);
    await writeFile(
      nextArchive,
      Buffer.concat([await readFile(nextArchive), Buffer.from("broken")]),
    );
    value.installer = join(next.releaseDir, "install.sh");
    value.env.KONA_TEST_RELEASE = next.releaseDir;
    const failed = await install(value);
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /checksum verification failed/);
    assert.equal(await readlink(link), active);
  } finally {
    await value.cleanup();
  }
});

test("activation failure leaves the prior release active and records no false ownership", async () => {
  const value = await fixture();
  try {
    assert.equal((await install(value)).code, 0);
    const link = join(value.bin, "kona");
    const active = await readlink(link);
    const statePath = join(value.home, "data/kona/install-state.json");
    const state = await readFile(statePath);
    const next = await buildVersion(value, "0.6.0");
    value.installer = join(next.releaseDir, "install.sh");
    value.env.KONA_TEST_RELEASE = next.releaseDir;

    const failed = await install(value, { KONA_INSTALL_TEST_FAIL_BEFORE_ACTIVATE: "1" });
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /injected failure before activation/);
    assert.equal(await readlink(link), active);
    assert.deepEqual(await readFile(statePath), state);
    const retried = await install(value);
    assert.equal(retried.code, 0, retried.stderr);
    assert.equal(await readlink(link), join(value.home, "data/kona/versions/v0.6.0/bin/kona"));
  } finally {
    await value.cleanup();
  }
});

test("a crash-created uncommitted version is recovered only through its durable journal", async () => {
  const value = await fixture();
  try {
    const crashed = await install(value, { KONA_INSTALL_TEST_CRASH_AFTER_VERSION: "1" });
    assert.notEqual(crashed.code, 0);
    assert.equal(
      (await lstat(join(value.home, "data/kona/activation-journal.json"))).isFile(),
      true,
    );
    const retried = await install(value);
    assert.equal(retried.code, 0, retried.stderr);
    assert.equal(
      await readlink(join(value.bin, "kona")),
      join(value.home, "data/kona/versions/v0.5.2/bin/kona"),
    );
    await assert.rejects(lstat(join(value.home, "data/kona/activation-journal.json")), {
      code: "ENOENT",
    });
  } finally {
    await value.cleanup();
  }
});

test("concurrent installers serialize activation and never remove the installed winner", async () => {
  const value = await fixture();
  try {
    const [first, second] = await Promise.all([
      install(value, { KONA_INSTALL_TEST_HOLD_LOCK_MS: "200" }),
      install(value),
    ]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    const link = join(value.bin, "kona");
    assert.equal(await readlink(link), join(value.home, "data/kona/versions/v0.5.2/bin/kona"));
    assert.equal((await lstat(await readlink(link))).isFile(), true);
    const state = JSON.parse(
      await readFile(join(value.home, "data/kona/install-state.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(state.versions), ["v0.5.2"]);
  } finally {
    await value.cleanup();
  }
});

test("installer never invokes sudo or modifies shell startup files", async () => {
  const value = await fixture();
  try {
    const fakeBin = join(value.directory, "fake-bin");
    const sudoLog = join(value.directory, "sudo.log");
    await mkdir(fakeBin);
    await writeFile(
      join(fakeBin, "sudo"),
      `#!/bin/sh\nprintf 'called\\n' >> "${sudoLog}"\nexit 99\n`,
      { mode: 0o755 },
    );
    const startup = [".profile", ".bashrc", ".zshrc"];
    for (const name of startup) await writeFile(join(value.home, name), `${name} canary\n`);

    const installed = await install(value, { PATH: `${fakeBin}:${process.env.PATH}` });
    assert.equal(installed.code, 0, installed.stderr);
    await assert.rejects(lstat(sudoLog), { code: "ENOENT" });
    for (const name of startup)
      assert.equal(await readFile(join(value.home, name), "utf8"), `${name} canary\n`);
  } finally {
    await value.cleanup();
  }
});
