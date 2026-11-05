# @invokta/auth-jwt

Bounded JWT bearer authentication for Invokta HTTP adapters. It verifies an
OAuth 2.0 JWT access token with [`jose`](https://github.com/panva/jose), maps
the verified claims to a minimal principal, and returns a function that is the
`serveMcpHttp` `authenticate` hook as-is.

The package is not an identity provider, token issuer, introspection client, or
OAuth Authorization Server. It adds no capability execution path: the principal
it returns still reaches capabilities only through `engine.invoke`, where each
capability's `access` rule decides authorization.

## Usage

```ts
import { createJwtBearerAuthenticator } from "@invokta/auth-jwt";
import { serveMcpHttp } from "@invokta/mcp";

import { engine } from "./engine.js";

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
    },
    challengeScopes: requiredScopes,
  },
});
```

The authenticator reads a structural request view,
`{ headers: { get(name) }, signal? }`, so it also accepts a Web `Request` or any
adapter exposing the same header lookup.

## Outcomes

| Request | Result | MCP HTTP outcome |
| --- | --- | --- |
| Verified token with every required scope | Principal | Request continues to `engine.invoke` |
| Missing, malformed, oversized, expired, not-yet-valid, wrong issuer, wrong audience, disallowed algorithm, unknown key, bad signature, missing `sub` or `exp`, or missing required scope | `null` | 401 with the configured Bearer challenge |
| Key set unreachable, non-200, or malformed; request cancelled | Rejects with `JwtVerificationUnavailableError` | Sanitized 500 |

A `null` result never says why the credential was rejected. The rejection has a
fixed message and no cause, so no token, key-set URL, or provider response can
reach a response or a log through it.

A token without a `kid` header that fits several published keys, as during an
issuer's key rotation, is tried against at most eight of them in key-set order.
It verifies if one of them signed it and is otherwise an invalid credential, so
a forged token cannot turn into a 500.

## Options

| Option | Required | Contract |
| --- | --- | --- |
| `issuer` | Yes | Exact `iss` value |
| `audience` | Yes | A string or non-empty list; the token's `aud` must contain one |
| `algorithms` | Yes | Non-empty allowlist of `RS256`, `RS384`, `RS512`, `PS256`, `PS384`, `PS512`, `ES256`, `ES384`, `ES512`, `EdDSA`, `Ed25519` |
| `jwksUrl` | One key source | HTTPS URL, or loopback HTTP for development; no credentials or fragment |
| `jwks` | One key source | Local JSON Web Key Set of public keys, for tests, offline use, or pinned keys |
| `clockToleranceSeconds` | No | Integer from 0 to 300; default 0 |
| `requiredScopes` | No | RFC 6749 scope tokens the `scope` claim must all grant |
| `maxTokenLength` | No | Integer from 1 to 16,384 characters; default 8,192 |
| `principal` | No | Synchronous claims-to-principal mapper; default `defaultJwtPrincipal` |

`none` and shared-secret `HS*` algorithms are rejected at construction. A remote
key set is fetched on first use, with a 5-second timeout, and cached for 10
minutes. After a successful fetch, an unknown key identifier triggers a refetch
at most once every 30 seconds. After a failed fetch, nothing is fetched for 5
seconds: a fresh cached key set keeps answering, and without one requests are
rejected at once. Redirects are not followed. Configuration is validated and snapshotted when the
authenticator is created, and configuration errors never echo a configured
value.

The credential must be `Authorization: Bearer <compact JWS>`: the scheme is
case-insensitive, exactly one space follows it, and the token consists of three
non-empty base64url segments. Every other shape is treated as no credential.

## Principal mapping

`defaultJwtPrincipal` maps `sub` to the principal `id` and copies only the
space-delimited `scope` claim, `iss`, and `client_id` into `attributes`:

```ts
{
  id: "user-42",
  attributes: {
    scopes: ["engine:invoke", "reports:read"],
    issuer: "https://identity.example.com",
    clientId: "reporting-cli",
  },
}
```

A custom `principal` mapper receives only the verified claims, never the raw
token. It returns a principal or `null` to reject the credential; a malformed
result is treated as `null`, and an error it throws propagates unchanged.
Include only verified, authorization-relevant claims.

## Scope failures

The `authenticate` hook can return only a principal or `null`, so a token
missing a required scope is unauthenticated and receives HTTP 401, not an RFC
6750 `insufficient_scope` 403. Configure the MCP adapter's `challengeScopes`
with the same list so the challenge names the scopes a client must request.
Scopes that only some capabilities need belong in those capabilities' `access`
rules, which answer `FORBIDDEN` inside the MCP response.

## Limits

The package does not discover `jwks_uri` from OpenID Connect metadata,
introspect opaque tokens, decrypt JWE tokens, enforce the RFC 9068 `typ`
header, accept several issuers, bind tokens with DPoP or mTLS, check
revocation, or retry a failed key-set fetch. Compose a host-owned hook for
those requirements.

The remote key-set response body is read whole by `jose`, bounded only by the
5-second fetch timeout, not by a size limit. Configure `jwksUrl` only for an
issuer endpoint you trust.

Read the [`@invokta/auth-jwt` reference](https://docs.invokta.dev/reference/auth-jwt/)
and the
[HTTP authentication guide](https://docs.invokta.dev/guides/http-authentication/).
