/**
 * A1, A3 and the static half of A7 — the three architectural claims, mechanized as greps over
 * `packages/viewer/src`.
 *
 * Each of them is the kind of promise that decays quietly. A1: one convenient import of the
 * CLI and the view has a path to the store, which is a second, unversioned mutator with no
 * rationale. A3: one locally written `isReady` and the canvas starts showing work as available
 * that the CLI refuses to dispatch — the store's semantics are subtle enough that a plausible
 * reimplementation is the likely outcome, not the unlikely one. A7: one absolute URL and the
 * "localhost only, zero outbound calls" claim is no longer true, whatever the README says.
 *
 * A3 decayed exactly that quietly once already. It was written against a hardcoded five names,
 * the store grew the activity model — nine node types in two families, guarded decision arms,
 * a seven-state lifecycle — and the list did not, so a locally reimplemented `firedGuard` or
 * `carriesStatus` passed a gate whose whole job was to stop one. The list is therefore no
 * longer trusted to stay current by hand: it is checked against what core actually exports, and
 * a judgment core adds tomorrow fails this file until somebody classifies it.
 *
 * None of these can be caught by types, so they are caught by reading the source tree. The
 * greps run over comment-stripped text, because a rule that a doc comment can defeat is not a
 * rule.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(HERE, "..");
const SRC_DIR = join(PACKAGE_DIR, "src");

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx"];

/**
 * The names whose meaning belongs to `@kona/core` and to nowhere else.
 *
 * The original five were readiness and resolution, because those were the only judgments the
 * store made. The activity model added the rest, and they are the more dangerous half, because
 * each of them has a plausible local version that compiles, passes a happy-path test, and
 * disagrees with the store on the one case that matters:
 *
 *   - `carriesStatus` written as "does this node have a status object" — every node is BORN
 *     with one, so a diamond sails through onto the frontier and gets dispatched;
 *   - `isTerminal` written as `completed || failed`, silently missing `withdrawn` and
 *     `terminated`, which are the two the store derives rather than a worker reporting them;
 *   - `isEdgeDead` written as `!isEdgeSatisfied(…)`, when core is explicit that the two are not
 *     complements — an edge whose source is still open is neither, and treating them as
 *     complements is how a live branch gets dropped;
 *   - `firedGuard` written as an equality against `resolutionOf`, which routes `confirmed` and
 *     `declined` to the identical arm because both project to `satisfied`.
 *
 * Grouped by the question each family answers, and kept in step with core by the coverage test
 * in the A3 block rather than by anyone remembering to come back here.
 */
const STORE_SEMANTICS = [
  // Readiness, satisfaction and what an activity's record adds up to (graph.ts).
  "isReady",
  "readyFrontier",
  "isEdgeSatisfied",
  "satisfiesBlockingEdge",
  "isActivityTerminal",
  "resolutionOf",
  "resolvingOutcome",

  // Which family a node belongs to, and therefore what it carries. The store owns this: a
  // second answer in the viewer is how the canvas ends up drawing a status on a node that
  // has none, which is what the discriminated union (D6) exists to make impossible.
  "isBehaviour",
  "isNodeLive",

  // Routing and deadness — which arm fires, and which can never fire again (graph.ts).
  "firedGuard",
  "isEdgeDead",
  "isArmDead",

  // Which nodes are work, and which states are over (vocab.ts). New with the activity model:
  // before it there was one family and four states, and neither needed a predicate.
  "isControlNode",
  "isBehaviourNode",
  "isUnclaimed",
  "isAbandoned",
  "isTerminal",
  "isDerivedStatus",
  "isResolvingVerdict",
  "isIrreversible",
] as const;

/**
 * The rest of what those two modules export: container operations and plain field reads, with
 * no rule inside them to disagree about. Listed rather than merely left out, so the coverage
 * test can tell "deliberately not guarded" from "nobody noticed".
 *
 * `inEdges` is the uncomfortable one. It is a filter over `graph.edges` and nothing more — but
 * the judgment that belongs beside it, core's `liveIn` (in-edges minus the ones a supersede took
 * out of the live graph, D5), is NOT exported. A viewer that needs it has to write it, and this
 * list cannot honestly forbid the only spelling available. That is a hole in core's surface, and
 * naming it here is the most this file can do about it.
 */
const NOT_A_JUDGMENT = [
  "emptyGraph",
  "activityIds",
  "inEdges",
  "outEdges",
  "projectGraph",
  "headVersion",
] as const;

/**
 * The subset A3 requires the model to actually consume, not merely to avoid redefining.
 *
 * Each entry is a group of ALTERNATIVES, and only the last one has more than one member. Core
 * spells the behaviour/control split three ways and the tree only has to ask one of them, so
 * pinning a particular spelling would fail on a rename that is not a regression. The group is
 * the claim — *which nodes are work is core's answer, not ours* — and it is new with the
 * activity model: a viewer that decides it locally draws diamonds as though they were steps a
 * person could pick up.
 *
 * The readiness entry USED TO BE `isReady`, and that requirement inverted with the activity
 * model. §6.2.1 makes `ready` a state the store derives at commit and writes into the log, so a
 * reader that calls `isReady(graph, node)` is recomputing at read time what the commit already
 * decided — core's own note on `readyFrontier` says the frontier a fresh process reads must be
 * "the frontier the commit decided, not one recomputed by whatever this file says today". The
 * two can disagree, which is the whole hazard. So the name the viewer must consume is
 * `readyFrontier`, core's query over the recorded fact; `isReady` stays on the redefinition
 * list above, because writing a local one is still forbidden, but importing it is no longer
 * what discharges the claim.
 *
 * `firedGuard` is deliberately NOT here yet. Nothing in the viewer renders which arm a decision
 * took, and a consumption rule for a thing nobody consumes would be a rule about intentions.
 * It is on the redefinition list above, which is the half that bites today.
 */
const MUST_BE_IMPORTED = [
  ["readyFrontier"],
  ["isEdgeSatisfied"],
  ["resolutionOf"],
  ["isControlNode", "carriesStatus", "isBehaviourNode"],
] as const;

interface SourceFile {
  /** Path relative to `packages/viewer`, POSIX-separated, so failures name something readable. */
  path: string;
  /** The bytes on disk. */
  text: string;
  /** The same bytes with comments blanked out, position-preserving. */
  code: string;
}

/**
 * Blank out comments, leaving string literals and byte positions intact.
 *
 * A regex-based `//.*$` strip would swallow the rest of the line starting at the `//` inside
 * `"https://example.com"` — which is precisely the literal these assertions exist to catch, so
 * the grep would pass on the one file it had to fail. Hence a walk that tracks quote state.
 * Template substitutions are treated as string content: conservative in the direction that
 * keeps a URL visible rather than hiding one.
 */
function stripComments(text: string): string {
  let out = "";
  let index = 0;
  let quote: string | null = null;

  while (index < text.length) {
    const ch = text[index] ?? "";
    const next = text[index + 1] ?? "";

    if (quote !== null) {
      out += ch;
      if (ch === "\\") {
        out += next;
        index += 2;
        continue;
      }
      if (ch === quote) quote = null;
      index += 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      index += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") {
        out += " ";
        index += 1;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      const close = text.indexOf("*/", index + 2);
      const stop = close === -1 ? text.length : close + 2;
      for (; index < stop; index += 1) out += text[index] === "\n" ? "\n" : " ";
      continue;
    }

    out += ch;
    index += 1;
  }

  return out;
}

/**
 * Every source file under `src/`, or nothing at all when the tree does not exist yet.
 *
 * The empty case is deliberate: `src/feed/` arrives with the file-watch work and the model
 * modules are written by other hands. A gate that threw on an absent directory would be a gate
 * that could not be written first.
 */
function readSourceTree(): SourceFile[] {
  let entries: string[];
  try {
    entries = readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext)))
    .map((entry) => {
      const relative = `src/${entry.split(/[\\/]/).join("/")}`;
      const text = readFileSync(join(SRC_DIR, entry), "utf8");
      return { path: relative, text, code: stripComments(text) };
    });
}

const FILES = readSourceTree();

/** Named bindings a file pulls out of `@kona/core`, aliases resolved to the original name. */
function coreImports(code: string): string[] {
  const names: string[] = [];
  const pattern = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@kona\/core["']/g;

  for (const match of code.matchAll(pattern)) {
    for (const clause of (match[1] ?? "").split(",")) {
      const name = clause
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name !== undefined && name.length > 0) names.push(name);
    }
  }

  return names;
}

const CORE_SRC_DIR = join(PACKAGE_DIR, "..", "core", "src");

/**
 * The two core modules that hold the fold judgments. `fold.ts` does the folding; these two are
 * where the folded graph is asked questions, so they are the surface A3 has to keep up with.
 */
const JUDGMENT_MODULES = ["graph.ts", "vocab.ts"] as const;

/**
 * The `export function` names in a core module.
 *
 * Only that form. A judgment core wrote as `export const f = (…) => …` would slip past this
 * check — the one hole left in it, named here rather than hidden, and not a hole today: both
 * modules are `export function` throughout, and their `export const`s are data (type lists,
 * arity tables) that no viewer could reimplement without the values being visibly wrong.
 */
function exportedFunctions(file: string): string[] {
  const code = stripComments(readFileSync(join(CORE_SRC_DIR, file), "utf8"));
  return [...code.matchAll(/\bexport\s+function\s+([A-Za-z_$][\w$]*)/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

describe("the scan itself", () => {
  test("the source tree is being read, so the gates below are not vacuous", () => {
    // Every assertion in this file is a "no file does X". A broken path would make all of them
    // pass on an empty list, which is the failure mode a seam test can least afford.
    expect(FILES.length).toBeGreaterThan(0);
    expect(FILES.map((file) => file.path)).toContain("src/main.tsx");
  });

  test("comments are stripped without eating the string literals around them", () => {
    const stripped = stripComments('const a = "https://x"; // https://y\n/* https://z */ b();');
    expect(stripped).toContain('"https://x"');
    expect(stripped).not.toContain("https://y");
    expect(stripped).not.toContain("https://z");
    expect(stripped).toContain("b();");
  });
});

describe("A1 — the viewer has no path to the store", () => {
  test("no file under src mentions @kona/cli", () => {
    // Checked against the raw bytes, not the stripped code: a commented-out import is a
    // dependency waiting to be uncommented, and the seam is worth more than that convenience.
    const offenders = FILES.filter((file) => file.text.includes("@kona/cli")).map(
      (file) => file.path,
    );
    expect(offenders).toEqual([]);
  });

  test("package.json declares @kona/cli in no dependency field", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const fields = Object.keys(manifest).filter((key) =>
      key.toLowerCase().endsWith("dependencies"),
    );

    expect(fields).toContain("dependencies");
    for (const field of fields) {
      expect(Object.keys(manifest[field] ?? {})).not.toContain("@kona/cli");
    }
    // The seam is "core and nothing else", not "no dependencies": assert the half that has to
    // be there, so a manifest emptied by accident cannot pass this by having nothing to find.
    expect(Object.keys(manifest["dependencies"] ?? {})).toContain("@kona/core");
  });
});

describe("A3 — readiness, routing and the node families come from core, never from here", () => {
  test("no file under src declares one of the store's semantics", () => {
    // This is a NAME gate, and that is exactly its reach: it sees `function isEdgeDead`, a
    // re-export, and a `const isEdgeDead =`, and it cannot see the same body under a different
    // name. A second opinion called `armFired` or `isWorkable` is invisible to it and always
    // will be — no regex distinguishes a reimplementation from an unrelated helper. What
    // narrows that gap is the import half below (the real function is demonstrably in use) and
    // review; what would widen it is pretending otherwise.
    const offenders: string[] = [];

    for (const file of FILES) {
      for (const name of STORE_SEMANTICS) {
        const declared = new RegExp(
          `\\bfunction\\s+${name}\\b|\\b(?:const|let|var)\\s+${name}\\s*=`,
        );
        if (declared.test(file.code)) offenders.push(`${file.path} declares ${name}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("every judgment core exports is classified, so the list cannot fall behind again", () => {
    // The failure this catches is the one that already happened: core grew `firedGuard`,
    // `isEdgeDead`, `isArmDead` and the whole node-family vocabulary, the hardcoded five did
    // not, and a local reimplementation of any of them was waved straight through. Guarding is
    // now the default and exemption is explicit, so the next judgment core adds turns this red
    // until somebody says which bucket it belongs in.
    const exported = JUDGMENT_MODULES.flatMap(exportedFunctions);

    // Anti-vacuity, the same guard "the scan itself" gets: a wrong path or a changed export
    // style would leave `exported` empty, and an empty list is classified by definition.
    expect(exported).toContain("isReady");
    expect(exported).toContain("firedGuard");
    expect(exported).toContain("isBehaviourNode");

    const classified = new Set<string>([...STORE_SEMANTICS, ...NOT_A_JUDGMENT]);
    expect(exported.filter((name) => !classified.has(name)).toSorted()).toEqual([]);
  });

  test("no guarded name is stale, because a name core does not export guards nothing", () => {
    // The other direction, and the quieter bug: a misspelled or since-renamed entry in
    // STORE_SEMANTICS is a grep that can never match, which reads as compliance forever.
    const exported = new Set(JUDGMENT_MODULES.flatMap(exportedFunctions));
    const stale = [...STORE_SEMANTICS, ...NOT_A_JUDGMENT].filter((name) => !exported.has(name));

    expect(stale).toEqual([]);
  });

  test("the judgments the model has to consume are imported from core", () => {
    // The other half of the same claim: not redefining them is worthless if nothing uses them
    // either, because then the judgment lives somewhere this grep cannot see.
    const imported = new Set(FILES.flatMap((file) => coreImports(file.code)));
    const missing = MUST_BE_IMPORTED.filter(
      (group) => !group.some((name) => imported.has(name)),
    ).map((group) => group.join(" or "));

    expect(missing).toEqual([]);
  });
});

describe("A7 — localhost only, zero outbound calls", () => {
  test("no source file carries an http:// or https:// literal outside a comment", () => {
    const offenders = FILES.filter((file) => /https?:\/\//.test(file.code)).map(
      (file) => file.path,
    );
    expect(offenders).toEqual([]);
  });

  test("the only fetch( calls live under src/feed/", () => {
    // Vacuously true until the feed lands, which is the point: the rule is in place before the
    // first line of network code is written, not bolted on after it.
    const offenders = FILES.filter(
      (file) => /\bfetch\s*\(/.test(file.code) && !file.path.startsWith("src/feed/"),
    ).map((file) => file.path);
    expect(offenders).toEqual([]);
  });
});
