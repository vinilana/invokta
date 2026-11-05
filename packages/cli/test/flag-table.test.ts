import type { CapabilityDescription } from "@invokta/core";
import { describe, expect, it } from "vitest";

import { deriveCapabilityFlags, parseFlagInput } from "../src/flags.js";

function describeInput(
  properties: Readonly<Record<string, unknown>>,
  required: readonly unknown[] = [],
): CapabilityDescription {
  return {
    id: "example.table",
    description: "Plain JSON Schema shapes.",
    access: "public",
    inputSchema: { type: "object", properties, required },
    outputSchema: { type: "object" },
  };
}

function summarize(description: CapabilityDescription) {
  const table = deriveCapabilityFlags(description);
  return {
    flags: table.flags.map((flag) => [
      flag.property,
      flag.name,
      flag.type,
      flag.repeatable,
    ]),
    inputOnly: table.inputOnly.map((entry) => [entry.property, entry.reason]),
  };
}

describe("deriveCapabilityFlags", () => {
  it("infers scalar types from enum and const values without a declared type", () => {
    const table = deriveCapabilityFlags(
      describeInput({
        level: { enum: [1, 2.5] },
        enabled: { const: true },
        color: { enum: ["red", "green"] },
      }),
    );

    expect(
      table.flags.map((flag) => [flag.property, flag.type, flag.allowed]),
    ).toEqual([
      ["level", "number", [1, 2.5]],
      ["enabled", "boolean", [true]],
      ["color", "string", ["red", "green"]],
    ]);
    expect(
      parseFlagInput("example.table", table, [
        "--level",
        "2.5",
        "--no-enabled",
        "--color",
        "blue",
      ]),
    ).toEqual({ level: 2.5, enabled: false, color: "blue" });
  });

  it("treats undecidable or composite property schemas as input-only", () => {
    expect(
      summarize(
        describeInput({
          mixed: { enum: ["a", 1] },
          empty: { enum: [] },
          objectEnum: { enum: [{ a: 1 }] },
          both: { type: "string", const: "a", enum: ["a"] },
          mismatch: { type: "integer", enum: [1, 2.5] },
          nullable: { type: ["string", "null"] },
          union: { anyOf: [{ type: "string" }, { type: "number" }] },
          reference: { $ref: "#/$defs/Mode" },
          anything: {},
          boolean: true,
          tuple: { type: "array", prefixItems: [{ type: "string" }] },
          untypedArray: { type: "array" },
          nestedArray: {
            type: "array",
            items: { type: "array", items: { type: "string" } },
          },
          objectArray: { type: "array", items: { type: "object" } },
          nested: { type: "object", properties: {} },
        }),
      ),
    ).toEqual({
      flags: [],
      inputOnly: [
        ["mixed", "unsupported schema"],
        ["empty", "unsupported schema"],
        ["objectEnum", "unsupported schema"],
        ["both", "unsupported schema"],
        ["mismatch", "unsupported schema"],
        ["nullable", "unsupported schema"],
        ["union", "unsupported schema"],
        ["reference", "unsupported schema"],
        ["anything", "unsupported schema"],
        ["boolean", "unsupported schema"],
        ["tuple", "unsupported schema"],
        ["untypedArray", "unsupported schema"],
        ["nestedArray", "unsupported schema"],
        ["objectArray", "unsupported schema"],
        ["nested", "nested object"],
      ],
    });
  });

  it("maps names deterministically and bounds the flag spelling", () => {
    expect(
      summarize(
        describeInput({
          HTTPServer: { type: "string" },
          address2Line: { type: "string" },
          "already-kebab": { type: "string" },
          snake__case_: { type: "string" },
          [`a${"b".repeat(63)}`]: { type: "string" },
          [`a${"b".repeat(64)}`]: { type: "string" },
          "9lives": { type: "string" },
          "dotted.name": { type: "string" },
          café: { type: "string" },
        }),
      ),
    ).toEqual({
      flags: [
        ["HTTPServer", "http-server", "string", false],
        ["address2Line", "address2-line", "string", false],
        ["already-kebab", "already-kebab", "string", false],
        ["snake__case_", "snake-case", "string", false],
        [`a${"b".repeat(63)}`, `a${"b".repeat(63)}`, "string", false],
      ],
      inputOnly: [
        [`a${"b".repeat(64)}`, "no flag spelling"],
        ["9lives", "no flag spelling"],
        ["dotted.name", "no flag spelling"],
        ["café", "no flag spelling"],
      ],
    });
  });

  it("ignores malformed root properties and required lists", () => {
    const table = deriveCapabilityFlags({
      id: "example.table",
      description: "Malformed root.",
      access: "public",
      inputSchema: { type: "object", properties: [], required: "name" },
      outputSchema: { type: "object" },
    });

    expect(table.flags).toEqual([]);
    expect(table.inputOnly).toEqual([]);
    expect(
      deriveCapabilityFlags(
        describeInput({ name: { type: "string" } }, ["name", 1]),
      ).flags[0]?.required,
    ).toBe(true);
  });

  it("builds own data properties for names that shadow Object.prototype", () => {
    const table = deriveCapabilityFlags(
      describeInput({ constructor: { type: "string" } }),
    );
    const input = parseFlagInput("example.table", table, [
      "--constructor",
      "value",
    ]);

    expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
    expect(Object.hasOwn(input, "constructor")).toBe(true);
    expect(input).toEqual({ constructor: "value" });
  });
});
