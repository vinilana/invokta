import { hashApiKey } from "@invokta/gateway";
import {
  connectMcpClient,
  type McpClientConnection,
  type McpHttpServerHandle,
} from "@invokta/mcp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createGatewayAuthenticator,
  parseApiKeys,
} from "../src/access/authenticate.js";
import { startDocsMcpHttp } from "../src/docs-mcp-http.js";
import {
  type AcmeGatewayServers,
  startAcmeGateway,
} from "../src/gateway-http.js";

const serviceToken = "docs-service-token-for-tests";
const keys = {
  support: "support-agent-key",
  finance: "finance-bot-key",
  reader: "reader-key",
} as const;

let docsServer: McpHttpServerHandle;
let servers: AcmeGatewayServers;
const clients: McpClientConnection[] = [];

beforeEach(async () => {
  docsServer = await startDocsMcpHttp({ serviceToken, port: 0 });
  const docs = docsServer.address();
  servers = await startAcmeGateway({
    docsUrl: `http://${docs.host}:${String(docs.port)}/mcp`,
    docsServiceToken: serviceToken,
    mcpPort: 0,
    httpPort: 0,
    authenticate: createGatewayAuthenticator({
      apiKeys: parseApiKeys(
        JSON.stringify([
          {
            id: "support-agent",
            sha256: await hashApiKey(keys.support),
            scopes: ["support", "billing:read"],
            agent: true,
          },
          {
            id: "finance-bot",
            sha256: await hashApiKey(keys.finance),
            scopes: ["billing:read", "billing:refund"],
          },
          { id: "reader", sha256: await hashApiKey(keys.reader) },
        ]),
      ),
    }),
  });
});

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await servers.close();
  await docsServer.close();
});

function httpUrl(path: string): string {
  const { host, port } = servers.http.address();
  return `http://${host}:${String(port)}${path}`;
}

async function mcpClient(key: string): Promise<McpClientConnection> {
  const { host, port } = servers.mcp.address();
  const client = await connectMcpClient({
    transport: "http",
    url: `http://${host}:${String(port)}/mcp`,
    authentication: { type: "headers", headers: { "x-api-key": key } },
  });
  clients.push(client);
  return client;
}

describe("the Acme gateway servers", () => {
  it("releases the MCP listener and docs connection when startup fails", async () => {
    const docs = docsServer.address();
    const { port } = servers.mcp.address();
    await expect(
      startAcmeGateway({
        docsUrl: `http://${docs.host}:${String(docs.port)}/mcp`,
        docsServiceToken: serviceToken,
        mcpPort: 0,
        // Already in use by the running gateway's MCP listener.
        httpPort: port,
        authenticate: () => null,
      }),
    ).rejects.toThrow();
  });

  it("authenticates every HTTP request and lists per caller", async () => {
    expect((await fetch(httpUrl("/capabilities"))).status).toBe(401);

    const listed = async (key: string) =>
      (
        (await (
          await fetch(httpUrl("/capabilities"), {
            headers: { "x-api-key": key },
          })
        ).json()) as { capabilities: { id: string }[] }
      ).capabilities.map((capability) => capability.id);

    expect(await listed(keys.reader)).toEqual(["kb.docs_search"]);
    expect(await listed(keys.finance)).toEqual([
      "billing.get-invoice",
      "billing.refund-invoice",
      "kb.docs_search",
    ]);
  });

  it("invokes over HTTP JSON and hides what the caller cannot use", async () => {
    const refund = (key: string) =>
      fetch(httpUrl("/capabilities/billing.refund-invoice"), {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ invoiceId: "INV-1001" }),
      });

    const hidden = await refund(keys.support);
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toMatchObject({
      error: { code: "CAPABILITY_NOT_FOUND" },
    });

    const allowed = await refund(keys.finance);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ refunded: true });

    const again = await refund(keys.finance);
    expect(again.status).toBe(422);
    expect(await again.json()).toMatchObject({
      error: {
        code: "DOMAIN_ERROR",
        publicDetails: { code: "ALREADY_REFUNDED" },
      },
    });
  });

  it("serves agents over MCP with the same rules", async () => {
    const support = await mcpClient(keys.support);
    expect((await support.listTools()).tools.map((tool) => tool.name)).toEqual([
      "support_classify-ticket",
      "support_close-ticket",
      "billing_get-invoice",
      "kb_docs_search",
    ]);

    const classified = await support.callTool("support_classify-ticket", {
      ticketId: "T-9",
      subject: "Refund for a double charge",
    });
    expect(classified.response.structuredContent).toEqual({
      ticketId: "T-9",
      category: "billing",
    });

    const searched = await support.callTool("kb_docs_search", {
      query: "password",
    });
    expect(searched.response.structuredContent).toMatchObject({
      articles: [{ slug: "reset-password" }],
    });

    const reader = await mcpClient(keys.reader);
    expect((await reader.listTools()).tools.map((tool) => tool.name)).toEqual([
      "kb_docs_search",
    ]);
  });
});
