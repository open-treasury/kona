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
const isLegacyPath = (path) => path.includes("/skills/prd/") || path.endsWith("/prd-writer.md");
const isReleasedPath = (path) =>
  !path.includes("/skills/copy/") &&
  !path.endsWith("/copy-writer.md") &&
  !path.includes("/skills/issues/");
const isPreviousPath = (path) => !path.includes("/skills/issues/");
const currentCapabilities = ["copy", "prd", "spec", "issues"];

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

async function createAuthoringCanaries(value) {
  const canaries = new Map([
    [join(value.project, "copy/existing.md"), Buffer.from("authored copy\n")],
    [join(value.project, "specs/existing/prd.md"), Buffer.from("authored PRD\n")],
    [join(value.project, "specs/existing/spec.md"), Buffer.from("authored SPEC\n")],
    [join(value.project, ".unrelated-host-config"), Buffer.from("unrelated config\n")],
  ]);
  for (const [path, bytes] of canaries) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  return async () => {
    for (const [path, bytes] of canaries) assert.deepEqual(await readFile(path), bytes, path);
  };
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
  const copiedRoot =
    scope === "project"
      ? join(value.project, host === "opencode" ? ".opencode" : ".agents")
      : join(value.home, host === "opencode" ? ".config/opencode" : ".agents");
  const skills = Object.fromEntries(
    currentCapabilities.map((name) => [name, join(copiedRoot, `skills/${name}/SKILL.md`)]),
  );
  const source =
    host === "opencode"
      ? `const fs=require("node:fs");const a=process.argv.slice(2);fs.appendFileSync("${calls}",a.join(" ")+"\\n");const skills=${JSON.stringify(skills)};const enabled=Object.entries(skills).filter(([name,path])=>fs.existsSync(path)&&!(name==="spec"&&process.env.MOCK_HIDE_SPEC)&&!(name==="issues"&&process.env.MOCK_HIDE_ISSUES));console.log(a[0]==="agent"?enabled.filter(([name])=>name!=="issues").map(([name])=>name+"-writer (subagent)").join("\\n"):JSON.stringify(enabled.map(([name,location])=>({name,location}))))`
      : `const fs=require("node:fs");fs.appendFileSync("${calls}",process.argv.slice(2).join(" ")+"\\n");let b="";process.stdin.on("data",x=>{b+=x;for(const l of b.split("\\n")){if(!l)continue;const m=JSON.parse(l);fs.appendFileSync("${calls}",m.method+"\\n");if(m.id===1)console.log(JSON.stringify({id:1,result:{}}));if(m.id===2){const paths=${JSON.stringify(skills)};const config="${join(value.home, ".codex/config.toml")}";const enabled=!fs.existsSync(config)||!fs.readFileSync(config,"utf8").includes("enabled = false");const skills=Object.entries(paths).filter(([name,path])=>fs.existsSync(path)&&!(name==="spec"&&process.env.MOCK_HIDE_SPEC)&&!(name==="issues"&&process.env.MOCK_HIDE_ISSUES)).map(([name,path])=>({name,path,enabled}));console.log(JSON.stringify({id:2,result:{data:[{cwd:"${value.project}",skills,errors:[]}]}}))}}})`;
  await installMock(value, host, source);
  return { calls, skills };
}

async function makeCopiedInstallLegacy(value, host, scope = "project") {
  const args = ["--host", host, "--scope", scope];
  const installed = await value.run(["install", ...args]);
  assert.equal(installed.exitCode, 0, JSON.stringify(installed.body));
  const manifestFile = await manifestPath(value, host, scope);
  const current = JSON.parse(await readFile(manifestFile, "utf8"));
  for (const resourcePath of current.paths.filter((candidate) => !isLegacyPath(candidate)))
    await rm(resourcePath, { force: true });
  const legacy = {
    schema: 1,
    capability: "prd",
    version: "0.1.1",
    host,
    scope,
    state: current.state,
    projectRoot: current.projectRoot,
    paths: current.paths.filter(isLegacyPath),
    resources: current.resources.filter(({ path }) => isLegacyPath(path)),
    backups: current.backups.filter(({ path }) => isLegacyPath(path)),
  };
  await writeFile(manifestFile, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
  return { args, path: manifestFile, manifest: legacy };
}

async function makeCopiedInstallReleased(value, host, scope = "project") {
  const args = ["--host", host, "--scope", scope];
  const installed = await value.run(["install", ...args]);
  assert.equal(installed.exitCode, 0, JSON.stringify(installed.body));
  const path = await manifestPath(value, host, scope);
  const current = JSON.parse(await readFile(path, "utf8"));
  for (const resourcePath of current.paths.filter((candidate) => !isReleasedPath(candidate)))
    await rm(resourcePath, { force: true });
  const released = {
    ...current,
    schema: 2,
    version: "0.2.0",
    capabilities: ["prd", "spec"],
    paths: current.paths.filter(isReleasedPath),
    resources: current.resources.filter(({ path: resourcePath }) => isReleasedPath(resourcePath)),
    backups: current.backups.filter(({ path: resourcePath }) => isReleasedPath(resourcePath)),
  };
  await writeFile(path, `${JSON.stringify(released, null, 2)}\n`, { mode: 0o600 });
  return { args, path, manifest: released };
}

async function makeCopiedInstallPrevious(value, host, scope = "project") {
  const args = ["--host", host, "--scope", scope];
  const installed = await value.run(["install", ...args]);
  assert.equal(installed.exitCode, 0, JSON.stringify(installed.body));
  const path = await manifestPath(value, host, scope);
  const current = JSON.parse(await readFile(path, "utf8"));
  for (const resourcePath of current.paths.filter((candidate) => !isPreviousPath(candidate)))
    await rm(resourcePath, { force: true });
  const previous = {
    ...current,
    schema: 3,
    version: "0.3.0",
    capabilities: ["copy", "prd", "spec"],
    paths: current.paths.filter(isPreviousPath),
    resources: current.resources.filter(({ path: resourcePath }) => isPreviousPath(resourcePath)),
    backups: current.backups.filter(({ path: resourcePath }) => isPreviousPath(resourcePath)),
  };
  await writeFile(path, `${JSON.stringify(previous, null, 2)}\n`, { mode: 0o600 });
  return { args, path, manifest: previous };
}

async function makeNativeManifestLegacy(value, host, scope = "project") {
  const path = await manifestPath(value, host, scope);
  const {
    bundle: _bundle,
    capabilities: _capabilities,
    ...current
  } = JSON.parse(await readFile(path, "utf8"));
  const legacy = { ...current, schema: 1, capability: "prd", version: "0.1.1" };
  legacy.nativeIdentity.invocation = host === "claude" ? "/kona:prd" : "/skill:prd";
  await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
  return { path, manifest: legacy };
}

async function makeNativeManifestReleased(value, host, scope = "project") {
  const path = await manifestPath(value, host, scope);
  const released = {
    ...JSON.parse(await readFile(path, "utf8")),
    schema: 2,
    version: "0.2.0",
    capabilities: ["prd", "spec"],
  };
  released.nativeIdentity.invocation = host === "claude" ? "/kona:prd" : "/skill:prd";
  await writeFile(path, `${JSON.stringify(released, null, 2)}\n`, { mode: 0o600 });
  return { path, manifest: released };
}

async function makeNativeManifestPrevious(value, host, scope = "project") {
  const path = await manifestPath(value, host, scope);
  const previous = {
    ...JSON.parse(await readFile(path, "utf8")),
    schema: 3,
    version: "0.3.0",
    capabilities: ["copy", "prd", "spec"],
  };
  await writeFile(path, `${JSON.stringify(previous, null, 2)}\n`, { mode: 0o600 });
  return { path, manifest: previous };
}

async function installClaudeMock(value) {
  const state = join(value.root, "claude.json");
  const calls = join(value.root, "claude.calls");
  const installRoot = join(value.root, "claude-package");
  await writeFile(state, JSON.stringify({ marketplace: false, installed: [] }));
  await installMock(
    value,
    "claude",
    `const fs=require("node:fs");const path=require("node:path");const a=process.argv.slice(2);const p="${state}";const c="${calls}";const s=JSON.parse(fs.readFileSync(p));fs.appendFileSync(c,JSON.stringify(a)+"\\n");const save=()=>fs.writeFileSync(p,JSON.stringify(s));
 if(a.join(" ")==="plugin marketplace list --json")console.log(JSON.stringify(s.marketplaces??(s.marketplace?[{name:"kona",source:{source:"github",repo:"open-treasury/kona"}}]:[])));
 else if(a.join(" ")==="plugin list --json --available")console.log(JSON.stringify({installed:s.installed,available:s.available??(s.marketplace?[{pluginId:"kona@kona",name:"kona",marketplaceName:"kona",version:"0.4.0"}]:[])}));
   else if(a.slice(0,2).join(" ")==="plugin details"){const names=process.env.MOCK_CLAUDE_COMMANDS?JSON.parse(process.env.MOCK_CLAUDE_COMMANDS):["copy","prd","spec","issues"];console.log("kona 0.4.0\\n  Source: "+(process.env.MOCK_CLAUDE_SOURCE||"kona@kona")+"\\n\\nComponent inventory\\n  Skills ("+names.length+")  "+names.join(", "))}
else if(a.slice(0,3).join(" ")==="plugin marketplace add"){s.marketplace=true;save()}
else if(a.slice(0,3).join(" ")==="plugin marketplace remove"){s.marketplace=false;save()}
 else{const v=a[1],scope=a[4],i=s.installed.findIndex(x=>x.scope===scope&&(scope==="user"||x.projectPath===process.cwd()));const root=path.join("${installRoot}",scope);if(process.env.MOCK_FAIL===v)process.exit(7);if(v==="install"||v==="update")fs.cpSync("${join(pluginRoot, "skills")}",path.join(root,"skills"),{recursive:true});if(v==="install")s.installed.push({id:"kona@kona",version:"0.4.0",scope,enabled:true,installPath:root,projectPath:scope==="user"?undefined:process.cwd()});else if(v==="uninstall")s.installed.splice(i,1);else if(v==="disable")s.installed[i].enabled=false;else if(v==="enable")s.installed[i].enabled=true;else if(v!=="update")process.exit(8);save()}`,
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
    `const fs=require("node:fs");const path=require("node:path");const a=process.argv.slice(2);const p="${state}";const c="${calls}";const s=JSON.parse(fs.readFileSync(p));fs.appendFileSync(c,JSON.stringify(a)+"\\n");const save=()=>fs.writeFileSync(p,JSON.stringify(s));const scope=a.includes("-l")?"project":"user";const id=x=>x.replace(/@(?:[0-9].*)$/," ").trim();
 if(a.includes("rpc")){let b="";process.stdin.on("data",x=>{b+=x;if(!b.includes("\\n"))return;fs.appendFileSync(c,JSON.stringify({rpc:JSON.parse(b.trim())})+"\\n");let commands=[];if(!process.env.MOCK_PI_HIDE_COMMAND){for(const x of s.packages.filter(x=>x.enabled)){const base=x.source.startsWith("/")?x.source:"/installed/kona";const names=process.env.MOCK_PI_COMMANDS?JSON.parse(process.env.MOCK_PI_COMMANDS):["copy","prd",...(process.env.MOCK_PI_HIDE_SPEC?[]:["spec"]),...(process.env.MOCK_PI_HIDE_ISSUES?[]:["issues"])];for(const name of names)commands.push({name:"skill:"+name,source:"skill",sourceInfo:{source:process.env.MOCK_PI_WRONG_SOURCE||x.source,scope:process.env.MOCK_PI_WRONG_SCOPE||x.scope,origin:"package",baseDir:base,path:process.env.MOCK_PI_WRONG_PATH||path.join(base,"plugin","skills",name,"SKILL.md")}})}}if(process.env.MOCK_PI_DUPLICATE&&commands.length)commands.push({...commands[0]});if(process.env.MOCK_PI_UNRELATED)commands.push({name:"unrelated",source:"extension",sourceInfo:{source:"other",scope,origin:"package",baseDir:"/other",path:"/other/index.js"}});console.log(JSON.stringify({type:"response",command:"get_commands",success:true,data:{commands}}))})}
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
        const assertCanaries = await createAuthoringCanaries(value);
        const args = ["--host", host, "--scope", scope];
        const installed = await value.run(["install", ...args]);
        assert.equal(installed.exitCode, 0, JSON.stringify(installed.body));
        assert.deepEqual(
          {
            version: installed.body.details.version,
            scope: installed.body.details.scope,
            invocation: installed.body.details.invocation,
            invocations: installed.body.details.invocations,
            native: installed.body.details.verification.native,
          },
          {
            version: "0.4.0",
            scope,
            invocation: host === "opencode" ? "@copy-writer" : "$copy",
            invocations:
              host === "opencode"
                ? {
                    copy: "@copy-writer",
                    prd: "@prd-writer",
                    spec: "@spec-writer",
                    issues: "issues",
                  }
                : { copy: "$copy", prd: "$prd", spec: "$spec", issues: "$issues" },
            native: "verified",
          },
        );
        assert.deepEqual(
          installed.body.details.capabilities.map(({ id, integrity }) => ({ id, integrity })),
          currentCapabilities.map((id) => ({
            id,
            integrity: { canonical: "verified", native: "verified" },
          })),
        );
        assert.equal((await value.run(["install", ...args])).body.status, "unchanged");
        const root =
          scope === "project"
            ? value.project
            : host === "opencode"
              ? join(value.home, ".config/opencode")
              : value.home;
        const copiedRoot =
          host === "opencode"
            ? join(root, scope === "project" ? ".opencode" : "")
            : join(root, ".agents");
        for (const name of currentCapabilities) {
          for (const resource of Object.values(
            JSON.parse(await readFile(join(pluginRoot, `capabilities/${name}.json`), "utf8"))
              .canonical,
          ))
            assert.deepEqual(
              await readFile(join(copiedRoot, resource.path)),
              await readFile(join(pluginRoot, resource.path)),
            );
          if (host === "opencode" && name !== "issues")
            assert.deepEqual(
              await readFile(join(copiedRoot, `agents/${name}-writer.md`)),
              await readFile(join(pluginRoot, `hosts/opencode/agents/${name}-writer.md`)),
            );
        }
        const manifest = JSON.parse(await readFile(await manifestPath(value, host, scope), "utf8"));
        assert.equal(manifest.schema, 4);
        assert.equal(manifest.bundle, "authoring");
        assert.deepEqual(manifest.capabilities, currentCapabilities);
        assert.equal(manifest.resources.length, host === "opencode" ? 11 : 8);
        const updated = await value.run(["update", ...args]);
        assert.equal(updated.body.status, "updated");
        assert.equal(updated.body.details.verification.native, "verified");
        assert.equal(updated.body.details.version, "0.4.0");
        assert.equal(updated.body.details.scope, scope);
        assert.equal((await value.run(["disable", ...args])).body.status, "disabled");
        const enabled = await value.run(["enable", ...args]);
        assert.equal(enabled.body.status, "enabled", JSON.stringify(enabled.body));
        assert.equal(enabled.body.details.verification.native, "verified");
        assert.equal(
          enabled.body.details.invocation,
          host === "opencode" ? "@copy-writer" : "$copy",
        );
        assert.deepEqual(
          enabled.body.details.invocations,
          host === "opencode"
            ? { copy: "@copy-writer", prd: "@prd-writer", spec: "@spec-writer", issues: "issues" }
            : { copy: "$copy", prd: "$prd", spec: "$spec", issues: "$issues" },
        );
        assert.equal((await value.run(["remove", ...args])).body.status, "removed");
        for (const name of currentCapabilities) {
          await missing(join(copiedRoot, `skills/${name}/SKILL.md`));
          if (host === "opencode" && name !== "issues")
            await missing(join(copiedRoot, `agents/${name}-writer.md`));
        }
        await assertCanaries();
      } finally {
        await rm(value.root, { recursive: true, force: true });
      }
    }
  }
});

test("schema-v1 copied installs require update and retain their legacy lifecycle", async () => {
  for (const host of ["opencode", "codex"]) {
    const value = await fixture();
    try {
      await installCopiedHostMock(value, host);
      const legacy = await makeCopiedInstallLegacy(value, host);
      for (const verb of ["verify", "install"]) {
        const result = await value.run([verb, ...legacy.args]);
        assert.equal(
          result.body.code,
          "UPDATE_REQUIRED",
          `${host} ${verb}: ${JSON.stringify(result.body)}`,
        );
        assert.equal(result.body.details.invocation, host === "opencode" ? "@prd-writer" : "$prd");
        assert.deepEqual(result.body.details.invocations, {
          prd: host === "opencode" ? "@prd-writer" : "$prd",
        });
      }

      assert.equal((await value.run(["disable", ...legacy.args])).body.status, "disabled");
      assert.equal(JSON.parse(await readFile(legacy.path, "utf8")).schema, 1);
      assert.equal((await value.run(["update", ...legacy.args])).body.code, "DISABLED");
      assert.equal(JSON.parse(await readFile(legacy.path, "utf8")).schema, 1);
      const enabled = await value.run(["enable", ...legacy.args]);
      assert.equal(enabled.body.status, "enabled", JSON.stringify(enabled.body));
      const preserved = JSON.parse(await readFile(legacy.path, "utf8"));
      assert.equal(preserved.schema, 1);
      assert.equal(preserved.capability, "prd");
      assert.equal(preserved.bundle, undefined);

      const specCanary =
        host === "opencode"
          ? join(value.project, ".opencode/skills/spec/SKILL.md")
          : join(value.project, ".agents/skills/spec/SKILL.md");
      await mkdir(dirname(specCanary), { recursive: true });
      await writeFile(specCanary, "unowned spec\n");
      assert.equal((await value.run(["remove", ...legacy.args])).body.status, "removed");
      assert.equal(await readFile(specCanary, "utf8"), "unowned spec\n");
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }

    const migrating = await fixture();
    try {
      await installCopiedHostMock(migrating, host);
      const legacy = await makeCopiedInstallLegacy(migrating, host);
      const result = await migrating.run(["update", ...legacy.args]);
      assert.equal(result.body.status, "updated", JSON.stringify(result.body));
      const manifest = JSON.parse(await readFile(legacy.path, "utf8"));
      assert.equal(manifest.schema, 4);
      assert.equal(manifest.bundle, "authoring");
      assert.deepEqual(manifest.capabilities, currentCapabilities);
      assert.equal(manifest.resources.length, host === "opencode" ? 11 : 8);
    } finally {
      await rm(migrating.root, { recursive: true, force: true });
    }
  }
});

test("released schema-v2 copied bundles expand to copy only through explicit update", async () => {
  for (const host of ["opencode", "codex"]) {
    const value = await fixture();
    try {
      await installCopiedHostMock(value, host);
      const released = await makeCopiedInstallReleased(value, host);
      for (const verb of ["install", "verify"]) {
        const observed = await value.run([verb, ...released.args]);
        assert.equal(observed.body.code, "UPDATE_REQUIRED", `${host}/${verb}`);
        assert.deepEqual(Object.keys(observed.body.details.invocations), ["prd", "spec"]);
      }
      const updated = await value.run(["update", ...released.args]);
      assert.equal(updated.body.status, "updated", JSON.stringify(updated.body));
      const manifest = JSON.parse(await readFile(released.path, "utf8"));
      assert.equal(manifest.schema, 4);
      assert.deepEqual(manifest.capabilities, currentCapabilities);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("disabled released schema-v2 copied bundles must be enabled before expansion", async () => {
  const value = await fixture();
  try {
    await installCopiedHostMock(value, "opencode");
    const released = await makeCopiedInstallReleased(value, "opencode");
    assert.equal((await value.run(["disable", ...released.args])).body.status, "disabled");
    assert.equal((await value.run(["update", ...released.args])).body.code, "DISABLED");
    assert.equal(JSON.parse(await readFile(released.path, "utf8")).schema, 2);
    assert.equal((await value.run(["enable", ...released.args])).body.status, "enabled");
    assert.equal((await value.run(["update", ...released.args])).body.status, "updated");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("released schema-v2 version skew is rejected before adding copy", async () => {
  const value = await fixture();
  try {
    await installCopiedHostMock(value, "opencode");
    const released = await makeCopiedInstallReleased(value, "opencode");
    const skewed = { ...released.manifest, version: "0.2.1" };
    await writeFile(released.path, `${JSON.stringify(skewed, null, 2)}\n`, { mode: 0o600 });
    const result = await value.run(["update", ...released.args]);
    assert.equal(result.body.code, "INVALID_STATE");
    await missing(join(value.project, ".opencode/skills/copy/SKILL.md"));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("schemas 1, 2, and 3 preserve copied capability ownership through disable, enable, and remove", async () => {
  const fixtures = [
    [makeCopiedInstallLegacy, ["prd"], "skills/spec/SKILL.md"],
    [makeCopiedInstallReleased, ["prd", "spec"], "skills/copy/SKILL.md"],
    [makeCopiedInstallPrevious, ["copy", "prd", "spec"], "skills/issues/SKILL.md"],
  ];
  for (const [makeLegacy, capabilities, unownedPath] of fixtures) {
    const value = await fixture();
    try {
      await installCopiedHostMock(value, "opencode");
      const legacy = await makeLegacy(value, "opencode");
      const manifestBefore = await readFile(legacy.path);
      const filesBefore = await Promise.all(legacy.manifest.paths.map((path) => readFile(path)));
      for (const verb of ["install", "verify"]) {
        const result = await value.run([verb, ...legacy.args]);
        assert.equal(result.body.code, "UPDATE_REQUIRED", `${legacy.manifest.schema}/${verb}`);
        assert.deepEqual(await readFile(legacy.path), manifestBefore);
        for (const [index, path] of legacy.manifest.paths.entries())
          assert.deepEqual(await readFile(path), filesBefore[index]);
      }

      assert.equal((await value.run(["disable", ...legacy.args])).body.status, "disabled");
      let preserved = JSON.parse(await readFile(legacy.path, "utf8"));
      assert.equal(preserved.schema, legacy.manifest.schema);
      assert.deepEqual(preserved.capabilities ?? [preserved.capability], capabilities);
      assert.equal((await value.run(["enable", ...legacy.args])).body.status, "enabled");
      preserved = JSON.parse(await readFile(legacy.path, "utf8"));
      assert.equal(preserved.schema, legacy.manifest.schema);
      assert.deepEqual(preserved.capabilities ?? [preserved.capability], capabilities);

      const unowned = join(value.project, ".opencode", unownedPath);
      await mkdir(dirname(unowned), { recursive: true });
      await writeFile(unowned, "unowned newer capability\n");
      assert.equal((await value.run(["remove", ...legacy.args])).body.status, "removed");
      assert.equal(await readFile(unowned, "utf8"), "unowned newer capability\n");
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("schema-v3 copied bundles migrate directly to strict schema 4 only through update", async () => {
  for (const host of ["opencode", "codex"]) {
    const value = await fixture();
    try {
      await installCopiedHostMock(value, host);
      const previous = await makeCopiedInstallPrevious(value, host);
      for (const verb of ["install", "verify"])
        assert.equal((await value.run([verb, ...previous.args])).body.code, "UPDATE_REQUIRED");
      const updated = await value.run(["update", ...previous.args]);
      assert.equal(updated.body.status, "updated", JSON.stringify(updated.body));
      const manifest = JSON.parse(await readFile(previous.path, "utf8"));
      assert.equal(manifest.schema, 4);
      assert.deepEqual(manifest.capabilities, currentCapabilities);
      assert.ok(manifest.paths.some((path) => path.endsWith("/skills/issues/SKILL.md")));
      assert.ok(!manifest.paths.some((path) => path.endsWith("/issues-writer.md")));
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("copied schema-v1 and schema-v3 migration rollback restores exact files, config, manifest, and backups", async () => {
  for (const makeLegacy of [makeCopiedInstallLegacy, makeCopiedInstallPrevious]) {
    const value = await fixture();
    try {
      await installCopiedHostMock(value, "codex");
      const legacy = await makeLegacy(value, "codex");
      const target = legacy.manifest.paths[0];
      const backupBytes = Buffer.from("pre-kona bytes\n");
      const backup = join(
        dirname(legacy.path),
        "backups",
        `${digest(target)}-${digest(backupBytes)}`,
      );
      await mkdir(dirname(backup), { recursive: true });
      await writeFile(backup, backupBytes, { mode: 0o600 });
      legacy.manifest.backups.push({
        path: target,
        backup,
        sha256: digest(backupBytes),
        mode: "0644",
      });
      await writeFile(legacy.path, `${JSON.stringify(legacy.manifest, null, 2)}\n`, {
        mode: 0o600,
      });
      const config = join(value.home, ".codex/config.toml");
      await mkdir(dirname(config), { recursive: true });
      await writeFile(config, 'model = "gpt-5"\n');
      const manifestBefore = await readFile(legacy.path);
      const filesBefore = await Promise.all(legacy.manifest.paths.map((path) => readFile(path)));
      value.env[legacy.manifest.schema === 1 ? "MOCK_HIDE_SPEC" : "MOCK_HIDE_ISSUES"] = "1";

      const result = await value.run(["update", ...legacy.args]);
      assert.equal(result.body.code, "DISCOVERY_FAILED");
      assert.deepEqual(await readFile(legacy.path), manifestBefore);
      for (const [index, path] of legacy.manifest.paths.entries())
        assert.deepEqual(await readFile(path), filesBefore[index]);
      assert.deepEqual(await readFile(backup), backupBytes);
      assert.equal(await readFile(config, "utf8"), 'model = "gpt-5"\n');
      const added = legacy.manifest.schema === 1 ? "spec" : "issues";
      await missing(join(value.project, `.agents/skills/${added}/SKILL.md`));
      await missing(join(value.state, "codex/journal.json"));
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("legacy allowlist validation and unknown schemas fail before copied-host mutation", async () => {
  for (const variant of ["extra-path", "unshipped-version", "newer-schema"]) {
    const value = await fixture();
    try {
      await installCopiedHostMock(value, "opencode");
      const legacy = await makeCopiedInstallLegacy(value, "opencode");
      const manifest = JSON.parse(await readFile(legacy.path, "utf8"));
      if (variant === "extra-path") {
        manifest.paths.push(join(value.project, "outside"));
        manifest.resources.push({
          path: join(value.project, "outside"),
          sha256: digest("counterfeit"),
          mode: "0644",
        });
      } else if (variant === "unshipped-version") manifest.version = "0.1.2";
      else manifest.schema = 5;
      await writeFile(legacy.path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      const prdBefore = await readFile(legacy.manifest.paths[0]);
      const result = await value.run(["update", ...legacy.args]);
      assert.equal(result.body.code, "INVALID_STATE");
      assert.deepEqual(await readFile(legacy.manifest.paths[0]), prdBefore);
      await missing(join(value.project, ".opencode/skills/spec/SKILL.md"));
    } finally {
      await rm(value.root, { recursive: true, force: true });
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

test("OpenCode and Codex reject partial bundle discovery at every scope", async () => {
  for (const host of ["opencode", "codex"]) {
    for (const scope of ["project", "user"]) {
      const value = await fixture();
      try {
        await installCopiedHostMock(value, host, scope);
        const args = ["--host", host, "--scope", scope];
        assert.equal((await value.run(["install", ...args])).exitCode, 0);
        value.env.MOCK_HIDE_ISSUES = "1";
        const result = await value.run(["verify", ...args]);
        assert.equal(result.body.code, "DISCOVERY_FAILED", `${host}/${scope}`);
        assert.match(result.body.message, /issues/i);
      } finally {
        await rm(value.root, { recursive: true, force: true });
      }
    }
  }
});

test("Codex disable owns one bounded block with all skills and preserves unrelated TOML", async () => {
  const value = await fixture();
  try {
    await installCopiedHostMock(value, "codex");
    const config = join(value.home, ".codex/config.toml");
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, 'model = "gpt-5"\n');
    const args = ["--host", "codex", "--scope", "project"];
    assert.equal((await value.run(["install", ...args])).exitCode, 0);
    assert.equal((await value.run(["disable", ...args])).body.status, "disabled");
    const disabled = await readFile(config, "utf8");
    assert.equal(disabled.match(/# >>> kona prd project/g)?.length, 1);
    assert.equal(disabled.match(/# <<< kona prd project/g)?.length, 1);
    assert.equal(disabled.match(/\[\[skills\.config\]\]/g)?.length, 4);
    assert.match(disabled, /skills\/copy\/SKILL\.md/);
    assert.match(disabled, /skills\/prd\/SKILL\.md/);
    assert.match(disabled, /skills\/spec\/SKILL\.md/);
    assert.match(disabled, /skills\/issues\/SKILL\.md/);
    assert.ok(disabled.startsWith('model = "gpt-5"\n'));
    assert.equal((await value.run(["verify", ...args])).body.status, "disabled");
    assert.equal((await value.run(["enable", ...args])).body.status, "enabled");
    assert.equal(await readFile(config, "utf8"), 'model = "gpt-5"\n');
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("AC14-AC21: Pi native package lifecycle is approved, scope-safe, pinned-update aware, and model-free", async () => {
  const value = await fixture();
  try {
    const mock = await installPiMock(value);
    const assertCanaries = await createAuthoringCanaries(value);
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
    const projectVerification = await value.run(["verify", ...project]);
    assert.deepEqual(projectVerification.body.details.discovery.invocations, {
      copy: "/skill:copy",
      prd: "/skill:prd",
      spec: "/skill:spec",
      issues: "/skill:issues",
    });
    assert.deepEqual(
      projectVerification.body.details.discovery.capabilities.map(({ id, integrity }) => ({
        id,
        integrity,
      })),
      currentCapabilities.map((id) => ({
        id,
        integrity: { canonical: "verified", native: "verified" },
      })),
    );
    assert.deepEqual(
      JSON.parse(await readFile(await manifestPath(value, "pi", "project"), "utf8")),
      {
        schema: 4,
        bundle: "authoring",
        capabilities: currentCapabilities,
        version: "0.4.0",
        host: "pi",
        scope: "project",
        state: "active",
        projectRoot: await realpath(value.project),
        nativeIdentity: {
          source: repositoryRoot,
          package: `local:${repositoryRoot}`,
          kind: "local",
          pinned: false,
          pin: null,
          invocation: "/skill:copy",
        },
      },
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
    const userInstall = await value.run([
      "install",
      ...user,
      "--source",
      "npm:@open-treasury/kona@0.4.0",
      "--approve",
    ]);
    assert.deepEqual(userInstall.body.details.discovery.invocations, {
      copy: "/skill:copy",
      prd: "/skill:prd",
      spec: "/skill:spec",
      issues: "/skill:issues",
    });
    assert.equal((await value.run(["update", ...user])).body.code, "NEW_PIN_REQUIRED");
    assert.equal(
      (
        await value.run([
          "update",
          ...user,
          "--source",
          "npm:@open-treasury/kona@0.5.0",
          "--approve",
        ])
      ).body.status,
      "updated",
    );
    const calls = await readFile(mock.calls, "utf8");
    assert.match(calls, /get_commands/);
    assert.doesNotMatch(calls, /prompt/);
    await assertCanaries();
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("schema-v1 Pi state reports update-required and remains inspectable through removal", async () => {
  const value = await fixture();
  try {
    await installPiMock(value);
    const args = ["--host", "pi", "--scope", "project"];
    assert.equal(
      (await value.run(["install", ...args, "--source", repositoryRoot, "--approve"])).exitCode,
      0,
    );
    const legacy = await makeNativeManifestLegacy(value, "pi");
    value.env.MOCK_PI_COMMANDS = JSON.stringify(["prd"]);
    for (const verb of ["verify", "install"]) {
      const result = await value.run([verb, ...args]);
      assert.equal(result.body.code, "UPDATE_REQUIRED");
      assert.deepEqual(result.body.details.discovery.invocations, { prd: "/skill:prd" });
    }
    assert.equal((await value.run(["disable", ...args, "--approve"])).body.status, "disabled");
    assert.equal(JSON.parse(await readFile(legacy.path, "utf8")).schema, 1);
    assert.equal((await value.run(["enable", ...args, "--approve"])).body.status, "enabled");
    assert.equal(JSON.parse(await readFile(legacy.path, "utf8")).schema, 1);
    assert.equal((await value.run(["remove", ...args, "--approve"])).body.status, "removed");
    await missing(legacy.path);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("active schema-v1 Pi update verifies the package before committing schema 4", async () => {
  const value = await fixture();
  try {
    await installPiMock(value);
    const args = ["--host", "pi", "--scope", "project"];
    assert.equal(
      (await value.run(["install", ...args, "--source", repositoryRoot, "--approve"])).exitCode,
      0,
    );
    const legacy = await makeNativeManifestLegacy(value, "pi");
    const updated = await value.run(["update", ...args, "--approve"]);
    assert.equal(updated.body.status, "updated", JSON.stringify(updated.body));
    assert.deepEqual(updated.body.details.discovery.invocations, {
      copy: "/skill:copy",
      prd: "/skill:prd",
      spec: "/skill:spec",
      issues: "/skill:issues",
    });
    const manifest = JSON.parse(await readFile(legacy.path, "utf8"));
    assert.equal(manifest.schema, 4);
    assert.deepEqual(manifest.capabilities, currentCapabilities);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Pi refuses pre-existing unmanaged matching packages at project and user scope", async () => {
  for (const scope of ["project", "user"]) {
    const value = await fixture();
    try {
      const mock = await installPiMock(value);
      const source = "npm:@open-treasury/kona@0.4.0";
      await writeFile(mock.state, JSON.stringify({ packages: [{ scope, source, enabled: true }] }));
      const result = await value.run([
        "install",
        "--host",
        "pi",
        "--scope",
        scope,
        "--source",
        "npm:@open-treasury/kona@0.4.0",
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
      const source = "npm:@open-treasury/kona@0.4.0";
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
        "npm:@open-treasury/kona@0.4.0",
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
      const source = "npm:@open-treasury/kona@0.4.0";
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
    await value.run(["install", ...args, "--source", "npm:@open-treasury/kona@0.4.0", "--approve"]);
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
      "npm:@open-treasury/kona@0.4.0",
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
      const assertCanaries = await createAuthoringCanaries(value);
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
      const manifest = JSON.parse(
        await readFile(await manifestPath(value, "claude", scope), "utf8"),
      );
      assert.equal(manifest.schema, 4);
      assert.equal(manifest.bundle, "authoring");
      assert.deepEqual(manifest.capabilities, currentCapabilities);
      assert.equal(manifest.nativeIdentity.invocation, "/kona:copy");
      assert.equal(
        (await value.run(["verify", ...args])).body.details.discovery.native,
        "verified",
      );
      assert.deepEqual((await value.run(["verify", ...args])).body.details.discovery.invocations, {
        copy: "/kona:copy",
        prd: "/kona:prd",
        spec: "/kona:spec",
        issues: "/kona:issues",
      });
      assert.deepEqual(
        (await value.run(["verify", ...args])).body.details.discovery.capabilities.map(
          ({ id, integrity }) => ({ id, integrity }),
        ),
        currentCapabilities.map((id) => ({
          id,
          integrity: { canonical: "verified", native: "verified" },
        })),
      );
      assert.equal((await value.run(["disable", ...args, "--approve"])).body.status, "disabled");
      assert.equal((await value.run(["enable", ...args, "--approve"])).body.status, "enabled");
      assert.equal((await value.run(["remove", ...args, "--approve"])).body.status, "removed");
      const calls = await readFile(mock.calls, "utf8");
      assert.doesNotMatch(calls, /prompt|--print| -p/);
      assert.doesNotMatch(calls, /kona@kona.*--scope/);
      await assertCanaries();
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("Claude rejects incomplete, ambiguous, misplaced, or altered package capability surfaces", async () => {
  const variants = [
    "missing",
    "duplicate",
    "wrong-scope",
    "wrong-source",
    "wrong-path",
    "altered-payload",
  ];
  const scopes = ["project", "local", "user"];
  for (const [index, variant] of variants.entries()) {
    const value = await fixture();
    try {
      const mock = await installClaudeMock(value);
      const scope = scopes[index % scopes.length];
      const args = ["--host", "claude", "--scope", scope];
      assert.equal((await value.run(["install", ...args, "--approve"])).exitCode, 0);
      if (variant === "missing") value.env.MOCK_CLAUDE_COMMANDS = JSON.stringify(["prd"]);
      if (variant === "duplicate")
        value.env.MOCK_CLAUDE_COMMANDS = JSON.stringify([
          "copy",
          "prd",
          "spec",
          "issues",
          "issues",
        ]);
      if (variant === "wrong-source") value.env.MOCK_CLAUDE_SOURCE = "kona@other";
      if (["wrong-scope", "wrong-path"].includes(variant)) {
        const state = JSON.parse(await readFile(mock.state, "utf8"));
        const entry = state.installed[0];
        if (variant === "wrong-scope") entry.scope = scope === "user" ? "project" : "user";
        if (variant === "wrong-path") entry.installPath = join(value.root, "wrong-package");
        await writeFile(mock.state, JSON.stringify(state));
      }
      if (variant === "altered-payload") {
        const state = JSON.parse(await readFile(mock.state, "utf8"));
        await writeFile(join(state.installed[0].installPath, "skills/copy/SKILL.md"), "altered\n");
      }
      const result = await value.run(["verify", ...args]);
      assert.notEqual(result.exitCode, 0, `${scope}/${variant}: ${JSON.stringify(result.body)}`);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("Pi requires exact bundle package command provenance at project and user scope", async () => {
  const variants = [
    ["MOCK_PI_HIDE_SPEC", "1"],
    ["MOCK_PI_DUPLICATE", "1"],
    ["MOCK_PI_WRONG_SCOPE", "user"],
    ["MOCK_PI_WRONG_SOURCE", "npm:counterfeit"],
    ["MOCK_PI_WRONG_PATH", "/counterfeit/SKILL.md"],
  ];
  for (const scope of ["project", "user"]) {
    for (const [environment, setting] of variants) {
      const value = await fixture();
      try {
        await installPiMock(value);
        const args = ["--host", "pi", "--scope", scope];
        assert.equal(
          (
            await value.run([
              "install",
              ...args,
              "--source",
              "npm:@open-treasury/kona@0.4.0",
              "--approve",
            ])
          ).exitCode,
          0,
        );
        value.env[environment] =
          environment === "MOCK_PI_WRONG_SCOPE" && scope === "user" ? "project" : setting;
        const result = await value.run(["verify", ...args]);
        assert.equal(result.body.code, "DISCOVERY_FAILED", `${scope}/${environment}`);
      } finally {
        await rm(value.root, { recursive: true, force: true });
      }
    }
  }

  const value = await fixture();
  try {
    await installPiMock(value);
    const args = ["--host", "pi", "--scope", "project"];
    assert.equal(
      (
        await value.run([
          "install",
          ...args,
          "--source",
          "npm:@open-treasury/kona@0.4.0",
          "--approve",
        ])
      ).exitCode,
      0,
    );
    value.env.MOCK_PI_UNRELATED = "1";
    assert.equal((await value.run(["verify", ...args])).exitCode, 0);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("active schema-v1 Claude state migrates only through explicit update", async () => {
  const value = await fixture();
  try {
    await installClaudeMock(value);
    const args = ["--host", "claude", "--scope", "project"];
    assert.equal((await value.run(["install", ...args, "--approve"])).exitCode, 0);
    const legacy = await makeNativeManifestLegacy(value, "claude");
    value.env.MOCK_CLAUDE_COMMANDS = JSON.stringify(["prd"]);
    const verified = await value.run(["verify", ...args]);
    assert.equal(verified.body.code, "UPDATE_REQUIRED");
    assert.deepEqual(verified.body.details.discovery.invocations, { prd: "/kona:prd" });
    assert.equal((await value.run(["install", ...args])).body.code, "UPDATE_REQUIRED");
    value.env.MOCK_CLAUDE_COMMANDS = JSON.stringify(currentCapabilities);
    const updated = await value.run(["update", ...args, "--approve"]);
    assert.equal(updated.body.status, "updated", JSON.stringify(updated.body));
    const manifest = JSON.parse(await readFile(legacy.path, "utf8"));
    assert.equal(manifest.schema, 4);
    assert.equal(manifest.bundle, "authoring");
    assert.deepEqual(manifest.capabilities, currentCapabilities);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("released schema-v2 native bundles require explicit update before reporting copy", async () => {
  for (const host of ["claude", "pi"]) {
    const value = await fixture();
    try {
      if (host === "claude") await installClaudeMock(value);
      else await installPiMock(value);
      const args = ["--host", host, "--scope", "project"];
      const installArgs =
        host === "claude"
          ? [...args, "--approve"]
          : [...args, "--source", repositoryRoot, "--approve"];
      assert.equal((await value.run(["install", ...installArgs])).exitCode, 0);
      const released = await makeNativeManifestReleased(value, host);
      const observed = await value.run(["verify", ...args]);
      assert.equal(
        observed.body.code,
        "UPDATE_REQUIRED",
        `${host}: ${JSON.stringify(observed.body)}`,
      );
      assert.deepEqual(Object.keys(observed.body.details.discovery.invocations), ["prd", "spec"]);
      const updated = await value.run(["update", ...args, "--approve"]);
      assert.equal(updated.body.status, "updated", JSON.stringify(updated.body));
      const manifest = JSON.parse(await readFile(released.path, "utf8"));
      assert.equal(manifest.schema, 4);
      assert.deepEqual(manifest.capabilities, currentCapabilities);
      assert.deepEqual(Object.keys(updated.body.details.discovery.invocations), [
        "copy",
        "prd",
        "spec",
        "issues",
      ]);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("schemas 1, 2, and 3 preserve native capability identity through disable, enable, and remove", async () => {
  const schemas = [
    [makeNativeManifestLegacy, ["prd"]],
    [makeNativeManifestReleased, ["prd", "spec"]],
    [makeNativeManifestPrevious, ["copy", "prd", "spec"]],
  ];
  for (const host of ["claude", "pi"]) {
    for (const [makeLegacy, capabilities] of schemas) {
      const value = await fixture();
      try {
        if (host === "claude") await installClaudeMock(value);
        else await installPiMock(value);
        const args = ["--host", host, "--scope", "project"];
        const installArgs =
          host === "claude"
            ? [...args, "--approve"]
            : [...args, "--source", repositoryRoot, "--approve"];
        assert.equal((await value.run(["install", ...installArgs])).exitCode, 0);
        const legacy = await makeLegacy(value, host);
        const manifestBefore = await readFile(legacy.path);

        for (const verb of ["install", "verify"]) {
          const result = await value.run([verb, ...args]);
          assert.equal(result.body.code, "UPDATE_REQUIRED", `${host}/${legacy.manifest.schema}`);
          assert.deepEqual(await readFile(legacy.path), manifestBefore);
        }
        assert.equal((await value.run(["disable", ...args, "--approve"])).body.status, "disabled");
        let preserved = JSON.parse(await readFile(legacy.path, "utf8"));
        assert.equal(preserved.schema, legacy.manifest.schema);
        assert.deepEqual(preserved.capabilities ?? [preserved.capability], capabilities);
        assert.equal((await value.run(["enable", ...args, "--approve"])).body.status, "enabled");
        preserved = JSON.parse(await readFile(legacy.path, "utf8"));
        assert.equal(preserved.schema, legacy.manifest.schema);
        assert.deepEqual(preserved.capabilities ?? [preserved.capability], capabilities);
        assert.equal((await value.run(["remove", ...args, "--approve"])).body.status, "removed");
        await missing(legacy.path);
      } finally {
        await rm(value.root, { recursive: true, force: true });
      }
    }
  }
});

test("schema-v3 native bundles migrate directly to strict schema 4 only through approved update", async () => {
  for (const host of ["claude", "pi"]) {
    const value = await fixture();
    try {
      if (host === "claude") await installClaudeMock(value);
      else await installPiMock(value);
      const args = ["--host", host, "--scope", "project"];
      const installArgs =
        host === "claude"
          ? [...args, "--approve"]
          : [...args, "--source", repositoryRoot, "--approve"];
      assert.equal((await value.run(["install", ...installArgs])).exitCode, 0);
      const previous = await makeNativeManifestPrevious(value, host);
      assert.equal((await value.run(["install", ...args])).body.code, "UPDATE_REQUIRED");
      assert.equal((await value.run(["verify", ...args])).body.code, "UPDATE_REQUIRED");
      assert.equal((await value.run(["update", ...args])).body.code, "APPROVAL_REQUIRED");
      const updated = await value.run(["update", ...args, "--approve"]);
      assert.equal(updated.body.status, "updated", JSON.stringify(updated.body));
      const manifest = JSON.parse(await readFile(previous.path, "utf8"));
      assert.equal(manifest.schema, 4);
      assert.deepEqual(manifest.capabilities, currentCapabilities);
      assert.equal(
        updated.body.details.discovery.invocations.issues,
        host === "claude" ? "/kona:issues" : "/skill:issues",
      );
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("failed native schema-v3 migration retains exact prior state and recovery evidence", async () => {
  for (const host of ["claude", "pi"]) {
    const value = await fixture();
    try {
      const mock = host === "claude" ? await installClaudeMock(value) : await installPiMock(value);
      const args = ["--host", host, "--scope", "project"];
      const installArgs =
        host === "claude"
          ? [...args, "--approve"]
          : [...args, "--source", repositoryRoot, "--approve"];
      assert.equal((await value.run(["install", ...installArgs])).exitCode, 0);
      const previous = await makeNativeManifestPrevious(value, host);
      const manifestBefore = await readFile(previous.path);
      const nativeStateBefore = await readFile(mock.state);
      if (host === "claude")
        value.env.MOCK_CLAUDE_COMMANDS = JSON.stringify(["copy", "prd", "spec"]);
      else value.env.MOCK_PI_COMMANDS = JSON.stringify(["copy", "prd", "spec"]);

      const result = await value.run(["update", ...args, "--approve"]);
      assert.equal(result.body.code, "RECOVERY_PARTIAL", `${host}: ${JSON.stringify(result.body)}`);
      assert.deepEqual(await readFile(previous.path), manifestBefore);
      assert.deepEqual(await readFile(mock.state), nativeStateBefore);
      const journalPath = join(value.state, host, "journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      assert.equal(journal.operation, "update");
      assert.equal(journal.manifestPreimage, manifestBefore.toString("utf8"));
      assert.deepEqual(journal.completed, ["update"]);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("strict schema 4 capability drift and newer native schemas fail before mutation", async () => {
  for (const host of ["claude", "pi"]) {
    for (const variant of ["capabilities", "newer-schema"]) {
      const value = await fixture();
      try {
        const mock =
          host === "claude" ? await installClaudeMock(value) : await installPiMock(value);
        const args = ["--host", host, "--scope", "project"];
        const installArgs =
          host === "claude"
            ? [...args, "--approve"]
            : [...args, "--source", repositoryRoot, "--approve"];
        assert.equal((await value.run(["install", ...installArgs])).exitCode, 0);
        const path = await manifestPath(value, host, "project");
        const manifest = JSON.parse(await readFile(path, "utf8"));
        if (variant === "capabilities") manifest.capabilities = ["copy", "prd", "spec"];
        else manifest.schema = 5;
        await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
        const manifestBefore = await readFile(path);
        const nativeStateBefore = await readFile(mock.state);
        const callsBefore = await readFile(mock.calls);

        const result = await value.run(["update", ...args, "--approve"]);
        assert.equal(result.body.code, "INVALID_STATE", `${host}/${variant}`);
        assert.deepEqual(await readFile(path), manifestBefore);
        assert.deepEqual(await readFile(mock.state), nativeStateBefore);
        assert.deepEqual(await readFile(mock.calls), callsBefore);
      } finally {
        await rm(value.root, { recursive: true, force: true });
      }
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
              version: "0.4.0",
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
        { pluginId: "kona@kona", name: "kona", marketplaceName: "kona", version: "0.4.0" },
        { pluginId: "kona@kona", name: "kona", marketplaceName: "kona", version: "0.4.0" },
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
    await missing(join(value.project, ".opencode/skills/spec/SKILL.md"));
    await missing(join(value.project, ".opencode/agents/prd-writer.md"));
    await missing(join(value.project, ".opencode/agents/spec-writer.md"));
    await missing(await manifestPath(value, "opencode", "project"));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("OpenCode opposite-scope ambiguity detects an unowned skill or adapter", async () => {
  for (const relativePath of [
    "skills/prd/SKILL.md",
    "skills/spec/SKILL.md",
    "agents/prd-writer.md",
    "agents/spec-writer.md",
  ]) {
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
