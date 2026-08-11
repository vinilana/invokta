# ADR 0024: Production MCP OAuth integration boundary

- Status: Accepted
- Date: 2026-08-10

## Context

The stateless MCP HTTP adapter already acts as an OAuth Resource Server: it
requires a host authentication hook, publishes configured Protected Resource
Metadata, issues a Bearer challenge, and passes a verified minimal `Principal`
to `engine.invoke`. Invokta devtools can also inspect an explicit remote MCP
target through an ephemeral Authorization Code with PKCE client flow.

A production Action Engine demonstrated a second recurring need: a complete
self-hosted Authorization Server with discovery, Client ID Metadata Documents,
Dynamic Client Registration, login, consent, signing keys, rotating refresh
tokens, persistent grants and sessions, database migration, reverse-proxy
routing, deployment recovery, and client-specific interoperability defaults.
Copying that implementation into a generic template proved that the operating
guidance and conformance path are reusable. It did not prove that account
policy, persistence, identity lifecycle, or an Authorization Server runtime API
has converged across several independent engines.

The MCP `2025-11-25` authorization specification separates the MCP Resource
Server from the Authorization Server. It requires Protected Resource Metadata
for discovery, requires audience-bound access tokens, and recommends that a 401
Bearer challenge identify the scopes required for the current request. The
challenge scope is authoritative and need not equal the metadata's
`scopes_supported` set.

## Decision

Invokta owns the MCP Resource Server protocol contract, provider-neutral project
generation, bounded deployment diagnostics, and OAuth client homologation. A
custom engine or host continues to own credential verification, identity and
account policy, login and consent, token issuance and refresh, persistence,
proxy topology, and secret lifecycle.

`@invokta/mcp` adds an optional `challengeScopes` field to required HTTP
authentication. It is independent of Protected Resource Metadata's
`scopesSupported`. The adapter validates and snapshots each configured RFC 6749
scope token before listening and, on an unauthenticated request, serializes the
ordered list in the Bearer challenge. Existing consumers that omit the field
retain their current challenge. Challenge scopes require configured Protected
Resource Metadata so an OAuth client can discover the Authorization Server.

Invokta adds a production-oriented self-hosted OAuth engine under `examples/`.
The example may depend on an identity library, JOSE, PostgreSQL, and deployment
assets, but those dependencies do not enter framework runtime packages. The
existing `create-invokta-engine --example` path is the supported creation
mechanism; the default HTTP and complete profiles remain provider-neutral and
fail closed.

`@invokta/deploy` may add a separately named, bounded, read-only OAuth discovery
inspection operation. It does not change the existing one-request health probe
and does not register clients, perform login or consent, exchange tokens, or
mutate a remote service by default. Interactive end-to-end authorization
continues through the existing `@invokta/mcp` client facade and Invokta
devtools, rather than through a second OAuth client implementation.

The complete self-hosted Authorization Server is not extracted into
`@invokta/core` or `@invokta/mcp`. A future optional runtime package requires a
new ADR, evidence from at least three independently deployed engines, a stable
shared contract across different host topologies, a threat model, and explicit
security-maintenance ownership.

## Security boundary

The Resource Server remains stateless and fail closed. Authentication never
bypasses capability access rules or the single `engine.invoke` path. Challenge
configuration cannot contain credentials or select a principal.

The official example must preserve PKCE, exact redirect URI validation,
audience and issuer validation, short-lived access tokens, refresh-token
rotation, CSRF and interaction replay protection, sanitized diagnostics, and a
bootstrap path with no default password or public sign-up.

Client ID Metadata Documents cause an Authorization Server to fetch a
client-controlled URL. The official example must either enforce a bounded
SSRF-resistant fetch policy, including address, redirect, re-resolution,
timeout, and response-size defenses, or leave CIMD disabled. HTTPS syntax and a
non-loopback hostname check alone are insufficient.

## Consequences

- OAuth discovery behavior that is part of the MCP Resource Server becomes a
  tested framework compatibility surface.
- Engine authors can start from one maintained production example without
  making its identity and database choices universal framework dependencies.
- The default creators remain small, provider-neutral, and fail closed.
- Deployment liveness, discovery readiness, and interactive authorization stay
  separate verification levels with separate authority and side effects.
- Invokta's package count and explicit prohibition on framework identity
  implementations remain unchanged.
- A complete Authorization Server library remains evidence-gated rather than
  being extracted from one implementation and its copy.
