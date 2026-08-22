# auth-cognito-engine

Authenticates MCP HTTP requests with **Amazon Cognito user pool access tokens**
and exposes one capability, `identity.whoami`, that reports the verified
principal.

## What it shows

- A `serveMcpHttp` `auth.authenticate` hook that verifies a Cognito access
  token with `jose` against the user pool JWKS, with injectable key resolution
  so tests run offline.
- The Cognito specifics an access token requires:
  - issuer `https://cognito-idp.<region>.amazonaws.com/<user-pool-id>`;
  - JWKS at `<issuer>/.well-known/jwks.json`, RS256 only;
  - **no `aud` claim** on an access token, so the app client is authorized
    through the `client_id` claim;
  - `token_use` must be `access`, so an id token is rejected.
- Claim mapping into the framework `Principal`: `sub` becomes `id`, `scope`
  becomes `attributes.scopes`, `cognito:groups` becomes `attributes.groups`,
  and `client_id` becomes `attributes.clientId`.
- The failure semantics of `docs/http-authentication.md`: `null` for any
  invalid or missing credential (HTTP 401) and a thrown, sanitized error only
  when verification infrastructure cannot complete (HTTP 500).

Cognito appears only in `src/identity/` and `src/mcp-http.ts`. The capability
in `src/capabilities/whoami.ts` sees a `Principal` and never a token.

## Layout

```text
src/
  engine.ts                 # the engine and its single capability
  capabilities/whoami.ts    # access: "authenticated"; derived from the principal
  identity/verifier.ts      # Cognito access-token verification
  identity/principal.ts     # verified claims -> Principal
  mcp-http.ts               # serveMcpHttp entrypoint, mode "required"
test/                       # offline tests, local key pair and local JWKS
```

## Run it against a real user pool

```sh
yarn workspace @invokta/example-auth-cognito build

COGNITO_REGION=us-east-1 \
COGNITO_USER_POOL_ID=us-east-1_ExamplePool \
COGNITO_APP_CLIENT_IDS=1example23456789 \
PORT=3000 \
yarn workspace @invokta/example-auth-cognito mcp:http
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `COGNITO_REGION` | yes | AWS region of the user pool |
| `COGNITO_USER_POOL_ID` | yes | User pool id, for example `us-east-1_ExamplePool` |
| `COGNITO_APP_CLIENT_IDS` | yes | Comma-separated app client ids accepted in `client_id` |
| `PORT` | no | Bind port, default `3000` |
| `COGNITO_RESOURCE_URL` | no | Public `/mcp` URL; publishes Protected Resource Metadata |
| `COGNITO_CHALLENGE_SCOPES` | no | Comma-separated ordered scopes serialized into the 401 Bearer challenge, written as `<resource-server-identifier>/<scope>`. Requires `COGNITO_RESOURCE_URL` |

No AWS credential or client secret is needed: the verifier reads only the
public JWKS.

Then call the engine with an access token obtained from your app client, for
example through the hosted UI or `InitiateAuth`:

```sh
curl -sS http://127.0.0.1:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer $COGNITO_ACCESS_TOKEN" \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/call",
       "params":{"name":"identity_whoami","arguments":{}}}'
```

A valid token returns the principal. A missing, expired, foreign-issuer,
foreign-client, or id token returns HTTP 401.

## Verify it

```sh
yarn workspace @invokta/example-auth-cognito test
```

The tests generate a key pair locally, serve it through `createLocalJWKSet`,
and mint tokens in the Cognito access-token claim shape. Signature verification
is real and no test performs network I/O or needs an AWS account.

## Related documentation

- [Capability authorization](../../docs/capability-authorization.md) for the
  policy half of the split.
- [HTTP authentication](../../docs/http-authentication.md) for the hook
  contract and the secret and logging rules.

## Verify the OAuth discovery chain

The challenge scopes are separate from the metadata's `scopes_supported` on
purpose: the 401 challenge is authoritative for the request the client just
made, while the metadata describes the minimal generally supported set. Leave
them unset when the authentication policy cannot name a stable base set.

Once the endpoint is reachable, inspect the discovery chain without sending a
credential:

```sh
yarn workspace @invokta/example-auth-cognito deploy:inspect-oauth --url https://engine.example.com/mcp
```

`invokta-deploy inspect-oauth` walks the 401 challenge, Protected Resource
Metadata, the Authorization Server's RFC 8414 metadata, and the advertised
registration and JWKS endpoints, and reports each leg with its own outcome and
remediation. It registers no client, opens no login, exchanges no code, and
mutates nothing.

## Inspect and gate this engine

```sh
yarn workspace @invokta/example-auth-cognito devtools
yarn workspace @invokta/example-auth-cognito devtools:doctor
yarn workspace @invokta/example-auth-cognito check:mcp
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
