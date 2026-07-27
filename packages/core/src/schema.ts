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

function assertJsonValue(
  value: unknown,
  ancestors: Set<object>,
  ignoredOwnProperty?: string,
): void {
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
    const unexpectedProperty = propertyNames.find(
      (propertyName) =>
        !keys.includes(propertyName) && propertyName !== ignoredOwnProperty,
    );
    if (unexpectedProperty !== undefined) rejectNonJsonValue();
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

function freezeJsonValue<Value>(value: Value, visited: Set<object>): Value {
  if (typeof value !== "object" || value === null || visited.has(value)) {
    return value;
  }
  visited.add(value);
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      freezeJsonValue(descriptor.value, visited);
    }
  }
  return Object.freeze(value);
}

function assertLosslessJson(value: unknown, ignoredOwnProperty?: string): void {
  assertJsonValue(value, new Set(), ignoredOwnProperty);
  if (JSON.stringify(value) === undefined) rejectNonJsonValue();
}

export function snapshotLosslessJson<Value>(value: Value): Value {
  assertLosslessJson(value);
  return freezeJsonValue(structuredClone(value), new Set());
}

function snapshotJsonSchemaDocument(value: unknown): EngineJsonSchema {
  assertLosslessJson(value, "~standard");
  return freezeJsonValue(structuredClone(value), new Set()) as EngineJsonSchema;
}

function assertSafelyJsonSerializable(
  value: unknown,
  options: {
    code: Extract<EngineErrorCode, "INPUT_INVALID" | "OUTPUT_INVALID">;
    message: string;
  },
): void {
  try {
    assertLosslessJson(value);
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
  path: unknown,
): ReadonlyArray<string | number> | undefined {
  if (path === undefined) return undefined;
  if (!Array.isArray(path) || nodeUtilTypes.isProxy(path)) {
    throw new TypeError("A validation issue path must be an array.");
  }
  const normalized: Array<string | number> = [];
  for (let index = 0; index < path.length; index += 1) {
    const segment: unknown = path[index];
    let key: unknown = segment;
    if (typeof segment === "object" && segment !== null) {
      if (nodeUtilTypes.isProxy(segment) || !("key" in segment)) {
        throw new TypeError("A validation path segment is malformed.");
      }
      key = (segment as StandardSchemaV1.PathSegment).key;
    }
    if (typeof key === "number") {
      if (!Number.isFinite(key) || Object.is(key, -0)) {
        throw new TypeError("A numeric validation path segment is invalid.");
      }
      normalized.push(key);
    } else if (typeof key === "string" || typeof key === "symbol") {
      normalized.push(String(key));
    } else {
      throw new TypeError("A validation path segment is malformed.");
    }
  }
  return normalized;
}

function normalizeIssues(
  issues: unknown,
): ReadonlyArray<{ message: string; path?: ReadonlyArray<string | number> }> {
  if (!Array.isArray(issues) || nodeUtilTypes.isProxy(issues)) {
    throw new TypeError("Validation issues must be an array.");
  }
  const normalized: Array<{
    message: string;
    path?: ReadonlyArray<string | number>;
  }> = [];
  for (let index = 0; index < issues.length; index += 1) {
    const issue: unknown = issues[index];
    if (
      typeof issue !== "object" ||
      issue === null ||
      nodeUtilTypes.isProxy(issue)
    ) {
      throw new TypeError("A validation issue is malformed.");
    }
    const message = (issue as StandardSchemaV1.Issue).message;
    if (typeof message !== "string") {
      throw new TypeError("A validation issue message must be a string.");
    }
    const path = normalizePath((issue as StandardSchemaV1.Issue).path);
    normalized.push(path === undefined ? { message } : { message, path });
  }
  return normalized;
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

  let issues: unknown;
  let normalizedIssues:
    | ReadonlyArray<{
        message: string;
        path?: ReadonlyArray<string | number>;
      }>
    | undefined;
  let validatedValue: InferSchemaOutput<Schema> | undefined;
  try {
    if (
      typeof result !== "object" ||
      result === null ||
      nodeUtilTypes.isProxy(result)
    ) {
      throw new TypeError("The schema validator returned a malformed result.");
    }
    const validatorResult = result as {
      readonly issues?: unknown;
      readonly value?: InferSchemaOutput<Schema>;
    };
    issues = validatorResult.issues;
    if (issues === undefined) {
      validatedValue = validatorResult.value;
    } else {
      normalizedIssues = normalizeIssues(issues);
    }
  } catch (cause) {
    throw new EngineError({
      code: options.code,
      message: options.message,
      cause,
    });
  }

  if (issues !== undefined) {
    throw new EngineError({
      code: options.code,
      message: options.message,
      publicDetails: { issues: normalizedIssues },
      cause: issues,
    });
  }
  assertSafelyJsonSerializable(validatedValue, options);
  return validatedValue as InferSchemaOutput<Schema>;
}

export function readJsonSchema(
  schema: EngineSchema,
  side: "input" | "output",
): EngineJsonSchema {
  if (nodeUtilTypes.isProxy(schema)) {
    throw new TypeError("A schema contract must not be a proxy.");
  }
  const standard = schema["~standard"];
  if (
    typeof standard !== "object" ||
    standard === null ||
    nodeUtilTypes.isProxy(standard)
  ) {
    throw new TypeError("A schema contract is malformed.");
  }
  const jsonSchema = readDataProperty(standard, "jsonSchema");
  if (
    typeof jsonSchema !== "object" ||
    jsonSchema === null ||
    nodeUtilTypes.isProxy(jsonSchema)
  ) {
    throw new TypeError("A JSON Schema contract is malformed.");
  }
  const converter = readDataProperty(jsonSchema, side);
  if (typeof converter !== "function") {
    throw new TypeError(`A JSON Schema ${side} converter is required.`);
  }
  const document: unknown = Reflect.apply(converter, jsonSchema, [
    { target: "draft-2020-12" },
  ]);
  return snapshotJsonSchemaDocument(document);
}

function readDataProperty(value: object, key: PropertyKey): unknown {
  let current: object | null = value;
  while (current !== null) {
    if (nodeUtilTypes.isProxy(current)) {
      throw new TypeError("A schema contract must not contain a proxy.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) {
        throw new TypeError("A schema contract must use data properties.");
      }
      return descriptor.value;
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}
