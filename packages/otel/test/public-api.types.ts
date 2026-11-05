import type { EngineDefinition, EngineEvent } from "@invokta/core";
import type { Context, Meter, Tracer } from "@opentelemetry/api";
import { expectTypeOf } from "vitest";

import {
  createOpenTelemetryEventHandler,
  type OpenTelemetryEventHandler,
  type OpenTelemetryEventHandlerOptions,
} from "../src/index.js";

declare const tracer: Tracer;
declare const meter: Meter;

const handler = createOpenTelemetryEventHandler({
  tracer,
  meter,
  recordPrincipalId: false,
  maxPendingSpans: 10_000,
  maxMetricAttributeValues: 256,
});
expectTypeOf(handler).toEqualTypeOf<OpenTelemetryEventHandler>();
expectTypeOf(
  createOpenTelemetryEventHandler(),
).toEqualTypeOf<OpenTelemetryEventHandler>();

// The handler is a synchronous engine hook.
expectTypeOf(handler).parameters.toEqualTypeOf<[event: EngineEvent]>();
expectTypeOf(handler).returns.toEqualTypeOf<void>();
expectTypeOf(handler).toMatchTypeOf<
  NonNullable<EngineDefinition<Record<never, never>>["onEvent"]>
>();

// contextFor resolves a request ID to an OpenTelemetry context.
expectTypeOf(handler.contextFor).parameters.toEqualTypeOf<
  [requestId: string]
>();
expectTypeOf(handler.contextFor).returns.toEqualTypeOf<Context>();

const options: OpenTelemetryEventHandlerOptions = {};
expectTypeOf(options).toMatchTypeOf<OpenTelemetryEventHandlerOptions>();

// @ts-expect-error The principal opt-in is a boolean, not a selector.
createOpenTelemetryEventHandler({ recordPrincipalId: "id" });

// @ts-expect-error The pending span cap is a number.
createOpenTelemetryEventHandler({ maxPendingSpans: "10" });

// @ts-expect-error A tracer provider is not a tracer.
createOpenTelemetryEventHandler({ tracer: { getTracer: () => tracer } });
