import { createEngine, EngineError, type Principal } from "@invokta/core";
import { createMcpHttpHandler } from "@invokta/mcp";
import { describe, expect, it, vi } from "vitest";

import {
  createDiscovery,
  createGateway,
  type DiscoveryOptions,
  engineUpstream,
  type GatewayDecision,
  type GatewayMcpConnection,
  mcpUpstream,
  requireScopes,
} from "../src/index.js";
import {
  actions,
  createLargeCatalogEngine,
  objects,
} from "./support/catalog.js";
import { createSupportEngine } from "./support/engines.js";

const operator: Principal = {
  id: "operator",
  attributes: { scopes: ["catalog:read", "catalog:write", "support"] },
};
const reader: Principal = {
  id: "reader",
  attributes: { scopes: ["catalog:read"] },
};

function hasScope(principal: Principal | null, scope: string): boolean {
  const scopes = principal?.attributes?.scopes;
  return Array.isArray(scopes) && scopes.includes(scope);
}

interface SearchOutput {
  readonly tools: ReadonlyArray<{
    readonly id: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
    readonly annotations?: Readonly<Record<string, unknown>>;
  }>;
  readonly truncated: boolean;
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

function setup(
  options: Omit<DiscoveryOptions, "gateway"> = {},
  decisions: GatewayDecision[] = [],
) {
  const gateway = createGateway({
    upstreams: [
      engineUpstream({ name: "catalog", engine: createLargeCatalogEngine() }),
      engineUpstream({
        name: "support",
        engine: createSupportEngine(),
        namespace: "helpdesk",
      }),
    ],
    rules: [
      {
        name: "helpdesk",
        match: "helpdesk.*",
        access: requireScopes("support"),
      },
      {
        name: "reads",
        match: ["*"],
        access: ({ principal, route }) =>
          hasScope(
            principal,
            route.readOnly ? "catalog:read" : "catalog:write",
          ),
        visible: (principal) => principal !== null,
      },
    ],
    onDecision: (decision) => {
      decisions.push(decision);
    },
  });
  const discovery = createDiscovery({ gateway, ...options });
  const engine = createEngine({
    name: "gateway-discovery",
    version: "0.1.0",
    capabilities: discovery.capabilities,
  });
  return { gateway, discovery, engine };
}

function search(
  engine: ReturnType<typeof setup>["engine"],
  query: string,
  principal: Principal | null,
  limit?: number,
): Promise<SearchOutput> {
  return engine.invoke(
    "gateway.search-tools",
    { query, ...(limit === undefined ? {} : { limit }) } as never,
    { principal },
  ) as Promise<SearchOutput>;
}

describe("createDiscovery", () => {
  it("publishes three discovery tools for a 200-tool catalog", () => {
    const { gateway, engine } = setup();

    expect(gateway.routes).toHaveLength(203);
    expect(engine.list()).toEqual([
      expect.objectContaining({
        id: "gateway.search-tools",
        annotations: { readOnly: true },
      }),
      expect.objectContaining({
        id: "gateway.invoke-read-tool",
        annotations: { readOnly: true },
      }),
      expect.objectContaining({
        id: "gateway.invoke-tool",
        annotations: { destructive: true, openWorld: true },
      }),
    ]);
    expect(engine.describe("gateway.search-tools").description).toContain(
      "in English",
    );
  });

  it("lets the host replace the query guidance for semantic rankers", () => {
    const { engine } = setup({
      queryGuidance:
        "Describe the user's whole task in one sentence, in any language.",
    });
    const description = engine.describe("gateway.search-tools").description;

    expect(description).toContain(
      "Describe the user's whole task in one sentence, in any language.",
    );
    expect(description).not.toContain("keywords");
    expect(() => setup({ queryGuidance: "" })).toThrow(TypeError);
    expect(() => setup({ queryGuidance: "x".repeat(501) })).toThrow(TypeError);
  });

  it("returns ranked, visible tools with their schemas", async () => {
    const { engine } = setup();

    const result = await search(engine, "cancel order", operator, 3);
    expect(result.truncated).toBe(false);
    expect(result.tools).toHaveLength(3);
    expect(result.tools[0]).toMatchObject({
      id: "orders.cancel-order",
      description: "Cancel an order that has not completed.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      annotations: { destructive: true },
    });

    const exact = await search(engine, "crm.get-account", operator, 1);
    expect(exact.tools.map((tool) => tool.id)).toEqual(["crm.get-account"]);
    expect((await search(engine, "zzz", operator)).tools).toEqual([]);
  });

  it("never returns a capability hidden from the caller", async () => {
    const { engine } = setup();

    const asReader = await search(engine, "close ticket", reader, 20);
    const asOperator = await search(engine, "close ticket", operator, 20);
    const anonymous = await search(engine, "close ticket", null, 20);

    expect(asReader.tools.map((tool) => tool.id)).not.toContain(
      "helpdesk.support.close-ticket",
    );
    expect(asOperator.tools[0]?.id).toBe("helpdesk.support.close-ticket");
    expect(anonymous.tools).toEqual([]);
  });

  it("measures lexical recall in English and documents that it does not cross languages", async () => {
    const { engine } = setup();
    const english: ReadonlyArray<readonly [string, string]> = [
      ["cancel order", "orders.cancel-order"],
      ["export report csv", "reporting.export-report"],
      ["approve contract", "legal.approve-contract"],
      ["delete employee", "hr.delete-employee"],
      ["archive campaign", "marketing.archive-campaign"],
      ["create customer", "crm.create-customer"],
      ["search tickets by keyword", "support.search-ticket"],
      ["update vendor", "procurement.update-vendor"],
      ["get shipment", "logistics.get-shipment"],
      ["list meetings", "calendar.list-meeting"],
    ];
    const portuguese: ReadonlyArray<readonly [string, string]> = [
      ["cancelar pedido", "orders.cancel-order"],
      ["exportar relatório", "reporting.export-report"],
      ["aprovar contrato", "legal.approve-contract"],
      ["excluir funcionário", "hr.delete-employee"],
      ["arquivar campanha", "marketing.archive-campaign"],
      ["criar cliente", "crm.create-customer"],
      ["buscar chamados", "support.search-ticket"],
      ["atualizar fornecedor", "procurement.update-vendor"],
      ["consultar remessa", "logistics.get-shipment"],
      ["listar reuniões", "calendar.list-meeting"],
    ];
    const recallAt8 = async (queries: typeof english) => {
      let found = 0;
      for (const [query, expected] of queries) {
        const { tools } = await search(engine, query, operator, 8);
        if (tools.some((tool) => tool.id === expected)) found += 1;
      }
      return found / queries.length;
    };

    expect(objects).toHaveLength(20);
    expect(actions).toHaveLength(10);
    expect(await recallAt8(english)).toBe(1);
    expect(await recallAt8(portuguese)).toBeLessThanOrEqual(0.2);
  });

  it("invokes a target through the gateway engine with its own rule", async () => {
    const decisions: GatewayDecision[] = [];
    const { engine } = setup({}, decisions);

    await expect(
      engine.invoke(
        "gateway.invoke-read-tool",
        { tool: "orders.get-order", arguments: { id: "O-1" } },
        { principal: reader, requestId: "r-read" },
      ),
    ).resolves.toEqual({ result: { ok: true, action: "get" } });
    expect(decisions.at(-1)).toEqual({
      requestId: "r-read",
      capabilityId: "orders.get-order",
      upstream: "catalog",
      rule: "reads",
      outcome: "allowed",
      principalId: "reader",
    });

    const forbidden = await failure(
      engine.invoke(
        "gateway.invoke-tool",
        { tool: "orders.cancel-order" },
        { principal: reader },
      ),
    );
    expect(forbidden.code).toBe("FORBIDDEN");
    await expect(
      engine.invoke(
        "gateway.invoke-tool",
        { tool: "orders.cancel-order", arguments: {} },
        { principal: operator },
      ),
    ).resolves.toEqual({ result: { ok: true, action: "cancel" } });
  });

  it("routes only trusted read-only targets to invoke-read-tool", async () => {
    const { engine } = setup();

    const destructive = await failure(
      engine.invoke(
        "gateway.invoke-read-tool",
        { tool: "orders.cancel-order" },
        { principal: operator },
      ),
    );
    expect(destructive.code).toBe("DOMAIN_ERROR");
    expect(destructive.publicDetails).toEqual({
      code: "TOOL_NOT_READ_ONLY",
      retryable: false,
      details: { tool: "orders.cancel-order" },
    });
  });

  it("rejects an untrusted MCP read-only hint on invoke-read-tool", async () => {
    const connection: GatewayMcpConnection = {
      async listTools() {
        return {
          tools: [
            {
              name: "wipe",
              description: "Claims to be harmless.",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true },
            },
          ],
        };
      },
      async callTool() {
        return { response: { content: [] } };
      },
    };
    const gateway = createGateway({
      upstreams: [
        await mcpUpstream({
          validator: "delegate-to-upstream",
          name: "remote",
          connection,
        }),
      ],
      rules: [{ match: "*", access: "authenticated" }],
    });
    const engine = createEngine({
      name: "discovery",
      version: "0.1.0",
      capabilities: createDiscovery({ gateway }).capabilities,
    });

    const result = await failure(
      engine.invoke(
        "gateway.invoke-read-tool",
        { tool: "remote.wipe" },
        { principal: operator },
      ),
    );
    expect(result.publicDetails).toMatchObject({ code: "TOOL_NOT_READ_ONLY" });
  });

  it("answers hidden and unknown targets identically without invoking", async () => {
    const decisions: GatewayDecision[] = [];
    const { engine } = setup({}, decisions);

    const hidden = await failure(
      engine.invoke(
        "gateway.invoke-tool",
        { tool: "helpdesk.support.close-ticket" },
        { principal: reader },
      ),
    );
    const unknown = await failure(
      engine.invoke(
        "gateway.invoke-tool",
        { tool: "helpdesk.support.missing" },
        { principal: reader },
      ),
    );

    expect(hidden.code).toBe("DOMAIN_ERROR");
    expect(hidden.message).toBe(unknown.message);
    expect(hidden.publicDetails).toEqual({
      code: "TOOL_NOT_FOUND",
      retryable: false,
      details: { tool: "helpdesk.support.close-ticket" },
    });
    expect(unknown.publicDetails).toEqual({
      code: "TOOL_NOT_FOUND",
      retryable: false,
      details: { tool: "helpdesk.support.missing" },
    });
    expect(decisions).toEqual([]);
  });

  it("wraps target domain errors and keeps framework codes", async () => {
    const { engine } = setup();

    const domain = await failure(
      engine.invoke(
        "gateway.invoke-tool",
        {
          tool: "helpdesk.support.close-ticket",
          arguments: { ticketId: "T-closed" },
        },
        {
          principal: {
            ...operator,
            attributes: { ...operator.attributes, agent: true },
          },
        },
      ),
    );
    expect(domain.publicDetails).toEqual({
      code: "TOOL_DOMAIN_ERROR",
      retryable: false,
      details: {
        tool: "helpdesk.support.close-ticket",
        code: "TICKET_ALREADY_CLOSED",
        retryable: false,
        details: { ticketId: "T-closed" },
      },
    });

    const invalid = await failure(
      engine.invoke(
        "gateway.invoke-read-tool",
        {
          tool: "helpdesk.support.classify-ticket",
          arguments: { ticketId: "" },
        },
        { principal: operator },
      ),
    );
    expect(invalid.code).toBe("INPUT_INVALID");
  });

  it("validates the discovery tool inputs", async () => {
    const { engine } = setup();

    for (const input of [
      { query: "" },
      { query: "   " },
      { query: "x".repeat(257) },
      { query: "order", limit: 0 },
      { query: "order", limit: 21 },
      { query: "order", limit: 1.5 },
      { query: "order", extra: true },
    ]) {
      expect(
        (
          await failure(
            engine.invoke("gateway.search-tools", input as never, {
              principal: operator,
            }),
          )
        ).code,
      ).toBe("INPUT_INVALID");
    }
    expect(
      (
        await failure(
          engine.invoke(
            "gateway.invoke-tool",
            { tool: "orders.get-order", arguments: [] } as never,
            { principal: operator },
          ),
        )
      ).code,
    ).toBe("INPUT_INVALID");
  });

  it("publishes alwaysList capabilities directly, subject to visibility", async () => {
    const { discovery, engine } = setup({
      alwaysList: ["orders.get-order", "helpdesk.*"],
    });

    expect(engine.list().map((summary) => summary.id)).toEqual([
      "gateway.search-tools",
      "gateway.invoke-read-tool",
      "gateway.invoke-tool",
      "orders.get-order",
      "helpdesk.support.classify-ticket",
      "helpdesk.support.close-ticket",
      "helpdesk.support.wait",
    ]);
    expect(
      discovery.visibility({
        principal: reader,
        capabilityId: "helpdesk.support.close-ticket",
      }),
    ).toBe(false);
    expect(
      discovery.visibility({
        principal: reader,
        capabilityId: "orders.get-order",
      }),
    ).toBe(true);
    expect(
      discovery.visibility({
        principal: null,
        capabilityId: "gateway.search-tools",
      }),
    ).toBe(true);
    expect(
      discovery.visibility({
        principal: operator,
        capabilityId: "crm.get-account",
      }),
    ).toBe(false);
    await expect(
      engine.invoke("orders.get-order", { id: "O-1" }, { principal: reader }),
    ).resolves.toEqual({ ok: true, action: "get" });
    expect(
      (
        await failure(
          engine.invoke(
            "orders.get-order",
            {},
            { principal: { id: "nobody" } },
          ),
        )
      ).code,
    ).toBe("FORBIDDEN");
  });

  it("bounds alwaysList and rejects patterns that match nothing", () => {
    expect(() =>
      setup({ alwaysList: ["crm.*", "orders.*", "billing.*", "hr.*"] }),
    ).toThrow(
      new TypeError(
        "Discovery alwaysList selects 60 capabilities; at most 32 are allowed.",
      ),
    );
    expect(() => setup({ alwaysList: ["shop.*"] })).toThrow(
      new TypeError(
        "Discovery alwaysList pattern shop.* matches no capability.",
      ),
    );
  });

  it("keeps the response within its byte budget", async () => {
    const huge = "word ".repeat(9_000);
    const connection: GatewayMcpConnection = {
      async listTools() {
        return {
          tools: ["a", "b", "c"].map((name) => ({
            name: `big-${name}`,
            description: `big tool ${name} ${huge}`,
            inputSchema: { type: "object" },
          })),
        };
      },
      async callTool() {
        return { response: { content: [] } };
      },
    };
    const gateway = createGateway({
      upstreams: [
        await mcpUpstream({
          validator: "delegate-to-upstream",
          name: "remote",
          connection,
        }),
      ],
      rules: [{ match: "*", access: "authenticated" }],
    });
    const engine = createEngine({
      name: "discovery",
      version: "0.1.0",
      capabilities: createDiscovery({ gateway }).capabilities,
    });

    const result = (await engine.invoke(
      "gateway.search-tools",
      { query: "big tool", limit: 3 },
      { principal: operator },
    )) as SearchOutput;
    expect(result.tools.length).toBeLessThan(3);
    expect(result.tools.length).toBeGreaterThan(0);
    expect(result.truncated).toBe(true);
    expect(
      new TextEncoder().encode(JSON.stringify(result)).length,
    ).toBeLessThanOrEqual(65_536);
  });

  it("lets a host ranker reorder or drop, but never add, tools", async () => {
    const rank = vi.fn(
      async (_query: string, candidates: ReadonlyArray<{ id: string }>) => [
        "helpdesk.support.close-ticket",
        "made.up-tool",
        candidates.at(-1)?.id ?? "",
        "orders.get-order",
        "orders.get-order",
      ],
    );
    const searches: unknown[] = [];
    const { engine } = setup({
      rank,
      onSearch: (event) => {
        searches.push(event);
      },
    });

    const result = await search(engine, "anything", reader, 5);
    expect(result.tools.map((tool) => tool.id)).toEqual([
      "calendar.cancel-meeting",
      "orders.get-order",
    ]);
    expect(rank.mock.calls[0]?.[1]).toHaveLength(200);
    expect(searches).toEqual([
      expect.objectContaining({
        principalId: "reader",
        resultCount: 2,
        ranker: "custom",
      }),
    ]);
    expect(JSON.stringify(searches)).not.toContain("anything");
  });

  it("falls back to lexical ranking when the ranker fails or times out", async () => {
    const searches: Array<{ ranker: string }> = [];
    const failing = setup({
      rank: async () => {
        throw new Error("embedding service down");
      },
      onSearch: (event) => {
        searches.push(event);
      },
    });
    const slow = setup({
      rank: () => new Promise(() => undefined),
      rankTimeoutMs: 20,
      onSearch: (event) => {
        searches.push(event);
      },
    });

    expect(
      (await search(failing.engine, "cancel order", operator, 1)).tools[0]?.id,
    ).toBe("orders.cancel-order");
    expect(
      (await search(slow.engine, "cancel order", operator, 1)).tools[0]?.id,
    ).toBe("orders.cancel-order");
    expect(searches.map((event) => event.ranker)).toEqual([
      "lexical-fallback",
      "lexical-fallback",
    ]);
  });

  it("wraps every target in the host's middleware, through discovery and directly", async () => {
    const calls: string[] = [];
    const { discovery, engine } = setup({
      gatewayEngine: {
        middleware: [
          async ({ capabilityId, next }) => {
            calls.push(capabilityId);
            return next();
          },
        ],
      },
    });

    await engine.invoke(
      "gateway.invoke-read-tool",
      { tool: "orders.get-order" },
      { principal: reader },
    );
    await discovery.gatewayEngine.invoke(
      "crm.get-account",
      {},
      { principal: reader },
    );

    expect(calls).toEqual(["orders.get-order", "crm.get-account"]);
    expect(() =>
      setup({
        gatewayEngine: { middleware: ["rate-limit" as never] },
      }),
    ).toThrow(TypeError);
  });

  it("invokes targets only through its own engine over the gateway capabilities", async () => {
    const events: string[] = [];
    const { gateway, discovery } = setup({
      gatewayEngine: {
        name: "acme-gateway",
        version: "2.0.0",
        onEvent: (event) => {
          events.push(`${event.type}:${event.capabilityId}`);
        },
      },
    });

    expect(discovery.gatewayEngine.name).toBe("acme-gateway");
    expect(discovery.gatewayEngine.list().map((summary) => summary.id)).toEqual(
      gateway.routes.map((route) => route.capabilityId),
    );
    await discovery.gatewayEngine.invoke(
      "orders.get-order",
      {},
      { principal: reader },
    );
    expect(events).toEqual([
      "invocation.started:orders.get-order",
      "invocation.completed:orders.get-order",
    ]);
    expect(() => createDiscovery({ gateway, prefix: "Bad Prefix" })).toThrow(
      TypeError,
    );
  });

  it("serves the discovery tools and alwaysList over MCP per caller", async () => {
    const { discovery, engine } = setup({ alwaysList: ["helpdesk.*"] });
    const handler = createMcpHttpHandler(engine, {
      visibility: discovery.visibility,
      auth: {
        mode: "required",
        authenticate: ({ headers }) =>
          headers.get("x-user") === "operator" ? operator : reader,
      },
    });
    const call = async (user: string, body: Record<string, unknown>) =>
      (await (
        await handler(
          new Request("http://127.0.0.1/mcp", {
            method: "POST",
            headers: {
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
              "x-user": user,
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
          }),
        )
      ).json()) as { result: Record<string, unknown> };

    const names = async (user: string) =>
      (
        (await call(user, { method: "tools/list" })).result.tools as {
          name: string;
        }[]
      ).map((tool) => tool.name);
    expect(await names("reader")).toEqual([
      "gateway_search-tools",
      "gateway_invoke-read-tool",
      "gateway_invoke-tool",
    ]);
    expect(await names("operator")).toHaveLength(6);

    const found = await call("reader", {
      method: "tools/call",
      params: {
        name: "gateway_search-tools",
        arguments: { query: "export invoice", limit: 1 },
      },
    });
    expect(found.result.structuredContent).toMatchObject({
      tools: [{ id: "billing.export-invoice" }],
    });
  });
});
