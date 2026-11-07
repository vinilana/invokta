# @invokta/gateway (proof of concept)

> Private and experimental. This package is not published. Its design,
> trade-offs, and delivery plan are in
> [Action Engine gateway](../../docs/action-engine-gateway.md).

Serve several Action Engines and MCP servers behind one endpoint that checks
the authentication and authorization rules you configure.

The gateway is not a new runtime. `createGateway` returns an ordinary
capability map: pass it to `createEngine` and serve that engine with
`@invokta/mcp`, `@invokta/http`, or `@invokta/cli`. Every call still goes
through `engine.invoke`.

## Quick start

```ts
import { createEngine } from "@invokta/core";
import { connectMcpClient, serveMcpHttp } from "@invokta/mcp";
import {
  apiKeyAuthenticator,
  chainAuthenticators,
  createGateway,
  engineUpstream,
  hashApiKey,
  mcpUpstream,
  requireScopes,
} from "@invokta/gateway";

const docs = await connectMcpClient({
  transport: "http",
  url: "https://docs.internal.example/mcp",
  authentication: { type: "bearer", token: process.env.DOCS_SERVICE_TOKEN! },
});

const gateway = createGateway({
  upstreams: [
    engineUpstream({ name: "billing", engine: billingEngine }),
    await mcpUpstream({ name: "docs", namespace: "kb", connection: docs }),
  ],
  rules: [
    { name: "no-refunds", match: "billing.refund", access: "deny" },
    { name: "billing-read", match: "billing.*", access: "authenticated" },
    { name: "kb-read", match: "kb.*", access: requireScopes("kb:read") },
  ],
  onDecision: (decision) => console.error(JSON.stringify(decision)),
});

const engine = createEngine({
  name: "acme-gateway",
  version: "1.0.0",
  capabilities: gateway.capabilities,
});

await serveMcpHttp(engine, {
  auth: {
    mode: "required",
    authenticate: chainAuthenticators(
      apiKeyAuthenticator({
        keys: [
          {
            id: "support-agent",
            sha256: await hashApiKey(process.env.SUPPORT_AGENT_KEY!),
            attributes: { scopes: ["kb:read"] },
          },
        ],
      }),
    ),
  },
});
```

## What it does

| Concern | Behavior |
| --- | --- |
| Engine upstream | Republishes the engine's contracts from `list`/`describe` and forwards to its `invoke`; the upstream's validation, access rule, timeout, progress, and events still apply |
| MCP upstream | Lists tools once at startup (bounded), publishes `<namespace>.<tool>`, forwards to `callTool` with a finite timeout, and can pin the catalog fingerprint |
| Authentication | The adapter's `authenticate` hook; `chainAuthenticators` combines methods such as `@invokta/auth-jwt` and `apiKeyAuthenticator` |
| Authorization | First matching rule by capability ID (`id`, `prefix.*`, `*`); `deny` by default; a throwing rule denies |
| Audit | `onDecision` receives request ID, capability, upstream, rule, outcome, and principal ID; never payloads |
| Exposure | `include` per upstream; `gateway.routes` lists every published capability and its rule |

## Run the demo

```sh
yarn build
node packages/gateway/demo/serve.mjs
```

The demo starts an upstream MCP engine that only the gateway's service token
can reach, aggregates it with an in-process engine, and serves the gateway
over MCP HTTP (`127.0.0.1:3100/mcp`) and HTTP JSON (`127.0.0.1:3102`). It
prints two generated API keys and `curl` commands to try allowed, forbidden,
and domain-error calls.

## Test

```sh
yarn vitest run packages/gateway
```
