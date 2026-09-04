/**
 * The activity-model fixture, folded.
 *
 * `fixtures/goalie.*` is emitted by the real binary via `./scripts/make-activity-fixture.sh`,
 * so this is the end-to-end proof that the store can hold a native schema-v6 pursuit — not that a hand-built
 * graph type-checks. The assertions are about SHAPE and DERIVATION, deliberately not about ids:
 * ids are hashes and would make this a test of the hash function.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type GraphProjection,
  NODE_TYPES,
  STATUSES as NODE_STATUSES,
  foldLog,
  isControlNode,
  projectGraph,
  readyFrontier,
} from "@kona/core";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures");
const logText = () => readFileSync(join(FIXTURES, "goalie.mutations.jsonl"), "utf8");
const graphJson = () =>
  JSON.parse(readFileSync(join(FIXTURES, "goalie.graph.json"), "utf8")) as GraphProjection & {
    torn_tail: boolean;
    damaged: unknown[];
  };
const folded = foldLog(logText());
const graph = folded.graph;
const nodes = [...graph.nodes.values()];

function named(name: string) {
  const node = nodes.find((n) => n.name === name);
  if (node === undefined) throw new Error(`the fixture has no node named "${name}"`);
  return node;
}

/** The same lookup, narrowed — every status assertion below is about work. */
function worked(name: string) {
  const node = named(name);
  if (node.status === undefined) throw new Error(`"${name}" is a ${node.type}: no status`);
  return node;
}

describe("the activity-model fixture", () => {
  test("folds clean, with nothing damaged", () => {
    expect(folded.damaged).toEqual([]);
    expect(graph.version).toBeGreaterThan(0);
  });

  test("the checked-in graph is exactly the projection of the checked-in log", () => {
    expect(graphJson()).toEqual({
      ...projectGraph(graph),
      torn_tail: false,
      damaged: [],
    });
  });

  test("every one of the nine node types is present, so a viewer has all nine to draw", () => {
    const present = new Set(nodes.map((node) => node.type));
    for (const type of NODE_TYPES) expect(present).toContain(type);
  });

  test("it exercises the lifecycle states used by this story across its versions", () => {
    // ACROSS versions, not at head: a viewer renders the scrubber too, and the states that
    // matter most — `ready`, `active` — are transient by definition. This successful-send
    // story has no failed or withdrawn behaviour node; `fixtures/thursday.*` covers failure.
    const seen = new Set<string>();
    for (let version = 0; version <= graph.version; version += 1) {
      for (const node of foldLog(logText(), { upToVersion: version }).graph.nodes.values()) {
        if (node.status !== undefined) seen.add(node.status.state);
      }
    }
    expect([...seen].toSorted()).toEqual(
      [...NODE_STATUSES]
        .filter((status) => status !== "failed" && status !== "withdrawn")
        .toSorted(),
    );
  });

  test("no control node ever acquired a status", () => {
    // The store derives them; nothing writes to them. This is the property that would fail
    // silently and everywhere if the cascade or the frontier ever treated one as work.
    for (const node of nodes) {
      // Not "has an inactive status" — has NO status. Under D6 the key is absent, which is
      // the difference between a convention every writer must remember and a compile error.
      if (isControlNode(node.type)) expect(node.status).toBeUndefined();
    }
  });

  test("the frontier holds only work — at EVERY version, never a diamond, a bar or a circle", () => {
    // Over every version rather than at head, because the interesting moments are the ones in
    // the middle: a fork just fired, a decision just routed, a merge just went dead. Those are
    // exactly when a control node is adjacent to the frontier and could leak onto it.
    let offered = 0;
    for (let version = 1; version <= graph.version; version += 1) {
      for (const node of readyFrontier(foldLog(logText(), { upToVersion: version }).graph)) {
        expect(node.status).toBeDefined();
        offered += 1;
      }
    }
    // The loop would pass vacuously on a pursuit that never offered anything.
    expect(offered).toBeGreaterThan(0);
  });

  test("head offers escalation and keeps the roster lock unavailable", () => {
    expect(readyFrontier(graph).map((node) => node.name)).toEqual(["Escalate: no goalie found"]);
    expect(worked("Lock the roster").status.state).toBe("inactive");
    expect(named("Thursday is settled").type).toBe("final");
  });

  test("the fork put its arms on the frontier together, not in a sequence", () => {
    // Find the version that introduced the fork: the evidence prelude deliberately precedes
    // it so irreversible recipient refs resolve against pre-commit state.
    const openingVersion = Array.from({ length: graph.version + 1 }, (_, version) => version).find(
      (version) =>
        foldLog(logText(), { upToVersion: version })
          .graph.nodes.values()
          .some((node) => node.name === "Ask both goalies at once"),
    );
    if (openingVersion === undefined) throw new Error("the fixture never introduces its fork");
    const opening = foldLog(logText(), { upToVersion: openingVersion }).graph;
    expect(
      readyFrontier(opening)
        .map((n) => n.name)
        .toSorted(),
    ).toEqual(["Ask Dana to play in goal", "Ask Pat to play in goal", "Book the pitch"]);
  });

  test("email actions carry irreversible effect metadata and completed outbox records", () => {
    for (const name of ["Ask Dana to play in goal", "Ask Pat to play in goal"]) {
      const node = worked(name);
      expect(["pivot", "compensatable"]).toContain(node.spec.effect_class);
      expect(node.spec.effect).toMatchObject({ channel: "email" });
      expect(node.status.effect_log).toHaveLength(1);
      expect(node.status.effect_log[0]?.outcome).toBe("sent");
    }
  });

  test("Pat is claimed before the outbox completes his email action", () => {
    const states = Array.from({ length: graph.version + 1 }, (_, version) => {
      const atVersion = foldLog(logText(), { upToVersion: version }).graph;
      return [...atVersion.nodes.values()].find((node) => node.name === "Ask Pat to play in goal")
        ?.status?.state;
    });
    expect(states.indexOf("active")).toBeGreaterThan(-1);
    expect(states.indexOf("completed")).toBeGreaterThan(states.indexOf("active"));
  });

  test("ONE dead arm does not kill a merge, because a merge is disjunctive", () => {
    // After Dana goes quiet, her decision has taken its else arm, but Pat is
    // still out there. Nothing downstream of the merge may move. Under v1 this was the
    // `merge: "any"` field — which `isReady` read and the viewer's own comment insisted
    // nothing did. Now it is a node, and the disagreement is not expressible.
    // Derived rather than hardcoded: the version this happens at is a property of the story,
    // and a hardcoded index silently stops testing the right moment the next time a beat is
    // inserted. Find the first version at which Dana's arm is over and Pat's is not.
    const stateAt = (version: number, name: string) =>
      [...foldLog(logText(), { upToVersion: version }).graph.nodes.values()].find(
        (n) => n.name === name,
      )?.status?.state;

    let checked = false;
    for (let version = 0; version <= graph.version; version += 1) {
      const danaOver = stateAt(version, "Dana replies") === "completed";
      const patOver = stateAt(version, "Pat replies") === "completed";
      if (!danaOver || patOver) continue;
      expect(stateAt(version, "Lock the roster")).toBe("inactive");
      checked = true;
    }
    expect(checked).toBe(true);
  });

  test("deadline resolution is native and does not rewrite completed effect work", () => {
    expect(worked("Dana replies").status.state).toBe("completed");
    expect(worked("Pat replies").status.state).toBe("completed");
    expect(worked("Dana replies").status.outcome?.verdict).toBe("timed_out");
    expect(worked("Pat replies").status.outcome?.verdict).toBe("timed_out");
    expect(worked("Lock the roster").status.state).toBe("inactive");
    expect(worked("Escalate: no goalie found").status.state).toBe("ready");

    // Real work that really finished is not rewritten by a withdrawal downstream of it.
    expect(worked("Confirm the pitch in writing").status.state).toBe("completed");

    // And the node it replaced is `terminated`, not `withdrawn`: it was CLAIMED when it was
    // superseded. The cascade would never have written that — `isDroppable` refuses to touch
    // a claimed node — so this is the supersede path, and the two states are what tell them
    // apart in the record.
    expect(worked("Book the pitch").status.state).toBe("terminated");
  });

  test("the final rationale describes the state the graph records", () => {
    const final = folded.records.at(-1);
    expect(final?.rationale.reason_code).toBe("DEADLINE_PASSED");
    expect(final?.rationale.why).toContain("Escalation is ready");
    expect(final?.rationale.why).toContain("roster remains locked");
  });
});
