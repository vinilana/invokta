import type { EngineEvent } from "@invokta/core";
import {
  type Attributes,
  type Context,
  type Counter,
  context as contextApi,
  diag,
  type Histogram,
  type Meter,
  type MeterProvider,
  metrics,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";

/** Instrumentation scope; the version tracks the package release. */
const INSTRUMENTATION_NAME = "@invokta/otel";
const INSTRUMENTATION_VERSION = "0.9.1";

const DEFAULT_MAX_PENDING_SPANS = 10_000;
const DEFAULT_MAX_METRIC_ATTRIBUTE_VALUES = 256;
const MAX_METRIC_ATTRIBUTE_VALUE_LENGTH = 256;

/** OpenTelemetry's conventional value for a value outside the recorded set. */
const OTHER = "_OTHER";
const OPERATION = "invoke";
const CAPABILITY_NOT_FOUND = "CAPABILITY_NOT_FOUND";

const ATTR_CAPABILITY_ID = "invokta.capability.id";
const ATTR_EXECUTION_SOURCE = "invokta.execution.source";
const ATTR_REQUEST_ID = "invokta.request.id";
const ATTR_PRINCIPAL_ID = "invokta.principal.id";
const ATTR_OUTCOME = "invokta.invocation.outcome";
const ATTR_ERROR_CODE = "invokta.error.code";
const ATTR_ERROR_TYPE = "error.type";
const ATTR_SPAN_EVICTED = "invokta.span.evicted";

/**
 * OpenTelemetry's HTTP duration boundaries, extended for capabilities that
 * wait on models or providers for minutes.
 */
const DURATION_BOUNDARIES_SECONDS = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10, 30,
  60, 120, 300,
]);

export interface OpenTelemetryEventHandlerOptions {
  /**
   * Tracer for invocation spans. Defaults to the global tracer provider's
   * tracer for this package, resolved when each span starts.
   */
  readonly tracer?: Tracer;
  /**
   * Meter for invocation metrics. Defaults to the global meter provider's
   * meter for this package, re-resolved when the global provider changes.
   */
  readonly meter?: Meter;
  /** Records the principal ID as `invokta.principal.id` on spans. Defaults to `false`. */
  readonly recordPrincipalId?: boolean;
  /** Invocations awaiting their terminal event before the oldest span is evicted. Defaults to 10,000. */
  readonly maxPendingSpans?: number;
  /** Distinct values recorded per metric attribute before `_OTHER` is used. Defaults to 256. */
  readonly maxMetricAttributeValues?: number;
}

/**
 * An `onEvent` hook that turns engine events into OpenTelemetry spans and
 * metrics. It never throws and always returns `undefined`.
 */
export interface OpenTelemetryEventHandler {
  (event: EngineEvent): void;
  /**
   * Returns the active context with the pending invocation span of
   * `requestId` as its span, or the active context unchanged when that
   * invocation has no pending span. Capabilities use it with
   * `context.with` so their own spans become children of the invocation.
   */
  readonly contextFor: (requestId: string) => Context;
}

interface PendingInvocation {
  readonly span: Span;
  readonly startTime: number | undefined;
  readonly source: string | undefined;
}

interface Instruments {
  readonly invocations: Counter;
  readonly duration: Histogram;
  readonly failures: Counter;
}

/** Admits at most `limit` distinct short strings; anything else is `_OTHER`. */
class BoundedValues {
  readonly #values = new Set<string>();
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  normalize(value: unknown): string {
    if (
      typeof value !== "string" ||
      value === "" ||
      value.length > MAX_METRIC_ATTRIBUTE_VALUE_LENGTH
    ) {
      return OTHER;
    }
    if (this.#values.has(value)) return value;
    if (this.#values.size >= this.#limit) return OTHER;
    this.#values.add(value);
    return value;
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function hasMethods(value: unknown, names: readonly string[]): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return names.every((name) => typeof record[name] === "function");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

function readDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function createInstruments(meter: Meter): Instruments {
  return {
    invocations: meter.createCounter("invokta.invocations", {
      description: "Completed and failed capability invocations.",
      unit: "{invocation}",
    }),
    duration: meter.createHistogram("invokta.invocation.duration", {
      description: "Duration of capability invocations.",
      unit: "s",
      advice: { explicitBucketBoundaries: [...DURATION_BOUNDARIES_SECONDS] },
    }),
    failures: meter.createCounter("invokta.invocation.failures", {
      description: "Failed capability invocations by error code.",
      unit: "{failure}",
    }),
  };
}

function reportFailure(): void {
  try {
    diag.warn(`${INSTRUMENTATION_NAME} could not record an engine event.`);
  } catch {
    // Diagnostics must not escape the engine hook.
  }
}

/**
 * Creates an engine `onEvent` hook that records one span per invocation and
 * invocation count, duration, and failure metrics.
 */
export function createOpenTelemetryEventHandler(
  options: OpenTelemetryEventHandlerOptions = {},
): OpenTelemetryEventHandler {
  if (typeof options !== "object" || options === null) {
    throw new TypeError(
      "OpenTelemetry event handler options must be an object.",
    );
  }
  const {
    tracer: configuredTracer,
    meter: configuredMeter,
    recordPrincipalId = false,
    maxPendingSpans = DEFAULT_MAX_PENDING_SPANS,
    maxMetricAttributeValues = DEFAULT_MAX_METRIC_ATTRIBUTE_VALUES,
  } = options;
  if (
    configuredTracer !== undefined &&
    !hasMethods(configuredTracer, ["startSpan"])
  ) {
    throw new TypeError("tracer must be an OpenTelemetry Tracer.");
  }
  if (
    configuredMeter !== undefined &&
    !hasMethods(configuredMeter, ["createCounter", "createHistogram"])
  ) {
    throw new TypeError("meter must be an OpenTelemetry Meter.");
  }
  if (typeof recordPrincipalId !== "boolean") {
    throw new TypeError("recordPrincipalId must be a boolean.");
  }
  if (!isPositiveSafeInteger(maxPendingSpans)) {
    throw new TypeError("maxPendingSpans must be a positive safe integer.");
  }
  if (!isPositiveSafeInteger(maxMetricAttributeValues)) {
    throw new TypeError(
      "maxMetricAttributeValues must be a positive safe integer.",
    );
  }

  const tracer =
    configuredTracer ??
    trace.getTracer(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);
  const configuredInstruments =
    configuredMeter === undefined
      ? undefined
      : createInstruments(configuredMeter);
  // The metrics API has no proxy provider, so the default meter follows the
  // global provider instead of staying no-op when the SDK starts later.
  let globalInstruments: Instruments | undefined;
  let globalMeterProvider: MeterProvider | undefined;
  const currentInstruments = (): Instruments => {
    if (configuredInstruments !== undefined) return configuredInstruments;
    const provider = metrics.getMeterProvider();
    if (globalInstruments === undefined || provider !== globalMeterProvider) {
      globalInstruments = createInstruments(
        provider.getMeter(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION),
      );
      globalMeterProvider = provider;
    }
    return globalInstruments;
  };

  const pending = new Map<string, PendingInvocation>();
  const capabilityIds = new BoundedValues(maxMetricAttributeValues);
  const sources = new BoundedValues(maxMetricAttributeValues);
  const errorCodes = new BoundedValues(maxMetricAttributeValues);

  const evict = (requestId: string): void => {
    const entry = pending.get(requestId);
    if (entry === undefined) return;
    pending.delete(requestId);
    try {
      entry.span.setAttribute(ATTR_SPAN_EVICTED, true);
      entry.span.end();
    } catch {
      reportFailure();
    }
  };

  const onStarted = (event: Record<string, unknown>): void => {
    const requestId = readString(event.requestId);
    if (requestId === undefined) return;
    evict(requestId);
    for (const oldest of pending.keys()) {
      if (pending.size < maxPendingSpans) break;
      evict(oldest);
    }

    const capabilityId = readString(event.capabilityId);
    const source = readString(event.source);
    const principalId = readString(event.principalId);
    const startTime = readTimestamp(event.startedAt);
    const attributes: Attributes = { [ATTR_REQUEST_ID]: requestId };
    if (capabilityId !== undefined) {
      attributes[ATTR_CAPABILITY_ID] = capabilityId;
    }
    if (source !== undefined) attributes[ATTR_EXECUTION_SOURCE] = source;
    if (recordPrincipalId && principalId !== undefined) {
      attributes[ATTR_PRINCIPAL_ID] = principalId;
    }
    const span = tracer.startSpan(
      capabilityId === undefined ? OPERATION : `${OPERATION} ${capabilityId}`,
      {
        kind: SpanKind.INTERNAL,
        attributes,
        ...(startTime === undefined ? {} : { startTime }),
      },
      contextApi.active(),
    );
    pending.set(requestId, {
      span,
      startTime,
      source: source === undefined ? undefined : sources.normalize(source),
    });
  };

  const recordMetrics = (
    event: Record<string, unknown>,
    entry: PendingInvocation | undefined,
    code: string | undefined,
  ): void => {
    const instruments = currentInstruments();
    const attributes: Attributes = {
      [ATTR_CAPABILITY_ID]:
        code === CAPABILITY_NOT_FOUND
          ? OTHER
          : capabilityIds.normalize(event.capabilityId),
    };
    if (entry?.source !== undefined) {
      attributes[ATTR_EXECUTION_SOURCE] = entry.source;
    }
    if (code !== undefined) {
      const errorCode = errorCodes.normalize(code);
      attributes[ATTR_ERROR_CODE] = errorCode;
      attributes[ATTR_ERROR_TYPE] = errorCode;
    }
    const outcome = {
      ...attributes,
      [ATTR_OUTCOME]: code === undefined ? "completed" : "failed",
    };
    instruments.invocations.add(1, outcome);
    const durationMs = readDuration(event.durationMs);
    if (durationMs !== undefined) {
      instruments.duration.record(durationMs / 1_000, outcome);
    }
    if (code !== undefined) instruments.failures.add(1, attributes);
  };

  const endSpan = (
    event: Record<string, unknown>,
    entry: PendingInvocation,
    code: string | undefined,
  ): void => {
    const { span } = entry;
    if (code === undefined) {
      span.setAttribute(ATTR_OUTCOME, "completed");
    } else {
      span.setAttributes({
        [ATTR_OUTCOME]: "failed",
        [ATTR_ERROR_CODE]: code,
        [ATTR_ERROR_TYPE]: code,
      });
      span.setStatus({ code: SpanStatusCode.ERROR, message: code });
      // The ID of a failed lookup is caller-chosen; keep the name bounded.
      if (code === CAPABILITY_NOT_FOUND) span.updateName(OPERATION);
    }
    const durationMs = readDuration(event.durationMs);
    span.end(
      entry.startTime === undefined || durationMs === undefined
        ? undefined
        : entry.startTime + durationMs,
    );
  };

  const onTerminal = (
    event: Record<string, unknown>,
    failed: boolean,
  ): void => {
    const requestId = readString(event.requestId);
    const entry = requestId === undefined ? undefined : pending.get(requestId);
    if (requestId !== undefined && entry !== undefined) {
      pending.delete(requestId);
    }
    let code: string | undefined;
    if (failed) {
      // The code is opaque: new codes are recorded without a release here.
      const candidate = readString(event.code);
      code = candidate === undefined || candidate === "" ? OTHER : candidate;
    }
    try {
      recordMetrics(event, entry, code);
    } catch {
      reportFailure();
    }
    if (entry !== undefined) {
      try {
        endSpan(event, entry, code);
      } catch {
        reportFailure();
      }
    }
  };

  const handler = (event: EngineEvent): void => {
    try {
      if (typeof event !== "object" || event === null) return;
      const record = event as unknown as Record<string, unknown>;
      switch (record.type) {
        case "invocation.started":
          onStarted(record);
          break;
        case "invocation.completed":
          onTerminal(record, false);
          break;
        case "invocation.failed":
          onTerminal(record, true);
          break;
        default:
          // Future event types are ignored rather than misinterpreted.
          break;
      }
    } catch {
      reportFailure();
    }
  };

  const contextFor = (requestId: string): Context => {
    try {
      const active = contextApi.active();
      const entry =
        typeof requestId === "string" ? pending.get(requestId) : undefined;
      return entry === undefined ? active : trace.setSpan(active, entry.span);
    } catch {
      reportFailure();
      return ROOT_CONTEXT;
    }
  };

  return Object.freeze(Object.assign(handler, { contextFor }));
}
