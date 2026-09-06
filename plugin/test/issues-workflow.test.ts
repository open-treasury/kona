import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deriveIdentity,
  prepareIssuesWorkspaceWrite,
  snapshotIssuesContext,
  transitionIssuesWorkspace,
  verifyIssuesWorkspaceWrite,
} from "../skills/epic-worktree/scripts/epic-worktree.mjs";

const skill = readFileSync(join(import.meta.dir, "..", "skills", "issues", "SKILL.md"), "utf8");

const scenarios = [
  {
    name: "missing installation",
    evidence: [
      /`br` is unavailable/i,
      /exact command, source, and expected system effect/i,
      /explicit confirmation/i,
    ],
  },
  {
    name: "uninitialized project",
    evidence: [/project is not\s+initialized/i, /before running\s+`br init`/i],
  },
  { name: "small work", evidence: [/small bounded change, use one issue/i] },
  {
    name: "substantial feature",
    evidence: [/substantial feature[\s\S]*one epic/i, /child issues before implementing a child/i],
  },
  {
    name: "dependency graph",
    evidence: [/dependent work depend on its blocker/i, /dependencies are acyclic/i],
  },
  {
    name: "claim conflict",
    evidence: [/another active actor/i, /age\s+alone does not authorize takeover/i],
  },
  {
    name: "discovered work",
    evidence: [/newly discovered required work/i, /before undertaking it/i],
  },
  {
    name: "failed verification",
    evidence: [/verification fails[\s\S]*accurately non-closed/i],
  },
  {
    name: "successful closure",
    evidence: [/Close only when the criteria pass/i, /outcome and evidence/i],
  },
  {
    name: "bounded continuation",
    evidence: [/do not automatically start[\s\S]*another issue/i],
  },
];

const clone = <T>(value: T): T => structuredClone(value);

class FakeBr {
  events: string[] = [];
  updates = 0;
  epic = {
    id: "E-42",
    parent_id: null,
    status: "open",
    claim: null as string | null,
    source_repo_path: "/repo",
    agent_context: {
      owner: { team: "settlements" },
      flags: ["preserve", { nested: true }],
      kona: { epicSlugSeed: "Import settlement reports", policy: { review: true } },
    },
  };

  show() {
    this.events.push("br:show");
    return clone(this.epic);
  }

  claim(actor: string) {
    this.events.push("br:claim");
    if (this.epic.claim && this.epic.claim !== actor) return false;
    this.epic.claim = actor;
    return true;
  }

  updateAgentContext(agentContext: typeof this.epic.agent_context) {
    this.events.push("br:update-context");
    this.updates += 1;
    this.epic.agent_context = clone(agentContext);
  }
}

class FakeWorktreeHelper {
  constructor(private readonly events: string[]) {}

  propose(epic: FakeBr["epic"]) {
    this.events.push("helper:propose");
    const identity = deriveIdentity(epic.id, epic.agent_context.kona.epicSlugSeed);
    return {
      code: "PROPOSAL",
      confirmation: { token: "start-token" },
      workspace: { relativePath: identity.relativePath, branch: identity.branch },
    };
  }

  start(epic: FakeBr["epic"]) {
    this.events.push("helper:start");
    const identity = deriveIdentity(epic.id, epic.agent_context.kona.epicSlugSeed);
    return {
      code: "HOST_TRANSITION_REQUIRED",
      mapping: {
        schemaVersion: 1,
        state: "starting",
        epicKey: identity.epicKey,
        relativePath: identity.relativePath,
        branch: identity.branch,
        baseCommit: "abc123",
        creationReadiness: {
          setup: "not-required",
          baseline: "pass",
          baselineResultDigest: "a".repeat(64),
          baselineException: null,
        },
      },
    };
  }
}

function startEpicWorkspace(
  br: FakeBr,
  options: { confirmed?: boolean; beforeWrite?: () => void } = {},
) {
  const helper = new FakeWorktreeHelper(br.events);
  const initial = br.show();
  const proposal = helper.propose(initial);
  br.events.push(options.confirmed === false ? "user:decline" : "user:confirm");
  if (options.confirmed === false) return { code: "DECLINED", proposal };
  if (!br.claim("agent-a")) return { code: "CLAIM_CONFLICT", proposal };

  const claimed = br.show();
  const expected = snapshotIssuesContext(claimed);
  const started = helper.start(claimed);
  const mapping = transitionIssuesWorkspace(null, started);
  options.beforeWrite?.();
  const prepared = prepareIssuesWorkspaceWrite(br.show(), expected, mapping);
  br.updateAgentContext(prepared.agentContext as typeof br.epic.agent_context);
  verifyIssuesWorkspaceWrite(prepared, br.show());
  return { code: started.code, proposal, mapping };
}

describe("issues workflow scenarios", () => {
  for (const scenario of scenarios) {
    test(scenario.name, () => {
      for (const evidence of scenario.evidence) expect(skill).toMatch(evidence);
    });
  }

  test("contains no executable prohibited backend commands", () => {
    expect(skill).not.toMatch(/(?:^|\n)\s*(?:\$\s*)?bd\s+\w+/m);
    expect(skill).not.toMatch(/(?:^|\n)\s*(?:\$\s*)?dolt\s+\w+/im);
  });

  test("keeps issue semantics separate from the current backend", () => {
    expect(skill).toMatch(/public capability is `issues`/i);
    expect(skill).toMatch(/`br` is its required backend for this release/i);
    expect(skill).toMatch(/future Kona backend can replace `br`/i);
  });
});

describe("epic workspace issues state scenarios", () => {
  test("proposes before claim and merges workspace without replacing unrelated context", () => {
    const br = new FakeBr();
    const before = clone(br.epic.agent_context);
    const result = startEpicWorkspace(br);

    expect(result.code).toBe("HOST_TRANSITION_REQUIRED");
    expect(br.events.indexOf("helper:propose")).toBeLessThan(br.events.indexOf("br:claim"));
    expect(br.events.indexOf("br:claim")).toBeLessThan(br.events.indexOf("helper:start"));
    expect(br.epic.agent_context.owner).toEqual(before.owner);
    expect(br.epic.agent_context.flags).toEqual(before.flags);
    expect(br.epic.agent_context.kona.policy).toEqual(before.kona.policy);
    expect(br.epic.agent_context.kona.workspace).toEqual(result.mapping);
  });

  test("declining the proposal performs no claim, start, or context mutation", () => {
    const br = new FakeBr();
    const before = clone(br.epic);

    expect(startEpicWorkspace(br, { confirmed: false }).code).toBe("DECLINED");
    expect(br.epic).toEqual(before);
    expect(br.events).toEqual(["br:show", "helper:propose", "user:decline"]);
    expect(br.updates).toBe(0);
  });

  test("claim conflict blocks start and context mutation", () => {
    const br = new FakeBr();
    br.epic.claim = "agent-b";

    expect(startEpicWorkspace(br).code).toBe("CLAIM_CONFLICT");
    expect(br.events).not.toContain("helper:start");
    expect(br.updates).toBe(0);
  });

  test("pre-write mismatch fails closed before br update", () => {
    const br = new FakeBr();

    expect(() =>
      startEpicWorkspace(br, {
        beforeWrite: () => {
          br.epic.agent_context.owner.team = "concurrent-writer";
        },
      }),
    ).toThrow(expect.objectContaining({ code: "ISSUE_CONTEXT_CONFLICT" }));
    expect(br.updates).toBe(0);
    expect(br.events).not.toContain("br:update-context");
  });

  test("read-after-write mismatch fails without a compensating rollback", () => {
    const br = new FakeBr();
    const originalUpdate = br.updateAgentContext.bind(br);
    br.updateAgentContext = (agentContext) => {
      originalUpdate(agentContext);
      br.epic.agent_context.owner.team = "raced-after-write";
    };

    expect(() => startEpicWorkspace(br)).toThrow(
      expect.objectContaining({ code: "ISSUE_CONTEXT_WRITE_MISMATCH" }),
    );
    expect(br.updates).toBe(1);
    expect(br.events.filter((event) => event === "br:update-context")).toHaveLength(1);
    expect(br.epic.agent_context.owner.team).toBe("raced-after-write");
  });

  test("starting becomes active only on READY", () => {
    const br = new FakeBr();
    const { mapping } = startEpicWorkspace(br);
    const ready = transitionIssuesWorkspace(mapping, {
      code: "READY",
      statusDigest: "clean",
      workspace: { currentCommit: "def456" },
    });

    expect(ready.state).toBe("active");
    expect(ready.lastCheck).toEqual({
      code: "READY",
      currentCommit: "def456",
      statusDigest: "clean",
    });
    expect(() => transitionIssuesWorkspace(mapping, { code: "READY_EXISTING_WORK" })).toThrow(
      expect.objectContaining({ code: "INVALID_WORKSPACE_TRANSITION" }),
    );
  });

  test("dirty active resume remains active and records READY_EXISTING_WORK", () => {
    const br = new FakeBr();
    const started = startEpicWorkspace(br).mapping;
    const active = transitionIssuesWorkspace(started, { code: "READY" });
    const resumed = transitionIssuesWorkspace(active, {
      code: "READY_EXISTING_WORK",
      statusDigest: "dirty-bytes",
      workspace: { currentCommit: "def456" },
    });

    expect(resumed.state).toBe("active");
    expect(resumed.lastCheck.code).toBe("READY_EXISTING_WORK");
    expect(br.events.filter((event) => event === "helper:start")).toHaveLength(1);
  });

  test("declined, unsafe, and failed cleanup remain pending; only REMOVED finishes", () => {
    const br = new FakeBr();
    const starting = startEpicWorkspace(br).mapping;
    const active = transitionIssuesWorkspace(starting, { code: "READY" });

    for (const code of ["DECLINED", "CLEANUP_UNSAFE", "REMOVE_FAILED", "PARTIAL_REMOVAL"]) {
      expect(transitionIssuesWorkspace(active, { code }).state).toBe("cleanup-pending");
    }
    expect(transitionIssuesWorkspace(active, { code: "PREFLIGHT_SAFE" }).state).toBe("active");
    expect(transitionIssuesWorkspace(active, { code: "REMOVED" }).state).toBe("finished");
    expect(() => transitionIssuesWorkspace(active, { code: "PREFLIGHT_SAFE" })).not.toThrow();
    expect(() => transitionIssuesWorkspace(starting, { code: "PREFLIGHT_SAFE" })).not.toThrow();
    expect(() => transitionIssuesWorkspace(starting, { code: "REMOVED" })).toThrow(
      expect.objectContaining({ code: "INVALID_WORKSPACE_TRANSITION" }),
    );
  });
});
