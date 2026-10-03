# @invokta/opentelemetry

OpenTelemetry traces and metrics for Invokta Action Engine invocations. The
package turns the engine's payload-free `onEvent` events into spans and metrics
that any OpenTelemetry-compatible platform can ingest, such as an OpenTelemetry
Collector, Datadog, Grafana, Honeycomb, New Relic, or Sentry.

The normative decision is
[ADR 0042](../../docs/adr/0042-opentelemetry-event-adapter.md). A conflict
between this file and an ADR is resolved in favor of the ADR.

## Install

```sh
yarn add @invokta/opentelemetry @opentelemetry/api
```

`@opentelemetry/api` is a peer dependency. The package depends on no
OpenTelemetry SDK, exporter, or vendor package; you choose those in your host
process.

## Use

Register an OpenTelemetry SDK and exporter once at process start, then pass the
hook to `createEngine`:

```ts
import { createEngine } from "@invokta/core";
import { createOpenTelemetryEventHook } from "@invokta/opentelemetry";

export const engine = createEngine({
  name: "support-engine",
  version: "1.0.0",
  capabilities,
  onEvent: createOpenTelemetryEventHook(),
});
```

A minimal Node.js setup that exports to an OTLP endpoint, which a Collector or a
vendor accepts:

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

new NodeSDK({
  serviceName: "support-engine",
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
  }),
}).start();
```

Set `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` to point the
exporters at your platform.

## Signals

| Signal | Name | Notes |
| --- | --- | --- |
| Span | `invokta.invoke <capabilityId>` | `INTERNAL`; ends at the engine-reported duration |
| Histogram | `invokta.invocation.duration` | Seconds; capability, source, and `error.type` on failure |
| Up-down counter | `invokta.invocation.active` | In-flight invocations by source |

Span attributes:

| Attribute | Value |
| --- | --- |
| `invokta.capability.id` | Capability ID |
| `invokta.request.id` | Request ID |
| `invokta.invocation.source` | `direct`, `cli`, `mcp-stdio`, or `mcp-http` |
| `error.type` | Stable `EngineErrorCode`, only on failure |
| `enduser.id` | Principal ID, only with `includePrincipalId: true` |

When a capability does not exist, the caller-supplied ID is replaced with
`_OTHER` so untrusted input cannot create unbounded span names or metric series.

A failed invocation also sets the span status to `ERROR` with the error code as
its message. Capability input, output, credentials, and error messages are never
exported.

## Options

```ts
interface OpenTelemetryEventHookOptions {
  readonly tracerProvider?: TracerProvider; // defaults to the global provider
  readonly meterProvider?: MeterProvider; // defaults to the global provider
  readonly includePrincipalId?: boolean; // defaults to false
}
```

## Parent context and limits

The invocation span is a child of the OpenTelemetry context that is active when
`engine.invoke` runs, for example inside `context.with(...)` in your own code.
The adapter does not read `traceparent` headers from inbound MCP HTTP requests.

The span is not active while the capability's `run` executes, so spans created
inside a capability, such as outbound HTTP calls, attach to the caller's span
instead of the invocation span. Event delivery is best-effort, as defined for
`onEvent`.

To use another `onEvent` consumer too, call both from one function:

```ts
const telemetry = createOpenTelemetryEventHook();

createEngine({
  name: "support-engine",
  version: "1.0.0",
  capabilities,
  onEvent(event) {
    telemetry(event);
    audit(event);
  },
});
```
