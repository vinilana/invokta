import { createEngine, defineCapability } from "@invokta/core";
import { createHttpHandler } from "@invokta/http";
import {
  connectMcpClient,
  type McpClientConnection,
  type McpHttpServerHandle,
  serveMcpHttp,
} from "@invokta/mcp";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  apiKeyAuthenticator,
  chainAuthenticators,
  createGateway,
  engineUpstream,
  hashApiKey,
  mcpUpstream,
  requireScopes,
} from "../src/index.js";
import { createBillingEngine } from "./support/engines.js";

const upstreamServiceToken = "upstream-service-token";
const connections: McpClientConnection[] = [];
const servers: McpHttpServerHandle[] = [];

afterEach(async () => {
  await Promise.allSettled(connections.splice(0).map((c) => c.close()));
  await Promise.allSettled(servers.splice(0).map((s) => s.close()));
});

/** An unrelated Action Engine that only the gateway's service identity may call. */
const docsEngine = createEngine({
  name: "docs-engine",
  version: "2.0.0",
  capabilities: {
    "docs.search": defineCapability({
      description: "Search the documentation index.",
      input: z.object({ query: z.string() }),
      output: z.object({ hits: z.array(z.string()) }),
      access: "authenticated",
      async run({ input, context }) {
        const hits: string[] = [
          `${input.query} via ${context.principal?.id ?? "anonymous"}`,
        ];
        return { hits };
      },
    }),
  },
});

async function startDocsServer(): Promise<string> {
  const server = await serveMcpHttp(docsEngine, {
    port: 0,
    auth: {
      mode: "required",
      authenticate: ({ headers }) =>
        headers.get("authorization") === `Bearer ${upstreamServiceToken}`
          ? { id: "gateway-service" }
          : null,
    },
  });
  servers.push(server);
  const { host, port } = server.address();
  return `http://${host}:${String(port)}/mcp`;
}

const supportKey = "support-agent-key";
const readerKey = "reader-key";

async function createGatewayEngine() {
  const connection = await connectMcpClient({
    transport: "http",
    url: await startDocsServer(),
    authentication: { type: "bearer", token: upstreamServiceToken },
  });
  connections.push(connection);

  const gateway = createGateway({
    upstreams: [
      engineUpstream({ name: "billing", engine: createBillingEngine() }),
      await mcpUpstream({ name: "docs", namespace: "kb", connection }),
    ],
    rules: [
      { name: "kb-read", match: "kb.*", access: requireScopes("kb:read") },
      { name: "billing-read", match: "billing.get-invoice", access: "public" },
    ],
  });
  return createEngine({
    name: "acme-gateway",
    version: "0.1.0",
    capabilities: gateway.capabilities,
  });
}

async function createAuthenticate() {
  return chainAuthenticators(
    apiKeyAuthenticator({
      keys: [
        {
          id: "support-agent",
          sha256: await hashApiKey(supportKey),
          attributes: { scopes: ["kb:read"] },
        },
        { id: "reader", sha256: await hashApiKey(readerKey) },
      ],
    }),
  );
}

describe("a gateway engine in front of an engine and an MCP server", () => {
  it("serves both upstreams over plain HTTP JSON with authentication and rules", async () => {
    const handler = createHttpHandler(await createGatewayEngine(), {
      auth: { mode: "required", authenticate: await createAuthenticate() },
    });
    const call = (id: string, body: unknown, key?: string) =>
      handler(
        new Request(`http://127.0.0.1/capabilities/${id}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(key === undefined ? {} : { "x-api-key": key }),
          },
          body: JSON.stringify(body),
        }),
      );

    const listed = await handler(
      new Request("http://127.0.0.1/capabilities", {
        headers: { "x-api-key": readerKey },
      }),
    );
    expect(
      (
        (await listed.json()) as { capabilities: { id: string }[] }
      ).capabilities.map((capability) => capability.id),
    ).toEqual(["billing.get-invoice", "billing.refund", "kb.docs_search"]);

    const unauthenticated = await call("kb.docs_search", { query: "x" });
    expect(unauthenticated.status).toBe(401);

    const allowed = await call("kb.docs_search", { query: "mcp" }, supportKey);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({
      hits: ["mcp via gateway-service"],
    });

    const missingScope = await call(
      "kb.docs_search",
      { query: "mcp" },
      readerKey,
    );
    expect(missingScope.status).toBe(403);

    const deniedByDefault = await call(
      "billing.refund",
      { invoiceId: "I-1" },
      supportKey,
    );
    expect(deniedByDefault.status).toBe(403);

    const publicRule = await call(
      "billing.get-invoice",
      { invoiceId: "I-9" },
      readerKey,
    );
    expect(await publicRule.json()).toEqual({ invoiceId: "I-9", total: 42 });
  });

  it("serves the same gateway engine to MCP clients", async () => {
    const gateway = await serveMcpHttp(await createGatewayEngine(), {
      port: 0,
      auth: { mode: "required", authenticate: await createAuthenticate() },
    });
    servers.push(gateway);
    const { host, port } = gateway.address();
    const client = await connectMcpClient({
      transport: "http",
      url: `http://${host}:${String(port)}/mcp`,
      authentication: { type: "headers", headers: { "x-api-key": supportKey } },
    });
    connections.push(client);

    const page = await client.listTools();
    expect(page.tools.map((tool) => tool.name)).toEqual([
      "billing_get-invoice",
      "billing_refund",
      "kb_docs_search",
    ]);
    const { response } = await client.callTool("kb_docs_search", {
      query: "agents",
    });
    expect(response.structuredContent).toEqual({
      hits: ["agents via gateway-service"],
    });
    const denied = await client.callTool("billing_refund", {
      invoiceId: "I-1",
    });
    expect(denied.response.isError).toBe(true);
  });
});
