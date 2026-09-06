#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const MAX_INPUT = 1024 * 1024;
const MAX_COMMAND_OUTPUT = 1024 * 1024;
const COMMANDS = new Set(["propose", "start", "check", "finish"]);
const STATES = new Set(["starting", "active", "cleanup-pending", "finished"]);

class HelperError extends Error {
  constructor(code, exitCode, message, details = {}) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

const canonicalJson = (value) => JSON.stringify(canonicalize(value));
const digestJson = (value) => sha256(canonicalJson(value));

const BASELINE_EXCEPTION_KEYS = [
  "accepted",
  "baselineStatus",
  "currentCommit",
  "resultDigest",
  "schemaVersion",
  "statusDigest",
  "tokenDigest",
];

function stableBaselineResult(baseline) {
  return {
    status: baseline.status,
    commands: baseline.commands.map(({ durationMs: _durationMs, ...record }) => record),
  };
}

function requireBaselineException(value, code = "MAPPING_CONFLICT") {
  const keys =
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value).toSorted()
      : [];
  if (
    canonicalJson(keys) !== canonicalJson(BASELINE_EXCEPTION_KEYS) ||
    value.schemaVersion !== 1 ||
    value.accepted !== true ||
    !["fail", "not-configured"].includes(value.baselineStatus) ||
    !/^[a-f0-9]{64}$/.test(value.tokenDigest ?? "") ||
    !/^[a-f0-9]{64}$/.test(value.resultDigest ?? "") ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.currentCommit ?? "") ||
    !/^[a-f0-9]{64}$/.test(value.statusDigest ?? "")
  ) {
    throw new HelperError(code, 4, "Stored baselineException evidence is invalid");
  }
  return value;
}

function baselineExceptionEvidence(token, baseline, currentCommit, statusDigest) {
  return {
    schemaVersion: 1,
    accepted: true,
    baselineStatus: baseline.status,
    tokenDigest: sha256(token),
    resultDigest: digestJson(stableBaselineResult(baseline)),
    currentCommit,
    statusDigest,
  };
}

function persistBaselineException(mapping, evidence) {
  const next = structuredClone(mapping);
  next.creationReadiness.baseline = evidence.baselineStatus;
  next.creationReadiness.baselineResultDigest = evidence.resultDigest;
  next.creationReadiness.baselineException = structuredClone(evidence);
  return next;
}

function requireJsonObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HelperError("INVALID_ISSUE_CONTEXT", 4, `${name} must be a JSON object`);
  }
  return value;
}

export function snapshotIssuesContext(epic) {
  requireJsonObject(epic, "epic");
  if (typeof epic.id !== "string" || !epic.id) {
    throw new HelperError("INVALID_ISSUE_CONTEXT", 4, "epic.id must be a non-empty string");
  }
  const agentContext = requireJsonObject(epic.agent_context, "agent_context");
  const kona = agentContext.kona;
  if (kona !== undefined) {
    requireJsonObject(kona, "agent_context.kona");
    if (kona.workspace !== undefined) {
      requireJsonObject(kona.workspace, "agent_context.kona.workspace");
    }
  }
  const identity = {
    id: epic.id,
    parentId: epic.parent_id ?? epic.parentId ?? null,
    status: epic.status ?? null,
    claim: epic.claim ?? epic.assignee ?? null,
  };
  return {
    identity,
    agentContext: structuredClone(agentContext),
    digest: digestJson({ identity, agentContext }),
  };
}

export function prepareIssuesWorkspaceWrite(currentEpic, expectedSnapshot, workspace) {
  requireJsonObject(expectedSnapshot, "expected context snapshot");
  requireJsonObject(workspace, "workspace");
  const current = snapshotIssuesContext(currentEpic);
  if (current.digest !== expectedSnapshot.digest) {
    throw new HelperError(
      "ISSUE_CONTEXT_CONFLICT",
      4,
      "Epic identity or agent_context changed before the workspace write",
      { expectedDigest: expectedSnapshot.digest, actualDigest: current.digest },
    );
  }
  const agentContext = structuredClone(current.agentContext);
  agentContext.kona = { ...agentContext.kona, workspace: structuredClone(workspace) };
  return { before: current, agentContext };
}

export function verifyIssuesWorkspaceWrite(prepared, observedEpic) {
  requireJsonObject(prepared, "prepared context write");
  const expectedIdentity = requireJsonObject(prepared.before?.identity, "prepared before identity");
  const observed = snapshotIssuesContext(observedEpic);
  const identityMatches = canonicalJson(observed.identity) === canonicalJson(expectedIdentity);
  const contextMatches =
    canonicalJson(observed.agentContext) === canonicalJson(prepared.agentContext);
  if (!identityMatches || !contextMatches) {
    throw new HelperError(
      "ISSUE_CONTEXT_WRITE_MISMATCH",
      4,
      "Post-write epic identity or agent_context does not match the prepared write",
      {
        beforeDigest: prepared.before?.digest ?? null,
        expectedDigest: digestJson(prepared.agentContext),
        actualDigest: digestJson(observed.agentContext),
        expectedIdentity,
        actualIdentity: observed.identity,
      },
    );
  }
  return observed;
}

export function transitionIssuesWorkspace(mapping, outcome) {
  requireJsonObject(outcome, "workspace outcome");
  const code = outcome.code;
  if (typeof code !== "string") {
    throw new HelperError("INVALID_WORKSPACE_TRANSITION", 4, "Workspace outcome code is required");
  }
  if (mapping === null && outcome.mapping?.state === "starting") {
    return structuredClone(outcome.mapping);
  }
  requireJsonObject(mapping, "workspace mapping");
  const next = structuredClone(mapping);
  const checkEvidence = {
    code,
    currentCommit: outcome.workspace?.currentCommit ?? null,
    statusDigest: outcome.statusDigest ?? null,
  };
  if (code === "READY") {
    if (next.state !== "starting" && next.state !== "active") {
      throw new HelperError("INVALID_WORKSPACE_TRANSITION", 4, "READY requires starting or active");
    }
    const exception = outcome.baseline?.exception ?? null;
    if (exception !== null) {
      requireBaselineException(exception, "INVALID_WORKSPACE_TRANSITION");
      if (
        exception.currentCommit !== outcome.workspace?.currentCommit ||
        exception.statusDigest !== outcome.statusDigest ||
        exception.resultDigest !== digestJson(stableBaselineResult(outcome.baseline))
      ) {
        throw new HelperError(
          "INVALID_WORKSPACE_TRANSITION",
          4,
          "Baseline exception evidence does not match the accepted READY result",
        );
      }
      const persisted = persistBaselineException(next, exception);
      next.creationReadiness = persisted.creationReadiness;
    }
    next.state = "active";
    next.lastCheck = checkEvidence;
    return next;
  }
  if (code === "READY_EXISTING_WORK") {
    if (next.state !== "active") {
      throw new HelperError(
        "INVALID_WORKSPACE_TRANSITION",
        4,
        "READY_EXISTING_WORK cannot activate a starting workspace",
      );
    }
    next.lastCheck = checkEvidence;
    return next;
  }
  if (
    [
      "DECLINED",
      "CLEANUP_UNSAFE",
      "REMOVE_FAILED",
      "PARTIAL_REMOVAL",
      "CONFIRMATION_STALE",
    ].includes(code)
  ) {
    if (next.state === "finished") {
      throw new HelperError("INVALID_WORKSPACE_TRANSITION", 4, "Finished workspace cannot regress");
    }
    next.state = "cleanup-pending";
    return next;
  }
  if (code === "REMOVED") {
    if (next.state !== "active" && next.state !== "cleanup-pending") {
      throw new HelperError(
        "INVALID_WORKSPACE_TRANSITION",
        4,
        "REMOVED requires active or cleanup-pending",
      );
    }
    next.state = "finished";
    return next;
  }
  if (code === "PREFLIGHT_SAFE") return next;
  throw new HelperError(
    "INVALID_WORKSPACE_TRANSITION",
    4,
    `Unsupported workspace outcome: ${code}`,
  );
}

function normalizedComponent(value, limit) {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return Buffer.from(normalized, "ascii").subarray(0, limit).toString("ascii").replace(/-+$/g, "");
}

export function deriveIdentity(id, slugSeed) {
  if (typeof id !== "string" || typeof slugSeed !== "string" || /[\0\r\n]/.test(id + slugSeed)) {
    throw new HelperError(
      "INVALID_REQUEST",
      2,
      "Epic id and slugSeed must be newline-free strings",
    );
  }
  const idComponent = normalizedComponent(id, 32);
  if (!idComponent)
    throw new HelperError("INVALID_REQUEST", 2, "Normalized epic identifier is empty");
  const slug = normalizedComponent(slugSeed, 48) || "epic";
  const epicKey = `${idComponent}-${slug}-${sha256(Buffer.from(id, "utf8")).slice(0, 10)}`;
  return {
    idComponent,
    slug,
    epicKey,
    branch: `epic/${epicKey}`,
    relativePath: `.worktrees/${epicKey}`,
  };
}

export function parseWorktreePorcelain(text) {
  if (typeof text !== "string" || (!text.endsWith("\0\0") && text !== "")) {
    throw new HelperError("MALFORMED_GIT_OUTPUT", 4, "Malformed worktree porcelain terminator");
  }
  const records = [];
  let record = null;
  for (const field of text.split("\0")) {
    if (field === "") {
      if (record) {
        if (!record.worktree)
          throw new HelperError("MALFORMED_GIT_OUTPUT", 4, "Worktree record has no path");
        records.push(record);
        record = null;
      }
      continue;
    }
    if (!record) record = { flags: [], unknown: [] };
    const space = field.indexOf(" ");
    const name = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? null : field.slice(space + 1);
    if (["worktree", "HEAD", "branch"].includes(name)) {
      if (record[name] !== undefined) {
        throw new HelperError("MALFORMED_GIT_OUTPUT", 4, `Duplicate worktree field: ${name}`);
      }
      if (value === null || value === "") {
        throw new HelperError("MALFORMED_GIT_OUTPUT", 4, `Empty worktree field: ${name}`);
      }
      record[name] = value;
    } else if (["bare", "detached", "locked", "prunable"].includes(name)) {
      if (record.flags.some((entry) => entry.name === name)) {
        throw new HelperError("MALFORMED_GIT_OUTPUT", 4, `Duplicate worktree field: ${name}`);
      }
      record.flags.push({ name, value });
    } else {
      if (record.unknown.some((entry) => entry.name === name)) {
        throw new HelperError("MALFORMED_GIT_OUTPUT", 4, `Duplicate worktree field: ${name}`);
      }
      record.unknown.push({ name, value });
    }
  }
  return records;
}

function git(cwd, argv, options = {}) {
  const env = { ...process.env };
  if (options.mutate) delete env.GIT_OPTIONAL_LOCKS;
  else env.GIT_OPTIONAL_LOCKS = "0";
  const child = spawnSync("git", argv, {
    cwd,
    env,
    encoding: "utf8",
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  const status = child.status ?? 127;
  const result = { status, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
  if (!options.allowFailure && status !== 0) {
    throw new HelperError(
      options.code ?? "GIT_INSPECTION_FAILED",
      options.exitCode ?? 4,
      options.message ?? `Git command failed: git ${argv.join(" ")}`,
      { git: { argv: ["git", ...argv], exitCode: status, stderrDigest: sha256(result.stderr) } },
    );
  }
  return result;
}

const gitText = (cwd, argv, options) => git(cwd, argv, options).stdout.replace(/[\r\n]+$/g, "");

async function canonicalExisting(path) {
  try {
    return await realpath(path);
  } catch {
    throw new HelperError("REPOSITORY_NOT_FOUND", 4, `Path does not exist: ${path}`);
  }
}

async function discoverRepository(sourceRepoPath) {
  const source = await canonicalExisting(sourceRepoPath);
  const bareProbe = git(source, ["rev-parse", "--is-bare-repository"], { allowFailure: true });
  if (bareProbe.status !== 0)
    throw new HelperError("NOT_A_REPOSITORY", 4, "Source path is not a Git repository");
  if (bareProbe.stdout.trim() === "true") {
    throw new HelperError("BARE_REPOSITORY", 4, "Bare repositories cannot own epic worktrees");
  }
  const root = await canonicalExisting(gitText(source, ["rev-parse", "--show-toplevel"]));
  const gitDir = await canonicalExisting(gitText(source, ["rev-parse", "--absolute-git-dir"]));
  const commonRaw = gitText(source, ["rev-parse", "--git-common-dir"]);
  const commonDir = await canonicalExisting(
    isAbsolute(commonRaw) ? commonRaw : resolve(root, commonRaw),
  );
  const superproject = gitText(source, ["rev-parse", "--show-superproject-working-tree"]);
  if (superproject) {
    throw new HelperError(
      "SUBMODULE_REPOSITORY",
      4,
      "Submodule contexts cannot own epic worktrees",
    );
  }
  const porcelain = gitText(root, ["worktree", "list", "--porcelain", "-z"]);
  const worktrees = parseWorktreePorcelain(porcelain);
  const primaryRecord = worktrees.find((entry) => !entry.flags.some(({ name }) => name === "bare"));
  if (!primaryRecord)
    throw new HelperError("PRIMARY_WORKTREE_MISSING", 4, "No primary worktree is registered");
  const primaryWorktree = await canonicalExisting(primaryRecord.worktree);
  const primaryCommonRaw = gitText(primaryWorktree, ["rev-parse", "--git-common-dir"]);
  const primaryCommon = await canonicalExisting(
    isAbsolute(primaryCommonRaw) ? primaryCommonRaw : resolve(primaryWorktree, primaryCommonRaw),
  );
  if (primaryCommon !== commonDir) {
    throw new HelperError(
      "REPOSITORY_IDENTITY_MISMATCH",
      4,
      "Primary worktree has a different Git common directory",
    );
  }
  return { root, gitDir, commonDir, primaryWorktree, porcelain, worktrees };
}

async function currentLocation() {
  const probe = git(process.cwd(), ["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
  if (probe.status !== 0 || probe.stdout.trim() !== "true") return null;
  const root = await canonicalExisting(gitText(process.cwd(), ["rev-parse", "--show-toplevel"]));
  const commonRaw = gitText(process.cwd(), ["rev-parse", "--git-common-dir"]);
  const commonDir = await canonicalExisting(
    isAbsolute(commonRaw) ? commonRaw : resolve(root, commonRaw),
  );
  return { root, commonDir };
}

function validateReadiness(readiness) {
  if (!readiness || typeof readiness !== "object" || Array.isArray(readiness)) {
    throw new HelperError("INVALID_REQUEST", 2, "readiness must be an object");
  }
  const output = {};
  for (const kind of ["setup", "baseline"]) {
    const commands = readiness[kind];
    if (!Array.isArray(commands))
      throw new HelperError("INVALID_REQUEST", 2, `${kind} must be an array`);
    output[kind] = commands.map((command) => {
      if (
        !command ||
        typeof command !== "object" ||
        !Array.isArray(command.argv) ||
        command.argv.length === 0 ||
        command.argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
        typeof command.source !== "string" ||
        command.source.length === 0
      ) {
        throw new HelperError("INVALID_REQUEST", 2, `Invalid ${kind} command`);
      }
      // This is deliberately an argv-level guard. Referenced script contents cannot be
      // semantically analyzed here and remain subject to the user's source review.
      const visibleArgv = command.argv
        .join(" ")
        .replace(/\\\r?\n/g, " ")
        .replace(/\s+/g, " ");
      const trustMutation =
        /(?:^|[^a-z0-9_-])(?:[^\s;&|]*\/)?(?:direnv(?:(?![;&|]).)*?\ballow|mise(?:(?![;&|]).)*?\btrust)(?=$|[\s;&|])/i;
      if (trustMutation.test(visibleArgv)) {
        throw new HelperError(
          "INVALID_REQUEST",
          2,
          "Visible readiness argv contains a forbidden environment trust command; referenced script contents are not semantically analyzed",
        );
      }
      return { argv: [...command.argv], source: command.source };
    });
  }
  return output;
}

function validateRequest(input, command) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    input.schemaVersion !== SCHEMA_VERSION
  ) {
    throw new HelperError("INVALID_REQUEST", 2, "Request schemaVersion must be 1");
  }
  if (!input.epic || typeof input.epic.id !== "string" || typeof input.epic.slugSeed !== "string") {
    throw new HelperError("INVALID_REQUEST", 2, "epic.id and epic.slugSeed are required");
  }
  if (
    ["propose", "start", "finish"].includes(command) &&
    !/^[a-f0-9]{64}$/.test(input.agentContextDigest ?? "")
  ) {
    throw new HelperError(
      "INVALID_REQUEST",
      2,
      "agentContextDigest must be a non-empty 64-character lowercase hexadecimal digest",
    );
  }
  if (
    input.agentContextDigest !== null &&
    input.agentContextDigest !== undefined &&
    !/^[a-f0-9]{64}$/.test(input.agentContextDigest)
  ) {
    throw new HelperError("INVALID_REQUEST", 2, "agentContextDigest is invalid");
  }
  const identity = deriveIdentity(input.epic.id, input.epic.slugSeed);
  if (input.mapping !== null && input.mapping !== undefined)
    validateMapping(input.mapping, identity);
  if (!Array.isArray(input.knownMappings))
    throw new HelperError("INVALID_REQUEST", 2, "knownMappings must be an array");
  if (command === "check" || command === "finish") {
    if (!input.mapping)
      throw new HelperError("MAPPING_REQUIRED", 2, `${command} requires a mapping`);
  }
  return {
    ...input,
    sourceRepoPath: input.sourceRepoPath ?? process.cwd(),
    mapping: input.mapping ?? null,
    confirmationToken: input.confirmationToken ?? null,
    baselineExceptionToken: input.baselineExceptionToken ?? null,
    readiness: validateReadiness(input.readiness ?? { setup: [], baseline: [] }),
    identity,
  };
}

function validateMapping(mapping, identity) {
  if (
    !mapping ||
    typeof mapping !== "object" ||
    Array.isArray(mapping) ||
    mapping.schemaVersion !== 1
  ) {
    throw new HelperError("MAPPING_CONFLICT", 4, "Workspace mapping schema is invalid");
  }
  if (!STATES.has(mapping.state))
    throw new HelperError("MAPPING_CONFLICT", 4, "Workspace mapping state is invalid");
  for (const [field, expected] of [
    ["epicKey", identity.epicKey],
    ["relativePath", identity.relativePath],
    ["branch", identity.branch],
  ]) {
    if (mapping[field] !== expected) {
      throw new HelperError(
        "MAPPING_CONFLICT",
        4,
        `Workspace mapping ${field} disagrees with immutable epic identity`,
      );
    }
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(mapping.baseCommit ?? "")) {
    throw new HelperError(
      "MAPPING_CONFLICT",
      4,
      "Workspace mapping baseCommit must be a full lowercase hexadecimal object ID",
    );
  }
  const readiness = mapping.creationReadiness;
  if (
    !readiness ||
    typeof readiness !== "object" ||
    !["pass", "not-required", "not-run", "fail"].includes(readiness.setup) ||
    !["pass", "fail", "not-configured", "not-run"].includes(readiness.baseline) ||
    !/^[a-f0-9]{64}$/.test(readiness.baselineResultDigest ?? "")
  ) {
    throw new HelperError(
      "MAPPING_CONFLICT",
      4,
      "Workspace creation-readiness evidence is invalid",
    );
  }
  if (readiness.baselineException !== null) {
    const exception = requireBaselineException(readiness.baselineException);
    if (
      readiness.baseline !== exception.baselineStatus ||
      readiness.baselineResultDigest !== exception.resultDigest
    ) {
      throw new HelperError(
        "MAPPING_CONFLICT",
        4,
        "Stored baselineException does not match creation-readiness evidence",
      );
    }
  }
}

function validateKnownMappings(request) {
  const expected = request.identity;
  for (const mapping of request.knownMappings) {
    if (!mapping || typeof mapping !== "object")
      throw new HelperError("INVALID_REQUEST", 2, "Invalid known mapping");
    const owner = mapping.epicId ?? mapping.id ?? "another epic";
    if (owner === request.epic.id) continue;
    for (const [field, value] of [
      ["epicKey", expected.epicKey],
      ["relativePath", expected.relativePath],
      ["branch", expected.branch],
    ]) {
      if (
        typeof mapping[field] === "string" &&
        mapping[field].toLowerCase() === value.toLowerCase()
      ) {
        throw new HelperError("MAPPING_COLLISION", 5, `${field} is already mapped by ${owner}`, {
          collision: { field, owner },
        });
      }
    }
  }
}

async function destination(repository, identity, requireExisting = false) {
  if (
    isAbsolute(identity.relativePath) ||
    identity.relativePath.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new HelperError("INVALID_WORKTREE_PATH", 4, "Worktree path is not repository-relative");
  }
  const worktreesRoot = join(repository.primaryWorktree, ".worktrees");
  try {
    const metadata = await lstat(worktreesRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new HelperError(
        "UNSAFE_WORKTREE_PATH",
        4,
        ".worktrees must not be a symlink or non-directory",
      );
    }
  } catch (error) {
    if (error instanceof HelperError) throw error;
    if (error.code !== "ENOENT") throw error;
    if (requireExisting)
      throw new HelperError("WORKTREE_MISSING", 4, "Mapped .worktrees directory is missing");
  }
  const path = join(repository.primaryWorktree, identity.relativePath);
  if (relative(repository.primaryWorktree, path).startsWith(`..${sep}`)) {
    throw new HelperError("INVALID_WORKTREE_PATH", 4, "Worktree path escapes repository root");
  }
  if (requireExisting) {
    const metadata = await lstat(path).catch(() => null);
    if (!metadata)
      throw new HelperError("WORKTREE_MISSING", 4, "Mapped worktree directory is missing");
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new HelperError("UNSAFE_WORKTREE_PATH", 4, "Mapped worktree must be a real directory");
    }
    return await canonicalExisting(path);
  }
  try {
    await lstat(path);
    throw new HelperError("WORKTREE_PATH_COLLISION", 5, "Unregistered destination already exists");
  } catch (error) {
    if (error instanceof HelperError) throw error;
    if (error.code !== "ENOENT") throw error;
  }
  return path;
}

function checkResult(name, status, detail) {
  return { name, status, detail };
}

function baseResult(command, request, repository, path) {
  return {
    schemaVersion: SCHEMA_VERSION,
    command,
    ok: false,
    code: "UNKNOWN",
    mutation: "none",
    epic: { id: request.epic.id, key: request.identity.epicKey },
    repository: {
      root: repository.primaryWorktree,
      commonDir: repository.commonDir,
      primaryWorktree: repository.primaryWorktree,
    },
    workspace: {
      path,
      relativePath: request.identity.relativePath,
      branch: request.identity.branch,
      baseSource: "post-pull refs/heads/main containing FETCH_HEAD",
      baseCommit: request.mapping?.baseCommit ?? null,
      currentCommit: null,
      status: "unknown",
    },
    checks: [],
    setup: { status: "not-run", commands: [] },
    baseline: { status: "not-run", commands: [] },
    confirmation: { required: false, action: null, token: null },
    hostTransition: { required: false, path },
  };
}

async function inspectIgnore(repository) {
  const tracked = git(
    repository.primaryWorktree,
    ["ls-files", "--error-unmatch", "--", ".gitignore"],
    {
      allowFailure: true,
    },
  );
  const ignored = git(
    repository.primaryWorktree,
    ["check-ignore", "-v", "--no-index", "--", ".worktrees/"],
    { allowFailure: true },
  );
  const line = ignored.stdout.trim();
  const tab = line.lastIndexOf("\t");
  const provenance = tab === -1 ? "" : line.slice(0, tab);
  const source = provenance.split(":", 1)[0];
  const committed = git(repository.primaryWorktree, ["rev-parse", "--verify", "HEAD:.gitignore"], {
    allowFailure: true,
  });
  const working = git(repository.primaryWorktree, ["hash-object", "--", ".gitignore"], {
    allowFailure: true,
  });
  const committedBytesMatch =
    committed.status === 0 &&
    working.status === 0 &&
    committed.stdout.trim() === working.stdout.trim();
  const accepted =
    tracked.status === 0 && ignored.status === 0 && source === ".gitignore" && committedBytesMatch;
  return { accepted, tracked: tracked.status === 0, output: line, digest: sha256(line) };
}

function operationInProgress(commonDir) {
  return [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-apply",
    "rebase-merge",
  ].some((name) => existsSync(join(commonDir, name)));
}

async function creationInspection(request, repository) {
  validateKnownMappings(request);
  const path = join(repository.primaryWorktree, request.identity.relativePath);
  const checks = [];
  const blockers = [];
  const addBlocker = (code, detail, exitCode = 4) => {
    blockers.push({ code, detail, exitCode });
    checks.push(checkResult(code.toLowerCase(), "fail", detail));
  };
  const ignore = await inspectIgnore(repository);
  if (!ignore.accepted)
    addBlocker(
      "IGNORE_RULE_REQUIRED",
      "A matching .worktrees/ rule must come from the tracked root .gitignore",
    );
  else
    checks.push(
      checkResult("tracked-root-ignore", "pass", "Tracked root .gitignore covers .worktrees/"),
    );

  const primaryBranch = git(repository.primaryWorktree, ["symbolic-ref", "-q", "HEAD"], {
    allowFailure: true,
  });
  if (primaryBranch.status !== 0 || primaryBranch.stdout.trim() !== "refs/heads/main") {
    addBlocker("PRIMARY_MAIN_REQUIRED", "Primary worktree must have refs/heads/main checked out");
  }
  const status = gitText(repository.primaryWorktree, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (status)
    addBlocker("PRIMARY_DIRTY", "Primary main worktree must be clean, including untracked files");
  if (operationInProgress(repository.commonDir))
    addBlocker("GIT_OPERATION_IN_PROGRESS", "A Git sequencer operation is in progress");
  const mainProbe = git(repository.primaryWorktree, ["rev-parse", "--verify", "refs/heads/main"], {
    allowFailure: true,
  });
  if (mainProbe.status !== 0) addBlocker("MAIN_MISSING", "Local refs/heads/main is required");
  const origin = git(repository.primaryWorktree, ["config", "--get", "remote.origin.url"], {
    allowFailure: true,
  });
  if (origin.status !== 0 || !origin.stdout.trim())
    addBlocker("ORIGIN_MISSING", "Remote origin is required");
  const current = await currentLocation();
  if (current?.commonDir === repository.commonDir && current.root !== repository.primaryWorktree) {
    addBlocker("LINKED_WORKTREE_CONTEXT", "Creation cannot run from another linked worktree");
  }

  const expectedRef = `refs/heads/${request.identity.branch}`;
  const branch = git(repository.primaryWorktree, ["show-ref", "--verify", expectedRef], {
    allowFailure: true,
  });
  if (branch.status === 0) addBlocker("BRANCH_COLLISION", "Expected epic branch already exists", 5);
  const matchingPath = repository.worktrees.filter(
    (entry) => resolve(entry.worktree).toLowerCase() === path.toLowerCase(),
  );
  const matchingBranch = repository.worktrees.filter((entry) => entry.branch === expectedRef);
  if (matchingPath.length || matchingBranch.length)
    addBlocker("WORKTREE_COLLISION", "Expected path or branch is already registered", 5);
  try {
    await destination(repository, request.identity, false);
    checks.push(
      checkResult("destination", "pass", "Destination is absent and contained in the primary root"),
    );
  } catch (error) {
    if (!(error instanceof HelperError)) throw error;
    addBlocker(error.code, error.message, error.exitCode);
  }
  const snapshot = {
    commonDir: repository.commonDir,
    primaryWorktree: repository.primaryWorktree,
    epicId: request.epic.id,
    epicKey: request.identity.epicKey,
    path,
    branch: request.identity.branch,
    basePolicy: "origin/main via fresh pull",
    agentContextDigest: request.agentContextDigest ?? null,
    knownMappingsDigest: digestJson(request.knownMappings),
    worktreesDigest: sha256(repository.porcelain),
    primaryHead: mainProbe.stdout.trim() || null,
    primaryStatusDigest: sha256(status),
    ignoreDigest: ignore.digest,
    blockers: blockers.map(({ code }) => code),
  };
  return {
    path,
    checks,
    blockers,
    snapshot,
    token: digestJson({ action: "start", schemaVersion: 1, snapshot }),
  };
}

async function proposal(request) {
  if (request.mapping) return checkWorkspace("propose", request);
  const repository = await discoverRepository(request.sourceRepoPath);
  const inspection = await creationInspection(request, repository);
  const result = baseResult("propose", request, repository, inspection.path);
  result.checks = inspection.checks;
  result.blockers = inspection.blockers.map(({ code, detail }) => ({ code, detail }));
  result.basePolicy = "origin/main via fresh pull";
  if (inspection.blockers.length) {
    const blocker = inspection.blockers[0];
    throw new HelperError(blocker.code, blocker.exitCode, blocker.detail, { result });
  }
  result.ok = true;
  result.code = "PROPOSAL";
  result.workspace.status = "absent";
  result.confirmation = { required: true, action: "start", token: inspection.token };
  return result;
}

async function ensureSafeLockParent(commonDir) {
  const lockParent = join(commonDir, "kona");
  try {
    await mkdir(lockParent, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const metadata = await lstat(lockParent);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new HelperError("UNSAFE_LOCK_PATH", 4, "Git common-directory lock parent is unsafe");
  }
  if ((await realpath(lockParent)) !== lockParent)
    throw new HelperError("UNSAFE_LOCK_PATH", 4, "Lock parent is not canonical");
  await chmod(lockParent, 0o700);
  return lockParent;
}

async function acquireLock(repository, operation) {
  const parent = await ensureSafeLockParent(repository.commonDir);
  const path = join(parent, "epic-worktree.lock");
  const token = randomBytes(24).toString("hex");
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let lockOwner = null;
    try {
      lockOwner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
    } catch {
      lockOwner = { unreadable: true };
    }
    throw new HelperError(
      "LOCK_UNAVAILABLE",
      9,
      "Repository lock exists; inspect it manually and never auto-break it",
      { lockOwner },
    );
  }
  const owner = {
    operation,
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    token,
  };
  await writeFile(join(path, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  return { path, token };
}

async function releaseLock(lock) {
  try {
    const owner = JSON.parse(await readFile(join(lock.path, "owner.json"), "utf8"));
    if (owner.token === lock.token) await rm(lock.path, { recursive: true });
  } catch {
    // A changed lock is deliberately retained for manual inspection.
  }
}

async function runCommands(commands, cwd, emptyStatus) {
  if (commands.length === 0) return { status: emptyStatus, commands: [] };
  const records = [];
  for (const command of commands) {
    const started = process.hrtime.bigint();
    const child = spawnSync(command.argv[0], command.argv.slice(1), {
      cwd,
      encoding: "utf8",
      shell: false,
      maxBuffer: MAX_COMMAND_OUTPUT,
    });
    const stdout = (child.stdout ?? "").slice(0, MAX_COMMAND_OUTPUT);
    const stderr = (child.stderr ?? "").slice(0, MAX_COMMAND_OUTPUT);
    if (stdout) process.stderr.write(stdout);
    if (stderr) process.stderr.write(stderr);
    const record = {
      argv: command.argv,
      source: command.source,
      exitCode: child.status ?? 127,
      durationMs: Number((process.hrtime.bigint() - started) / 1000000n),
      stdoutDigest: sha256(stdout),
      stderrDigest: sha256(stderr),
    };
    records.push(record);
    if (record.exitCode !== 0) return { status: "fail", commands: records };
  }
  return { status: "pass", commands: records };
}

function validateRepositoryObjectId(repository, objectId) {
  const format = gitText(repository.primaryWorktree, ["rev-parse", "--show-object-format"]);
  const expectedLength = format === "sha256" ? 64 : format === "sha1" ? 40 : null;
  const resolved = git(
    repository.primaryWorktree,
    ["rev-parse", "--verify", `${objectId}^{commit}`],
    { allowFailure: true },
  );
  if (
    expectedLength === null ||
    objectId.length !== expectedLength ||
    resolved.stdout.trim() !== objectId
  ) {
    throw new HelperError(
      "BASE_COMMIT_MISMATCH",
      4,
      "Mapped baseCommit is not a full commit object ID for this repository object format",
    );
  }
}

function localRelationship(cwd, ref, head) {
  const available = git(cwd, ["show-ref", "--verify", ref], { allowFailure: true });
  if (available.status !== 0) return null;
  const counts = gitText(cwd, ["rev-list", "--left-right", "--count", `${ref}...${head}`])
    .trim()
    .split(/\s+/)
    .map(Number);
  if (counts.length !== 2 || counts.some((value) => !Number.isSafeInteger(value))) {
    throw new HelperError("MALFORMED_GIT_OUTPUT", 4, `Invalid ahead/behind output for ${ref}`);
  }
  return { ahead: counts[1], behind: counts[0] };
}

function aheadBehind(repository, head) {
  return {
    main: localRelationship(repository.primaryWorktree, "refs/heads/main", head),
    originMain: localRelationship(repository.primaryWorktree, "refs/remotes/origin/main", head),
  };
}

function inspectWorkspaceState(path) {
  const head = git(path, ["rev-parse", "--verify", "HEAD^{commit}"], { allowFailure: true });
  const status = git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    allowFailure: true,
  });
  return {
    currentCommit: head.status === 0 ? head.stdout.trim() : null,
    status: status.status === 0 ? (status.stdout ? "dirty" : "clean") : "unknown",
    statusPorcelain: status.status === 0 ? status.stdout : "",
  };
}

function applyWorkspaceState(result, path) {
  const observed = inspectWorkspaceState(path);
  result.workspace.currentCommit = observed.currentCommit;
  result.workspace.status = observed.status;
  result.statusDigest = sha256(observed.statusPorcelain);
  return observed;
}

async function registeredWorkspace(repository, request) {
  validateRepositoryObjectId(repository, request.mapping.baseCommit);
  const path = await destination(repository, request.identity, true);
  const freshPorcelain = gitText(repository.primaryWorktree, [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  const records = parseWorktreePorcelain(freshPorcelain);
  const expectedRef = `refs/heads/${request.identity.branch}`;
  const matches = [];
  for (const record of records) {
    let canonicalPath;
    try {
      canonicalPath = await realpath(record.worktree);
    } catch {
      canonicalPath = resolve(record.worktree);
    }
    if (canonicalPath === path) matches.push(record);
  }
  if (matches.length !== 1)
    throw new HelperError(
      "WORKTREE_REGISTRATION_MISMATCH",
      4,
      "Expected one exact worktree registration",
    );
  const record = matches[0];
  if (
    record.branch !== expectedRef ||
    record.flags.some(({ name }) => ["detached", "locked", "prunable", "bare"].includes(name))
  ) {
    throw new HelperError(
      "WORKTREE_IDENTITY_MISMATCH",
      4,
      "Mapped worktree branch or registry state is unsafe",
    );
  }
  if (records.filter((entry) => entry.branch === expectedRef).length !== 1) {
    throw new HelperError("BRANCH_COLLISION", 5, "Mapped branch is registered more than once");
  }
  const linkedGitDir = await canonicalExisting(gitText(path, ["rev-parse", "--absolute-git-dir"]));
  const linkedCommonRaw = gitText(path, ["rev-parse", "--git-common-dir"]);
  const linkedCommon = await canonicalExisting(
    isAbsolute(linkedCommonRaw) ? linkedCommonRaw : resolve(path, linkedCommonRaw),
  );
  if (linkedGitDir === linkedCommon || linkedCommon !== repository.commonDir) {
    throw new HelperError(
      "WORKTREE_IDENTITY_MISMATCH",
      4,
      "Expected a linked worktree with the repository common directory",
    );
  }
  const branch = gitText(path, ["symbolic-ref", "-q", "HEAD"]);
  if (branch !== expectedRef)
    throw new HelperError(
      "WORKTREE_IDENTITY_MISMATCH",
      4,
      "Worktree HEAD branch does not match mapping",
    );
  const head = gitText(path, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const ancestor = git(path, ["merge-base", "--is-ancestor", request.mapping.baseCommit, head], {
    allowFailure: true,
  });
  if (ancestor.status !== 0)
    throw new HelperError(
      "BASE_COMMIT_MISMATCH",
      4,
      "Mapped base is not an ancestor of current HEAD",
    );
  return { path, record, records, porcelain: freshPorcelain, head };
}

function creationMapping(request, baseCommit, setup, baseline, baselineException = null) {
  return {
    schemaVersion: 1,
    state: "starting",
    epicKey: request.identity.epicKey,
    relativePath: request.identity.relativePath,
    branch: request.identity.branch,
    baseCommit,
    creationReadiness: {
      setup: setup.status,
      baseline: baseline.status,
      baselineResultDigest: digestJson({ setup, baseline }),
      baselineException,
    },
  };
}

function recoveryMapping(request, baseCommit) {
  return creationMapping(
    request,
    baseCommit,
    { status: "not-run", commands: [] },
    { status: "not-run", commands: [] },
  );
}

async function start(request) {
  if (request.mapping) return checkWorkspace("start", request);
  const repository = await discoverRepository(request.sourceRepoPath);
  const initialInspection = await creationInspection(request, repository);
  if (!request.confirmationToken) {
    throw new HelperError(
      "CONFIRMATION_REQUIRED",
      3,
      "Start requires the proposal confirmation token",
      {
        result: {
          ...baseResult("start", request, repository, initialInspection.path),
          confirmation: { required: true, action: "start", token: initialInspection.token },
        },
      },
    );
  }
  if (request.confirmationToken !== initialInspection.token) {
    throw new HelperError(
      "CONFIRMATION_STALE",
      3,
      "Start confirmation no longer matches repository state",
      { result: baseResult("start", request, repository, initialInspection.path) },
    );
  }
  const lock = await acquireLock(repository, "start");
  try {
    const refreshed = await discoverRepository(request.sourceRepoPath);
    const inspection = await creationInspection(request, refreshed);
    if (request.confirmationToken !== inspection.token) {
      throw new HelperError(
        "CONFIRMATION_STALE",
        3,
        "Start confirmation no longer matches repository state",
        {
          result: baseResult("start", request, refreshed, inspection.path),
        },
      );
    }
    if (inspection.blockers.length) {
      const blocker = inspection.blockers[0];
      throw new HelperError(blocker.code, blocker.exitCode, blocker.detail, {
        result: baseResult("start", request, refreshed, inspection.path),
      });
    }
    const pull = git(
      refreshed.primaryWorktree,
      ["-C", refreshed.primaryWorktree, "pull", "--ff-only", "origin", "main"],
      {
        allowFailure: true,
        mutate: true,
      },
    );
    if (pull.status !== 0) {
      throw new HelperError(
        "PULL_FAILED",
        6,
        "Fresh fast-forward-only pull failed; no rollback was attempted",
        {
          result: {
            ...baseResult("start", request, refreshed, inspection.path),
            mutation: "pull-attempted",
          },
        },
      );
    }
    const head = gitText(refreshed.primaryWorktree, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const mainCommit = gitText(refreshed.primaryWorktree, [
      "rev-parse",
      "--verify",
      "refs/heads/main^{commit}",
    ]);
    const fetchHead = gitText(refreshed.primaryWorktree, [
      "rev-parse",
      "--verify",
      "FETCH_HEAD^{commit}",
    ]);
    if (
      head !== mainCommit ||
      git(refreshed.primaryWorktree, ["merge-base", "--is-ancestor", fetchHead, mainCommit], {
        allowFailure: true,
      }).status !== 0
    ) {
      throw new HelperError(
        "POST_PULL_VERIFICATION_FAILED",
        6,
        "Post-pull main does not contain FETCH_HEAD",
        {
          result: {
            ...baseResult("start", request, refreshed, inspection.path),
            mutation: "pull-completed",
          },
        },
      );
    }
    const raceCheck = await discoverRepository(request.sourceRepoPath);
    const afterPull = await creationInspection(request, raceCheck);
    if (afterPull.blockers.length) {
      throw new HelperError("POST_PULL_REVALIDATION_FAILED", 6, afterPull.blockers[0].detail, {
        result: {
          ...baseResult("start", request, raceCheck, inspection.path),
          mutation: "pull-completed",
        },
      });
    }
    const refreshedHead = gitText(raceCheck.primaryWorktree, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]);
    const refreshedMain = gitText(raceCheck.primaryWorktree, [
      "rev-parse",
      "--verify",
      "refs/heads/main^{commit}",
    ]);
    if (refreshedHead !== mainCommit || refreshedMain !== mainCommit) {
      throw new HelperError(
        "POST_PULL_REVALIDATION_FAILED",
        6,
        "Primary HEAD or refs/heads/main moved after the captured post-pull commit",
        {
          result: {
            ...baseResult("start", request, raceCheck, inspection.path),
            mutation: "pull-completed",
          },
        },
      );
    }
    const added = git(
      raceCheck.primaryWorktree,
      [
        "-C",
        raceCheck.primaryWorktree,
        "worktree",
        "add",
        "-b",
        request.identity.branch,
        inspection.path,
        mainCommit,
      ],
      { allowFailure: true, mutate: true },
    );
    if (added.status !== 0) {
      const observed = await observePartialCreation(raceCheck, request, inspection.path);
      const result = {
        ...baseResult("start", request, raceCheck, inspection.path),
        mutation: observed.partial ? "partial" : "add-attempted",
        partial: observed,
      };
      result.workspace.baseCommit = mainCommit;
      if (observed.partial) result.mapping = recoveryMapping(request, mainCommit);
      throw new HelperError(
        observed.partial ? "PARTIAL_CREATION" : "WORKTREE_ADD_FAILED",
        6,
        "Worktree add failed; observed artifacts were preserved",
        { result },
      );
    }
    const recovery = recoveryMapping(request, mainCommit);
    const mappingSeed = {
      ...request,
      mapping: recovery,
    };
    let verified;
    try {
      const postAddHead = gitText(raceCheck.primaryWorktree, [
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
      ]);
      const postAddMain = gitText(raceCheck.primaryWorktree, [
        "rev-parse",
        "--verify",
        "refs/heads/main^{commit}",
      ]);
      if (postAddHead !== mainCommit || postAddMain !== mainCommit) {
        throw new HelperError(
          "POST_ADD_PRIMARY_MOVED",
          6,
          "Primary HEAD or refs/heads/main moved after worktree add",
        );
      }
      verified = await registeredWorkspace(raceCheck, mappingSeed);
      if (verified.head !== mainCommit) {
        throw new HelperError(
          "CREATION_VERIFICATION_FAILED",
          6,
          "Created worktree did not start at post-pull main",
        );
      }
    } catch (error) {
      const observed = await observePartialCreation(raceCheck, request, inspection.path);
      const result = {
        ...baseResult("start", request, raceCheck, inspection.path),
        mutation: "partial",
        mapping: recovery,
        partial: observed,
        verificationFailure: {
          code: error instanceof HelperError ? error.code : "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      };
      result.workspace.baseCommit = mainCommit;
      if (observed.pathExists) applyWorkspaceState(result, inspection.path);
      throw new HelperError(
        "PARTIAL_CREATION",
        6,
        "Post-add verification failed; created artifacts were preserved",
        { result },
      );
    }
    const result = baseResult("start", request, raceCheck, inspection.path);
    result.mutation = "created";
    result.workspace.baseCommit = mainCommit;
    result.workspace.currentCommit = verified.head;
    result.workspace.status = "clean";
    result.setup = await runCommands(request.readiness.setup, inspection.path, "not-required");
    if (result.setup.status === "fail") {
      result.code = "SETUP_FAILED";
      result.baseline = { status: "not-run", commands: [] };
      result.mapping = creationMapping(request, mainCommit, result.setup, result.baseline);
      applyWorkspaceState(result, inspection.path);
      throw new HelperError(
        result.code,
        7,
        "Setup command failed; created worktree was preserved",
        { result },
      );
    }
    result.baseline = await runCommands(
      request.readiness.baseline,
      inspection.path,
      "not-configured",
    );
    result.mapping = creationMapping(request, mainCommit, result.setup, result.baseline);
    if (result.baseline.status === "fail") {
      const observed = applyWorkspaceState(result, inspection.path);
      result.code = "BASELINE_FAILED";
      if (observed.currentCommit === mainCommit && observed.status === "clean") {
        const exceptionToken = baselineToken(
          request,
          raceCheck,
          result.baseline,
          observed.currentCommit,
          sha256(observed.statusPorcelain),
        );
        result.confirmation = {
          required: true,
          action: "baseline-exception",
          token: exceptionToken,
        };
      }
      throw new HelperError(
        result.code,
        7,
        "Baseline command failed; created worktree and command evidence were preserved",
        { result },
      );
    }
    const afterCommands = await verifyAfterCommands(raceCheck, mappingSeed, mainCommit);
    result.workspace.currentCommit = afterCommands.head;
    result.workspace.status = afterCommands.status ? "dirty" : "clean";
    if (afterCommands.head !== mainCommit || afterCommands.status) {
      result.code = "READINESS_CHANGED_WORKTREE";
      throw new HelperError(
        result.code,
        7,
        "Readiness commands changed tracked source, untracked source, or HEAD",
        { result },
      );
    }
    if (result.baseline.status !== "pass") {
      const exceptionToken = baselineToken(
        request,
        raceCheck,
        result.baseline,
        mainCommit,
        sha256(afterCommands.status),
      );
      result.code =
        result.baseline.status === "not-configured" ? "BASELINE_NOT_CONFIGURED" : "BASELINE_FAILED";
      result.confirmation = { required: true, action: "baseline-exception", token: exceptionToken };
      throw new HelperError(
        result.code,
        7,
        "Baseline did not pass; created worktree was preserved",
        { result },
      );
    }
    result.code = "HOST_TRANSITION_REQUIRED";
    result.hostTransition = { required: true, path: inspection.path };
    throw new HelperError(result.code, 8, "Enter the verified linked worktree and run check", {
      result,
    });
  } finally {
    await releaseLock(lock);
  }
}

async function observePartialCreation(repository, request, path) {
  const pathExists = await lstat(path).then(
    () => true,
    () => false,
  );
  const branchExists =
    git(
      repository.primaryWorktree,
      ["show-ref", "--verify", `refs/heads/${request.identity.branch}`],
      { allowFailure: true },
    ).status === 0;
  const porcelain = gitText(repository.primaryWorktree, ["worktree", "list", "--porcelain", "-z"]);
  const registered = parseWorktreePorcelain(porcelain).some(
    (entry) => resolve(entry.worktree) === path,
  );
  return {
    partial: pathExists || branchExists || registered,
    pathExists,
    branchExists,
    registered,
  };
}

async function verifyAfterCommands(repository, mappedRequest, expectedHead = null) {
  const verified = await registeredWorkspace(repository, mappedRequest);
  const status = gitText(verified.path, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (expectedHead && verified.head !== expectedHead) return { ...verified, status };
  return { ...verified, status };
}

function baselineToken(request, repository, baseline, commit, statusDigest) {
  return digestJson({
    action: "baseline-exception",
    schemaVersion: 1,
    commonDir: repository.commonDir,
    epicId: request.epic.id,
    epicKey: request.identity.epicKey,
    commit,
    statusDigest,
    baseline: stableBaselineResult(baseline),
  });
}

async function checkWorkspace(command, request) {
  const repository = await discoverRepository(request.sourceRepoPath);
  validateKnownMappings(request);
  const verified = await registeredWorkspace(repository, request);
  const result = baseResult(command, request, repository, verified.path);
  result.workspace.baseCommit = request.mapping.baseCommit;
  result.workspace.currentCommit = verified.head;
  result.workspace.aheadBehind = aheadBehind(repository, verified.head);
  result.checks.push(
    checkResult(
      "linked-worktree",
      "pass",
      "Exact path, branch, common directory, and registration verified",
    ),
  );
  const current = await currentLocation();
  if (!current || current.commonDir !== repository.commonDir || current.root !== verified.path) {
    result.code = "HOST_TRANSITION_REQUIRED";
    result.workspace.status = "unknown";
    result.hostTransition = { required: true, path: verified.path };
    throw new HelperError(result.code, 8, "Current host is not inside the expected worktree", {
      result,
    });
  }
  const status = gitText(verified.path, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  result.workspace.status = status ? "dirty" : "clean";
  result.statusDigest = sha256(status);
  if (command === "propose") {
    result.ok = true;
    result.code = "MAPPED_WORKSPACE";
    result.setup = { status: "not-run", commands: [] };
    result.baseline = { status: "not-run", commands: [] };
    return result;
  }
  if (status) {
    result.setup = { status: "not-run-existing-changes", commands: [] };
    result.baseline = { status: "not-run-existing-changes", commands: [] };
    const readiness = request.mapping.creationReadiness;
    const accepted = readiness.baseline === "pass" || readiness.baselineException !== null;
    if (request.mapping.state === "active" && accepted) {
      result.ok = true;
      result.code = "READY_EXISTING_WORK";
      return result;
    }
    result.code =
      request.mapping.state === "starting"
        ? "DIRTY_STARTING_WORKTREE"
        : "DIRTY_WORKTREE_NOT_RESUMABLE";
    throw new HelperError(
      result.code,
      4,
      "Dirty worktree cannot establish readiness for this mapping state",
      { result },
    );
  }
  result.setup = await runCommands(request.readiness.setup, verified.path, "not-required");
  if (result.setup.status === "fail") {
    result.code = "SETUP_FAILED";
    applyWorkspaceState(result, verified.path);
    result.mapping = structuredClone(request.mapping);
    throw new HelperError(result.code, 7, "Setup command failed", { result });
  }
  result.baseline = await runCommands(request.readiness.baseline, verified.path, "not-configured");
  if (result.baseline.status === "fail") {
    const observed = applyWorkspaceState(result, verified.path);
    result.mapping = structuredClone(request.mapping);
    result.code = "BASELINE_FAILED";
    const token = baselineToken(
      request,
      repository,
      result.baseline,
      observed.currentCommit,
      sha256(observed.statusPorcelain),
    );
    if (
      observed.currentCommit === verified.head &&
      observed.status === "clean" &&
      request.baselineExceptionToken === token
    ) {
      const evidence = baselineExceptionEvidence(
        token,
        result.baseline,
        observed.currentCommit,
        result.statusDigest,
      );
      result.ok = true;
      result.code = "READY";
      result.baseline.exception = evidence;
      result.mapping = persistBaselineException(result.mapping, evidence);
      return result;
    }
    if (observed.currentCommit === verified.head && observed.status === "clean") {
      result.confirmation = { required: true, action: "baseline-exception", token };
    }
    throw new HelperError(
      result.code,
      7,
      "Baseline command failed; command evidence and observed workspace state were preserved",
      { result },
    );
  }
  const after = await verifyAfterCommands(repository, request);
  result.workspace.currentCommit = after.head;
  result.workspace.status = after.status ? "dirty" : "clean";
  if (after.head !== verified.head || after.status) {
    result.code = "READINESS_CHANGED_WORKTREE";
    throw new HelperError(
      result.code,
      7,
      "Readiness commands changed tracked source, untracked source, or HEAD",
      { result },
    );
  }
  if (result.baseline.status !== "pass") {
    const token = baselineToken(
      request,
      repository,
      result.baseline,
      after.head,
      sha256(after.status),
    );
    if (request.baselineExceptionToken === token) {
      const statusDigest = sha256(after.status);
      const evidence = baselineExceptionEvidence(token, result.baseline, after.head, statusDigest);
      result.ok = true;
      result.code = "READY";
      result.statusDigest = statusDigest;
      result.baseline.exception = evidence;
      result.mapping = persistBaselineException(request.mapping, evidence);
      return result;
    }
    result.code =
      result.baseline.status === "not-configured" ? "BASELINE_NOT_CONFIGURED" : "BASELINE_FAILED";
    result.confirmation = { required: true, action: "baseline-exception", token };
    throw new HelperError(result.code, 7, "Baseline requires a matching explicit exception", {
      result,
    });
  }
  result.ok = true;
  result.code = "READY";
  return result;
}

async function finishPreflight(request, repository) {
  const verified = await registeredWorkspace(repository, request);
  const result = baseResult("finish", request, repository, verified.path);
  result.workspace.baseCommit = request.mapping.baseCommit;
  result.workspace.currentCommit = verified.head;
  const status = gitText(verified.path, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const ignoredStatus = gitText(verified.path, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
  ]);
  const ignoredUntracked = ignoredStatus.split("\0").filter(Boolean);
  const dirty = Boolean(status || ignoredUntracked.length);
  result.workspace.status = dirty ? "dirty" : "clean";
  const branchRef = `refs/heads/${request.identity.branch}`;
  const branchTip = gitText(repository.primaryWorktree, [
    "rev-parse",
    "--verify",
    `${branchRef}^{commit}`,
  ]);
  const tipMatches = branchTip === verified.head;
  const originContains =
    git(
      repository.primaryWorktree,
      ["merge-base", "--is-ancestor", branchTip, "refs/remotes/origin/main"],
      { allowFailure: true },
    ).status === 0;
  const upstream = git(
    verified.path,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { allowFailure: true },
  );
  const upstreamContains =
    upstream.status === 0
      ? git(verified.path, ["merge-base", "--is-ancestor", branchTip, upstream.stdout.trim()], {
          allowFailure: true,
        }).status === 0
      : null;
  result.preflight = {
    clean: !dirty,
    ignoredUntracked,
    changes: status.split("\0").filter(Boolean),
    branchTip,
    headMatchesBranchTip: tipMatches,
    originMainContainsTip: originContains,
    upstream: upstream.status === 0 ? upstream.stdout.trim() : null,
    upstreamContainsTip: upstreamContains,
  };
  result.warnings = [];
  if (!originContains)
    result.warnings.push("Branch tip is not contained in the available origin/main");
  if (!result.preflight.upstream) result.warnings.push("Branch has no configured upstream");
  else if (!upstreamContains)
    result.warnings.push("Branch tip is not contained in its configured upstream");
  const snapshot = {
    action: "finish",
    schemaVersion: 1,
    commonDir: repository.commonDir,
    epicId: request.epic.id,
    epicKey: request.identity.epicKey,
    path: verified.path,
    branch: request.identity.branch,
    agentContextDigest: request.agentContextDigest ?? null,
    knownMappingsDigest: digestJson(request.knownMappings),
    porcelainDigest: sha256(verified.porcelain),
    statusDigest: sha256(`${status}\0${ignoredStatus}`),
    branchTip,
    head: verified.head,
    clean: !dirty,
    tipMatches,
  };
  return { result, safe: !dirty && tipMatches, token: digestJson(snapshot), branchTip, verified };
}

async function finish(request) {
  const repository = await discoverRepository(request.sourceRepoPath);
  validateKnownMappings(request);
  if (!request.confirmationToken) {
    const preflight = await finishPreflight(request, repository);
    if (!preflight.safe) {
      preflight.result.code = "CLEANUP_UNSAFE";
      throw new HelperError(
        "CLEANUP_UNSAFE",
        4,
        "Cleanup preflight is unsafe; worktree and branch were preserved",
        { result: preflight.result },
      );
    }
    preflight.result.ok = true;
    preflight.result.code = "PREFLIGHT_SAFE";
    preflight.result.confirmation = { required: true, action: "finish", token: preflight.token };
    return preflight.result;
  }
  const lock = await acquireLock(repository, "finish");
  try {
    const refreshed = await discoverRepository(request.sourceRepoPath);
    const preflight = await finishPreflight(request, refreshed);
    if (!preflight.safe || request.confirmationToken !== preflight.token) {
      preflight.result.code = "CONFIRMATION_STALE";
      throw new HelperError(
        "CONFIRMATION_STALE",
        3,
        "Finish confirmation no longer matches cleanup preflight",
        { result: preflight.result },
      );
    }
    const removed = git(
      refreshed.primaryWorktree,
      ["-C", refreshed.primaryWorktree, "worktree", "remove", preflight.verified.path],
      { allowFailure: true, mutate: true },
    );
    if (removed.status !== 0) {
      preflight.result.code = "REMOVE_FAILED";
      preflight.result.mutation = "remove-attempted";
      throw new HelperError(
        "REMOVE_FAILED",
        6,
        "Non-forced worktree removal failed; no cleanup compensation was attempted",
        { result: preflight.result },
      );
    }
    const afterPorcelain = gitText(refreshed.primaryWorktree, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    const stillRegistered = parseWorktreePorcelain(afterPorcelain).some(
      (entry) => resolve(entry.worktree) === preflight.verified.path,
    );
    const pathExists = await lstat(preflight.verified.path).then(
      () => true,
      () => false,
    );
    const retainedTip = gitText(refreshed.primaryWorktree, [
      "rev-parse",
      "--verify",
      `refs/heads/${request.identity.branch}^{commit}`,
    ]);
    if (stillRegistered || pathExists || retainedTip !== preflight.branchTip) {
      preflight.result.code = "PARTIAL_REMOVAL";
      preflight.result.mutation = "partial";
      throw new HelperError(
        "PARTIAL_REMOVAL",
        6,
        "Removal postconditions failed; branch was not modified",
        { result: preflight.result },
      );
    }
    preflight.result.ok = true;
    preflight.result.code = "REMOVED";
    preflight.result.mutation = "removed";
    preflight.result.workspace.status = "absent";
    preflight.result.confirmation = { required: false, action: null, token: null };
    return preflight.result;
  } finally {
    await releaseLock(lock);
  }
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT) throw new HelperError("INVALID_REQUEST", 2, "JSON request is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HelperError("INVALID_REQUEST", 2, "stdin must contain one valid JSON request");
  }
}

function failureResult(command, error) {
  const embedded = error.details?.result ?? {};
  const { result: _result, ...details } = error.details ?? {};
  return {
    schemaVersion: SCHEMA_VERSION,
    command: COMMANDS.has(command) ? command : null,
    mutation: "none",
    ...embedded,
    ok: false,
    code: error.code ?? "INTERNAL_ERROR",
    message: error.message,
    ...details,
  };
}

async function main() {
  const [command, format, ...extra] = process.argv.slice(2);
  if (!COMMANDS.has(command) || format !== "--json" || extra.length) {
    const error = new HelperError(
      "INVALID_ARGUMENTS",
      2,
      "Usage: epic-worktree.mjs <propose|start|check|finish> --json",
    );
    process.stdout.write(`${JSON.stringify(failureResult(command, error))}\n`);
    process.exitCode = error.exitCode;
    return;
  }
  try {
    const input = await readStdin();
    const request = validateRequest(input, command);
    const result = await { propose: proposal, start, check: checkWorkspace, finish }[command](
      ...(command === "check" ? [command, request] : [request]),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const normalized =
      error instanceof HelperError
        ? error
        : new HelperError(
            "INTERNAL_ERROR",
            4,
            error instanceof Error ? error.message : String(error),
          );
    process.stdout.write(`${JSON.stringify(failureResult(command, normalized))}\n`);
    process.exitCode = normalized.exitCode;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
