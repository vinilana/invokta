import { apiKeyAuthenticator, hashApiKey } from "@invokta/gateway";
import {
  connectMcpClient,
  type McpClientConnection,
  type McpHttpServerHandle,
} from "@invokta/mcp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseApiKeys } from "../src/access/api-keys.js";
import { startCrmMcpHttp } from "../src/crm-mcp-http.js";
import {
  type CrmGatewayServers,
  startCrmGateway,
} from "../src/gateway-http.js";
import { portugueseGlossaryRanker } from "../src/ranking/portuguese-glossary.js";

const serviceToken = "crm-service-token-for-tests";
const keys = { reader: "sales-reader-key", ops: "sales-ops-key" } as const;

let crmServer: McpHttpServerHandle;
let servers: CrmGatewayServers;
const clients: McpClientConnection[] = [];

beforeEach(async () => {
  crmServer = await startCrmMcpHttp({ serviceToken, port: 0 });
  const crm = crmServer.address();
  servers = await startCrmGateway({
    crmUrl: `http://${crm.host}:${String(crm.port)}/mcp`,
    crmServiceToken: serviceToken,
    catalogPort: 0,
    discoveryPort: 0,
    rank: portugueseGlossaryRanker,
    authenticate: apiKeyAuthenticator({
      keys: parseApiKeys(
        JSON.stringify([
          {
            id: "sales-reader",
            sha256: await hashApiKey(keys.reader),
            scopes: ["crm:read"],
          },
          {
            id: "sales-ops",
            sha256: await hashApiKey(keys.ops),
            scopes: ["crm:read", "crm:write"],
          },
        ]),
      ),
    }),
  });
});

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await servers.close();
  await crmServer.close();
});

async function client(
  server: McpHttpServerHandle,
  path: string,
  key: string,
): Promise<McpClientConnection> {
  const { host, port } = server.address();
  const connection = await connectMcpClient({
    transport: "http",
    url: `http://${host}:${String(port)}${path}`,
    authentication: { type: "headers", headers: { "x-api-key": key } },
  });
  clients.push(connection);
  return connection;
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

describe("the CRM gateway servers", () => {
  it("serves a per-caller full catalog and a small discovery catalog", async () => {
    const fullOps = await client(servers.catalog, "/mcp", keys.ops);
    const fullReader = await client(servers.catalog, "/mcp", keys.reader);
    const discoveryOps = await client(
      servers.discovery,
      "/search/mcp",
      keys.ops,
    );

    const fullOpsTools = (await fullOps.listTools()).tools;
    const fullReaderTools = (await fullReader.listTools()).tools;
    const discoveryTools = (await discoveryOps.listTools()).tools;

    expect(fullOpsTools).toHaveLength(180);
    expect(fullReaderTools).toHaveLength(80);
    expect(discoveryTools.map((tool) => tool.name)).toEqual([
      "gateway_search-tools",
      "gateway_invoke-read-tool",
      "gateway_invoke-tool",
      "crm_accounts_get-customer",
      "crm_service_search-ticket",
    ]);
    // The discovery catalog stays small whatever the vendor publishes.
    expect(bytes(discoveryTools)).toBeLessThan(bytes(fullOpsTools) / 10);
  });

  it("searches in Portuguese and invokes the tool it found", async () => {
    const ops = await client(servers.discovery, "/search/mcp", keys.ops);

    const found = await ops.callTool("gateway_search-tools", {
      query: "cancelar pedido",
      limit: 3,
    });
    const tools = (
      found.response.structuredContent as {
        tools: { id: string; inputSchema: Record<string, unknown> }[];
      }
    ).tools;
    expect(tools[0]?.id).toBe("crm.orders_cancel-order");
    expect(tools[0]?.inputSchema).toMatchObject({ type: "object" });

    const invoked = await ops.callTool("gateway_invoke-tool", {
      tool: "crm.orders_cancel-order",
      arguments: { id: "O-42" },
    });
    expect(invoked.response.structuredContent).toEqual({
      result: { ok: true, operation: "cancel", record: "order" },
    });
  });

  it("keeps writes away from a read-only caller on both endpoints", async () => {
    const reader = await client(servers.discovery, "/search/mcp", keys.reader);

    const write = await reader.callTool("gateway_invoke-tool", {
      tool: "crm.orders_cancel-order",
    });
    expect(write.response.isError).toBe(true);
    expect(JSON.stringify(write.response.content)).toContain("TOOL_NOT_FOUND");

    const full = await client(servers.catalog, "/mcp", keys.reader);
    await expect(
      full.callTool("crm_orders_cancel-order", {}),
    ).rejects.toThrow();
  });
});
