# @invokta/gateway

Serve several Action Engines and MCP servers behind one endpoint that checks
the authentication and authorization rules you configure.

The gateway is not a new runtime. `createGateway` returns an ordinary
capability map: pass it to `createEngine` and serve that engine with
`@invokta/mcp`, `@invokta/http`, or `@invokta/cli`. Every call still goes
through `engine.invoke`.

## Install

```sh
npm install @invokta/core @invokta/gateway
```

The package is native ESM and an optional runtime helper. Its only dependency
is `@invokta/core`; it depends on no adapter or MCP SDK, and its modules use
only ECMAScript and Web platform globals. It is tested on Node.js 22.20.0 or
later, the version its manifest declares.

## Use

```ts
import { createEngine } from "@invokta/core";
import { createJwtBearerAuthenticator } from "@invokta/auth-jwt";
import { connectMcpClient, serveMcpHttp } from "@invokta/mcp";
import {
  apiKeyAuthenticator,
  chainAuthenticators,
  createGateway,
  engineUpstream,
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
    await mcpUpstream({
      name: "docs",
      namespace: "kb",
      connection: docs,
      validator, // or "delegate-to-upstream"; see Validation
    }),
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
      createJwtBearerAuthenticator({
        issuer: "https://identity.example.com",
        audience: "https://gateway.example.com/mcp",
        algorithms: ["RS256"],
        jwksUrl: "https://identity.example.com/.well-known/jwks.json",
      }),
      apiKeyAuthenticator({
        keys: [
          {
            id: "support-agent",
            // A digest printed once with hashApiKey; never the key itself.
            sha256: process.env.SUPPORT_AGENT_KEY_SHA256!,
            attributes: { scopes: ["kb:read"] },
          },
        ],
      }),
    ),
  },
  visibility: gateway.visibility,
});
```

## What it does

| Concern | Behavior |
| --- | --- |
| Engine upstream | Republishes the engine's contracts from `list` and `describe` and forwards to its `invoke`; the upstream's validation, access rule, timeout, progress, and events still apply |
| MCP upstream | Lists tools once at startup within bounds, publishes `<namespace>.<tool>`, and forwards to `callTool` with a finite timeout; `pin` and `lock` fail startup when the catalog changes |
| Validation | Every MCP upstream chooses a synchronous JSON Schema validator or `"delegate-to-upstream"` |
| Authentication | The adapter's `authenticate` hook; `chainAuthenticators` combines methods such as `@invokta/auth-jwt` and `apiKeyAuthenticator` |
| Authorization | First matching rule by capability ID (`id`, `prefix.*`, `*`); `deny` by default; a throwing rule denies |
| Audit | `onDecision` receives request ID, capability, upstream, rule, outcome, and principal ID; never payloads |
| Exposure | `include` per upstream; `gateway.routes` lists every published capability, its rule, and its trusted read-only status |
| Visibility | `gateway.visibility` for the adapters' `visibility` option: each caller lists and calls only what its rules can allow; hidden equals nonexistent |
| Annotation trust | Untrusted MCP hints only make a tool look riskier; `trustAnnotations` or `readOnlyTools` vouch for an upstream's tools |
| Discovery | `createDiscovery` publishes `search-tools`, `invoke-read-tool`, and `invoke-tool`, plus an optional `alwaysList`, whatever the catalog size |

## Upstreams

`engineUpstream(options)` returns synchronously. `mcpUpstream(options)` lists
tools and returns a promise; await it before serving.

| `mcpUpstream` option | Default | Contract |
| --- | --- | --- |
| `name` | Required | 1-64 lowercase letters, digits, or inner hyphens; unique per gateway |
| `connection` | Required | `listTools` and `callTool`; `McpClientConnection` from `@invokta/mcp` fits |
| `validator` | Required | A `JsonSchemaValidator` or `"delegate-to-upstream"` |
| `namespace` | `name` | Prefix of the published IDs |
| `include` | Every tool | Tool name patterns; each must match a tool |
| `timeoutMs` | `30000` | Finite timeout of every tool call |
| `discoveryTimeoutMs` | `30000` | Deadline of the whole discovery, at most `300000` |
| `maxTools` | `256` | At most `4096`; discovery also reads at most 64 pages |
| `maxToolBytes` | `65536` | Canonical size of one tool definition, at most `1048576` |
| `pin` | None | Expected catalog fingerprint |
| `lock` | None | A reviewed `McpCatalogLock`; differences fail with `McpCatalogLockError` |
| `trustAnnotations` | `false` | Trust every annotation hint of this server |
| `readOnlyTools` | None | Tool names the operator vouches are read-only |
| `forwardToolErrors` | `false` | Publish the first 1,024 characters of a tool error's text |
| `signal` | None | Cancels discovery |

A tool name must have 1 to 128 characters from `A-Z`, `a-z`, `0-9`, `.`, `_`,
and `-`. A tool error is the declared domain error `UPSTREAM_TOOL_ERROR`. Its
upstream text may hold internal details, so it reaches callers only with
`forwardToolErrors: true`.

`engineUpstream` accepts `name`, `engine`, `namespace`, `include`, `principal`
(maps the gateway caller to the upstream principal), and `validator`. An
upstream `DOMAIN_ERROR` is raised again with the same code, and the upstream
`timeoutMs` is republished.

## Validation

Every MCP upstream makes an explicit choice. A validator, such as Ajv, checks
input against the tool's input schema before the gateway rule and the call,
failing as `INPUT_INVALID`, and a structured result against the output schema,
failing as `OUTPUT_INVALID`:

```ts
import { Ajv, type ValidateFunction } from "ajv";
import type { JsonSchemaValidator } from "@invokta/gateway";

const ajv = new Ajv({ strict: false });
const compiled = new WeakMap<object, ValidateFunction>();

export const validator: JsonSchemaValidator = (schema, value) => {
  let validate = compiled.get(schema);
  if (validate === undefined) {
    validate = ajv.compile(schema);
    // An upstream schema with "$async": true compiles to a validator that
    // returns a promise, which is always truthy: refuse it.
    if ("$async" in validate) {
      throw new TypeError("Asynchronous schemas are not supported.");
    }
    compiled.set(schema, validate);
  }
  if (validate(value) === true) return undefined;
  return (validate.errors ?? []).map((error) => ({
    message: error.message ?? "Invalid value.",
    path: error.instancePath.split("/").slice(1),
  }));
};
```

The validator is synchronous, and the gateway passes the same frozen schema on
every call so it can be compiled once. A validator that throws or returns
anything but a list or `undefined`, including a promise, fails closed.

MCP schemas are chosen by the upstream server, so treat them as untrusted
input to the validator:

- Refuse asynchronous schemas, as above; compare `validate(value)` with `true`.
- A `pattern` keyword runs a regular expression the server chose. Use Ajv's
  `code: { regExp }` option with a linear-time engine such as RE2, or reject
  schemas with patterns you have not reviewed; `lock` makes such a review
  stick.
- Do not enable options that change the value, such as `useDefaults`,
  `coerceTypes`, or `removeAdditional`. The gateway does not support mutating
  validators: the value a validator receives is the caller's input.

`"delegate-to-upstream"` names the trade-off: the gateway checks only that
values are JSON objects, rules read unvalidated input, and the server's
rejection of invalid input is an `UPSTREAM_TOOL_ERROR`. Engine upstreams need
no validator, because the upstream `engine.invoke` validates; pass one to make
gateway rules read validated input.

## Rules

A rule is `{ name?, match, access, visible? }`. `access` is `public`,
`authenticated`, `deny`, or a function of `{ principal, input, context, route }`
that allows only when it returns `true`. The first matching rule governs a
capability; unmatched capabilities get `defaultAccess`, `deny` by default.
Every pattern must match a capability and a rule shadowed by earlier rules
fails construction, so a typo cannot silently change policy.

An MCP upstream sees only the gateway's service credential, so every caller
the gateway allows acts with that credential's authority. Give the service
credential no more authority than the rules allow. Engine upstreams still
enforce their own access rules against the mapped principal.

## Large catalogs

Filter the catalog per caller with the adapters' `visibility` option, as in
the example above. For clients that should not receive hundreds of tools,
serve search-based discovery as its own engine. Every invocation still goes
through the target's gateway rule:

```ts
const discovery = createDiscovery({
  gateway,
  alwaysList: ["kb.docs_search"],
  onSearch: (event) => audit.write(event),
});

// The full catalog, for clients that search tools on their own.
await serveMcpHttp(discovery.gatewayEngine, {
  auth,
  visibility: gateway.visibility,
});

// Three discovery tools plus alwaysList.
await serveMcpHttp(
  createEngine({
    name: "acme-gateway-discovery",
    version: "1.0.0",
    capabilities: discovery.capabilities,
  }),
  { port: 3001, path: "/search/mcp", auth, visibility: discovery.visibility },
);
```

`search-tools` ranks with deterministic BM25 over the weighted ID, title, and
description, with diacritic and plural folding. It does not cross languages:
write descriptions and queries in the same language, or inject a `rank` port
for semantic search. A ranker can only reorder or drop visible tools, and a
ranker that fails or misses `rankTimeoutMs` (2,000 ms by default) falls back
to lexical search. Results stay within 64 KiB of structured content.

## Limits

| Concern | Behavior |
| --- | --- |
| Catalog | Read once at startup; the gateway never re-lists tools |
| Dropped upstream connection | Calls fail until the host reconnects and restarts |
| Rich MCP content of a tool without an output schema | Returned as structured `{ content }` |
| Caller credentials | Never forwarded to an upstream |
| Rules | Match on the capability ID; anything else needs an access function |
| Search query | At most 256 characters; at most 20 results |

## Examples

The repository has four runnable examples:

- `examples/gateway-engine`: two in-process engines and another team's MCP
  server behind API-key and JWT authentication, first-match rules, per-caller
  visibility, and audit.
- `examples/gateway-discovery-engine`: a vendor's 200-tool MCP server served
  as a per-caller catalog and as search-based discovery, with a host-owned
  Portuguese glossary ranker.
- `examples/gateway-jev-engine`: TypeSafe's Jev as the `rank` port, deciding
  which visible tools a task needs.
- `examples/gateway-semantic-search-engine`: an embeddings index prepared at
  startup as the `rank` port.

Read the [gateway reference](https://docs.invokta.dev/reference/gateway/) for
the full API.
