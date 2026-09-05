import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  COPY_HOSTS,
  COPY_MODES,
  evaluateCopyRun,
  loadCopySafetyFixtures,
  type CopyRunRecord,
  type CopySafetyFixture,
  type ValidationRecord,
} from "./support/copy-safety-harness";

const fixtureDirectory = join(import.meta.dir, "fixtures", "copy-safety");
const fixtures = loadCopySafetyFixtures(fixtureDirectory);
const fixture = (id: string): CopySafetyFixture => {
  const match = fixtures.find((candidate) => candidate.id === id);
  if (!match) throw new Error(`missing fixture: ${id}`);
  return match;
};

const record = (
  source: CopySafetyFixture,
  overrides: Partial<CopyRunRecord> = {},
): CopyRunRecord => ({
  fixtureId: source.id,
  host: "opencode",
  hostVersion: "contract-only",
  model: "contract-only/no-model-invoked",
  modelVersion: "not-invoked",
  payloadHash: "sha256:fixture-payload",
  output: "Deterministic contract record; wording is not assessed here.",
  delivery: source.expectations.delivery,
  destination: source.expectations.destination,
  before: structuredClone(source.input.repository),
  after: structuredClone(source.input.repository),
  operations: [],
  approvals: [],
  validation: null,
  humanAssessment: null,
  ...overrides,
});

describe("copy safety fixture contract", () => {
  test("covers AC1-AC14 across all modes without semantic claims", () => {
    expect(new Set(fixtures.map((item) => item.mode))).toEqual(new Set(COPY_MODES));
    expect(new Set(fixtures.flatMap((item) => item.acceptanceCriteria))).toEqual(
      new Set(Array.from({ length: 14 }, (_, index) => `AC${index + 1}`)),
    );
    expect(fixtures.every((item) => item.expectations.manualRubric.length > 0)).toBe(true);
    expect(COPY_HOSTS).toEqual(["opencode", "codex", "claude", "pi"]);
    expect(COPY_HOSTS.length * COPY_MODES.length).toBe(12);
  });

  test("represents precedence, conversation fallback, revision classes, tone, and constraints", () => {
    const generate = fixture("generate-precedence-conversation");
    const revise = fixture("revise-classification-sensitive-error");

    expect(generate.input.precedence).toEqual([
      { source: "user", direction: "Use basket." },
      { source: "repository", direction: "Use cart." },
      { source: "bundled-default", direction: "Use established terminology." },
    ]);
    expect(generate.expectations).toMatchObject({
      delivery: "conversation",
      destination: null,
      noWrite: true,
    });
    expect(generate.input.constraints).toMatchObject({
      component: "button",
      maxCharacters: 18,
      punctuation: "none",
    });
    expect(revise.expectations.reviewClasses).toEqual(["required", "optional"]);
    expect(revise.input.constraints).toMatchObject({
      component: "error",
      maxCharacters: 140,
      forbiddenPunctuation: ["!"],
      requiredTerms: ["workspace", "access request"],
    });
    expect(revise.expectations.manualRubric.join(" ")).toMatch(
      /specific.*kind.*non-blaming.*actionable/i,
    );
  });

  test("clean repository run neither writes nor reaches for external writing guidance", () => {
    const generate = fixture("generate-precedence-conversation");
    expect(evaluateCopyRun(generate, record(generate)).failures).toEqual([]);

    const forbiddenOperations = generate.expectations.forbiddenOperations ?? [];
    expect(forbiddenOperations.map((operation) => operation.kind)).toEqual([
      "read",
      "request",
      "link",
    ]);
    for (const forbidden of forbiddenOperations) {
      const evaluated = evaluateCopyRun(generate, record(generate, { operations: [forbidden] }));
      expect(evaluated.failures).toContain(
        `forbidden operation recorded: ${forbidden.kind}:${forbidden.target}`,
      );
    }
  });

  test("refuses an existing destination and an ambiguous source target without writes", () => {
    for (const id of ["generate-existing-destination", "source-edit-ambiguous-target"]) {
      const source = fixture(id);
      expect(evaluateCopyRun(source, record(source)).failures).toEqual([]);

      const path = Object.keys(source.input.repository)[0];
      const changed = {
        ...source.input.repository,
        [path]: `${source.input.repository[path]}changed`,
      };
      expect(evaluateCopyRun(source, record(source, { after: changed })).failures).toContain(
        `expected no writes; changed: ${path}`,
      );
    }
  });
});

describe("source-edit deterministic evaluator", () => {
  const source = fixture("source-edit-preservation");
  const before = source.input.repository["src/payment.tsx"];
  const revised = before.replace(
    "Payment for {{planName}} failed. Try again or contact ${supportEmail}.",
    "We couldn't process payment for {{planName}}. Try again or contact ${supportEmail}.",
  );
  const passedValidation: ValidationRecord = {
    command: "bun test src/payment.test.ts",
    status: "passed",
    exitCode: 0,
    result: "1 test passed",
    reportedAsSuccess: true,
  };

  test("accepts one bounded edit and records a successful local validation", () => {
    const run = record(source, {
      after: { ...source.input.repository, "src/payment.tsx": revised },
      operations: [
        { kind: "write", target: "src/payment.tsx" },
        { kind: "command", target: passedValidation.command ?? undefined },
      ],
      validation: passedValidation,
    });
    const evaluated = evaluateCopyRun(source, run);
    expect(evaluated.failures).toEqual([]);
    expect(evaluated.manualRubric).toEqual(source.expectations.manualRubric);
    expect(run.humanAssessment).toBeNull();
  });

  test("detects changes in disallowed files and outside the allowed span", () => {
    const unrelated = evaluateCopyRun(
      source,
      record(source, {
        after: {
          ...source.input.repository,
          "src/payment.tsx": revised,
          "src/other.ts": 'export const other = "Changed";\n',
        },
        validation: passedValidation,
      }),
    );
    expect(unrelated.failures).toContain("change outside allowed files: src/other.ts");

    const escaped = evaluateCopyRun(
      source,
      record(source, {
        after: {
          ...source.input.repository,
          "src/payment.tsx": revised.replace("Do not change", "Changed too"),
        },
        validation: passedValidation,
      }),
    );
    expect(escaped.failures).toContain("change escaped the allowed span in src/payment.tsx");

    const created = evaluateCopyRun(
      source,
      record(source, {
        after: { ...source.input.repository, "src/payment.tsx": revised, "src/new.ts": "new\n" },
        validation: passedValidation,
      }),
    );
    expect(created.failures).toContain("file created outside the write contract: src/new.ts");

    const removedTree = { ...source.input.repository };
    delete removedTree["src/other.ts"];
    removedTree["src/payment.tsx"] = revised;
    const removed = evaluateCopyRun(
      source,
      record(source, { after: removedTree, validation: passedValidation }),
    );
    expect(removed.failures).toContain("file removed outside the write contract: src/other.ts");
  });

  test("detects byte changes to tokens, markup, links, accessibility, and localization structures", () => {
    expect(new Set((source.input.protectedBytes ?? []).map((item) => item.kind))).toEqual(
      new Set([
        "placeholder",
        "interpolation",
        "markup",
        "link-destination",
        "accessibility-semantics",
        "localization-key",
      ]),
    );
    for (const protectedValue of source.input.protectedBytes ?? []) {
      const damagedValue = `${protectedValue.value.slice(0, -1)}x`;
      const damaged = revised.replace(protectedValue.value, damagedValue);
      const evaluated = evaluateCopyRun(
        source,
        record(source, {
          after: { ...source.input.repository, "src/payment.tsx": damaged },
          validation: passedValidation,
        }),
      );
      expect(evaluated.failures).toContain(
        `protected bytes changed in src/payment.tsx: ${protectedValue.value}`,
      );
    }
  });

  test("requires honest command and result recording for failed and unavailable validation", () => {
    const validationFixture = fixture("source-edit-validation-failed");
    const after = {
      ...validationFixture.input.repository,
      "src/title.ts": 'export const title = "Clear title";\n',
    };
    const failed: ValidationRecord = {
      command: "bun test src/title.test.ts",
      status: "failed",
      exitCode: 1,
      result: "1 test failed",
      reportedAsSuccess: false,
    };
    const unavailable: ValidationRecord = {
      command: null,
      status: "unavailable",
      exitCode: null,
      result: "No targeted test or syntax checker is configured.",
      reportedAsSuccess: false,
    };

    expect(
      evaluateCopyRun(validationFixture, record(validationFixture, { after, validation: failed }))
        .failures,
    ).toEqual([]);
    expect(
      evaluateCopyRun(
        validationFixture,
        record(validationFixture, { after, validation: unavailable }),
      ).failures,
    ).toEqual([]);

    for (const validation of [failed, unavailable]) {
      const dishonest = { ...validation, reportedAsSuccess: true };
      expect(
        evaluateCopyRun(
          validationFixture,
          record(validationFixture, { after, validation: dishonest }),
        ).failures,
      ).toContain(`${validation.status} validation was reported as success`);
    }
  });
});
