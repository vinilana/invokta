import { createEngine, EngineError } from "@invokta/core";
import { describe, expect, it, vi } from "vitest";

import {
  createGateway,
  type GatewayMcpConnection,
  type JsonSchemaValidator,
  mcpUpstream,
} from "../src/index.js";

/**
 * A minimal validator for the tests: checks `required` and the `type` of
 * top-level properties. Hosts inject a complete one, such as Ajv.
 */
const validator: JsonSchemaValidator = (schema, value) => {
  const issues: { message: string; path?: ReadonlyArray<string> }[] = [];
  const record = value as Record<string, unknown>;
  for (const key of (schema.required as string[] | undefined) ?? []) {
    if (!(key in record)) issues.push({ message: "Required.", path: [key] });
  }
  const properties = (schema.properties ?? {}) as Record<
    string,
    { readonly type?: string }
  >;
  for (const [key, property] of Object.entries(properties)) {
    if (key in record && property.type === "string") {
      if (typeof record[key] !== "string") {
        issues.push({ message: "Expected a string.", path: [key] });
      }
    }
  }
  return issues;
};

function connection(
  output: Record<string, unknown> = { hits: ["a"] },
): GatewayMcpConnection & { readonly callTool: ReturnType<typeof vi.fn> } {
  return {
    async listTools() {
      return {
        tools: [
          {
            name: "search",
            description: "Search documents.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
            outputSchema: {
              type: "object",
              properties: {
                hits: { type: "array" },
                cursor: { type: "string" },
              },
              required: ["hits"],
            },
          },
        ],
      };
    },
    callTool: vi.fn(async () => ({
      response: { content: [], structuredContent: output },
    })),
  };
}

async function engineFor(
  docs: GatewayMcpConnection,
  options: { readonly validator?: JsonSchemaValidator } = {},
) {
  return createEngine({
    name: "gateway",
    version: "0.1.0",
    capabilities: createGateway({
      upstreams: [
        await mcpUpstream({ name: "docs", connection: docs, ...options }),
      ],
      rules: [{ match: "*", access: "public" }],
    }).capabilities,
  });
}

async function failure(pending: Promise<unknown>): Promise<EngineError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof EngineError) return error;
    throw error;
  }
  throw new Error("Expected the invocation to fail.");
}

describe("JSON Schema validation of MCP upstream contracts", () => {
  it("rejects invalid input as INPUT_INVALID before calling the upstream", async () => {
    const docs = connection();
    const engine = await engineFor(docs, { validator });

    const invalid = await failure(engine.invoke("docs.search", { query: 42 }));

    expect(invalid.code).toBe("INPUT_INVALID");
    expect(invalid.publicDetails).toEqual({
      issues: [{ message: "Expected a string.", path: ["query"] }],
    });
    expect(docs.callTool).not.toHaveBeenCalled();
    await expect(
      engine.invoke("docs.search", { query: "gateway" }),
    ).resolves.toEqual({ hits: ["a"] });
  });

  it("rejects an invalid upstream result as OUTPUT_INVALID", async () => {
    const engine = await engineFor(connection({ cursor: 7 }), { validator });

    const invalid = await failure(
      engine.invoke("docs.search", { query: "gateway" }),
    );
    expect(invalid.code).toBe("OUTPUT_INVALID");
  });

  it("passes the same frozen schema object on every call so validators can cache", async () => {
    const seen: object[] = [];
    const engine = await engineFor(connection(), {
      validator: (schema) => {
        seen.push(schema);
        return undefined;
      },
    });

    await engine.invoke("docs.search", { query: "a" });
    await engine.invoke("docs.search", { query: "b" });

    expect(seen).toHaveLength(4);
    expect(seen[0]).toBe(seen[2]);
    expect(seen[1]).toBe(seen[3]);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  it("fails closed when the validator throws", async () => {
    const docs = connection();
    const engine = await engineFor(docs, {
      validator: () => {
        throw new Error("schema compiler crashed");
      },
    });

    const invalid = await failure(engine.invoke("docs.search", { query: "a" }));
    expect(invalid.code).toBe("INPUT_INVALID");
    expect(JSON.stringify(invalid.publicDetails)).not.toContain("crashed");
    expect(docs.callTool).not.toHaveBeenCalled();
  });

  it("checks only the object shape without a validator", async () => {
    const docs = connection();
    const engine = await engineFor(docs);

    await engine.invoke("docs.search", { query: 42 });
    expect(docs.callTool).toHaveBeenCalledTimes(1);
  });

  it("rejects a validator that is not a function", async () => {
    await expect(
      mcpUpstream({
        name: "docs",
        connection: connection(),
        validator: "ajv" as unknown as JsonSchemaValidator,
      }),
    ).rejects.toThrow(
      new TypeError("Upstream docs validator must be a function."),
    );
  });
});
