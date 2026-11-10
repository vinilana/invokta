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
  selectorFromEnvironment,
  startCrmGateway,
} from "../src/gateway-http.js";
import { startFakeTypeSafeApi } from "./support/fake-typesafe-api.js";

const serviceToken = "crm-service-token-for-tests";
const typesafeKey = "ts-test-key-0123456789";
const opsKey = "sales-ops-key";

let crmServer: McpHttpServerHandle;
let typesafe: Awaited<ReturnType<typeof startFakeTypeSafeApi>>;
let servers: CrmGatewayServers;
const clients: McpClientConnection[] = [];

beforeEach(async () => {
  crmServer = await startCrmMcpHttp({ serviceToken, port: 0 });
  typesafe = await startFakeTypeSafeApi(typesafeKey);
  const crm = crmServer.address();
  servers = await startCrmGateway({
    crmUrl: `http://${crm.host}:${String(crm.port)}/mcp`,
    crmServiceToken: serviceToken,
    catalogPort: 0,
    discoveryPort: 0,
    // The same configuration path as the entry point, pointed at the fake.
    selector: selectorFromEnvironment({
      TYPESAFE_API_KEY: typesafeKey,
      TYPESAFE_BASE_URL: typesafe.baseUrl,
      JEV_THRESHOLD: "0.6",
    }),
    authenticate: apiKeyAuthenticator({
      keys: parseApiKeys(
        JSON.stringify([
          {
            id: "sales-ops",
            sha256: await hashApiKey(opsKey),
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
  await typesafe.close();
  await crmServer.close();
});

describe("the Jev-backed gateway servers", () => {
  it("lets an MCP client ask which tools a task needs, then call them", async () => {
    const { host, port } = servers.discovery.address();
    const client = await connectMcpClient({
      transport: "http",
      url: `http://${host}:${String(port)}/search/mcp`,
      authentication: { type: "headers", headers: { "x-api-key": opsKey } },
    });
    clients.push(client);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "gateway_search-tools",
      "gateway_invoke-read-tool",
      "gateway_invoke-tool",
    ]);

    const found = await client.callTool("gateway_search-tools", {
      query: "Cancel order O-42 and archive its invoice",
    });
    const tools = (
      found.response.structuredContent as {
        tools: { id: string; inputSchema: Record<string, unknown> }[];
      }
    ).tools;
    expect(tools.map((tool) => tool.id)).toEqual([
      "crm.billing_archive-invoice",
      "crm.orders_cancel-order",
    ]);
    expect(tools[0]?.inputSchema).toMatchObject({ type: "object" });

    const cancelled = await client.callTool("gateway_invoke-tool", {
      tool: "crm.orders_cancel-order",
      arguments: { id: "O-42" },
    });
    expect(cancelled.response.structuredContent).toEqual({
      result: { ok: true, operation: "cancel", record: "order" },
    });
  });
});
