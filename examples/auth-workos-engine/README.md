# auth-workos-engine

An Action Engine whose MCP HTTP boundary authenticates callers with
[WorkOS AuthKit](https://workos.com/docs/authkit) access tokens.

## What it shows

- A composition-root verifier (`src/identity/verifier.ts`) that validates an
  AuthKit access token with `jose` against the client-scoped WorkOS JWKS,
  checking signature, issuer, expiry, and — when configured — audience.
- A claims mapping (`src/identity/principal.ts`) that turns the verified
  claims into the framework `Principal`: `sub` becomes the id, and `org_id`,
  `role`, `permissions`, and `sid` become attributes when the token carries
  them. `org_id` is the multi-tenant attribute a capability access rule keys
  on.
- The `authenticate` hook contract (`src/mcp-http.ts`): a `Principal` for a
  valid credential, `null` for every invalid one (HTTP 401), and a rejection
  only when verification infrastructure fails (sanitized HTTP 500).
- A single `identity.whoami` capability with `access: "authenticated"` that
  derives its whole result from the trusted principal, never from input.

Key resolution is injectable, so the tests verify real RS256 signatures
against a locally generated key pair with `createLocalJWKSet` and perform no
network I/O.

## Run it against a real WorkOS environment

Build the repository from its root, then start the MCP HTTP adapter:

```sh
yarn build
WORKOS_CLIENT_ID=client_... \
PORT=3000 \
yarn workspace @invokta/example-auth-workos mcp:http
```

That starts the **session-token flavor**: it verifies the AuthKit access
tokens your application already holds (`iss` `https://api.workos.com/`, JWKS
`sso/jwks/<clientId>`, no `aud` claim). For the **MCP OAuth flavor** — tokens
bound to this engine through a resource indicator, with Protected Resource
Metadata published for discovery — also set `WORKOS_AUTHKIT_DOMAIN` and
`WORKOS_MCP_RESOURCE`.

| Variable | Required | Meaning |
| --- | --- | --- |
| `WORKOS_CLIENT_ID` | yes | Client id of the WorkOS environment; it selects the session-token JWKS at `https://api.workos.com/sso/jwks/<clientId>` |
| `WORKOS_MCP_RESOURCE` | no | Resource indicator registered in AuthKit; selects the MCP OAuth flavor, becomes the expected `aud` claim and the published Protected Resource Metadata resource. **Security consequence of leaving it unset:** session tokens carry no `aud`, so any valid AuthKit session token from the environment — including one minted for your main web app — authenticates here |
| `WORKOS_AUTHKIT_DOMAIN` | with `WORKOS_MCP_RESOURCE` | The environment's AuthKit domain, `https://<environment>.authkit.app`; the MCP OAuth flavor derives `iss`, the `/oauth2/jwks` key set, and the advertised authorization server from it |
| `WORKOS_ISSUER` | no | Expected `iss` override for a custom auth domain |
| `WORKOS_JWKS_URL` | no | Full JWKS URL override for a custom auth domain |
| `PORT` | no | Listening port, defaults to `3000` |

No WorkOS API key or client secret is needed: verifying an access token only
requires the public JWKS.

Call the engine with an AuthKit access token obtained by your application:

```sh
curl -sS http://127.0.0.1:3000/mcp \
  -H "authorization: Bearer $WORKOS_ACCESS_TOKEN" \
  -H 'accept: application/json, text/event-stream' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"identity.whoami","arguments":{}}}'
```

A missing or invalid token answers HTTP 401 before `engine.invoke` runs.

## Verify it

```sh
yarn workspace @invokta/example-auth-workos test
```

The tests cover a valid token, every invalid-credential class (missing header,
non-bearer scheme, malformed, expired, wrong issuer, wrong audience, bad
signature, unknown signing key), verification infrastructure failure, request
cancellation, the organization-claims mapping, and the absence of credential
material in the produced principal.

## Related documentation

- [Recipe: Authenticate with WorkOS AuthKit](https://docs.invokta.dev/recipes/auth/workos/)
- [Guide: HTTP authentication](https://docs.invokta.dev/guides/http-authentication/)
- [Guide: Capability authorization](https://docs.invokta.dev/guides/capability-authorization/)
