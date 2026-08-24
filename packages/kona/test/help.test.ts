/**
 * `--help` works on every verb.
 *
 * This exists because of a run that looked like the model ignoring the plan and was actually
 * the model unable to learn the CLI. It asked `kona mutate --help` six times, got
 * `REFUSED BAD_FLAG Unknown option '--help'` every time, guessed at flags, collected four
 * more refusals, and then went back to doing the task without the graph. The plan stopped
 * updating at v1.
 *
 * `parseArgs` runs in strict mode, so an unknown option throws — which means help has to be
 * intercepted BEFORE parsing, and a test that only checks bare `kona --help` would have
 * passed throughout. So this checks every verb.
 */

import { describe, expect, test } from "bun:test";
import { REASON_CODES } from "@kona/core";
import { run } from "../src/cli.ts";
import { harness, type Harness } from "./harness.ts";

const VERBS = [
  "init",
  "mutate",
  "graph",
  "next",
  "brief",
  "poll",
  "resume",
  "effect",
  "view",
] as const;

describe("--help", () => {
  for (const verb of VERBS) {
    test(`kona ${verb} --help exits 0 and says something`, async () => {
      const h: Harness = harness();
      try {
        expect(await run([verb, "--help"], h.io)).toBe(0);
        const out = h.out.join("\n");
        expect(out).toContain(`kona ${verb}`);
        // A flag list tells you what exists; an example tells you what to type. The model
        // that hit this was looking for the second thing.
        expect(out).toContain("Example:");
        expect(h.err.join("\n")).toBe("");
      } finally {
        h.cleanup();
      }
    });
  }

  test("-h is accepted too — it is the reflex half the time", async () => {
    const h = harness();
    try {
      expect(await run(["mutate", "-h"], h.io)).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("help never touches the store — it works before init", async () => {
    const h = harness();
    try {
      // No `kona init` here on purpose: a model reaches for --help before it has a pursuit,
      // and help that requires one is help you cannot get when you need it.
      expect(await run(["mutate", "--help"], h.io)).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("mutate's help lists the closed reason-code vocabulary", async () => {
    const h = harness();
    try {
      await run(["mutate", "--help"], h.io);
      const out = h.out.join("\n");
      // Omitting these just relocates the guess: --reason-code is closed, so a help page
      // without it sends the reader back to guessing.
      for (const code of REASON_CODES) expect(out).toContain(code);
    } finally {
      h.cleanup();
    }
  });

  test("an unknown verb still refuses, and points at help", async () => {
    const h = harness();
    try {
      // `kona status` was tried twice in a real run. It is not a verb, and the refusal has
      // to say where to look rather than just saying no.
      expect(await run(["status"], h.io)).toBe(1);
      expect(h.err.join("\n")).toContain("--help");
    } finally {
      h.cleanup();
    }
  });
});
