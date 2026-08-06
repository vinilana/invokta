# Auth0 authentication example

This example plugs Auth0 into the MCP HTTP boundary. It verifies an Auth0 access
token issued for a registered API, maps the verified claims to Invokta's minimal
`Principal`, and exposes one capability, `identity.whoami`, that echoes exactly
what the framework trusts about the caller.

The same code is the template for any generic OIDC issuer that publishes a JWKS
and mints an audience-scoped access token: Kinde and Logto are issuer and
audience swaps of this file set.

## What it shows

- `jose` JWKS verification of an Auth0 access token in the `auth.authenticate`
  hook: issuer, audience, RS256, and expiry are all enforced.
- The failure semantics the framework requires: `null` for every invalid or
  missing credential (HTTP 401), a rejection only when the check itself cannot
  run (sanitized HTTP 500).
- Claims to `Principal`: `sub` becomes the id, `scope` becomes
  `attributes.scopes`, and the RBAC `permissions` claim becomes
  `attributes.permissions`. Nothing else crosses the boundary.
- Protected Resource Metadata that names the tenant as the Authorization
  Server, so an OAuth-capable MCP client can discover where to get a token.

## Architecture

```text
MCP HTTP request
      |
      v
auth.authenticate hook          src/mcp-http.ts
      |
      +--> Auth0 access token verifier    src/identity/verifier.ts
      |        (jose JWKS, issuer + audience + RS256)
      |
      +--> claims -> Principal            src/identity/principal.ts
      |
      v
 engine.invoke  ->  identity.whoami       src/capabilities/whoami.ts
```

- `src/identity/verifier.ts` owns credential verification. Key resolution is
  injectable: production uses the tenant's remote JWKS, tests inject a local
  JWKS so signature verification is real and offline.
- `src/identity/principal.ts` owns the claims mapping. It never copies the raw
  token or the full claim set.
- `src/capabilities/whoami.ts` declares `access: "authenticated"` and derives
  its result only from `context.principal`. It has no idea Auth0 exists.
- `src/mcp-http.ts` is the composition root: bearer parsing, the hook, and the
  Protected Resource Metadata document.

Authorization stays separate. `identity.whoami` only requires an authenticated
caller; a real capability decides, in its `access` rule, what
`attributes.scopes` or `attributes.permissions` allow.

## Run it against a real Auth0 tenant

Register an API in the Auth0 dashboard and copy its identifier. Then, from the
repository root:

```sh
yarn build
AUTH0_DOMAIN=your-tenant.eu.auth0.com \
AUTH0_AUDIENCE=https://orders.example.com/api \
AUTH0_MCP_RESOURCE=http://127.0.0.1:3000/mcp \
AUTH0_MCP_SCOPES="orders:read orders:write" \
  node examples/auth-auth0-engine/dist/mcp-http.js
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `AUTH0_DOMAIN` | yes | Tenant or custom domain; the issuer becomes `https://<domain>/` |
| `AUTH0_AUDIENCE` | yes | The API identifier the token must carry in `aud` |
| `PORT` | no | Bind port, default `3000` |
| `AUTH0_MCP_RESOURCE` | no | Public `/mcp` URL published as Protected Resource Metadata |
| `AUTH0_MCP_SCOPES` | no | Scopes advertised in that metadata document |

Get a machine-to-machine token for the same audience and call the tool:

```sh
curl -s --request POST \
  --url "https://${AUTH0_DOMAIN}/oauth/token" \
  --header 'content-type: application/json' \
  --data "{\"client_id\":\"$AUTH0_CLIENT_ID\",\"client_secret\":\"$AUTH0_CLIENT_SECRET\",\"audience\":\"$AUTH0_AUDIENCE\",\"grant_type\":\"client_credentials\"}"
```

```sh
curl -i --request POST http://127.0.0.1:3000/mcp \
  --header "authorization: Bearer $ACCESS_TOKEN" \
  --header 'accept: application/json, text/event-stream' \
  --header 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"identity.whoami","arguments":{}}}'
```

Keep the client secret in your shell's secret mechanism. Never paste a token
into a log, an issue, or capability input.

Dropping the `authorization` header returns HTTP 401 with a
`WWW-Authenticate: Bearer resource_metadata="..."` challenge pointing at
`/.well-known/oauth-protected-resource/mcp`.

## Verify it

```sh
yarn workspace @invokta/example-auth-auth0 test
yarn workspace @invokta/example-auth-auth0 typecheck
yarn workspace @invokta/example-auth-auth0 build
```

The tests mint RS256 tokens from a locally generated key pair and cover a valid
token, an expired token, a foreign issuer, an issuer missing the trailing slash,
a wrong audience, a missing audience, an unknown signing key, a forged
signature, a malformed token, a missing header, a JWKS outage, and the absence
of any token material in the produced `Principal`. No test performs network I/O
and no Auth0 account is needed.
