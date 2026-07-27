import { types as nodeUtilTypes } from "node:util";

import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";

import { EngineError, type EngineErrorCode } from "./error.js";

export interface EngineSchema<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output> &
    StandardJSONSchemaV1.Props<Input, Output>;
}

export type InferSchemaInput<Schema extends EngineSchema> =
  StandardSchemaV1.InferInput<Schema>;

export type InferSchemaOutput<Schema extends EngineSchema> =
  StandardSchemaV1.InferOutput<Schema>;

export type EngineJsonSchema = Readonly<Record<string, unknown>>;

const nonJsonValueDetails = Object.freeze({
  issues: Object.freeze([
    Object.freeze({
      message:
        "The validated value is not safely JSON-serializable without data loss.",
    }),
  ]),
});

function rejectNonJsonValue(): never {
  throw new TypeError(
    "The validated value is outside the supported JSON data model.",
  );
}

function hasInheritedJsonRepresentation(prototype: object | null): boolean {
  let current = prototype;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "toJSON");
    if (descriptor !== undefined) {
      return !("value" in descriptor) || typeof descriptor.value === "function";
    }
    current = Object.getPrototypeOf(current);
  }
  return false;
}

function assertJsonValue(value: unknown, ancestors: Set<object>): void {
  if (value === null) return;

  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        rejectNonJsonValue();
      }
      return;
    case "object":
      break;
    default:
      rejectNonJsonValue();
  }

  if (nodeUtilTypes.isProxy(value)) rejectNonJsonValue();
  if (ancestors.has(value)) rejectNonJsonValue();

  const prototype = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (
    isArray
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  ) {
    rejectNonJsonValue();
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    rejectNonJsonValue();
  }
  if (
    !Object.hasOwn(value, "toJSON") &&
    hasInheritedJsonRepresentation(prototype)
  ) {
    rejectNonJsonValue();
  }

  const keys = Object.keys(value);
  const propertyNames = Object.getOwnPropertyNames(value);
  if (isArray) {
    if (keys.length !== value.length) rejectNonJsonValue();
    if (propertyNames.length !== keys.length + 1) rejectNonJsonValue();
    for (let index = 0; index < keys.length; index += 1) {
      if (keys[index] !== String(index)) rejectNonJsonValue();
    }
    if (!propertyNames.includes("length")) rejectNonJsonValue();
  } else if (propertyNames.length !== keys.length) {
    rejectNonJsonValue();
  }

  ancestors.add(value);
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        rejectNonJsonValue();
      }
      assertJsonValue(descriptor.value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function assertSafelyJsonSerializable(
  value: unknown,
  options: {
    code: Extract<EngineErrorCode, "INPUT_INVALID" | "OUTPUT_INVALID">;
    message: string;
  },
): void {
  try {
    assertJsonValue(value, new Set());
    if (JSON.stringify(value) === undefined) rejectNonJsonValue();
  } catch (cause) {
    throw new EngineError({
      code: options.code,
      message: options.message,
      publicDetails: nonJsonValueDetails,
      cause,
    });
  }
}

function normalizePath(
  path: ReadonlyArray<PropertyKey | StandardSchemaV1.PathSegment> | undefined,
): ReadonlyArray<string | number> | undefined {
  if (path === undefined) return undefined;
  return path.map((segment) => {
    const key =
      typeof segment === "object" && segment !== null && "key" in segment
        ? segment.key
        : segment;
    return typeof key === "number" ? key : String(key);
  });
}

function normalizeIssues(
  issues: ReadonlyArray<StandardSchemaV1.Issue>,
): ReadonlyArray<{ message: string; path?: ReadonlyArray<string | number> }> {
  return issues.map((issue) => {
    const path = normalizePath(issue.path);
    return path === undefined
      ? { message: issue.message }
      : { message: issue.message, path };
  });
}

export async function validateSchema<Schema extends EngineSchema>(
  schema: Schema,
  value: unknown,
  options: {
    code: Extract<EngineErrorCode, "INPUT_INVALID" | "OUTPUT_INVALID">;
    message: string;
  },
): Promise<InferSchemaOutput<Schema>> {
  let result: StandardSchemaV1.Result<InferSchemaOutput<Schema>>;
  try {
    result = await schema["~standard"].validate(value);
  } catch (cause) {
    throw new EngineError({
      code: options.code,
      message: options.message,
      cause,
    });
  }

  if (result.issues !== undefined) {
    throw new EngineError({
      code: options.code,
      message: options.message,
      publicDetails: { issues: normalizeIssues(result.issues) },
      cause: result.issues,
    });
  }
  assertSafelyJsonSerializable(result.value, options);
  return result.value;
}

export function readJsonSchema(
  schema: EngineSchema,
  side: "input" | "output",
): EngineJsonSchema {
  return schema["~standard"].jsonSchema[side]({ target: "draft-2020-12" });
}
