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
  indexFromEnvironment,
  startCrmGateway,
} from "../src/gateway-http.js";
import { startFakeEmbeddingsApi } from "./support/concept-embedder.js";

const serviceToken = "crm-service-token-for-tests";
const opsKey = "sales-ops-key";

let crmServer: McpHttpServerHandle;
let embeddings: Awaited<ReturnType<typeof startFakeEmbeddingsApi>>;
let servers: CrmGatewayServers;
const clients: McpClientConnection[] = [];

beforeEach(async () => {
  crmServer = await startCrmMcpHttp({ serviceToken, port: 0 });
  embeddings = await startFakeEmbeddingsApi();
  const crm = crmServer.address();
  servers = await startCrmGateway({
    crmUrl: `http://${crm.host}:${String(crm.port)}/mcp`,
    crmServiceToken: serviceToken,
    catalogPort: 0,
    discoveryPort: 0,
    // The same configuration path as the entry point, pointed at the fake.
    index: indexFromEnvironment({
      EMBEDDINGS_BASE_URL: embeddings.baseUrl,
      EMBEDDINGS_MODEL: "concept-test-model",
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
  await embeddings.close();
  await crmServer.close();
});

describe("the semantic search gateway servers", () => {
  it("searches in Portuguese over MCP and calls the tool found", async () => {
    expect(servers.indexed).toBe(200);
    const { host, port } = servers.discovery.address();
    const client = await connectMcpClient({
      transport: "http",
      url: `http://${host}:${String(port)}/search/mcp`,
      authentication: { type: "headers", headers: { "x-api-key": opsKey } },
    });
    clients.push(client);

    const found = await client.callTool("gateway_search-tools", {
      query: "consultar a remessa 991",
      limit: 3,
    });
    const tools = (
      found.response.structuredContent as { tools: { id: string }[] }
    ).tools;
    expect(tools[0]?.id).toBe("crm.logistics_get-shipment");

    const result = await client.callTool("gateway_invoke-read-tool", {
      tool: "crm.logistics_get-shipment",
      arguments: { id: "991" },
    });
    expect(result.response.structuredContent).toEqual({
      result: { ok: true, operation: "get", record: "shipment" },
    });
  });
});
