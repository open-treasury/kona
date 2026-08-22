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

/** The names whose meaning belongs to `@kona/core` and to nowhere else. */
const STORE_SEMANTICS = [
  "isReady",
  "isEdgeSatisfied",
  "resolutionOf",
  "satisfiesBlockingEdge",
  "readyFrontier",
] as const;

/** The subset A3 requires the model to actually consume, not merely to avoid redefining. */
const MUST_BE_IMPORTED = ["isReady", "isEdgeSatisfied", "resolutionOf"] as const;

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
      const name = clause.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim();
      if (name !== undefined && name.length > 0) names.push(name);
    }
  }

  return names;
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

describe("A3 — readiness and resolution come from core, never from here", () => {
  test("no file under src declares one of the store's semantics", () => {
    const offenders: string[] = [];

    for (const file of FILES) {
      for (const name of STORE_SEMANTICS) {
        const declared = new RegExp(`\\bfunction\\s+${name}\\b|\\b(?:const|let|var)\\s+${name}\\s*=`);
        if (declared.test(file.code)) offenders.push(`${file.path} declares ${name}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("isReady, isEdgeSatisfied and resolutionOf are imported from core", () => {
    // The other half of the same claim: not redefining them is worthless if nothing uses them
    // either, because then the judgment lives somewhere this grep cannot see.
    const imported = new Set(FILES.flatMap((file) => coreImports(file.code)));

    for (const name of MUST_BE_IMPORTED) {
      expect([...imported].toSorted()).toContain(name);
    }
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
