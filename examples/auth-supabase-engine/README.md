# Supabase authentication example

This example wires **Supabase Auth** into the stateless MCP HTTP boundary. A
request carries a Supabase access token as a bearer credential, the
`auth.authenticate` hook verifies it against the project's published JWKS with
[`jose`](https://github.com/panva/jose), and the verified claims become the
minimal `Principal` the engine authorizes.

One capability, `identity.whoami`, is declared `access: "authenticated"` and
answers only from `context.principal`. That makes the identity boundary
observable with an MCP client while keeping the domain trivial on purpose.

Invokta ships no identity system: everything Supabase-specific in this example
is application code at the composition root. Capabilities see a `Principal` and
nothing else.

## What it shows

```text
Authorization: Bearer <supabase access token>
              |
              v
   auth.authenticate (src/mcp-http.ts)
              |
              v
   verifier (src/identity/verifier.ts)   <- jose jwtVerify against the project JWKS
              |
              v
   claims -> Principal (src/identity/principal.ts)
              |
              v
   engine.invoke -> access: "authenticated" -> identity.whoami
```

- `src/identity/verifier.ts` verifies the token: issuer
  `https://<project-ref>.supabase.co/auth/v1`, audience `authenticated`,
  signature from `<issuer>/.well-known/jwks.json`, algorithms `ES256`/`RS256`.
  Key resolution is injectable, so tests verify real signatures offline.
- `src/identity/principal.ts` maps `sub` to `Principal.id` and `role`, `email`,
  and `session_id` to `Principal.attributes`. Nothing else from the token is
  copied, and the raw token never leaves the verifier.
- `src/mcp-http.ts` reads the single bearer credential, calls the verifier with
  the request's `AbortSignal`, and serves the engine with `auth.mode:
  "required"`.

Failure semantics follow
[`docs/http-authentication.md`](../../docs/http-authentication.md): an invalid
or missing credential returns `null` (HTTP 401), and only a verification
infrastructure failure throws (sanitized HTTP 500).

## Run it against a real Supabase project

The project must use **asymmetric JWT signing keys** (Dashboard →
Authentication → JWT Keys). A legacy project that still signs with the shared
HS256 JWT secret publishes no usable JWKS, and this verifier refuses HS256 on
purpose.

From the repository root:

```sh
yarn build

SUPABASE_URL=https://<project-ref>.supabase.co \
  node examples/auth-supabase-engine/dist/mcp-http.js
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `SUPABASE_URL` | yes | Project URL, `https://<project-ref>.supabase.co`. The issuer and JWKS URL are derived from it. |
| `SUPABASE_JWT_AUDIENCE` | no | Defaults to `authenticated`, which every user session carries — including anonymous sign-ins, whose tokens differ only by `is_anonymous: true` (mapped into `Principal.attributes.isAnonymous` for access rules). |
| `PORT` | no | Defaults to `3000`. |

Obtain an access token from any Supabase client session
(`supabase.auth.getSession()` returns `session.access_token`), then call the
endpoint:

```sh
curl -sS http://127.0.0.1:3000/mcp \
  -H "authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H 'accept: application/json, text/event-stream' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"identity_whoami","arguments":{}}}'
```

The same request without the header returns HTTP 401 before `engine.invoke`
runs.

## Verify it

```sh
yarn workspace @invokta/example-auth-supabase test
yarn workspace @invokta/example-auth-supabase typecheck
yarn workspace @invokta/example-auth-supabase build
```

The tests are offline and use no Supabase account: a locally generated ES256
key pair mints Supabase-shaped tokens and `createLocalJWKSet` stands in for the
project JWKS, so signature verification is real without any network call. They
cover a valid token, every invalid class (missing, malformed, expired, wrong
issuer, wrong audience, unknown key, forged signature, legacy HS256, no
subject), an infrastructure failure, and the absence of any token material in
the resulting principal.

Read the [Supabase recipe](../../apps/docs/src/content/docs/recipes/auth/supabase.mdx)
for the step-by-step walkthrough and the `@supabase/supabase-js` variant.

## Inspect and gate this engine

```sh
yarn workspace @invokta/example-auth-supabase devtools
yarn workspace @invokta/example-auth-supabase devtools:doctor
yarn workspace @invokta/example-auth-supabase check:mcp
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
