import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type ContractCapabilitySnapshot,
  type ContractDiff,
  type ContractErrorSnapshot,
  type ContractSnapshot,
  diffContractSnapshots,
  runContractCommand,
} from "../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const commandPath = "packages/tooling/dist/cli.js";
const temporaryDirectory = mkdtempSync(join(tmpdir(), "invokta-diff-"));

type Schema = Readonly<Record<string, unknown>>;

function capability(
  overrides: Partial<ContractCapabilitySnapshot> = {},
): ContractCapabilitySnapshot {
  return {
    description: "Echo a value.",
    access: "public",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    outputSchema: {
      type: "object",
      properties: { result: { type: "string" } },
      required: ["result"],
    },
    ...overrides,
  };
}

function snapshot(
  capabilities: Readonly<Record<string, ContractCapabilitySnapshot>>,
  engine: { readonly name: string; readonly version: string } = {
    name: "support-engine",
    version: "1.0.0",
  },
): ContractSnapshot {
  return { formatVersion: 1, engine, capabilities };
}

function summarize(diff: ContractDiff): readonly string[] {
  return diff.changes.map((change) =>
    [
      change.severity,
      change.code,
      change.capabilityId ?? "-",
      change.schema === undefined ? "-" : `${change.schema}#${change.path}`,
    ].join(" "),
  );
}

function diffCapability(
  previous: Partial<ContractCapabilitySnapshot>,
  next: Partial<ContractCapabilitySnapshot>,
): readonly string[] {
  return summarize(
    diffContractSnapshots(
      snapshot({ c: capability(previous) }),
      snapshot({ c: capability(next) }),
    ),
  );
}

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
  extra: Schema = {},
): Schema {
  return { type: "object", properties, required, ...extra };
}

function diffInput(previous: Schema, next: Schema): readonly string[] {
  return diffCapability({ inputSchema: previous }, { inputSchema: next });
}

function diffOutput(previous: Schema, next: Schema): readonly string[] {
  return diffCapability({ outputSchema: previous }, { outputSchema: next });
}

function propertySchema(schema: unknown): Schema {
  return objectSchema({ value: schema }, ["value"]);
}

function writeSnapshot(name: string, value: unknown): string {
  const path = join(temporaryDirectory, name);
  writeFileSync(
    path,
    typeof value === "string" ? value : JSON.stringify(value),
  );
  return path;
}

async function runContract(...args: readonly string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runContractCommand({
    argv: args,
    cwd: temporaryDirectory,
    io: {
      writeStdout: (text) => {
        stdout.push(text);
      },
      writeStderr: (text) => {
        stderr.push(text);
      },
    },
  });
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

beforeAll(() => {
  execFileSync(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "-b",
      "packages/core",
      "packages/mcp",
      "packages/tooling",
      "--pretty",
      "false",
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
});

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("capability-level contract rules", () => {
  it("reports no changes for identical snapshots", () => {
    const diff = diffContractSnapshots(
      snapshot({ c: capability() }),
      snapshot(
        { c: capability() },
        { name: "support-engine", version: "2.0.0" },
      ),
    );

    expect(diff).toEqual({
      changes: [],
      breaking: 0,
      potentiallyBreaking: 0,
      compatible: 0,
    });
  });

  it("classifies a removed capability as breaking", () => {
    expect(
      summarize(
        diffContractSnapshots(
          snapshot({ a: capability(), b: capability() }),
          snapshot({ a: capability() }),
        ),
      ),
    ).toEqual(["breaking CAPABILITY_REMOVED b -"]);
  });

  it("reports a rename as one removal and one addition", () => {
    const diff = diffContractSnapshots(
      snapshot({ "support.classify": capability() }),
      snapshot({ "support.categorize": capability() }),
    );

    expect(summarize(diff)).toEqual([
      "compatible CAPABILITY_ADDED support.categorize -",
      "breaking CAPABILITY_REMOVED support.classify -",
    ]);
    expect(diff).toMatchObject({
      breaking: 1,
      potentiallyBreaking: 0,
      compatible: 1,
    });
  });

  it("classifies an added capability as compatible", () => {
    expect(
      summarize(
        diffContractSnapshots(
          snapshot({ a: capability() }),
          snapshot({ a: capability(), b: capability() }),
        ),
      ),
    ).toEqual(["compatible CAPABILITY_ADDED b -"]);
  });

  it.each([
    ["public", "authenticated", "breaking"],
    ["public", "function", "breaking"],
    ["authenticated", "function", "potentially-breaking"],
    ["function", "authenticated", "potentially-breaking"],
    ["authenticated", "public", "compatible"],
    ["function", "public", "compatible"],
  ] as const)(
    "classifies access %s to %s as %s",
    (previous, next, severity) => {
      expect(diffCapability({ access: previous }, { access: next })).toEqual([
        `${severity} ACCESS_CHANGED c -`,
      ]);
    },
  );

  it.each([
    [undefined, 1_000, "potentially-breaking"],
    [2_000, 1_000, "potentially-breaking"],
    [1_000, 2_000, "compatible"],
    [1_000, undefined, "compatible"],
  ] as const)(
    "classifies timeout %s to %s as %s",
    (previous, next, severity) => {
      expect(
        diffCapability(
          previous === undefined ? {} : { timeoutMs: previous },
          next === undefined ? {} : { timeoutMs: next },
        ),
      ).toEqual([`${severity} TIMEOUT_CHANGED c -`]);
    },
  );

  it("treats a lost behavioral guarantee as potentially breaking", () => {
    expect(
      diffCapability(
        { annotations: { readOnly: true, destructive: false } },
        { annotations: { readOnly: false } },
      ),
    ).toEqual([
      "potentially-breaking ANNOTATIONS_CHANGED c -",
      "potentially-breaking ANNOTATIONS_CHANGED c -",
    ]);
    expect(
      diffCapability(
        { annotations: { idempotent: false, openWorld: true } },
        { annotations: { idempotent: true, openWorld: false } },
      ),
    ).toEqual([
      "compatible ANNOTATIONS_CHANGED c -",
      "compatible ANNOTATIONS_CHANGED c -",
    ]);
  });

  it("classifies deprecation and documentation changes as compatible", () => {
    expect(
      diffCapability(
        { title: "Echo" },
        {
          title: "Echo value",
          description: "Echo one value.",
          deprecated: { reason: "Use echo.v2.", replacement: "echo.v2" },
        },
      ),
    ).toEqual([
      "compatible METADATA_CHANGED c -",
      "compatible DEPRECATION_CHANGED c -",
    ]);
  });

  it("treats an engine rename as potentially breaking", () => {
    expect(
      summarize(
        diffContractSnapshots(
          snapshot({ c: capability() }),
          snapshot(
            { c: capability() },
            { name: "helpdesk-engine", version: "1.0.0" },
          ),
        ),
      ),
    ).toEqual(["potentially-breaking ENGINE_NAME_CHANGED - -"]);
  });

  it("rejects an invalid snapshot passed to the programmatic API", () => {
    expect(() =>
      diffContractSnapshots(
        { ...snapshot({}), formatVersion: 2 } as unknown as ContractSnapshot,
        snapshot({}),
      ),
    ).toThrow("previous snapshot: formatVersion must be 1.");
  });
});

describe("object properties", () => {
  it("classifies a new required input property as breaking", () => {
    expect(
      diffInput(
        objectSchema({ id: { type: "string" } }, ["id"]),
        objectSchema({ id: { type: "string" }, priority: { type: "string" } }, [
          "id",
          "priority",
        ]),
      ),
    ).toEqual(["breaking PROPERTY_ADDED c input#/properties/priority"]);
  });

  it("classifies a newly required input property as breaking", () => {
    expect(
      diffInput(
        objectSchema({ id: { type: "string" }, priority: { type: "string" } }, [
          "id",
        ]),
        objectSchema({ id: { type: "string" }, priority: { type: "string" } }, [
          "id",
          "priority",
        ]),
      ),
    ).toEqual(["breaking REQUIRED_CHANGED c input#/properties/priority"]);
  });

  it("classifies an added optional input property as compatible", () => {
    expect(
      diffInput(
        objectSchema({ id: { type: "string" } }, ["id"]),
        objectSchema({ id: { type: "string" }, note: { type: "string" } }, [
          "id",
        ]),
      ),
    ).toEqual(["compatible PROPERTY_ADDED c input#/properties/note"]);
  });

  it("classifies a removed input property by whether extra input is rejected", () => {
    const previous = objectSchema(
      { id: { type: "string" }, note: { type: "string" } },
      ["id"],
    );

    expect(
      diffInput(previous, objectSchema({ id: { type: "string" } }, ["id"])),
    ).toEqual([
      "potentially-breaking PROPERTY_REMOVED c input#/properties/note",
    ]);
    expect(
      diffInput(
        { ...previous, additionalProperties: false },
        objectSchema({ id: { type: "string" } }, ["id"], {
          additionalProperties: false,
        }),
      ),
    ).toEqual(["breaking PROPERTY_REMOVED c input#/properties/note"]);
  });

  it("classifies a removed output property as breaking", () => {
    expect(
      diffOutput(
        objectSchema(
          { result: { type: "string" }, score: { type: "number" } },
          ["result"],
        ),
        objectSchema({ result: { type: "string" } }, ["result"]),
      ),
    ).toEqual(["breaking PROPERTY_REMOVED c output#/properties/score"]);
  });

  it("classifies a newly optional output property as breaking", () => {
    expect(
      diffOutput(
        objectSchema({ result: { type: "string" } }, ["result"]),
        objectSchema({ result: { type: "string" } }),
      ),
    ).toEqual(["breaking REQUIRED_CHANGED c output#/properties/result"]);
  });

  it("flags an output property added to a closed object as potentially breaking", () => {
    const diff = diffContractSnapshots(
      snapshot({
        c: capability({
          outputSchema: objectSchema(
            { result: { type: "string" } },
            ["result"],
            {
              additionalProperties: false,
            },
          ),
        }),
      }),
      snapshot({
        c: capability({
          outputSchema: objectSchema(
            { result: { type: "string" }, score: { type: "number" } },
            ["result", "score"],
            { additionalProperties: false },
          ),
        }),
      }),
    );

    expect(summarize(diff)).toEqual([
      "potentially-breaking CLOSED_OUTPUT_PROPERTY_ADDED c output#/properties/score",
    ]);
    expect(diff.changes[0]?.message).toContain(
      "reject results until they list tools again",
    );
  });

  it("classifies an output property added to an open object as compatible", () => {
    expect(
      diffOutput(
        objectSchema({ result: { type: "string" } }, ["result"]),
        objectSchema(
          { result: { type: "string" }, score: { type: "number" } },
          ["result"],
        ),
      ),
    ).toEqual(["compatible PROPERTY_ADDED c output#/properties/score"]);
  });

  it.each([
    ["input", { type: "number" }, { type: "string" }, "potentially-breaking"],
    ["output", { type: "number" }, { type: "string" }, "potentially-breaking"],
    ["input", { type: "number" }, { type: "number" }, "compatible"],
    ["output", { type: "number" }, { type: "number" }, "compatible"],
  ] as const)(
    "checks a property added to an %s object against its previous additionalProperties %j",
    (direction, additional, added, severity) => {
      const previous = objectSchema({}, [], {
        additionalProperties: additional,
      });
      const next = objectSchema({ name: added }, [], {
        additionalProperties: additional,
      });

      expect(
        direction === "input"
          ? diffInput(previous, next)
          : diffOutput(previous, next),
      ).toEqual([`${severity} PROPERTY_ADDED c ${direction}#/properties/name`]);
    },
  );

  it("treats a property added under previous patternProperties as potentially breaking", () => {
    expect(
      diffInput(
        objectSchema({}, [], {
          patternProperties: { "^n": { type: "number" } },
        }),
        objectSchema({ name: { type: "string" } }, [], {
          patternProperties: { "^n": { type: "number" } },
        }),
      ),
    ).toEqual(["potentially-breaking PROPERTY_ADDED c input#/properties/name"]);
  });

  it("keeps a new required input property breaking under a catchall", () => {
    expect(
      diffInput(
        objectSchema({}, [], { additionalProperties: { type: "number" } }),
        objectSchema({ name: { type: "number" } }, ["name"], {
          additionalProperties: { type: "number" },
        }),
      ),
    ).toEqual(["breaking PROPERTY_ADDED c input#/properties/name"]);
  });

  it("classifies an input property made optional as compatible", () => {
    expect(
      diffInput(
        objectSchema({ id: { type: "string" } }, ["id"]),
        objectSchema({ id: { type: "string" } }),
      ),
    ).toEqual(["compatible REQUIRED_CHANGED c input#/properties/id"]);
  });

  it("compares nested properties and escapes JSON Pointer segments", () => {
    expect(
      diffInput(
        objectSchema({
          "a/b~c": objectSchema({ inner: { type: "string" } }, ["inner"]),
        }),
        objectSchema({
          "a/b~c": objectSchema({ inner: { type: "number" } }, ["inner"]),
        }),
      ),
    ).toEqual([
      "breaking TYPE_CHANGED c input#/properties/a~1b~0c/properties/inner",
    ]);
  });
});

describe("additional properties", () => {
  it.each([
    [undefined, false, "breaking"],
    [true, false, "breaking"],
    [undefined, { type: "string" }, "breaking"],
    [{ type: "string" }, false, "breaking"],
    [false, undefined, "compatible"],
    [false, { type: "string" }, "compatible"],
    [{ type: "string" }, true, "compatible"],
  ] as const)(
    "classifies input additionalProperties %j to %j as %s",
    (previous, next, severity) => {
      expect(
        diffInput(
          objectSchema(
            {},
            [],
            previous === undefined ? {} : { additionalProperties: previous },
          ),
          objectSchema(
            {},
            [],
            next === undefined ? {} : { additionalProperties: next },
          ),
        ),
      ).toEqual([`${severity} ADDITIONAL_PROPERTIES_CHANGED c input#`]);
    },
  );

  it.each([
    [undefined, false, "compatible"],
    [false, undefined, "potentially-breaking"],
    [false, { type: "string" }, "potentially-breaking"],
    [{ type: "string" }, undefined, "breaking"],
    [{ type: "string" }, false, "compatible"],
  ] as const)(
    "classifies output additionalProperties %j to %j as %s",
    (previous, next, severity) => {
      expect(
        diffOutput(
          objectSchema(
            {},
            [],
            previous === undefined ? {} : { additionalProperties: previous },
          ),
          objectSchema(
            {},
            [],
            next === undefined ? {} : { additionalProperties: next },
          ),
        ),
      ).toEqual([`${severity} ADDITIONAL_PROPERTIES_CHANGED c output#`]);
    },
  );

  it("compares additionalProperties schemas recursively", () => {
    expect(
      diffOutput(
        objectSchema({}, [], { additionalProperties: { type: "number" } }),
        objectSchema({}, [], { additionalProperties: { type: "string" } }),
      ),
    ).toEqual(["breaking TYPE_CHANGED c output#/additionalProperties"]);
  });
});

describe("types, values, and bounds", () => {
  it.each([
    [{ type: "string" }, { type: "number" }, "breaking", "breaking"],
    [{ type: "integer" }, { type: "number" }, "compatible", "breaking"],
    [{ type: "number" }, { type: "integer" }, "breaking", "compatible"],
    [
      { type: ["string", "null"] },
      { type: "string" },
      "breaking",
      "compatible",
    ],
    [{}, { type: "string" }, "breaking", "compatible"],
  ])(
    "classifies %j to %j as %s for input and %s for output",
    (previous, next, inputSeverity, outputSeverity) => {
      expect(diffInput(propertySchema(previous), propertySchema(next))).toEqual(
        [`${inputSeverity} TYPE_CHANGED c input#/properties/value`],
      );
      expect(
        diffOutput(propertySchema(previous), propertySchema(next)),
      ).toEqual([`${outputSeverity} TYPE_CHANGED c output#/properties/value`]);
    },
  );

  it.each([
    [{ enum: ["low", "high"] }, { enum: ["low"] }, "breaking", "compatible"],
    [{ enum: ["low"] }, { enum: ["low", "high"] }, "compatible", "breaking"],
    [{ enum: ["low"] }, { enum: ["high"] }, "breaking", "breaking"],
    [{}, { const: "low" }, "breaking", "compatible"],
    [{ const: "low" }, { const: "high" }, "breaking", "breaking"],
    [{ const: "low" }, { enum: ["low", "high"] }, "compatible", "breaking"],
    [{ enum: [{ a: 1, b: 2 }] }, { enum: [{ b: 2, a: 1 }] }, null, null],
  ])(
    "classifies values %j to %j as %s for input and %s for output",
    (previous, next, inputSeverity, outputSeverity) => {
      expect(diffInput(propertySchema(previous), propertySchema(next))).toEqual(
        inputSeverity === null
          ? []
          : [`${inputSeverity} VALUES_CHANGED c input#/properties/value`],
      );
      expect(
        diffOutput(propertySchema(previous), propertySchema(next)),
      ).toEqual(
        outputSeverity === null
          ? []
          : [`${outputSeverity} VALUES_CHANGED c output#/properties/value`],
      );
    },
  );

  it.each([
    [{ minimum: 0 }, { minimum: 1 }, "breaking"],
    [{ minimum: 1 }, { minimum: 0 }, "compatible"],
    [{ minimum: 0 }, { exclusiveMinimum: 0 }, "breaking"],
    [{}, { maximum: 10 }, "breaking"],
    [{ maximum: 10 }, {}, "compatible"],
    [{ exclusiveMaximum: 10 }, { maximum: 9 }, "breaking"],
    [{ minLength: 1 }, { minLength: 2 }, "breaking"],
    [{ maxLength: 10 }, { maxLength: 5 }, "breaking"],
    [{ maxLength: 5 }, { maxLength: 10 }, "compatible"],
    [{ minItems: 0 }, { minItems: 1 }, "breaking"],
    [{ maxItems: 3 }, {}, "compatible"],
    [{ maxProperties: 3 }, { maxProperties: 2 }, "breaking"],
    [{}, { uniqueItems: true }, "breaking"],
    [{}, { pattern: "^a" }, "breaking"],
    [{ pattern: "^a" }, {}, "compatible"],
    [{}, { multipleOf: 2 }, "breaking"],
  ])(
    "classifies the input constraint %j to %j as %s",
    (previous, next, severity) => {
      expect(diffInput(propertySchema(previous), propertySchema(next))).toEqual(
        [`${severity} CONSTRAINT_CHANGED c input#/properties/value`],
      );
    },
  );

  it("classifies stricter output bounds as compatible", () => {
    expect(
      diffOutput(
        propertySchema({ type: "string", maxLength: 10 }),
        propertySchema({ type: "string", maxLength: 5 }),
      ),
    ).toEqual(["compatible CONSTRAINT_CHANGED c output#/properties/value"]);
    expect(
      diffOutput(
        propertySchema({ type: "number", minimum: 1 }),
        propertySchema({ type: "number", minimum: 0 }),
      ),
    ).toEqual(["breaking CONSTRAINT_CHANGED c output#/properties/value"]);
  });

  it("compares array items recursively", () => {
    expect(
      diffInput(
        propertySchema({ type: "array", items: { type: "string" } }),
        propertySchema({ type: "array", items: { type: "number" } }),
      ),
    ).toEqual(["breaking TYPE_CHANGED c input#/properties/value/items"]);
  });

  it("treats a boolean false schema as rejecting every value", () => {
    expect(diffInput(propertySchema(true), propertySchema(false))).toEqual([
      "breaking TYPE_CHANGED c input#/properties/value",
    ]);
    expect(diffInput(propertySchema(true), propertySchema({}))).toEqual([]);
  });
});

describe("nullable values", () => {
  const object = (properties: Readonly<Record<string, unknown>>) =>
    objectSchema(properties, Object.keys(properties), {
      additionalProperties: false,
    });
  const nullable = (schema: unknown, nullFirst = false) => ({
    anyOf: nullFirst ? [{ type: "null" }, schema] : [schema, { type: "null" }],
  });

  it("compares the non-null branch of a nullable object", () => {
    expect(
      diffOutput(
        propertySchema(
          nullable(object({ x: { type: "string" }, y: { type: "string" } })),
        ),
        propertySchema(nullable(object({ x: { type: "string" } }))),
      ),
    ).toEqual([
      "breaking PROPERTY_REMOVED c output#/properties/value/anyOf/0/properties/y",
    ]);
    expect(
      diffInput(
        propertySchema(nullable(object({ x: { type: "string" } }))),
        propertySchema(
          nullable(object({ x: { type: "string" }, y: { type: "string" } })),
        ),
      ),
    ).toEqual([
      "breaking PROPERTY_ADDED c input#/properties/value/anyOf/0/properties/y",
    ]);
  });

  it("classifies adding and removing null by direction", () => {
    const plain = object({ x: { type: "string" } });

    expect(
      diffOutput(propertySchema(plain), propertySchema(nullable(plain))),
    ).toEqual(["breaking TYPE_CHANGED c output#/properties/value"]);
    expect(
      diffInput(propertySchema(plain), propertySchema(nullable(plain))),
    ).toEqual(["compatible TYPE_CHANGED c input#/properties/value"]);
    expect(
      diffInput(propertySchema(nullable(plain)), propertySchema(plain)),
    ).toEqual(["breaking TYPE_CHANGED c input#/properties/value"]);
  });

  it("treats branch order and the type-array form as the same nullable value", () => {
    const inner = { type: "array", items: { type: "string" } };

    expect(
      diffOutput(
        propertySchema(nullable(inner)),
        propertySchema(nullable(inner, true)),
      ),
    ).toEqual([]);
    expect(
      diffOutput(
        propertySchema({ type: ["string", "null"], minLength: 1 }),
        propertySchema(nullable({ type: "string", minLength: 1 })),
      ),
    ).toEqual([]);
    expect(
      diffOutput(
        propertySchema(nullable(inner)),
        propertySchema(
          nullable({ type: "array", items: { type: ["number", "string"] } }),
        ),
      ),
    ).toEqual([
      "breaking TYPE_CHANGED c output#/properties/value/anyOf/0/items",
    ]);
  });

  it("decides null acceptance from type, enum, and const together", () => {
    const nullableEnum = nullable({ type: "string", enum: ["a", "b"] });
    const typeArrayEnum = { type: ["string", "null"], enum: ["a", "b"] };

    expect(
      diffInput(propertySchema(nullableEnum), propertySchema(typeArrayEnum)),
    ).toEqual(["breaking TYPE_CHANGED c input#/properties/value"]);
    expect(
      diffOutput(propertySchema(typeArrayEnum), propertySchema(nullableEnum)),
    ).toEqual(["breaking TYPE_CHANGED c output#/properties/value"]);
    expect(
      diffOutput(
        propertySchema({ type: ["string", "null"], const: "a" }),
        propertySchema(nullable({ type: "string", const: "a" })),
      ),
    ).toEqual(["breaking TYPE_CHANGED c output#/properties/value"]);
    expect(
      diffOutput(
        propertySchema({ type: ["string", "null"], enum: ["a", null] }),
        propertySchema(nullable({ type: "string", enum: ["a"] })),
      ),
    ).toEqual([]);
  });

  it("treats a schema without a type as accepting null", () => {
    const nullableObject = nullable(object({ x: { type: "string" } }));

    expect(
      diffInput(propertySchema(nullableObject), propertySchema({})),
    ).not.toContainEqual(expect.stringMatching(/^breaking /u));
    expect(
      diffInput(propertySchema(nullableObject), propertySchema({})),
    ).toContain("compatible TYPE_CHANGED c input#/properties/value");
    expect(
      diffOutput(propertySchema({}), propertySchema(nullableObject)),
    ).not.toContainEqual(expect.stringMatching(/^(breaking|potentially)/u));
    expect(
      diffOutput(
        propertySchema(nullable({ type: "string" })),
        propertySchema({}),
      ),
    ).toEqual(["breaking TYPE_CHANGED c output#/properties/value"]);
  });

  it("treats a schema that only allows null as rejecting every other value", () => {
    expect(
      diffOutput(
        propertySchema({ const: null }),
        propertySchema(nullable({ type: "string" })),
      ),
    ).toEqual(["breaking TYPE_CHANGED c output#/properties/value/anyOf/0"]);
    expect(
      diffOutput(
        propertySchema(nullable(false)),
        propertySchema(nullable({ type: "string" })),
      ),
    ).toEqual(["breaking TYPE_CHANGED c output#/properties/value/anyOf/0"]);
  });

  it("falls back to the generic comparison when composition can reject null", () => {
    expect(
      diffOutput(
        propertySchema({ type: ["string", "null"], not: { type: "null" } }),
        propertySchema(nullable({ type: "string" })),
      ),
    ).toContainEqual(
      "potentially-breaking KEYWORD_CHANGED c output#/properties/value",
    );
  });

  it("keeps other unions undecidable", () => {
    expect(
      diffOutput(
        propertySchema({ anyOf: [{ type: "string" }, { type: "number" }] }),
        propertySchema({ anyOf: [{ type: "string" }, { type: "boolean" }] }),
      ),
    ).toEqual([
      "potentially-breaking KEYWORD_CHANGED c output#/properties/value",
    ]);
    expect(
      diffOutput(
        propertySchema({ type: "object", ...nullable({ type: "string" }) }),
        propertySchema({ type: "object", ...nullable({ type: "number" }) }),
      ),
    ).toEqual([
      "potentially-breaking KEYWORD_CHANGED c output#/properties/value",
    ]);
  });
});

describe("undecidable schema changes", () => {
  it.each([
    [{ pattern: "^a" }, { pattern: "^b" }],
    [{ multipleOf: 2 }, { multipleOf: 3 }],
    [{ format: "email" }, { format: "uri" }],
    [{ default: "a" }, { default: "b" }],
    [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
    [{ anyOf: [{ type: "string" }] }, { anyOf: [{ type: "number" }] }],
    [{ oneOf: [{ type: "string" }] }, { oneOf: [{ type: "number" }] }],
    [{ allOf: [{ minLength: 1 }] }, { allOf: [{ minLength: 2 }] }],
    [{ not: { type: "string" } }, { not: { type: "number" } }],
    [{ if: { type: "string" } }, { if: { type: "number" } }],
    [{ patternProperties: { "^a": {} } }, { patternProperties: { "^b": {} } }],
  ])("classifies %j to %j as potentially breaking", (previous, next) => {
    const changes = diffInput(propertySchema(previous), propertySchema(next));

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatch(
      /^potentially-breaking (CONSTRAINT|KEYWORD)_CHANGED c input#\/properties\/value$/u,
    );
  });

  it("reports changed definitions at the schema root", () => {
    expect(
      diffInput(
        objectSchema({ value: { $ref: "#/$defs/Value" } }, [], {
          $defs: { Value: { type: "string" } },
        }),
        objectSchema({ value: { $ref: "#/$defs/Value" } }, [], {
          $defs: { Value: { type: "number" } },
        }),
      ),
    ).toEqual(["potentially-breaking KEYWORD_CHANGED c input#"]);
  });

  it("classifies schema documentation changes as compatible", () => {
    expect(
      diffInput(
        propertySchema({ type: "string", description: "A value." }),
        propertySchema({
          type: "string",
          description: "The value.",
          examples: ["x"],
        }),
      ),
    ).toEqual(["compatible METADATA_CHANGED c input#/properties/value"]);
  });
});

describe("declared domain errors", () => {
  const details = (
    properties: Readonly<Record<string, unknown>>,
    extra: Schema = { additionalProperties: false },
  ) => objectSchema(properties, Object.keys(properties), extra);
  const slotTaken = (
    overrides: Partial<ContractErrorSnapshot> = {},
  ): ContractErrorSnapshot => ({
    description: "The slot is taken.",
    retryable: false,
    detailsSchema: details({ slotId: { type: "string" } }),
    ...overrides,
  });
  const diffErrors = (
    previous: Readonly<Record<string, ContractErrorSnapshot>> | undefined,
    next: Readonly<Record<string, ContractErrorSnapshot>> | undefined,
  ) =>
    diffCapability(
      previous === undefined ? {} : { errors: previous },
      next === undefined ? {} : { errors: next },
    );

  it("classifies a removed error code as breaking and an added one as compatible", () => {
    expect(diffErrors({ SLOT_TAKEN: slotTaken() }, undefined)).toEqual([
      "breaking ERROR_REMOVED c -",
    ]);
    expect(
      diffErrors(
        { SLOT_TAKEN: slotTaken() },
        { BOOKING_CLOSED: slotTaken(), SLOT_TAKEN: slotTaken() },
      ),
    ).toEqual(["compatible ERROR_ADDED c -"]);
  });

  it("classifies a retryable change as potentially breaking", () => {
    expect(
      diffErrors(
        { SLOT_TAKEN: slotTaken() },
        { SLOT_TAKEN: slotTaken({ retryable: true }) },
      ),
    ).toEqual(["potentially-breaking ERROR_RETRYABLE_CHANGED c -"]);
  });

  it("classifies a description change as compatible", () => {
    expect(
      diffErrors(
        { SLOT_TAKEN: slotTaken() },
        { SLOT_TAKEN: slotTaken({ description: "Someone booked it." }) },
      ),
    ).toEqual(["compatible METADATA_CHANGED c -"]);
  });

  it("classifies adding details as compatible and removing them as breaking", () => {
    const { detailsSchema: _omitted, ...withoutDetails } = slotTaken();

    expect(
      diffErrors({ SLOT_TAKEN: withoutDetails }, { SLOT_TAKEN: slotTaken() }),
    ).toEqual(["compatible ERROR_DETAILS_CHANGED c -"]);
    expect(
      diffErrors({ SLOT_TAKEN: slotTaken() }, { SLOT_TAKEN: withoutDetails }),
    ).toEqual(["breaking ERROR_DETAILS_CHANGED c -"]);
  });

  it("compares details schemas with the output rules", () => {
    expect(
      diffErrors(
        {
          SLOT_TAKEN: slotTaken({
            detailsSchema: details({
              slotId: { type: "string" },
              until: { type: "string" },
            }),
          }),
        },
        { SLOT_TAKEN: slotTaken() },
      ),
    ).toEqual([
      "breaking PROPERTY_REMOVED c errors#/SLOT_TAKEN/detailsSchema/properties/until",
    ]);
    expect(
      diffErrors(
        { SLOT_TAKEN: slotTaken() },
        {
          SLOT_TAKEN: slotTaken({
            detailsSchema: details({ slotId: { type: ["number", "string"] } }),
          }),
        },
      ),
    ).toEqual([
      "breaking TYPE_CHANGED c errors#/SLOT_TAKEN/detailsSchema/properties/slotId",
    ]);
    expect(
      diffErrors(
        {
          SLOT_TAKEN: slotTaken({
            detailsSchema: details({ slotId: { type: ["number", "string"] } }),
          }),
        },
        { SLOT_TAKEN: slotTaken() },
      ),
    ).toEqual([
      "compatible TYPE_CHANGED c errors#/SLOT_TAKEN/detailsSchema/properties/slotId",
    ]);
  });

  it("flags a property added to closed details for review", () => {
    const diff = diffContractSnapshots(
      snapshot({ c: capability({ errors: { SLOT_TAKEN: slotTaken() } }) }),
      snapshot({
        c: capability({
          errors: {
            SLOT_TAKEN: slotTaken({
              detailsSchema: details({
                slotId: { type: "string" },
                until: { type: "string" },
              }),
            }),
          },
        }),
      }),
    );

    expect(summarize(diff)).toEqual([
      "potentially-breaking CLOSED_OUTPUT_PROPERTY_ADDED c errors#/SLOT_TAKEN/detailsSchema/properties/until",
    ]);
    expect(diff.changes[0]?.message).toContain("error details property");
    expect(diff.changes[0]?.message).not.toContain("MCP SDK");
  });
});

describe("invokta contract diff", () => {
  const previous = snapshot({
    "support.classify": capability({
      inputSchema: objectSchema(
        { ticketId: { type: "string" }, priority: { type: "string" } },
        ["ticketId"],
      ),
    }),
    "support.close": capability(),
  });
  const next = snapshot(
    {
      "support.classify": capability({
        timeoutMs: 1_000,
        inputSchema: objectSchema(
          { ticketId: { type: "string" }, priority: { type: "string" } },
          ["priority", "ticketId"],
        ),
      }),
      "support.reopen": capability(),
    },
    { name: "support-engine", version: "2.0.0" },
  );

  it("prints a readable report and exits 1 for breaking changes", async () => {
    const result = await runContract(
      "contract",
      "diff",
      writeSnapshot("previous.json", previous),
      writeSnapshot("next.json", next),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`invokta: contract diff
previous: engine="support-engine" version="1.0.0" capabilities=2
next: engine="support-engine" version="2.0.0" capabilities=2

breaking changes: 2
  REQUIRED_CHANGED capability="support.classify" at="input#/properties/priority": The property is now required.
  CAPABILITY_REMOVED capability="support.close": The capability was removed.

potentially breaking changes: 1
  TIMEOUT_CHANGED capability="support.classify": A timeout of 1000 ms was added.

compatible changes: 1
  CAPABILITY_ADDED capability="support.reopen": The capability was added.

result: breaking changes found
`);
  });

  it("exits 1 through the binary when breaking changes are found", () => {
    const result = spawnSync(
      process.execPath,
      [
        commandPath,
        "contract",
        "diff",
        writeSnapshot("binary-previous.json", previous),
        writeSnapshot("binary-next.json", next),
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("result: breaking changes found");
    expect(result.stderr).toBe("");
  });

  it("exits 0 for compatible changes", async () => {
    const result = await runContract(
      "contract",
      "diff",
      writeSnapshot("compatible-previous.json", snapshot({ a: capability() })),
      writeSnapshot(
        "compatible-next.json",
        snapshot({ a: capability(), b: capability() }),
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("compatible changes: 1\n");
    expect(result.stdout).toContain("result: compatible\n");
  });

  it("exits 0 and states when there are no changes", async () => {
    const path = writeSnapshot("same.json", snapshot({ a: capability() }));

    const result = await runContract("contract", "diff", path, path);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`invokta: contract diff
previous: engine="support-engine" version="1.0.0" capabilities=1
next: engine="support-engine" version="1.0.0" capabilities=1

no contract changes

result: compatible
`);
  });

  it("fails on potentially breaking changes only when requested", async () => {
    const previousPath = writeSnapshot(
      "potential-previous.json",
      snapshot({ a: capability() }),
    );
    const nextPath = writeSnapshot(
      "potential-next.json",
      snapshot({ a: capability({ timeoutMs: 10 }) }),
    );

    const lenient = await runContract(
      "contract",
      "diff",
      previousPath,
      nextPath,
    );
    const strict = await runContract(
      "contract",
      "diff",
      previousPath,
      nextPath,
      "--fail-on-potentially-breaking",
    );

    expect(lenient.exitCode).toBe(0);
    expect(lenient.stdout).toContain(
      "result: no breaking changes; review the potentially breaking changes\n",
    );
    expect(strict.exitCode).toBe(1);
    expect(strict.stdout).toContain(
      "result: potentially breaking changes found\n",
    );
  });

  it.each([
    [["contract", "diff"], "Exactly two snapshot paths are required."],
    [
      ["contract", "diff", "a.json"],
      "Exactly two snapshot paths are required.",
    ],
    [
      ["contract", "diff", "a.json", "b.json", "c.json"],
      "Exactly two snapshot paths are required.",
    ],
    [
      ["contract", "diff", "a.json", "b.json", "--export", "engine"],
      'Unknown option "--export".',
    ],
  ])("rejects invalid usage %j", async (argv, message) => {
    const result = await runContract(...argv);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`invokta: ${message}`);
    expect(result.stderr).toContain(
      "invokta contract diff <previous-snapshot> <next-snapshot> [--fail-on-potentially-breaking]",
    );
  });

  it.each([
    ["a missing file", undefined, "the file could not be read."],
    ["invalid JSON", '{"secret-marker": ', "the file is not valid JSON."],
    [
      "invalid UTF-8",
      Buffer.from([0x7b, 0xff, 0x7d]),
      "the file is not valid UTF-8.",
    ],
    [
      "an unsupported format version",
      { ...snapshot({}), formatVersion: 2 },
      "formatVersion must be 1.",
    ],
    [
      "an unknown capability field",
      snapshot({
        a: {
          ...capability(),
          outcomes: [],
        } as unknown as ContractCapabilitySnapshot,
      }),
      'capabilities["a"] contains the unsupported field "outcomes".',
    ],
    [
      "a non-boolean retryable flag",
      snapshot({
        a: capability({
          errors: {
            SLOT_TAKEN: {
              description: "The slot is taken.",
              retryable: "yes" as unknown as boolean,
            },
          },
        }),
      }),
      'capabilities["a"].errors["SLOT_TAKEN"].retryable must be a boolean.',
    ],
    [
      "an invalid access kind",
      snapshot({
        a: capability({
          access: "anyone" as ContractCapabilitySnapshot["access"],
        }),
      }),
      'capabilities["a"].access must be "public", "authenticated", or "function".',
    ],
  ])("rejects %s as a snapshot", async (_case, content, reason) => {
    const path = join(
      temporaryDirectory,
      `invalid-${_case.replace(/[^a-z0-9]+/gu, "-")}.json`,
    );
    if (content !== undefined) {
      writeFileSync(
        path,
        Buffer.isBuffer(content) || typeof content === "string"
          ? content
          : JSON.stringify(content),
      );
    } else {
      rmSync(path, { force: true });
    }
    const validPath = writeSnapshot("valid.json", snapshot({}));

    const result = await runContract("contract", "diff", path, validPath);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(
      result.stderr,
    ).toBe(`invokta: the previous snapshot could not be read.
file: ${JSON.stringify(path)}
reason: ${reason}
`);
    expect(result.stderr).not.toContain("secret-marker");
  });

  it("bounds and escapes identifiers echoed from an invalid snapshot", async () => {
    const validPath = writeSnapshot("echo-valid.json", snapshot({}));
    const longKey = "S".repeat(200_000);
    const longPath = writeSnapshot("echo-long.json", {
      ...snapshot({}),
      [longKey]: 1,
    });
    const controlPath = writeSnapshot("echo-control.json", {
      ...snapshot({}),
      capabilities: { "x\u009b31m\u202eRED": { description: 1 } },
    });

    const long = await runContract("contract", "diff", longPath, validPath);
    const control = await runContract(
      "contract",
      "diff",
      controlPath,
      validPath,
    );

    expect(long.exitCode).toBe(2);
    expect(long.stderr).toContain(
      `reason: snapshot contains the unsupported field "${"S".repeat(64)}…".`,
    );
    expect(long.stderr.length).toBeLessThan(longPath.length + 300);
    expect(control.exitCode).toBe(2);
    expect(control.stderr).toContain(
      'reason: capabilities["x\\u009b31m\\u202eRED"].access must be',
    );
    expect(control.stderr).not.toMatch(/[\u0080-\u009f\u202e]/u);
  });

  it("escapes control and format characters in the report", async () => {
    const previousPath = writeSnapshot(
      "escape-previous.json",
      snapshot({ "bad\u009b\u2028id": capability() }),
    );
    const nextPath = writeSnapshot("escape-next.json", snapshot({}));

    const result = await runContract(
      "contract",
      "diff",
      previousPath,
      nextPath,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      'CAPABILITY_REMOVED capability="bad\\u009b\\u2028id"',
    );
    expect(result.stdout).not.toMatch(/[\u0080-\u009f\u2028]/u);
  });

  it("rejects a snapshot file larger than 16 MiB before reading it", async () => {
    const path = join(temporaryDirectory, "oversized.json");
    writeFileSync(path, "");
    truncateSync(path, 16 * 1024 * 1024 + 1);
    const validPath = writeSnapshot("valid-small.json", snapshot({}));

    const result = await runContract("contract", "diff", validPath, path);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      "invokta: the next snapshot could not be read.",
    );
    expect(result.stderr).toContain(
      "reason: the file exceeds the 16777216-byte snapshot limit.",
    );
  });

  it("rejects schemas nested deeper than the comparison limit", async () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let depth = 0; depth < 300; depth += 1) {
      schema = { type: "array", items: schema };
    }
    const path = writeSnapshot(
      "deep.json",
      snapshot({
        a: capability({ inputSchema: objectSchema({ deep: schema }) }),
      }),
    );

    const result = await runContract("contract", "diff", path, path);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      'reason: capabilities["a"].inputSchema exceeds the maximum JSON nesting depth of 256.',
    );
  });
});
