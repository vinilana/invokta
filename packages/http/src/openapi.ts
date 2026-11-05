import type {
  CapabilityDescription,
  CapabilityMap,
  Engine,
  EngineJsonSchema,
} from "@invokta/core";

const DEFAULT_BASE_PATH = "/";
const MAX_BASE_PATH_BYTES = 256;
const BASE_PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/u;
const UNSAFE_COMPONENT_CHARACTER = /[^A-Za-z0-9._-]/gu;
const COMPONENT_SCHEMAS = "#/components/schemas/";

export interface HttpOpenApiDocumentOptions {
  /**
   * The mount path of the HTTP routes. Defaults to `/`. It becomes the
   * document's single relative server URL, so the document does not name a
   * host or scheme.
   */
  readonly basePath?: string;
  /**
   * `bearer` (the default) declares the HTTP Bearer scheme the adapter's 401
   * challenge advertises; `none` describes a development handler whose
   * authentication is disabled.
   */
  readonly security?: "bearer" | "none";
}

export interface HttpOpenApiDocument {
  readonly openapi: string;
  readonly jsonSchemaDialect: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly servers: ReadonlyArray<{ readonly url: string }>;
  readonly paths: Readonly<Record<string, unknown>>;
  readonly components: Readonly<Record<string, unknown>>;
  readonly security?: ReadonlyArray<
    Readonly<Record<string, ReadonlyArray<string>>>
  >;
}

/**
 * Validates a base path once. The rule matches the MCP mount-path rule
 * without its `mcp` suffix: `/`, or an absolute path of unreserved ASCII
 * segments without dot segments, empty segments, percent encoding, a query, a
 * fragment, or a trailing slash, at most 256 bytes.
 */
export function normalizeBasePath(value: string | undefined): string {
  if (value === undefined) return DEFAULT_BASE_PATH;
  const invalid = (): TypeError =>
    new TypeError(
      `basePath must be "/" or an absolute path of unreserved ASCII segments, without dot segments, percent encoding, query, fragment, or trailing slash, and at most ${String(MAX_BASE_PATH_BYTES)} bytes.`,
    );
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_BASE_PATH_BYTES ||
    !value.startsWith("/")
  ) {
    throw invalid();
  }
  if (value === DEFAULT_BASE_PATH) return value;
  for (const segment of value.slice(1).split("/")) {
    if (
      !BASE_PATH_SEGMENT.test(segment) ||
      segment === "." ||
      segment === ".."
    ) {
      throw invalid();
    }
  }
  return value;
}

/** The capability route below the base path, with the ID as one segment. */
export function capabilityRoutePath(capabilityId: string): string {
  return `/capabilities/${encodeURIComponent(capabilityId)}`;
}

function normalizeSecurity(
  value: HttpOpenApiDocumentOptions["security"],
): "bearer" | "none" {
  if (value === undefined) return "bearer";
  if (value === "bearer" || value === "none") return value;
  throw new TypeError('security must be either "bearer" or "none".');
}

const schemaKeywords = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const schemaArrayKeywords = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaMapKeywords = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);
const referenceKeywords = new Set(["$ref", "$dynamicRef"]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Copies one schema into `#/components/schemas/<name>`. JSON Schema resolves a
 * local `#` or `#/...` reference against the enclosing resource; once the
 * schema is embedded without its own `$id`, that resource is the OpenAPI
 * document, so those references are rebased onto the component. Only
 * reference keywords in schema positions change: data such as `const`,
 * `enum`, `default`, and `examples`, every other reference form, and every
 * subschema that declares its own `$id` are copied verbatim.
 */
function relocateSchema(schema: unknown, componentPointer: string): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => relocateSchema(item, componentPointer));
  }
  if (!isRecord(schema)) return structuredClone(schema);
  if (typeof schema.$id === "string") return structuredClone(schema);
  const relocated: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(schema)) {
    if (referenceKeywords.has(keyword) && typeof value === "string") {
      relocated[keyword] =
        value === "#"
          ? componentPointer
          : value.startsWith("#/")
            ? `${componentPointer}${value.slice(1)}`
            : value;
    } else if (
      schemaKeywords.has(keyword) ||
      schemaArrayKeywords.has(keyword)
    ) {
      relocated[keyword] = relocateSchema(value, componentPointer);
    } else if (schemaMapKeywords.has(keyword) && isRecord(value)) {
      const members: Record<string, unknown> = {};
      for (const [name, member] of Object.entries(value)) {
        members[name] = relocateSchema(member, componentPointer);
      }
      relocated[keyword] = members;
    } else if (keyword === "dependencies" && isRecord(value)) {
      const members: Record<string, unknown> = {};
      for (const [name, member] of Object.entries(value)) {
        members[name] = isRecord(member)
          ? relocateSchema(member, componentPointer)
          : structuredClone(member);
      }
      relocated[keyword] = members;
    } else {
      relocated[keyword] = structuredClone(value);
    }
  }
  return relocated;
}

function componentBaseNames(
  capabilityIds: ReadonlyArray<string>,
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const capabilityId of capabilityIds) {
    const base = capabilityId.replace(UNSAFE_COMPONENT_CHARACTER, "_") || "_";
    let name = base;
    for (let suffix = 2; used.has(name); suffix += 1) {
      name = `${base}-${String(suffix)}`;
    }
    used.add(name);
    names.set(capabilityId, name);
  }
  return names;
}

function jsonContent(schemaName: string) {
  return {
    "application/json": {
      schema: { $ref: `${COMPONENT_SCHEMAS}${schemaName}` },
    },
  };
}

function errorResponses(statuses: ReadonlyArray<string>) {
  const responses: Record<string, unknown> = {};
  for (const status of statuses) {
    responses[status] = {
      $ref:
        status === "401"
          ? "#/components/responses/Unauthenticated"
          : "#/components/responses/Error",
    };
  }
  return responses;
}

const annotationsSchema = {
  type: "object",
  properties: {
    readOnly: { type: "boolean" },
    destructive: { type: "boolean" },
    idempotent: { type: "boolean" },
    openWorld: { type: "boolean" },
  },
};

function summaryProperties() {
  return {
    id: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    annotations: structuredClone(annotationsSchema),
  };
}

function fixedSchemas() {
  return {
    CapabilitySummary: {
      type: "object",
      required: ["id", "description"],
      properties: summaryProperties(),
    },
    CapabilityDescription: {
      type: "object",
      required: ["id", "description", "inputSchema", "outputSchema"],
      properties: {
        ...summaryProperties(),
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        timeoutMs: { type: "integer", minimum: 1, maximum: 2_147_483_647 },
      },
    },
    CapabilityList: {
      type: "object",
      required: ["capabilities"],
      properties: {
        capabilities: {
          type: "array",
          items: { $ref: `${COMPONENT_SCHEMAS}CapabilitySummary` },
        },
      },
    },
    Error: {
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["code", "message"],
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            publicDetails: {},
          },
        },
      },
    },
  };
}

function schemaComponent(
  schema: EngineJsonSchema,
  name: string,
): Readonly<Record<string, unknown>> {
  return relocateSchema(schema, `${COMPONENT_SCHEMAS}${name}`) as Readonly<
    Record<string, unknown>
  >;
}

/**
 * Generates an OpenAPI 3.1 description of the `@invokta/http` routes from
 * `engine.list()` and `engine.describe()` only. It publishes no information
 * those methods do not already publish. Each call returns a new plain JSON
 * object that a host may post-process before publishing it elsewhere.
 */
export function createHttpOpenApiDocument<Capabilities extends CapabilityMap>(
  engine: Engine<Capabilities>,
  options: HttpOpenApiDocumentOptions = {},
): HttpOpenApiDocument {
  if (options === null || typeof options !== "object") {
    throw new TypeError("options must be an object.");
  }
  const basePath = normalizeBasePath(options.basePath);
  const security = normalizeSecurity(options.security);
  const secured = security === "bearer";
  const readErrors = secured ? ["401", "403", "500"] : ["403", "500"];
  const describeErrors = secured
    ? ["401", "403", "404", "500"]
    : ["403", "404", "500"];
  const invokeErrors = ["400", "401", "403", "404", "413", "415", "500", "503"];

  const descriptions: CapabilityDescription[] = engine
    .list()
    .map((summary) =>
      engine.describe(summary.id as Extract<keyof Capabilities, string>),
    );
  const names = componentBaseNames(
    descriptions.map((description) => description.id),
  );
  const schemas: Record<string, unknown> = fixedSchemas();
  const paths: Record<string, unknown> = {
    "/capabilities": {
      get: {
        operationId: "listCapabilities",
        summary: "List capabilities",
        responses: {
          "200": {
            description: "The published capability catalog.",
            content: jsonContent("CapabilityList"),
          },
          ...errorResponses(readErrors),
        },
      },
    },
  };

  for (const description of descriptions) {
    const name = names.get(description.id) ?? "_";
    const inputName = `${name}.Input`;
    const outputName = `${name}.Output`;
    schemas[inputName] = schemaComponent(description.inputSchema, inputName);
    schemas[outputName] = schemaComponent(description.outputSchema, outputName);
    paths[capabilityRoutePath(description.id)] = {
      get: {
        operationId: `describe.${description.id}`,
        summary: `Describe ${description.id}`,
        responses: {
          "200": {
            description: "The published capability contract.",
            content: jsonContent("CapabilityDescription"),
          },
          ...errorResponses(describeErrors),
        },
      },
      post: {
        operationId: `invoke.${description.id}`,
        summary: description.title ?? `Invoke ${description.id}`,
        description: description.description,
        requestBody: {
          required: true,
          content: jsonContent(inputName),
        },
        responses: {
          "200": {
            description: "The validated capability output.",
            content: jsonContent(outputName),
          },
          ...errorResponses(invokeErrors),
        },
      },
    };
  }

  const components: Record<string, unknown> = {
    schemas,
    responses: {
      Error: {
        description: "A sanitized error.",
        content: jsonContent("Error"),
      },
      Unauthenticated: {
        description: "Authentication is required.",
        headers: {
          "WWW-Authenticate": {
            description: "The Bearer authentication challenge.",
            schema: { type: "string" },
          },
        },
        content: jsonContent("Error"),
      },
    },
    ...(secured
      ? { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } }
      : {}),
  };

  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: { title: engine.name, version: engine.version },
    servers: [{ url: basePath }],
    paths,
    components,
    ...(secured ? { security: [{ bearerAuth: [] }] } : {}),
  };
}
