import { describe, expect, test } from "bun:test";
import type { ActivityNode, Graph, Status } from "@kona/core";
import {
  collapsedStatusSummary,
  collapseForks,
  forkRegion,
  reconcileSelection,
} from "../src/model/collapse.ts";
import { viewEdges } from "../src/model/edges.ts";
import { blockedReason } from "../src/model/blocked.ts";
import { waitStateOf } from "../src/model/waitState.ts";
import { hasRecordedOutput, liveControlInputs } from "../src/panels/Inspector.tsx";
import { canPinVersion } from "../src/panels/Timeline.tsx";

function control(id: string, type: ActivityNode["type"]): ActivityNode {
  return {
    id,
    type,
    name: id,
    spec: {},
    provenance: { created_by_version: 1, supersedes: null, superseded_by: null },
  } as ActivityNode;
}

function action(id: string, state: Status = "inactive"): ActivityNode {
  return {
    id,
    type: "action",
    name: id,
    spec: { instruction: id, inputs: [], outputs: [], effect_class: "pure" },
    status: {
      state,
      outcomes: [],
      outcome: null,
      output: null,
      output_evidence: null,
      conditions: [],
      effect_log: [],
      observed_at_version: 1,
    },
    provenance: { created_by_version: 1, supersedes: null, superseded_by: null },
  };
}

function acceptEvent(id: string, state: Status = "inactive") {
  const node = {
    ...action(id, state),
    type: "accept_event" as const,
    spec: {
      instruction: `wait for ${id}`,
      inputs: [],
      outputs: [],
      effect_class: "pure" as const,
      deadline: { at: "2026-09-05T00:00:00.000Z" },
      match: {
        kind: "event" as const,
        conditions: [{ kind: "reply", on: "satisfied" as const }],
        memory: true,
      },
    },
  } as unknown as Extract<ActivityNode, { type: "accept_event" }>;
  return node;
}

function graph(nodes: ActivityNode[], edges: Graph["edges"]): Graph {
  return {
    schema_version: 6,
    version: 1,
    nodes: new Map(nodes.map((node) => [node.id, node])),
    edges,
  };
}

describe("activity-model viewer", () => {
  test("an accept_event reads its timeout route from the following decision", () => {
    const event = acceptEvent("reply");
    const value = graph(
      [event, control("route", "decision"), action("continue"), action("escalate")],
      [
        { from: "reply", to: "route" },
        { from: "route", to: "continue", guard: "else" },
        { from: "route", to: "escalate", guard: { on: "timeout" } },
      ],
    );

    expect(
      waitStateOf(value, event, new Map(), Date.parse("2026-09-04T00:00:00Z"))?.timeoutTarget,
    ).toBe("escalate");
    expect(waitStateOf(value, action("plain"), new Map(), 0)).toBeNull();

    const fallback = graph(
      [event, control("route", "decision"), action("continue"), action("accepted")],
      [
        { from: "reply", to: "route" },
        { from: "route", to: "accepted", guard: { on: "accept" } },
        { from: "route", to: "continue", guard: "else" },
      ],
    );
    expect(waitStateOf(fallback, event, new Map(), 0)?.timeoutTarget).toBe("continue");
  });

  test("a joined fork collapses through its immediate post-dominator and redirects flow", () => {
    const value = graph(
      [
        control("start", "initial"),
        control("fan", "fork"),
        action("left", "completed"),
        action("right"),
        control("sync", "join"),
        action("after"),
      ],
      [
        { from: "start", to: "fan" },
        { from: "fan", to: "left" },
        { from: "fan", to: "right" },
        { from: "left", to: "sync" },
        { from: "right", to: "sync" },
        { from: "sync", to: "after" },
      ],
    );

    expect(forkRegion(value, "fan")).toEqual(new Set(["fan", "left", "right", "sync"]));
    const collapsed = collapseForks(value, new Set());
    expect([...collapsed.graph.nodes.keys()]).toEqual(["start", "fan", "after"]);
    expect(collapsed.graph.edges.map(({ from, to }) => `${from}>${to}`)).toEqual([
      "start>fan",
      "fan>after",
    ]);
    expect(collapsed.regions.get("fan")?.counts.get("completed")).toBe(1);
    expect(collapseForks(value, new Set(["fan"])).graph).toBe(value);
  });

  test("collapsed boundary edges retain original control-node satisfaction", () => {
    const value = graph(
      [
        control("start", "initial"),
        control("fan", "fork"),
        action("left", "completed"),
        action("right"),
        control("sync", "join"),
        action("after"),
      ],
      [
        { from: "start", to: "fan" },
        { from: "fan", to: "left" },
        { from: "fan", to: "right" },
        { from: "left", to: "sync" },
        { from: "right", to: "sync" },
        { from: "sync", to: "after" },
      ],
    );
    const collapsed = collapseForks(value, new Set());
    const boundary = viewEdges(collapsed.graph, collapsed.edgeStates).find(
      (edge) => edge.from === "fan" && edge.to === "after",
    );
    expect(boundary?.satisfied).toBe(false);
    expect(boundary?.dead).toBe(false);
    expect(viewEdges(collapsed.graph).find((edge) => edge.to === "after")?.satisfied).toBe(true);
  });

  test("collapsed boundary edges retain original decision deadness", () => {
    const event = acceptEvent("reply", "completed");
    event.status.outcomes = [{ verdict: "accept", evidence_ref: "mail:reply", at_version: 1 }];
    event.status.outcome = event.status.outcomes[0] ?? null;
    const value = graph(
      [
        control("start", "initial"),
        control("fan", "fork"),
        event,
        action("other", "completed"),
        control("route", "decision"),
        action("accepted"),
        action("fallback"),
        control("end", "merge"),
      ],
      [
        { from: "start", to: "fan" },
        { from: "fan", to: "reply" },
        { from: "fan", to: "other" },
        { from: "reply", to: "route" },
        { from: "other", to: "route" },
        { from: "route", to: "accepted", guard: { on: "accept" } },
        { from: "route", to: "fallback", guard: "else" },
        { from: "accepted", to: "end" },
        { from: "fallback", to: "end" },
      ],
    );
    const collapsed = collapseForks(value, new Set());
    const boundary = viewEdges(collapsed.graph, collapsed.edgeStates).find(
      (edge) => edge.from === "fan" && edge.to === "fallback",
    );
    expect(boundary?.dead).toBe(true);
    expect(viewEdges(collapsed.graph).find((edge) => edge.to === "fallback")?.dead).toBe(false);
  });

  test("decision edges use core deadness and retain else/count descriptions", () => {
    const event = acceptEvent("reply", "completed");
    event.status.outcomes = [{ verdict: "accept", evidence_ref: "mail:reply", at_version: 1 }];
    event.status.outcome = event.status.outcomes[0] ?? null;
    const value = graph(
      [event, control("route", "decision"), action("accepted"), action("fallback")],
      [
        { from: "reply", to: "route" },
        { from: "route", to: "accepted", guard: { on: "accept" } },
        { from: "route", to: "fallback", guard: "else" },
      ],
    );
    const fallbackEdge = viewEdges(value).find((edge) => edge.to === "fallback");
    expect(fallbackEdge?.dead).toBe(true);
    expect(fallbackEdge?.label).toBe("else fallback");
    const fallback = value.nodes.get("fallback");
    if (fallback === undefined) throw new Error("fallback node missing");
    const blocked = blockedReason(value, fallback);
    expect(blocked?.causes[0]?.wants).toBe("else fallback");
    expect(blocked?.causes[0]?.text).toContain("edge needs else fallback");

    value.edges[1] = {
      from: "route",
      to: "accepted",
      guard: { count: { verdict: "confirmed", attrs: { role: "goalie" } }, op: ">=", n: 2 },
    };
    expect(viewEdges(value).find((edge) => edge.to === "accepted")?.label).toBe(
      "count confirmed role=goalie >= 2",
    );
    const accepted = value.nodes.get("accepted");
    if (accepted === undefined) throw new Error("accepted node missing");
    expect(blockedReason(value, accepted)?.causes[0]?.wants).toBe(
      "count confirmed role=goalie >= 2",
    );
  });

  test("collapse summaries exclude superseded work and name every terminal status", () => {
    const completed = action("completed", "completed");
    const failed = action("failed", "failed");
    const withdrawn = action("withdrawn", "withdrawn");
    const terminated = action("terminated", "terminated");
    const retired = action("retired", "completed");
    retired.provenance.superseded_by = "completed";
    const value = graph(
      [control("fan", "fork"), completed, failed, withdrawn, terminated, retired],
      [completed, failed, withdrawn, terminated, retired].map((node) => ({
        from: "fan",
        to: node.id,
      })),
    );
    const collapsed = collapseForks(value, new Set());
    const region = collapsed.regions.get("fan");
    if (region === undefined) throw new Error("fork did not collapse");
    expect(collapsedStatusSummary(region)).toBe(
      "4 activities · 1 completed · 1 failed · 1 withdrawn · 1 terminated",
    );
    expect(reconcileSelection("failed", collapsed)).toBe("fan");
    expect(reconcileSelection("missing", collapsed)).toBeNull();
  });

  test("control details ignore superseded inputs and null outputs", () => {
    const old = action("old", "completed");
    old.provenance.superseded_by = "new";
    const replacement = action("new", "completed");
    const join = control("sync", "join");
    const value = graph(
      [old, replacement, join],
      [
        { from: "old", to: "sync" },
        { from: "new", to: "sync" },
      ],
    );
    expect(liveControlInputs(value, "sync").map((edge) => edge.from)).toEqual(["new"]);
    expect(hasRecordedOutput(join)).toBe(false);
    expect(hasRecordedOutput(action("empty"))).toBe(false);
  });

  test("timeline pins cannot point beyond the scrubbed version", () => {
    expect(canPinVersion(4, 4)).toBe(true);
    expect(canPinVersion(3, 4)).toBe(true);
    expect(canPinVersion(5, 4)).toBe(false);
  });

  test("an unjoined fork collapses through each arm terminator", () => {
    const value = graph(
      [
        control("fan", "fork"),
        action("left"),
        action("right"),
        control("a-end", "flow_final"),
        control("b-end", "flow_final"),
      ],
      [
        { from: "fan", to: "left" },
        { from: "fan", to: "right" },
        { from: "left", to: "a-end" },
        { from: "right", to: "b-end" },
      ],
    );
    expect(forkRegion(value, "fan")).toEqual(new Set(["fan", "left", "right", "a-end", "b-end"]));
  });
});
