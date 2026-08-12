# auth-jwt-bearer-engine

Provider-neutral OIDC/JWT bearer authentication at the MCP HTTP boundary.

This is the base authentication example. It verifies an OAuth 2.0 JWT access
token with [`jose`](https://github.com/panva/jose), maps the verified claims to
Invokta's minimal `Principal`, and exposes a single `identity.whoami`
capability that echoes that principal back. Any OIDC provider that publishes a
JWKS works with it: point `AUTH_JWT_ISSUER` and `AUTH_JWT_AUDIENCE` at your
project and nothing else changes.

## What it shows

- The `serveMcpHttp` `auth.authenticate` hook: `Principal` for a valid
  credential, `null` for an invalid one (HTTP 401), a thrown error only when the
  check could not complete (sanitized HTTP 500).
- A verifier whose key resolution is injectable, so production uses
  `createRemoteJWKSet` and the tests use `createLocalJWKSet` with a locally
  generated key pair. Signature verification is real; no test touches the
  network.
- Claims mapped to `Principal` by an explicit allowlist: `sub` becomes the
  principal id, the space-delimited `scope` claim becomes `attributes.scopes`,
  and `iss` plus `client_id` are the only other claims carried. The raw token
  never reaches the engine.
- Authentication separated from authorization: `identity.whoami` declares
  `access: "authenticated"` and derives its result from `context.principal`
  only, never from input.
- Optional RFC 9728 Protected Resource Metadata, so an OAuth-capable MCP client
  can discover the Authorization Server from a 401.

## Layout

```text
src/
  engine.ts                # engine with the identity.whoami capability
  capabilities/whoami.ts   # access: "authenticated"; echoes safe principal data
  identity/
    verifier.ts            # jose jwtVerify, issuer/audience/algorithm policy
    principal.ts           # verified claims -> Principal
  mcp-http.ts              # serveMcpHttp entrypoint, mode "required"
test/
  identity.test.ts         # verifier matrix, claim mapping, authenticate hook
  mcp-http.test.ts         # well-known metadata, 401 challenge, authorized call
```

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `AUTH_JWT_ISSUER` | yes | Exact `iss` value to accept, for example `https://tenant.example.auth0.com/` |
| `AUTH_JWT_AUDIENCE` | yes | Resource identifier expected in `aud`; normally this engine's public `/mcp` URL |
| `AUTH_JWT_JWKS_URI` | no | Explicit key-set URL. Defaults to `<issuer>/.well-known/jwks.json` |
| `AUTH_JWT_ALGORITHMS` | no | Comma-separated signature allowlist. Defaults to `RS256,ES256` |
| `AUTH_JWT_RESOURCE` | no | Public `/mcp` URL. Setting it publishes Protected Resource Metadata |
| `AUTH_JWT_AUTHORIZATION_SERVERS` | no | Comma-separated AS issuers for that document. Defaults to `AUTH_JWT_ISSUER` |
| `AUTH_JWT_SCOPES_SUPPORTED` | no | Comma-separated scopes advertised in that document |
| `AUTH_JWT_HOST` | no | Bind host. Defaults to `127.0.0.1` |
| `PORT` | no | Bind port. Defaults to `3000` |
| `AUTH_JWT_ALLOWED_HOSTS` | no | Host allowlist. Required for a non-loopback bind |
| `AUTH_JWT_ALLOWED_ORIGINS` | no | Browser Origin allowlist |

`<issuer>/.well-known/jwks.json` is a widespread convention, not a
specification requirement. The authoritative location is the `jwks_uri` member
of `<issuer>/.well-known/openid-configuration`; read it once and set
`AUTH_JWT_JWKS_URI` when your provider hosts its key set elsewhere.

## Run it against a real provider project

From the repository root:

```sh
yarn build
AUTH_JWT_ISSUER="https://your-tenant.example.com/" \
AUTH_JWT_AUDIENCE="http://127.0.0.1:3000/mcp" \
PORT=3000 \
node examples/auth-jwt-bearer-engine/dist/mcp-http.js
```

Then call it with an access token your provider issued for that audience:

```sh
curl -s http://127.0.0.1:3000/mcp \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'accept: application/json, text/event-stream' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"identity_whoami","arguments":{}}}'
```

An unauthenticated call returns HTTP 401. To make that 401 carry a discovery
pointer, add `AUTH_JWT_RESOURCE="http://127.0.0.1:3000/mcp"` and read
`http://127.0.0.1:3000/.well-known/oauth-protected-resource/mcp`.

## Verify it

```sh
yarn workspace @invokta/example-auth-jwt-bearer test
```

The suite mints tokens from a key pair generated in the test process and covers
the valid credential plus every invalid class (missing header, wrong scheme,
malformed, expired, wrong issuer, wrong audience, unknown key, bad signature,
algorithm outside the allowlist, missing subject), the infrastructure-failure
path, cancellation, and the assertion that no token material reaches the
principal.

## Related documentation

- [HTTP authentication](../../docs/http-authentication.md) for the hook
  contract and the secret and logging rules.
- [Capability authorization](../../docs/capability-authorization.md) for the
  policy half, once a principal exists.
