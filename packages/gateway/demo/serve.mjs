// Runnable proof of concept. Build the workspace first (`yarn build`), then run
// `node packages/gateway/demo/serve.mjs` from the repository root.
//
// It starts three loopback listeners:
//   - an upstream "docs" Action Engine over MCP HTTP, reachable only with a
//     service token that only the gateway holds;
//   - the gateway over MCP HTTP, for agent clients; and
//   - the same gateway over plain HTTP JSON, for applications and curl.
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
  name: "docs",
  namespace: "kb",
  connection: docsConnection,
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

const engine = createEngine({
  name: "acme-gateway",
  version: "0.0.0-poc",
  capabilities: gateway.capabilities,
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
const mcpServer = await serveMcpHttp(engine, { port: 3100, auth });
const httpServer = await serveHttp(engine, { port: 3102, auth });

process.stdout.write(
  [
    "Gateway proof of concept is running.",
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
    "MCP endpoint:  http://127.0.0.1:3100/mcp   (send the key as x-api-key)",
    "HTTP endpoint: http://127.0.0.1:3102/capabilities",
    "",
    "Try:",
    `  curl -s -H 'x-api-key: ${readerKey}' http://127.0.0.1:3102/capabilities`,
    `  curl -s -X POST -H 'x-api-key: ${agentKey}' -H 'content-type: application/json' -d '{"query":"gateway"}' http://127.0.0.1:3102/capabilities/kb.docs_search`,
    `  curl -s -X POST -H 'x-api-key: ${readerKey}' -H 'content-type: application/json' -d '{"invoiceId":"I-1"}' http://127.0.0.1:3102/capabilities/billing.refund`,
    "",
    "Press Ctrl+C to stop.",
    "",
  ].join("\n"),
);

const stop = async () => {
  await Promise.allSettled([
    mcpServer.close(),
    httpServer.close(),
    docsConnection.close(),
  ]);
  await upstreamServer.close();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
