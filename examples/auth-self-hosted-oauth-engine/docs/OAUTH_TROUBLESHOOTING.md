# OAuth Troubleshooting

## Start with stages, not guesses

Every successful connection crosses these stages:

1. MCP protected-resource discovery.
2. Authorization-server discovery and JWKS.
3. Client registration.
4. Browser login.
5. Consent submission.
6. Callback delivery.
7. Authorization-code exchange at `/token`.
8. Authenticated MCP request.

Determine the last completed stage before changing configuration.

## Safe first checks

```sh
docker compose ps
docker compose logs --since=10m auth engine
npm run deploy:probe -- --url https://mcp.example.com/mcp --expect alive
npm run oauth:probe-dcr -- --url https://mcp.example.com
```

The DCR probe must return HTTP 201 and cleanup HTTP 204. It does not print the
client ID or secret.

## Symptom matrix

| Symptom | Evidence to inspect | Likely cause |
| --- | --- | --- |
| Client asks for manual ID and secret | DCR probe and `registration_create.error` | Invalid default metadata, unsupported auth method, or `/reg` routing |
| `invalid_client_metadata` mentions signing algorithm | DCR response and JWKS | Client default requests RS256 while the server signs only ES256 |
| Login rejects a known password | Owner row lock state and bootstrap history | Wrong email/password, account lock, or owner already bootstrapped with another value |
| First consent appears idle; second returns `server_error` | First `interaction_consent` and `authorization` logs | First interaction was consumed; inspect its callback instead of resubmitting |
| Authorization code exists but no `/token` request follows | Redirect origin and client callback behavior | Browser/CSP callback interruption, client eligibility, state handling, or external callback failure |
| `/token` returns client authentication error | Registered `token_endpoint_auth_method` | Client sends Basic while registered for POST, or vice versa |
| `/token` returns invalid grant | Code age, redirect URI, PKCE method | Expired/reused code, redirect mismatch, or wrong verifier |
| MCP remains 401 after token exchange | JWT claims and protected-resource metadata | Wrong issuer, audience, subject, signature, or missing `mcp:tools` |
| Refresh works once and then fails with the old token | Rotation behavior | Expected replay protection; store the newly returned refresh token |
| Proxy returns 404 for metadata | Router priority and path rules | MCP metadata routed to OAuth or catch-all router wins |
| Proxy cannot start | Existing listeners on 80/443 | Caddy and Traefik conflict |

## Read sanitized request logs

Expected browser flow:

```text
OAuth request completed: method=GET route=authorization status=303 redirect=self.
OAuth request completed: method=POST route=interaction_login status=303 redirect=self.
OAuth request completed: method=POST route=interaction_consent status=303 redirect=self.
OAuth request completed: method=GET route=authorization status=303 redirect=https://client.example.com.
OAuth request completed: method=POST route=token status=200 redirect=none.
```

If the final authorization redirect exists but `/token` does not, the server
has already finished consent. Investigate the callback client and its product
requirements. Do not extend interaction lifetimes or permit replay to hide a
callback failure.

## Inspect artifact counts without secrets

Use counts and expiry state, not payload dumps:

```sql
SELECT model,
       count(*) AS total,
       count(*) FILTER (WHERE expires_at IS NULL OR expires_at > now()) AS live,
       count(*) FILTER (WHERE consumed_at IS NOT NULL) AS consumed
FROM oauth_artifacts
GROUP BY model
ORDER BY model;
```

Do not print complete `Client`, `Interaction`, `AuthorizationCode`, access-token,
refresh-token, or registration-token payloads. Client secrets and protocol
values may be present.

## Dynamic registration failures

Verify:

- `registration_endpoint` points to the public `/reg` route;
- JWKS contains an ES256 signing key;
- omitted metadata defaults to ES256 and `client_secret_basic`;
- `client_secret_post` is accepted when explicitly registered;
- redirect URIs are absolute and accepted by oidc-provider;
- Traefik or Caddy sends `/reg` to OAuth, not the engine.

After changing DCR, test a real POST that omits optional metadata. Discovery
alone does not prove that registration works.

## Consent and callback failures

Use a fresh authorization interaction for every retry. A consent URL is
single-use. Check:

- the selected `redirect_uri` exactly matches a registered value;
- the CSP allows the HTTPS redirect chain or exact loopback origin;
- the first POST returned 303;
- the resumed `/auth/*` request returned 303 to the client origin;
- the client called `/token` before the 60-second code expired.

Automated tests must use a callback on an origin you control. Do not authorize
the owner account against an external callback without explicit user approval.

## Token and MCP failures

Decode only a disposable test JWT and never log the raw token. Confirm:

- `alg` is ES256;
- `iss` equals `APP_PUBLIC_URL` exactly;
- `aud` equals `${APP_PUBLIC_URL}/mcp`;
- `sub` is present;
- `scope` contains `mcp:tools`;
- `exp` is current;
- the engine can reach its configured JWKS URL.

Do not add authentication bypasses for local convenience. Use the explicit
Bearer compatibility mode only when the client cannot perform OAuth and the
user accepts the reduced security model.

## Escalation record

When a problem remains, report:

- last successful stage;
- first failing route and sanitized status/code;
- whether a code was created and consumed;
- whether `/token` was called;
- client auth method and redirect origin, without secrets;
- exact server version and proxy topology;
- account or product eligibility requirements still outside server control.
