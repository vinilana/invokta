import type { Attributes, HrTime, Meter, Tracer } from "@opentelemetry/api";
import {
  type DataPoint,
  type Histogram,
  MeterProvider,
  type MetricData,
  MetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";

/** A pull reader: tests call `collect` instead of waiting for an export interval. */
class CollectingMetricReader extends MetricReader {
  protected override async onShutdown(): Promise<void> {}
  protected override async onForceFlush(): Promise<void> {}
}

export interface CollectedMetric {
  readonly name: string;
  readonly unit: string;
  readonly points: readonly DataPoint<number | Histogram>[];
}

export interface InMemoryTelemetry {
  readonly tracerProvider: TracerProvider;
  readonly meterProvider: MeterProvider;
  readonly tracer: Tracer;
  readonly meter: Meter;
  spans(): readonly ReadableSpan[];
  metrics(): Promise<ReadonlyMap<string, CollectedMetric>>;
  shutdown(): Promise<void>;
}

/**
 * Builds the reference OpenTelemetry SDK with in-memory exporters, so tests
 * observe exactly what a real backend would receive.
 */
export function createInMemoryTelemetry(): InMemoryTelemetry {
  const exporter = new InMemorySpanExporter();
  const tracerProvider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  const reader = new CollectingMetricReader();
  const meterProvider = new MeterProvider({ readers: [reader] });

  return {
    tracerProvider,
    meterProvider,
    tracer: tracerProvider.getTracer("invokta-otel-test"),
    meter: meterProvider.getMeter("invokta-otel-test"),
    spans: () => exporter.getFinishedSpans(),
    async metrics() {
      const { resourceMetrics, errors } = await reader.collect();
      if (errors.length > 0) throw new Error("Metric collection failed.");
      const collected = new Map<string, CollectedMetric>();
      for (const scope of resourceMetrics.scopeMetrics) {
        for (const metric of scope.metrics as MetricData[]) {
          collected.set(metric.descriptor.name, {
            name: metric.descriptor.name,
            unit: metric.descriptor.unit,
            points: metric.dataPoints as DataPoint<number | Histogram>[],
          });
        }
      }
      return collected;
    },
    async shutdown() {
      await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
    },
  };
}

export function hrTimeToMilliseconds([seconds, nanoseconds]: HrTime): number {
  return seconds * 1_000 + nanoseconds / 1_000_000;
}

/** Returns the point whose attributes equal `attributes` exactly. */
export function pointWith<Value>(
  metric: CollectedMetric | undefined,
  attributes: Attributes,
): DataPoint<Value> | undefined {
  const expected = JSON.stringify(sortAttributes(attributes));
  return metric?.points.find(
    (point) => JSON.stringify(sortAttributes(point.attributes)) === expected,
  ) as DataPoint<Value> | undefined;
}

function sortAttributes(attributes: Attributes): [string, unknown][] {
  return Object.entries(attributes).sort(([left], [right]) =>
    left.localeCompare(right),
  );
}
