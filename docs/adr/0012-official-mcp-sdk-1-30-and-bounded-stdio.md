# ADR 0012: Official MCP SDK 1.30.0 and bounded stdio reads

- Status: Accepted
- Date: 2026-07-29
- Supersedes in part: [ADR 0006](0006-isolated-official-mcp-sdk-and-protocol-2025-11-25.md)

## Context

ADR 0006 approved `@modelcontextprotocol/sdk@1.29.0`, required exact pins and
compatibility verification for every update, and temporarily forced
`@hono/node-server@2.0.12` at the workspace root. SDK 1.30.0 changes observable
stdio resource behavior and widens the Hono dependency range, so treating the
upgrade as a lockfile-only change would leave the public operational contract and
the security decision stale.

The 1.29.0 to 1.30.0 comparison was reviewed against every SDK subpath imported
by `@ai-engine/mcp` and its tests. The investigation established the following:

- `LATEST_PROTOCOL_VERSION` remains `2025-11-25`, and the protocol schemas used
  by the adapter remain compatible with the adopted baseline.
- The package export map and the documented subpaths imported by this repository
  are unchanged. The adapter continues to avoid the SDK root entry point.
- The SDK still treats request IDs `0` and `""` incorrectly in its cancellation
  path. The private request-ID transport remains necessary, and the stdio and
  HTTP acceptance tests continue to cover both IDs.
- The SDK now bounds its stdio read buffer to 10 MiB by default. A buffer append
  above the configured maximum emits a transport error and closes the
  connection. Both the SDK client and server transports accept a custom maximum.
- The Web Standard HTTP transport adds parsed Content-Type validation and fixes
  SSE keep-alive and resumption lifecycle behavior. The framework already
  validates the exact media type before SDK dispatch, passes a parsed body, and
  creates a fresh JSON-response transport for every request with sessions,
  resumption, event storage, and server-to-client SSE disabled. These SDK fixes
  therefore do not expand or change the framework's stateless HTTP contract.
- Zod literal and error-formatting fixes remain internal to the SDK. The
  framework still registers authoritative Standard JSON Schemas through the
  low-level server API and exposes no SDK or Zod types from `@ai-engine/mcp`.
- The SDK dependency range for `@hono/node-server` changes from `^1.19.9` to
  `^1.19.9 || ^2.0.5`. An ordinary install can now select a patched 2.x release,
  so the temporary root resolution and its incompatible-range warning are no
  longer justified.

## Decision

The approved SDK version is `@modelcontextprotocol/sdk@1.30.0`. Every manifest
that directly consumes the SDK MUST pin exactly `1.30.0`, and the repository MUST
enforce that alignment with an executable workspace test. The lockfile remains
the reproducible dependency record.

This decision supersedes ADR 0006 only for the approved SDK version, the
temporary Hono resolution, and the previously unspecified stdio input-buffer
limit. ADR 0006 remains authoritative for protocol `2025-11-25`, SDK isolation,
subpath imports, low-level tool registration, falsy request-ID adaptation, stdio
shutdown, and all other decisions not replaced here.

`ServeMcpStdioOptions` adds the neutral `maxReadBufferBytes` number. Its default
is 10,485,760 bytes, matching SDK 1.30.0. A configured value MUST be a positive
safe integer; invalid values reject before process-stream listeners are
installed. The framework passes the number into the isolated SDK transport and
does not expose the SDK's option or transport type.

The limit applies to the SDK read buffer at each append. A buffer at the exact
boundary is accepted. When an append would cross the boundary, the transport
closes, the protocol aborts active requests, the adapter removes its process
listeners, and `serveMcpStdio` rejects with a controlled error that contains no
request payload. This is an intentional compatibility change: a peer that sends
more than 10 MiB without a host override previously relied on unbounded buffering
and will now lose the connection.

The root `@hono/node-server` resolution is removed. The unforced lockfile MUST
select a release outside the affected range, the direct Node transport
compatibility test MUST pass, and the repository dependency audit MUST remain
green. As before, the repository lockfile does not control downstream consumer
installs.

The HTTP adapter keeps its own stricter boundary parsing and stateless transport
options. SDK 1.30.0's SSE defaults are not adopted as new framework behavior.
The falsy request-ID adapter is retained until a separately approved SDK version
passes the existing identity and cancellation tests without it.

## Consequences

- Stdio input memory is bounded by default and configurable without leaking SDK
  types.
- Legitimate stdio messages above 10 MiB require an explicit host decision.
- A fatal stdio read overflow settles the adapter lifetime instead of leaving a
  process waiting on an already-closed transport.
- All direct SDK consumers stay on one reviewed exact version, including examples
  added after the automated dependency pull request was opened.
- The Hono workaround and incompatible-resolution warning are removed while the
  direct transport test and audit continue to verify the dependency path.
- The protocol baseline and the single `engine.invoke` execution path do not
  change.

## Decision evidence

- [SDK 1.30.0 release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.30.0)
- [SDK 1.29.0 to 1.30.0 comparison](https://github.com/modelcontextprotocol/typescript-sdk/compare/v1.29.0...1.30.0)
- [SDK 1.30.0 protocol constants](https://github.com/modelcontextprotocol/typescript-sdk/blob/1.30.0/src/types.ts#L4-L6)
- [SDK 1.30.0 manifest](https://github.com/modelcontextprotocol/typescript-sdk/blob/1.30.0/package.json)
- [SDK stdio buffer-limit change](https://github.com/modelcontextprotocol/typescript-sdk/pull/2239)
- [SDK Hono range change](https://github.com/modelcontextprotocol/typescript-sdk/pull/2549)
- [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9)
