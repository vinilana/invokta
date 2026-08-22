# auth-clerk-engine

Authenticate an Invokta engine's MCP HTTP boundary with
[Clerk](https://clerk.com) session tokens.

The example verifies a Clerk session-token JWT with `jose` against the
instance JWKS, enforces the `azp` (authorized party) claim against an
allowlist, and maps the verified claims to the framework's minimal
`Principal`. The engine exposes one capability, `identity.whoami`, whose result
is derived only from that principal, so a live check tells you exactly which
identity the boundary proved.

## What it shows

- `src/identity/verifier.ts` — Clerk session-token verification: RS256
  signature against the instance JWKS, `iss` equal to the Frontend API URL,
  a required `exp` within a clock tolerance, a v2 session status other than
  `active` rejected, and `azp` inside the configured authorized-party
  allowlist (required by this composition root, so azp-less JWT-template and
  machine tokens are rejected too). The organization comes from the v2
  compact `o` object with a v1 `org_id`/`org_role` fallback, the role
  normalized to the v2 unprefixed form. Key resolution is injected, so
  production uses the remote JWKS and tests use a local one.
- `src/identity/principal.ts` — claims to `Principal`: `sub` becomes the
  principal ID, and the session and organization claims become attributes
  when the session has them. The token, the raw claim set, and SDK objects
  never leave the composition root.
- `src/mcp-http.ts` — the `serveMcpHttp` `auth.authenticate` hook in
  `mode: "required"`: a `Principal` for a valid credential, `null` for every
  invalid one (HTTP 401), and a rejection only when verification could not
  complete (sanitized HTTP 500).
- `src/capabilities/whoami.ts` — an `access: "authenticated"` capability that
  reads identity from `context.principal` and ignores the tool input.

## Configuration

| Variable | Meaning |
| --- | --- |
| `CLERK_FRONTEND_API_URL` | The instance Frontend API URL, which is also the session token's `iss` claim: `https://<slug>.clerk.accounts.dev` in development, `https://clerk.<your-domain>.com` for a production custom domain. |
| `CLERK_AUTHORIZED_PARTIES` | Comma-separated origins allowed to hold a token for this engine, compared against `azp`. Required: the engine refuses to start without it. |
| `PORT` | Listen port. Defaults to `3000`. |

The JWKS URL is derived from the Frontend API URL as
`<CLERK_FRONTEND_API_URL>/.well-known/jwks.json`. No Clerk Secret Key is
needed, because JWKS verification uses only public keys.

## Run it against a real Clerk project

```sh
yarn build
CLERK_FRONTEND_API_URL="https://clean-mayfly-62.clerk.accounts.dev" \
CLERK_AUTHORIZED_PARTIES="http://localhost:3000,https://app.example.com" \
PORT=3010 \
yarn workspace @invokta/example-auth-clerk mcp:http
```

Copy a session token from your Clerk application — for example
`await window.Clerk.session.getToken()` in the browser console of a signed-in
page — and call the tool:

```sh
curl -sS http://127.0.0.1:3010/mcp \
  -H "authorization: Bearer $CLERK_SESSION_TOKEN" \
  -H 'accept: application/json, text/event-stream' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"identity_whoami","arguments":{}}}'
```

Clerk session tokens are short-lived, so an old token returns HTTP 401. So does
a token whose `azp` is not in `CLERK_AUTHORIZED_PARTIES`.

## Verify it

```sh
yarn workspace @invokta/example-auth-clerk test
```

The tests mint tokens in Clerk's session-token claim shape from a locally
generated key pair and serve them through a local JWKS, so signature
verification is real and no test performs network I/O or needs a Clerk account.

## Related

- [`docs/http-authentication.md`](../../docs/http-authentication.md) — the hook
  contract and the secret and logging rules.
- [`docs/capability-authorization.md`](../../docs/capability-authorization.md) —
  turning principal attributes such as `organizationRole` into an access rule.

## Inspect and gate this engine

```sh
yarn workspace @invokta/example-auth-clerk devtools
yarn workspace @invokta/example-auth-clerk devtools:doctor
yarn workspace @invokta/example-auth-clerk check:mcp
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
