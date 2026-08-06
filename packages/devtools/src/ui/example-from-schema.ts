type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type SchemaRecord = Readonly<Record<string, unknown>>;

const maxDepth = 8;

function asSchema(value: unknown): SchemaRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as SchemaRecord;
}

function resolveRef(root: SchemaRecord, ref: string): SchemaRecord | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as SchemaRecord)[segment];
  }
  return asSchema(current);
}

function firstType(schema: SchemaRecord): string | undefined {
  const type = schema.type;
  if (typeof type === "string") return type;
  if (Array.isArray(type) && typeof type[0] === "string") return type[0];
  return undefined;
}

function build(
  schema: SchemaRecord | undefined,
  root: SchemaRecord,
  depth: number,
  seenRefs: ReadonlySet<string>,
): JsonValue {
  if (schema === undefined || depth > maxDepth) return null;

  const ref = schema.$ref;
  if (typeof ref === "string") {
    if (seenRefs.has(ref)) return null;
    return build(
      resolveRef(root, ref),
      root,
      depth + 1,
      new Set([...seenRefs, ref]),
    );
  }

  if (schema.const !== undefined) return schema.const as JsonValue;
  if (schema.default !== undefined) return schema.default as JsonValue;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    return schema.examples[0] as JsonValue;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0] as JsonValue;
  }

  for (const combinator of ["anyOf", "oneOf"] as const) {
    const branches = schema[combinator];
    if (Array.isArray(branches) && branches.length > 0) {
      return build(asSchema(branches[0]), root, depth + 1, seenRefs);
    }
  }
  const allOf = schema.allOf;
  if (Array.isArray(allOf) && allOf.length > 0) {
    const merged: Record<string, unknown> = {};
    for (const branch of allOf) {
      const branchSchema = asSchema(branch);
      if (branchSchema !== undefined) Object.assign(merged, branchSchema);
    }
    delete merged.allOf;
    return build(merged as SchemaRecord, root, depth + 1, seenRefs);
  }

  const type = firstType(schema);
  if (
    type === "object" ||
    (type === undefined && schema.properties !== undefined)
  ) {
    const example: { [key: string]: JsonValue } = {};
    const properties = asSchema(schema.properties);
    if (properties !== undefined) {
      for (const [name, property] of Object.entries(properties)) {
        example[name] = build(asSchema(property), root, depth + 1, seenRefs);
      }
    }
    return example;
  }
  if (type === "array") {
    const item = build(asSchema(schema.items), root, depth + 1, seenRefs);
    return schema.items === undefined ? [] : [item];
  }
  if (type === "string") return "";
  if (type === "number" || type === "integer") return 0;
  if (type === "boolean") return false;
  if (type === "null") return null;
  return null;
}

/**
 * Builds a starter example value from a JSON Schema document so a developer
 * edits real field names instead of typing JSON from scratch. The result is a
 * seed for the invocation editor, not a schema-valid value; validation stays
 * with the engine.
 */
export function exampleFromSchema(schema: unknown): JsonValue {
  const record = asSchema(schema);
  if (record === undefined) return null;
  return build(record, record, 0, new Set());
}
