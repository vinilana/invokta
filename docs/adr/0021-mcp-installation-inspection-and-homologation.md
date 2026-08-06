# ADR 0021: MCP installation inspection and homologation

- Status: Accepted
- Date: 2026-08-06

## Context

ADR 0020 gives an Invokta engine author a local development surface by loading
an explicitly named built engine module. That mode is deliberately tied to a
workspace composition root: it can run Doctor against the engine contract,
mint development principals, host the engine through `serveMcpHttp`, and
observe the resulting `engine.invoke` path.

Testing an installed MCP server is a different use case. A developer or release
reviewer needs to validate the same launch descriptor or Streamable HTTP URL
that an MCP client will use, including optional credentials, without importing
the server's workspace or claiming knowledge of its implementation. Requiring
an engine module prevents this use case and makes remote homologation
impossible. Importing client configuration, discovering servers, or invoking a
tool automatically would exceed the supporting-tool boundary and create unsafe
side effects.

The official MCP SDK is currently isolated inside `@invokta/mcp` for server
adapters. If devtools imports the SDK directly to act as a client, SDK types and
protocol details would cross the established package boundary.

## Decision

`@invokta/devtools` adds an MCP installation inspection and homologation mode.
Running `invokta-devtools` with no module argument, or the explicit `open`
command, starts an idle web workbench on loopback. Startup performs no workspace
load, network request, process spawn, discovery, or configuration import. The
user must explicitly connect exactly one target:

- a structured stdio descriptor containing an executable, an argument array,
  an optional working directory, and environment configuration; or
- an absolute Streamable HTTP URL with no authentication, bearer
  authentication, or explicit custom request headers.

Stdio starts the selected executable directly with `shell: false`. MCP defines
no protocol authentication for stdio; credentials are child-process
environment configuration. HTTP requires HTTPS except when the host is the
literal loopback address `127.0.0.1` or `[::1]`. URLs containing credentials,
a query, or a fragment are rejected. Redirects and TLS verification bypasses
are prohibited.

CLI credentials are read from named environment variables and are never
accepted as literal command arguments. Values entered in the interface exist
in browser memory only until a connection response arrives, then the fields are
cleared and replaced by a masked configured state; the active connection keeps
only its process-memory copy. Values are never returned by an API or written to
browser storage. Connection secrets never appear in diagnostics, activity
records, trace data, or server responses.

The attached workbench exposes only Tools, Activity, and Connection validation.
It MUST NOT expose or imply engine Doctor results, development principals,
workspace watch state, core events, or an `engine.invoke` trace. Its interface
remains a compact developer tool, uses the Invokta visual identity, and does
not use bracketed decorative labels.

`@invokta/devtools` also adds a non-interactive `verify` command. Verification
performs the MCP initialization handshake and follows `tools/list` pagination
to completion. It never calls a tool. Neither the workbench nor `verify`
automatically invokes, retries, discovers, persists, evaluates, judges, or
release-gates a target.

`@invokta/mcp` adds a plain-type client facade over the approved official SDK.
The facade owns stdio and Streamable HTTP client transports, initialization,
tool listing, manual tool calls, cancellation, and closure. Its public API uses
only Invokta-owned structural types, JSON values, and platform types; official
SDK classes and types remain private to the package.

The stdio client configures the official SDK with a conservative 10 MiB read
buffer and maps a buffer overflow to the bounded client error contract. Closing
a stdio connection delegates to the SDK's public transport close operation. The
facade does not promise a kill signal, grace period, descendant-process cleanup,
or exact operating-system process-reap timing beyond that public SDK semantic.

The attached mode permits one connected target and one explicit tool call at a
time. Initialization and complete catalog collection each have a 15-second
deadline. A manual tool call has a 60-second deadline. Each MCP message, call
response, and complete catalog is limited to 10 MiB. Catalog traversal is
limited to 100 pages and 2,000 tools, and Activity retains at most 500 metadata
records. Crossing a message, response, catalog, page, or tool limit fails
closed; equality with a byte or count limit is accepted. Activity drops its
oldest record when a new record would cross its capacity and truncates a
displayed tool name to 256 Unicode code points. The interface retains at most
128 browser sessions in process memory; creating another evicts the
oldest-created session that does not own the active target. There is no
automatic retry.

Connection-mutating browser requests require the exact loopback `Host`, the
exact interface `Origin`, and a process-memory CSRF token bound to the browser
session. The interface emits a restrictive Content Security Policy and no CORS
headers. HTTP credentials and stdio environment values are never persisted,
echoed, or included in activity data.

The existing commands remain compatible:

- `doctor <module>` and `serve <module>` keep their ADR 0020 behavior,
  diagnostics, and exit codes;
- the explicit module requirement continues to apply to those commands; and
- `serve` remains the only mode that claims Invokta engine internals and the
  single `engine.invoke` execution path.

Changing bare `invokta-devtools` from invalid usage to the idle workbench is an
intentional command-line behavior change. It requires release notes, but no
existing valid invocation changes meaning.

Normative behavior is specified in the
[MCP installation inspection and homologation specification](../specs/mcp-installation-inspection-and-homologation.md).

## Consequences

- A developer can inspect a local installed stdio server or an installed HTTP
  endpoint without an Invokta workspace or engine module.
- CI and homologation environments can run a read-only protocol verification
  that cannot trigger a domain action.
- The MCP SDK remains isolated behind `@invokta/mcp`, while that package's
  charter expands from server adapters to a bounded client facade.
- The devtools gains process-spawn and outbound-network authority only after an
  explicit connection or `verify` request. Idle startup remains inert.
- Installed-target inspection validates launch, authentication, protocol
  initialization, and the advertised tool catalog. It does not prove that a
  separate MCP client's configuration file contains the descriptor.
- Adding persistence, target discovery, configuration import, multiple targets,
  OAuth, resources, prompts, automatic calls, evals, or release gating requires
  another architectural decision.
