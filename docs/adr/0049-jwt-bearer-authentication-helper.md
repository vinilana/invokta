# ADR 0049: JWT bearer authentication helper

- Status: Accepted
- Date: 2026-11-05

## Context

ADR 0007 made HTTP authentication a pluggable hook that returns a minimal
`Principal` or `null`, and AE-LIMIT-04 excluded a universal JWT/JWKS client
until repeated evidence justified one. AE-SCOPE-04 and the evolution triggers
name that evidence: authentication support after several engines repeat the
same integration.

Nine authentication examples now repeat it. `auth-jwt-bearer-engine`,
`auth-auth0-engine`, `auth-authjs-engine`, `auth-better-auth-engine`,
`auth-clerk-engine`, `auth-cognito-engine`, `auth-self-hosted-oauth-engine`,
`auth-supabase-engine`, and `auth-workos-engine` each parse an
`Authorization: Bearer` header, verify a signed JWT with `jose`
`createRemoteJWKSet` and `jwtVerify` under an issuer, audience, and algorithm
policy, classify `jose` failures into invalid credentials and infrastructure
failures, race the request signal, map selected claims to a `Principal`, and
replace infrastructure errors with a fixed sentence. Their differences are the
issuer and key-set derivation, the algorithm list, and the claim mapping.

Each copy also carries the same security decisions, so a defect or a `jose`
upgrade must be repeated in every example and in every engine copied from one.

## Decision

Invokta publishes `@invokta/auth-jwt`, a native ESM package whose only runtime
dependency is `jose`, pinned exactly to the version the examples use. It has no
`@invokta/*` dependency: its request view and principal are structural types
compatible with `McpHttpAuthenticationRequest` and the core `Principal`.

`createJwtBearerAuthenticator(options)` validates and snapshots its
configuration and returns a function of
`{ headers: { get(name) }, signal? }` to `Promise<Principal | null>`. The
function is the `serveMcpHttp` `authenticate` hook as-is and fits any adapter
with the same request view, including a Web `Request`.

Configuration:

- `issuer` is the exact `iss` value; `audience` is one value or a non-empty
  list, of which the token's `aud` must contain one.
- `algorithms` is a required, non-empty allowlist of asymmetric JWS
  algorithms: RS, PS, and ES with 256, 384, or 512 bits, `EdDSA`, and
  `Ed25519`. `none`, shared-secret `HS*`, unknown names, and duplicates are
  rejected at construction. A Resource Server that can verify a shared-secret
  token can also mint one, and a JWKS publishes public keys.
- Exactly one key source: `jwksUrl`, an HTTPS URL or loopback HTTP for
  development without credentials or a fragment, verified through `jose`'s
  remote key set with a 5-second fetch timeout, a 10-minute cache, a 30-second
  refetch cooldown for unknown key identifiers after a successful fetch, and no
  redirects; or `jwks`, a local set of public keys for tests, offline use, or
  pinned keys. A remote key set is not fetched until a credential arrives.
  Because `jose` starts its cooldown only after a successful fetch, the helper
  adds a 5-second window after a failed fetch in which nothing is fetched: a
  fresh cached key set keeps answering, and without one the lookup fails at
  once. The response body is read whole and is bounded only by the fetch
  timeout, so the host must configure a trusted endpoint.
- `clockToleranceSeconds` is an integer from 0 to 300 and defaults to 0.
- `maxTokenLength` is an integer from 1 to 16,384 and defaults to 8,192
  characters.
- `requiredScopes` lists unique RFC 6749 scope tokens that the space-delimited
  `scope` claim must all grant.
- `principal` is a synchronous mapper from verified claims to a principal or
  `null`. It never receives the raw token. The default maps `sub` to `id` and
  only `scope`, `iss`, and `client_id` to `attributes.scopes`,
  `attributes.issuer`, and `attributes.clientId`.

Configuration errors are `TypeError`s with fixed messages that never echo a
configured value.

Each call parses only `Authorization: Bearer <compact JWS>`: a case-insensitive
scheme, exactly one space, and three non-empty base64url segments within the
length bound. The token must verify its signature under the allowlist and
carry the configured issuer and audience, `sub`, and `exp`; `nbf` is honored.
The call then resolves:

- a principal when verification, required scopes, and mapping succeed;
- `null` for a missing, malformed, oversized, expired, not-yet-valid, wrongly
  issued, wrongly addressed, disallowed-algorithm, unknown-key, bad-signature,
  missing-claim, or insufficient-scope credential, and for a malformed mapper
  result, without revealing which check failed; or
- a rejected `JwtVerificationUnavailableError` with a fixed message and no
  cause when verification cannot complete: a key-set timeout, transport
  failure, non-200 or redirect response, malformed or unusable key set, the
  failed-fetch window without a fresh cache, or cancellation through the
  optional request signal.

A token without a `kid` header can match several published keys, which is
normal while an issuer rotates keys. The caller, not the issuer, creates that
ambiguity by omitting `kid`, so it is never reported as an unavailable key set.
The helper tries at most eight matching keys in key-set order. The key that
signed a legitimate token verifies it, and a token that none of them verifies
resolves `null`. A forged token therefore cannot force a 500.

An unreachable key set is therefore not reported as an invalid credential.
The MCP HTTP adapter answers the rejection with its existing sanitized 500, so
neither the response nor the error can expose the token, the key-set URL, or
the provider's response. An error thrown by a host-supplied mapper propagates
unchanged, because it belongs to host code rather than to verification.

Because the hook contract is `Principal | null`, a token that lacks a required
scope is unauthenticated and receives HTTP 401 rather than an RFC 6750
`insufficient_scope` 403. The host configures the MCP adapter's
`challengeScopes` with the same scopes, so the challenge names what an OAuth
client must request. Scopes required only by some capabilities remain domain
authorization in those capabilities' `access` rules, which answer `FORBIDDEN`
inside the MCP response.

The package adds no capability execution path, routing, session, cache shared
across authenticators, retry, or logging. `auth-jwt-bearer-engine` and
`auth-auth0-engine` adopt it; the other examples keep their own verifiers until
they are migrated individually.

## Security boundary

AE-LIMIT-04 is amended, not removed. Invokta still provides no identity
provider, token issuer, token introspection client, OpenID Connect discovery,
DPoP, mTLS or certificate-bound tokens, revocation check, policy language,
relationship graph, PDP adapter, or session binding. The helper verifies one
configured issuer's signed JWT access tokens; opaque tokens, encrypted JWTs,
several issuers, RFC 9068 `typ` enforcement, and shared-secret tokens remain
host-owned hooks.

The core still imports no identity SDK, and the MCP adapter still accepts any
host hook. The helper is opt-in and does not change ADR 0007's outcomes:
`null` is 401, a rejection is a sanitized 500, and authorization stays in
`engine.invoke`.

## Consequences

- Hosts get one maintained, tested JWT bearer policy instead of copying an
  example's verifier, and `jose` upgrades happen in one package.
- The option names, defaults, bounds, supported algorithms, failure
  classification, default principal shape, and error class become public
  compatibility surfaces of a new package.
- The public package set grows by one. `@invokta/auth-jwt` is an optional
  runtime helper, not a fourth framework runtime package: the core and the
  adapters do not depend on it. The authentication implementation limit
  becomes this one opt-in JWT bearer helper, and the PDP limit stays at zero.
- A new npm trusted publisher must be configured for the package before the
  release that first publishes it.
- Examples migrated to the helper depend on an `@invokta/*` package that is
  published only with the next release.
- Introspection, OIDC discovery, multi-issuer, `typ` enforcement, or
  sender-constrained tokens require new evidence and a new decision.
