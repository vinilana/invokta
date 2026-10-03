# ADR 0042: OpenTelemetry adapter over the engine event hook

- Status: Accepted
- Date: 2026-10-03

## Context

ADR 0003 gives the core one cross-cutting hook, `onEvent`, and states that a
custom engine may connect it to logs, metrics, or tracing. The scope matrix
leaves the observability platform outside Invokta. Engines that publish through
MCP HTTP or the CLI now need their invocations to appear in the observability
platform the operator already runs, such as Datadog, Grafana, Honeycomb, New
Relic, Sentry, or an OpenTelemetry Collector, without each engine rewriting the
same mapping from engine events to spans and metrics.

OpenTelemetry is the vendor-neutral standard those platforms ingest. A
backend-neutral mapping from `EngineEvent` to OpenTelemetry signals is therefore
the repeated integration, while exporters, sampling, resources, and the choice
of destination remain deployment decisions.

## Decision

Invokta publishes `@invokta/opentelemetry`, an optional runtime-side adapter
package whose only export is `createOpenTelemetryEventHook`. It returns a value
assignable to the engine definition's `onEvent`.

The package is an event consumer, not a second execution path. It depends on
`@invokta/core` only for the `EngineEvent` type and on the OpenTelemetry API.
`@opentelemetry/api` is a peer dependency so the application and the adapter
share one API instance; the adapter depends on no OpenTelemetry SDK, exporter,
or vendor package. The core, CLI, and MCP packages do not depend on it and do
not change.

For each invocation the hook produces:

- one `INTERNAL` span named `invokta.invoke <capabilityId>`, started at the
  event's `startedAt` and ended at `startedAt + durationMs`, with the attributes
  `invokta.capability.id`, `invokta.request.id`, and
  `invokta.invocation.source`;
- on `invocation.failed`, the attribute `error.type` set to the stable
  `EngineErrorCode` and an `ERROR` span status whose message is the same code;
  a completed invocation leaves the status unset;
- an `invokta.invocation.duration` histogram in seconds with the capability,
  source, and, on failure, `error.type` attributes; and
- an `invokta.invocation.active` up-down counter for in-flight invocations,
  attributed by source only.

The span is parented to the OpenTelemetry context that is active when the
engine emits `invocation.started`. Because the engine invokes the hook
synchronously inside `engine.invoke`, a span that the caller made active around
the call, for example by a host's own instrumentation or `context.with`, becomes
the invocation's parent. This ADR does not promise that an adapter preserves an
inbound request's context up to that call; the contract tests cover only the
direct case.

The adapter preserves ADR 0003's payload-free guarantee. It reads only event
fields, so capability input, output, credentials, and error messages never reach
telemetry. The principal ID can identify a person, so it is exported as
`enduser.id` only when the caller passes `includePrincipalId: true`. Request IDs
are span attributes only and never metric attributes.

Metric cardinality is bounded by the capability and source sets. The engine
reports the caller-supplied ID when a capability does not exist, so the adapter
replaces it with `_OTHER` in the span name, the span attribute, and the duration
histogram once the invocation fails with `CAPABILITY_NOT_FOUND`. The in-flight
counter omits the capability ID because it must be attributed before the engine
resolves the capability. Both instruments therefore stay bounded even when an
untrusted client sends arbitrary capability IDs. Both tracer and meter report
the package version as their instrumentation scope version.

Tracer and meter providers default to the OpenTelemetry globals and can be
injected for tests or for hosts that scope providers per engine.

The hook correlates terminal events to started events by request ID and
capability ID in a map that holds only in-flight invocations. The engine emits
exactly one terminal event per started event, so the map does not grow without
bound. Request IDs may be caller supplied, so one ID can have several open
invocations. A terminal event without a started event is ignored.

## Limits

- The span is not made active while `run` executes, because the core exposes no
  wrapper around execution (ADR 0003 permits no before or after hooks).
  Instrumentation inside a capability, such as an HTTP client, therefore parents
  to the caller's span rather than to the invocation span. Closing this gap needs
  a core extension and its own decision.
- Delivery is best-effort, matching the hook contract. The adapter adds no
  buffering, retry, or backpressure; the OpenTelemetry SDK owns export behavior.
- The adapter does not read `traceparent` from MCP HTTP requests. Inbound
  propagation through the MCP HTTP adapter is not part of this contract.
- Combining this hook with another `onEvent` consumer is the engine author's
  composition, for example by calling both from one function.

## Consequences

- Operators connect an engine to any OpenTelemetry-compatible platform by
  registering an OpenTelemetry SDK and exporter in the host process and passing
  one hook to `createEngine`.
- The package list grows from ten to eleven published packages, and the new
  package joins the release package set and release verification.
- The span and metric names, attribute keys, and the `includePrincipalId` default
  become public contract and require contract tests.
- Further attributes, such as GenAI or MCP semantic conventions, can be added
  without changing the core.
