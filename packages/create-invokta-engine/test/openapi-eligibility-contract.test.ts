import { describe, expect, it } from "vitest";

import type { OpenApiDocument, OpenApiObject } from "../src/openapi.js";
import {
  buildOpenApiStarterOperations,
  discoverOpenApiOperations,
  type OpenApiOperationCandidate,
  selectOpenApiOperations,
} from "../src/openapi-discovery.js";

function documentWithPaths(
  paths: OpenApiObject,
  extra: OpenApiObject = {},
): OpenApiDocument {
  return {
    openapi: "3.1.1",
    info: { title: "Eligibility contract", version: "1.0.0" },
    paths,
    ...extra,
  };
}

function successfulOperation(extra: OpenApiObject = {}): OpenApiObject {
  return {
    responses: { "204": { description: "No content" } },
    ...extra,
  };
}

function bySelector(
  candidates: readonly OpenApiOperationCandidate[],
  selector: string,
): OpenApiOperationCandidate {
  const candidate = candidates.find((item) => item.selector === selector);
  if (candidate === undefined) throw new Error(`Missing ${selector}`);
  return candidate;
}

describe("OpenAPI server eligibility", () => {
  it("expands declared defaults and accepts only HTTP(S) URLs without user information", () => {
    const candidates = discoverOpenApiOperations(
      documentWithPaths(
        {
          "/safe": { get: successfulOperation() },
          "/userinfo": {
            get: successfulOperation({
              servers: [{ url: "https://user:secret@example.test/v1" }],
            }),
          },
          "/relative": {
            get: successfulOperation({ servers: [{ url: "/v1" }] }),
          },
          "/ftp": {
            get: successfulOperation({
              servers: [{ url: "ftp://example.test/v1" }],
            }),
          },
          "/missing-default": {
            get: successfulOperation({
              servers: [
                {
                  url: "https://{region}.example.test/v1",
                  variables: { region: { description: "Region" } },
                },
              ],
            }),
          },
          "/non-string-default": {
            get: successfulOperation({
              servers: [
                {
                  url: "https://{port}.example.test/v1",
                  variables: { port: { default: 443 } },
                },
              ],
            }),
          },
          "/literal-default": {
            get: successfulOperation({
              servers: [
                {
                  url: "https://{authority}/{base}",
                  variables: {
                    authority: { default: "api.example.test:8443" },
                    base: { default: "v1/beta" },
                  },
                },
              ],
            }),
          },
        },
        {
          servers: [
            {
              url: "https://{region}.example.test/{version}",
              variables: {
                region: { default: "eu" },
                version: { default: "v2" },
              },
            },
          ],
        },
      ),
    );

    expect(bySelector(candidates, "GET:/safe")).toMatchObject({
      connection: {
        serverSource: "root",
        serverUrls: ["https://eu.example.test/v2"],
      },
      eligibility: { eligible: true },
    });
    expect(bySelector(candidates, "GET:/literal-default")).toMatchObject({
      connection: {
        serverSource: "operation",
        serverUrls: ["https://api.example.test:8443/v1/beta"],
      },
      eligibility: { eligible: true },
    });
    for (const selector of [
      "GET:/userinfo",
      "GET:/relative",
      "GET:/ftp",
      "GET:/missing-default",
      "GET:/non-string-default",
    ]) {
      expect(bySelector(candidates, selector).eligibility).toEqual({
        eligible: false,
        reason: "SERVER_UNSUPPORTED",
      });
    }
  });
});

describe("OpenAPI success response eligibility", () => {
  it("accepts exact JSON in preference to alternatives and rejects ambiguous or unsupported media", () => {
    const candidates = discoverOpenApiOperations(
      documentWithPaths({
        "/exact": {
          get: successfulOperation({
            responses: {
              "200": {
                content: {
                  "text/plain": { schema: { type: "string" } },
                  "application/problem+json": {
                    schema: { type: "object" },
                  },
                  "application/json": { schema: { type: "object" } },
                },
              },
            },
          }),
        },
        "/ambiguous": {
          get: successfulOperation({
            responses: {
              "200": {
                content: {
                  "application/first+json": {},
                  "application/second+json": {},
                },
              },
            },
          }),
        },
        "/unsupported": {
          get: successfulOperation({
            responses: { "200": { content: { "text/plain": {} } } },
          }),
        },
        "/malformed": {
          get: successfulOperation({ responses: { "200": "invalid" } }),
        },
      }),
    );

    expect(bySelector(candidates, "GET:/exact").eligibility).toEqual({
      eligible: true,
    });
    for (const selector of [
      "GET:/ambiguous",
      "GET:/unsupported",
      "GET:/malformed",
    ]) {
      expect(bySelector(candidates, selector).eligibility).toEqual({
        eligible: false,
        reason: "RESPONSE_UNSUPPORTED",
      });
    }
  });
});

describe("OpenAPI schema eligibility", () => {
  const arraySchema = (memberCount: number): OpenApiObject => ({
    anyOf: Array.from({ length: memberCount }, () => ({ type: "string" })),
  });

  it("rejects unsupported semantic keywords after the earlier eligibility gates", () => {
    const candidates = discoverOpenApiOperations(
      documentWithPaths({
        "/supported": {
          post: successfulOperation({
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      value: {
                        oneOf: [
                          { type: "string", minLength: 1, format: "uuid" },
                          { type: "integer", minimum: 0 },
                        ],
                      },
                    },
                    additionalProperties: false,
                  },
                },
              },
            },
          }),
        },
        "/not": {
          get: successfulOperation({
            parameters: [
              {
                name: "value",
                in: "query",
                schema: { type: "string", not: { const: "secret" } },
              },
            ],
          }),
        },
        "/unique": {
          post: successfulOperation({
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { type: "string" },
                    uniqueItems: true,
                  },
                },
              },
            },
          }),
        },
        "/unknown-semantic": {
          post: successfulOperation({
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "string", futureSemantic: true },
                },
              },
            },
          }),
        },
        "/non-json-enum": {
          post: successfulOperation({
            requestBody: {
              content: {
                "application/json": {
                  schema: { enum: [Number.POSITIVE_INFINITY] },
                },
              },
            },
          }),
        },
      }),
    );

    expect(bySelector(candidates, "POST:/supported").eligibility).toEqual({
      eligible: true,
    });
    expect(bySelector(candidates, "GET:/not").eligibility).toEqual({
      eligible: false,
      reason: "SCHEMA_UNSUPPORTED",
    });
    expect(bySelector(candidates, "POST:/unique").eligibility).toEqual({
      eligible: false,
      reason: "SCHEMA_UNSUPPORTED",
    });
    expect(
      bySelector(candidates, "POST:/unknown-semantic").eligibility,
    ).toEqual({
      eligible: false,
      reason: "SCHEMA_UNSUPPORTED",
    });
    expect(bySelector(candidates, "POST:/non-json-enum").eligibility).toEqual({
      eligible: false,
      reason: "SCHEMA_UNSUPPORTED",
    });
  });

  it("accepts exactly 1,000 reachable schema nodes and rejects 1,001", () => {
    const candidates = discoverOpenApiOperations(
      documentWithPaths({
        "/boundary": {
          post: successfulOperation({
            requestBody: {
              content: {
                "application/json": { schema: arraySchema(999) },
              },
            },
          }),
        },
        "/overflow": {
          post: successfulOperation({
            requestBody: {
              content: {
                "application/json": { schema: arraySchema(1_000) },
              },
            },
          }),
        },
      }),
    );

    expect(bySelector(candidates, "POST:/boundary").eligibility).toEqual({
      eligible: true,
    });
    expect(bySelector(candidates, "POST:/overflow").eligibility).toEqual({
      eligible: false,
      reason: "SCHEMA_UNSUPPORTED",
    });
  });
});

describe("OpenAPI security eligibility", () => {
  it("rejects non-empty scopes for supported non-OAuth security schemes", () => {
    const candidates = discoverOpenApiOperations(
      documentWithPaths(
        {
          "/safe": { get: successfulOperation({ security: [] }) },
          "/scoped-api-key": {
            get: successfulOperation({ security: [{ ApiKey: ["write"] }] }),
          },
          "/scoped-bearer": {
            get: successfulOperation({ security: [{ Bearer: ["read"] }] }),
          },
        },
        {
          components: {
            securitySchemes: {
              ApiKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
              Bearer: { type: "http", scheme: "bearer" },
            },
          },
        },
      ),
    );

    for (const selector of ["GET:/scoped-api-key", "GET:/scoped-bearer"]) {
      expect(bySelector(candidates, selector).eligibility).toEqual({
        eligible: false,
        reason: "SECURITY_UNSUPPORTED",
      });
    }
  });
});

describe("OpenAPI generated-name eligibility", () => {
  it("prefixes operation exports that would be invalid TypeScript bindings", () => {
    const document = documentWithPaths({
      "/numeric": {
        get: successfulOperation({ operationId: "123-start" }),
      },
      "/reserved": {
        get: successfulOperation({ operationId: "delete" }),
      },
      "/empty": {
        get: successfulOperation({ operationId: "---" }),
      },
    });
    const candidates = discoverOpenApiOperations(document);
    const plans = buildOpenApiStarterOperations(
      document,
      selectOpenApiOperations(candidates, []),
    );

    expect(
      plans.map(({ selector, exportName, moduleName, capabilityId }) => ({
        selector,
        exportName,
        moduleName,
        capabilityId,
      })),
    ).toEqual([
      {
        selector: "GET:/empty",
        exportName: "getEmpty",
        moduleName: "get-empty",
        capabilityId: "openapi.get-empty",
      },
      {
        selector: "GET:/numeric",
        exportName: "operation123Start",
        moduleName: "123-start",
        capabilityId: "openapi.123-start",
      },
      {
        selector: "GET:/reserved",
        exportName: "operationDelete",
        moduleName: "delete",
        capabilityId: "openapi.delete",
      },
    ]);
  });

  it("marks every otherwise eligible participant in a capability ID collision", () => {
    const candidates = discoverOpenApiOperations(
      documentWithPaths({
        "/first": {
          get: successfulOperation({ operationId: "read_widget" }),
        },
        "/second": {
          get: successfulOperation({ operationId: "read-widget" }),
        },
        "/safe": {
          get: successfulOperation({ operationId: "safeOperation" }),
        },
      }),
    );

    expect(bySelector(candidates, "GET:/first").eligibility).toEqual({
      eligible: false,
      reason: "CAPABILITY_ID_COLLISION",
    });
    expect(bySelector(candidates, "GET:/second").eligibility).toEqual({
      eligible: false,
      reason: "CAPABILITY_ID_COLLISION",
    });
    expect(bySelector(candidates, "GET:/safe").eligibility).toEqual({
      eligible: true,
    });
  });

  it("marks every participant whose distinct long capability IDs map to one MCP tool name", () => {
    const commonPrefix = "a".repeat(55);
    // These suffixes give the derived capability IDs the same 48-bit SHA-256
    // prefix used by the bounded MCP tool-name mapping.
    const candidates = discoverOpenApiOperations(
      documentWithPaths({
        "/first": {
          get: successfulOperation({
            operationId: `${commonPrefix}-498155`,
          }),
        },
        "/second": {
          get: successfulOperation({
            operationId: `${commonPrefix}-39824100`,
          }),
        },
        "/safe": {
          get: successfulOperation({ operationId: "safeOperation" }),
        },
      }),
    );

    expect(bySelector(candidates, "GET:/first").eligibility).toEqual({
      eligible: false,
      reason: "MCP_TOOL_NAME_COLLISION",
    });
    expect(bySelector(candidates, "GET:/second").eligibility).toEqual({
      eligible: false,
      reason: "MCP_TOOL_NAME_COLLISION",
    });
    expect(bySelector(candidates, "GET:/safe").eligibility).toEqual({
      eligible: true,
    });
  });

  it("does not let an earlier ineligibility reason participate in collisions", () => {
    const candidates = discoverOpenApiOperations(
      documentWithPaths({
        "/invalid": {
          get: {
            operationId: "same-name",
            responses: { default: { description: "No explicit success" } },
          },
        },
        "/valid": {
          get: successfulOperation({ operationId: "same_name" }),
        },
      }),
    );

    expect(bySelector(candidates, "GET:/invalid").eligibility).toEqual({
      eligible: false,
      reason: "SUCCESS_RESPONSE_MISSING",
    });
    expect(bySelector(candidates, "GET:/valid").eligibility).toEqual({
      eligible: true,
    });
  });
});

describe("OpenAPI selector ambiguity", () => {
  it("rejects a token that names one canonical selector and another operation alias", () => {
    const candidates = discoverOpenApiOperations(
      documentWithPaths({
        "/target": {
          get: successfulOperation({ operationId: "canonicalOperation" }),
        },
        "/alias": {
          get: successfulOperation({ operationId: "GET:/target" }),
        },
      }),
    );

    expect(() => selectOpenApiOperations(candidates, ["GET:/target"])).toThrow(
      expect.objectContaining({
        code: "OPENAPI_SELECTION_INVALID",
        exitCode: 2,
      }),
    );
  });
});

describe("OpenAPI zero-eligible discovery", () => {
  it("returns the bounded ineligible catalog for interactive rendering", () => {
    const candidates = discoverOpenApiOperations(
      documentWithPaths({
        "/unsupported": {
          get: { responses: { default: { description: "Failure" } } },
        },
      }),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.eligibility).toEqual({
      eligible: false,
      reason: "SUCCESS_RESPONSE_MISSING",
    });
  });
});
