import {
  createEngine,
  defineCapability,
  type EngineSchema,
} from "@invokta/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createHttpOpenApiDocument,
  type HttpOpenApiDocumentOptions,
} from "../src/index.js";

type JsonObject = Readonly<Record<string, unknown>>;

const componentName = /^[a-zA-Z0-9.\-_]+$/u;

function jsonSchemaContract(
  input: JsonObject,
  output: JsonObject,
): EngineSchema<Record<string, unknown>> {
  return {
    "~standard": {
      version: 1,
      vendor: "invokta-test",
      validate: (value) => ({ value: value as Record<string, unknown> }),
      jsonSchema: {
        input: () => structuredClone(input) as Record<string, unknown>,
        output: () => structuredClone(output) as Record<string, unknown>,
      },
    },
  };
}

function createCatalogEngine() {
  return createEngine({
    name: "catalog-engine",
    version: "2.0.1",
    capabilities: {
      "support.classify-ticket": defineCapability({
        title: "Classify ticket",
        description: "Classifies a support ticket.",
        input: z.object({ ticketId: z.string().min(1) }),
        output: z.object({
          category: z.enum(["billing", "technical"]),
          confidence: z.number(),
        }),
        access: () => true,
        timeoutMs: 30_000,
        annotations: { readOnly: true, openWorld: false },
        async run() {
          return { category: "billing" as const, confidence: 1 };
        },
      }),
      "support.close-ticket": defineCapability({
        description: "Closes a support ticket.",
        input: z.object({ ticketId: z.string() }),
        output: z.object({ closed: z.boolean() }),
        access: "authenticated",
        async run() {
          return { closed: true };
        },
      }),
    },
  });
}

function resolvePointer(document: unknown, reference: string): unknown {
  expect(reference.startsWith("#")).toBe(true);
  const pointer = decodeURIComponent(reference.slice(1));
  if (pointer === "") return document;
  expect(pointer.startsWith("/")).toBe(true);
  let current: unknown = document;
  for (const token of pointer.slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    expect(
      typeof current === "object" &&
        current !== null &&
        Object.hasOwn(current, key),
      `${reference} does not resolve at ${key}`,
    ).toBe(true);
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function collectReferences(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, found);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (key === "$ref" && typeof item === "string") found.push(item);
      else collectReferences(item, found);
    }
  }
  return found;
}

interface Operation {
  readonly operationId: string;
  readonly summary?: string;
  readonly description?: string;
  readonly requestBody?: {
    readonly required: boolean;
    readonly content: {
      readonly "application/json": {
        readonly schema: { readonly $ref: string };
      };
    };
  };
  readonly responses: Readonly<
    Record<
      string,
      {
        readonly $ref?: string;
        readonly description?: string;
        readonly content?: {
          readonly "application/json": {
            readonly schema: { readonly $ref: string };
          };
        };
      }
    >
  >;
}

function operation(
  document: ReturnType<typeof createHttpOpenApiDocument>,
  path: string,
  method: "get" | "post",
): Operation {
  const item = document.paths[path] as Readonly<Record<string, Operation>>;
  expect(item, path).toBeDefined();
  const value = item[method];
  expect(value, `${method} ${path}`).toBeDefined();
  return value as Operation;
}

describe("createHttpOpenApiDocument", () => {
  it("describes the HTTP routes as an OpenAPI 3.1 document", () => {
    const engine = createCatalogEngine();
    const document = createHttpOpenApiDocument(engine);

    expect(document.openapi).toBe("3.1.0");
    expect(document.jsonSchemaDialect).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(document.info).toEqual({
      title: "catalog-engine",
      version: "2.0.1",
    });
    expect(document.servers).toEqual([{ url: "/" }]);
    expect(Object.keys(document.paths).sort()).toEqual([
      "/capabilities",
      "/capabilities/support.classify-ticket",
      "/capabilities/support.close-ticket",
    ]);

    const operationIds: string[] = [];
    for (const [path, item] of Object.entries(document.paths)) {
      expect(path.startsWith("/")).toBe(true);
      for (const [method, value] of Object.entries(
        item as Readonly<Record<string, Operation>>,
      )) {
        expect(["get", "post"]).toContain(method);
        operationIds.push(value.operationId);
        expect(Object.keys(value.responses).length).toBeGreaterThan(0);
        for (const [status, response] of Object.entries(value.responses)) {
          expect(status).toMatch(/^[1-5]\d\d$/u);
          const resolved = (
            response.$ref === undefined
              ? response
              : resolvePointer(document, response.$ref)
          ) as { readonly description?: unknown };
          expect(typeof resolved.description).toBe("string");
        }
      }
    }
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(operationIds.sort()).toEqual([
      "describe.support.classify-ticket",
      "describe.support.close-ticket",
      "invoke.support.classify-ticket",
      "invoke.support.close-ticket",
      "listCapabilities",
    ]);

    for (const name of Object.keys(document.components.schemas as object)) {
      expect(name).toMatch(componentName);
    }
    for (const reference of collectReferences(document)) {
      expect(resolvePointer(document, reference)).toBeDefined();
    }
  });

  it("publishes exactly the schemas and metadata returned by describe()", () => {
    const engine = createCatalogEngine();
    const document = createHttpOpenApiDocument(engine);

    for (const summary of engine.list()) {
      const description = engine.describe(summary.id as never);
      const path = `/capabilities/${encodeURIComponent(summary.id)}`;
      const invoke = operation(document, path, "post");

      expect(invoke.description).toBe(description.description);
      expect(invoke.summary).toBe(description.title ?? `Invoke ${summary.id}`);
      expect(invoke.requestBody?.required).toBe(true);
      expect(
        resolvePointer(
          document,
          invoke.requestBody?.content["application/json"].schema.$ref ?? "",
        ),
      ).toEqual(description.inputSchema);
      expect(
        resolvePointer(
          document,
          invoke.responses["200"]?.content?.["application/json"].schema.$ref ??
            "",
        ),
      ).toEqual(description.outputSchema);
      expect(Object.keys(invoke.responses).sort()).toEqual([
        "200",
        "400",
        "401",
        "403",
        "404",
        "413",
        "415",
        "500",
        "503",
      ]);

      const describeOperation = operation(document, path, "get");
      expect(
        resolvePointer(
          document,
          describeOperation.responses["200"]?.content?.["application/json"]
            .schema.$ref ?? "",
        ),
      ).toMatchObject({ type: "object" });
    }

    expect(JSON.stringify(document)).not.toMatch(/"(?:access|run)"/u);
  });

  it("declares bearer security by default and none on request", () => {
    const engine = createCatalogEngine();

    const secured = createHttpOpenApiDocument(engine);
    expect(secured.security).toEqual([{ bearerAuth: [] }]);
    expect(secured.components.securitySchemes).toEqual({
      bearerAuth: { type: "http", scheme: "bearer" },
    });
    expect(
      Object.keys(operation(secured, "/capabilities", "get").responses),
    ).toContain("401");

    const open = createHttpOpenApiDocument(engine, { security: "none" });
    expect(open.security).toBeUndefined();
    expect(open.components.securitySchemes).toBeUndefined();
    expect(
      Object.keys(operation(open, "/capabilities", "get").responses),
    ).not.toContain("401");
    expect(
      Object.keys(
        operation(open, "/capabilities/support.close-ticket", "post").responses,
      ),
    ).toContain("401");
  });

  it("uses the base path as a relative server URL", () => {
    const document = createHttpOpenApiDocument(createCatalogEngine(), {
      basePath: "/api/support",
    });

    expect(document.servers).toEqual([{ url: "/api/support" }]);
    expect(Object.keys(document.paths)).toContain("/capabilities");
  });

  it("relocates local schema references into the component that owns them", () => {
    const input = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        root: { $ref: "#/$defs/Node" },
        self: { $ref: "#" },
        literal: { const: { $ref: "#/not-a-reference" } },
        external: { $ref: "https://schemas.example/node.json" },
        anchored: { $ref: "#node" },
        embedded: {
          $id: "https://schemas.example/embedded.json",
          $defs: { leaf: { type: "string" } },
          $ref: "#/$defs/leaf",
        },
        list: {
          type: "array",
          prefixItems: [{ $ref: "#/$defs/Node" }],
          items: { $ref: "#/$defs/Node" },
        },
        $ref: { type: "string" },
      },
      $defs: {
        Node: {
          $anchor: "node",
          type: "object",
          properties: {
            children: { type: "array", items: { $ref: "#/$defs/Node" } },
          },
          anyOf: [{ $ref: "#/$defs/Node" }, { type: "null" }],
        },
      },
    };
    const output = { type: "object", properties: {} };
    const engine = createEngine({
      name: "recursive-engine",
      version: "1.0.0",
      capabilities: {
        "graph.walk": defineCapability({
          description: "Walks a graph.",
          input: jsonSchemaContract(input, output),
          output: jsonSchemaContract(output, output),
          access: "public",
          async run() {
            return {};
          },
        }),
      },
    });

    const document = createHttpOpenApiDocument(engine);
    const schemas = document.components.schemas as Readonly<
      Record<string, JsonObject>
    >;
    const relocated = schemas["graph.walk.Input"] as {
      readonly properties: Readonly<Record<string, JsonObject>>;
      readonly $defs: Readonly<Record<string, JsonObject>>;
    };
    const base = "#/components/schemas/graph.walk.Input";

    expect(relocated.properties.root).toEqual({ $ref: `${base}/$defs/Node` });
    expect(relocated.properties.self).toEqual({ $ref: base });
    expect(relocated.properties.literal).toEqual({
      const: { $ref: "#/not-a-reference" },
    });
    expect(relocated.properties.external).toEqual({
      $ref: "https://schemas.example/node.json",
    });
    expect(relocated.properties.anchored).toEqual({ $ref: "#node" });
    expect(relocated.properties.embedded).toEqual(input.properties.embedded);
    expect(relocated.properties.list).toEqual({
      type: "array",
      prefixItems: [{ $ref: `${base}/$defs/Node` }],
      items: { $ref: `${base}/$defs/Node` },
    });
    expect(relocated.properties.$ref).toEqual({ type: "string" });
    expect(relocated.$defs.Node).toEqual({
      $anchor: "node",
      type: "object",
      properties: {
        children: { type: "array", items: { $ref: `${base}/$defs/Node` } },
      },
      anyOf: [{ $ref: `${base}/$defs/Node` }, { type: "null" }],
    });
    expect(resolvePointer(document, `${base}/$defs/Node`)).toBe(
      relocated.$defs.Node,
    );
    expect(resolvePointer(document, base)).toBe(relocated);
  });

  it("derives unique component names and encoded paths from arbitrary capability IDs", () => {
    const schema = z.object({});
    const capability = defineCapability({
      description: "Does nothing.",
      input: schema,
      output: schema,
      access: "public",
      async run() {
        return {};
      },
    });
    const engine = createEngine({
      name: "names-engine",
      version: "1.0.0",
      capabilities: {
        "a b": capability,
        a_b: capability,
        "a/b": capability,
        "": capability,
      },
    });

    const document = createHttpOpenApiDocument(engine);

    expect(Object.keys(document.components.schemas as object)).toEqual(
      expect.arrayContaining([
        "a_b.Input",
        "a_b.Output",
        "a_b-2.Input",
        "a_b-3.Input",
        "_.Input",
      ]),
    );
    for (const name of Object.keys(document.components.schemas as object)) {
      expect(name).toMatch(componentName);
    }
    expect(Object.keys(document.paths).sort()).toEqual([
      "/capabilities",
      "/capabilities/",
      "/capabilities/a%20b",
      "/capabilities/a%2Fb",
      "/capabilities/a_b",
    ]);
    expect(operation(document, "/capabilities/a%2Fb", "post").operationId).toBe(
      "invoke.a/b",
    );
  });

  it("returns a fresh mutable document without exposing engine snapshots", () => {
    const engine = createCatalogEngine();
    const first = createHttpOpenApiDocument(engine) as unknown as {
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    const schema = first.components.schemas["support.classify-ticket.Input"];
    expect(schema).toBeDefined();
    expect(Object.isFrozen(schema)).toBe(false);
    if (schema !== undefined) schema.type = "string";

    expect(
      (
        createHttpOpenApiDocument(engine).components.schemas as Record<
          string,
          JsonObject
        >
      )["support.classify-ticket.Input"]?.type,
    ).toBe("object");
    expect(engine.describe("support.classify-ticket").inputSchema.type).toBe(
      "object",
    );
  });

  it("rejects invalid options", () => {
    const engine = createCatalogEngine();
    for (const options of [
      { security: "basic" },
      { basePath: "api" },
      { basePath: "/api/" },
    ]) {
      expect(() =>
        createHttpOpenApiDocument(
          engine,
          options as unknown as HttpOpenApiDocumentOptions,
        ),
      ).toThrow(TypeError);
    }
  });
});
