# ADR 0037: Typed connector definitions with explicit port injection

- Status: Accepted
- Date: 2026-08-22

## Context

ADR 0036 established outbound connectors as engine-owned implementations of
domain ports and deliberately deferred a shared connector API. The crawl,
image, observability, Obsidian, and agent-session engines now demonstrate the
same construction boundary across network and filesystem integrations:
configuration is validated before I/O, transports and clients are injected,
and one connector may provide ports used by several capabilities.

Ordinary TypeScript factories preserve that architecture, but they do not give
authors a standard way to infer validated configuration, separate deployment
configuration from opaque clients, or expose a stable named-port result. A
runtime registry would solve a different problem and would make capability
dependencies implicit.

## Decision

`@invokta/core` exports the optional `defineConnector` authoring helper and its
plain TypeScript contracts. A connector definition contains:

- a non-empty internal `name`;
- a Standard Schema v1 `config` contract;
- a synchronous `create` callback that receives validated configuration and an
  explicitly typed, opaque dependency value; and
- a result with one or more named engine-owned `ports`.

`defineConnector` captures the definition fields and the Standard Schema
validator exactly once. Defining a connector does not validate configuration,
call the factory, perform I/O, register a value, or change an engine.

The returned connector factory exposes `name` and synchronous `create`. Creation
validates and transforms the supplied configuration before calling the connector
callback. Configuration validation must be synchronous and its successful output
must be a lossless JSON object. The core snapshots and freezes that output before
passing it to the callback. Configuration does not require Standard JSON Schema
because it is private construction data and is never described through an
engine or adapter.

Invalid configuration always throws `TypeError` with the message
`Connector configuration is invalid.` without retaining validator issues,
causes, or rejected values. An asynchronous validator throws `TypeError` with
`Connector configuration validation must be synchronous.` The public core
reference defines the remaining deterministic definition and result errors.
Exceptions thrown by the connector callback after successful configuration
validation are preserved.

Opaque dependencies such as `fetch`, SDK clients, clocks, and pools are passed
to the callback unchanged. They are not configuration, are not copied or
validated by Invokta, and remain owned by the composition root. The callback
returns a connector instance containing a non-empty named ports record. The
core shallow-copies and freezes the instance and ports container while
preserving each port implementation by identity. It does not freeze, wrap,
invoke, inspect, or publish port values.

Capabilities continue to receive only the narrow ports they use through their
factories or closures. `createEngine` receives only the resulting capability
map. Connector names, configuration, dependencies, and instances do not enter
capability input or output, `ExecutionContext`, engine descriptions, events,
CLI, MCP, or `engine.invoke`.

The API creates no connector registry, service locator, discovery mechanism,
automatic wiring, provider catalog, alternate invocation path, retry policy,
or lifecycle management. Connector creation is synchronous and I/O-free;
hosts initialize asynchronous dependencies separately and inject the ready
value. Existing connector factories remain valid and require no migration.

## Consequences

- Engine authors gain one typed construction pattern without coupling
  capabilities to providers or the core runtime.
- Configuration transformations and failures become deterministic before
  connector-specific construction begins.
- One connector definition may provide several cohesive ports while each
  capability still receives only the port it needs.
- Connector configuration stays private and secret-safe because it has no JSON
  Schema description, engine metadata, or adapter mapping.
- Behavioral guarantees such as no construction I/O, cancellation propagation,
  response translation, finite limits, and failure sanitization still require
  connector contract tests; `defineConnector` cannot prove them structurally.
- The core public API and documented primitive inventory expand additively, but
  the invocation pipeline, capability contract, error taxonomy, package count,
  and inbound adapters do not change.
