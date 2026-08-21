import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";
import { loadOpenApiDocument, type OpenApiDocument } from "../src/openapi.js";
import {
  buildOpenApiStarterOperations,
  discoverOpenApiOperations,
  selectOpenApiOperations,
} from "../src/openapi-discovery.js";

const fixtureDirectory = fileURLToPath(
  new URL("./fixtures/openapi/", import.meta.url),
);

type StarterOperation = ReturnType<
  typeof buildOpenApiStarterOperations
>[number];

let document: OpenApiDocument;
let operations: readonly StarterOperation[];

function bySelector(selector: string): StarterOperation {
  const operation = operations.find((item) => item.selector === selector);
  if (operation === undefined) {
    throw new Error(`Missing planned operation ${selector}`);
  }
  return operation;
}

beforeAll(async () => {
  document = await loadOpenApiDocument({
    cwd: fixtureDirectory,
    path: "connection-planning.yaml",
  });
  const selectedCandidates = selectOpenApiOperations(
    discoverOpenApiOperations(document),
    [],
  );
  operations = buildOpenApiStarterOperations(document, selectedCandidates);
});

describe("buildOpenApiStarterOperations", () => {
  it("derives deterministic capability, export, and module names with and without operationId", () => {
    expect(
      operations.map((operation) => ({
        selector: operation.selector,
        capabilityId: operation.capabilityId,
        exportName: operation.exportName,
        moduleName: operation.moduleName,
      })),
    ).toEqual([
      {
        selector: "GET:/health",
        capabilityId: "openapi.health-check",
        exportName: "healthCheck",
        moduleName: "health-check",
      },
      {
        selector: "GET:/session",
        capabilityId: "openapi.read-session",
        exportName: "readSession",
        moduleName: "read-session",
      },
      {
        selector: "GET:/token",
        capabilityId: "openapi.get-token",
        exportName: "getToken",
        moduleName: "get-token",
      },
      {
        selector: "POST:/widgets/{widgetId}",
        capabilityId: "openapi.create-widget",
        exportName: "createWidget",
        moduleName: "create-widget",
      },
    ]);
  });

  it("expands server variable defaults and records a names-only base URL override", () => {
    expect(bySelector("POST:/widgets/{widgetId}").connection).toEqual({
      serverSource: "root",
      serverUrls: ["https://us.api.example.test/v1"],
      baseUrl: {
        environmentVariable: "OPENAPI_CREATE_WIDGET_BASE_URL",
        default: "https://us.api.example.test/v1",
      },
    });
  });

  it("normalizes path, query, header, and cookie parameters without losing requiredness or schemas", () => {
    const operation = bySelector("POST:/widgets/{widgetId}");

    expect(operation.parameters).toEqual([
      {
        name: "widgetId",
        in: "path",
        required: true,
        style: "simple",
        explode: false,
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "tags",
        in: "query",
        required: true,
        style: "form",
        explode: true,
        schema: { type: "array", items: { type: "string" } },
      },
      {
        name: "verbose",
        in: "query",
        required: false,
        style: "form",
        explode: true,
        schema: { type: "boolean" },
      },
      {
        name: "X-Trace-Id",
        in: "header",
        required: false,
        style: "simple",
        explode: false,
        schema: { type: "string" },
      },
      {
        name: "session",
        in: "cookie",
        required: true,
        style: "form",
        explode: true,
        schema: { type: "string" },
      },
    ]);

    expect(operation.inputSchema).toEqual({
      type: "object",
      properties: {
        path: {
          type: "object",
          properties: {
            widgetId: { type: "string", minLength: 1 },
          },
          required: ["widgetId"],
          additionalProperties: false,
        },
        query: {
          type: "object",
          properties: {
            tags: { type: "array", items: { type: "string" } },
            verbose: { type: "boolean" },
          },
          required: ["tags"],
          additionalProperties: false,
        },
        headers: {
          type: "object",
          properties: {
            "X-Trace-Id": { type: "string" },
          },
          additionalProperties: false,
        },
        cookies: {
          type: "object",
          properties: {
            session: { type: "string" },
          },
          required: ["session"],
          additionalProperties: false,
        },
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1 },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
      required: ["path", "query", "cookies", "body"],
      additionalProperties: false,
    });
  });

  it("normalizes a required JSON request body and explicit 200, 201, and 204 success responses", () => {
    const operation = bySelector("POST:/widgets/{widgetId}");

    expect(operation.requestBody).toEqual({
      required: true,
      mediaType: "application/json",
      schema: {
        type: "object",
        properties: { name: { type: "string", minLength: 1 } },
        required: ["name"],
        additionalProperties: false,
      },
    });
    expect(operation.successResponses).toEqual([
      {
        status: "200",
        mediaType: "application/json",
        schema: {
          type: "object",
          properties: {
            id: { type: "string" },
            created: { const: false },
          },
          required: ["id", "created"],
          additionalProperties: false,
        },
      },
      {
        status: "201",
        mediaType: "application/widget+json",
        schema: {
          type: "object",
          properties: {
            id: { type: "string" },
            created: { const: true },
          },
          required: ["id", "created"],
          additionalProperties: false,
        },
      },
      { status: "204" },
    ]);
    expect(operation.outputSchema).toEqual({
      oneOf: [
        {
          type: "object",
          properties: {
            status: { const: 200 },
            body: {
              type: "object",
              properties: {
                id: { type: "string" },
                created: { const: false },
              },
              required: ["id", "created"],
              additionalProperties: false,
            },
          },
          required: ["status", "body"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            status: { const: 201 },
            body: {
              type: "object",
              properties: {
                id: { type: "string" },
                created: { const: true },
              },
              required: ["id", "created"],
              additionalProperties: false,
            },
          },
          required: ["status", "body"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { status: { const: 204 } },
          required: ["status"],
          additionalProperties: false,
        },
      ],
    });
  });

  it("normalizes anonymous, API-key, Basic, and Bearer security with deterministic credential names", () => {
    expect(bySelector("GET:/health").security).toEqual({
      alternatives: [[]],
    });
    expect(bySelector("POST:/widgets/{widgetId}").security).toEqual({
      alternatives: [
        [
          {
            name: "HeaderApiKey",
            type: "apiKey",
            in: "header",
            parameterName: "X-Api-Key",
            environmentVariables: {
              value: "OPENAPI_HEADER_API_KEY_API_KEY",
            },
          },
        ],
      ],
    });
    expect(bySelector("GET:/session").security).toEqual({
      alternatives: [
        [
          {
            name: "BasicAuth",
            type: "basic",
            environmentVariables: {
              username: "OPENAPI_BASIC_AUTH_USERNAME",
              password: "OPENAPI_BASIC_AUTH_PASSWORD",
            },
          },
        ],
      ],
    });
    expect(bySelector("GET:/token").security).toEqual({
      alternatives: [
        [
          {
            name: "BearerAuth",
            type: "bearer",
            environmentVariables: {
              token: "OPENAPI_BEARER_AUTH_TOKEN",
            },
          },
        ],
      ],
    });
  });
});
