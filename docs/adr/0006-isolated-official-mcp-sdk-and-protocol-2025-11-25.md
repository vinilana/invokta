# ADR 0006: Isolated official MCP SDK and protocol `2025-11-25`

- Status: Accepted
- Date: 2026-07-27

## Context

Supporting the Model Context Protocol requires precise interoperability, but the
SDK is a transport dependency subject to evolution independently of the kernel.
Pinning a version number without verifying compatibility with the adopted
protocol revision would create a false guarantee.

## Decision

`@ai-engine/mcp` will implement the integration with the official MCP SDK. The
SDK's imports, concrete types, transport objects, and lifecycle details will be
confined to `packages/mcp`; none of them will be part of the public API or types
of `@ai-engine/core`.

The adapter's normative protocol revision will be the exact string `2025-11-25`.
The handshake, capabilities, messages, and conformance tests must be compatible
with this revision. It is the current compatibility baseline, not an instruction
to reject older revisions that the pinned SDK can negotiate correctly.
Translations between MCP and the engine model will occur at the boundary, and
every tool execution will converge on `invoke`.

That revision permits one JSON-RPC message per HTTP POST and does not permit
JSON-RPC batches. The adapter therefore rejects every top-level JSON array before
SDK dispatch, including empty and single-element arrays. It also parses media
negotiation at the boundary rather than relying on substring checks: `Accept`
must list the exact JSON and event-stream media types with positive quality, and
`Content-Type` must identify the exact JSON media type. The adapter passes the
single parsed message to the SDK so the body is not parsed twice.

The approved version is `@modelcontextprotocol/sdk@1.29.0`, pinned exactly in the
manifest and lockfile, without `^`, `~`, or the `latest` tag. Version 1.29.0
declares `2025-11-25` as the latest supported protocol. The v2 packages remain in
beta as of the date of this decision and will not be used in framework version
0.1.

As an additional defense, the integration will not import the root entry point
affected by the known packaging issue in version 1.29.0; it will use only the
documented subpaths covered by smoke tests. An SDK update must reverify the
protocol, exports, runtime, release notes, and security fixes.

The adapter will use the SDK's low-level `Server` API for tool registration. This
is deliberate: the high-level `McpServer` API accepts schema-library shapes and
normalizes them, while engine capabilities already expose their authoritative
Standard JSON Schemas. The low-level handler keeps those input and output schemas
unchanged at the transport boundary. This SDK choice remains internal to the MCP
package and may change without changing its public API.

No complete in-house protocol implementation will be maintained in parallel with
the official SDK; local code will be limited to adaptation, isolation, and tests.

## Consequences

- SDK updates or breaking changes remain contained within the MCP package.
- The core remains usable without installing the SDK.
- The protocol revision can be tested as an explicit contract.
- The lockfile and integration tests make the revision reproducible.
- Updating the SDK will require repeating the compatibility research and running
  the conformance tests.

## Decision evidence

- [SDK 1.29.0 protocol constants](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/types.ts#L4-L6)
- [SDK 1.29.0 manifest](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/package.json)
- [MCP specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [Known root entry point issue](https://github.com/modelcontextprotocol/typescript-sdk/issues/971)
