import { createEngine, defineCapability, EngineError } from "@invokta/core";
import {
  context,
  type ContextManager,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  AggregationTemporality,
  type DataPoint,
  type Histogram,
  MeterProvider,
  MetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import packageManifest from "../package.json" with { type: "json" };
import { createOpenTelemetryEventHook } from "../src/index.js";

const packageVersion = packageManifest.version;

class TestMetricReader extends MetricReader {
  constructor() {
    super({
      aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE,
    });
  }

  protected override onShutdown(): Promise<void> {
    return Promise.resolve();
  }

  protected override onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

const echo = defineCapability({
  description: "Echo a value.",
  input: z.object({ value: z.string() }),
  output: z.object({ value: z.string() }),
  access: "public",
  run: async ({ input }) => input,
});

const restricted = defineCapability({
  description: "Reject every caller.",
  input: z.object({}),
  output: z.object({}),
  access: () => false,
  run: async () => ({}),
});

const broken = defineCapability({
  description: "Fail with a domain error.",
  input: z.object({}),
  output: z.object({}),
  access: "public",
  run: async () => {
    throw new EngineError({
      code: "EXECUTION_FAILED",
      message: "private detail",
    });
  },
});

let spans: InMemorySpanExporter;
let tracerProvider: BasicTracerProvider;
let reader: TestMetricReader;
let meterProvider: MeterProvider;
let contextManager: ContextManager;

beforeEach(() => {
  spans = new InMemorySpanExporter();
  tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spans)],
  });
  reader = new TestMetricReader();
  meterProvider = new MeterProvider({ readers: [reader] });
  contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
});

afterEach(async () => {
  context.disable();
  await tracerProvider.shutdown();
  await meterProvider.shutdown();
});

function createTestEngine(
  options: Parameters<typeof createOpenTelemetryEventHook>[0] = {},
) {
  return createEngine({
    name: "telemetry-test-engine",
    version: "0.1.0",
    capabilities: { echo, restricted, broken },
    onEvent: createOpenTelemetryEventHook({
      tracerProvider,
      meterProvider,
      ...options,
    }),
  });
}

async function metric(name: string) {
  const { resourceMetrics } = await reader.collect();
  const found = resourceMetrics.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .find((candidate) => candidate.descriptor.name === name);
  if (found === undefined) throw new Error(`Metric ${name} was not recorded.`);
  return found;
}

describe("createOpenTelemetryEventHook", () => {
  it("records one internal span per successful invocation", async () => {
    const engine = createTestEngine();

    await engine.invoke(
      "echo",
      { value: "payload-secret" },
      { requestId: "req-1", source: "cli" },
    );

    const [span, ...rest] = spans.getFinishedSpans();
    expect(rest).toEqual([]);
    expect(span?.name).toBe("invokta.invoke echo");
    expect(span?.kind).toBe(SpanKind.INTERNAL);
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    expect(span?.attributes).toEqual({
      "invokta.capability.id": "echo",
      "invokta.request.id": "req-1",
      "invokta.invocation.source": "cli",
    });
    expect(span?.instrumentationScope.name).toBe("@invokta/opentelemetry");
  });

  it("marks failed invocations with the stable error code and no message", async () => {
    const engine = createTestEngine();

    await expect(
      engine.invoke("restricted", {}, { requestId: "req-2" }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(engine.invoke("broken", {})).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
    });
    await expect(
      engine.invoke("missing" as "echo", { value: "x" }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_NOT_FOUND",
    });

    const finished = spans.getFinishedSpans();
    expect(finished.map((span) => span.attributes["error.type"])).toEqual([
      "UNAUTHENTICATED",
      "EXECUTION_FAILED",
      "CAPABILITY_NOT_FOUND",
    ]);
    for (const span of finished) {
      expect(span.status).toEqual({
        code: SpanStatusCode.ERROR,
        message: span.attributes["error.type"],
      });
    }
    expect(
      JSON.stringify(finished.map((span) => span.attributes)),
    ).not.toContain("private detail");
  });

  it("ends each span at the engine-reported duration", async () => {
    const hook = createOpenTelemetryEventHook({ tracerProvider });

    hook({
      type: "invocation.started",
      requestId: "req-3",
      capabilityId: "echo",
      source: "direct",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    hook({
      type: "invocation.completed",
      requestId: "req-3",
      capabilityId: "echo",
      durationMs: 250,
    });

    const [span] = spans.getFinishedSpans();
    expect(span?.startTime).toEqual([1_767_225_600, 0]);
    expect(span?.endTime).toEqual([1_767_225_600, 250_000_000]);
  });

  it("parents the span to the caller's active context", async () => {
    const engine = createTestEngine();
    const tracer = tracerProvider.getTracer("test");
    const parent = tracer.startSpan("http request");

    await context.with(trace.setSpan(context.active(), parent), () =>
      engine.invoke("echo", { value: "x" }),
    );
    parent.end();

    const span = spans
      .getFinishedSpans()
      .find((candidate) => candidate.name === "invokta.invoke echo");
    expect(span?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(span?.spanContext().traceId).toBe(parent.spanContext().traceId);
  });

  it("keeps concurrent invocations of one capability independent", async () => {
    const engine = createTestEngine();

    await Promise.all([
      engine.invoke("echo", { value: "a" }, { requestId: "a" }),
      engine.invoke("echo", { value: "b" }, { requestId: "b" }),
      engine.invoke("broken", {}, { requestId: "c" }).catch(() => undefined),
    ]);

    const byRequest = new Map(
      spans
        .getFinishedSpans()
        .map((span) => [span.attributes["invokta.request.id"], span]),
    );
    expect([...byRequest.keys()].sort()).toEqual(["a", "b", "c"]);
    expect(byRequest.get("a")?.status.code).toBe(SpanStatusCode.UNSET);
    expect(byRequest.get("c")?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("matches reused request IDs by capability", async () => {
    const hook = createOpenTelemetryEventHook({ tracerProvider });
    const started = (capabilityId: string) =>
      hook({
        type: "invocation.started",
        requestId: "same",
        capabilityId,
        source: "direct",
        startedAt: "2026-01-01T00:00:00.000Z",
      });

    started("first");
    started("second");
    hook({
      type: "invocation.failed",
      requestId: "same",
      capabilityId: "second",
      durationMs: 1,
      code: "FORBIDDEN",
    });
    hook({
      type: "invocation.completed",
      requestId: "same",
      capabilityId: "first",
      durationMs: 1,
    });

    expect(
      spans.getFinishedSpans().map((span) => [span.name, span.status.code]),
    ).toEqual([
      ["invokta.invoke second", SpanStatusCode.ERROR],
      ["invokta.invoke first", SpanStatusCode.UNSET],
    ]);
  });

  it("ignores a terminal event without a started event", () => {
    const hook = createOpenTelemetryEventHook({ tracerProvider });

    expect(() =>
      hook({
        type: "invocation.completed",
        requestId: "orphan",
        capabilityId: "echo",
        durationMs: 1,
      }),
    ).not.toThrow();
    expect(spans.getFinishedSpans()).toEqual([]);
  });

  it("omits the principal ID unless explicitly enabled", async () => {
    const principal = { id: "user-42" };

    await createTestEngine().invoke("echo", { value: "x" }, { principal });
    await createTestEngine({ includePrincipalId: true }).invoke(
      "echo",
      { value: "x" },
      { principal },
    );

    const [defaultSpan, enabledSpan] = spans.getFinishedSpans();
    expect(defaultSpan?.attributes["enduser.id"]).toBeUndefined();
    expect(enabledSpan?.attributes["enduser.id"]).toBe("user-42");
  });

  it("records a duration histogram without per-request attributes", async () => {
    const engine = createTestEngine();

    await engine.invoke("echo", { value: "x" }, { source: "mcp-http" });
    await engine.invoke("echo", { value: "y" }, { source: "mcp-http" });
    await engine.invoke("broken", {}).catch(() => undefined);

    const duration = await metric("invokta.invocation.duration");
    expect(duration.descriptor.unit).toBe("s");
    const points = duration.dataPoints as DataPoint<Histogram>[];
    const summary = points
      .map((point) => ({
        attributes: point.attributes,
        count: point.value.count,
      }))
      .sort((left, right) => right.count - left.count);
    expect(summary).toEqual([
      {
        attributes: {
          "invokta.capability.id": "echo",
          "invokta.invocation.source": "mcp-http",
        },
        count: 2,
      },
      {
        attributes: {
          "invokta.capability.id": "broken",
          "invokta.invocation.source": "direct",
          "error.type": "EXECUTION_FAILED",
        },
        count: 1,
      },
    ]);
  });

  it("bounds telemetry cardinality for unknown capability IDs", async () => {
    const engine = createTestEngine();
    const unknown = ["attacker-1", "attacker-2", "x".repeat(5000)];

    for (const id of unknown) {
      await engine.invoke(id as "echo", { value: "x" }).catch(() => undefined);
    }
    await engine.invoke("echo", { value: "x" });

    const finished = spans.getFinishedSpans();
    expect(finished.map((span) => span.name)).toEqual([
      "invokta.invoke _OTHER",
      "invokta.invoke _OTHER",
      "invokta.invoke _OTHER",
      "invokta.invoke echo",
    ]);
    expect(
      finished.map((span) => span.attributes["invokta.capability.id"]),
    ).toEqual(["_OTHER", "_OTHER", "_OTHER", "echo"]);

    const duration = await metric("invokta.invocation.duration");
    expect(
      (duration.dataPoints as DataPoint<Histogram>[])
        .map((point) => point.attributes["invokta.capability.id"])
        .sort(),
    ).toEqual(["_OTHER", "echo"]);
    const active = await metric("invokta.invocation.active");
    expect(
      (active.dataPoints as DataPoint<number>[]).map((point) => ({
        attributes: point.attributes,
        value: point.value,
      })),
    ).toEqual([
      { attributes: { "invokta.invocation.source": "direct" }, value: 0 },
    ]);
  });

  it("reports the instrumentation scope version", async () => {
    await createTestEngine().invoke("echo", { value: "x" });

    const [span] = spans.getFinishedSpans();
    expect(span?.instrumentationScope.version).toBe(packageVersion);
  });

  it("returns the active invocation gauge to zero", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = defineCapability({
      description: "Wait for the test to release it.",
      input: z.object({}),
      output: z.object({}),
      access: "public",
      run: async () => {
        await gate;
        return {};
      },
    });
    const engine = createEngine({
      name: "telemetry-slow-engine",
      version: "0.1.0",
      capabilities: { slow },
      onEvent: createOpenTelemetryEventHook({ tracerProvider, meterProvider }),
    });

    const pending = engine.invoke("slow", {});
    const during = await metric("invokta.invocation.active");
    release();
    await pending;
    const after = await metric("invokta.invocation.active");

    expect(
      (during.dataPoints as DataPoint<number>[]).map((point) => point.value),
    ).toEqual([1]);
    expect(
      (after.dataPoints as DataPoint<number>[]).map((point) => point.value),
    ).toEqual([0]);
  });

  it("falls back to the global providers", async () => {
    trace.setGlobalTracerProvider(tracerProvider);
    try {
      const engine = createEngine({
        name: "telemetry-global-engine",
        version: "0.1.0",
        capabilities: { echo },
        onEvent: createOpenTelemetryEventHook(),
      });

      await engine.invoke("echo", { value: "x" });

      expect(spans.getFinishedSpans()).toHaveLength(1);
    } finally {
      trace.disable();
    }
  });
});
