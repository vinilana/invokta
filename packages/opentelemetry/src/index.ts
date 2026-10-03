import type { EngineEvent } from "@invokta/core";
import {
  type Attributes,
  metrics,
  type MeterProvider,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
  type TracerProvider,
  ValueType,
} from "@opentelemetry/api";

const instrumentationName = "@invokta/opentelemetry";

// Bucket boundaries, in seconds, recommended by the OpenTelemetry semantic
// conventions for operation durations.
const durationBuckets = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
];

export interface OpenTelemetryEventHookOptions {
  /** Defaults to the global tracer provider. */
  readonly tracerProvider?: TracerProvider;
  /** Defaults to the global meter provider. */
  readonly meterProvider?: MeterProvider;
  /**
   * Records the authenticated principal ID as `enduser.id` on spans. Disabled
   * by default because the ID can identify a person.
   */
  readonly includePrincipalId?: boolean;
}

interface OpenInvocation {
  readonly capabilityId: string;
  readonly span: Span;
  readonly startedAtMs: number;
  readonly metricAttributes: Attributes;
}

/**
 * Creates an `onEvent` hook that reports every Invokta invocation as an
 * OpenTelemetry span and as duration and in-flight metrics.
 *
 * The hook consumes only the payload-free engine events, so it never exports
 * capability input, output, credentials, or error messages. Exporters, sampling,
 * and the destination platform are configured through the host's OpenTelemetry
 * SDK.
 */
export function createOpenTelemetryEventHook(
  options: OpenTelemetryEventHookOptions = {},
): (event: EngineEvent) => void {
  const tracer = (
    options.tracerProvider ?? trace.getTracerProvider()
  ).getTracer(instrumentationName);
  const meter = (options.meterProvider ?? metrics.getMeterProvider()).getMeter(
    instrumentationName,
  );
  const duration = meter.createHistogram("invokta.invocation.duration", {
    description: "Duration of Invokta capability invocations.",
    unit: "s",
    valueType: ValueType.DOUBLE,
    advice: { explicitBucketBoundaries: durationBuckets },
  });
  const active = meter.createUpDownCounter("invokta.invocation.active", {
    description: "Invokta capability invocations currently in flight.",
    unit: "{invocation}",
  });
  const includePrincipalId = options.includePrincipalId === true;
  // Request IDs may be caller supplied, so one ID can have several open
  // invocations. The engine emits exactly one terminal event for each started
  // event, which bounds this map to the invocations in flight.
  const open = new Map<string, OpenInvocation[]>();

  const take = (
    requestId: string,
    capabilityId: string,
  ): OpenInvocation | undefined => {
    const invocations = open.get(requestId);
    const index =
      invocations?.findIndex(
        (candidate) => candidate.capabilityId === capabilityId,
      ) ?? -1;
    if (invocations === undefined || index === -1) return undefined;
    const [invocation] = invocations.splice(index, 1);
    if (invocations.length === 0) open.delete(requestId);
    return invocation;
  };

  return (event) => {
    switch (event.type) {
      case "invocation.started": {
        const parsed = Date.parse(event.startedAt);
        const startedAtMs = Number.isNaN(parsed) ? Date.now() : parsed;
        const metricAttributes: Attributes = {
          "invokta.capability.id": event.capabilityId,
          "invokta.invocation.source": event.source,
        };
        const span = tracer.startSpan(`invokta.invoke ${event.capabilityId}`, {
          kind: SpanKind.INTERNAL,
          startTime: new Date(startedAtMs),
          attributes: {
            ...metricAttributes,
            "invokta.request.id": event.requestId,
            ...(includePrincipalId && event.principalId !== undefined
              ? { "enduser.id": event.principalId }
              : {}),
          },
        });
        const invocations = open.get(event.requestId) ?? [];
        invocations.push({
          capabilityId: event.capabilityId,
          span,
          startedAtMs,
          metricAttributes,
        });
        open.set(event.requestId, invocations);
        active.add(1, metricAttributes);
        return;
      }
      case "invocation.completed":
      case "invocation.failed": {
        const invocation = take(event.requestId, event.capabilityId);
        if (invocation === undefined) return;
        const attributes: Attributes =
          event.type === "invocation.failed"
            ? { ...invocation.metricAttributes, "error.type": event.code }
            : invocation.metricAttributes;
        if (event.type === "invocation.failed") {
          invocation.span.setAttribute("error.type", event.code);
          invocation.span.setStatus({
            code: SpanStatusCode.ERROR,
            message: event.code,
          });
        }
        invocation.span.end(
          new Date(invocation.startedAtMs + event.durationMs),
        );
        duration.record(event.durationMs / 1000, attributes);
        active.add(-1, invocation.metricAttributes);
        return;
      }
    }
  };
}
