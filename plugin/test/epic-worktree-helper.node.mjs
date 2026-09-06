import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const helper = join(repositoryRoot, "plugin/skills/epic-worktree/scripts/epic-worktree.mjs");
const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

function git(cwd, ...argv) {
  return execFileSync(realGit, argv, { cwd, encoding: "utf8" }).trim();
}

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "kona-epic-worktree-"));
  const remote = join(root, "origin.git");
  const seed = join(root, "seed");
  const primary = join(root, "repo");
  git(root, "init", "--bare", remote);
  git(root, "init", "-b", "main", seed);
  git(seed, "config", "user.name", "Kona Test");
  git(seed, "config", "user.email", "kona@example.test");
  await writeFile(join(seed, ".gitignore"), options.ignore ?? ".worktrees/\n");
  await writeFile(join(seed, "README.md"), "fixture\n");
  git(seed, "add", ".gitignore", "README.md");
  git(seed, "commit", "-m", "initial");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  git(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "clone", remote, primary);
  git(primary, "config", "user.name", "Kona Test");
  git(primary, "config", "user.email", "kona@example.test");
  return { root, remote, seed, primary };
}

function request(primary, overrides = {}) {
  return {
    schemaVersion: 1,
    epic: { id: "E-42", slugSeed: "Import settlement reports" },
    sourceRepoPath: primary,
    agentContextDigest: "a".repeat(64),
    mapping: null,
    knownMappings: [],
    confirmationToken: null,
    baselineExceptionToken: null,
    readiness: { setup: [], baseline: [] },
    ...overrides,
  };
}

function invoke(command, body, options = {}) {
  const child = spawnSync(process.execPath, [helper, command, "--json"], {
    cwd: options.cwd ?? body.sourceRepoPath ?? repositoryRoot,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    input: JSON.stringify(body),
  });
  assert.equal(child.signal, null, child.stderr);
  assert.doesNotThrow(() => JSON.parse(child.stdout), `${child.stdout}\n${child.stderr}`);
  return { status: child.status, result: JSON.parse(child.stdout), stderr: child.stderr };
}

async function startWorkspace(primary, overrides = {}, options = {}) {
  const body = request(primary, overrides);
  const proposal = invoke("propose", body, options);
  assert.equal(proposal.status, 0, JSON.stringify(proposal.result));
  const started = invoke(
    "start",
    { ...body, confirmationToken: proposal.result.confirmation.token },
    options,
  );
  assert.equal(started.status, 8, JSON.stringify(started.result));
  assert.equal(started.result.code, "HOST_TRANSITION_REQUIRED");
  return { body, proposal: proposal.result, started: started.result };
}

test("normalizes deterministic epic identity and parses porcelain defensively", async () => {
  const { deriveIdentity, parseWorktreePorcelain } = await import(helper);
  assert.deepEqual(deriveIdentity("ÉPIC/42", "Résumé + settlement"), {
    idComponent: "epic-42",
    slug: "resume-settlement",
    epicKey: "epic-42-resume-settlement-f7cfd45b8b",
    branch: "epic/epic-42-resume-settlement-f7cfd45b8b",
    relativePath: ".worktrees/epic-42-resume-settlement-f7cfd45b8b",
  });
  assert.equal(deriveIdentity("x".repeat(80), "y".repeat(80)).idComponent.length, 32);
  assert.equal(deriveIdentity("x", "---").slug, "epic");
  assert.throws(() => deriveIdentity("---", "valid"), /identifier/i);
  assert.deepEqual(
    parseWorktreePorcelain("worktree /repo\0HEAD abc\0branch refs/heads/main\0future value\0\0"),
    [
      {
        worktree: "/repo",
        HEAD: "abc",
        branch: "refs/heads/main",
        flags: [],
        unknown: [{ name: "future", value: "value" }],
      },
    ],
  );
  assert.throws(() => parseWorktreePorcelain("worktree /repo\0HEAD a\0HEAD b\0\0"), /duplicate/i);
});

test("issue workspace write verification rejects every observed identity mismatch", async () => {
  const { prepareIssuesWorkspaceWrite, snapshotIssuesContext, verifyIssuesWorkspaceWrite } =
    await import(helper);
  const epic = {
    id: "E-42",
    parent_id: "E-PARENT",
    status: "in_progress",
    claim: "actor-1",
    agent_context: { ownerNote: "preserve", kona: { epicSlugSeed: "Settlement" } },
  };
  const prepared = prepareIssuesWorkspaceWrite(epic, snapshotIssuesContext(epic), {
    schemaVersion: 1,
    state: "starting",
  });
  const observed = { ...epic, agent_context: prepared.agentContext };
  assert.deepEqual(
    verifyIssuesWorkspaceWrite(prepared, observed).identity,
    prepared.before.identity,
  );
  for (const changed of [
    { id: "E-OTHER" },
    { parent_id: "E-OTHER-PARENT" },
    { status: "closed" },
    { claim: "actor-2" },
  ]) {
    assert.throws(
      () => verifyIssuesWorkspaceWrite(prepared, { ...observed, ...changed }),
      (error) => error.code === "ISSUE_CONTEXT_WRITE_MISMATCH",
    );
  }
});

test("rejects invalid private interface requests with one JSON result", () => {
  const badCommand = invoke("unknown", request(repositoryRoot));
  assert.equal(badCommand.status, 2);
  assert.equal(badCommand.result.code, "INVALID_ARGUMENTS");
  const badSchema = invoke("check", { schemaVersion: 2 });
  assert.equal(badSchema.status, 2);
  assert.equal(badSchema.result.code, "INVALID_REQUEST");
  for (const command of ["propose", "start", "finish"]) {
    const missingDigest = request(repositoryRoot, { agentContextDigest: null });
    const invalid = invoke(command, missingDigest);
    assert.equal(invalid.status, 2);
    assert.equal(invalid.result.code, "INVALID_REQUEST");
    assert.match(invalid.result.message, /agentContextDigest/);
  }
});

test("rejects visible trust commands through direct, env, shell, and embedded argv forms only", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const forbidden = [
    ["direnv", "allow"],
    ["env", "MODE=test", "mise", "trust"],
    ["sh", "-c", "direnv allow"],
    ["bash", "-c", "mise trust"],
    ["runner", "--command=direnv allow"],
    ["mise", "--yes", "trust"],
    ["direnv", "--quiet", "allow"],
    ["sh", "-c", "mise \\\n+ --yes \\\n+ trust"],
  ];
  for (const argv of forbidden) {
    const result = invoke(
      "propose",
      request(repo.primary, { readiness: { setup: [{ argv, source: "test" }], baseline: [] } }),
    );
    assert.equal(result.status, 2, argv.join(" "));
    assert.match(result.result.message, /visible readiness argv/i);
  }

  const opaqueScript = invoke(
    "propose",
    request(repo.primary, {
      readiness: {
        setup: [{ argv: ["./repository-setup.sh"], source: "README.md" }],
        baseline: [],
      },
    }),
  );
  assert.equal(opaqueScript.status, 0, JSON.stringify(opaqueScript.result));
});

test("read-only Git inspection disables optional locks while pull and add retain lock capability", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const shimDir = join(repo.root, "optional-locks-bin");
  const log = join(repo.root, "optional-locks.log");
  await mkdir(shimDir);
  await writeFile(
    join(shimDir, "git"),
    `#!/bin/sh
locks="\${GIT_OPTIONAL_LOCKS-<unset>}"
printf '%s|%s\n' "$locks" "$*" >> "$KONA_GIT_LOG"
exec "$KONA_REAL_GIT" "$@"
`,
  );
  await chmod(join(shimDir, "git"), 0o755);
  const env = {
    PATH: `${shimDir}:${process.env.PATH}`,
    KONA_GIT_LOG: log,
    KONA_REAL_GIT: realGit,
  };
  const body = request(repo.primary, {
    readiness: { setup: [], baseline: [{ argv: ["true"], source: "test" }] },
  });
  const proposed = invoke("propose", body, { env });
  assert.equal(proposed.status, 0, JSON.stringify(proposed.result));
  const proposalLines = (await readFile(log, "utf8")).trim().split("\n");
  assert.ok(proposalLines.length > 0);
  assert.ok(proposalLines.every((line) => line.startsWith("0|")));

  await writeFile(log, "");
  const started = invoke(
    "start",
    { ...body, confirmationToken: proposed.result.confirmation.token },
    { env },
  );
  assert.equal(started.status, 8, JSON.stringify(started.result));
  const startLines = (await readFile(log, "utf8")).trim().split("\n");
  assert.ok(startLines.some((line) => line.startsWith("<unset>|") && line.includes(" pull ")));
  assert.ok(
    startLines.some((line) => line.startsWith("<unset>|") && line.includes(" worktree add ")),
  );
  assert.ok(
    startLines
      .filter((line) => !line.includes(" pull ") && !line.includes(" worktree add "))
      .every((line) => line.startsWith("0|")),
  );
});

test("propose is read-only and start token is deterministic, action-bound, and stale-safe", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const body = request(repo.primary, {
    readiness: { setup: [], baseline: [{ argv: ["true"], source: "test" }] },
  });
  const before = git(repo.primary, "status", "--porcelain=v1", "--untracked-files=all");
  const first = invoke("propose", body);
  const second = invoke("propose", body);
  assert.equal(first.status, 0);
  assert.equal(first.result.code, "PROPOSAL");
  assert.equal(first.result.confirmation.required, true);
  assert.equal(first.result.confirmation.token, second.result.confirmation.token);
  assert.equal(git(repo.primary, "status", "--porcelain=v1", "--untracked-files=all"), before);
  assert.equal(git(repo.primary, "branch", "--list", first.result.workspace.branch), "");

  const contextStale = invoke("start", {
    ...body,
    agentContextDigest: "b".repeat(64),
    confirmationToken: first.result.confirmation.token,
  });
  assert.equal(contextStale.status, 3);
  assert.equal(contextStale.result.code, "CONFIRMATION_STALE");
  assert.equal(git(repo.primary, "branch", "--list", first.result.workspace.branch), "");

  await writeFile(join(repo.primary, "untracked.txt"), "changed snapshot\n");
  const stale = invoke("start", { ...body, confirmationToken: first.result.confirmation.token });
  assert.equal(stale.status, 3);
  assert.equal(stale.result.code, "CONFIRMATION_STALE");
  assert.equal(git(repo.primary, "branch", "--list", first.result.workspace.branch), "");

  await rm(join(repo.primary, "untracked.txt"));
  const wrongAction = invoke("finish", {
    ...body,
    mapping: {
      schemaVersion: 1,
      state: "active",
      epicKey: first.result.epic.key,
      relativePath: first.result.workspace.relativePath,
      branch: first.result.workspace.branch,
      baseCommit: git(repo.primary, "rev-parse", "HEAD"),
      creationReadiness: {
        setup: "not-required",
        baseline: "pass",
        baselineResultDigest: "x",
        baselineException: null,
      },
    },
    confirmationToken: first.result.confirmation.token,
  });
  assert.notEqual(wrongAction.result.code, "REMOVED");
});

test("propose with an existing mapping inspects without running readiness commands", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const created = await startWorkspace(repo.primary, {
    readiness: { setup: [], baseline: [{ argv: ["true"], source: "creation" }] },
  });
  const marker = join(repo.root, "mapped-propose-command-ran");
  const proposed = invoke(
    "propose",
    {
      ...created.body,
      mapping: { ...created.started.mapping, state: "active" },
      readiness: {
        setup: [
          {
            argv: [
              process.execPath,
              "-e",
              `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
            ],
            source: "test",
          },
        ],
        baseline: [{ argv: ["false"], source: "test" }],
      },
    },
    { cwd: created.started.workspace.path },
  );
  assert.equal(proposed.status, 0, JSON.stringify(proposed.result));
  assert.equal(proposed.result.command, "propose");
  assert.equal(proposed.result.code, "MAPPED_WORKSPACE");
  assert.equal(proposed.result.setup.status, "not-run");
  assert.equal(proposed.result.baseline.status, "not-run");
  await assert.rejects(readFile(marker));
});

test("creation verifies tracked root ignore, exact pull semantics, lock path, and host transition", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const shimDir = join(repo.root, "bin");
  const log = join(repo.root, "git.log");
  await mkdir(shimDir);
  await writeFile(
    join(shimDir, "git"),
    `#!/bin/sh\nprintf '%s\\0' "$@" >> "$KONA_GIT_LOG"\nprintf '\\n' >> "$KONA_GIT_LOG"\nexec "$KONA_REAL_GIT" "$@"\n`,
  );
  await chmod(join(shimDir, "git"), 0o755);
  const env = {
    PATH: `${shimDir}:${process.env.PATH}`,
    KONA_GIT_LOG: log,
    KONA_REAL_GIT: realGit,
    GIT_ALLOW_PROTOCOL: "file",
  };
  const readiness = {
    setup: [{ argv: ["true"], source: "test setup" }],
    baseline: [{ argv: ["true"], source: "test baseline" }],
  };
  const { body, started } = await startWorkspace(repo.primary, { readiness }, { env });
  assert.equal(started.mutation, "created");
  assert.equal(started.workspace.baseCommit, git(repo.primary, "rev-parse", "refs/heads/main"));
  assert.equal(git(started.workspace.path, "rev-parse", "HEAD"), started.workspace.baseCommit);
  assert.equal((await lstat(join(await realpath(repo.primary), ".git/kona"))).mode & 0o777, 0o700);
  await assert.rejects(lstat(join(await realpath(repo.primary), ".git/kona/epic-worktree.lock")));
  const invocations = (await readFile(log, "utf8"))
    .split("\n")
    .map((line) => line.split("\0").filter(Boolean));
  const canonicalPrimary = started.repository.primaryWorktree;
  assert.ok(
    invocations.some(
      (argv) => argv.join(" ") === `-C ${canonicalPrimary} pull --ff-only origin main`,
    ),
  );
  assert.ok(
    invocations.some(
      (argv) =>
        argv.join(" ") ===
        `-C ${canonicalPrimary} worktree add -b ${started.workspace.branch} ${started.workspace.path} ${started.workspace.baseCommit}`,
    ),
  );

  const fromPrimary = invoke(
    "check",
    { ...body, mapping: started.mapping },
    { cwd: repo.primary, env },
  );
  assert.equal(fromPrimary.status, 8);
  assert.equal(fromPrimary.result.code, "HOST_TRANSITION_REQUIRED");
  const activeMapping = { ...started.mapping, state: "active" };
  const checked = invoke(
    "check",
    { ...body, mapping: activeMapping },
    { cwd: started.workspace.path, env },
  );
  assert.equal(checked.status, 0, JSON.stringify(checked.result));
  assert.equal(checked.result.code, "READY");
});

test("creation rejects non-tracked or non-root ignore provenance before pull", async (t) => {
  const repo = await fixture({ ignore: "node_modules/\n" });
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const infoExclude = join(repo.primary, ".git/info/exclude");
  await writeFile(infoExclude, ".worktrees/\n");
  const blocked = invoke("propose", request(repo.primary));
  assert.equal(blocked.status, 4);
  assert.equal(blocked.result.code, "IGNORE_RULE_REQUIRED");
  assert.match(JSON.stringify(blocked.result.checks), /tracked root \.gitignore/i);
});

test("known mapping collisions fail before lock or Git mutation", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const plain = request(repo.primary);
  const identity = invoke("propose", plain).result;
  const blocked = invoke("propose", {
    ...plain,
    knownMappings: [
      {
        epicId: "E-OTHER",
        epicKey: identity.epic.key.toUpperCase(),
        relativePath: ".worktrees/other",
        branch: "epic/other",
      },
    ],
  });
  assert.equal(blocked.status, 5);
  assert.equal(blocked.result.code, "MAPPING_COLLISION");
  await assert.rejects(lstat(join(repo.primary, ".git/kona")));
  assert.equal(git(repo.primary, "branch", "--list", identity.workspace.branch), "");
});

test("lock contention blocks start without mutation and reports owner metadata", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const body = request(repo.primary, {
    readiness: { setup: [], baseline: [{ argv: ["true"], source: "test" }] },
  });
  const proposal = invoke("propose", body).result;
  const absent = invoke("start", body);
  assert.equal(absent.status, 3);
  assert.equal(absent.result.code, "CONFIRMATION_REQUIRED");
  await assert.rejects(lstat(join(repo.primary, ".git/kona")));
  const lock = join(repo.primary, ".git/kona/epic-worktree.lock");
  await mkdir(lock, { recursive: true, mode: 0o700 });
  await writeFile(join(lock, "owner.json"), JSON.stringify({ operation: "other", pid: 123 }));
  const blocked = invoke("start", { ...body, confirmationToken: proposal.confirmation.token });
  assert.equal(blocked.status, 9);
  assert.equal(blocked.result.code, "LOCK_UNAVAILABLE");
  assert.equal(blocked.result.lockOwner.pid, 123);
  assert.equal(git(repo.primary, "branch", "--list", proposal.workspace.branch), "");
});

test("fresh pull bases creation on remote-ahead main without a remote-tracking ref", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  await writeFile(join(repo.seed, "remote.txt"), "new remote commit\n");
  git(repo.seed, "add", "remote.txt");
  git(repo.seed, "commit", "-m", "remote ahead");
  git(repo.seed, "push", "origin", "main");
  const remoteCommit = git(repo.seed, "rev-parse", "HEAD");
  git(repo.primary, "update-ref", "-d", "refs/remotes/origin/main");

  const created = await startWorkspace(repo.primary, {
    readiness: { setup: [], baseline: [{ argv: ["true"], source: "test" }] },
  });
  assert.equal(created.started.workspace.baseCommit, remoteCommit);
  assert.equal(git(repo.primary, "rev-parse", "HEAD"), remoteCommit);
  assert.equal(git(repo.primary, "merge-base", "--is-ancestor", "FETCH_HEAD", remoteCommit), "");
});

test("fresh pull preserves an intentional clean local-ahead main as the exact base", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  await writeFile(join(repo.primary, "local.txt"), "intentional local main commit\n");
  git(repo.primary, "add", "local.txt");
  git(repo.primary, "commit", "-m", "local ahead");
  const localCommit = git(repo.primary, "rev-parse", "HEAD");

  const created = await startWorkspace(repo.primary, {
    readiness: { setup: [], baseline: [{ argv: ["true"], source: "test" }] },
  });
  assert.equal(created.started.workspace.baseCommit, localCommit);
  assert.equal(git(created.started.workspace.path, "rev-parse", "HEAD"), localCommit);
  assert.equal(git(repo.primary, "merge-base", "--is-ancestor", "FETCH_HEAD", localCommit), "");
});

test("pull failure preserves pre-pull HEAD and creates no branch or destination", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const body = request(repo.primary, {
    readiness: { setup: [], baseline: [{ argv: ["true"], source: "test" }] },
  });
  const proposal = invoke("propose", body).result;
  const before = git(repo.primary, "rev-parse", "HEAD");
  git(repo.primary, "remote", "set-url", "origin", join(repo.root, "missing-origin.git"));
  const failed = invoke("start", { ...body, confirmationToken: proposal.confirmation.token });
  assert.equal(failed.status, 6);
  assert.equal(failed.result.code, "PULL_FAILED");
  assert.equal(git(repo.primary, "rev-parse", "HEAD"), before);
  assert.equal(git(repo.primary, "branch", "--list", proposal.workspace.branch), "");
  await assert.rejects(lstat(proposal.workspace.path));
});

test("primary dirtied during pull fails post-pull revalidation before worktree add", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const body = request(repo.primary, {
    readiness: { setup: [], baseline: [{ argv: ["true"], source: "test" }] },
  });
  const proposal = invoke("propose", body).result;
  const shimDir = join(repo.root, "dirty-during-pull-bin");
  await mkdir(shimDir);
  await writeFile(
    join(shimDir, "git"),
    `#!/bin/sh
if [ "$3" = pull ] && [ "$4" = --ff-only ]; then
  "$KONA_REAL_GIT" "$@"
  status=$?
  if [ "$status" -eq 0 ]; then printf 'concurrent change\n' > "$KONA_PRIMARY/concurrent.txt"; fi
  exit "$status"
fi
exec "$KONA_REAL_GIT" "$@"
`,
  );
  await chmod(join(shimDir, "git"), 0o755);
  const failed = invoke(
    "start",
    { ...body, confirmationToken: proposal.confirmation.token },
    {
      env: {
        PATH: `${shimDir}:${process.env.PATH}`,
        KONA_REAL_GIT: realGit,
        KONA_PRIMARY: repo.primary,
      },
    },
  );
  assert.equal(failed.status, 6);
  assert.equal(failed.result.code, "POST_PULL_REVALIDATION_FAILED");
  assert.equal(await readFile(join(repo.primary, "concurrent.txt"), "utf8"), "concurrent change\n");
  assert.equal(git(repo.primary, "branch", "--list", proposal.workspace.branch), "");
  await assert.rejects(lstat(proposal.workspace.path));
});

test("primary HEAD movement after pull fails revalidation before worktree add", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const body = request(repo.primary, {
    readiness: { setup: [], baseline: [{ argv: ["true"], source: "test" }] },
  });
  const proposal = invoke("propose", body).result;
  const shimDir = join(repo.root, "move-main-after-pull-bin");
  const marker = join(repo.root, "pull-complete");
  await mkdir(shimDir);
  await writeFile(
    join(shimDir, "git"),
    `#!/bin/sh
if [ "$3" = pull ] && [ "$4" = --ff-only ]; then
  "$KONA_REAL_GIT" "$@"
  status=$?
  if [ "$status" -eq 0 ]; then touch "$KONA_PULL_MARKER"; fi
  exit "$status"
fi
if [ -f "$KONA_PULL_MARKER" ] && [ "$1" = rev-parse ] && [ "$2" = --is-bare-repository ]; then
  rm "$KONA_PULL_MARKER"
  "$KONA_REAL_GIT" -C "$KONA_PRIMARY" commit --allow-empty -m concurrent-main-move >/dev/null
fi
exec "$KONA_REAL_GIT" "$@"
`,
  );
  await chmod(join(shimDir, "git"), 0o755);
  const failed = invoke(
    "start",
    { ...body, confirmationToken: proposal.confirmation.token },
    {
      env: {
        PATH: `${shimDir}:${process.env.PATH}`,
        KONA_REAL_GIT: realGit,
        KONA_PRIMARY: repo.primary,
        KONA_PULL_MARKER: marker,
      },
    },
  );
  assert.equal(failed.status, 6);
  assert.equal(failed.result.code, "POST_PULL_REVALIDATION_FAILED");
  assert.equal(git(repo.primary, "branch", "--list", proposal.workspace.branch), "");
  await assert.rejects(lstat(proposal.workspace.path));
});

test("partial worktree add artifacts are reported and never compensated", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const body = request(repo.primary, {
    readiness: { setup: [], baseline: [{ argv: ["true"], source: "test" }] },
  });
  const proposal = invoke("propose", body).result;
  const shimDir = join(repo.root, "partial-bin");
  await mkdir(shimDir);
  await writeFile(
    join(shimDir, "git"),
    `#!/bin/sh\nif [ "$3" = worktree ] && [ "$4" = add ]; then\n  "$KONA_REAL_GIT" -C "$2" branch "$6" "$8"\n  exit 55\nfi\nexec "$KONA_REAL_GIT" "$@"\n`,
  );
  await chmod(join(shimDir, "git"), 0o755);
  const failed = invoke(
    "start",
    { ...body, confirmationToken: proposal.confirmation.token },
    { env: { PATH: `${shimDir}:${process.env.PATH}`, KONA_REAL_GIT: realGit } },
  );
  assert.equal(failed.status, 6);
  assert.equal(failed.result.code, "PARTIAL_CREATION");
  assert.equal(failed.result.partial.branchExists, true);
  assert.equal(failed.result.mapping.state, "starting");
  assert.equal(failed.result.mapping.baseCommit, git(repo.primary, "rev-parse", "refs/heads/main"));
  assert.equal(failed.result.mapping.creationReadiness.setup, "not-run");
  assert.equal(failed.result.mapping.creationReadiness.baseline, "not-run");
  assert.match(git(repo.primary, "branch", "--list", proposal.workspace.branch), /epic\//);
});

test("post-add verification failure returns a complete recovery mapping", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const body = request(repo.primary, {
    readiness: { setup: [], baseline: [{ argv: ["true"], source: "test" }] },
  });
  const proposal = invoke("propose", body).result;
  const shimDir = join(repo.root, "post-add-verification-bin");
  await mkdir(shimDir);
  await writeFile(
    join(shimDir, "git"),
    `#!/bin/sh
if [ "$3" = worktree ] && [ "$4" = add ]; then
  "$KONA_REAL_GIT" "$@"
  status=$?
  if [ "$status" -eq 0 ]; then "$KONA_REAL_GIT" -C "$7" checkout --detach >/dev/null 2>&1; fi
  exit "$status"
fi
exec "$KONA_REAL_GIT" "$@"
`,
  );
  await chmod(join(shimDir, "git"), 0o755);
  const failed = invoke(
    "start",
    { ...body, confirmationToken: proposal.confirmation.token },
    { env: { PATH: `${shimDir}:${process.env.PATH}`, KONA_REAL_GIT: realGit } },
  );
  assert.equal(failed.status, 6);
  assert.equal(failed.result.code, "PARTIAL_CREATION");
  assert.equal(failed.result.mapping.state, "starting");
  assert.equal(failed.result.mapping.baseCommit, git(repo.primary, "rev-parse", "refs/heads/main"));
  assert.equal(failed.result.mapping.creationReadiness.setup, "not-run");
  assert.equal(failed.result.mapping.creationReadiness.baseline, "not-run");
  assert.equal((await lstat(proposal.workspace.path)).isDirectory(), true);
  assert.match(git(repo.primary, "branch", "--list", proposal.workspace.branch), /epic\//);
});

test("primary movement after worktree add returns partial creation and preserves recovery artifacts", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const body = request(repo.primary, {
    readiness: { setup: [], baseline: [{ argv: ["true"], source: "test" }] },
  });
  const proposal = invoke("propose", body).result;
  const shimDir = join(repo.root, "post-add-main-move-bin");
  await mkdir(shimDir);
  await writeFile(
    join(shimDir, "git"),
    `#!/bin/sh
if [ "$3" = worktree ] && [ "$4" = add ]; then
  "$KONA_REAL_GIT" "$@"
  status=$?
  if [ "$status" -eq 0 ]; then
    "$KONA_REAL_GIT" -C "$KONA_PRIMARY" commit --allow-empty -m post-add-main-move >/dev/null
  fi
  exit "$status"
fi
exec "$KONA_REAL_GIT" "$@"
`,
  );
  await chmod(join(shimDir, "git"), 0o755);
  const failed = invoke(
    "start",
    { ...body, confirmationToken: proposal.confirmation.token },
    {
      env: {
        PATH: `${shimDir}:${process.env.PATH}`,
        KONA_REAL_GIT: realGit,
        KONA_PRIMARY: repo.primary,
      },
    },
  );
  assert.equal(failed.status, 6);
  assert.equal(failed.result.code, "PARTIAL_CREATION");
  assert.equal(failed.result.mapping.state, "starting");
  assert.equal(failed.result.mapping.baseCommit, failed.result.workspace.baseCommit);
  assert.equal(failed.result.mapping.creationReadiness.setup, "not-run");
  assert.equal(failed.result.mapping.creationReadiness.baseline, "not-run");
  assert.equal((await lstat(proposal.workspace.path)).isDirectory(), true);
  assert.match(git(repo.primary, "branch", "--list", proposal.workspace.branch), /epic\//);
});

test("dirty active resume skips commands and preserves bytes while dirty starting blocks", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const marker = join(repo.root, "command-ran");
  const readiness = {
    setup: [{ argv: [process.execPath, "-e", "process.exit(0)"], source: "test" }],
    baseline: [
      {
        argv: [
          process.execPath,
          "-e",
          `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
        ],
        source: "test",
      },
    ],
  };
  const created = await startWorkspace(repo.primary, { readiness });
  await rm(marker, { force: true });
  const source = join(created.started.workspace.path, "README.md");
  await writeFile(source, "in progress\n");
  const bytes = await readFile(source, "utf8");
  const active = invoke(
    "check",
    { ...created.body, mapping: { ...created.started.mapping, state: "active" } },
    { cwd: created.started.workspace.path },
  );
  assert.equal(active.status, 0);
  assert.equal(active.result.code, "READY_EXISTING_WORK");
  assert.equal(active.result.setup.status, "not-run-existing-changes");
  await assert.rejects(readFile(marker));
  assert.equal(await readFile(source, "utf8"), bytes);

  const starting = invoke(
    "check",
    { ...created.body, mapping: created.started.mapping },
    { cwd: created.started.workspace.path },
  );
  assert.equal(starting.status, 4);
  assert.equal(starting.result.code, "DIRTY_STARTING_WORKTREE");
  assert.equal(await readFile(source, "utf8"), bytes);
});

test("dirty resume rejects forged truthy baseline exception evidence", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const created = await startWorkspace(repo.primary, {
    readiness: { setup: [], baseline: [{ argv: ["true"], source: "creation" }] },
  });
  await writeFile(join(created.started.workspace.path, "README.md"), "dirty work\n");
  for (const baselineException of [true, "accepted", { tokenDigest: "a".repeat(64) }]) {
    const mapping = {
      ...created.started.mapping,
      state: "active",
      creationReadiness: {
        ...created.started.mapping.creationReadiness,
        baseline: "fail",
        baselineException,
      },
    };
    const result = invoke(
      "check",
      { ...created.body, mapping },
      { cwd: created.started.workspace.path },
    );
    assert.equal(result.status, 4);
    assert.equal(result.result.code, "MAPPING_CONFLICT");
  }
});

test("mapping baseCommit must be an immutable object id valid for the repository format", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const created = await startWorkspace(repo.primary, {
    readiness: { setup: [], baseline: [{ argv: ["true"], source: "test" }] },
  });
  const symbolic = invoke(
    "check",
    { ...created.body, mapping: { ...created.started.mapping, baseCommit: "refs/heads/main" } },
    { cwd: created.started.workspace.path },
  );
  assert.equal(symbolic.status, 4);
  assert.equal(symbolic.result.code, "MAPPING_CONFLICT");

  const wrongFormat = invoke(
    "check",
    { ...created.body, mapping: { ...created.started.mapping, baseCommit: "0".repeat(64) } },
    { cwd: created.started.workspace.path },
  );
  assert.equal(wrongFormat.status, 4);
  assert.equal(wrongFormat.result.code, "BASE_COMMIT_MISMATCH");
});

test("check reports local ahead and behind relationships without fetching", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const created = await startWorkspace(repo.primary, {
    readiness: { setup: [], baseline: [{ argv: ["true"], source: "test" }] },
  });
  await writeFile(join(created.started.workspace.path, "workspace.txt"), "workspace commit\n");
  git(created.started.workspace.path, "add", "workspace.txt");
  git(created.started.workspace.path, "commit", "-m", "workspace ahead");
  await writeFile(join(repo.primary, "primary.txt"), "primary commit\n");
  git(repo.primary, "add", "primary.txt");
  git(repo.primary, "commit", "-m", "main ahead");

  const checked = invoke(
    "check",
    { ...created.body, mapping: { ...created.started.mapping, state: "active" } },
    { cwd: created.started.workspace.path },
  );
  assert.equal(checked.status, 0, JSON.stringify(checked.result));
  assert.deepEqual(checked.result.workspace.aheadBehind.main, { ahead: 1, behind: 1 });
  assert.deepEqual(checked.result.workspace.aheadBehind.originMain, { ahead: 1, behind: 0 });
});

test("setup and baseline failures remain distinct and baseline exceptions bind exact state", async (t) => {
  const { transitionIssuesWorkspace } = await import(helper);
  const repo = await fixture();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const failingSetup = request(repo.primary, {
    readiness: {
      setup: [
        {
          argv: [
            process.execPath,
            "-e",
            "require('fs').writeFileSync('setup-created.txt', 'preserve me'); process.exit(9)",
          ],
          source: "test",
        },
      ],
      baseline: [{ argv: ["true"], source: "test" }],
    },
  });
  const setupProposal = invoke("propose", failingSetup).result;
  const setup = invoke("start", {
    ...failingSetup,
    confirmationToken: setupProposal.confirmation.token,
  });
  assert.equal(setup.status, 7);
  assert.equal(setup.result.code, "SETUP_FAILED");
  assert.equal(setup.result.setup.status, "fail");
  assert.equal(setup.result.baseline.status, "not-run");
  assert.equal(setup.result.workspace.status, "dirty");
  assert.equal(
    setup.result.workspace.currentCommit,
    git(setup.result.workspace.path, "rev-parse", "HEAD"),
  );
  assert.equal(
    await readFile(join(setup.result.workspace.path, "setup-created.txt"), "utf8"),
    "preserve me",
  );
  assert.equal(
    git(repo.primary, "branch", "--list", setup.result.workspace.branch).includes("epic/"),
    true,
  );

  const repo2 = await fixture();
  t.after(() => rm(repo2.root, { recursive: true, force: true }));
  const created = await startWorkspace(repo2.primary, {
    readiness: { setup: [], baseline: [{ argv: ["true"], source: "creation" }] },
  });
  const checkBody = {
    ...created.body,
    mapping: {
      ...created.started.mapping,
      state: "starting",
      creationReadiness: {
        ...created.started.mapping.creationReadiness,
        baseline: "fail",
      },
    },
    readiness: { setup: [], baseline: [{ argv: ["false"], source: "known flaky baseline" }] },
  };
  const failed = invoke("check", checkBody, { cwd: created.started.workspace.path });
  assert.equal(failed.status, 7);
  assert.equal(failed.result.code, "BASELINE_FAILED");
  assert.equal(failed.result.confirmation.action, "baseline-exception");
  const accepted = invoke(
    "check",
    { ...checkBody, baselineExceptionToken: failed.result.confirmation.token },
    { cwd: created.started.workspace.path },
  );
  assert.equal(accepted.status, 0, JSON.stringify(accepted.result));
  assert.equal(accepted.result.code, "READY");
  const evidence = accepted.result.baseline.exception;
  assert.deepEqual(Object.keys(evidence).toSorted(), [
    "accepted",
    "baselineStatus",
    "currentCommit",
    "resultDigest",
    "schemaVersion",
    "statusDigest",
    "tokenDigest",
  ]);
  assert.equal(evidence.accepted, true);
  assert.match(evidence.tokenDigest, /^[a-f0-9]{64}$/);
  assert.match(evidence.resultDigest, /^[a-f0-9]{64}$/);
  assert.equal(evidence.currentCommit, accepted.result.workspace.currentCommit);
  assert.equal(evidence.statusDigest, accepted.result.statusDigest);
  const activeMapping = transitionIssuesWorkspace(checkBody.mapping, accepted.result);
  assert.equal(activeMapping.state, "active");
  assert.deepEqual(activeMapping.creationReadiness.baselineException, evidence);
  assert.equal(activeMapping.creationReadiness.baselineResultDigest, evidence.resultDigest);
  assert.equal(activeMapping.creationReadiness.baseline, evidence.baselineStatus);
  await writeFile(join(created.started.workspace.path, "README.md"), "state changed\n");
  const resumed = invoke(
    "check",
    { ...created.body, mapping: activeMapping },
    { cwd: created.started.workspace.path },
  );
  assert.equal(resumed.status, 0, JSON.stringify(resumed.result));
  assert.equal(resumed.result.code, "READY_EXISTING_WORK");
});

test("failed readiness command that moves HEAD retains command evidence and recovery mapping", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const created = await startWorkspace(repo.primary, {
    readiness: { setup: [], baseline: [{ argv: ["true"], source: "creation" }] },
  });
  await writeFile(join(created.started.workspace.path, "advance.txt"), "advance branch\n");
  git(created.started.workspace.path, "add", "advance.txt");
  git(created.started.workspace.path, "commit", "-m", "advance workspace");
  const body = {
    ...created.body,
    mapping: { ...created.started.mapping, state: "active" },
    readiness: {
      setup: [],
      baseline: [
        {
          argv: [
            process.execPath,
            "-e",
            "require('child_process').execFileSync('git', ['checkout', '--detach', 'HEAD~1']); process.exit(7)",
          ],
          source: "test",
        },
      ],
    },
  };
  const failed = invoke("check", body, { cwd: created.started.workspace.path });
  assert.equal(failed.status, 7, JSON.stringify(failed.result));
  assert.equal(failed.result.code, "BASELINE_FAILED");
  assert.equal(failed.result.baseline.commands[0].exitCode, 7);
  assert.equal(failed.result.mapping.state, "active");
  assert.equal(
    failed.result.workspace.currentCommit,
    git(created.started.workspace.path, "rev-parse", "HEAD"),
  );
  assert.equal(failed.result.workspace.status, "clean");
});

test("finish preflight is separately confirmed, refuses dirty state, removes without force, and retains branch", async (t) => {
  const repo = await fixture({ ignore: ".worktrees/\n.env\n" });
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const created = await startWorkspace(repo.primary, {
    readiness: { setup: [], baseline: [{ argv: ["true"], source: "test" }] },
  });
  const mapping = { ...created.started.mapping, state: "active" };
  const finishBody = { ...created.body, mapping };
  await writeFile(join(created.started.workspace.path, ".env"), "SECRET=preserve\n");
  assert.equal(
    git(created.started.workspace.path, "status", "--porcelain=v1", "--untracked-files=all"),
    "",
  );
  const ignoredUnsafe = invoke("finish", finishBody, { cwd: repo.primary });
  assert.equal(ignoredUnsafe.status, 4);
  assert.equal(ignoredUnsafe.result.code, "CLEANUP_UNSAFE", JSON.stringify(ignoredUnsafe.result));
  assert.match(JSON.stringify(ignoredUnsafe.result.preflight), /\.env/);
  assert.equal(
    await readFile(join(created.started.workspace.path, ".env"), "utf8"),
    "SECRET=preserve\n",
  );
  await rm(join(created.started.workspace.path, ".env"));

  await writeFile(join(created.started.workspace.path, "dirty.txt"), "keep me\n");
  const unsafe = invoke("finish", finishBody, { cwd: repo.primary });
  assert.equal(unsafe.status, 4);
  assert.equal(unsafe.result.code, "CLEANUP_UNSAFE", JSON.stringify(unsafe.result));
  assert.equal(
    await readFile(join(created.started.workspace.path, "dirty.txt"), "utf8"),
    "keep me\n",
  );
  await rm(join(created.started.workspace.path, "dirty.txt"));

  const preflight = invoke("finish", finishBody, { cwd: repo.primary });
  assert.equal(preflight.status, 0, JSON.stringify(preflight.result));
  assert.equal(preflight.result.code, "PREFLIGHT_SAFE", JSON.stringify(preflight.result));
  assert.equal(preflight.result.confirmation.action, "finish");
  assert.notEqual(preflight.result.confirmation.token, created.proposal.confirmation.token);
  const unbound = invoke(
    "finish",
    {
      ...finishBody,
      agentContextDigest: null,
      confirmationToken: preflight.result.confirmation.token,
    },
    { cwd: repo.primary },
  );
  assert.equal(unbound.status, 2);
  assert.equal(unbound.result.code, "INVALID_REQUEST");
  assert.equal((await lstat(created.started.workspace.path)).isDirectory(), true);

  const shimDir = join(repo.root, "finish-bin");
  const log = join(repo.root, "finish-git.log");
  await mkdir(shimDir);
  await writeFile(
    join(shimDir, "git"),
    `#!/bin/sh\nprintf '%s\\0' "$@" >> "$KONA_GIT_LOG"\nprintf '\\n' >> "$KONA_GIT_LOG"\nexec "$KONA_REAL_GIT" "$@"\n`,
  );
  await chmod(join(shimDir, "git"), 0o755);
  const removed = invoke(
    "finish",
    { ...finishBody, confirmationToken: preflight.result.confirmation.token },
    {
      cwd: repo.primary,
      env: { PATH: `${shimDir}:${process.env.PATH}`, KONA_GIT_LOG: log, KONA_REAL_GIT: realGit },
    },
  );
  assert.equal(removed.status, 0, JSON.stringify(removed.result));
  assert.equal(removed.result.code, "REMOVED");
  const lines = (await readFile(log, "utf8"))
    .split("\n")
    .map((line) => line.split("\0").filter(Boolean));
  assert.ok(
    lines.some(
      (argv) =>
        argv.join(" ") ===
        `-C ${removed.result.repository.primaryWorktree} worktree remove ${created.started.workspace.path}`,
    ),
  );
  assert.ok(!lines.some((argv) => argv.includes("--force") || argv.includes("-f")));
  assert.equal(
    git(repo.primary, "show-ref", "--verify", `refs/heads/${mapping.branch}`),
    `${git(repo.primary, "rev-parse", `refs/heads/${mapping.branch}`)} refs/heads/${mapping.branch}`,
  );
  await assert.rejects(lstat(created.started.workspace.path));
});

test("failed non-forced removal preserves the worktree and branch", async (t) => {
  const repo = await fixture();
  t.after(() => rm(repo.root, { recursive: true, force: true }));
  const created = await startWorkspace(repo.primary, {
    readiness: { setup: [], baseline: [{ argv: ["true"], source: "test" }] },
  });
  const body = { ...created.body, mapping: { ...created.started.mapping, state: "active" } };
  const preflight = invoke("finish", body, { cwd: repo.primary });
  assert.equal(preflight.result.code, "PREFLIGHT_SAFE");
  const shimDir = join(repo.root, "remove-failure-bin");
  await mkdir(shimDir);
  await writeFile(
    join(shimDir, "git"),
    `#!/bin/sh\nif [ "$3" = worktree ] && [ "$4" = remove ]; then exit 56; fi\nexec "$KONA_REAL_GIT" "$@"\n`,
  );
  await chmod(join(shimDir, "git"), 0o755);
  const failed = invoke(
    "finish",
    { ...body, confirmationToken: preflight.result.confirmation.token },
    { cwd: repo.primary, env: { PATH: `${shimDir}:${process.env.PATH}`, KONA_REAL_GIT: realGit } },
  );
  assert.equal(failed.status, 6);
  assert.equal(failed.result.code, "REMOVE_FAILED");
  assert.equal((await lstat(created.started.workspace.path)).isDirectory(), true);
  assert.match(git(repo.primary, "branch", "--list", body.mapping.branch), /epic\//);
});

test("canonical discovery rejects bare and submodule source repositories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kona-epic-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bare = join(root, "bare.git");
  git(root, "init", "--bare", bare);
  const bareResult = invoke("propose", request(bare));
  assert.equal(bareResult.status, 4);
  assert.equal(bareResult.result.code, "BARE_REPOSITORY");

  const parent = await fixture();
  t.after(() => rm(parent.root, { recursive: true, force: true }));
  const child = await fixture();
  t.after(() => rm(child.root, { recursive: true, force: true }));
  git(
    parent.primary,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    child.remote,
    "vendor/child",
  );
  git(parent.primary, "commit", "-m", "add submodule");
  const submodule = join(parent.primary, "vendor/child");
  const submoduleResult = invoke("propose", request(submodule), { cwd: submodule });
  assert.equal(submoduleResult.status, 4);
  assert.equal(submoduleResult.result.code, "SUBMODULE_REPOSITORY");
});
