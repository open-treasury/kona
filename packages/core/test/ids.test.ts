import { describe, expect, test } from "bun:test";
import { MAX_NODE_ID_LENGTH, isValidNodeId, mintNodeId, slugify } from "../src/index.ts";

describe("slugify", () => {
  test("reduces a human label to the id alphabet", () => {
    expect(slugify("Ask Dana to play Thursday")).toBe("ask-dana-to-play-thursday");
  });

  test("collapses runs of separators and trims the ends", () => {
    expect(slugify("  --Ask   Dana!! ")).toBe("ask-dana");
  });

  test("never emits '/', which would alias two nodes into one reply address", () => {
    expect(slugify("goalie/dana")).toBe("goalie-dana");
  });

  test("is total: a label with no usable characters still yields a legal id", () => {
    expect(slugify("!!!")).toBe("node");
    expect(slugify("")).toBe("node");
  });

  test("truncates without leaving a trailing separator", () => {
    const slug = slugify(`${"a".repeat(MAX_NODE_ID_LENGTH)} tail`);
    expect(slug.length).toBeLessThanOrEqual(MAX_NODE_ID_LENGTH);
    expect(slug.endsWith("-")).toBe(false);
    expect(isValidNodeId(slug)).toBe(true);
  });

  test("every slug it produces is a valid id", () => {
    for (const label of ["Ask Dana", "  ", "9 lives", "-lead-", "ÜBER goalie", "a/b/c"]) {
      expect(isValidNodeId(slugify(label))).toBe(true);
    }
  });
});

describe("isValidNodeId", () => {
  test.each([
    ["goalie-dana", true],
    ["a", true],
    ["9lives", true],
    ["", false],
    ["-leading", false],
    ["goalie/dana", false],
    ["Goalie", false],
    ["goalie_dana", false],
    ["a".repeat(MAX_NODE_ID_LENGTH), true],
    ["a".repeat(MAX_NODE_ID_LENGTH + 1), false],
  ])("%s -> %s", (id, expected) => {
    expect(isValidNodeId(id)).toBe(expected);
  });
});

describe("mintNodeId", () => {
  test("uses the plain slug when it is free", () => {
    expect(mintNodeId("Ask Dana", new Set())).toBe("ask-dana");
  });

  test("disambiguates against ids already taken", () => {
    expect(mintNodeId("Ask Dana", new Set(["ask-dana"]))).toBe("ask-dana-2");
    expect(mintNodeId("Ask Dana", new Set(["ask-dana", "ask-dana-2"]))).toBe("ask-dana-3");
  });

  test("keeps the disambiguated id inside the length limit", () => {
    const label = "x".repeat(MAX_NODE_ID_LENGTH);
    const taken = new Set([slugify(label)]);
    const minted = mintNodeId(label, taken);
    expect(minted.length).toBeLessThanOrEqual(MAX_NODE_ID_LENGTH);
    expect(isValidNodeId(minted)).toBe(true);
  });

  test("is deterministic in (label, taken), which is what lets fold and mutate agree", () => {
    const taken = new Set(["ask-dana"]);
    expect(mintNodeId("Ask Dana", taken)).toBe(mintNodeId("Ask Dana", taken));
  });
});
