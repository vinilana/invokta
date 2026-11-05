# Integrating an identity provider at the HTTP boundary

`@invokta/mcp` accepts a pluggable authentication hook, converts a valid
request identity into the framework's minimal `Principal`, and passes that
principal to `engine.invoke`. When OAuth metadata is configured, the framework
acts only as a Resource Server boundary. It does not perform login or consent,
issue or refresh tokens, store users or sessions, act as an Authorization
Server, or prescribe a JWT or introspection implementation.

When the host accepts signed JWT access tokens from one issuer that publishes a
JWKS, the optional [`@invokta/auth-jwt`](#jwt-bearer-helper) package provides
the hook. Otherwise, use an identity library or trusted identity service
already selected by the host application. Keep provider-specific request and
response types outside the engine's capabilities.

The plain HTTP JSON adapter in `@invokta/http` takes the same
`{ mode: "required", authenticate }` option, and its `HttpAuthenticationRequest`
has the same structure as `McpHttpAuthenticationRequest`, so one authenticator
serves both adapters. It issues the same plain `Bearer` challenge and has no
Protected Resource Metadata option (ADR 0048).

## Required authentication

The authentication hook receives only request-boundary data: `method`, `path`,
a read-only header view with `get` and `has`, and an `AbortSignal`. This
provider-neutral example assumes an injected verifier that distinguishes
invalid credentials from infrastructure failure:

```ts
import type { Principal } from "@invokta/core";
import {
  type McpHttpHeaderView,
  serveMcpHttp,
} from "@invokta/mcp";

import { engine } from "./engine.js";

interface VerifiedIdentity {
  readonly subject: string;
  readonly scopes: ReadonlyArray<string>;
}

interface AccessTokenVerifier {
  verify(
    token: string,
    options: { readonly signal: AbortSignal },
  ): Promise<VerifiedIdentity | null>;
}

declare const verifier: AccessTokenVerifier;

function readBearerToken(headers: McpHttpHeaderView): string | null {
  const authorization = headers.get("authorization");
  if (authorization === null) return null;

  // RFC 9110 makes the authentication scheme case-insensitive.
  const match = /^Bearer ([^\s]+)$/iu.exec(authorization);
  return match?.[1] ?? null;
}

function toPrincipal(identity: VerifiedIdentity): Principal {
  return {
    id: identity.subject,
    attributes: {
      scopes: identity.scopes,
    },
  };
}

await serveMcpHttp(engine, {
  host: "127.0.0.1",
  port: 3000,
  auth: {
    mode: "required",
    async authenticate(request) {
      const token = readBearerToken(request.headers);
      if (token === null) return null;

      const identity = await verifier.verify(token, {
        signal: request.signal,
      });
      return identity === null ? null : toPrincipal(identity);
    },
    resourceMetadata: {
      resource: "https://engine.example.com/mcp",
      authorizationServers: ["https://identity.example.com"],
      scopesSupported: ["engine:invoke"],
    },
    challengeScopes: ["engine:invoke"],
  },
});
```

The verifier contract above is application code, not a framework abstraction.
It may be implemented by a provider SDK, token introspection client, JOSE/JWT
library, workload identity mechanism, or trusted reverse-proxy integration.

The hook must return:

- a valid `Principal` for an authenticated request;
- `null` for a missing, malformed, expired, revoked, or otherwise invalid
  credential;
- a rejected promise or thrown error only when authentication infrastructure
  cannot complete the check.

A `null` result produces HTTP 401 before `engine.invoke`. A thrown or rejected
hook produces a sanitized HTTP 500 because the adapter cannot safely infer that
an arbitrary failure means an invalid credential. The framework does not retry
the identity provider.

The adapter validates and snapshots the exact authentication mode and required
hook before listening. Mutating the configuration object afterward cannot
disable authentication or replace the hook. It deep-clones every returned
principal immediately, requires a nonempty string `id`, and accepts
`attributes` only when it is a record. A malformed or non-cloneable principal is
treated like invalid credentials and produces HTTP 401. This request-local
snapshot prevents later mutation or reuse of a principal object from changing
another request's identity.

## JWT bearer helper

`@invokta/auth-jwt` returns a hook that verifies one configured issuer's signed
JWT access tokens with `jose` (ADR 0049):

```ts
import { createJwtBearerAuthenticator } from "@invokta/auth-jwt";

const requiredScopes = ["engine:invoke"];

await serveMcpHttp(engine, {
  auth: {
    mode: "required",
    authenticate: createJwtBearerAuthenticator({
      issuer: "https://identity.example.com",
      audience: "https://engine.example.com/mcp",
      algorithms: ["RS256"],
      jwksUrl: "https://identity.example.com/.well-known/jwks.json",
      requiredScopes,
    }),
    resourceMetadata: {
      resource: "https://engine.example.com/mcp",
      authorizationServers: ["https://identity.example.com"],
      scopesSupported: requiredScopes,
    },
    challengeScopes: requiredScopes,
  },
});
```

The helper reads only `Authorization: Bearer <compact JWS>` with a
case-insensitive scheme, one space, and a token of at most 8,192 characters by
default. It requires an explicit asymmetric algorithm allowlist, the exact
issuer, one of the configured audiences, `sub`, and `exp`, and honors `nbf`
within a clock tolerance of at most 300 seconds. Its outcomes follow the hook
contract above:

- a principal mapped from verified claims, by default `sub` as the `id` and
  `scope`, `iss`, and `client_id` as `attributes.scopes`, `attributes.issuer`,
  and `attributes.clientId`;
- `null` for every missing, malformed, oversized, expired, not-yet-valid,
  wrongly issued, wrongly addressed, disallowed-algorithm, unknown-key, or
  bad-signature credential, and for a token missing a required scope. A token
  without `kid` that fits several published keys is tried against at most
  eight of them and resolves `null` when none verifies it; and
- a `JwtVerificationUnavailableError` rejection with a fixed message and no
  cause when the key set times out, is unreachable, answers anything but 200,
  or is malformed, or the request is cancelled. After a failed fetch nothing is
  fetched for 5 seconds; a fresh cached key set keeps answering meanwhile, and
  a `kid` missing from it, even a newly rotated one, resolves `null` until a
  refetch succeeds.

A token without a required scope therefore receives 401, not an RFC 6750
`insufficient_scope` 403, because the hook can return only a principal or
`null`. Configure `challengeScopes` with the same scopes so the challenge names
what the client must request. Scopes needed only by some capabilities belong in
their `access` rules.

The helper is not an identity provider, introspection client, OpenID Connect
discovery client, or DPoP or mTLS verifier. Configure the JWKS URL explicitly,
preferably from the issuer's `jwks_uri`, and write a host hook for opaque
tokens, several issuers, or sender-constrained tokens.

## Protected Resource Metadata and challenges

When `resourceMetadata` is configured, the adapter validates it at startup,
publishes its public well-known document, and adds its configured discovery URL
to the Bearer challenge returned by a 401. The URL is derived from the configured
`resource`, never from `Host`, `X-Forwarded-Host`, or another request header.
For a resource ending in `/mcp`, the discovery path is
`/.well-known/oauth-protected-resource/mcp`; a resource mounted under a prefix
such as `/e/orders/mcp` publishes it at
`/.well-known/oauth-protected-resource/e/orders/mcp` (ADR 0039).

Set `challengeScopes` when the Resource Server knows the scopes required for
its base MCP request. The adapter validates and snapshots each RFC 6749 scope
token before listening and serializes the ordered set in the 401 Bearer
challenge. Challenge scopes require `resourceMetadata`. They are intentionally
separate from `scopesSupported`: the challenge is authoritative for the current
request, while metadata describes the minimal generally supported set. Omit
`challengeScopes` when the authentication policy cannot name a stable base set.

The resource must identify the engine's exact mount path over HTTPS, `/mcp` by
default, with loopback HTTP allowed only for local development. It cannot contain credentials, a query, or
a fragment. Authorization Server identifiers must use HTTPS, except for the
same loopback HTTP origin as a loopback development resource. They cannot
contain credentials, a query, or a fragment; issuer paths are allowed. A
different loopback port is a different origin and is rejected.

The metadata describes this Resource Server and identifies one or more external
Authorization Servers. It does not turn the framework into an Authorization
Server. Do not expose a login, token, consent, refresh, or user-management route
from the adapter.

## Host, Origin, and proxy configuration

The default bind address is `127.0.0.1`. A non-loopback bind requires a nonempty
`allowedHosts` configuration. Host matching is exact after hostname
normalization; it does not use a suffix or wildcard match and ignores forwarded
host headers.

An absent `Origin` is allowed for non-browser MCP clients. If a request supplies
an `Origin`, the value must be a valid HTTP(S) origin and exactly match an entry
in `allowedOrigins`, including scheme and non-default port. With no configured
origin allowlist, every supplied Origin is rejected.

For example, a deployment whose trusted network and browser boundary require
explicit values can configure:

```ts
await serveMcpHttp(engine, {
  host: "0.0.0.0",
  port: 3000,
  allowedHosts: ["engine.example.com"],
  allowedOrigins: ["https://console.example.com"],
  auth: {
    mode: "required",
    authenticate,
  },
});
```

`authenticate` is a host-defined function in this example. Configure the public
resource URL, trusted hosts, and trusted origins explicitly when a reverse proxy
is present; do not derive trust decisions from forwarded headers. TLS
termination and proxy trust are deployment responsibilities, not features of
this HTTP adapter.

Host and Origin failures return HTTP 403 before the authentication hook runs.
This is a request-boundary defense, not a capability authorization result.
More than one raw `Authorization` header is an invalid request and is rejected
before the authentication hook runs; authenticators never need to choose among
ambiguous credentials.

`createMcpHttpHandler` applies the same boundary to a Fetch `Request` in a
host-owned server or a Fetch runtime (ADR 0042). Without `allowedHosts` it
accepts only the loopback host names, and it requires the `Host` header, when
present, and the request URL's authority to be allowed. The Fetch API joins
repeated header fields with `, ` before the handler sees them, so a repeated
`Authorization` header reaches the hook as one value such as
`Bearer a, Bearer b`. Accept exactly one credential of the expected form, as
the `readBearerToken` pattern above and the
[`@invokta/auth-jwt`](#jwt-bearer-helper) authenticator do, and treat anything
else as missing.

The request target must be the exact canonical mount path, `/mcp` by default.
Dot-segment or percent-encoded aliases, queries, fragments, and absolute-form
targets are not routed to MCP or authentication. IPv6 `Host` values must use bracketed authority
syntax, such as `[::1]:3000`; bare `::1` is rejected.

After Host, Origin, and route validation, unsupported methods and declared body
overflow are rejected before the authentication hook. Early responses close or
drain the request rather than retaining a keep-alive connection for a slow,
unconsumed body. A disconnect that happens before body listeners are installed
also settles body handling and closes request-scoped protocol resources.

## Authentication is not authorization

The hook proves who made the request and produces a `Principal`. The core still
validates capability input and applies the capability's `access` rule before
`run`. An authenticated principal can therefore receive `FORBIDDEN`.

For MCP tools, `FORBIDDEN` is returned as `isError: true` inside a successful HTTP
200 MCP response. It is intentionally different from:

- HTTP 401 for missing or invalid authentication;
- HTTP 403 for rejected Host or Origin;
- HTTP 500 for an authentication infrastructure failure.

See [Integrating a PDP through an access rule](./capability-authorization.md) for
domain authorization.

## Provider recipes

This guide stays provider-neutral. The repository ships runnable, offline-tested
examples that implement this hook contract for common TypeScript identity
providers — generic OIDC/JWT bearer, Supabase, Clerk, Auth0, AWS Cognito,
Firebase Auth, Better Auth, Auth.js, WorkOS AuthKit, and machine-to-machine API
keys — under [`examples/auth-*`](../examples/). Each pairs with a documentation
recipe at <https://docs.invokta.dev/recipes/auth/>. The generic JWT bearer and
Auth0 examples configure `@invokta/auth-jwt`; the other JWT examples still show
a complete `jose` verifier.

## Dangerous development mode

Authentication can be disabled only with the explicit option:

```ts
auth: {
  mode: "dangerously-disabled-for-development",
}
```

Use it only for an isolated loopback development process. The adapter supplies
`principal = null`, so `authenticated` and principal-dependent access rules
remain closed. This option must not be used to expose an endpoint on a shared
network or in production.

## Secret and logging rules

- Never put a raw access token, API key, Authorization header, client secret, or
  provider credential in `Principal.id` or `Principal.attributes`.
- Never include credentials in `EngineError.publicDetails`, event payloads,
  capability input, URLs, or command-line arguments.
- Do not log the authentication request headers or verifier request. Log only
  safe identifiers and operational categories needed by the host.
- Keep secrets in the deployment's secret mechanism and inject only the verifier
  or configuration needed at the composition root.
- Validate the minimum token properties required by the application's security
  policy inside the verifier. The framework does not define issuer, audience,
  signature, expiry, replay, or scope policy; `@invokta/auth-jwt` enforces only
  the issuer, audience, algorithm, signature, lifetime, and scope policy the
  host configures, and no replay policy.
- Bound provider calls with the verifier's own timeout and observe
  `request.signal`. The framework does not provide authentication retries.

Every `/mcp` POST is independent: the adapter creates a fresh MCP server and
transport and authenticates the request again. It stores no identity session,
cookie, or token and emits no MCP session ID. A disconnect can cancel the active
request, but a later request cannot cancel earlier work through MCP because the
stateless profile provides no cross-request cancellation state.

The adapter bounds request bodies to 1 MiB by default and returns HTTP 413 when
the declared or streamed body exceeds the limit. Set `maxRequestBodyBytes` to a
positive safe-integer byte limit when the host needs a different bound.
