import { describe, expect, test } from "bun:test";
import {
  MAX_NODE_ID_LENGTH,
  isValidNodeId,
  isValidPrefix,
  mintNodeId,
  slugify,
} from "../src/index.ts";

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
  test("every id in a pursuit opens with the same prefix", () => {
    const taken = new Set<string>();
    const ids = ["Ask Dana", "Read the ERP tables", "Build the schedule"].map((name, index) =>
      mintNodeId("acme", name, 1, index, taken),
    );
    for (const id of ids) expect(id.startsWith("acme-")).toBe(true);
  });

  test("is fixed width, so a viewer rail never truncates one", () => {
    // The slug ids this replaced ran to the 48-character cap and were clipped mid-word:
    // `build-production-schedule-respecting-all-constra` is a real one from a benchmark run.
    const long = "Build the production schedule respecting every constraint in the ERP and MES";
    const id = mintNodeId("kn", long, 1, 0, new Set());
    expect(id).toHaveLength("kn-".length + 4);
    expect(isValidNodeId(id)).toBe(true);
  });

  test("disambiguates against ids already taken", () => {
    const first = mintNodeId("kn", "Ask Dana", 1, 0, new Set());
    const second = mintNodeId("kn", "Ask Dana", 1, 0, new Set([first]));
    expect(second).not.toBe(first);
    expect(second.startsWith("kn-")).toBe(true);
  });

  test("resolves a collision deterministically rather than by re-rolling", () => {
    // The nonce is an input to the hash, so the same collision resolves the same way every
    // time. Randomness would also avoid the collision, and would not replay.
    const taken = new Set([mintNodeId("kn", "Ask Dana", 1, 0, new Set())]);
    expect(mintNodeId("kn", "Ask Dana", 1, 0, taken)).toBe(
      mintNodeId("kn", "Ask Dana", 1, 0, taken),
    );
  });

  test("the same label in different commits mints different ids", () => {
    // Version and op index are in the seed, so a label reused later does not land on the
    // collision loop every time.
    expect(mintNodeId("kn", "Ask Dana", 1, 0, new Set())).not.toBe(
      mintNodeId("kn", "Ask Dana", 2, 0, new Set()),
    );
  });

  test("is deterministic, which is what lets fold and mutate agree", () => {
    expect(mintNodeId("kn", "Ask Dana", 1, 0, new Set())).toBe(
      mintNodeId("kn", "Ask Dana", 1, 0, new Set()),
    );
  });

  test("mints a valid node id for a label with nothing in the id alphabet", () => {
    // A slug had to fall back to "node" here. A hash does not care what the label contains.
    const id = mintNodeId("kn", "\u2014 \u2014 \u2014", 1, 0, new Set());
    expect(isValidNodeId(id)).toBe(true);
  });
});

describe("isValidPrefix", () => {
  test("accepts one to eight lowercase characters opening with a letter", () => {
    for (const good of ["k", "kn", "acme", "kona", "a1", "abcdefgh"]) {
      expect(isValidPrefix(good)).toBe(true);
    }
  });

  test("refuses a prefix containing '-', because the dash is the boundary", () => {
    // `my-proj-a1b2` would be unreadable: the reader cannot tell where the prefix ends.
    expect(isValidPrefix("my-proj")).toBe(false);
  });

  test("refuses empty, over-long, leading-digit and upper-case prefixes", () => {
    for (const bad of ["", "abcdefghi", "1kn", "KN", "kn ", "kn_1"]) {
      expect(isValidPrefix(bad)).toBe(false);
    }
  });
});
