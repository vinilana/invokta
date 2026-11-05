import { readFileSync } from "node:fs";

import type { EngineEvent } from "@invokta/core";
import { metrics, trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";

import { createOpenTelemetryEventHandler } from "../src/index.js";
import {
  createInMemoryTelemetry,
  type InMemoryTelemetry,
} from "./support/in-memory-telemetry.js";

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { readonly name: string; readonly version: string };

const events: readonly EngineEvent[] = [
  {
    type: "invocation.started",
    requestId: "request-1",
    capabilityId: "support.classify-ticket",
    source: "direct",
    startedAt: "2026-11-05T12:00:00.000Z",
  },
  {
    type: "invocation.completed",
    requestId: "request-1",
    capabilityId: "support.classify-ticket",
    durationMs: 12,
  },
];

let telemetry: InMemoryTelemetry | undefined;

afterEach(async () => {
  trace.disable();
  metrics.disable();
  await telemetry?.shutdown();
  telemetry = undefined;
});

describe("global OpenTelemetry providers", () => {
  it("uses the global providers under this package's instrumentation scope", async () => {
    telemetry = createInMemoryTelemetry();
    trace.setGlobalTracerProvider(telemetry.tracerProvider);
    metrics.setGlobalMeterProvider(telemetry.meterProvider);

    const handler = createOpenTelemetryEventHandler();
    for (const event of events) handler(event);

    const [span] = telemetry.spans();
    expect(span?.instrumentationScope).toMatchObject({
      name: manifest.name,
      version: manifest.version,
    });
    const collected = await telemetry.metrics();
    expect(collected.get("invokta.invocations")?.points).toHaveLength(1);
  });

  it("follows providers registered after the handler was created", async () => {
    const handler = createOpenTelemetryEventHandler();
    handler(events[0] as EngineEvent);
    handler(events[1] as EngineEvent);

    telemetry = createInMemoryTelemetry();
    trace.setGlobalTracerProvider(telemetry.tracerProvider);
    metrics.setGlobalMeterProvider(telemetry.meterProvider);
    for (const event of events) handler(event);

    expect(telemetry.spans()).toHaveLength(1);
    const collected = await telemetry.metrics();
    expect(collected.get("invokta.invocations")?.points[0]?.value).toBe(1);
  });
});
