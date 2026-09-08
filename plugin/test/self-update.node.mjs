import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { releaseIdentity } from "../lib/self-update.mjs";
import { buildRelease } from "../scripts/release-lib.mjs";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function makeWritable(path) {
  const stat = await lstat(path).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  await chmod(path, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory())
    for (const name of await readdir(path)) await makeWritable(join(path, name));
}

async function makeDirectoriesImmutable(path) {
  for (const name of await readdir(path)) {
    const child = join(path, name);
    if ((await lstat(child)).isDirectory()) await makeDirectoriesImmutable(child);
  }
  await chmod(path, 0o555);
}

async function installedFixture() {
  const directory = await mkdtemp(join(tmpdir(), "kona-self-update-installed-"));
  const release = await buildRelease({ root, outDir: join(directory, "release") });
  const home = join(directory, "home");
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  const transport = join(directory, "transport.sh");
  await writeFile(
    transport,
    '#!/bin/sh\nset -eu\nprintf "HTTP/1.1 200 OK\\r\\n\\r\\n" > "$3"\ncp "$KONA_TEST_RELEASE/${1##*/}" "$2"\n',
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    HOME: home,
    KONA_BIN_DIR: bin,
    KONA_STATE_HOME: join(home, "state"),
    XDG_DATA_HOME: join(home, "data"),
    KONA_INSTALL_TESTING: "1",
    KONA_INSTALL_TEST_TRANSPORT: transport,
    KONA_TEST_RELEASE: release.releaseDir,
  };
  await execute("sh", [join(release.releaseDir, "install.sh")], { env });
  return {
    directory,
    env,
    active: join(bin, "kona"),
    activeRealpath: await realpath(join(bin, "kona")),
    cleanup: async () => {
      await makeWritable(directory);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("update bootstraps once and re-executes the exact active path with exact argv", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kona-self-update-"));
  try {
    const bin = join(directory, "bin");
    const activeRoot = join(directory, "active");
    const log = join(directory, "reexec.json");
    const swappedLog = join(directory, "swapped");
    await Promise.all([
      mkdir(bin),
      mkdir(join(activeRoot, "bin"), { recursive: true }),
      mkdir(join(activeRoot, "lib"), { recursive: true }),
    ]);
    const active = join(activeRoot, "bin/kona");
    const activeBytes = Buffer.from(
      `#!${process.execPath}\nconst fs=require("node:fs");fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({argv:process.argv.slice(2),marker:process.env.KONA_SELF_UPDATE_REEXEC,path:process.argv[1]}));`,
    );
    await writeFile(active, activeBytes, { mode: 0o555 });
    const packageBytes = Buffer.from('{"version":"0.5.3"}\n');
    const installerBytes = Buffer.from("#!/bin/sh\nexit 0\n");
    const selfUpdateBytes = Buffer.from("export {};\n");
    await Promise.all([
      writeFile(join(activeRoot, "package.json"), packageBytes, { mode: 0o444 }),
      writeFile(join(activeRoot, "install.sh"), installerBytes, { mode: 0o555 }),
      writeFile(join(activeRoot, "lib/self-update.mjs"), selfUpdateBytes, { mode: 0o444 }),
    ]);
    await writeFile(
      join(activeRoot, "MANIFEST.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        name: "kona",
        version: "0.5.3",
        tag: "v0.5.3",
        files: [
          { path: "bin/kona", sha256: hash(activeBytes), mode: "0555" },
          { path: "install.sh", sha256: hash(installerBytes), mode: "0555" },
          { path: "lib/self-update.mjs", sha256: hash(selfUpdateBytes), mode: "0444" },
          { path: "package.json", sha256: hash(packageBytes), mode: "0444" },
        ],
      })}\n`,
      { mode: 0o444 },
    );
    await makeDirectoriesImmutable(activeRoot);
    const installer = join(directory, "installer.sh");
    const installerLog = join(directory, "installer-args.json");
    await writeFile(
      installer,
      `#!/bin/sh\nset -eu\nprintf '%s' "$*" > ${JSON.stringify(installerLog)}\nln -s ${JSON.stringify(active)} ${JSON.stringify(join(bin, "kona"))}\n`,
      { mode: 0o755 },
    );
    const swapped = join(directory, "swapped-kona");
    await writeFile(
      swapped,
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(swappedLog)},"ran")`,
      { mode: 0o755 },
    );
    const args = [
      "update",
      "--host",
      "claude",
      "--scope",
      "project",
      "--source",
      "/tmp/source with spaces",
      "--confirm-replace",
      "a".repeat(64),
      "--confirm-replace",
      "b".repeat(64),
      "--approve",
      "--json",
    ];
    await execute(process.execPath, [join(root, "plugin/bin/kona.mjs"), ...args], {
      env: {
        ...process.env,
        HOME: directory,
        KONA_BIN_DIR: bin,
        KONA_INSTALL_TESTING: "1",
        KONA_SELF_UPDATE_INSTALLER: installer,
        KONA_SELF_UPDATE_TEST_SWAP_BIN_TO: swapped,
      },
    });
    assert.equal(await readFile(installerLog, "utf8"), "--latest");
    const observed = JSON.parse(await readFile(log, "utf8"));
    assert.deepEqual(observed.argv, args);
    assert.equal(observed.path, await realpath(active));
    assert.match(observed.marker, /^[0-9a-f]{64}$/);
    await assert.rejects(readFile(swappedLog), { code: "ENOENT" });
  } finally {
    await makeWritable(directory);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a malformed re-exec guard fails closed before host state creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kona-self-update-guard-"));
  try {
    await assert.rejects(
      execute(
        process.execPath,
        [
          join(root, "plugin/bin/kona.mjs"),
          "update",
          "--host",
          "opencode",
          "--scope",
          "project",
          "--json",
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            HOME: directory,
            KONA_STATE_HOME: join(directory, "state"),
            KONA_SELF_UPDATE_REEXEC: "not-json",
          },
        },
      ),
      (error) => {
        assert.equal(error.stdout, "");
        assert.match(error.stderr, /SELF_UPDATE_FAILED/);
        return true;
      },
    );
    await assert.rejects(readFile(join(directory, "state/opencode/journal.json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installer failure reports SELF_UPDATE_FAILED before host mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kona-self-update-failure-"));
  try {
    const installer = join(directory, "installer.sh");
    await writeFile(installer, "#!/bin/sh\nprintf 'bounded failure detail\\n' >&2\nexit 9\n", {
      mode: 0o755,
    });
    await assert.rejects(
      execute(
        process.execPath,
        [
          join(root, "plugin/bin/kona.mjs"),
          "update",
          "--host",
          "opencode",
          "--scope",
          "project",
          "--json",
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            HOME: directory,
            KONA_STATE_HOME: join(directory, "state"),
            KONA_INSTALL_TESTING: "1",
            KONA_SELF_UPDATE_INSTALLER: installer,
          },
        },
      ),
      (error) => {
        assert.equal(error.stdout, "");
        const body = JSON.parse(error.stderr);
        assert.equal(body.code, "SELF_UPDATE_FAILED");
        assert.match(body.details.reason, /bounded failure detail/);
        return true;
      },
    );
    await assert.rejects(readFile(join(directory, "state/opencode/journal.json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid update arguments return usage without invoking the installer", async () => {
  for (const args of [
    ["update", "--host", "opencode", "--host", "codex", "--scope", "project", "--json"],
    ["update", "--host", "--scope", "project", "--json"],
    ["update", "--host", "opencode", "--json"],
    ["update", "--host", "opencode", "--scope", "project", "--unknown", "--json"],
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "kona-self-update-usage-"));
    try {
      const called = join(directory, "called");
      const installer = join(directory, "installer.sh");
      await writeFile(installer, `#!/bin/sh\ntouch ${JSON.stringify(called)}\n`, { mode: 0o755 });
      await assert.rejects(
        execute(process.execPath, [join(root, "plugin/bin/kona.mjs"), ...args], {
          env: {
            ...process.env,
            HOME: directory,
            KONA_INSTALL_TESTING: "1",
            KONA_SELF_UPDATE_INSTALLER: installer,
          },
        }),
        (error) => {
          assert.equal(error.stdout, "");
          const body = JSON.parse(error.stderr);
          assert.equal(body.code, "USAGE");
          assert.equal(body.host, null);
          assert.equal(body.scope, null);
          return true;
        },
      );
      await assert.rejects(readFile(called), { code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("active release validation rejects tampered files, modes, symlinks, and manifests", async () => {
  for (const variant of [
    "installer",
    "binary",
    "library",
    "mode",
    "symlink",
    "manifest",
    "writable-directory",
    "extra-directory",
  ]) {
    const directory = await mkdtemp(join(tmpdir(), `kona-release-integrity-${variant}-`));
    try {
      const release = await buildRelease({ root, outDir: join(directory, "release") });
      const unpacked = join(directory, "unpacked");
      await mkdir(unpacked);
      await execute("tar", ["-xzf", join(release.releaseDir, release.archiveName), "-C", unpacked]);
      const releaseRoot = join(unpacked, "kona");
      await makeDirectoriesImmutable(releaseRoot);
      const binary = join(releaseRoot, "bin/kona");
      if (variant === "installer") {
        await chmod(join(releaseRoot, "install.sh"), 0o755);
        await writeFile(join(releaseRoot, "install.sh"), "tampered\n");
      } else if (variant === "binary") {
        await chmod(binary, 0o755);
        await writeFile(binary, "tampered\n");
      } else if (variant === "library") {
        const path = join(releaseRoot, "lib/self-update.mjs");
        await chmod(path, 0o644);
        await writeFile(path, "tampered\n");
      } else if (variant === "mode") {
        await chmod(join(releaseRoot, "package.json"), 0o644);
      } else if (variant === "symlink") {
        const path = join(releaseRoot, "lib/self-update.mjs");
        await chmod(join(releaseRoot, "lib"), 0o755);
        await rm(path);
        await symlink(join(releaseRoot, "package.json"), path);
        await chmod(join(releaseRoot, "lib"), 0o555);
      } else if (variant === "writable-directory") {
        await chmod(join(releaseRoot, "lib"), 0o755);
      } else if (variant === "extra-directory") {
        await chmod(releaseRoot, 0o755);
        await mkdir(join(releaseRoot, "extra"), { mode: 0o555 });
        await chmod(releaseRoot, 0o555);
      } else {
        const path = join(releaseRoot, "MANIFEST.json");
        await chmod(path, 0o644);
        const manifest = JSON.parse(await readFile(path, "utf8"));
        manifest.files.push(manifest.files[0]);
        await writeFile(path, `${JSON.stringify(manifest)}\n`);
        await chmod(path, 0o444);
      }
      await assert.rejects(releaseIdentity(binary), /active Kona/);
    } finally {
      await makeWritable(directory);
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("actual CLI one-use guard prevents accidental fabrication and replay under same-user trust", async () => {
  const value = await installedFixture();
  try {
    const installer = join(value.directory, "noop-installer.sh");
    const calls = join(value.directory, "installer.calls");
    await writeFile(installer, `#!/bin/sh\nprintf 'called\\n' >> ${JSON.stringify(calls)}\n`, {
      mode: 0o755,
    });
    const args = ["update", "--host", "opencode", "--scope", "project", "--json"];
    await assert.rejects(
      execute(value.active, args, {
        env: { ...value.env, KONA_SELF_UPDATE_INSTALLER: installer },
      }),
      (error) => {
        assert.equal(JSON.parse(error.stderr).code, "NOT_INSTALLED");
        return true;
      },
    );
    assert.equal(await readFile(calls, "utf8"), "called\n");

    const guardDirectory = join(value.env.KONA_STATE_HOME, "self-update-guards");
    await assert.rejects(
      execute(value.active, args, {
        env: {
          ...value.env,
          KONA_SELF_UPDATE_INSTALLER: installer,
          KONA_SELF_UPDATE_TEST_FAIL_SPAWN: "1",
        },
      }),
      (error) => {
        assert.equal(JSON.parse(error.stderr).code, "SELF_UPDATE_FAILED");
        return true;
      },
    );
    assert.deepEqual(await readdir(guardDirectory), []);
    assert.equal(await realpath(value.active), value.activeRealpath);

    const nonce = "a".repeat(64);
    await writeFile(
      join(guardDirectory, `${nonce}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        nonce,
        version: "0.5.3",
        activeRealpath: value.activeRealpath,
      })}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      execute(value.active, args, {
        env: { ...value.env, KONA_SELF_UPDATE_REEXEC: nonce },
      }),
      (error) => {
        assert.equal(JSON.parse(error.stderr).code, "NOT_INSTALLED");
        return true;
      },
    );
    for (const marker of [nonce, "b".repeat(64), "not-a-nonce"]) {
      await assert.rejects(
        execute(value.active, args, {
          env: { ...value.env, KONA_SELF_UPDATE_REEXEC: marker },
        }),
        (error) => {
          assert.equal(JSON.parse(error.stderr).code, "SELF_UPDATE_FAILED");
          return true;
        },
      );
    }

    const mismatch = "c".repeat(64);
    await writeFile(
      join(guardDirectory, `${mismatch}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        nonce: mismatch,
        version: "9.9.9",
        activeRealpath: value.activeRealpath,
      })}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      execute(value.active, args, {
        env: { ...value.env, KONA_SELF_UPDATE_REEXEC: mismatch },
      }),
      (error) => {
        assert.equal(JSON.parse(error.stderr).code, "SELF_UPDATE_FAILED");
        return true;
      },
    );

    const unsafe = "d".repeat(64);
    await writeFile(
      join(guardDirectory, `${unsafe}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        nonce: unsafe,
        version: "0.5.3",
        activeRealpath: value.activeRealpath,
      })}\n`,
      { mode: 0o644 },
    );
    await assert.rejects(
      execute(value.active, args, {
        env: { ...value.env, KONA_SELF_UPDATE_REEXEC: unsafe },
      }),
      (error) => {
        assert.equal(JSON.parse(error.stderr).code, "SELF_UPDATE_FAILED");
        return true;
      },
    );
  } finally {
    await value.cleanup();
  }
});

test("plugin-only source layout uses its verified canonical installer mirror", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kona-plugin-only-update-"));
  try {
    const release = await buildRelease({ root, outDir: join(directory, "release") });
    const pluginOnly = join(directory, "plugin");
    await cp(join(root, "plugin"), pluginOnly, { recursive: true });
    const home = join(directory, "home");
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    const transport = join(directory, "transport.sh");
    await writeFile(
      transport,
      '#!/bin/sh\nset -eu\nprintf "HTTP/1.1 200 OK\\r\\n\\r\\n" > "$3"\ncp "$KONA_TEST_RELEASE/${1##*/}" "$2"\n',
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      HOME: home,
      KONA_BIN_DIR: bin,
      KONA_STATE_HOME: join(home, "state"),
      XDG_DATA_HOME: join(home, "data"),
      KONA_INSTALL_TESTING: "1",
      KONA_INSTALL_TEST_TRANSPORT: transport,
      KONA_TEST_RELEASE: release.releaseDir,
    };
    await assert.rejects(
      execute(
        process.execPath,
        [
          join(pluginOnly, "bin/kona.mjs"),
          "update",
          "--host",
          "opencode",
          "--scope",
          "project",
          "--json",
        ],
        { env },
      ),
      (error) => {
        assert.equal(JSON.parse(error.stderr).code, "NOT_INSTALLED");
        return true;
      },
    );
    assert.equal(
      await realpath(join(bin, "kona")),
      await realpath(join(home, "data/kona/versions/v0.5.3/bin/kona")),
    );
  } finally {
    await makeWritable(directory);
    await rm(directory, { recursive: true, force: true });
  }
});

test("active release validation failure occurs before installer execution and preserves activation", async () => {
  const value = await installedFixture();
  try {
    const installer = join(value.directory, "should-not-run.sh");
    const called = join(value.directory, "called");
    await writeFile(installer, `#!/bin/sh\ntouch ${JSON.stringify(called)}\n`, { mode: 0o755 });
    const packagePath = join(dirname(dirname(value.activeRealpath)), "package.json");
    await chmod(packagePath, 0o644);
    await writeFile(packagePath, `${await readFile(packagePath, "utf8")} `, { mode: 0o444 });

    await assert.rejects(
      execute(value.active, ["update", "--host", "opencode", "--scope", "project", "--json"], {
        env: { ...value.env, KONA_SELF_UPDATE_INSTALLER: installer },
      }),
      (error) => {
        assert.equal(JSON.parse(error.stderr).code, "SELF_UPDATE_FAILED");
        return true;
      },
    );
    await assert.rejects(readFile(called), { code: "ENOENT" });
    assert.equal(await realpath(value.active), value.activeRealpath);
  } finally {
    await value.cleanup();
  }
});

test("parent forwards SIGINT, SIGTERM, and SIGHUP to the installer and preserves the signal", async () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const directory = await mkdtemp(join(tmpdir(), `kona-self-update-signal-${signal}-`));
    try {
      const ready = join(directory, "ready");
      const installer = join(directory, "installer.sh");
      await writeFile(
        installer,
        `#!/bin/sh\ntrap 'exit 0' ${signal}\ntouch ${JSON.stringify(ready)}\nwhile :; do sleep 1; done\n`,
        { mode: 0o755 },
      );
      const child = spawn(
        process.execPath,
        [join(root, "plugin/bin/kona.mjs"), "update", "--host", "opencode", "--scope", "project"],
        {
          env: {
            ...process.env,
            HOME: directory,
            KONA_INSTALL_TESTING: "1",
            KONA_SELF_UPDATE_INSTALLER: installer,
          },
          stdio: "ignore",
        },
      );
      for (let attempt = 0; attempt < 100 && !(await lstat(ready).catch(() => null)); attempt += 1)
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      assert.ok(await lstat(ready).catch(() => null), `${signal} installer did not start`);
      const close = new Promise((resolvePromise) =>
        child.on("close", (code, childSignal) => resolvePromise({ code, signal: childSignal })),
      );
      child.kill(signal);
      const closed = await close;
      assert.deepEqual(closed, { code: null, signal });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("parent cancellation terminates installer process group before child or grandchild mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kona-self-update-process-group-"));
  try {
    const ready = join(directory, "ready");
    const childPid = join(directory, "child-pid");
    const grandchildPid = join(directory, "grandchild-pid");
    const grandchildReady = join(directory, "grandchild-ready");
    const childMutation = join(directory, "child-mutation");
    const grandchildMutation = join(directory, "grandchild-mutation");
    const grandchild = join(directory, "grandchild.sh");
    await writeFile(
      grandchild,
      `#!/bin/sh\nprintf '%s' "$$" > ${JSON.stringify(grandchildPid)}\ntouch ${JSON.stringify(grandchildReady)}\nsleep 5\ntouch ${JSON.stringify(grandchildMutation)}\n`,
      { mode: 0o755 },
    );
    const installer = join(directory, "installer.sh");
    await writeFile(
      installer,
      `#!/bin/sh\nprintf '%s' "$$" > ${JSON.stringify(childPid)}\nsh ${JSON.stringify(grandchild)} &\nwhile [ ! -f ${JSON.stringify(grandchildReady)} ]; do sleep 0.01; done\ntouch ${JSON.stringify(ready)}\nwait\ntouch ${JSON.stringify(childMutation)}\n`,
      { mode: 0o755 },
    );
    const child = spawn(
      process.execPath,
      [join(root, "plugin/bin/kona.mjs"), "update", "--host", "opencode", "--scope", "project"],
      {
        env: {
          ...process.env,
          HOME: directory,
          KONA_INSTALL_TESTING: "1",
          KONA_SELF_UPDATE_INSTALLER: installer,
        },
        stdio: "ignore",
      },
    );
    for (let attempt = 0; attempt < 100 && !(await lstat(ready).catch(() => null)); attempt += 1)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    assert.ok(await lstat(ready).catch(() => null), "installer process group did not start");
    const close = new Promise((resolvePromise) =>
      child.on("close", (code, signal) => resolvePromise({ code, signal })),
    );
    child.kill("SIGTERM");
    assert.deepEqual(await close, { code: null, signal: "SIGTERM" });
    const processGroup = Number(await readFile(childPid, "utf8"));
    assert.equal(Number.isInteger(processGroup) && processGroup > 0, true);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(-processGroup, 0);
      } catch (error) {
        if (error.code === "ESRCH") break;
        throw error;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    assert.throws(() => process.kill(-processGroup, 0), { code: "ESRCH" });
    assert.equal(Number(await readFile(grandchildPid, "utf8")) > 0, true);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    await assert.rejects(lstat(childMutation), { code: "ENOENT" });
    await assert.rejects(lstat(grandchildMutation), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("re-entry rejects an active symlink switch after consuming its guard", async () => {
  const value = await installedFixture();
  try {
    const nonce = "e".repeat(64);
    const guardDirectory = join(value.env.KONA_STATE_HOME, "self-update-guards");
    await mkdir(guardDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(guardDirectory, `${nonce}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        nonce,
        version: "0.5.3",
        activeRealpath: value.activeRealpath,
      })}\n`,
      { mode: 0o600 },
    );
    const switched = join(value.directory, "switched-kona");
    await writeFile(switched, `#!${process.execPath}\n`, { mode: 0o755 });
    await assert.rejects(
      execute(value.active, ["update", "--host", "opencode", "--scope", "project", "--json"], {
        env: {
          ...value.env,
          KONA_SELF_UPDATE_REEXEC: nonce,
          KONA_SELF_UPDATE_TEST_SWAP_BIN_AFTER_GUARD_TO: switched,
        },
      }),
      (error) => {
        assert.equal(JSON.parse(error.stderr).code, "SELF_UPDATE_FAILED");
        return true;
      },
    );
    await assert.rejects(lstat(join(guardDirectory, `${nonce}.json`)), { code: "ENOENT" });
  } finally {
    await value.cleanup();
  }
});
