import { describe, expect, test } from "bun:test";
import { SCHEMA_VERSION, emptyGraph, normalizeBatch, parseBatch } from "../src/index.ts";
import { seeded, task, wait } from "./fixtures.ts";
import type { AuthoredOp, Graph } from "../src/index.ts";

function normalize(graph: Graph, ops: AuthoredOp[]) {
  const parsed = parseBatch(ops);
  if (!parsed.ok) throw new Error(`fixture failed the parser: ${parsed.rejection.message}`);
  return normalizeBatch(graph, parsed.value);
}

function expectRefusal(graph: Graph, ops: AuthoredOp[], reason: string): void {
  const result = normalize(graph, ops);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.rejection.reason).toBe(reason);
}

const EMPTY = emptyGraph(SCHEMA_VERSION);

describe("id minting", () => {
  test("mints from the label and reports it on the committed op", () => {
    const result = normalize(EMPTY, [task("Ask Dana to play Thursday")]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const op = result.value[0];
    expect(op?.op).toBe("add_node");
    expect(op?.op === "add_node" ? op.id : null).toBe("ask-dana-to-play-thursday");
  });

  test("two identical labels in one batch get distinct ids", () => {
    const result = normalize(EMPTY, [task("Ask Dana"), task("Ask Dana")]);
    if (!result.ok) throw new Error("unreachable");
    const ids = result.value.flatMap((op) => (op.op === "add_node" ? [op.id] : []));
    expect(ids).toEqual(["ask-dana", "ask-dana-2"]);
  });

  test("minting avoids ids already committed", () => {
    const result = normalize(seeded([task("Ask Dana")]), [task("Ask Dana")]);
    if (!result.ok) throw new Error("unreachable");
    const op = result.value[0];
    expect(op?.op === "add_node" ? op.id : null).toBe("ask-dana-2");
  });
});

describe("$N resolution", () => {
  test("resolves an edge to ids minted earlier in the same batch", () => {
    const result = normalize(EMPTY, [
      task("Ask Dana"),
      task("Chase Dana"),
      { op: "add_edge", from: "$0", to: "$1" },
    ]);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value[2]).toEqual({ op: "add_edge", from: "ask-dana", to: "chase-dana" });
  });

  test("resolves refs inside a node spec, not only at the top level", () => {
    const result = normalize(EMPTY, [
      task("Send invite"),
      wait("Await reply", { on_timeout: "$0", deadline: { after: "$0", duration: "48h" } }),
      task("Undo invite", { compensates: "$0" }),
    ]);
    if (!result.ok) throw new Error("unreachable");
    const awaited = result.value[1];
    const undo = result.value[2];
    const awaitedSpec = awaited?.op === "add_node" ? awaited.spec : null;
    expect(awaitedSpec?.on_timeout).toBe("send-invite");
    expect(awaitedSpec?.deadline).toEqual({ after: "send-invite", duration: "48h" });
    expect(undo?.op === "add_node" ? undo.spec.compensates : null).toBe("send-invite");
  });

  test("resolves obviated_if.wait", () => {
    const result = normalize(EMPTY, [
      task("Escalate"),
      wait("Quorum", { on_timeout: "$0" }),
      task("Chase", { obviated_if: { wait: "$1", satisfied: true } }),
    ]);
    if (!result.ok) throw new Error("unreachable");
    const chase = result.value[2];
    expect(chase?.op === "add_node" ? chase.spec.obviated_if : null).toEqual({
      wait: "quorum",
      satisfied: true,
    });
  });

  test("rejects a forward reference", () => {
    expectRefusal(EMPTY, [{ op: "add_edge", from: "$1", to: "$0" }, task("A")], "FORWARD_REF");
  });

  test("rejects a self reference", () => {
    expectRefusal(EMPTY, [task("A", { compensates: "$0" })], "FORWARD_REF");
  });

  test("rejects a ref to an op that minted no id", () => {
    expectRefusal(
      EMPTY,
      [
        task("A"),
        { op: "set_status", node: "$0", status: "done", evidence_ref: "e" },
        { op: "add_edge", from: "$1", to: "$0" },
      ],
      "UNRESOLVED_REF",
    );
  });

  test("rejects a committed id that does not exist — never invent an id", () => {
    expectRefusal(EMPTY, [{ op: "set_status", node: "ghost", status: "done", evidence_ref: "e" }], "UNKNOWN_NODE");
    expectRefusal(seeded([task("A")]), [{ op: "add_edge", from: "a", to: "ghost" }], "UNKNOWN_NODE");
    expectRefusal(seeded([task("A")]), [{ op: "supersede_node", node: "a", by: "ghost" }], "UNKNOWN_NODE");
    expectRefusal(EMPTY, [task("A", { compensates: "ghost" })], "UNKNOWN_NODE");
  });

  test("a supersede with no replacement stays shaped that way", () => {
    const result = normalize(seeded([task("A")]), [{ op: "supersede_node", node: "a" }]);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value[0]).toEqual({ op: "supersede_node", node: "a" });
  });
});
