import { EngineError, type Principal } from "@invokta/core";
import {
  connectMcpClient,
  type McpClientConnection,
  type McpHttpServerHandle,
} from "@invokta/mcp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startCrmMcpHttp } from "../src/crm-mcp-http.js";
import { createCrmGateway } from "../src/gateway.js";
import {
  portugueseGlossaryRanker,
  translateQuery,
} from "../src/ranking/portuguese-glossary.js";

const serviceToken = "crm-service-token-for-tests";
const salesReader: Principal = {
  id: "sales-reader",
  attributes: { scopes: ["crm:read"] },
};
const salesOps: Principal = {
  id: "sales-ops",
  attributes: { scopes: ["crm:read", "crm:write"] },
};

let crmServer: McpHttpServerHandle;
let crm: McpClientConnection;

beforeEach(async () => {
  crmServer = await startCrmMcpHttp({ serviceToken, port: 0 });
  const { host, port } = crmServer.address();
  crm = await connectMcpClient({
    transport: "http",
    url: `http://${host}:${String(port)}/mcp`,
    authentication: { type: "bearer", token: serviceToken },
  });
});

afterEach(async () => {
  await crm.close();
  await crmServer.close();
});

interface SearchResult {
  readonly tools: ReadonlyArray<{ readonly id: string }>;
}

async function search(
  engine: Awaited<ReturnType<typeof createCrmGateway>>["discoveryEngine"],
  query: string,
  principal: Principal,
): Promise<string[]> {
  const result = (await engine.invoke(
    "gateway.search-tools",
    { query, limit: 8 },
    { principal },
  )) as SearchResult;
  return result.tools.map((tool) => tool.id);
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

const portugueseQueries: ReadonlyArray<readonly [string, string]> = [
  ["cancelar pedido", "crm.orders_cancel-order"],
  ["exportar relatório", "crm.analytics_export-report"],
  ["aprovar contrato", "crm.legal_approve-contract"],
  ["arquivar campanha", "crm.marketing_archive-campaign"],
  ["criar cliente", "crm.accounts_create-customer"],
  ["buscar chamados", "crm.service_search-ticket"],
  ["atualizar fornecedor", "crm.procurement_update-vendor"],
  ["consultar remessa", "crm.logistics_get-shipment"],
  ["listar reuniões", "crm.calendar_list-meeting"],
  ["exportar faturas", "crm.billing_export-invoice"],
];

async function portugueseRecall(
  engine: Awaited<ReturnType<typeof createCrmGateway>>["discoveryEngine"],
): Promise<number> {
  let found = 0;
  for (const [query, expected] of portugueseQueries) {
    if ((await search(engine, query, salesOps)).includes(expected)) found += 1;
  }
  return found / portugueseQueries.length;
}

describe("the CRM gateway", () => {
  it("publishes the vendor's 200 tools with trusted, pinned annotations", async () => {
    const { gateway, catalogFingerprint } = await createCrmGateway({ crm });

    expect(gateway.routes).toHaveLength(200);
    expect(gateway.routes.filter((route) => route.readOnly)).toHaveLength(80);
    expect(catalogFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    await expect(
      createCrmGateway({ crm, catalogPin: "f".repeat(64) }),
    ).rejects.toThrow("does not match the pinned fingerprint");
  });

  it("shows each caller only the tools it can call, and nobody deletions", async () => {
    const { gateway } = await createCrmGateway({ crm });
    const visible = (principal: Principal) =>
      gateway.routes.filter((route) =>
        gateway.visibility({ principal, capabilityId: route.capabilityId }),
      );

    expect(visible(salesReader)).toHaveLength(80);
    expect(visible(salesReader).every((route) => route.readOnly)).toBe(true);
    expect(visible(salesOps)).toHaveLength(180);
    expect(
      visible(salesOps).some((route) =>
        route.upstreamCapabilityId.includes("_delete-"),
      ),
    ).toBe(false);
    expect(visible({ id: "no-scopes" })).toHaveLength(0);
  });

  it("publishes three discovery tools plus the alwaysList", async () => {
    const { discoveryEngine } = await createCrmGateway({ crm });

    expect(discoveryEngine.list().map((summary) => summary.id)).toEqual([
      "gateway.search-tools",
      "gateway.invoke-read-tool",
      "gateway.invoke-tool",
      "crm.accounts_get-customer",
      "crm.service_search-ticket",
    ]);
  });

  it("finds English queries lexically and searches only visible tools", async () => {
    const { discoveryEngine } = await createCrmGateway({ crm });

    expect((await search(discoveryEngine, "cancel order", salesOps))[0]).toBe(
      "crm.orders_cancel-order",
    );
    expect(
      await search(discoveryEngine, "cancel order", salesReader),
    ).not.toContain("crm.orders_cancel-order");
    expect(
      await search(discoveryEngine, "delete order", salesOps),
    ).not.toContain("crm.orders_delete-order");
  });

  it("needs the glossary ranker for Portuguese queries over English descriptions", async () => {
    const lexical = await createCrmGateway({ crm });
    const withGlossary = await createCrmGateway({
      crm,
      rank: portugueseGlossaryRanker,
    });

    expect(translateQuery("Listar reuniões")).toBe("list meeting");
    expect(await portugueseRecall(lexical.discoveryEngine)).toBeLessThanOrEqual(
      0.2,
    );
    expect(await portugueseRecall(withGlossary.discoveryEngine)).toBe(1);
    expect(
      (await search(withGlossary.discoveryEngine, "cancel order", salesOps))[0],
    ).toBe("crm.orders_cancel-order");
  });

  it("invokes through the gateway rules by risk class", async () => {
    const { discoveryEngine } = await createCrmGateway({ crm });

    await expect(
      discoveryEngine.invoke(
        "gateway.invoke-read-tool",
        { tool: "crm.orders_get-order", arguments: { id: "O-1" } },
        { principal: salesReader },
      ),
    ).resolves.toEqual({
      result: { ok: true, operation: "get", record: "order" },
    });

    const notReadOnly = await failure(
      discoveryEngine.invoke(
        "gateway.invoke-read-tool",
        { tool: "crm.orders_cancel-order" },
        { principal: salesOps },
      ),
    );
    expect(notReadOnly.publicDetails).toMatchObject({
      code: "TOOL_NOT_READ_ONLY",
    });

    await expect(
      discoveryEngine.invoke(
        "gateway.invoke-tool",
        { tool: "crm.orders_cancel-order" },
        { principal: salesOps },
      ),
    ).resolves.toEqual({
      result: { ok: true, operation: "cancel", record: "order" },
    });

    const deletion = await failure(
      discoveryEngine.invoke(
        "gateway.invoke-tool",
        { tool: "crm.orders_delete-order" },
        { principal: salesOps },
      ),
    );
    expect(deletion.publicDetails).toMatchObject({ code: "TOOL_NOT_FOUND" });
  });
});
