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
Each MCP POST will create a new protocol server and transport without a session
identifier, event store, or resumption state. A principal exists only for that
request and cannot be reused by another concurrent or later request.

Authentication (`authn`) will be a pluggable hook at the HTTP boundary. The
authenticator will receive the transport data and produce a normalized principal
limited to the request context, or reject the request. Tokens, headers, and
framework types will not cross into the domain.

A non-null principal entering `invoke` must be a structured-cloneable record with
a non-empty string `id`. Its optional `attributes` value must itself be a
structured-cloneable record. The core will deep-snapshot this identity before any
asynchronous pipeline work and will give authorization and execution independent
copies. A malformed or uncloneable identity fails closed as `UNAUTHENTICATED`
before the access rule or handler. Mutation by the authenticator's caller or by
an access rule therefore cannot alter the identity observed by execution.

The adapter will validate `Host` before authentication on every request and will
ignore forwarded-host headers. Loopback binds receive safe loopback host defaults;
a non-loopback bind requires an explicit host allowlist. An absent `Origin` is
accepted for non-browser clients, while every supplied origin requires an
explicit normalized HTTP(S) origin allowlist. Host or Origin rejection returns
HTTP 403 before authentication.

Only the exact canonical `/mcp` target is a protocol route. Dot-segment and
percent-encoded aliases, queries, fragments, and absolute-form targets are
rejected before authentication. IPv6 `Host` authorities require brackets; a bare
multi-colon authority is rejected before authentication even when it represents
loopback.

The adapter requires exactly one raw `Host` header and does not consult forwarded
host headers. The authentication hook receives a minimal read-only view of
headers rather than a mutable platform header object. HTTP request bodies are
bounded to 1,048,576 bytes by default, with an optional positive safe-integer
override. Declared or streamed overflow returns HTTP 413 and never reaches MCP
protocol dispatch.

The authentication hook returns `null` for missing or invalid credentials, which
produces HTTP 401 and a Bearer challenge. If Protected Resource Metadata is
configured, the challenge contains its configured, validated discovery URL.
A thrown or rejected hook is an authentication infrastructure failure and
produces a sanitized HTTP 500. The adapter does not infer whether an arbitrary
exception means an invalid credential.

The adapter accepts only the exact required and explicitly dangerous development
authentication modes and validates the required hook before listening. It
snapshots that mode and hook at startup, so later mutations to host configuration
cannot swap or disable authentication. It rejects duplicate raw `Authorization`
headers before calling the hook. A returned principal is deep-cloned and
validated immediately for that request: its ID is a nonempty string and its
optional attributes are a record. Malformed or non-cloneable principals fail as
invalid credentials, and later mutation or reuse of the hook's object cannot
bleed identity between requests.

Protected Resource Metadata is validated before listening. Its resource URL uses
HTTPS and the exact `/mcp` path without credentials, query, or fragment. Loopback
HTTP is permitted only as an explicit development resource. Authorization server
URLs use HTTPS without credentials, query, or fragment. Their path components
remain permitted because OAuth issuer identifiers commonly include tenant paths.

Authorization (`authz`) will be the responsibility of `@ai-engine/core` and will
occur in the `invoke` pipeline before the handler. Every capability will declare
`access` as `public`, `authenticated`, or a domain authorization function.
Protected capabilities will
fail closed when there is no principal or valid authorization decision. Adapters
will only map the structured error; they must not grant access or duplicate
business policies.

After authentication, the HTTP adapter will construct the invocation and call
`invoke`; it will not call handlers directly.

A capability authorization denial remains a tool execution error with
`FORBIDDEN` inside a successful HTTP 200 MCP response; it is distinct from the
HTTP 403 used by the request-boundary Host and Origin defenses. Cancellation is
propagated when the active HTTP request disconnects. Cross-request MCP
cancellation is not promised because the stateless profile deliberately retains
no server, transport, or session between requests.

The returned server handle exposes only its bound host and port. Concurrent calls
to `close` share one shutdown operation. Shutdown aborts tracked active request
signals and closes their connections so it cannot wait indefinitely for a
capability that is already cancellable through the runtime contract.

## Consequences

- Identity strategies can vary without modifying core capabilities.
- Horizontal scaling does not depend on a session maintained by an instance.
- The same authorization policy applies to HTTP and other transports.
- Request identity snapshotting prevents mutable authentication state from being
  shared across authorization and execution.
- Features that require a session must use explicit external state and must not
  change the adapter's stateless semantics.
- Tests must cover pluggable authenticators, configuration snapshots, principal
  validation and per-request isolation, fail-closed behavior, and execution
  denied before the handler.
- Features that require cross-request cancellation must choose an explicitly
  stateful profile outside the v0.1 adapter.
