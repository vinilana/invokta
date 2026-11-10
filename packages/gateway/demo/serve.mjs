// Runnable demo. Build the workspace first (`yarn build`), then run
// `node packages/gateway/demo/serve.mjs` from the repository root.
//
// It starts four loopback listeners:
//   - an upstream "docs" Action Engine over MCP HTTP, reachable only with a
//     service token that only the gateway holds;
//   - the gateway over MCP HTTP, for agent clients, listing only the tools
//     each caller may see;
//   - the same gateway over plain HTTP JSON, for applications and curl; and
//   - search-based discovery over MCP HTTP at /search/mcp, for clients that
//     should see three tools instead of the whole catalog.
// A local "billing" engine is aggregated in-process next to the MCP upstream.
import { randomBytes } from "node:crypto";
import process from "node:process";

import { CapabilityError, createEngine, defineCapability } from "@invokta/core";
import { serveHttp } from "@invokta/http/node";
import { connectMcpClient, serveMcpHttp } from "@invokta/mcp";
import { z } from "zod";

import {
  apiKeyAuthenticator,
  chainAuthenticators,
  createDiscovery,
  createGateway,
  engineUpstream,
  hashApiKey,
  mcpUpstream,
  requireScopes,
} from "../dist/index.js";

const secret = () => randomBytes(24).toString("base64url");
const serviceToken = secret();
const agentKey = secret();
const readerKey = secret();

const docsEngine = createEngine({
  name: "docs-engine",
  version: "1.0.0",
  capabilities: {
    "docs.search": defineCapability({
      description: "Search the product documentation.",
      input: z.object({ query: z.string().min(1) }),
      output: z.object({ hits: z.array(z.string()) }),
      access: "authenticated",
      annotations: { readOnly: true },
      async run({ input }) {
        return { hits: [`Result for "${input.query}"`] };
      },
    }),
  },
});

const billingEngine = createEngine({
  name: "billing-engine",
  version: "1.0.0",
  capabilities: {
    "billing.get-invoice": defineCapability({
      description: "Return one invoice summary.",
      input: z.object({ invoiceId: z.string() }),
      output: z.object({ invoiceId: z.string(), total: z.number() }),
      access: "public",
      annotations: { readOnly: true },
      async run({ input }) {
        return { invoiceId: input.invoiceId, total: 42 };
      },
    }),
    "billing.refund": defineCapability({
      description: "Refund one invoice.",
      input: z.object({ invoiceId: z.string() }),
      output: z.object({ refunded: z.boolean() }),
      access: "authenticated",
      annotations: { destructive: true },
      errors: {
        ALREADY_REFUNDED: { description: "The invoice is already refunded." },
      },
      async run({ input }) {
        if (input.invoiceId === "I-0") {
          throw new CapabilityError("ALREADY_REFUNDED");
        }
        return { refunded: true };
      },
    }),
  },
});

const upstreamServer = await serveMcpHttp(docsEngine, {
  port: 3101,
  auth: {
    mode: "required",
    authenticate: ({ headers }) =>
      headers.get("authorization") === `Bearer ${serviceToken}`
        ? { id: "gateway-service" }
        : null,
  },
});
const docsConnection = await connectMcpClient({
  transport: "http",
  url: "http://127.0.0.1:3101/mcp",
  authentication: { type: "bearer", token: serviceToken },
});

const docs = await mcpUpstream({
  validator: "delegate-to-upstream",
  name: "docs",
  namespace: "kb",
  connection: docsConnection,
  // The operator vouches for this tool; the server's own hint is not trusted.
  readOnlyTools: ["docs_search"],
});

const gateway = createGateway({
  upstreams: [engineUpstream({ name: "billing", engine: billingEngine }), docs],
  rules: [
    { name: "kb-read", match: "kb.*", access: requireScopes("kb:read") },
    { name: "invoice-read", match: "billing.get-invoice", access: "public" },
    {
      name: "refunds",
      match: "billing.refund",
      access: requireScopes("billing:refund"),
    },
  ],
  onDecision(decision) {
    process.stderr.write(`decision ${JSON.stringify(decision)}\n`);
  },
});

const discovery = createDiscovery({
  gateway,
  gatewayEngine: { name: "acme-gateway", version: "1.0.0" },
  onSearch(event) {
    process.stderr.write(`search ${JSON.stringify(event)}\n`);
  },
});
// One engine serves the full catalog; discovery invokes through the same one.
const engine = discovery.gatewayEngine;
const discoveryEngine = createEngine({
  name: "acme-gateway-discovery",
  version: "1.0.0",
  capabilities: discovery.capabilities,
});

const auth = {
  mode: "required",
  authenticate: chainAuthenticators(
    apiKeyAuthenticator({
      keys: [
        {
          id: "support-agent",
          sha256: await hashApiKey(agentKey),
          attributes: { scopes: ["kb:read", "billing:refund"] },
        },
        { id: "reader", sha256: await hashApiKey(readerKey) },
      ],
    }),
  ),
};
const visibility = gateway.visibility;
const mcpServer = await serveMcpHttp(engine, { port: 3100, auth, visibility });
const httpServer = await serveHttp(engine, { port: 3102, auth, visibility });
const discoveryServer = await serveMcpHttp(discoveryEngine, {
  port: 3103,
  path: "/search/mcp",
  auth,
  visibility: discovery.visibility,
});

process.stdout.write(
  [
    "Gateway demo is running.",
    "",
    `Upstream docs pinned fingerprint: ${docs.fingerprint}`,
    "Routes:",
    ...gateway.routes.map(
      (route) =>
        `  ${route.capabilityId} -> ${route.upstream}:${route.upstreamCapabilityId} (rule ${route.rule})`,
    ),
    "",
    `Agent key (kb:read, billing:refund): ${agentKey}`,
    `Reader key (no scopes):              ${readerKey}`,
    "",
    "MCP endpoint:       http://127.0.0.1:3100/mcp         (send the key as x-api-key)",
    "HTTP endpoint:      http://127.0.0.1:3102/capabilities",
    "Discovery endpoint: http://127.0.0.1:3103/search/mcp  (3 tools: search, invoke-read, invoke)",
    "",
    "Try:",
    `  curl -s -H 'x-api-key: ${readerKey}' http://127.0.0.1:3102/capabilities`,
    `  curl -s -X POST -H 'x-api-key: ${agentKey}' -H 'content-type: application/json' -d '{"query":"gateway"}' http://127.0.0.1:3102/capabilities/kb.docs_search`,
    `  curl -s -X POST -H 'x-api-key: ${readerKey}' -H 'content-type: application/json' -d '{"invoiceId":"I-1"}' http://127.0.0.1:3102/capabilities/billing.refund`,
    `  curl -s -X POST -H 'x-api-key: ${agentKey}' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"gateway_search-tools","arguments":{"query":"refund invoice"}}}' http://127.0.0.1:3103/search/mcp`,
    "",
    "Press Ctrl+C to stop.",
    "",
  ].join("\n"),
);

const stop = async () => {
  await Promise.allSettled([
    mcpServer.close(),
    httpServer.close(),
    discoveryServer.close(),
    docsConnection.close(),
  ]);
  await upstreamServer.close();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
