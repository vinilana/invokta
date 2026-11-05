# @invokta/otel

OpenTelemetry instrumentation for Invokta Action Engines. The package turns the
engine's `invocation.started`, `invocation.completed`, and `invocation.failed`
events into one span per invocation and three invocation metrics through the
OpenTelemetry API.

It is instrumentation, not an observability platform: it bundles no SDK,
exporter, collector, or backend. Your host registers the OpenTelemetry SDK and
chooses where telemetry goes. The core runtime has no OpenTelemetry dependency.

## Install

```sh
npm install @invokta/otel @opentelemetry/api
```

`@opentelemetry/api` is a peer dependency (`^1.9.0`) so the engine and your
SDK share one API instance. The package is native ESM. Its root imports only
`@opentelemetry/api` and core types and loads no Node.js built-in; it is tested
on Node.js 22.20.0 or later, the version its manifest declares.

## Use

```ts
import { createEngine } from "@invokta/core";
import { createOpenTelemetryEventHandler } from "@invokta/otel";

export const engine = createEngine({
  name: "support-engine",
  version: "1.0.0",
  capabilities,
  onEvent: createOpenTelemetryEventHandler(),
});
```

Without options the handler uses the global tracer and meter providers under
the `@invokta/otel` instrumentation scope. It resolves them as it records, so a
module-scope engine reports to an SDK started later from an `--import` module or
the entry point, and to a provider that replaced an earlier one. Pass `tracer`
and `meter` to use explicit providers instead.

| Option | Default | Meaning |
| --- | --- | --- |
| `tracer` | global tracer | OpenTelemetry `Tracer` for invocation spans |
| `meter` | global meter | OpenTelemetry `Meter` for invocation metrics |
| `recordPrincipalId` | `false` | Record `invokta.principal.id` on spans; principal IDs may be personal data |
| `maxPendingSpans` | `10000` | Invocations awaiting their terminal event before the oldest span is evicted |
| `maxMetricAttributeValues` | `256` | Distinct values per metric attribute before new values become `_OTHER` |

Invalid options throw `TypeError` when the handler is created. The handler
itself never throws into the engine and always returns `undefined`.

### Keep an existing event hook

Call the OpenTelemetry handler first and return the existing hook's result, so
the engine still observes that hook's promise:

```ts
const telemetry = createOpenTelemetryEventHandler();

createEngine({
  name: "support-engine",
  version: "1.0.0",
  capabilities,
  onEvent(event) {
    telemetry(event);
    return auditLog.record(event);
  },
});
```

## Spans

| Property | Value |
| --- | --- |
| Name | `invoke {capabilityId}`; `invoke` for `CAPABILITY_NOT_FOUND` or a capability ID over 256 characters |
| Kind | `INTERNAL` |
| Parent | The active context when `engine.invoke` starts |
| Start | The event's `startedAt` |
| End | Start plus the terminal event's `durationMs` |
| Status | Unset on completion; `ERROR` with the error code on failure |

| Attribute | When |
| --- | --- |
| `invokta.capability.id` | Always |
| `invokta.execution.source` | Always; `direct`, `cli`, `mcp-stdio`, `mcp-http`, `http`, or a later source |
| `invokta.request.id` | Always |
| `invokta.principal.id` | Only with `recordPrincipalId: true` |
| `invokta.invocation.outcome` | `completed` or `failed` |
| `invokta.error.code`, `error.type` | Failure; the code is an opaque string |
| `invokta.error.domain_code` | `DOMAIN_ERROR` failure; the capability's declared domain code |
| `invokta.span.evicted` | `true` when the span ended early: evicted, or its request ID was reused |

A span attribute value longer than 256 characters is recorded as `_OTHER`.

## Metrics

| Instrument | Kind | Unit | Attributes |
| --- | --- | --- | --- |
| `invokta.invocations` | Counter | `{invocation}` | capability, source, outcome, error code on failure |
| `invokta.invocation.duration` | Histogram | `s` | capability, source, outcome, error code on failure |
| `invokta.invocation.failures` | Counter | `{failure}` | capability, source, error code, domain code of a `DOMAIN_ERROR` |

Failure points carry both `invokta.error.code` and `error.type`. Only the
failures counter carries `invokta.error.domain_code`, so the count and duration
series stay split by framework code alone. Request and
principal IDs never appear on metrics. A failed lookup records its
caller-chosen capability ID as `_OTHER`; so does any value that is not a
non-empty string of at most 256 characters, and any new value once an attribute
holds `maxMetricAttributeValues` distinct values.

## Nest capability spans

The engine does not run `access` or `run` inside the invocation span, so a span a
capability starts from the active context is a sibling of the invocation span.
Inject `contextFor` when a capability needs nested spans:

```ts
import { context, trace } from "@opentelemetry/api";

const telemetry = createOpenTelemetryEventHandler();
const tracer = trace.getTracer("support-engine");

const classifyTicket = defineCapability({
  // ...
  async run({ input, context: execution }) {
    return context.with(telemetry.contextFor(execution.requestId), () =>
      tracer.startActiveSpan("classifier.classify", async (span) => {
        try {
          return await classifier.classify(input, execution.signal);
        } finally {
          span.end();
        }
      }),
    );
  },
});
```

`contextFor(requestId)` returns the active context with the pending invocation
span, or the active context unchanged when the invocation has no pending span
or another running invocation uses the same request ID.

## Limits

- Event delivery is best-effort, as defined by the core.
- Pending spans are capped by `maxPendingSpans`. The oldest pending span ends
  early with `invokta.span.evicted = true`; its terminal event still records
  metrics, with the source.
- Spans and `contextFor` are accurate only while request IDs are unique among
  concurrent invocations. Terminal events carry only the request ID, so when a
  running invocation's ID is reused, every span for those overlapping
  invocations ends early as evicted with no outcome, `contextFor` resolves no
  invocation span, and metrics still count every terminal event. The ID is
  traced normally again once all of them finish.
- Spans carry no input, output, message, or credential.
- Unknown event types are ignored, and new error codes are recorded unchanged.
- No log signal, exporter, sampling policy, or automatic context propagation is
  provided.

ADR 0050 records the decision and its rationale.
