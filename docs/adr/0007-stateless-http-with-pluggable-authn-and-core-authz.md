# ADR 0007: Stateless HTTP, pluggable authentication, and core authorization

- Status: Accepted
- Date: 2026-07-27

## Context

HTTP authentication varies by deployment, while capability authorization is a
domain rule that must apply identically through every execution channel.

## Decision

The MCP HTTP adapter is stateless. Each POST creates a fresh protocol server and
transport with no session identifier, event store, resumption state, sticky
routing, or identity in global state.

Authentication is a required, pluggable HTTP-boundary hook unless the host
explicitly enables the dangerous development mode. It returns a minimal
`Principal` or `null`. Missing or invalid credentials produce HTTP 401 with a
Bearer challenge; authentication infrastructure failure produces a sanitized
HTTP 500.

Before authentication, the adapter validates the exact canonical `/mcp` route,
method, one raw `Host` header, any supplied `Origin`, and declared body limits.
Loopback is the default bind boundary. Non-loopback binds require an explicit
host allowlist, and forwarded-host headers are ignored. Request bodies are
bounded to 1,048,576 bytes by default and decoded as strict UTF-8.

The adapter snapshots its configuration at startup and deep-clones and validates
the principal for each request. Credentials and platform header types do not
enter domain code. Protected Resource Metadata is validated before listening.

Authorization remains in the core `engine.invoke` pipeline before `run`.
Capabilities declare `public`, `authenticated`, or a domain access function;
adapters only map the resulting structured error. Capability denial is an MCP
tool error with `FORBIDDEN` inside HTTP 200, distinct from the HTTP 403 used by
Host and Origin defenses.

An active request disconnect aborts its invocation. Cross-request cancellation
is not supported because no protocol state survives between requests. Server
shutdown shares one close operation, aborts active request signals, and closes
their connections.

## Consequences

- Identity providers can change without modifying capabilities or the core.
- The same authorization rule applies to direct, CLI, stdio, and HTTP calls.
- Horizontal scaling does not require server affinity.
- Stateful MCP features require a separate profile and architectural decision.
