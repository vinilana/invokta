# Auth.js Engine

This example shows how an application that already runs
[Auth.js](https://authjs.dev/) (NextAuth v5) gives an Action Engine a trusted
identity. It defines one capability, `identity.whoami`, and reaches it through
the two surfaces an Auth.js application actually has.

## What it shows

**Embedded (primary).** The host route handler calls `auth()`, maps
`session.user` to a `Principal` with an enumerated set of safe fields, and
calls `engine.invoke` directly. No credential crosses a process boundary
because there is no boundary to cross. See
[`src/embedded.ts`](./src/embedded.ts) and
[`src/identity/principal.ts`](./src/identity/principal.ts).

**MCP HTTP (secondary).** For callers that cannot invoke the engine in process,
the application mints its own short-lived access token — a signed JWS with an
application-owned issuer, audience, and key set — and the engine's
`authenticate` hook verifies that token. See
[`src/identity/issuer.ts`](./src/identity/issuer.ts),
[`src/identity/verifier.ts`](./src/identity/verifier.ts), and
[`src/mcp-http.ts`](./src/mcp-http.ts).

The Auth.js session cookie is deliberately **not** the HTTP credential. Auth.js
encrypts its JWT session by default (JWE, `A256CBC-HS512`, keyed from
`AUTH_SECRET`), so it is readable only by the application that holds that
secret. It is a session cookie, not a bearer token for a separate resource
server. Issuing a narrow, short-lived token instead keeps the engine a plain
Resource Server and keeps `AUTH_SECRET` in one place.

The `whoami` capability derives its result only from `context.principal`.
Capability input never names, extends, or overrides an identity.

## Identity mapping

Both surfaces produce the same `Principal.id`: the Auth.js user id. Only
`email` and `name` are copied into `attributes`, plus a `channel` marker and,
for the token surface, the granted `scopes`. `image` is not authorization
relevant and is not copied. Neither the session cookie nor the access token
appears anywhere in the principal.

## Build and test

From the repository root:

```bash
yarn workspace @invokta/example-auth-authjs build
yarn workspace @invokta/example-auth-authjs test
```

The tests generate an ES256 key pair in process and resolve it with
`createLocalJWKSet`, so signature verification is real while no test performs
network I/O or needs an Auth.js project.

## Run the embedded surface

```bash
node examples/auth-authjs-engine/dist/direct.js
```

This runs [`src/direct.ts`](./src/direct.ts), which substitutes a stub session
for the one `auth()` returns and executes the same route-handler code:

```json
{"principalId":"user_2f1a","attributes":{"channel":"authjs-session","email":"ada@example.com","name":"Ada Lovelace"}}
```

In a real Next.js App Router project, the handler is one line:

```ts
// app/api/engine/whoami/route.ts
import { auth } from "@/auth";

import { createWhoamiRouteHandler } from "./embedded.js";

export const POST = createWhoamiRouteHandler({ resolveSession: auth });
```

With Auth.js v5's default JWT session strategy, `session.user.id` stays unset
until your Auth.js config adds the documented session-extension callback
(`session.user.id = token.sub`); without it, `sessionToPrincipal` fails closed
and every signed-in user receives 401. See the
[recipe's aside](https://docs.invokta.dev/recipes/auth/authjs/) for the exact
callback, and note that database-session deployments need no callback.

## Run the MCP HTTP surface

The engine trusts one issuer, one audience, and one JWKS document, all owned by
your application:

```bash
AUTHJS_ENGINE_TOKEN_ISSUER='https://app.example.com' \
AUTHJS_ENGINE_TOKEN_AUDIENCE='https://engine.example.com/mcp' \
AUTHJS_ENGINE_JWKS_URL='https://app.example.com/.well-known/jwks.json' \
PORT=3000 \
  node examples/auth-authjs-engine/dist/mcp-http.js
```

The endpoint is `http://127.0.0.1:3000/mcp`. A caller presents the token your
application issued for it:

```bash
curl --fail-with-body http://127.0.0.1:3000/mcp \
  --header 'Accept: application/json, text/event-stream' \
  --header "Authorization: Bearer $ENGINE_ACCESS_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":"whoami-1","method":"tools/call","params":{"name":"identity_whoami","arguments":{}}}'
```

A missing, malformed, expired, foreign-issuer, foreign-audience, or
badly-signed token returns HTTP 401 before `engine.invoke` runs. Only a
verifier infrastructure failure — an unreachable JWKS endpoint, an elapsed
deadline — returns a sanitized HTTP 500.

### Environment variables

| Name | Required | Meaning |
| --- | --- | --- |
| `AUTHJS_ENGINE_TOKEN_ISSUER` | yes | `iss` your application signs into engine access tokens |
| `AUTHJS_ENGINE_TOKEN_AUDIENCE` | yes | `aud` identifying this engine |
| `AUTHJS_ENGINE_JWKS_URL` | yes | your application's own JWKS document |
| `PORT` | no | bind port, default `3000` |

`AUTH_SECRET` is never read by the engine. It stays in the Auth.js application,
which is the only party that can decrypt a session cookie.

## Related documentation

- [Integrating an identity provider at the HTTP boundary](../../docs/http-authentication.md)
- [Integrating a PDP through a capability access rule](../../docs/capability-authorization.md)
