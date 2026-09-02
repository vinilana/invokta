# ADR 0039: Configurable MCP HTTP mount path

- Status: Accepted
- Date: 2026-09-02

## Context

ADR 0007 fixed the stateless MCP HTTP adapter at the exact canonical `/mcp`
request target and required a Protected Resource Metadata resource whose path
is exactly `/mcp`. Every `serveMcpHttp` call owns its own `node:http` server,
so a host that publishes several engines from one process behind one public
origin could not give each engine its own resource identifier: every instance
claimed the same path.

The Invokta Gateway design note describes that host. It builds Action Engines
from configuration and publishes each one as its own MCP server with its own
audience-bound access tokens, which requires one distinct resource identifier
per engine. One subdomain per engine satisfies the fixed route without a
framework change, but it requires wildcard DNS and TLS and does not resolve
through Node's resolver during local development.

RFC 8707 allows a resource identifier to carry a path, and RFC 9728 defines the
path-suffix well-known location for its metadata. The isolated SDK helper the
adapter already uses derives that location from the resource URL.

## Decision

`serveMcpHttp` accepts an optional `path`. It defaults to `/mcp`, so existing
consumers observe no change. A configured value MUST be an absolute path of
unreserved ASCII segments (`A-Z`, `a-z`, `0-9`, `-`, `.`, `_`, `~`), without a
dot segment, an empty segment, percent encoding, a query, a fragment, or a
trailing slash, at most 256 bytes, and its final segment MUST be `mcp`. The
adapter validates the value and fails before listening.

The configured path is the only request target that reaches protocol dispatch.
A Protected Resource Metadata resource MUST use exactly that path, and its
document is served at the RFC 9728 path-suffix location
`/.well-known/oauth-protected-resource<path>`. The authentication hook receives
the configured path. Request-target aliases of the mounted path are rejected
by the existing canonical-target rule, so the two checks accept one spelling.

Everything else in ADR 0007 is unchanged: statelessness, the single raw `Host`
header and its allowlist, ignored forwarded headers, `Origin` validation, body
limits, the authentication order, and the deep-cloned principal.

`@invokta/deploy` accepts the same rule wherever it accepts an MCP URL. `probe`
and `inspect-oauth` send their request to the path exactly as written instead
of substituting `/mcp`, and they continue to reject every alias of it.

The adapter still creates one server per engine. Mounting an engine inside a
host-owned server, or a fetch-handler adapter for serverless platforms, remains
a separate decision. Devtools keep serving their workbenches at `/mcp` and
`/cli`; those are not engine mount paths.

## Consequences

- A host can publish several engines from one origin, each with its own
  resource identifier and audience, by fronting the loopback-bound adapters
  with a reverse proxy that preserves the raw `Host` header.
- The canonical `mcp` suffix keeps the MCP route recognizable to operators,
  probes, and documentation regardless of the prefix.
- The default profile, the creators, and every existing example are unchanged.
- The Gateway remains an application outside the framework packages; this ADR
  is the only framework change it needs for its MVP.
