import {
  createEngine,
  defineCapability,
  type EngineSchema,
} from "@invokta/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createHttpHandler,
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

  it("documents declared domain errors as a 422 response", () => {
    const engine = createEngine({
      name: "domain-engine",
      version: "1.0.0",
      capabilities: {
        "seats.reserve": defineCapability({
          description: "Reserves a seat.",
          input: z.object({ seat: z.string() }),
          output: z.object({ reserved: z.boolean() }),
          access: "public",
          errors: {
            SEAT_TAKEN: {
              description: "The seat is already reserved.",
              details: z.object({ seat: z.string() }),
            },
            SALES_CLOSED: {
              description: "Sales are closed for this event.",
              retryable: true,
            },
          },
          async run() {
            return { reserved: true };
          },
        }),
        "seats.list": defineCapability({
          description: "Lists seats.",
          input: z.object({}),
          output: z.object({}),
          access: "public",
          async run() {
            return {};
          },
        }),
      },
    });
    const document = createHttpOpenApiDocument(engine);
    const declared = engine.describe("seats.reserve").errors ?? [];
    expect(declared).toHaveLength(2);

    const invoke = operation(document, "/capabilities/seats.reserve", "post");
    const response = invoke.responses["422"] as unknown as {
      readonly description: string;
      readonly content: {
        readonly "application/json": {
          readonly schema: {
            readonly oneOf: ReadonlyArray<{
              readonly title: string;
              readonly description: string;
              readonly properties: {
                readonly error: {
                  readonly required: ReadonlyArray<string>;
                  readonly properties: {
                    readonly code: unknown;
                    readonly publicDetails: {
                      readonly required: ReadonlyArray<string>;
                      readonly properties: Readonly<Record<string, unknown>>;
                    };
                  };
                };
              };
            }>;
          };
        };
      };
    };
    expect(response.description).toContain("SEAT_TAKEN");
    expect(response.description).toContain("SALES_CLOSED");
    const branches = response.content["application/json"].schema.oneOf;
    expect(branches.map((branch) => branch.title)).toEqual(
      declared.map((error) => error.code),
    );
    for (const [index, error] of declared.entries()) {
      const branch = branches[index];
      expect(branch?.description).toBe(error.description);
      const envelope = branch?.properties.error;
      expect(envelope?.properties.code).toEqual({ const: "DOMAIN_ERROR" });
      expect(envelope?.required).toContain("publicDetails");
      const details = envelope?.properties.publicDetails;
      expect(details?.required).toEqual(["code", "retryable"]);
      expect(details?.properties.code).toEqual({ const: error.code });
      expect(details?.properties.retryable).toEqual({
        const: error.retryable,
      });
      const detailsSchema = details?.properties.details as
        | { readonly $ref: string }
        | undefined;
      if (error.detailsSchema === undefined) {
        expect(detailsSchema).toBeUndefined();
      } else {
        expect(resolvePointer(document, detailsSchema?.$ref ?? "")).toEqual(
          error.detailsSchema,
        );
      }
    }
    expect(
      Object.keys(
        operation(document, "/capabilities/seats.list", "post").responses,
      ),
    ).not.toContain("422");
    for (const reference of collectReferences(document)) {
      expect(resolvePointer(document, reference)).toBeDefined();
    }
    for (const name of Object.keys(document.components.schemas as object)) {
      expect(name).toMatch(componentName);
    }
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

  it("preserves a property named __proto__", () => {
    const input = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"},"ok":{"type":"number"}},"required":["__proto__"]}',
    ) as JsonObject;
    const output = { type: "object" };
    const engine = createEngine({
      name: "proto-engine",
      version: "1.0.0",
      capabilities: {
        "proto.check": defineCapability({
          description: "Accepts a property named __proto__.",
          input: jsonSchemaContract(input, output),
          output: jsonSchemaContract(output, output),
          access: "public",
          async run() {
            return {};
          },
        }),
      },
    });

    const component = (
      createHttpOpenApiDocument(engine).components.schemas as Readonly<
        Record<string, { readonly properties: object }>
      >
    )["proto.check.Input"];

    expect(Object.hasOwn(component?.properties ?? {}, "__proto__")).toBe(true);
    expect(JSON.stringify(component)).toBe(
      JSON.stringify(engine.describe("proto.check").inputSchema),
    );
  });

  it("keeps rebasing below a fragment-only draft-07 $id", () => {
    const input = {
      type: "object",
      definitions: { leaf: { type: "string" } },
      properties: {
        a: {
          $id: "#plain",
          type: "object",
          properties: { b: { $ref: "#/definitions/leaf" } },
        },
      },
    };
    const output = { type: "object" };
    const engine = createEngine({
      name: "draft7-engine",
      version: "1.0.0",
      capabilities: {
        "draft.check": defineCapability({
          description: "Uses a draft-07 plain-name $id.",
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
    const references = collectReferences(document.components.schemas);

    expect(references).toContain(
      "#/components/schemas/draft.check.Input/definitions/leaf",
    );
    for (const reference of collectReferences(document)) {
      expect(resolvePointer(document, reference)).toBeDefined();
    }
  });

  it("fails closed when a JSON Schema identifier would be published twice", () => {
    const anchored = {
      type: "object",
      $defs: { Node: { $anchor: "node", type: "string" } },
      properties: { a: { $ref: "#node" } },
    };
    const identified = {
      type: "object",
      properties: {
        a: { $id: "https://schemas.example/shared.json", type: "string" },
      },
    };
    const draftAnchor = {
      type: "object",
      properties: { a: { $id: "#shared", type: "string" } },
    };
    const plain = { type: "object" };
    const capability = (input: JsonObject, output: JsonObject) =>
      defineCapability({
        description: "Shares schema identifiers.",
        input: jsonSchemaContract(input, input),
        output: jsonSchemaContract(output, output),
        access: "public",
        async run() {
          return {};
        },
      });

    for (const capabilities of [
      { "same.schema": capability(anchored, anchored) },
      {
        first: capability(identified, plain),
        second: capability(identified, plain),
      },
      {
        first: capability(draftAnchor, plain),
        second: capability(draftAnchor, plain),
      },
    ]) {
      const engine = createEngine({
        name: "ids",
        version: "1.0.0",
        capabilities,
      });
      expect(() => createHttpOpenApiDocument(engine)).toThrow(TypeError);
      expect(() =>
        createHttpHandler(engine, {
          auth: { mode: "dangerously-disabled-for-development" },
        }),
      ).toThrow(TypeError);
    }

    const embedded = {
      type: "object",
      properties: {
        a: {
          $id: "https://schemas.example/a.json",
          $defs: { x: { $anchor: "node", type: "string" } },
        },
        b: {
          $id: "https://schemas.example/b.json",
          $defs: { x: { $anchor: "node", type: "string" } },
        },
      },
    };
    const scoped = createEngine({
      name: "scoped",
      version: "1.0.0",
      capabilities: { scoped: capability(embedded, plain) },
    });
    expect(() => createHttpOpenApiDocument(scoped)).not.toThrow();
  });

  it("rejects capability keys that URL parsing would remove", () => {
    for (const capabilityId of [".", ".."]) {
      const engine = createEngine({
        name: "dots",
        version: "1.0.0",
        capabilities: {
          [capabilityId]: defineCapability({
            description: "Cannot be addressed.",
            input: z.object({}),
            output: z.object({}),
            access: "public",
            async run() {
              return {};
            },
          }),
        },
      });
      expect(() => createHttpOpenApiDocument(engine)).toThrow(TypeError);
      expect(() =>
        createHttpHandler(engine, {
          auth: { mode: "dangerously-disabled-for-development" },
        }),
      ).toThrow(TypeError);
    }
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
