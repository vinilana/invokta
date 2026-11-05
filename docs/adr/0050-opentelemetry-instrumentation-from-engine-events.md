# ADR 0050: OpenTelemetry instrumentation from engine events

- Status: Accepted
- Date: 2026-11-05

## Context

ADR 0003 makes `onEvent` the only cross-cutting hook. It delivers
`invocation.started` and exactly one `invocation.completed` or
`invocation.failed` event per invocation, synchronously, best-effort, and
without business payloads or credentials. Connecting those events to logs,
metrics, or tracing is left to each custom engine.

Every engine that wants OpenTelemetry writes the same translation: correlate the
start and terminal events by request ID, convert the ISO start time and the
measured duration into span timestamps, map the error code to span status, keep
pending spans bounded, and keep metric attributes low-cardinality. The scope
document names an observability package as an evolution trigger once
engine-local implementations converge, and the maintainer approved this
extraction on the roadmap. OpenTelemetry is the vendor-neutral instrumentation
standard, so one package can serve every backend.

The constraints are the existing ones: the core must not depend on
OpenTelemetry (AE-ARCH-01, ADR 0004), the event payload stays minimal, a
principal ID may be personal data, event delivery is not awaited, and the error
code set may grow through other decisions.

## Decision

### Package and dependency

Invokta publishes `@invokta/otel` as a runtime instrumentation package. It
depends on `@invokta/core` for the `EngineEvent` type only and on
`@opentelemetry/api` as a **peer dependency** with the caret range `^1.9.0`.

The OpenTelemetry API is a process-wide singleton: the tracer provider, meter
provider, context manager, and diagnostic logger are registered globally and
checked for version compatibility. A private copy can fail that check against
the host's registered SDK and silently become no-op, or read a different
context manager and lose the caller's trace. The OpenTelemetry JavaScript
instrumentation guidelines therefore direct instrumentation to declare the API
as a peer with its minimum supported version as a caret range. An exact peer pin would force a
duplicate API or an install conflict for hosts on another 1.x release,
including API 1.10 required by SDK 3.x.

The repository still pins what it builds and tests against: the API at `1.9.1`,
and the reference SDK packages `@opentelemetry/sdk-trace`,
`@opentelemetry/sdk-metrics`, and `@opentelemetry/context-async-hooks` at
`2.12.0`, are exact `devDependencies` locked in `yarn.lock`. The SDK appears
only in tests so the package is verified against the reference implementation
of time inputs, status, histogram advice, and context propagation rather than
against a hand-written double. The range floor `1.9.0` is the API line those
tests exercise and the one every SDK 2.x release accepts.

The package bundles or registers no SDK, exporter, sampler, resource detector,
or context manager. The host owns its SDK. The core and every other package
gain no OpenTelemetry dependency.

### Public API

```ts
function createOpenTelemetryEventHandler(
  options?: OpenTelemetryEventHandlerOptions,
): OpenTelemetryEventHandler;

interface OpenTelemetryEventHandler {
  (event: EngineEvent): void;
  readonly contextFor: (requestId: string) => Context;
}
```

| Option | Default | Contract |
| --- | --- | --- |
| `tracer` | Global tracer for `@invokta/otel` | An OpenTelemetry `Tracer` |
| `meter` | Global meter for `@invokta/otel` | An OpenTelemetry `Meter` |
| `recordPrincipalId` | `false` | Boolean opt-in for `invokta.principal.id` |
| `maxPendingSpans` | `10000` | Positive safe integer |
| `maxMetricAttributeValues` | `256` | Positive safe integer |

Options are read once and validated synchronously; an invalid value throws
`TypeError`. The default tracer comes from the API's proxy provider and follows
an SDK registered later. The metrics API has no proxy, so the default meter is
re-resolved whenever the global meter provider changes; a handler created at
module scope before the SDK starts still records metrics afterwards.

The handler is a frozen function that never throws and returns `undefined`. No
composition helper is added: an engine with an existing hook writes
`onEvent(event) { otel(event); return existing(event); }`. Calling the
OpenTelemetry handler first guarantees it sees every event, and returning the
existing hook's result keeps the engine's rejection diagnostic.

### Traces

The handler starts one span on `invocation.started` and ends it on the terminal
event with the same `requestId`.

- **Timing:** the start time is `Date.parse(startedAt)` and the end time is that
  start plus `durationMs`, so the span duration equals the event duration.
- **Parent:** the span starts in the active OpenTelemetry context. Because the
  engine emits the started event synchronously inside `invoke`, the span joins
  the caller's trace, such as an instrumented HTTP server request.
- **Kind:** `INTERNAL`. The hook runs inside the process and has no transport or
  peer data; transport instrumentation owns `SERVER` and `CLIENT` spans.
- **Name:** `invoke {capabilityId}`. A `CAPABILITY_NOT_FOUND` failure renames the
  span to `invoke` because that ID is chosen by the caller.
- **Status:** unset on completion, following OpenTelemetry guidance for
  instrumentation libraries; `ERROR` with the error code as its description on
  failure.

| Attribute | Set on | Value |
| --- | --- | --- |
| `invokta.capability.id` | Start | Requested capability ID |
| `invokta.execution.source` | Start | `direct`, `cli`, `mcp-stdio`, `mcp-http`, or a later source |
| `invokta.request.id` | Start | Invocation request ID |
| `invokta.principal.id` | Start, only with `recordPrincipalId: true` | Principal ID |
| `invokta.invocation.outcome` | End | `completed` or `failed` |
| `invokta.error.code` | Failure | Opaque error code |
| `error.type` | Failure | Same value, for OpenTelemetry error conventions |
| `invokta.span.evicted` | Eviction | `true` |

Spans carry no input, output, message, exception event, or credential, because
the events carry none.

### Metrics

| Instrument | Kind | Unit | Attributes |
| --- | --- | --- | --- |
| `invokta.invocations` | Counter | `{invocation}` | capability, source, outcome, and on failure error code and `error.type` |
| `invokta.invocation.duration` | Histogram | `s` | Same as `invokta.invocations` |
| `invokta.invocation.failures` | Counter | `{failure}` | capability, source, error code, and `error.type` |

Metrics are recorded from terminal events, so a started invocation that never
terminates adds no data point. The failures counter equals the failed
`invokta.invocations` points; it exists so alerts on error codes need no outcome
filter. The duration histogram advises the OpenTelemetry HTTP boundaries
extended for long-running work: 0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5,
0.75, 1, 2.5, 5, 7.5, 10, 30, 60, 120, and 300 seconds. An SDK view may override
them.

Metric attributes are bounded:

- a `CAPABILITY_NOT_FOUND` failure records the capability as `_OTHER`;
- each attribute admits at most `maxMetricAttributeValues` distinct values in
  first-seen order, and later new values become `_OTHER`;
- a non-string, empty, or longer-than-256-character value becomes `_OTHER`;
- request and principal IDs never appear on metrics; and
- the source is omitted when the start of the invocation was not observed.

### Robustness

Pending spans live in an insertion-ordered map capped by `maxPendingSpans`.
Reaching the cap evicts the oldest pending span: it ends immediately with
`invokta.span.evicted = true`, unset status, and no outcome. A started event
that reuses a pending request ID evicts the earlier span the same way. A
terminal event without a pending span records metrics but no span. The handler
uses no timer.

The error code is an opaque string, so codes added by later decisions are
recorded without a release of this package. Unknown event types are ignored.
Each event is processed inside its own failure boundary; a failing meter does
not prevent the span from ending, and a failure is reported only as a
payload-free OpenTelemetry `diag` warning.

### Context propagation

The invocation span is not the active context inside `access` or `run`. The
engine ignores the hook's return value and has no execution-wrapping hook, so a
span a capability starts from the ambient context becomes a sibling of the
invocation span under the caller's span.

`contextFor(requestId)` is the supported workaround. It returns the active
context with the pending invocation span set, or the active context unchanged
when that invocation has no pending span. The composition root injects it into
the capabilities that need nested spans, and they run their work inside
`context.with(contextFor(context.requestId), ...)`. Tracing therefore remains an
explicit engine dependency, consistent with ADR 0001 and AE-CTX-01, and the core
does not change.

Automatic propagation would require the core to run `access` and `run` inside a
host-supplied context wrapper: a second cross-cutting hook that changes
AE-OBS-01 and the one-hook limit. This decision does not need that change.
Revisit it only when several engines need nesting that an injected
`contextFor` cannot provide.

## Consequences

- Engines get spans and RED metrics from one `onEvent` assignment and keep
  their own SDK, exporter, sampling, and backend.
- The package is instrumentation, not an observability platform: there is no
  SDK, exporter, collector, log signal, dashboard, alert, or storage.
- The public attribute and metric names above are a stable contract of this
  package; changing one requires a new decision.
- Hosts must provide `@opentelemetry/api` 1.9 or a later 1.x release.
- A capability's own spans nest under the invocation span only when the
  capability uses the injected `contextFor`.
- Memory for pending spans and metric attribute values is bounded by explicit,
  configurable limits; extreme concurrency above the cap shortens evicted spans
  instead of growing memory.

## Decision evidence

- [OpenTelemetry JS contrib instrumentation guidelines: API as a peer dependency](https://github.com/open-telemetry/opentelemetry-js-contrib/blob/main/GUIDELINES.md#opentelemetry-api)
- [OpenTelemetry trace API: span status](https://opentelemetry.io/docs/specs/otel/trace/api/#set-status)
- [Semantic conventions: recording errors and `error.type`](https://opentelemetry.io/docs/specs/semconv/general/recording-errors/)
- [Semantic conventions: metric naming and units](https://opentelemetry.io/docs/specs/semconv/general/naming/)
- [Semantic conventions: HTTP metrics duration boundaries](https://opentelemetry.io/docs/specs/semconv/http/http-metrics/)
