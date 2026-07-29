# ADR 0006: Isolated official MCP SDK and protocol `2025-11-25`

- Status: Accepted
- Date: 2026-07-27

## Context

MCP interoperability requires an official protocol implementation, but SDK
types, lifecycle behavior, and release cadence must not become framework-core
contracts.

## Decision

`@invokta/mcp` uses the official MCP TypeScript SDK, pinned exactly to the
version declared in its package manifest and lockfile. The current approved
version is `1.30.0`, and the compatibility baseline is protocol `2025-11-25`.
Every SDK update requires review of protocol support, exported subpaths,
release notes, security fixes, and the full MCP conformance suite.

SDK imports, concrete types, transports, and lifecycle details remain private to
`@invokta/mcp`. The adapter uses documented subpath imports and the low-level
`Server` API so capability Standard JSON Schemas remain authoritative. Every
tool execution converges on `engine.invoke`; no in-house protocol implementation
is maintained in parallel.

The HTTP boundary accepts one JSON-RPC message per POST and rejects batches.
It validates exact media types, bounded strict UTF-8 input, and the parsed
message before SDK dispatch. The stateless HTTP profile does not adopt SDK
sessions, resumption, event storage, or server-to-client SSE behavior.

Valid request IDs `0` and `""` receive private transport identities while the
SDK processes cancellation, then are restored before reaching the wire. This
adapter remains until an approved SDK version passes the existing identity and
cancellation tests without it.

Stdio reads are bounded by `ServeMcpStdioOptions.maxReadBufferBytes`, defaulting
to 10,485,760 bytes. The value must be a positive safe integer. Crossing the
limit closes the transport, aborts active requests, removes process listeners,
and rejects without exposing request payloads.

POSIX pipe teardown settles pending asynchronous writes. On Windows, pipe writes
may block synchronously when a peer does not read stdout, so the host must drain
stdout continuously and supervise the process.

## Consequences

- The core remains usable without the SDK.
- SDK changes stay isolated behind neutral adapter types and executable
  compatibility tests.
- Stdio input memory is bounded by default; larger messages require an explicit
  host decision.
- Protocol and operating-system constraints remain visible without becoming
  domain contracts.

## Decision evidence

- [MCP specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [SDK 1.30.0 release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.30.0)
- [SDK stdio buffer limit](https://github.com/modelcontextprotocol/typescript-sdk/pull/2239)
- [Node process I/O behavior](https://nodejs.org/api/process.html#a-note-on-process-io)
