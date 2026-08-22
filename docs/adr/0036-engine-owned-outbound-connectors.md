# ADR 0036: Engine-owned outbound connectors through explicit ports

- Status: Accepted
- Date: 2026-08-22

## Context

Capabilities commonly need a model, database, search service, SaaS API, or
other external system to produce a domain outcome. Existing engines already put
those integrations behind engine-owned interfaces and inject their
implementations at the composition root, as required by ADR 0001. The
architecture does not, however, give those provider-specific implementations a
shared name or state the authoring boundary that keeps them replaceable.

Treating an integration as a capability would expose infrastructure instead of
a domain action. Treating it as a runtime registration would add a service
locator, lifecycle, and second execution mechanism. Leaving the convention
implicit makes it easier for provider types, credentials, retry behavior, and
ambient configuration to leak into capability contracts.

## Decision

An **outbound connector** is an engine-owned, provider- or technology-specific
implementation of one or more outbound ports owned by the custom engine. It
crosses the engine boundary to adapt an external system, API, SDK, protocol, or
data source to the domain-facing contract a capability needs. An in-memory
implementation, test double, or engine-local policy implementation may satisfy
a port but is not an outbound connector because it crosses no external-system
boundary.

The architectural path is:

```text
direct / CLI / MCP -> engine.invoke -> capability -> port -> outbound connector
                                                               |
                                                               v
                                                        external provider
```

An outbound connector is an outbound adapter in hexagonal-architecture terms.
The more specific name distinguishes it from Invokta's inbound CLI and MCP
adapters. It is not a capability, a port, or a separately invocable action.
ADR 0037 adds an optional core authoring definition without turning the
connector instance into a runtime primitive. The concept is also unrelated to
client products that use “MCP
connector” for an installed MCP server, and it is not capability composition
through `composeCapabilities`. Provider authentication performed by an outbound
connector identifies the engine to that provider; it is distinct from MCP HTTP
caller authentication, which produces the `Principal` used by `engine.invoke`.

The following composition rules apply:

- the custom engine owns the port and its domain types;
- a provider- or technology-specific connector implements one or more related
  ports and keeps provider request, response, SDK, and transport types behind
  that boundary;
- capability factories receive only the ports they use, not a connector
  registry or a provider client;
- the application composition root explicitly imports and constructs the
  connector, then injects its ports into capability factories;
- connector factories receive configuration, credentials, clients, clocks, and
  transport implementations explicitly. They do not read ambient environment
  variables or mutable global registration state;
- connector factories synchronously validate required configuration before any
  I/O. Provider endpoints must use an allowed scheme and must not embed
  credentials unless the provider protocol requires it; configured numeric
  limits must be finite safe integers within the connector's documented range;
- importing a connector and constructing it perform no outbound I/O. If a
  dependency requires asynchronous initialization, the host completes it before
  exposing the engine and injects the ready dependency;
- `createEngine`, `composeCapabilities`, `ExecutionContext`, and
  `engine.invoke` gain no connector field, registry, lookup, or alternate
  execution path.

Connector operations obey these invocation boundaries:

- every connector operation that may wait accepts the invocation's
  `AbortSignal`, whether the capability calls it from `access` or `run`. The
  capability passes the applicable context signal to the port, and the
  connector propagates it to provider calls and stops connector-owned polling
  or waits when aborted;
- a connector operation called from `access` has its own finite client or
  operation deadline. Capability `timeoutMs` starts only after authorization,
  so it does not bound connector work performed during `access`;
- a connector does not translate observed cancellation into a provider failure.
  Cancellation remains subject to the runtime's existing `CANCELLED` handling;
- provider status failures, transport failures, and malformed responses do not
  add error codes. When a connector exposes an `EngineError`, it uses a
  sanitized `EXECUTION_FAILED`; otherwise the existing invocation boundary
  normalizes the unknown failure;
- provider responses are checked and translated into port-owned domain values
  before returning. Raw provider payloads do not become capability outputs or
  public error details;
- credentials do not enter capability input or output, `ExecutionContext`,
  invocation events, logs, diagnostics, or `publicDetails`. A provider protocol
  may require credentials in an outbound URL, header, or body, but those request
  values and raw provider errors are not copied into public or diagnostic
  surfaces; any URL that is exposed there is sanitized. A retained error
  `cause` remains internal and excludes credentials and unfiltered provider
  payloads. The composition root resolves secrets and fails before serving
  traffic when required configuration is absent;
- Invokta supplies no retry policy. A connector retry is opt-in,
  cancellation-aware, and permitted only when the operation's idempotency and
  provider semantics make it safe. Each retrying connector documents and
  configures finite maximum attempts and a finite maximum delay or elapsed
  retry time; provider SDK retries count toward those same bounds;
- every capability that invokes a connector from `run` configures a finite
  `timeoutMs`. Connector or provider request timeouts may provide shorter
  per-operation deadlines but do not replace that capability bound. The
  capability timeout keeps ADR 0003's pipeline scope: it starts after
  authorization and ends after output validation;
- provider-specific response, polling, pagination, batch, and concurrency
  limits have concrete finite values in connector or capability configuration
  and contract tests. Invokta introduces no universal values for them.

The engine host owns provider-client, pool, credential-refresh, and shutdown
lifecycle. It initializes dependencies before exposing the engine. During
shutdown it stops admitting invocations, then drains or cancels in-flight work
before disposing dependencies; the choice between drain and cancellation is an
explicit host policy. This convention defines no common `start`, `stop`,
`dispose`, or `probe` interface and adds no framework lifecycle hook. A specific
engine may expose lifecycle functions at its own composition boundary when its
dependencies require them.

Invokta will not publish an official connector package or provider catalog as a
result of this decision. Reusable connector packages may exist outside the
runtime, but they implement engine- or domain-owned ports and compose through
ordinary explicit imports. ADR 0037 adds the optional `defineConnector`
authoring contract after repeated construction evidence; a shared behavioral
test kit, lifecycle contract, or provider package still requires a later
architectural decision.

## Consequences

- Capabilities remain stable domain actions when a provider or SDK changes.
- Tests can inject port doubles without credentials, network access, or
  connector initialization.
- Configuration and dependency ownership remain visible at the composition
  root, including startup and shutdown order.
- CLI and MCP continue to execute the capability through the single
  `engine.invoke` path; connectors create no provider bypass.
- The original convention added terminology without a public API; ADR 0037
  later adds an optional core authoring type without changing the error taxonomy
  or runtime pipeline.
- Engine authors must write provider translation, sanitization, cancellation,
  and operational-limit code explicitly, and large compositions may require
  more wiring.
- A connector that reads ambient configuration, exposes provider types to a
  capability, relies on framework discovery, or hides an unbounded retry or
  polling loop does not conform to this decision.
