import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { runLifecycle } from "../lib/plugin-lifecycle.mjs";

const pluginRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(pluginRoot, "..");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const execute = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kona-lifecycle-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const state = join(root, "state");
  await Promise.all([mkdir(home), mkdir(project), mkdir(state)]);
  const env = { HOME: home, KONA_STATE_HOME: state, KONA_PLUGIN_ROOT: pluginRoot };
  return {
    root,
    home,
    project,
    state,
    env,
    run: (args) => runLifecycle(args, { cwd: project, env }),
  };
}

async function missing(path) {
  await assert.rejects(access(path), { code: "ENOENT" });
}

async function installMock(value, name, source) {
  const bin = join(value.root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  value.env.PATH = bin;
}

async function manifestPath(value, host, scope, project = value.project) {
  return scope === "user"
    ? join(value.state, host, "user/manifest.json")
    : join(value.state, host, "projects", digest(await realpath(project)), scope, "manifest.json");
}

async function installCopiedHostMock(value, host, scope = "project") {
  const calls = join(value.root, `${host}.calls`);
  const skill =
    scope === "project"
      ? join(
          value.project,
          host === "opencode" ? ".opencode/skills/prd/SKILL.md" : ".agents/skills/prd/SKILL.md",
        )
      : join(
          value.home,
          host === "opencode"
            ? ".config/opencode/skills/prd/SKILL.md"
            : ".agents/skills/prd/SKILL.md",
        );
  const source =
    host === "opencode"
      ? `const fs=require("node:fs");const a=process.argv.slice(2);fs.appendFileSync("${calls}",a.join(" ")+"\\n");const enabled=fs.existsSync("${skill}");console.log(a[0]==="agent"?(enabled?"prd-writer (subagent)":""):JSON.stringify(enabled?[{name:"prd",location:"${skill}"}]:[]))`
      : `const fs=require("node:fs");fs.appendFileSync("${calls}",process.argv.slice(2).join(" ")+"\\n");let b="";process.stdin.on("data",x=>{b+=x;for(const l of b.split("\\n")){if(!l)continue;const m=JSON.parse(l);fs.appendFileSync("${calls}",m.method+"\\n");if(m.id===1)console.log(JSON.stringify({id:1,result:{}}));if(m.id===2){const exists=fs.existsSync("${skill}");const config="${join(value.home, ".codex/config.toml")}";const enabled=exists&&(!fs.existsSync(config)||!fs.readFileSync(config,"utf8").includes("enabled = false"));console.log(JSON.stringify({id:2,result:{data:[{cwd:"${value.project}",skills:exists?[{name:"prd",path:"${skill}",enabled}]:[],errors:[]}]}}))}}})`;
  await installMock(value, host, source);
  return { calls, skill };
}

async function installClaudeMock(value) {
  const state = join(value.root, "claude.json");
  const calls = join(value.root, "claude.calls");
  await writeFile(state, JSON.stringify({ marketplace: false, installed: [] }));
  await installMock(
    value,
    "claude",
    `const fs=require("node:fs");const a=process.argv.slice(2);const p="${state}";const c="${calls}";const s=JSON.parse(fs.readFileSync(p));fs.appendFileSync(c,JSON.stringify(a)+"\\n");const save=()=>fs.writeFileSync(p,JSON.stringify(s));
 if(a.join(" ")==="plugin marketplace list --json")console.log(JSON.stringify(s.marketplaces??(s.marketplace?[{name:"kona",source:{source:"github",repo:"open-treasury/kona"}}]:[])));
 else if(a.join(" ")==="plugin list --json --available")console.log(JSON.stringify({installed:s.installed,available:s.available??(s.marketplace?[{pluginId:"kona@kona",name:"kona",marketplaceName:"kona",version:"0.1.1"}]:[])}));
else if(a.slice(0,3).join(" ")==="plugin marketplace add"){s.marketplace=true;save()}
else if(a.slice(0,3).join(" ")==="plugin marketplace remove"){s.marketplace=false;save()}
 else{const v=a[1],scope=a[4],i=s.installed.findIndex(x=>x.scope===scope&&(scope==="user"||x.projectPath===process.cwd()));if(process.env.MOCK_FAIL===v)process.exit(7);if(v==="install")s.installed.push({id:"kona@kona",version:"0.1.1",scope,enabled:true,projectPath:scope==="user"?undefined:process.cwd()});else if(v==="uninstall")s.installed.splice(i,1);else if(v==="disable")s.installed[i].enabled=false;else if(v==="enable")s.installed[i].enabled=true;else if(v!=="update")process.exit(8);save()}`,
  );
  return { state, calls };
}

async function installPiMock(value) {
  const state = join(value.root, "pi.json");
  const calls = join(value.root, "pi.calls");
  await writeFile(state, JSON.stringify({ packages: [] }));
  await installMock(
    value,
    "pi",
    `const fs=require("node:fs");const a=process.argv.slice(2);const p="${state}";const c="${calls}";const s=JSON.parse(fs.readFileSync(p));fs.appendFileSync(c,JSON.stringify(a)+"\\n");const save=()=>fs.writeFileSync(p,JSON.stringify(s));const scope=a.includes("-l")?"project":"user";const id=x=>x.replace(/@(?:[0-9].*)$/,"");
 if(a.includes("rpc")){let b="";process.stdin.on("data",x=>{b+=x;if(!b.includes("\\n"))return;fs.appendFileSync(c,JSON.stringify({rpc:JSON.parse(b.trim())})+"\\n");console.log(JSON.stringify({type:"response",command:"get_commands",success:true,data:{commands:process.env.MOCK_PI_HIDE_COMMAND?[]:s.packages.filter(x=>x.enabled).map(x=>({name:"skill:prd",source:"skill",location:x.scope,path:"/installed/skills/prd/SKILL.md"}))}}))})}
 else if(a[0]==="list"){for(const scope of ["user","project"]){const xs=s.packages.filter(x=>x.scope===scope);if(xs.length){console.log((scope==="user"?"User":"Project")+" packages:");xs.forEach(x=>console.log("  "+x.source))}}if(!s.packages.length)console.log("No packages installed.")}
else if(a[0]==="install"){const x={scope,source:a[1],enabled:true},i=s.packages.findIndex(y=>y.scope===scope&&id(y.source)===id(x.source));i<0?s.packages.push(x):s.packages[i]=x;save()}
 else if(a[0]==="remove"){if(!process.env.MOCK_PI_KEEP_PACKAGE)s.packages=s.packages.filter(x=>!(x.scope===scope&&id(x.source)===id(a[1])));save()}
else if(a[0]==="update")save();
else if(a[0]==="config"){const x=s.packages.find(x=>x.scope===scope);x.enabled=!x.enabled;save()}
else process.exit(9);`,
  );
  return { state, calls };
}

test("AC14-AC19, AC21: copied-host scope matrix is canonical, idempotent, and preserves canaries", async () => {
  for (const host of ["opencode", "codex"]) {
    for (const scope of ["project", "user"]) {
      const value = await fixture();
      try {
        await installCopiedHostMock(value, host, scope);
        const canary = join(value.project, "specs/existing/prd.md");
        await mkdir(dirname(canary), { recursive: true });
        await writeFile(canary, "authored\n");
        const args = ["--host", host, "--scope", scope];
        const installed = await value.run(["install", ...args]);
        assert.equal(installed.exitCode, 0, JSON.stringify(installed.body));
        assert.deepEqual(
          {
            version: installed.body.details.version,
            scope: installed.body.details.scope,
            invocation: installed.body.details.invocation,
            native: installed.body.details.verification.native,
          },
          {
            version: "0.1.1",
            scope,
            invocation: host === "opencode" ? "@prd-writer" : "$prd",
            native: "verified",
          },
        );
        assert.equal((await value.run(["install", ...args])).body.status, "unchanged");
        const root =
          scope === "project"
            ? value.project
            : host === "opencode"
              ? join(value.home, ".config/opencode")
              : value.home;
        const skill =
          host === "opencode"
            ? join(
                root,
                scope === "project" ? ".opencode/skills/prd/SKILL.md" : "skills/prd/SKILL.md",
              )
            : join(root, ".agents/skills/prd/SKILL.md");
        assert.deepEqual(
          await readFile(skill),
          await readFile(join(pluginRoot, "skills/prd/SKILL.md")),
        );
        const updated = await value.run(["update", ...args]);
        assert.equal(updated.body.status, "updated");
        assert.equal(updated.body.details.verification.native, "verified");
        assert.equal(updated.body.details.version, "0.1.1");
        assert.equal(updated.body.details.scope, scope);
        assert.equal((await value.run(["disable", ...args])).body.status, "disabled");
        const enabled = await value.run(["enable", ...args]);
        assert.equal(enabled.body.status, "enabled");
        assert.equal(enabled.body.details.verification.native, "verified");
        assert.equal(enabled.body.details.invocation, host === "opencode" ? "@prd-writer" : "$prd");
        assert.equal((await value.run(["remove", ...args])).body.status, "removed");
        assert.equal(await readFile(canary, "utf8"), "authored\n");
      } finally {
        await rm(value.root, { recursive: true, force: true });
      }
    }
  }
});

test("AC16-AC18: replacement is digest-bound, backup drift blocks removal, and exact bytes restore", async () => {
  const value = await fixture();
  try {
    await installCopiedHostMock(value, "codex");
    const target = join(value.project, ".agents/skills/prd/SKILL.md");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "unowned\n");
    const args = ["--host", "codex", "--scope", "project"];
    const refused = await value.run(["install", ...args]);
    assert.equal(refused.body.code, "REPLACEMENT_CONFIRMATION_REQUIRED");
    assert.equal(await readFile(target, "utf8"), "unowned\n");
    const replaced = await value.run([
      "install",
      ...args,
      "--confirm-replace",
      digest("unowned\n"),
    ]);
    assert.equal(replaced.exitCode, 0, JSON.stringify(replaced.body));
    const stateManifest = await manifestPath(value, "codex", "project");
    const manifest = JSON.parse(await readFile(stateManifest, "utf8"));
    await writeFile(manifest.backups[0].backup, "counterfeit\n");
    assert.equal((await value.run(["remove", ...args])).body.code, "BACKUP_DRIFT");
    await writeFile(manifest.backups[0].backup, "unowned\n", { mode: 0o600 });
    assert.equal((await value.run(["remove", ...args])).exitCode, 0);
    assert.equal(await readFile(target, "utf8"), "unowned\n");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("AC9, AC16, AC21 negative controls reject drift, counterfeit paths, and a live host lock", async () => {
  const value = await fixture();
  try {
    await installCopiedHostMock(value, "codex");
    const args = ["--host", "codex", "--scope", "project"];
    const installed = await value.run(["install", ...args]);
    assert.equal(installed.exitCode, 0, JSON.stringify(installed.body));
    const stateManifest = await manifestPath(value, "codex", "project");
    const original = await readFile(stateManifest, "utf8");
    const manifest = JSON.parse(original);
    manifest.paths[0] = join(value.project, "outside");
    await writeFile(stateManifest, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    assert.equal((await value.run(["verify", ...args])).body.code, "INVALID_STATE");
    await writeFile(stateManifest, original, { mode: 0o600 });
    await writeFile(join(value.project, ".agents/skills/prd/SKILL.md"), "drift\n");
    assert.equal((await value.run(["verify", ...args])).body.code, "DRIFT");

    const other = await fixture();
    try {
      const lock = join(other.state, "opencode.lock");
      await mkdir(lock);
      await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
      assert.equal(
        (await other.run(["install", "--host", "opencode", "--scope", "project"])).body.code,
        "LOCKED",
      );
    } finally {
      await rm(other.root, { recursive: true, force: true });
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("AC17-AC18: crash journal recovery restores preimages before verification", async () => {
  const value = await fixture();
  try {
    await installCopiedHostMock(value, "codex");
    const args = ["--host", "codex", "--scope", "project"];
    await value.run(["install", ...args]);
    const target = join(value.project, ".agents/skills/prd/SKILL.md");
    const original = await readFile(target);
    const transaction = join(value.state, "codex/transaction-test");
    const preimage = join(transaction, "0.preimage");
    await mkdir(transaction);
    await writeFile(preimage, original, { mode: 0o600 });
    await writeFile(target, "interrupted\n");
    await writeFile(
      join(value.state, "codex/journal.json"),
      `${JSON.stringify({ schema: 1, host: "codex", scope: "project", projectRoot: value.project, root: transaction, preimages: [{ path: target, exists: true, backup: preimage, sha256: digest(original), mode: "0644" }] })}\n`,
      { mode: 0o600 },
    );
    const verified = await value.run(["verify", ...args]);
    assert.equal(verified.exitCode, 0);
    assert.equal(verified.body.recovered, true);
    assert.deepEqual(await readFile(target), original);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("AC15: OpenCode and Codex native discovery uses list protocols and never starts a model", async () => {
  for (const host of ["opencode", "codex"]) {
    const value = await fixture();
    try {
      const args = ["--host", host, "--scope", "project"];
      const mock = await installCopiedHostMock(value, host);
      const installed = await value.run(["install", ...args]);
      assert.equal(installed.exitCode, 0, JSON.stringify(installed.body));
      assert.equal(installed.body.details.verification.native, "verified");
      const recorded = await readFile(mock.calls, "utf8");
      assert.doesNotMatch(recorded, /prompt|turn\/start/);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("AC14-AC21: Pi native package lifecycle is approved, scope-safe, pinned-update aware, and model-free", async () => {
  const value = await fixture();
  try {
    const mock = await installPiMock(value);
    const project = ["--host", "pi", "--scope", "project"];
    const planned = await value.run(["install", ...project]);
    assert.equal(planned.body.code, "APPROVAL_REQUIRED");
    assert.deepEqual(planned.body.details.plan, [
      ["pi", "install", "git:github.com/open-treasury/kona", "-l", "--approve"],
    ]);
    assert.deepEqual(JSON.parse(await readFile(mock.state, "utf8")).packages, []);
    assert.equal(
      (await value.run(["install", ...project, "--source", repositoryRoot, "--approve"])).exitCode,
      0,
    );
    assert.equal(
      (
        await value.run([
          "install",
          "--host",
          "pi",
          "--scope",
          "user",
          "--source",
          "npm:@open-treasury/kona",
          "--approve",
        ])
      ).body.code,
      "ACTIVE_SCOPE",
    );
    assert.equal((await value.run(["disable", ...project, "--approve"])).body.status, "disabled");
    assert.equal((await value.run(["enable", ...project, "--approve"])).body.status, "enabled");
    assert.equal((await value.run(["remove", ...project, "--approve"])).body.status, "removed");

    const user = ["--host", "pi", "--scope", "user"];
    await value.run(["install", ...user, "--source", "npm:@open-treasury/kona@0.1.1", "--approve"]);
    assert.equal((await value.run(["update", ...user])).body.code, "NEW_PIN_REQUIRED");
    assert.equal(
      (
        await value.run([
          "update",
          ...user,
          "--source",
          "npm:@open-treasury/kona@0.2.0",
          "--approve",
        ])
      ).body.status,
      "updated",
    );
    const calls = await readFile(mock.calls, "utf8");
    assert.match(calls, /get_commands/);
    assert.doesNotMatch(calls, /prompt/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Pi refuses pre-existing unmanaged matching packages at project and user scope", async () => {
  for (const scope of ["project", "user"]) {
    const value = await fixture();
    try {
      const mock = await installPiMock(value);
      const source = "npm:@open-treasury/kona@0.1.1";
      await writeFile(mock.state, JSON.stringify({ packages: [{ scope, source, enabled: true }] }));
      const result = await value.run([
        "install",
        "--host",
        "pi",
        "--scope",
        scope,
        "--source",
        "npm:@open-treasury/kona@0.2.0",
        "--approve",
      ]);
      assert.equal(result.body.code, "UNMANAGED_NATIVE_INSTALL");
      assert.deepEqual(JSON.parse(await readFile(mock.state, "utf8")).packages, [
        { scope, source, enabled: true },
      ]);
      assert.doesNotMatch(await readFile(mock.calls, "utf8"), /\["(?:install|remove)"/);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("Pi blocks unmanaged Kona packages across project and user activation scopes", async () => {
  for (const [installedScope, requestedScope] of [
    ["project", "user"],
    ["user", "project"],
  ]) {
    const value = await fixture();
    try {
      const mock = await installPiMock(value);
      const source = "npm:@open-treasury/kona@0.1.1";
      await writeFile(
        mock.state,
        JSON.stringify({ packages: [{ scope: installedScope, source, enabled: true }] }),
      );
      const result = await value.run([
        "install",
        "--host",
        "pi",
        "--scope",
        requestedScope,
        "--source",
        "npm:@open-treasury/kona@0.2.0",
        "--approve",
      ]);
      assert.equal(result.body.code, "UNMANAGED_NATIVE_INSTALL");
      assert.equal(result.body.details.scope, installedScope);
      assert.doesNotMatch(await readFile(mock.calls, "utf8"), /\["install"/);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("Pi blocks native active opposite scopes independently of protected state", async () => {
  for (const [activeScope, requestedScope] of [
    ["project", "user"],
    ["user", "project"],
  ]) {
    const value = await fixture();
    try {
      await installPiMock(value);
      const source = "npm:@open-treasury/kona@0.1.1";
      await value.run([
        "install",
        "--host",
        "pi",
        "--scope",
        activeScope,
        "--source",
        source,
        "--approve",
      ]);
      const path = await manifestPath(value, "pi", activeScope);
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.state = "disabled";
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);

      const result = await value.run([
        "install",
        "--host",
        "pi",
        "--scope",
        requestedScope,
        "--source",
        source,
        "--approve",
      ]);
      assert.equal(result.body.code, "ACTIVE_SCOPE");
      assert.equal(result.body.details.activeScope, activeScope);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("Pi remove retains ownership when RPC hides discovery but native listing remains", async () => {
  const value = await fixture();
  try {
    await installPiMock(value);
    const args = ["--host", "pi", "--scope", "project"];
    await value.run(["install", ...args, "--source", "npm:@open-treasury/kona@0.1.1", "--approve"]);
    value.env.MOCK_PI_HIDE_COMMAND = "1";
    value.env.MOCK_PI_KEEP_PACKAGE = "1";
    const result = await value.run(["remove", ...args, "--approve"]);
    assert.equal(result.body.code, "DISCOVERY_FAILED");
    assert.match(result.body.message, /still lists the package/);
    assert.equal(
      JSON.parse(await readFile(await manifestPath(value, "pi", "project"), "utf8")).host,
      "pi",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Pi failed-install compensation removes only the package Kona just created", async () => {
  const value = await fixture();
  try {
    const mock = await installPiMock(value);
    const unmanaged = { scope: "project", source: "npm:unrelated-package@1.0.0", enabled: true };
    await writeFile(mock.state, JSON.stringify({ packages: [unmanaged] }));
    value.env.MOCK_PI_HIDE_COMMAND = "1";
    const result = await value.run([
      "install",
      "--host",
      "pi",
      "--scope",
      "project",
      "--source",
      "npm:@open-treasury/kona@0.1.1",
      "--approve",
    ]);
    assert.equal(result.body.code, "DISCOVERY_FAILED");
    assert.deepEqual(JSON.parse(await readFile(mock.state, "utf8")).packages, [unmanaged]);
    await missing(await manifestPath(value, "pi", "project"));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("AC15, AC18, AC20-AC21: Claude collaborator bootstrap and all scopes use approved model-free native lifecycle", async () => {
  for (const scope of ["project", "local", "user"]) {
    const value = await fixture();
    try {
      const mock = await installClaudeMock(value);
      const args = ["--host", "claude", "--scope", scope];
      const planned = await value.run(["install", ...args]);
      assert.equal(planned.body.code, "APPROVAL_REQUIRED");
      assert.deepEqual(planned.body.details.plan[0], [
        "claude",
        "plugin",
        "marketplace",
        "add",
        "https://github.com/open-treasury/kona",
      ]);
      assert.equal((await value.run(["install", ...args, "--approve"])).exitCode, 0);
      assert.equal(
        (await value.run(["verify", ...args])).body.details.discovery.native,
        "verified",
      );
      assert.equal((await value.run(["disable", ...args, "--approve"])).body.status, "disabled");
      assert.equal((await value.run(["enable", ...args, "--approve"])).body.status, "enabled");
      assert.equal((await value.run(["remove", ...args, "--approve"])).body.status, "removed");
      const calls = await readFile(mock.calls, "utf8");
      assert.doesNotMatch(calls, /prompt|--print| -p/);
      assert.doesNotMatch(calls, /kona@kona.*--scope/);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("native failure rolls Claude marketplace registration and protected state back", async () => {
  const value = await fixture();
  try {
    const mock = await installClaudeMock(value);
    value.env.MOCK_FAIL = "install";
    const result = await value.run([
      "install",
      "--host",
      "claude",
      "--scope",
      "project",
      "--approve",
    ]);
    assert.equal(result.body.code, "NATIVE_COMMAND_FAILED");
    assert.deepEqual(JSON.parse(await readFile(mock.state, "utf8")), {
      marketplace: false,
      installed: [],
    });
    await missing(join(value.state, "claude/journal.json"));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("project protected state is namespaced by canonical repository root", async () => {
  const value = await fixture();
  const secondProject = join(value.root, "project-two");
  await mkdir(secondProject);
  try {
    await installCopiedHostMock(value, "opencode", "project");
    const first = await value.run(["install", "--host", "opencode", "--scope", "project"]);
    assert.equal(first.exitCode, 0, JSON.stringify(first.body));
    await installCopiedHostMock({ ...value, project: secondProject }, "opencode", "project");
    const second = await runLifecycle(["install", "--host", "opencode", "--scope", "project"], {
      cwd: secondProject,
      env: value.env,
    });
    assert.equal(second.exitCode, 0, JSON.stringify(second.body));
    const projects = await readdir(join(value.state, "opencode/projects"));
    assert.equal(projects.length, 2);
    assert.notEqual(projects[0], projects[1]);
    assert.equal(
      JSON.parse(await readFile(await manifestPath(value, "opencode", "project"), "utf8"))
        .projectRoot,
      await realpath(value.project),
    );
    assert.equal(
      JSON.parse(
        await readFile(await manifestPath(value, "opencode", "project", secondProject), "utf8"),
      ).projectRoot,
      await realpath(secondProject),
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Claude activation ambiguity is isolated to the current repository", async () => {
  const value = await fixture();
  const secondProject = join(value.root, "project-two");
  await mkdir(secondProject);
  try {
    await installClaudeMock(value);
    const install = (project, scope) =>
      runLifecycle(["install", "--host", "claude", "--scope", scope, "--approve"], {
        cwd: project,
        env: value.env,
      });
    assert.equal((await install(value.project, "project")).exitCode, 0);
    assert.equal((await install(secondProject, "project")).exitCode, 0);
    assert.equal((await install(value.project, "local")).body.code, "ACTIVE_SCOPE");
    assert.equal((await install(secondProject, "local")).body.code, "ACTIVE_SCOPE");
    const projects = await readdir(join(value.state, "claude/projects"));
    assert.equal(projects.length, 2);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Claude refuses every mutation of a selected unmanaged native install", async () => {
  for (const verb of ["install", "update", "disable", "enable", "remove"]) {
    const value = await fixture();
    try {
      const mock = await installClaudeMock(value);
      await writeFile(
        mock.state,
        JSON.stringify({
          marketplace: true,
          installed: [
            {
              id: "kona@kona",
              version: "0.1.1",
              scope: "project",
              enabled: verb !== "enable",
              projectPath: value.project,
            },
          ],
        }),
      );
      const result = await value.run([verb, "--host", "claude", "--scope", "project", "--approve"]);
      assert.equal(result.body.code, "UNMANAGED_NATIVE_INSTALL", verb);
      const calls = await readFile(mock.calls, "utf8");
      assert.doesNotMatch(
        calls,
        new RegExp(`plugin ${verb === "remove" ? "uninstall" : verb} kona`),
      );
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("Claude accepts only consistent normalized marketplace source fields and one Kona entry", async () => {
  const accepted = await fixture();
  try {
    const mock = await installClaudeMock(accepted);
    await writeFile(
      mock.state,
      JSON.stringify({
        marketplace: true,
        marketplaces: [
          {
            name: "kona",
            source: {
              source: "github",
              type: "github",
              repo: "open-treasury/kona",
              url: "https://github.com/open-treasury/kona.git",
            },
            url: "git@github.com:open-treasury/kona.git",
          },
        ],
        installed: [],
      }),
    );
    const result = await accepted.run(["install", "--host", "claude", "--scope", "project"]);
    assert.equal(result.body.code, "APPROVAL_REQUIRED");
  } finally {
    await rm(accepted.root, { recursive: true, force: true });
  }

  for (const state of [
    {
      marketplace: true,
      marketplaces: [
        {
          name: "kona",
          source: { url: "https://example.invalid/?next=https://github.com/open-treasury/kona" },
        },
      ],
      installed: [],
    },
    {
      marketplace: true,
      marketplaces: [{ name: "kona", source: { source: "registry", repo: "open-treasury/kona" } }],
      installed: [],
    },
    {
      marketplace: true,
      marketplaces: [
        {
          name: "kona",
          source: {
            source: "github",
            repo: "open-treasury/kona",
            url: "https://github.com/attacker/kona",
          },
        },
      ],
      installed: [],
    },
    {
      marketplace: true,
      marketplaces: [{ name: "kona", source: { source: "github", repo: 42 } }],
      installed: [],
    },
    {
      marketplace: true,
      marketplaces: [
        { name: "kona", source: { source: "github", repo: "open-treasury/kona" } },
        { name: "kona", source: { source: "github", repo: "open-treasury/kona" } },
      ],
      installed: [],
    },
    {
      marketplace: true,
      installed: [],
      available: [
        { pluginId: "kona@kona", name: "kona", marketplaceName: "kona", version: "0.1.1" },
        { pluginId: "kona@kona", name: "kona", marketplaceName: "kona", version: "0.1.1" },
      ],
    },
  ]) {
    const value = await fixture();
    try {
      const mock = await installClaudeMock(value);
      await writeFile(mock.state, JSON.stringify(state));
      const result = await value.run(["install", "--host", "claude", "--scope", "project"]);
      assert.match(result.body.code, /MARKETPLACE|PLUGIN_SOURCE_CONFLICT/);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("failed copied-host discovery rolls back files and protected state", async () => {
  const value = await fixture();
  try {
    await installMock(
      value,
      "opencode",
      'const a=process.argv.slice(2);console.log(a[0]==="agent"?"":"[]")',
    );
    const result = await value.run(["install", "--host", "opencode", "--scope", "project"]);
    assert.equal(result.body.code, "DISCOVERY_FAILED");
    await missing(join(value.project, ".opencode/skills/prd/SKILL.md"));
    await missing(join(value.project, ".opencode/agents/prd-writer.md"));
    await missing(await manifestPath(value, "opencode", "project"));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("OpenCode opposite-scope ambiguity detects an unowned skill or adapter", async () => {
  for (const relativePath of ["skills/prd/SKILL.md", "agents/prd-writer.md"]) {
    const value = await fixture();
    try {
      await installCopiedHostMock(value, "opencode", "project");
      const target = join(value.home, ".config/opencode", relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "unowned\n");
      const result = await value.run(["install", "--host", "opencode", "--scope", "project"]);
      assert.equal(result.body.code, "CROSS_SCOPE_AMBIGUITY");
      assert.deepEqual(result.body.details.paths, [target]);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("unsafe protected-state ancestors and copied-host journals are rejected", async () => {
  const writable = await fixture();
  try {
    await chmod(writable.state, 0o777);
    const result = await writable.run(["verify", "--host", "opencode", "--scope", "project"]);
    assert.equal(result.body.code, "INVALID_STATE");
  } finally {
    await chmod(writable.state, 0o700);
    await rm(writable.root, { recursive: true, force: true });
  }

  const linked = await fixture();
  try {
    const outside = join(linked.root, "outside");
    await mkdir(outside);
    await symlink(outside, join(linked.state, "opencode"));
    const result = await linked.run(["verify", "--host", "opencode", "--scope", "project"]);
    assert.equal(result.body.code, "INVALID_STATE");
  } finally {
    await rm(linked.root, { recursive: true, force: true });
  }
});

test("Pi project unpinned update plan retains local scope and trust arguments", async () => {
  const value = await fixture();
  try {
    await installPiMock(value);
    const args = ["--host", "pi", "--scope", "project"];
    await value.run(["install", ...args, "--source", "npm:@open-treasury/kona", "--approve"]);
    const update = await value.run(["update", ...args]);
    assert.equal(update.body.code, "APPROVAL_REQUIRED");
    assert.deepEqual(update.body.details.plan, [
      ["pi", "update", "npm:@open-treasury/kona", "--approve"],
    ]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("human approval output contains exact executable shell-quoted native plans", async () => {
  const value = await fixture();
  try {
    const mock = await installClaudeMock(value);
    let stderr;
    try {
      await execute(
        process.execPath,
        [join(pluginRoot, "bin/kona.mjs"), "install", "--host", "claude", "--scope", "project"],
        { cwd: value.project, env: value.env },
      );
      assert.fail("approval should be required");
    } catch (error) {
      stderr = error.stderr;
    }
    const commands = stderr
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("'claude'"));
    assert.deepEqual(commands, [
      "'claude' 'plugin' 'marketplace' 'add' 'https://github.com/open-treasury/kona'",
      "'claude' 'plugin' 'install' 'kona' '--scope' 'project'",
    ]);
    for (const command of commands)
      await execute("/bin/sh", ["-c", command], { cwd: value.project, env: value.env });
    assert.equal(JSON.parse(await readFile(mock.state, "utf8")).installed.length, 1);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
