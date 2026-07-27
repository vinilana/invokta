# ADR 0007: Stateless HTTP, pluggable authentication, and authorization in the core

- Status: Accepted
- Date: 2026-07-27

## Context

HTTP deployments may authenticate with JWT, an API key, an identity proxy, or
another mechanism. These options belong at the boundary and vary by environment.
Authorization for a capability, however, is an engine rule and must apply equally
to other transports.

## Decision

The HTTP integration will be stateless: each request will contain everything
needed to authenticate and execute it. The default adapter will not maintain a
user session, session cookie, instance affinity, or identity in global state.

Authentication (`authn`) will be a pluggable hook at the HTTP boundary. The
authenticator will receive the transport data and produce a normalized principal
limited to the request context, or reject the request. Tokens, headers, and
framework types will not cross into the domain.

Authorization (`authz`) will be the responsibility of `@ai-engine/core` and will
occur in the `invoke` pipeline before the handler. Every capability will declare
`access` as `public`, `authenticated`, or a domain authorization function.
Protected capabilities will
fail closed when there is no principal or valid authorization decision. Adapters
will only map the structured error; they must not grant access or duplicate
business policies.

After authentication, the HTTP adapter will construct the invocation and call
`invoke`; it will not call handlers directly.

## Consequences

- Identity strategies can vary without modifying core capabilities.
- Horizontal scaling does not depend on a session maintained by an instance.
- The same authorization policy applies to HTTP and other transports.
- Features that require a session must use explicit external state and must not
  change the adapter's stateless semantics.
- Tests must cover pluggable authenticators, per-request isolation, fail-closed
  behavior, and execution denied before the handler.
