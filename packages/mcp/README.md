# @invokta/mcp

MCP adapters and a plain-type client facade for Invokta Action Engines. The
adapters publish an engine's capabilities over MCP stdio and stateless
Streamable HTTP; the client facade connects to an MCP server and returns plain
JSON values.

The official MCP SDK is confined to this package
([ADR 0006](../../docs/adr/0006-isolated-official-mcp-sdk-and-protocol-2025-11-25.md)).
No SDK type, transport object, schema, or credential crosses the public API.
The normative contracts live in [`docs/`](../../docs/README.md) and the ADRs; a
conflict between this file and an ADR is resolved in favor of the ADR.

## Serving an engine

```ts
import { serveMcpHttp, serveMcpStdio } from "@invokta/mcp";

await serveMcpStdio(engine, { principal });

const server = await serveMcpHttp(engine, {
  port: 3000,
  auth: { mode: "required", authenticate: (request) => resolve(request) },
});
```

Both adapters execute every tool call through `engine.invoke`, so the CLI,
direct calls, and MCP share one execution path. `serveMcpHttp` is stateless and
requires an explicit `auth` choice: `mode: "required"` with an `authenticate`
hook, or the deliberately verbose
`mode: "dangerously-disabled-for-development"`. When `auth.resourceMetadata` is
supplied, the server publishes the RFC 9728 protected resource metadata document
and answers unauthenticated requests with a `WWW-Authenticate` challenge naming
it. Authorization servers must use HTTPS; a loopback HTTP resource may name a
loopback HTTP authorization server for local development.

The protocol endpoint is `/mcp` by default. `path` mounts it under a prefix so
several engines can share one origin, each behind its own loopback-bound
server and its own resource identifier
([ADR 0039](../../docs/adr/0039-configurable-mcp-http-mount-path.md)):

```ts
const orders = await serveMcpHttp(ordersEngine, {
  port: 3101,
  path: "/e/orders/mcp",
  allowedHosts: ["gateway.example.com"],
  auth: {
    mode: "required",
    authenticate,
    resourceMetadata: {
      resource: "https://gateway.example.com/e/orders/mcp",
      authorizationServers: ["https://gateway.example.com"],
    },
  },
});
```

A mount path is an absolute path of unreserved ASCII segments, at most 256
bytes, without a dot segment, an empty segment, percent encoding, a query, a
fragment, or a trailing slash, and its final segment is `mcp`. The resource
must use exactly that path, and its metadata is served at
`/.well-known/oauth-protected-resource<path>`.

Tool names are derived from capability IDs with `toMcpToolName`, which keeps
dotted domain IDs visible to clients that enforce `^[a-zA-Z0-9_-]{1,64}$`
([ADR 0025](../../docs/adr/0025-portable-mcp-tool-names.md)).
`validateMcpToolCatalog(engine)` fails closed with an
`McpToolNameCollisionError` when two capability IDs would publish the same tool
name.

## Connecting as a client

```ts
import { connectMcpClient } from "@invokta/mcp";

const connection = await connectMcpClient({
  transport: "http",
  url: "https://engine.example.com/mcp",
  authentication: { type: "bearer", token },
});
const { tools } = await connection.listTools();
await connection.close();
```

A target is either `stdio` (command, args, cwd, env) or `http` (URL, plus
`none`, `bearer`, or `headers` authentication). Every failure is an
`McpClientError` carrying one of `INVALID_TARGET`, `SPAWN_FAILED`,
`CONNECTION_FAILED`, `AUTHENTICATION_FAILED`, `PROTOCOL_ERROR`, `TIMEOUT`,
`LIMIT_EXCEEDED`, or `CANCELLED`.

## Interactive OAuth

`beginMcpOAuthAuthorization` performs discovery, dynamic client registration,
and PKCE preparation, then returns one validated authorization URL. `finish`
exchanges the single-use code and returns the same plain `McpClientConnection`.
Tokens, PKCE material, and registration artifacts stay in process memory and are
cleared on `close`
([ADR 0023](../../docs/adr/0023-ephemeral-oauth-for-installed-mcp-inspection.md),
amended by
[ADR 0031](../../docs/adr/0031-oauth-discovery-inspection-and-advertised-servers.md)).

Protected resource metadata is read only from the MCP resource's own origin.
The authorization servers that document advertises are then trusted for
authorization-server metadata and, once that metadata validates with a matching
issuer, the endpoints it publishes — dynamic client registration, the
authorization endpoint, and the token endpoint — are trusted on their own
origins too, so an engine can delegate to a hosted identity provider that
serves its OAuth endpoints apart from its issuer.

## Inspecting OAuth discovery

```ts
import { inspectMcpOAuth } from "@invokta/mcp";

const inspection = await inspectMcpOAuth({
  transport: "http",
  url: "https://engine.example.com/mcp",
  authentication: { type: "oauth" },
});

for (const step of inspection.steps) {
  console.log(step.name, step.outcome, step.summary, step.hint ?? "");
}
```

```ts
function inspectMcpOAuth(
  target: McpOAuthClientTarget,
  options?: McpClientOperationOptions,
): Promise<McpOAuthInspection>;

interface McpOAuthInspection {
  readonly steps: readonly McpOAuthStep[];
  readonly ready: boolean;
}

interface McpOAuthStep {
  readonly name:
    | "challenge"
    | "resource-metadata"
    | "authorization-server-metadata"
    | "registration";
  readonly outcome: "ok" | "failed" | "skipped";
  readonly summary: string;
  readonly hint?: string;
  readonly detail?: McpJsonValue;
}
```

The inspection is read-only. It sends one unauthenticated MCP request to observe
the `401` challenge, reads the protected resource metadata and the first
advertised authorization server's RFC 8414 document, and reports whether that
server advertises a registration endpoint. It never authorizes, never registers,
never sends a credential, and leaves nothing behind.

Every step is reported. A step that needed the output of a failed step is
`skipped` and says so. A network error, an unexpected status, a malformed
document, or a document that fails validation is a `failed` step with a
one-line `summary` and a remediation `hint`; `detail` carries the document when
one was read. `ready` is `true` only when an interactive authorization could be
attempted. An `McpClientError` is thrown only for an invalid target descriptor
or a cancelled operation.
