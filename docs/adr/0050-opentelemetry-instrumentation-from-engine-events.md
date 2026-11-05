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

Invokta publishes `@invokta/otel` as an optional runtime helper package, like
`@invokta/auth-jwt` (ADR 0049): engines opt in, and no framework runtime package
depends on it. It depends on `@invokta/core` for the `EngineEvent` type only and
on `@opentelemetry/api` as a **peer dependency** with the caret range `^1.9.0`.
Its source imports only those two packages and loads no Node.js built-in, and
the OpenTelemetry API loads none either, so the package root runs wherever the
API runs. Its tests run on Node.js only.

The OpenTelemetry API is a process-wide singleton: the tracer provider, meter
provider, context manager, and diagnostic logger are registered globally and
checked for version compatibility. A private copy can fail that check against
the host's registered SDK and silently become no-op, or read a different
context manager and lose the caller's trace. The OpenTelemetry JavaScript
instrumentation guidelines therefore direct instrumentation to declare the API
as a peer with its minimum supported version as a caret range. An exact peer
pin would force a duplicate API or an install conflict for hosts on another 1.x
release, including API 1.10 required by SDK 3.x.

This range is a deliberate exception to the repository convention of pinning
every dependency exactly. It applies only to this peer, because the host and
not the package owns the API instance. Every dependency the package installs,
`@invokta/core` included, stays exactly pinned.

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
`TypeError`. Without a configured tracer, the global tracer is resolved for each
span. The metrics API has no proxy, so the default meter is re-resolved whenever
the global meter provider changes. A handler created at module scope before the
SDK starts, or kept while a test suite replaces the global providers, therefore
reports to the current providers.

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
  span to `invoke` because that ID is chosen by the caller. A capability ID
  longer than 256 characters names the span `invoke` from the start.
- **Status:** unset on completion, following OpenTelemetry guidance for
  instrumentation libraries; `ERROR` with the error code as its description on
  failure.

| Attribute | Set on | Value |
| --- | --- | --- |
| `invokta.capability.id` | Start | Requested capability ID |
| `invokta.execution.source` | Start | `direct`, `cli`, `mcp-stdio`, `mcp-http`, `http`, or a later source |
| `invokta.request.id` | Start | Invocation request ID |
| `invokta.principal.id` | Start, only with `recordPrincipalId: true` | Principal ID |
| `invokta.invocation.outcome` | End | `completed` or `failed` |
| `invokta.error.code` | Failure | Opaque error code |
| `error.type` | Failure | Same value, for OpenTelemetry error conventions |
| `invokta.error.domain_code` | `DOMAIN_ERROR` failure | Declared domain code |
| `invokta.span.evicted` | Early end: eviction or a reused request ID | `true` |

A string attribute value longer than 256 characters is recorded as `_OTHER`
when the span starts, because capability, request, and principal IDs and the
source can be chosen by a caller. Spans carry no input, output, message,
exception event, or credential, because the events carry none.

### Metrics

| Instrument | Kind | Unit | Attributes |
| --- | --- | --- | --- |
| `invokta.invocations` | Counter | `{invocation}` | capability, source, outcome, and on failure error code and `error.type` |
| `invokta.invocation.duration` | Histogram | `s` | Same as `invokta.invocations` |
| `invokta.invocation.failures` | Counter | `{failure}` | capability, source, error code, `error.type`, and the domain code of a `DOMAIN_ERROR` |

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
- the source is omitted when the start of the invocation was not observed, or
  when invocations sharing a request ID started from different sources.

A `DOMAIN_ERROR` failure (ADR 0045) carries the capability's declared
`domainCode`. The span records it as `invokta.error.domain_code`, and
`invokta.error.code` and `error.type` stay `DOMAIN_ERROR`. Of the metrics, only
`invokta.invocation.failures` splits by the domain code, so alerts can target
one declared failure. The count and duration series keep the framework code
taxonomy, which avoids multiplying their series by every declared code. Domain
codes are engine-declared (at most 64 per capability), and the attribute has its
own `maxMetricAttributeValues` bound, so a value beyond the bound, or one that is
not a non-empty string of at most 256 characters, becomes `_OTHER`.

### Robustness

Pending spans live in an insertion-ordered map capped by `maxPendingSpans`.
Reaching the cap evicts the oldest pending span: it ends immediately with
`invokta.span.evicted = true`, unset status, and no outcome. The handler keeps
the evicted invocation's metric source in a second map with the same cap, so its
terminal metrics stay in the same series. A terminal event without a pending
span records metrics but no span. The handler uses no timer.

Spans and `contextFor` are accurate only while request IDs are unique among
concurrent invocations. The core accepts a caller-supplied `requestId`, and a
host may forward an inbound correlation ID, such as a gateway retry with the
same `x-request-id` while the first attempt still runs. Terminal events carry
only the request ID, so the handler cannot tell which of the overlapping
invocations an event belongs to. It therefore never assigns an outcome across
them:

- a started event whose request ID belongs to a running invocation ends the
  earlier span early as evicted and starts the new span marked ambiguous;
- the first terminal event for that ID ends the ambiguous span early as
  evicted, with no outcome, status, or error code;
- every terminal event for that ID records metrics, with the source only when
  all overlapping starts shared it, and ends no other span; and
- `contextFor` returns the active context unchanged while the ID is ambiguous.

Once every overlapping invocation has terminated, the request ID is traced
normally again. The bookkeeping for overlapping and evicted invocations is
bounded by `maxPendingSpans`; beyond that bound the oldest counts are dropped,
so a reused request ID can again receive an earlier invocation's outcome.

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
- Hosts that reuse request IDs across concurrent invocations get evicted spans
  without outcomes for those invocations rather than misattributed outcomes;
  their metrics remain complete.

## Decision evidence

- [OpenTelemetry JS contrib instrumentation guidelines: API as a peer dependency](https://github.com/open-telemetry/opentelemetry-js-contrib/blob/main/GUIDELINES.md#opentelemetry-api)
- [OpenTelemetry trace API: span status](https://opentelemetry.io/docs/specs/otel/trace/api/#set-status)
- [Semantic conventions: recording errors and `error.type`](https://opentelemetry.io/docs/specs/semconv/general/recording-errors/)
- [Semantic conventions: metric naming and units](https://opentelemetry.io/docs/specs/semconv/general/naming/)
- [Semantic conventions: HTTP metrics duration boundaries](https://opentelemetry.io/docs/specs/semconv/http/http-metrics/)
