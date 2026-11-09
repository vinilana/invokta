import { createEngine, defineCapability, EngineError } from "@invokta/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  chainAuthenticators,
  createDiscovery,
  createGateway,
  engineUpstream,
  type Gateway,
  type GatewayAuthenticationRequest,
  type GatewayMcpConnection,
  type GatewayMcpTool,
  type JsonSchemaValidator,
  McpCatalogLockError,
  mcpUpstream,
} from "../src/index.js";
import { createBillingEngine } from "./support/engines.js";

const tool: GatewayMcpTool = {
  name: "search",
  description: "Search documents.",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
};

function connection(
  tools: ReadonlyArray<GatewayMcpTool> = [tool],
  response: Record<string, unknown> = { content: [] },
): GatewayMcpConnection {
  return {
    async listTools() {
      return { tools };
    },
    async callTool() {
      return { response };
    },
  };
}

function request(
  signal = new AbortController().signal,
): GatewayAuthenticationRequest {
  return {
    path: "/mcp",
    method: "POST",
    headers: { get: () => null, has: () => false },
    signal,
  };
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

describe("rule patterns", () => {
  it("rejects a rule with any pattern that matches nothing", () => {
    expect(() =>
      createGateway({
        upstreams: [
          engineUpstream({ name: "billing", engine: createBillingEngine() }),
        ],
        rules: [
          {
            name: "no-refunds",
            match: ["billing.refnud", "billing.refund"],
            access: "deny",
          },
        ],
      }),
    ).toThrow(
      new TypeError(
        "Gateway rule no-refunds pattern billing.refnud matches no capability.",
      ),
    );
  });
});

describe("validation choice for MCP upstreams", () => {
  it("requires an explicit validator or delegation to the upstream", async () => {
    await expect(
      mcpUpstream({ name: "docs", connection: connection() } as never),
    ).rejects.toThrow(
      new TypeError(
        'Upstream docs validator must be a function or "delegate-to-upstream".',
      ),
    );
    await expect(
      mcpUpstream({
        name: "docs",
        connection: connection(),
        validator: "delegate-to-upstream",
      }),
    ).resolves.toBeDefined();
  });

  it("fails closed when a validator returns a promise", async () => {
    const engine = createEngine({
      name: "gateway",
      version: "0.1.0",
      capabilities: createGateway({
        upstreams: [
          await mcpUpstream({
            name: "docs",
            connection: connection(),
            validator: (async () =>
              undefined) as unknown as JsonSchemaValidator,
          }),
        ],
        rules: [{ match: "*", access: "public" }],
      }).capabilities,
    });

    expect(
      (await failure(engine.invoke("docs.search", { query: "a" }))).code,
    ).toBe("INPUT_INVALID");
  });

  it("validates engine upstream input before the gateway rule reads it", async () => {
    const seen: unknown[] = [];
    const engine = createEngine({
      name: "gateway",
      version: "0.1.0",
      capabilities: createGateway({
        upstreams: [
          engineUpstream({
            name: "billing",
            engine: createBillingEngine(),
            validator: (schema, value) =>
              (schema.required as string[]).every((key) => key in value)
                ? undefined
                : [{ message: "Required." }],
          }),
        ],
        rules: [
          {
            match: "*",
            access: ({ input }) => {
              seen.push(input);
              return true;
            },
          },
        ],
      }).capabilities,
    });

    expect((await failure(engine.invoke("billing.get-invoice", {}))).code).toBe(
      "INPUT_INVALID",
    );
    expect(seen).toEqual([]);
  });
});

describe("upstream tool errors", () => {
  async function toolError(forwardToolErrors?: boolean) {
    const engine = createEngine({
      name: "gateway",
      version: "0.1.0",
      capabilities: createGateway({
        upstreams: [
          await mcpUpstream({
            name: "docs",
            validator: "delegate-to-upstream",
            connection: connection([tool], {
              isError: true,
              content: [{ type: "text", text: "db password=hunter2 rejected" }],
            }),
            ...(forwardToolErrors === undefined ? {} : { forwardToolErrors }),
          }),
        ],
        rules: [{ match: "*", access: "public" }],
      }).capabilities,
    });
    return failure(engine.invoke("docs.search", { query: "a" }));
  }

  it("omits upstream error text by default", async () => {
    const error = await toolError();
    expect(error.publicDetails).toEqual({
      code: "UPSTREAM_TOOL_ERROR",
      retryable: false,
    });
    expect(JSON.stringify(error.publicDetails)).not.toContain("hunter2");
  });

  it("forwards bounded upstream error text only on request", async () => {
    expect((await toolError(true)).publicDetails).toEqual({
      code: "UPSTREAM_TOOL_ERROR",
      retryable: false,
      details: { message: "db password=hunter2 rejected" },
    });
  });
});

describe("bounded MCP discovery", () => {
  it("fails discovery after its deadline even when the client ignores the signal", async () => {
    const stalled: GatewayMcpConnection = {
      listTools: () => new Promise(() => undefined),
      callTool: async () => ({ response: { content: [] } }),
    };
    await expect(
      mcpUpstream({
        name: "docs",
        connection: stalled,
        validator: "delegate-to-upstream",
        discoveryTimeoutMs: 20,
      }),
    ).rejects.toThrow("MCP upstream docs did not list its tools within 20 ms.");
  });

  it("rejects a published tool with an invalid name or an oversized definition", async () => {
    await expect(
      mcpUpstream({
        name: "docs",
        validator: "delegate-to-upstream",
        connection: connection([{ ...tool, name: "bad name\u0007" }]),
      }),
    ).rejects.toThrow(
      new TypeError(
        'MCP upstream docs lists the invalid tool name "bad name\\u0007".',
      ),
    );
    await expect(
      mcpUpstream({
        name: "docs",
        validator: "delegate-to-upstream",
        maxToolBytes: 1_024,
        connection: connection([{ ...tool, description: "x".repeat(2_000) }]),
      }),
    ).rejects.toThrow(
      new TypeError(
        "MCP upstream docs tool search exceeds the 1024-byte definition limit.",
      ),
    );
    await expect(
      mcpUpstream({
        name: "docs",
        validator: "delegate-to-upstream",
        include: ["search"],
        connection: connection([tool, { ...tool, name: "ignored name!" }]),
      }),
    ).resolves.toBeDefined();
  });
});

describe("catalog lock fingerprint", () => {
  it("rejects a lock whose fingerprint disagrees with its tools", async () => {
    const upstream = await mcpUpstream({
      name: "docs",
      validator: "delegate-to-upstream",
      connection: connection(),
    });

    await expect(
      mcpUpstream({
        name: "docs",
        validator: "delegate-to-upstream",
        connection: connection(),
        lock: { ...upstream.lock, fingerprint: "0".repeat(64) },
      }),
    ).rejects.toThrow(McpCatalogLockError);
  });
});

describe("engine upstream contracts", () => {
  it("republishes the upstream timeout", () => {
    const engine = createEngine({
      name: "slow-engine",
      version: "1.0.0",
      capabilities: {
        "reports.build": defineCapability({
          description: "Build a report.",
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          access: "public",
          timeoutMs: 1_500,
          async run() {
            return { ok: true };
          },
        }),
      },
    });
    const gateway = createEngine({
      name: "gateway",
      version: "0.1.0",
      capabilities: createGateway({
        upstreams: [engineUpstream({ name: "reports", engine })],
        rules: [{ match: "*", access: "public" }],
      }).capabilities,
    });

    expect(gateway.describe("reports.build").timeoutMs).toBe(1_500);
  });
});

describe("chainAuthenticators", () => {
  it("treats undefined as no principal and stops once the request is aborted", async () => {
    const chain = chainAuthenticators(
      () => undefined as never,
      () => ({ id: "second" }),
    );
    await expect(chain(request())).resolves.toEqual({ id: "second" });

    const controller = new AbortController();
    const aborting = chainAuthenticators(
      () => {
        controller.abort(new Error("client gone"));
        return null;
      },
      () => ({ id: "never" }),
    );
    await expect(aborting(request(controller.signal))).rejects.toThrow(
      "client gone",
    );
  });
});

describe("createDiscovery", () => {
  it("accepts only a gateway created by createGateway", () => {
    const real = createGateway({
      upstreams: [
        engineUpstream({ name: "billing", engine: createBillingEngine() }),
      ],
      rules: [{ match: "*", access: "public" }],
    });
    const forged = { ...real } as Gateway;

    expect(() => createDiscovery({ gateway: real })).not.toThrow();
    expect(() => createDiscovery({ gateway: forged })).toThrow(
      new TypeError("createDiscovery needs the value createGateway returned."),
    );
  });
});
