import { describe, expect, test } from "bun:test";
import { SCHEMA_VERSION, emptyGraph, normalizeBatch, parseBatch } from "../src/index.ts";
import { seeded, task, wait, resolveSlugs, nid } from "./fixtures.ts";
import type { AuthoredOp, Graph } from "../src/index.ts";

function normalize(graph: Graph, ops: AuthoredOp[]) {
  const parsed = parseBatch(ops);
  if (!parsed.ok) throw new Error(`fixture failed the parser: ${parsed.rejection.message}`);
  return normalizeBatch(graph, resolveSlugs(graph, parsed.value) as AuthoredOp[], "t", graph.version + 1);
}

function expectRefusal(graph: Graph, ops: AuthoredOp[], reason: string): void {
  const result = normalize(graph, ops);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.rejection.reason).toBe(reason);
}

const EMPTY = emptyGraph(SCHEMA_VERSION);

describe("id minting", () => {
  test("mints an id under the pursuit's prefix, and reports it on the committed op", () => {
    const result = normalize(EMPTY, [task("Ask Dana to play Thursday")]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const op = result.value[0];
    expect(op?.op).toBe("add_node");
    const id = op?.op === "add_node" ? op.id : "";
    // `t` is the prefix these fixtures init with. The four characters after it are the hash,
    // so the assertion is on the SHAPE — the value is checked for stability below.
    expect(id).toMatch(/^t-[0-9a-z]{4}$/);
  });

  test("is deterministic, which is what lets fold and mutate agree", () => {
    // fold never mints: it replays the ids the log already carries. That only holds because
    // minting the same batch twice produces the same ids.
    const once = normalize(EMPTY, [task("Ask Dana to play Thursday")]);
    const twice = normalize(EMPTY, [task("Ask Dana to play Thursday")]);
    if (!once.ok || !twice.ok) throw new Error("unreachable");
    expect(once.value).toEqual(twice.value);
  });

  test("the id carries no trace of the label, so correcting one does not orphan the other", () => {
    const result = normalize(EMPTY, [task("Ask Dana to play Thursday")]);
    if (!result.ok) throw new Error("unreachable");
    const id = result.value[0]?.op === "add_node" ? result.value[0].id : "";
    for (const word of ["ask", "dana", "play", "thursday"]) expect(id).not.toContain(word);
  });

  test("two identical labels in one batch get distinct ids", () => {
    const result = normalize(EMPTY, [task("Ask Dana"), task("Ask Dana")]);
    if (!result.ok) throw new Error("unreachable");
    const ids = result.value.flatMap((op) => (op.op === "add_node" ? [op.id] : []));
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  test("minting avoids ids already committed", () => {
    const head = seeded([task("Ask Dana")]);
    const result = normalize(head, [task("Ask Dana")]);
    if (!result.ok) throw new Error("unreachable");
    const id = result.value[0]?.op === "add_node" ? result.value[0].id : "";
    expect([...head.nodes.keys()]).not.toContain(id);
  });

  test("a label with nothing in the id alphabet still mints", () => {
    // A slug had to fall back to a literal "node" here; a hash does not care.
    const result = normalize(EMPTY, [task("— — —")]);
    if (!result.ok) throw new Error("unreachable");
    const id = result.value[0]?.op === "add_node" ? result.value[0].id : "";
    expect(id).toMatch(/^t-[0-9a-z]{4}$/);
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
    const minted = result.value.flatMap((op) => (op.op === "add_node" ? [op.id] : []));
    expect(result.value[2]).toEqual({
      op: "add_edge",
      from: String(minted[0]),
      to: String(minted[1]),
    });
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
    // Every `$0` here means the first node, so they all have to land on the id it minted.
    const sendInvite = result.value[0]?.op === "add_node" ? result.value[0].id : "";
    expect(awaitedSpec?.on_timeout).toBe(sendInvite);
    expect(awaitedSpec?.deadline).toEqual({ after: sendInvite, duration: "48h" });
    expect(undo?.op === "add_node" ? undo.spec.compensates : null).toBe(sendInvite);
  });

  test("resolves obviated_if.wait", () => {
    const result = normalize(EMPTY, [
      task("Escalate"),
      wait("Quorum", { on_timeout: "$0" }),
      task("Chase", { obviated_if: { wait: "$1", satisfied: true } }),
    ]);
    if (!result.ok) throw new Error("unreachable");
    const chase = result.value[2];
    const quorum = result.value[1]?.op === "add_node" ? result.value[1].id : "";
    expect(chase?.op === "add_node" ? chase.spec.obviated_if : null).toEqual({
      wait: quorum,
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
    const head = seeded([task("A")]);
    const result = normalize(head, [{ op: "supersede_node", node: "a" }]);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value[0]).toEqual({ op: "supersede_node", node: nid(head, "a") });
  });
});
