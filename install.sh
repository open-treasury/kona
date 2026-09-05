#!/bin/sh
set -eu

KONA_VERSION='0.4.1'
KONA_TAG="v${KONA_VERSION}"
KONA_ARCHIVE="kona-${KONA_TAG}-portable.tar.gz"
KONA_RELEASE_URL="https://github.com/open-treasury/kona/releases/download/v${KONA_VERSION}"
KONA_PUBLIC_INSTALL_URL='https://github.com/open-treasury/kona/releases/latest/download/install.sh'
KONA_MAX_REDIRECTS=5

fail() {
  printf 'kona installer: %s\n' "$*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail 'Node.js 20 or newer is required'
command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v tar >/dev/null 2>&1 || fail 'tar is required'

node -e 'const major=Number(process.versions.node.split(".")[0]); process.exit(major >= 20 ? 0 : 1)' ||
  fail 'Node.js 20 or newer is required'

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) fail 'only macOS and Linux are supported' ;;
esac

if command -v sha256sum >/dev/null 2>&1; then
  sha256_file() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  fail 'sha256sum or shasum is required'
fi

approved_url() {
  case "$1" in
    https://github.com/*|https://release-assets.githubusercontent.com/*|https://objects.githubusercontent.com/*|https://github-releases.githubusercontent.com/*) return 0 ;;
    *) return 1 ;;
  esac
}

fetch_once() {
  url=$1
  body=$2
  headers=$3
  if [ "${KONA_INSTALL_TESTING:-}" = '1' ] && [ -n "${KONA_INSTALL_TEST_TRANSPORT:-}" ]; then
    "${KONA_INSTALL_TEST_TRANSPORT}" "$url" "$body" "$headers"
  else
    curl --silent --show-error --proto '=https' --max-redirs 0 \
      --dump-header "$headers" --output "$body" "$url"
  fi
}

fetch() {
  url=$1
  destination=$2
  redirects=0
  approved_url "$url" || fail "refusing unapproved URL: $url"
  while :; do
    headers="${destination}.headers"
    body="${destination}.part"
    rm -f "$headers" "$body"
    fetch_once "$url" "$body" "$headers" || fail "download failed: $url"
    status=$(awk '/^HTTP\// { code=$2 } END { print code }' "$headers")
    case "$status" in
      200)
        mv "$body" "$destination"
        rm -f "$headers"
        return
        ;;
      301|302|303|307|308)
        redirects=$((redirects + 1))
        [ "$redirects" -le "$KONA_MAX_REDIRECTS" ] || fail 'release redirect limit exceeded'
        location=$(awk 'tolower($0) ~ /^location:/ { sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); value=$0 } END { print value }' "$headers")
        [ -n "$location" ] || fail 'release redirect omitted Location'
        approved_url "$location" || fail "refusing unapproved redirect: $location"
        url=$location
        ;;
      *) fail "unexpected HTTP status ${status:-unknown} from $url" ;;
    esac
  done
}

umask 077
work=$(mktemp -d "${TMPDIR:-/tmp}/kona-install.XXXXXX") || fail 'could not create private staging directory'
cleanup() {
  chmod -R u+w "$work" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM

checksums="$work/SHA256SUMS"
archive="$work/$KONA_ARCHIVE"
fetch "$KONA_RELEASE_URL/SHA256SUMS" "$checksums"
fetch "$KONA_RELEASE_URL/$KONA_ARCHIVE" "$archive"

checksum_record=$(awk -v name="$KONA_ARCHIVE" '
  $2 == name && length($1) == 64 && $1 ~ /^[0-9a-f]+$/ { hash=$1; count++ }
  END { if (count == 1) print hash, count }
' "$checksums")
set -- $checksum_record
[ "$#" -eq 2 ] || fail "SHA256SUMS must contain exactly one valid $KONA_ARCHIVE record"
expected_checksum=$1
actual_checksum=$(sha256_file "$archive")
[ "$actual_checksum" = "$expected_checksum" ] || fail 'archive checksum verification failed'

tar -tzf "$archive" > "$work/archive.list" || fail 'archive cannot be listed'
while IFS= read -r entry; do
  case "$entry" in
    kona|kona/*) ;;
    *) fail "archive path escapes portable root: $entry" ;;
  esac
  safe_entry=${entry%/}
  case "/$safe_entry/" in
    *'/../'*|*'/./'*|*'//'*) fail "archive contains an unsafe path: $entry" ;;
  esac
done < "$work/archive.list"
tar -tvzf "$archive" > "$work/archive.verbose" || fail 'archive metadata cannot be listed'
while IFS= read -r entry; do
  type=$(printf '%s' "$entry" | cut -c1)
  case "$type" in
    -|d) ;;
    *) fail 'archive links and special files are not allowed' ;;
  esac
done < "$work/archive.verbose"

mkdir "$work/extracted"
tar -xpzf "$archive" -C "$work/extracted" || fail 'archive extraction failed'
[ -d "$work/extracted/kona" ] || fail 'archive portable root is missing'

cat > "$work/install-helper.mjs" <<'KONA_NODE'
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [sourceRoot, dataRoot, binDir, version, tag, archiveHash] = process.argv.slice(2);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const exists = async (path) => lstat(path).then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error));
const mode = (stat) => stat.mode & 0o777;
const fail = (message) => { throw new Error(message); };
const compareVersions = (left, right) => {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
};

async function assertDirectory(path, label) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a real directory`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) fail(`${label} is not owned by the current user`);
  if ((mode(stat) & 0o022) !== 0) fail(`${label} is writable by another user`);
}

async function readProtectedJson(path, label) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || mode(stat) !== 0o600) fail(`${label} is not protected`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) fail(`${label} has another owner`);
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { fail(`${label} is invalid JSON`); }
}

async function walk(root, current = "") {
  const names = await readdir(join(root, current));
  const result = [];
  for (const name of names.toSorted()) {
    const path = current ? join(current, name) : name;
    const stat = await lstat(join(root, path));
    if (stat.isSymbolicLink()) fail(`manifest payload contains a symbolic link: ${path}`);
    if (stat.isDirectory()) result.push(...await walk(root, path));
    else if (stat.isFile()) result.push(path.split(sep).join("/"));
    else fail(`manifest payload contains a special file: ${path}`);
  }
  return result;
}

async function validatePayload(root, expectedVersion = version, expectedTag = tag) {
  const manifestPath = join(root, "MANIFEST.json");
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) fail("MANIFEST.json is not a regular file");
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch { fail("MANIFEST.json is invalid JSON"); }
  if (manifest.schemaVersion !== 1 || manifest.name !== "kona" || manifest.version !== expectedVersion || manifest.tag !== expectedTag)
    fail("internal manifest release identity does not match the installer");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail("internal manifest file list is invalid");
  const expected = new Set(["MANIFEST.json"]);
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || !/^[A-Za-z0-9._/-]+$/.test(file.path) || file.path.startsWith("/") || file.path.split("/").includes(".."))
      fail("internal manifest contains an unsafe path");
    if (expected.has(file.path) || !/^[0-9a-f]{64}$/.test(file.sha256) || !/^0[45][0-7]{2}$/.test(file.mode))
      fail(`internal manifest entry is invalid: ${file.path}`);
    expected.add(file.path);
    const path = resolve(root, file.path);
    if (relative(root, path).startsWith(`..${sep}`)) fail(`internal manifest path escapes root: ${file.path}`);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`manifest entry is not a regular file: ${file.path}`);
    if (hash(await readFile(path)) !== file.sha256) fail(`internal manifest hash mismatch: ${file.path}`);
    if (mode(stat) !== Number.parseInt(file.mode, 8)) fail(`internal manifest mode mismatch: ${file.path}`);
  }
  const actual = await walk(root);
  if (actual.length !== expected.size || actual.some((path) => !expected.has(path)))
    fail("portable payload contains files outside the internal manifest");
  return manifest;
}

async function copyTree(source, destination) {
  await mkdir(destination, { mode: 0o700 });
  for (const name of await readdir(source)) {
    const from = join(source, name);
    const to = join(destination, name);
    const stat = await lstat(from);
    if (stat.isDirectory()) await copyTree(from, to);
    else {
      await copyFile(from, to);
      await chmod(to, mode(stat));
    }
  }
}

async function makeImmutable(root, manifest) {
  for (const file of manifest.files) await chmod(join(root, file.path), Number.parseInt(file.mode, 8));
  await chmod(join(root, "MANIFEST.json"), 0o444);
  async function lockDirectories(path) {
    for (const name of await readdir(path)) {
      const child = join(path, name);
      if ((await lstat(child)).isDirectory()) await lockDirectories(child);
    }
    await chmod(path, 0o555);
  }
  await lockDirectories(root);
}

async function removeTree(root) {
  if (!(await exists(root))) return;
  const stat = await lstat(root);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    await chmod(root, 0o700);
    for (const name of await readdir(root)) await removeTree(join(root, name));
  } else if (!stat.isSymbolicLink()) {
    await chmod(root, 0o600);
  }
  await rm(root, { recursive: true, force: true });
}

async function readState(path) {
  if (!(await exists(path))) return null;
  const state = await readProtectedJson(path, "install ownership state");
  if (state.schemaVersion !== 1 || state.name !== "kona" || state.dataRoot !== dataRoot || state.bin !== join(binDir, "kona") || !state.versions || Array.isArray(state.versions))
    fail("install ownership state is invalid");
  for (const [ownedTag, digest] of Object.entries(state.versions)) {
    if (!/^v\d+\.\d+\.\d+$/.test(ownedTag) || !/^[0-9a-f]{64}$/.test(digest)) fail("install ownership state contains an invalid version");
  }
  return state;
}

async function acquireInstallLock(path) {
  const token = `${process.pid}-${randomUUID()}`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await mkdir(path, { mode: 0o700 });
      await writeState(join(path, "owner.json"), { pid: process.pid, token });
      return async () => {
        const owner = await readProtectedJson(join(path, "owner.json"), "install lock owner").catch(() => null);
        if (owner?.token === token) await rm(path, { recursive: true, force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await assertDirectory(path, "Kona install lock");
    const ownerPath = join(path, "owner.json");
    if (!(await exists(ownerPath))) { await delay(25); continue; }
    const owner = await readProtectedJson(ownerPath, "install lock owner");
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || typeof owner.token !== "string")
      fail("install lock owner cannot be verified");
    let live = true;
    try { process.kill(owner.pid, 0); }
    catch (error) { if (error.code === "ESRCH") live = false; else throw error; }
    if (live) { await delay(25); continue; }
    let reclaim;
    try { reclaim = await open(join(path, "reclaim"), "wx", 0o600); }
    catch (error) { if (error.code === "EEXIST" || error.code === "ENOENT") { await delay(25); continue; } throw error; }
    await reclaim.close();
    const current = await readProtectedJson(join(path, "owner.json"), "install lock owner").catch(() => null);
    if (current?.token === owner.token) await rm(path, { recursive: true, force: true });
    else await rm(join(path, "reclaim"), { force: true });
  }
  fail("another Kona installer holds the install lock");
}

async function writeState(path, state) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

const sourceManifest = await validatePayload(sourceRoot);
const dataExisted = await exists(dataRoot);
if (dataExisted) await assertDirectory(dataRoot, "Kona data root");
else await mkdir(dataRoot, { recursive: true, mode: 0o700 });
await chmod(dataRoot, 0o700);

const releaseLock = await acquireInstallLock(join(dataRoot, "install.lock"));
try {
if (process.env.KONA_INSTALL_TESTING === "1" && process.env.KONA_INSTALL_TEST_HOLD_LOCK_MS)
  await delay(Number(process.env.KONA_INSTALL_TEST_HOLD_LOCK_MS));

const statePath = join(dataRoot, "install-state.json");
let state = await readState(statePath);
const versionsRoot = join(dataRoot, "versions");
if (await exists(versionsRoot)) await assertDirectory(versionsRoot, "Kona versions root");
else await mkdir(versionsRoot, { mode: 0o700 });

const activationPath = join(dataRoot, "activation-journal.json");
if (await exists(activationPath)) {
  const activation = await readProtectedJson(activationPath, "activation journal");
  const expectedVersionRoot = join(versionsRoot, activation.tag || "invalid");
  const expectedStage = join(dataRoot, activation.stageName || "invalid");
  if (
    activation.schemaVersion !== 1 || activation.name !== "kona" ||
    activation.versionRoot !== expectedVersionRoot || activation.stage !== expectedStage ||
    activation.archiveHash == null || !/^[0-9a-f]{64}$/.test(activation.archiveHash) ||
    !/^v\d+\.\d+\.\d+$/.test(activation.tag || "") ||
    !/^\.stage-v\d+\.\d+\.\d+-[0-9a-f-]+$/.test(activation.stageName || "") ||
    (activation.previousState !== null && typeof activation.previousState !== "object")
  ) fail("activation journal is invalid");
  const journalTarget = join(expectedVersionRoot, "bin/kona");
  const active = await exists(join(binDir, "kona")) && (await lstat(join(binDir, "kona"))).isSymbolicLink()
    ? await readlink(join(binDir, "kona")) : null;
  const committed = active === journalTarget && state?.versions?.[activation.tag] === activation.archiveHash;
  if (!committed) {
    if (active === journalTarget) fail("activation journal cannot safely roll back the active version");
    await removeTree(expectedStage);
    await removeTree(expectedVersionRoot);
    state = activation.previousState;
    if (state) await writeState(statePath, state);
    else await rm(statePath, { force: true });
  }
  await rm(activationPath, { force: true });
}

if (!state && dataExisted) {
  const entries = (await readdir(dataRoot)).filter((entry) => entry !== "install.lock" && entry !== "versions");
  const versions = await readdir(versionsRoot);
  if (entries.length !== 0 || versions.length !== 0) fail("existing Kona data root has no valid ownership state");
}
const binPath = join(binDir, "kona");
if (await exists(binDir)) await assertDirectory(binDir, "Kona bin directory");
else await mkdir(binDir, { recursive: true, mode: 0o755 });

const binExists = await exists(binPath);
let activeTarget = null;
if (binExists) {
  const stat = await lstat(binPath);
  if (!state || !stat.isSymbolicLink()) fail(`refusing to replace unowned destination: ${binPath}`);
  activeTarget = await readlink(binPath);
  const relativeTarget = relative(versionsRoot, activeTarget);
  const activeTag = relativeTarget.split(sep)[0];
  if (activeTarget !== join(versionsRoot, activeTag, "bin/kona") || !state.versions[activeTag])
    fail(`refusing to replace unowned destination: ${binPath}`);
  await validatePayload(join(versionsRoot, activeTag), activeTag.slice(1), activeTag);
  if (compareVersions(version, activeTag.slice(1)) < 0)
    fail(`refusing downgrade from ${activeTag.slice(1)} to ${version}`);
} else if (state) {
  fail("owned Kona activation link is missing");
}

const ownedStateBeforeActivation = state ? structuredClone(state) : null;
state ||= { schemaVersion: 1, name: "kona", dataRoot, bin: binPath, versions: {} };
const versionRoot = join(versionsRoot, tag);
let activation = null;
if (await exists(versionRoot)) {
  if (state.versions[tag] !== archiveHash) fail(`existing ${tag} directory is not owned by this release`);
  await validatePayload(versionRoot);
} else {
  const privateStage = join(dataRoot, `.stage-${tag}-${randomUUID()}`);
  activation = {
    schemaVersion: 1,
    name: "kona",
    tag,
    archiveHash,
    versionRoot,
    stage: privateStage,
    stageName: privateStage.slice(dataRoot.length + 1),
    previousState: ownedStateBeforeActivation,
  };
  await writeState(activationPath, activation);
  try {
    await copyTree(sourceRoot, privateStage);
    await validatePayload(privateStage);
    await rename(privateStage, versionRoot);
    await makeImmutable(versionRoot, sourceManifest);
    if (process.env.KONA_INSTALL_TESTING === "1" && process.env.KONA_INSTALL_TEST_CRASH_AFTER_VERSION === "1")
      process.exit(86);
  } catch (error) {
    await removeTree(privateStage);
    if (await exists(versionRoot)) await removeTree(versionRoot);
    await rm(activationPath, { force: true });
    throw error;
  }
}

const target = join(versionRoot, "bin/kona");
if (binExists && await readlink(binPath) === target) {
  if (activation) await rm(activationPath, { force: true });
  console.log(`kona ${version} is already installed at ${binPath}`);
  process.exit(0);
}

if (process.env.KONA_INSTALL_TESTING === "1" && process.env.KONA_INSTALL_TEST_FAIL_BEFORE_ACTIVATE === "1")
  {
    if (activation) {
      await removeTree(versionRoot);
      await rm(activationPath, { force: true });
    }
    fail("injected failure before activation");
  }

state.versions[tag] = archiveHash;
await writeState(statePath, state);
if (!binExists) {
  await symlink(target, binPath);
  if (activation) await rm(activationPath, { force: true });
  console.log(`installed kona ${version} at ${binPath}`);
  process.exit(0);
}
const temporaryLink = join(binDir, `.kona-${process.pid}-${randomUUID()}`);
await symlink(target, temporaryLink);
try { await rename(temporaryLink, binPath); }
catch (error) { await rm(temporaryLink, { force: true }); throw error; }
if (activation) await rm(activationPath, { force: true });
console.log(`installed kona ${version} at ${binPath}`);
} finally {
  await releaseLock();
}
KONA_NODE

data_root="${XDG_DATA_HOME:-$HOME/.local/share}/kona"
bin_dir="${KONA_BIN_DIR:-$HOME/.local/bin}"
node "$work/install-helper.mjs" "$work/extracted/kona" "$data_root" "$bin_dir" \
  "$KONA_VERSION" "$KONA_TAG" "$actual_checksum" || fail 'verified installation failed'
