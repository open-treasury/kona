/**
 * The plugin's op catalogue must be accepted by the real parser.
 *
 * §6.9 is emphatic that the §6.2 catalogue ships into the plan prompt **verbatim**, because
 * a paraphrase produced four stuck-gate defects. But the spec writes ops in a shorthand —
 * `add_node(scope, spec)` — that is not parseable JSON, so "verbatim" cannot mean copying
 * that. It has to mean the shape the CLI actually accepts.
 *
 * Which leaves the documentation free to drift from the parser, silently, in the one place
 * where drift produces a confident model writing ops that are rejected on arrival. So every
 * JSON example in the skill files is extracted here and run through `parseBatch`. If the
 * schema changes and the prompt does not, this fails.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OP_KINDS, REASON_CODES, STATUSES, VERDICTS, parseBatch } from "@kona/core";

const PLUGIN = join(import.meta.dir, "..", "..", "..", "plugin");

function read(...parts: string[]): string {
  return readFileSync(join(PLUGIN, ...parts), "utf8");
}

/**
 * Pull every top-level `{...}` out of the fenced blocks, dropping `//` comments.
 *
 * One scanner does both, and it tracks string state — otherwise a `//` inside a value, or
 * a brace inside a quoted string, would split an object in the wrong place and the test
 * would fail on documentation that is perfectly correct.
 */
function jsonObjectsIn(markdown: string): string[] {
  const fences = [...markdown.matchAll(/```jsonc?\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  const objects: string[] = [];

  for (const source of fences) {
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    let cleaned = "";

    for (let i = 0; i < source.length; i++) {
      const char = source[i] ?? "";

      if (inString) {
        cleaned += char;
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }

      if (char === '"') {
        inString = true;
        cleaned += char;
        continue;
      }

      if (char === "/" && source[i + 1] === "/") {
        const nextBreak = source.indexOf("\n", i);
        i = nextBreak === -1 ? source.length : nextBreak - 1;
        continue;
      }

      cleaned += char;
      if (char === "{") {
        if (depth === 0) start = cleaned.length - 1;
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          objects.push(cleaned.slice(start));
          start = -1;
        }
      }
    }
  }

  return objects;
}

/** Only the op-shaped ones; the skills also show deadlines, match blocks and rationales. */
function opsIn(markdown: string): { source: string; parsed: unknown }[] {
  return jsonObjectsIn(markdown).flatMap((source) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      return [];
    }
    const op = (parsed as { op?: unknown }).op;
    return typeof op === "string" ? [{ source, parsed }] : [];
  });
}

const PLAN = read("skills", "plan", "SKILL.md");
const RUN = read("skills", "run", "SKILL.md");
const EXECUTOR = read("agents", "kona-executor.md");

describe("every op the plan skill documents is accepted by the parser", () => {
  const documented = opsIn(PLAN);

  test("the catalogue is actually there — extraction did not silently find nothing", () => {
    expect(documented.length).toBeGreaterThanOrEqual(6);
  });

  test("all six ops are documented, and no seventh is", () => {
    const kinds = new Set(documented.map((entry) => (entry.parsed as { op: string }).op));
    expect([...kinds].toSorted()).toEqual([...OP_KINDS].toSorted());
  });

  test.each(documented.map((entry) => [(entry.parsed as { op: string }).op, entry] as const))(
    "the documented %s parses",
    (_kind, entry) => {
      const result = parseBatch([entry.parsed]);
      if (!result.ok) {
        throw new Error(`the plan skill documents an op the CLI rejects:\n${entry.source}\n\n${result.rejection.message}`);
      }
      expect(result.ok).toBe(true);
    },
  );
});

describe("the ops the other skills show are accepted too", () => {
  test("extraction found ops in both — an empty test.each passes silently", () => {
    expect(opsIn(RUN).length).toBeGreaterThan(0);
    expect(opsIn(EXECUTOR).length).toBeGreaterThan(0);
  });

  test.each(opsIn(RUN).map((entry) => [(entry.parsed as { op: string }).op, entry] as const))(
    "the run skill's %s parses",
    (_kind, entry) => {
      const result = parseBatch([entry.parsed]);
      if (!result.ok) throw new Error(`${entry.source}\n\n${result.rejection.message}`);
      expect(result.ok).toBe(true);
    },
  );

  test.each(opsIn(EXECUTOR).map((entry) => [(entry.parsed as { op: string }).op, entry] as const))(
    "the executor's %s parses",
    (_kind, entry) => {
      const result = parseBatch([entry.parsed]);
      if (!result.ok) throw new Error(`${entry.source}\n\n${result.rejection.message}`);
      expect(result.ok).toBe(true);
    },
  );
});

describe("the vocabularies the prompt quotes are the real ones", () => {
  test("every status is listed, and nothing that is not a status", () => {
    // The prompt renders them as `·`-separated inline code in a table row.
    const row = /\| `status` \|([^|]+)\|/.exec(PLAN)?.[1] ?? "";
    const listed = [...row.matchAll(/`([a-z_]+)`/g)].flatMap((m) => m[1] ?? []);
    expect(listed.toSorted()).toEqual([...STATUSES].toSorted());
  });

  test("every verdict is listed — including the four a human wait returns", () => {
    const row = /\| `verdict` \|([^|]+)\|/.exec(PLAN)?.[1] ?? "";
    const listed = [...row.matchAll(/`([a-z_]+)`/g)].flatMap((m) => m[1] ?? []);
    expect(listed.toSorted()).toEqual([...VERDICTS].toSorted());
  });

  test("every reason code is listed", () => {
    for (const code of REASON_CODES) expect(PLAN).toContain(code);
  });

  test("the forbidden opcodes are named as forbidden", () => {
    for (const forbidden of ["delete_node", "rollback", "replace_graph"]) {
      expect(PLAN).toContain(forbidden);
      expect(parseBatch([{ op: forbidden, node: "a" }]).ok).toBe(false);
    }
  });
});

describe("the rules the probes paid for are still in the prompt", () => {
  test("the premise check comes before authoring", () => {
    // 2 of 4 briefs referenced entities that did not exist and produced approvable graphs.
    expect(PLAN.indexOf("Check the premises first")).toBeGreaterThan(-1);
    expect(PLAN.indexOf("Check the premises first")).toBeLessThan(PLAN.indexOf("op catalogue"));
  });

  test("edge direction is stated as a dependency, not as time", () => {
    expect(PLAN).toContain("B REQUIRES A");
    expect(PLAN).toContain("Y needs X");
  });

  test("numbering is called out as not creating sequence", () => {
    expect(PLAN).toContain("Numbering your steps does not create sequence");
  });

  test("the inputs/outputs pairing carries its measurement", () => {
    expect(PLAN).toContain("0 of 8");
    expect(PLAN).toContain("10 of 10");
  });

  test("the run skill states the one gate, and states it as the only one", () => {
    expect(RUN).toContain("THE ONE GATE");
    expect(RUN).toContain("recipient the graph has\n> never seen");
    expect(RUN).toContain("invent");
  });

  test("the executor's refusal_reason is mandatory and the three verdicts are exact", () => {
    for (const verdict of ["EXECUTED", "COMPOSED", "REFUSED"]) expect(EXECUTOR).toContain(verdict);
    expect(EXECUTOR).toContain("refusal_reason");
    expect(EXECUTOR).toContain("mandatory");
  });

  test("the executor is told the deadline is never disclosed", () => {
    expect(EXECUTOR).toContain("disclosure.withheld");
    expect(EXECUTOR).toContain("not a promise");
  });
});

describe("the plugin is additive and trivially removable (§6.9)", () => {
  test("it declares no git hooks and no daemon", () => {
    const hooks = JSON.parse(read("hooks", "hooks.json")) as {
      hooks: Record<string, { hooks: { type: string; command: string }[] }[]>;
    };
    expect(Object.keys(hooks.hooks)).toEqual(["SessionStart"]);
    for (const group of Object.values(hooks.hooks).flat()) {
      for (const hook of group.hooks) {
        expect(hook.type).toBe("command");
        // Relocatable: a hard-coded path works in a checkout and nowhere else.
        expect(hook.command).toContain("CLAUDE_PLUGIN_ROOT");
      }
    }
  });

  test("the SessionStart hook does not write — it reports", () => {
    // Firing timeouts unprompted at every session start is a commit nobody asked for.
    const script = read("scripts", "session-start.sh");
    expect(script).toContain("resume --dry-run");
    expect(script).not.toMatch(/kona.*mutate/);
  });

  test("the loop that sends things cannot be auto-invoked", () => {
    expect(read("skills", "run", "SKILL.md")).toContain("disable-model-invocation: true");
  });

  test("the manifest names the plugin `kona`, which is what namespaces the skills", () => {
    const manifest = JSON.parse(read(".claude-plugin", "plugin.json")) as { name: string };
    expect(manifest.name).toBe("kona");
  });
});
