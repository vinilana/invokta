import { createEngine, EngineError } from "@invokta/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  createDiscovery,
  createGateway,
  type DiscoveryRanker,
  type DiscoverySearchEvent,
  engineUpstream,
  type GatewayMcpConnection,
  type GatewayMcpTool,
  type JsonSchemaValidator,
  mcpUpstream,
} from "../src/index.js";
import { validator as ajvValidator } from "./support/ajv-validator.js";
import { createLargeCatalogEngine } from "./support/catalog.js";

const unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
process.on("unhandledRejection", recordUnhandled);

afterEach(() => {
  unhandled.length = 0;
});

/** Lets pending rejections surface as unhandled before asserting. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
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

function recordingConnection(tool: GatewayMcpTool): {
  readonly connection: GatewayMcpConnection;
  readonly calls: unknown[];
} {
  const calls: unknown[] = [];
  return {
    calls,
    connection: {
      async listTools() {
        return { tools: [tool] };
      },
      async callTool(name, argumentsValue) {
        calls.push({ name, argumentsValue });
        return { response: { content: [] } };
      },
    },
  };
}

async function gatewayEngine(
  tool: GatewayMcpTool,
  validator: JsonSchemaValidator,
) {
  const upstream = recordingConnection(tool);
  const engine = createEngine({
    name: "gateway",
    version: "0.1.0",
    capabilities: createGateway({
      upstreams: [
        await mcpUpstream({
          name: "docs",
          connection: upstream.connection,
          validator,
        }),
      ],
      rules: [{ match: "*", access: "public" }],
    }).capabilities,
  });
  return { engine, calls: upstream.calls };
}

const searchTool: GatewayMcpTool = {
  name: "search",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
};

describe("validator safety", () => {
  it("fails closed on a rejecting validator promise without an unhandled rejection", async () => {
    const rejecting = (() =>
      Promise.reject(
        new Error("validator crashed"),
      )) as unknown as JsonSchemaValidator;
    const { engine, calls } = await gatewayEngine(searchTool, rejecting);

    const error = await failure(engine.invoke("docs.search", { query: "a" }));
    await settle();

    expect(error.code).toBe("INPUT_INVALID");
    expect(calls).toEqual([]);
    expect(unhandled).toEqual([]);
  });

  it("validates with the documented Ajv recipe", async () => {
    const { engine, calls } = await gatewayEngine(searchTool, ajvValidator);

    await expect(
      engine.invoke("docs.search", { query: "refunds" }),
    ).resolves.toEqual({ content: [] });
    const error = await failure(
      engine.invoke("docs.search", { query: 42, evil: true }),
    );

    expect(error.code).toBe("INPUT_INVALID");
    expect(calls).toHaveLength(1);
  });

  it("fails closed when an upstream publishes an asynchronous schema", async () => {
    const hostile: GatewayMcpTool = {
      ...searchTool,
      inputSchema: { ...searchTool.inputSchema, $async: true },
    };
    const { engine, calls } = await gatewayEngine(hostile, ajvValidator);

    const error = await failure(
      engine.invoke("docs.search", { query: 42, evil: true }),
    );
    await settle();

    expect(error.code).toBe("INPUT_INVALID");
    expect(calls).toEqual([]);
    expect(unhandled).toEqual([]);
  });
});

describe("discovery cancellation", () => {
  it("settles on caller cancellation even when the client ignores the signal", async () => {
    const caller = new AbortController();
    const connection: GatewayMcpConnection = {
      listTools: () => new Promise(() => undefined),
      async callTool() {
        return { response: { content: [] } };
      },
    };
    const pending = mcpUpstream({
      name: "docs",
      connection,
      validator: "delegate-to-upstream",
      discoveryTimeoutMs: 300_000,
      signal: caller.signal,
    });
    const reason = new Error("host shutdown");
    caller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });
});

describe("ranker bounds", () => {
  it("reads only the first 4,096 ranker IDs", async () => {
    const events: DiscoverySearchEvent[] = [];
    const rank: DiscoveryRanker = async (_query, candidates) => [
      ...candidates.map((candidate) => candidate.id),
      ...Array.from({ length: 4_096 }, () => "padding"),
      42 as unknown as string,
    ];
    const engine = createEngine({
      name: "discovery",
      version: "0.1.0",
      capabilities: createDiscovery({
        gateway: createGateway({
          upstreams: [
            engineUpstream({
              name: "catalog",
              engine: createLargeCatalogEngine(),
            }),
          ],
          rules: [{ match: "*", access: "public" }],
        }),
        rank,
        onSearch: (event) => {
          events.push(event);
        },
      }).capabilities,
    });

    await engine.invoke("gateway.search-tools", { query: "customer" });

    expect(events.map((event) => event.ranker)).toEqual(["custom"]);
  });
});
