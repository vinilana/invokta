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
after authentication exactly one raw `Content-Type` header must identify the
exact JSON media type. A missing, duplicated, or invalid `Content-Type` returns
HTTP 415. The adapter passes the single parsed message to the SDK so the body is
not parsed twice.

Before JSON parsing, the adapter decodes the bounded request stream as strict
UTF-8. Incomplete, overlong, and invalid-continuation sequences are rejected with
a sanitized HTTP 400 JSON-RPC parse error before SDK dispatch. Decoding remains
incremental so a valid multibyte sequence may cross transport chunks without
requiring a second byte buffer.

The approved version is `@modelcontextprotocol/sdk@1.29.0`, pinned exactly in the
manifest and lockfile, without `^`, `~`, or the `latest` tag. Version 1.29.0
declares `2025-11-25` as the latest supported protocol. The v2 packages remain in
beta as of the date of this decision and will not be used in framework version
0.1.

As an additional defense, the integration will not import the root entry point
affected by the known packaging issue in version 1.29.0; it will use only the
documented subpaths covered by smoke tests. An SDK update must reverify the
protocol, exports, runtime, release notes, and security fixes.

The root Yarn workspace resolves `@hono/node-server` to exactly `2.0.12` as a
temporary supply-chain audit workaround for GHSA-frvp-7c67-39w9. On Windows, the
optional `serve-static` entry point can interpret an encoded backslash as a path
separator and bypass prefix-mounted middleware within the configured static
root. The framework does not import `serve-static`, and its HTTP adapter uses the
SDK's Web Standard transport, so that vulnerable static-file path is not
reachable through framework code.

As verified on 2026-07-27, the Hono repository advisory records two affected
ranges: versions before `1.19.15`, and 2.x versions before `2.0.5`. It identifies
`1.19.15` and `2.0.5` as the respective patches. The aggregated GitHub/npm data
consumed by Yarn instead reports every version before `2.0.5` as affected, so it
still flags the SDK-compatible, maintainer-patched `1.19.17` release. The exact
`2.0.12` resolution keeps the install on an unaffected release and makes the
repository audit deterministic despite that stale aggregate range; it is not the
security patch for the previous lockfile.

The package is nevertheless a real SDK runtime dependency. The SDK's Node
Streamable HTTP transport imports `getRequestListener` from
`@hono/node-server`, so the repository keeps a direct initialization-request
compatibility check for that transport in addition to the framework adapter
tests. This is not a complete MCP lifecycle test. Version `2.0.12` requires
Node.js 20 or newer, which is within this project's Node.js `>=22.20.0`
contract.

SDK 1.29.0 declares the incompatible range `^1.19.9`. Yarn therefore emits an
expected incompatible-resolution warning when applying the exact 2.x
resolution. Upstream issue #2531 tracks the range mismatch; its statement that no
patched 1.x release existed described the state when it was filed but became
obsolete after the patched 1.x publication. The warning is accepted only while
the full transport suite and repository dependency audit remain green.

Root Yarn resolutions are not included in a published package's dependency
contract. A downstream consumer of `@ai-engine/mcp` does not inherit this
control and must evaluate its own lockfile and advisory data. In particular, this
repository's zero-audit result is not a guarantee about a consumer's install.
The resolution must be removed when an unforced install using the approved SDK
passes the repository dependency audit and either resolves an unaffected
`@hono/node-server` release or no longer installs that dependency. Removal
requires repeating the SDK compatibility research, transport tests, and
dependency audit.

The adapter will use the SDK's low-level `Server` API for tool registration. This
is deliberate: the high-level `McpServer` API accepts schema-library shapes and
normalizes them, while engine capabilities already expose their authoritative
Standard JSON Schemas. The low-level handler keeps those input and output schemas
unchanged at the transport boundary. This SDK choice remains internal to the MCP
package and may change without changing its public API.

SDK 1.29.0 treats the valid request IDs `0` and `""` as absent when processing a
cancellation notification. The MCP package will contain this version-specific
defect at its transport boundary: those two IDs receive private in-memory
identities while the SDK processes the request and are restored before any
message reaches the wire. Other IDs pass through unchanged. This normalization
uses the SDK's transport interface, remains internal, and must be removed when an
approved SDK version handles all valid request IDs directly.

No complete in-house protocol implementation will be maintained in parallel with
the official SDK; local code will be limited to adaptation, isolation, and tests.

## Consequences

- SDK updates or breaking changes remain contained within the MCP package.
- The core remains usable without installing the SDK.
- The protocol revision can be tested as an explicit contract.
- The lockfile and integration tests make the revision reproducible.
- Updating the SDK will require repeating the compatibility research and running
  the conformance tests.
- The repository audit gate avoids the stale Hono false positive while the
  aggregate advisory range remains unresolved, without overstating protection
  for package consumers.

## Decision evidence

- [SDK 1.29.0 protocol constants](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/types.ts#L4-L6)
- [SDK 1.29.0 manifest](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/package.json)
- [MCP specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [Known root entry point issue](https://github.com/modelcontextprotocol/typescript-sdk/issues/971)
- [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9)
- [Hono maintainer advisory](https://github.com/honojs/node-server/security/advisories/GHSA-frvp-7c67-39w9)
- [Upstream SDK range issue #2531](https://github.com/modelcontextprotocol/typescript-sdk/issues/2531)
- [`@hono/node-server` 2.0.12 manifest](https://github.com/honojs/node-server/blob/v2.0.12/package.json)
