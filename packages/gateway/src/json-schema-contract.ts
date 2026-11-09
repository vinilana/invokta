import type { EngineSchema } from "@invokta/core";

export type JsonObject = Readonly<Record<string, unknown>>;

const notAnObjectIssues = Object.freeze([
  Object.freeze({ message: "Expected a JSON object." }),
]);

/**
 * Wraps a JSON Schema document published by an upstream as an engine schema.
 *
 * The gateway does not own the upstream contract: it republishes the document
 * unchanged and checks only that the value is a JSON object. The upstream
 * engine or MCP server remains the authoritative validator, and the core still
 * enforces the lossless JSON data model on every value.
 */
export function jsonSchemaContract(
  document: JsonObject,
): EngineSchema<JsonObject> {
  if (document.type !== "object") {
    throw new TypeError("A gateway schema contract must have an object root.");
  }
  const snapshot = deepFreeze(structuredClone(document));
  const converter = Object.freeze({
    input: () => snapshot,
    output: () => snapshot,
  });
  return Object.freeze({
    "~standard": Object.freeze({
      version: 1 as const,
      vendor: "invokta-gateway",
      validate(value: unknown) {
        return isJsonObject(value) ? { value } : { issues: notAnObjectIssues };
      },
      jsonSchema: converter,
    }),
  }) as EngineSchema<JsonObject>;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/**
 * A gateway-owned contract that validates its own input: `check` returns an
 * issue message, or `undefined` when the object is valid.
 */
export function checkedContract(
  document: JsonObject,
  check: (value: JsonObject) => string | undefined,
): EngineSchema<JsonObject> {
  const published = jsonSchemaContract(document);
  const standard = published["~standard"];
  return Object.freeze({
    "~standard": Object.freeze({
      version: 1 as const,
      vendor: standard.vendor,
      validate(value: unknown) {
        if (!isJsonObject(value)) return { issues: notAnObjectIssues };
        const issue = check(value);
        return issue === undefined
          ? { value }
          : { issues: Object.freeze([Object.freeze({ message: issue })]) };
      },
      jsonSchema: standard.jsonSchema,
    }),
  }) as EngineSchema<JsonObject>;
}
