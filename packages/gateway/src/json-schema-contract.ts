import type { EngineSchema } from "@invokta/core";

export type JsonObject = Readonly<Record<string, unknown>>;

/** One failed check reported by a JSON Schema validator. */
export interface JsonSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<string | number>;
}

/**
 * Validates a JSON value against a JSON Schema document, for example with
 * Ajv. It is synchronous and returns the failed checks, or `undefined` or an
 * empty list when the value is valid; a returned promise fails closed. The
 * gateway passes the same frozen document object on every call, so a
 * validator may compile it once and cache it by identity. It must not change
 * the value, which is the caller's input. MCP schemas are chosen by the
 * server: refuse asynchronous schemas and run `pattern` keywords on a
 * linear-time regular expression engine.
 */
export type JsonSchemaValidator = (
  schema: JsonObject,
  value: JsonObject,
) => ReadonlyArray<JsonSchemaIssue> | undefined;

const notAnObjectIssues = Object.freeze([
  Object.freeze({ message: "Expected a JSON object." }),
]);
const unvalidatedIssues = Object.freeze([
  Object.freeze({ message: "The value could not be validated." }),
]);
const MAX_ISSUES = 100;
const MAX_ISSUE_MESSAGE_LENGTH = 512;

/** Copies at most 100 issues with bounded messages; anything else fails closed. */
function snapshotIssues(
  issues: unknown,
): ReadonlyArray<JsonSchemaIssue> | undefined {
  if (issues === undefined) return undefined;
  // A promise or any other non-list cannot prove the value valid.
  if (!Array.isArray(issues)) return unvalidatedIssues;
  if (issues.length === 0) return undefined;
  return Object.freeze(
    issues.slice(0, MAX_ISSUES).map((issue: unknown) => {
      const { message, path } = (issue ?? {}) as {
        readonly message?: unknown;
        readonly path?: unknown;
      };
      const validPath =
        Array.isArray(path) &&
        path.every(
          (segment) =>
            typeof segment === "string" ||
            (typeof segment === "number" && Number.isInteger(segment)),
        );
      return Object.freeze({
        message:
          typeof message === "string" && message !== ""
            ? message.slice(0, MAX_ISSUE_MESSAGE_LENGTH)
            : "The value does not match the schema.",
        ...(validPath
          ? { path: Object.freeze([...(path as (string | number)[])]) }
          : {}),
      });
    }),
  );
}

/**
 * Wraps a JSON Schema document published by an upstream as an engine schema.
 *
 * The gateway republishes the document unchanged. It always checks that the
 * value is a JSON object; with a `validator`, it also validates the value
 * against the document, so invalid input fails as `INPUT_INVALID` before the
 * upstream is called and an invalid result fails as `OUTPUT_INVALID`. A
 * validator that throws or returns anything but a list or `undefined`,
 * including a promise, fails closed. The core still enforces the lossless
 * JSON data model on every value.
 */
export function jsonSchemaContract(
  document: JsonObject,
  validator?: JsonSchemaValidator,
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
        if (!isJsonObject(value)) return { issues: notAnObjectIssues };
        if (validator === undefined) return { value };
        let issues: ReadonlyArray<JsonSchemaIssue> | undefined;
        try {
          const result: unknown = validator(snapshot, value);
          if (isThenable(result)) {
            // A promise cannot prove the value valid. Observe its rejection so
            // it cannot surface as an unhandled rejection, then fail closed.
            result.then(undefined, () => undefined);
            issues = unvalidatedIssues;
          } else {
            issues = snapshotIssues(result);
          }
        } catch {
          issues = unvalidatedIssues;
        }
        return issues === undefined ? { value } : { issues };
      },
      jsonSchema: converter,
    }),
  }) as EngineSchema<JsonObject>;
}

function isThenable(
  value: unknown,
): value is { then(onFulfilled: undefined, onRejected: () => void): unknown } {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) {
    return false;
  }
  try {
    return typeof (value as { readonly then?: unknown }).then === "function";
  } catch {
    // A throwing `then` getter is not a usable promise; it still fails closed.
    return false;
  }
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
