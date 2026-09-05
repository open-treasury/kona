import { describe, expect, test } from "bun:test";
import { SCHEMA_VERSION, foldLog, projectGraph, splitLogLines } from "../src/index.ts";
import { logOf, record } from "./fixtures.ts";

const GENESIS = record(0, []);
const ADD_A = record(1, [
  {
    op: "add_node",
    id: "ask-dana",
    name: "Ask Dana",
    type: "action",
    spec: {
      instruction: "email dana",
      inputs: [],
      outputs: [{ name: "reply", type: "string" }],
      effect_class: "pure",
    },
  },
]);
const ADD_B = record(2, [
  {
    op: "add_node",
    id: "chase-dana",
    name: "Chase Dana",
    type: "action",
    spec: { instruction: "chase", inputs: [], outputs: [], effect_class: "pure" },
  },
  { op: "add_edge", from: "ask-dana", to: "chase-dana" },
]);

const LOG = logOf(GENESIS, ADD_A, ADD_B);

describe("fold is deterministic", () => {
  test("folding twice yields an identical graph, byte for byte", () => {
    const first = JSON.stringify(projectGraph(foldLog(LOG).graph));
    const second = JSON.stringify(projectGraph(foldLog(LOG).graph));
    expect(second).toBe(first);
  });

  test("activity order is insertion order and edge order is append order", () => {
    const projection = projectGraph(foldLog(LOG).graph);
    expect(projection.nodes.map((n) => n.id)).toEqual(["ask-dana", "chase-dana"]);
    expect(projection.edges).toEqual([{ from: "ask-dana", to: "chase-dana" }]);
  });

  test("head version is the v of the last record folded", () => {
    expect(foldLog(LOG).graph.version).toBe(2);
    expect(foldLog(logOf(GENESIS)).graph.version).toBe(0);
  });

  test("the fold stamps the schema version it was asked for", () => {
    expect(foldLog(LOG).graph.schema_version).toBe(SCHEMA_VERSION);
    expect(foldLog(LOG, { schemaVersion: 4 }).graph.schema_version).toBe(4);
  });

  test("an empty log folds to an empty graph rather than throwing", () => {
    const folded = foldLog("");
    expect(folded.graph.nodes.size).toBe(0);
    expect(folded.records).toHaveLength(0);
    expect(folded.damaged).toEqual([]);
  });
});

describe("line handling", () => {
  test("strips one trailing \\r, so a CRLF checkout folds identically", () => {
    const crlf = LOG.replace(/\n/g, "\r\n");
    expect(JSON.stringify(projectGraph(foldLog(crlf).graph))).toBe(
      JSON.stringify(projectGraph(foldLog(LOG).graph)),
    );
    expect(foldLog(crlf).damaged).toEqual([]);
  });

  test("blank lines carry no data and are skipped", () => {
    const padded = `${logOf(GENESIS)}\n   \n${logOf(ADD_A)}`;
    expect(foldLog(padded).damaged).toEqual([]);
    expect(foldLog(padded).graph.version).toBe(1);
  });

  test("only a TRAILING carriage return is stripped; one mid-line is data", () => {
    expect(splitLogLines("a\rb\r")).toEqual([{ line: 1, text: "a\rb" }]);
  });

  test("line numbers are 1-based and count blank lines, so they match an editor", () => {
    expect(splitLogLines("a\n\nb\n")).toEqual([
      { line: 1, text: "a" },
      { line: 3, text: "b" },
    ]);
  });
});

describe("a torn final line is the expected shape of a crash", () => {
  test("is dropped, reported, and never guessed at", () => {
    const torn = `${LOG}{"v":3,"schema_ver`;
    const folded = foldLog(torn);
    expect(folded.torn_tail).toBe('{"v":3,"schema_ver');
    expect(folded.damaged).toEqual([]);
    expect(folded.graph.version).toBe(2);
  });

  test("everything before it still folds", () => {
    const folded = foldLog(`${LOG}{"v":3,`);
    expect(folded.graph.nodes.size).toBe(2);
    expect(folded.records).toHaveLength(3);
  });

  test("a complete log has no torn tail", () => {
    expect(foldLog(LOG).torn_tail).toBeNull();
  });

  test("unparseable JSON reports the parser's own complaint, not a generic one", () => {
    const folded = foldLog(`${logOf(GENESIS)}{"v":1,,}\n${logOf(ADD_A)}`);
    expect(folded.damaged[0]?.reason).toBe("UNPARSEABLE_RECORD");
    expect(folded.damaged[0]?.detail.toLowerCase()).toContain("json");
  });

  test("a torn line that is not last is damage, not a tear", () => {
    const folded = foldLog(`${logOf(GENESIS)}{"v":1,\n${logOf(ADD_A)}`);
    expect(folded.torn_tail).toBeNull();
    expect(folded.damaged[0]?.reason).toBe("UNPARSEABLE_RECORD");
    expect(folded.damaged[0]?.line).toBe(2);
    expect(folded.damaged).toHaveLength(1);
  });
});

describe("the loader is partial-tolerant: it reports rather than dies", () => {
  test("a line that parses as JSON but fails the schema is reported", () => {
    const folded = foldLog(`${logOf(GENESIS)}{"v":1,"nope":true}\n${logOf(ADD_A)}`);
    expect(folded.damaged[0]?.reason).toBe("UNPARSEABLE_RECORD");
    // `path: message`, semicolon-separated — the shape an operator greps.
    expect(folded.damaged[0]?.detail).toContain("schema_version: ");
  });

  test("a version gap is reported rather than silently swallowed", () => {
    const folded = foldLog(logOf(GENESIS, record(7, [])));
    expect(folded.damaged[0]?.reason).toBe("VERSION_DISCONTINUITY");
    expect(folded.damaged[0]?.detail).toBe("expected v=1, found v=7");
  });

  test("a record whose ops cannot apply is reported with the op's own reason", () => {
    const folded = foldLog(
      logOf(
        GENESIS,
        record(1, [{ op: "set_status", node: "ghost", status: "completed", evidence_ref: "e" }]),
      ),
    );
    expect(folded.damaged[0]?.reason).toBe("UNKNOWN_ACTIVITY");
    expect(folded.graph.version).toBe(0);
  });

  test("a missing genesis record is a discontinuity, not a crash", () => {
    expect(foldLog(logOf(ADD_A)).damaged[0]?.reason).toBe("VERSION_DISCONTINUITY");
  });
});

describe("read-only time travel", () => {
  test("upToVersion stops the fold there", () => {
    expect(foldLog(LOG, { upToVersion: 1 }).graph.version).toBe(1);
    expect(foldLog(LOG, { upToVersion: 1 }).graph.nodes.size).toBe(1);
  });

  test("version 0 is the empty graph the pursuit started from", () => {
    expect(foldLog(LOG, { upToVersion: 0 }).graph.nodes.size).toBe(0);
  });

  test("a version beyond head folds everything, rather than erroring", () => {
    expect(foldLog(LOG, { upToVersion: 99 }).graph.version).toBe(2);
  });

  test("it removes nothing: the same log still folds to head on the next read", () => {
    foldLog(LOG, { upToVersion: 0 });
    expect(foldLog(LOG).graph.version).toBe(2);
  });
});
