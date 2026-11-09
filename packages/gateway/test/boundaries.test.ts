import { createEngine } from "@invokta/core";
import { describe, expect, it } from "vitest";

import {
  apiKeyAuthenticator,
  createDiscovery,
  createGateway,
  engineUpstream,
  type GatewayAuthenticationRequest,
  type GatewayMcpConnection,
  type GatewayMcpTool,
  hashApiKey,
  mcpUpstream,
} from "../src/index.js";
import { createLargeCatalogEngine } from "./support/catalog.js";

function tools(count: number): GatewayMcpTool[] {
  return Array.from({ length: count }, (_value, index) => ({
    name: `tool-${String(index)}`,
    inputSchema: { type: "object" },
  }));
}

function paged(pages: number): GatewayMcpConnection {
  return {
    async listTools(cursor) {
      const page = cursor === undefined ? 0 : Number(cursor);
      return {
        tools: tools(1).map((tool) => ({
          ...tool,
          name: `${tool.name}-${String(page)}`,
        })),
        ...(page + 1 < pages ? { nextCursor: String(page + 1) } : {}),
      };
    },
    async callTool() {
      return { response: { content: [] } };
    },
  };
}

function flat(list: ReadonlyArray<GatewayMcpTool>): GatewayMcpConnection {
  return {
    async listTools() {
      return { tools: list };
    },
    async callTool() {
      return { response: { content: [] } };
    },
  };
}

const upstream = (options: Record<string, unknown>) =>
  mcpUpstream({
    name: "docs",
    validator: "delegate-to-upstream",
    connection: flat(tools(1)),
    ...options,
  });

describe("MCP upstream bounds", () => {
  it("accepts maxTools equal to the listed tools and rejects one fewer", async () => {
    await expect(
      upstream({ connection: flat(tools(3)), maxTools: 3 }),
    ).resolves.toBeDefined();
    await expect(
      upstream({ connection: flat(tools(3)), maxTools: 2 }),
    ).rejects.toThrow("more than the configured maximum of 2 tools");
  });

  it.each([
    ["maxTools", 4_096, 4_097],
    ["timeoutMs", 2_147_483_647, 2_147_483_648],
    ["discoveryTimeoutMs", 300_000, 300_001],
    ["maxToolBytes", 1_048_576, 1_048_577],
  ])("accepts %s %i and rejects %i", async (option, accepted, rejected) => {
    await expect(upstream({ [option]: accepted })).resolves.toBeDefined();
    await expect(upstream({ [option]: rejected })).rejects.toThrow(TypeError);
    await expect(upstream({ [option]: 0 })).rejects.toThrow(TypeError);
  });

  it("reads 64 pages and rejects a 65th", async () => {
    await expect(upstream({ connection: paged(64) })).resolves.toMatchObject({
      routes: expect.arrayContaining([
        expect.objectContaining({ upstreamCapabilityId: "tool-0-63" }),
      ]),
    });
    await expect(upstream({ connection: paged(65) })).rejects.toThrow(
      "paginates beyond 64 tool pages",
    );
  });

  it("accepts a 128-character tool name and rejects 129", async () => {
    await expect(
      upstream({
        connection: flat([
          { name: "t".repeat(128), inputSchema: { type: "object" } },
        ]),
      }),
    ).resolves.toBeDefined();
    await expect(
      upstream({
        connection: flat([
          { name: "t".repeat(129), inputSchema: { type: "object" } },
        ]),
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe("API key bounds", () => {
  it("accepts a 1,024-character key and rejects 1,025", async () => {
    const key = "k".repeat(1_024);
    const authenticate = apiKeyAuthenticator({
      keys: [{ id: "bot", sha256: await hashApiKey(key) }],
    });
    const request = (value: string): GatewayAuthenticationRequest => ({
      path: "/mcp",
      method: "POST",
      headers: {
        get: (name) => (name === "x-api-key" ? value : null),
        has: (name) => name === "x-api-key",
      },
      signal: new AbortController().signal,
    });

    await expect(authenticate(request(key))).resolves.toEqual({ id: "bot" });
    await expect(authenticate(request(`${key}k`))).resolves.toBeNull();
  });
});

describe("discovery bounds", () => {
  function discoveryEngine(options: Record<string, unknown> = {}) {
    const built = createGateway({
      upstreams: [
        engineUpstream({ name: "catalog", engine: createLargeCatalogEngine() }),
      ],
      rules: [{ match: "*", access: "public" }],
    });
    return createEngine({
      name: "discovery",
      version: "0.1.0",
      capabilities: createDiscovery({ gateway: built, ...options })
        .capabilities,
    });
  }

  it("accepts a 256-character query and limit 20", async () => {
    const engine = discoveryEngine();
    const result = (await engine.invoke("gateway.search-tools", {
      query: `get ${"x".repeat(252)}`,
      limit: 20,
    })) as { tools: unknown[] };
    expect(result.tools).toHaveLength(20);
  });

  it("accepts an alwaysList of exactly 32 capabilities", () => {
    expect(() =>
      discoveryEngine({
        alwaysList: [
          "billing.*",
          "crm.create-customer",
          "crm.update-customer",
          "crm.delete-customer",
          "crm.get-customer",
          "crm.list-customer",
          "crm.search-customer",
          "crm.archive-customer",
          "crm.export-customer",
          "crm.approve-customer",
          "crm.cancel-customer",
          "orders.get-order",
          "orders.list-order",
        ],
      }),
    ).not.toThrow();
  });

  it("accepts a 60,000 ms ranker deadline and rejects 60,001", () => {
    expect(() => discoveryEngine({ rankTimeoutMs: 60_000 })).not.toThrow();
    expect(() => discoveryEngine({ rankTimeoutMs: 60_001 })).toThrow(TypeError);
  });
});
