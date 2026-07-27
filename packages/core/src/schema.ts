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
  return result.value;
}

export function readJsonSchema(
  schema: EngineSchema,
  side: "input" | "output",
): EngineJsonSchema {
  return schema["~standard"].jsonSchema[side]({ target: "draft-2020-12" });
}
