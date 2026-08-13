# ADR 0026: Adapter emulation in the engine devtools

- Status: Accepted
- Date: 2026-08-13

## Context

ADR 0021 gave the devtools one execution boundary: `serve` hosts the loaded
engine with the unmodified `serveMcpHttp` adapter and the interface invokes
capabilities by proxying `POST /mcp`. Every playground invocation therefore
reaches `engine.invoke` with source `mcp-http`, and no other source is
reachable from the development surface.

An engine publishes the same capability through four execution paths: a direct
call, the CLI adapter, MCP stdio, and MCP Streamable HTTP. The paths differ in
exactly the places where an engine breaks in practice — how the principal is
established, how input is decoded, how a structured error reaches the caller,
and what the caller finally observes. A development surface bound to one
adapter can confirm none of that, so authors fall back to hand-run terminal
commands and hand-framed JSON-RPC to check the other three.

Emulating those paths in process is not possible without weakening the
contracts they exist to prove. `serveMcpStdio` owns the process standard
streams by construction, `runCli` reports its outcome through an exit code and
the process streams, and both fix their principal when the process starts. A
faithful emulation must therefore run a real process, and in watch mode the
loaded engine already lives in a child the parent never imports.

## Decision

The devtools workspace mode emulates a capability call through a caller-selected
adapter. The selectable set is exactly the four `ExecutionSource` values already
defined by the core: `direct`, `cli`, `mcp-stdio`, and `mcp-http`. This decision
extends ADR 0021 and changes neither the source union, the event surface, nor
the single `engine.invoke` execution path.

Each emulation performs a real call through the published adapter:

- `mcp-http` sends one `tools/call` request to the running engine host, which
  remains the unmodified `serveMcpHttp` adapter bound to loopback.
- `mcp-stdio`, `cli`, and `direct` each run in a devtools-owned child process
  that imports the same explicitly named built module the developer passed to
  `serve` and calls `serveMcpStdio`, `runCli`, or `engine.invoke` respectively.
  The devtools speaks to the stdio child with the public `@invokta/mcp` client
  facade.

A child process is spawned per invocation and exits when that invocation
settles. The devtools keeps no adapter session, no warm child, and no state
between calls. This extends the bounded process-spawning surface granted by
ADR 0021 — previously the engine host child and the developer's build command —
and it applies unchanged in watch mode, because the child imports the module by
path rather than borrowing the parent's loaded engine.

The devtools depends on `@invokta/cli` for the CLI child, adding the dependency
edge `devtools → cli` to the package graph. The devtools now depends on the
public API of all three runtime packages and on no supporting package, and no
runtime package depends on it. The published package count is unchanged.

The principal reaches each adapter the way that adapter defines it. `mcp-http`
authenticates per request against the devtools principal store with a minted
opaque bearer token. The three child adapters receive the selected development
principal when the process starts, exactly as a composition root supplies it.
The devtools introduces no third authentication mode and no adapter-specific
identity concept.

The interface normalizes every emulation into one outcome — a result, a
capability error, or an adapter error — with the elapsed time and an
adapter-specific record of what was actually exchanged: the request and
response bodies with the HTTP status, the JSON-RPC frames with the child's
diagnostics, or the argument vector with the standard streams and the exit
code. Adapter exchanges are recorded in the existing bounded in-memory trace
buffer, which remains session-scoped, unexported, and never written to disk.

The prohibitions of ADR 0021 continue to bind. The devtools MUST NOT add an
`ExecutionContext.source` value, a second cross-cutting hook, or an event; MUST
NOT persist, aggregate, or export invocation data; MUST NOT discover engines,
scan directories, or read configuration to locate a module; MUST NOT bind a
non-loopback interface; MUST NOT write to the developer's project. It
additionally MUST NOT keep an adapter process alive between invocations, MUST
bound the number of concurrent emulations, and MUST NOT reimplement an adapter:
an emulation that cannot run the published adapter is not offered.

## Consequences

- One set of arguments can be executed through every path an engine publishes,
  and a divergence between them becomes visible in the surface that provokes it.
- A capability error reaches the interface with the same code from all four
  paths, which is the observable form of the single execution path.
- Emulated calls pay process startup — roughly a few hundred milliseconds — in
  exchange for real exit codes, real standard streams, and real protocol frames.
- The MCP HTTP adapter is no longer the devtools' only execution boundary, so
  the CLI adapter contract now also constrains it.
- Keeping an adapter session alive across calls, emulating an adapter the
  framework does not publish, or replaying recorded exchanges each require
  another architectural decision.
