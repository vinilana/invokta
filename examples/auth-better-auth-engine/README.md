# auth-better-auth-engine

Protect an Invokta engine with [Better Auth](https://www.better-auth.com/), the
TypeScript-native authentication library that runs inside your own application.

Because the application that runs Better Auth is also the token issuer, both
integration surfaces are shown here:

| Surface | File | Use it when |
| --- | --- | --- |
| Embedded | `src/embedded.ts` | The engine runs in the same process as the app. The route handler already resolved a session, so it maps that session to a `Principal` and calls `engine.invoke` directly. |
| MCP HTTP | `src/mcp-http.ts` | The engine is a separate service. Better Auth's JWT plugin issues a JWT, publishes JWKS at `/api/auth/jwks`, and the `auth.authenticate` hook verifies it with `jose`. |

The single capability, `identity.whoami`, derives its whole result from the
trusted principal, so any channel can be verified end to end without a domain.

## Layout

```text
src/
  engine.ts                 # engine with the identity.whoami capability
  capabilities/whoami.ts    # access: "authenticated"; echoes safe principal data
  identity/
    verifier.ts             # Better Auth JWT verification (injectable key resolution)
    principal.ts            # verified claims -> Principal mapping
  embedded.ts               # host-resolved session -> Principal -> engine.invoke
  mcp-http.ts               # serveMcpHttp with auth mode "required"
```

## What it shows

- The `authenticate` hook returns a `Principal` for a verified token, `null` for
  every unusable credential (missing, malformed, expired, wrong issuer, wrong
  audience, unknown signing key, no subject), and throws only when the JWKS
  endpoint cannot answer — so an outage becomes HTTP 500, never a silent 401.
- Key resolution is injected. Production wiring uses
  `createBetterAuthRemoteKeySet` (`createRemoteJWKSet` with a bounded timeout);
  the tests pass `createLocalJWKSet`, so signature verification is real with
  zero network I/O.
- The principal carries only an enumerated claim allowlist — `email`,
  `emailVerified`, `name`, `role`, `activeOrganizationId`. Better Auth puts the
  whole user object in the JWT payload by default, and this example never
  forwards it wholesale.
- No token, session token, or `Authorization` header value reaches the
  principal, an error message, or a log line.

## Run it against a real Better Auth project

Add the JWT plugin to your Better Auth server:

```ts
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  plugins: [jwt()],
});
```

The plugin serves JWKS at `<baseURL>/api/auth/jwks` and mints a JWT at
`<baseURL>/api/auth/token`. With the defaults, `iss` and `aud` are both the app
base URL, `sub` is the user id, and the token expires after 15 minutes.

Build the repository, then start the MCP HTTP adapter:

```sh
yarn build
BETTER_AUTH_URL="https://app.example.com" PORT=3000 \
  yarn workspace @invokta/example-auth-better-auth mcp:http
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `BETTER_AUTH_URL` | yes | Your app's base URL. It supplies the JWKS URL, the expected `iss`, and the expected `aud`. |
| `BETTER_AUTH_JWT_ISSUER` | no | Override when the app sets `jwt.issuer`. |
| `BETTER_AUTH_JWT_AUDIENCE` | no | Override when the app sets `jwt.audience`. |
| `PORT` | no | Bind port; defaults to `3000`. |

Fetch a token with `authClient.token()` in the browser or client app, then call
the engine:

```sh
curl -sS http://127.0.0.1:3000/mcp \
  -H "authorization: Bearer $BETTER_AUTH_JWT" \
  -H "accept: application/json, text/event-stream" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"identity_whoami","arguments":{}}}'
```

The embedded surface needs no token and no server:

```sh
yarn workspace @invokta/example-auth-better-auth embedded
```

## Verify it

```sh
yarn workspace @invokta/example-auth-better-auth test
```

The tests generate an Ed25519 key pair locally, mint tokens in Better Auth's
claim shape, and cover the valid case, every invalid-credential class, the
infrastructure failure, and the absence of token material in the principal. No
test performs network I/O or needs a Better Auth account.

## Inspect and gate this engine

```sh
yarn workspace @invokta/example-auth-better-auth devtools
yarn workspace @invokta/example-auth-better-auth devtools:doctor
yarn workspace @invokta/example-auth-better-auth check:mcp
```

`devtools` rebuilds on change and serves the engine on the printed
`http://localhost:<port>/` URL. Its Playground emulates one call through the
direct, CLI, MCP stdio, or MCP HTTP path under the development `Principal` you
select, and records what that adapter exchanged. `devtools:doctor` runs the
read-only engine checks and reports whether an `invokta.mcp.json` manifest sits
next to the project. `check:mcp` is the build-time conformance gate from
[ADR 0026](../../docs/adr/0026-generated-engine-mcp-conformance-gate.md): it
fails when two capability IDs derive the same portable MCP tool name, before an
adapter starts or the engine is installed.
