import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const SELF_UPDATE_MARKER = "KONA_SELF_UPDATE_REEXEC";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_ERROR_BYTES = 8 * 1024;
const SOURCE_INSTALLER_SHA256 = "5a0ed508fd31ef7db3e056e04648bbb26fc5c5233c6e0547d0cdcb8110772582";
const REQUIRED_FILES = new Map([
  ["bin/kona", "0555"],
  ["install.sh", "0555"],
  ["lib/self-update.mjs", "0444"],
  ["package.json", "0444"],
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const modeOf = (stat) => `0${(stat.mode & 0o777).toString(8)}`;
const pathExists = async (path) =>
  lstat(path).then(
    () => true,
    (error) => (error.code === "ENOENT" ? false : Promise.reject(error)),
  );

async function assertProtectedDirectory(path, label) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error(`${label} is not protected`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid())
    throw new Error(`${label} has another owner`);
}

async function payloadTree(root, current = "") {
  const files = [];
  const directories = [current.split(sep).join("/")];
  const directoryStat = await lstat(join(root, current));
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    modeOf(directoryStat) !== "0555"
  )
    throw new Error(`active Kona directory is not immutable: ${current || "."}`);
  if (typeof process.getuid === "function" && directoryStat.uid !== process.getuid())
    throw new Error(`active Kona directory has another owner: ${current || "."}`);
  for (const name of await readdir(join(root, current))) {
    const path = current ? join(current, name) : name;
    const stat = await lstat(join(root, path));
    if (stat.isSymbolicLink()) throw new Error(`active Kona release contains a symlink: ${path}`);
    if (stat.isDirectory()) {
      const child = await payloadTree(root, path);
      files.push(...child.files);
      directories.push(...child.directories);
    } else if (stat.isFile()) files.push(path.split(sep).join("/"));
    else throw new Error(`active Kona release contains a special file: ${path}`);
  }
  return {
    files: files.toSorted((left, right) => left.localeCompare(right)),
    directories: directories.toSorted((left, right) => left.localeCompare(right)),
  };
}

export async function releaseIdentity(binaryPath) {
  const binaryRealpath = await realpath(binaryPath);
  const root = dirname(dirname(binaryRealpath));
  const manifestPath = join(root, "MANIFEST.json");
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || modeOf(manifestStat) !== "0444")
    throw new Error("active Kona manifest is not a protected regular file");

  let manifest;
  let packageJson;
  try {
    [manifest, packageJson] = await Promise.all([
      readFile(manifestPath, "utf8").then(JSON.parse),
      readFile(join(root, "package.json"), "utf8").then(JSON.parse),
    ]);
  } catch {
    throw new Error("active Kona release metadata is unreadable");
  }
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.name !== "kona" ||
    !SEMVER.test(manifest.version || "") ||
    manifest.tag !== `v${manifest.version}` ||
    packageJson?.version !== manifest.version ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  )
    throw new Error("active Kona release identity is invalid");

  const expected = new Set(["MANIFEST.json"]);
  const expectedDirectories = new Set([""]);
  for (const entry of manifest.files) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      !/^[A-Za-z0-9._/-]+$/.test(entry.path) ||
      entry.path.startsWith("/") ||
      entry.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      expected.has(entry.path) ||
      !SHA256.test(entry.sha256 || "") ||
      !/^0[45][0-7]{2}$/.test(entry.mode || "")
    )
      throw new Error("active Kona manifest file set is invalid");
    const path = resolve(root, ...entry.path.split("/"));
    const contained = relative(root, path);
    if (contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained))
      throw new Error("active Kona manifest path escapes its release");
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`active Kona file is not regular: ${entry.path}`);
    if (modeOf(stat) !== entry.mode)
      throw new Error(`active Kona file mode mismatch: ${entry.path}`);
    if (sha256(await readFile(path)) !== entry.sha256)
      throw new Error(`active Kona file checksum mismatch: ${entry.path}`);
    expected.add(entry.path);
    const parts = entry.path.split("/");
    for (let index = 1; index < parts.length; index += 1)
      expectedDirectories.add(parts.slice(0, index).join("/"));
  }
  for (const [path, mode] of REQUIRED_FILES) {
    const entry = manifest.files.find((candidate) => candidate.path === path);
    if (!entry || entry.mode !== mode) throw new Error(`active Kona release is missing ${path}`);
  }
  const actual = await payloadTree(root);
  if (actual.files.length !== expected.size || actual.files.some((path) => !expected.has(path)))
    throw new Error("active Kona release contains files outside its manifest");
  if (
    actual.directories.length !== expectedDirectories.size ||
    actual.directories.some((path) => !expectedDirectories.has(path))
  )
    throw new Error("active Kona release contains directories outside its manifest");
  if (binaryRealpath !== join(root, "bin", "kona"))
    throw new Error("active Kona binary path is invalid");
  return { version: manifest.version, binaryRealpath, root, installer: join(root, "install.sh") };
}

async function sourceInstallerPath(launcherPath) {
  const pluginRoot = dirname(dirname(launcherPath));
  for (const candidate of [join(pluginRoot, "install.sh"), join(pluginRoot, "..", "install.sh")]) {
    const stat = await lstat(candidate).catch((error) =>
      error.code === "ENOENT" ? null : Promise.reject(error),
    );
    if (!stat) continue;
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      sha256(await readFile(candidate)) !== SOURCE_INSTALLER_SHA256
    )
      throw new Error("source Kona installer mirror cannot be verified");
    return candidate;
  }
  return null;
}

async function installerPath(environment, launcherPath, binPath) {
  const launcherRealpath = await realpath(launcherPath);
  const hasReleaseManifest = await pathExists(
    join(dirname(dirname(launcherRealpath)), "MANIFEST.json"),
  );
  if (basename(launcherRealpath) === "kona" && !hasReleaseManifest)
    throw new Error("active Kona manifest is missing");
  const runningRelease = hasReleaseManifest ? await releaseIdentity(launcherPath) : null;
  if (environment.KONA_SELF_UPDATE_INSTALLER) {
    if (environment.KONA_INSTALL_TESTING !== "1")
      throw new Error("self-update installer override is restricted to tests");
    return resolve(environment.KONA_SELF_UPDATE_INSTALLER);
  }
  if (runningRelease) return runningRelease.installer;
  const sourceInstaller = await sourceInstallerPath(launcherPath);
  if (sourceInstaller) return sourceInstaller;
  if (await pathExists(binPath)) return (await releaseIdentity(binPath)).installer;
  throw new Error("verified Kona installer is unavailable");
}

function run(command, args, options, captureError = false) {
  return new Promise((resolvePromise, reject) => {
    const grouped = process.platform === "darwin" || process.platform === "linux";
    const child = spawn(command, args, {
      ...options,
      // detached creates a process group on POSIX; retaining the handle and close listener keeps it supervised.
      detached: grouped,
      shell: false,
      stdio: captureError ? ["inherit", "ignore", "pipe"] : "inherit",
    });
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    let forwardedSignal = null;
    let settled = false;
    const handlers = new Map(
      signals.map((signal) => [
        signal,
        () => {
          forwardedSignal ||= signal;
          if (grouped && child.pid) {
            try {
              process.kill(-child.pid, signal);
              return;
            } catch (error) {
              if (error.code === "ESRCH") return;
            }
          }
          try {
            child.kill(signal);
          } catch (error) {
            if (error.code !== "ESRCH") forwardedSignal ||= signal;
          }
        },
      ]),
    );
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      for (const [signal, handler] of handlers) process.off(signal, handler);
      callback();
    };
    let errors = "";
    if (captureError) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        errors = `${errors}${chunk}`.slice(-MAX_ERROR_BYTES);
      });
    }
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code, signal) =>
      finish(() =>
        resolvePromise({ code, signal: signal || forwardedSignal, errors: errors.trim() }),
      ),
    );
  });
}

function stateRoot(environment) {
  const home = environment.HOME || homedir();
  return resolve(
    environment.KONA_STATE_HOME ||
      join(environment.XDG_STATE_HOME || join(home, ".local", "state"), "kona"),
  );
}

async function guardDirectory(environment) {
  const root = stateRoot(environment);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertProtectedDirectory(root, "Kona state root");
  const directory = join(root, "self-update-guards");
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  await assertProtectedDirectory(directory, "Kona self-update guard directory");
  return directory;
}

async function createGuard(environment, active) {
  const nonce = randomBytes(32).toString("hex");
  const path = join(await guardDirectory(environment), `${nonce}.json`);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify({
        schemaVersion: 1,
        nonce,
        version: active.version,
        activeRealpath: active.binaryRealpath,
      })}\n`,
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
  return { nonce, path };
}

async function consumeGuard(environment, nonce, active, launcherPath) {
  // This one-use file prevents accidental recursion and replay. Same-user state tampering is out of scope.
  if (!/^[0-9a-f]{64}$/.test(nonce)) throw new Error("self-update re-exec marker is malformed");
  const directory = await guardDirectory(environment);
  const path = join(directory, `${nonce}.json`);
  const consumed = join(directory, `.consumed-${nonce}-${process.pid}`);
  await rename(path, consumed).catch(() => {
    throw new Error("self-update re-exec guard is missing or already consumed");
  });
  try {
    const stat = await lstat(consumed);
    if (!stat.isFile() || stat.isSymbolicLink() || modeOf(stat) !== "0600")
      throw new Error("self-update re-exec guard is not protected");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid())
      throw new Error("self-update re-exec guard has another owner");
    let guard;
    try {
      guard = JSON.parse(await readFile(consumed, "utf8"));
    } catch {
      throw new Error("self-update re-exec guard is malformed");
    }
    if (
      Object.keys(guard)
        .toSorted((left, right) => left.localeCompare(right))
        .join(",") !== "activeRealpath,nonce,schemaVersion,version" ||
      guard.schemaVersion !== 1 ||
      guard.nonce !== nonce ||
      guard.version !== active.version ||
      guard.activeRealpath !== active.binaryRealpath ||
      (await realpath(launcherPath)) !== active.binaryRealpath
    )
      throw new Error("self-update re-exec guard does not match the active Kona release");
  } finally {
    await rm(consumed, { force: true });
  }
}

export async function prepareSelfUpdate(argv, context) {
  const { env, launcherPath } = context;
  const binPath = resolve(env.KONA_BIN_DIR || join(env.HOME || homedir(), ".local", "bin"), "kona");
  const marker = env[SELF_UPDATE_MARKER];
  if (marker !== undefined) {
    const active = await releaseIdentity(binPath);
    await consumeGuard(env, marker, active, launcherPath);
    if (env.KONA_INSTALL_TESTING === "1" && env.KONA_SELF_UPDATE_TEST_SWAP_BIN_AFTER_GUARD_TO) {
      await rm(binPath, { force: true });
      await symlink(resolve(env.KONA_SELF_UPDATE_TEST_SWAP_BIN_AFTER_GUARD_TO), binPath);
    }
    const current = await releaseIdentity(binPath);
    if (current.version !== active.version || current.binaryRealpath !== active.binaryRealpath)
      throw new Error("active Kona release changed after consuming the re-exec guard");
    delete env[SELF_UPDATE_MARKER];
    return { guarded: true };
  }

  const installer = await installerPath(env, launcherPath, binPath);
  const installed = await run("sh", [installer, "--latest"], { cwd: context.cwd, env }, true);
  if (installed.signal) {
    process.kill(process.pid, installed.signal);
    return { reexecuted: true, exitCode: 1 };
  }
  if (installed.code !== 0)
    throw new Error(
      `self-update installer failed${installed.errors ? `: ${installed.errors}` : ""}`,
    );

  const active = await releaseIdentity(binPath);
  const guard = await createGuard(env, active);
  if (env.KONA_INSTALL_TESTING === "1" && env.KONA_SELF_UPDATE_TEST_SWAP_BIN_TO) {
    await rm(binPath, { force: true });
    await symlink(resolve(env.KONA_SELF_UPDATE_TEST_SWAP_BIN_TO), binPath);
  }
  let child;
  try {
    const command =
      env.KONA_INSTALL_TESTING === "1" && env.KONA_SELF_UPDATE_TEST_FAIL_SPAWN === "1"
        ? join(dirname(active.binaryRealpath), ".missing-kona")
        : active.binaryRealpath;
    child = await run(command, argv, {
      cwd: context.cwd,
      env: { ...env, [SELF_UPDATE_MARKER]: guard.nonce },
    });
  } finally {
    await rm(guard.path, { force: true });
  }
  if (child.signal) {
    process.kill(process.pid, child.signal);
    return { reexecuted: true, exitCode: 1 };
  }
  return { reexecuted: true, exitCode: child.code ?? 1 };
}
