import type { EngineEvent } from "@invokta/core";
import {
  type DiagLogger,
  DiagLogLevel,
  diag,
  type Meter,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import type { Histogram } from "@opentelemetry/sdk-metrics";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOpenTelemetryEventHandler } from "../src/index.js";
import {
  createInMemoryTelemetry,
  hrTimeToMilliseconds,
  type InMemoryTelemetry,
  pointWith,
} from "./support/in-memory-telemetry.js";

const startedAt = "2026-11-05T12:00:00.000Z";

type StartedEvent = Extract<EngineEvent, { type: "invocation.started" }>;

/** `principalId: null` omits the principal, as for an anonymous call. */
function started(
  requestId: string,
  overrides: {
    readonly capabilityId?: string;
    readonly source?: StartedEvent["source"];
    readonly principalId?: string | null;
  } = {},
): EngineEvent {
  const { principalId = "user:ada", ...rest } = overrides;
  return {
    type: "invocation.started",
    requestId,
    capabilityId: "support.classify-ticket",
    source: "mcp-http",
    startedAt,
    ...rest,
    ...(principalId === null ? {} : { principalId }),
  };
}

function completed(
  requestId: string,
  durationMs = 42.5,
  capabilityId = "support.classify-ticket",
): EngineEvent {
  return {
    type: "invocation.completed",
    requestId,
    capabilityId,
    durationMs,
  };
}

function failed(
  requestId: string,
  code: string,
  durationMs = 7.25,
  capabilityId = "support.classify-ticket",
  domainCode?: string,
): EngineEvent {
  return {
    type: "invocation.failed",
    requestId,
    capabilityId,
    durationMs,
    code,
    ...(domainCode === undefined ? {} : { domainCode }),
  } as EngineEvent;
}

let telemetry: InMemoryTelemetry;

beforeEach(() => {
  telemetry = createInMemoryTelemetry();
});

afterEach(async () => {
  await telemetry.shutdown();
});

function createHandler(
  options: Parameters<typeof createOpenTelemetryEventHandler>[0] = {},
) {
  return createOpenTelemetryEventHandler({
    tracer: telemetry.tracer,
    meter: telemetry.meter,
    ...options,
  });
}

describe("invocation spans", () => {
  it("starts one internal span per invocation and ends it on completion", () => {
    const handler = createHandler();

    handler(started("request-1"));
    expect(telemetry.spans()).toEqual([]);
    handler(completed("request-1", 42.5));

    const [span, ...others] = telemetry.spans();
    expect(others).toEqual([]);
    expect(span?.name).toBe("invoke support.classify-ticket");
    expect(span?.kind).toBe(SpanKind.INTERNAL);
    expect(span?.status).toEqual({ code: SpanStatusCode.UNSET });
    expect(span?.attributes).toEqual({
      "invokta.capability.id": "support.classify-ticket",
      "invokta.execution.source": "mcp-http",
      "invokta.request.id": "request-1",
      "invokta.invocation.outcome": "completed",
    });
    expect(hrTimeToMilliseconds(span?.startTime ?? [0, 0])).toBe(
      Date.parse(startedAt),
    );
    expect(hrTimeToMilliseconds(span?.duration ?? [0, 0])).toBeCloseTo(42.5, 6);
  });

  it("ends a failed invocation with an error status and its opaque code", () => {
    const handler = createHandler();

    handler(started("request-1"));
    handler(failed("request-1", "FORBIDDEN", 3.5));
    handler(started("request-2"));
    handler(failed("request-2", "TICKET_ALREADY_CLOSED"));

    const [forbidden, domain] = telemetry.spans();
    expect(forbidden?.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: "FORBIDDEN",
    });
    expect(forbidden?.attributes).toMatchObject({
      "invokta.invocation.outcome": "failed",
      "invokta.error.code": "FORBIDDEN",
      "error.type": "FORBIDDEN",
    });
    expect(hrTimeToMilliseconds(forbidden?.duration ?? [0, 0])).toBeCloseTo(
      3.5,
      6,
    );
    expect(domain?.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: "TICKET_ALREADY_CLOSED",
    });
    expect(domain?.attributes["invokta.error.code"]).toBe(
      "TICKET_ALREADY_CLOSED",
    );
  });

  it("records the declared domain code of a domain error", () => {
    const handler = createHandler();

    handler(started("request-1"));
    handler(
      failed("request-1", "DOMAIN_ERROR", 2, undefined, "TICKET_NOT_FOUND"),
    );
    handler(started("request-2"));
    handler(failed("request-2", "DOMAIN_ERROR", 2, undefined, "D".repeat(257)));
    handler(started("request-3"));
    handler(failed("request-3", "EXECUTION_FAILED"));

    const [domain, overLong, execution] = telemetry.spans();
    expect(domain?.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: "DOMAIN_ERROR",
    });
    expect(domain?.attributes).toMatchObject({
      "invokta.invocation.outcome": "failed",
      "invokta.error.code": "DOMAIN_ERROR",
      "error.type": "DOMAIN_ERROR",
      "invokta.error.domain_code": "TICKET_NOT_FOUND",
    });
    expect(overLong?.attributes["invokta.error.domain_code"]).toBe("_OTHER");
    expect(execution?.attributes).not.toHaveProperty(
      "invokta.error.domain_code",
    );
  });

  it("does not record the principal ID unless explicitly enabled", () => {
    const withoutPrincipal = createHandler();
    withoutPrincipal(started("request-1"));
    withoutPrincipal(completed("request-1"));

    const withPrincipal = createHandler({ recordPrincipalId: true });
    withPrincipal(started("request-2"));
    withPrincipal(completed("request-2"));
    withPrincipal(started("request-3", { principalId: null }));
    withPrincipal(completed("request-3"));

    const [hidden, recorded, anonymous] = telemetry.spans();
    expect(hidden?.attributes).not.toHaveProperty("invokta.principal.id");
    expect(recorded?.attributes["invokta.principal.id"]).toBe("user:ada");
    expect(anonymous?.attributes).not.toHaveProperty("invokta.principal.id");
  });

  it("renames the span of an unknown capability to the bare operation", () => {
    const handler = createHandler();

    handler(started("request-1", { capabilityId: "attacker.chosen-id" }));
    handler(
      failed("request-1", "CAPABILITY_NOT_FOUND", 1, "attacker.chosen-id"),
    );

    const [span] = telemetry.spans();
    expect(span?.name).toBe("invoke");
    expect(span?.attributes["invokta.capability.id"]).toBe(
      "attacker.chosen-id",
    );
  });

  it("records over-long caller-chosen strings as _OTHER from the start", () => {
    const names: string[] = [];
    const tracer: Tracer = {
      startSpan(name, options, context) {
        names.push(name);
        return telemetry.tracer.startSpan(name, options, context);
      },
      startActiveSpan: telemetry.tracer.startActiveSpan.bind(telemetry.tracer),
    };
    const handler = createOpenTelemetryEventHandler({
      tracer,
      meter: telemetry.meter,
      recordPrincipalId: true,
    });
    const capabilityId = "x".repeat(1_000_000);
    const requestId = "r".repeat(257);

    handler(
      started(requestId, {
        capabilityId,
        principalId: "p".repeat(257),
      }),
    );
    handler(failed(requestId, "CAPABILITY_NOT_FOUND", 1, capabilityId));
    handler(started("request-2", { capabilityId: "c".repeat(256) }));
    handler(completed("request-2", 1, "c".repeat(256)));

    expect(names).toEqual(["invoke", `invoke ${"c".repeat(256)}`]);
    const [overLong, limit] = telemetry.spans();
    expect(overLong?.name).toBe("invoke");
    expect(overLong?.attributes).toMatchObject({
      "invokta.capability.id": "_OTHER",
      "invokta.request.id": "_OTHER",
      "invokta.principal.id": "_OTHER",
      "invokta.error.code": "CAPABILITY_NOT_FOUND",
    });
    expect(limit?.attributes["invokta.capability.id"]).toBe("c".repeat(256));
    expect(limit?.attributes["invokta.invocation.outcome"]).toBe("completed");
  });

  it("records later execution sources such as http unchanged", async () => {
    const handler = createHandler();

    handler(started("request-1", { source: "http" }));
    handler(completed("request-1"));

    expect(telemetry.spans()[0]?.attributes["invokta.execution.source"]).toBe(
      "http",
    );
    const metrics = await telemetry.metrics();
    expect(
      metrics.get("invokta.invocations")?.points[0]?.attributes[
        "invokta.execution.source"
      ],
    ).toBe("http");
  });

  it("correlates interleaved invocations by request ID", () => {
    const handler = createHandler();

    handler(started("request-a", { capabilityId: "first" }));
    handler(started("request-b", { capabilityId: "second" }));
    handler(completed("request-a", 10, "first"));
    handler(failed("request-b", "CANCELLED", 20, "second"));

    const spans = telemetry.spans();
    expect(spans.map((span) => span.name)).toEqual([
      "invoke first",
      "invoke second",
    ]);
    expect(spans.map((span) => span.attributes["invokta.request.id"])).toEqual([
      "request-a",
      "request-b",
    ]);
    expect(spans[1]?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("creates no span for a terminal event whose start was never observed", () => {
    const handler = createHandler();

    handler(completed("unknown-request"));
    handler(failed("another-unknown-request", "EXECUTION_FAILED"));

    expect(telemetry.spans()).toEqual([]);
  });
});

describe("pending span bounds", () => {
  it("evicts the oldest pending span when the cap is reached", () => {
    const handler = createHandler({ maxPendingSpans: 2 });

    handler(started("request-1"));
    handler(started("request-2"));
    expect(telemetry.spans()).toEqual([]);
    handler(started("request-3"));

    const [evicted, ...others] = telemetry.spans();
    expect(others).toEqual([]);
    expect(evicted?.attributes).toMatchObject({
      "invokta.request.id": "request-1",
      "invokta.span.evicted": true,
    });
    expect(evicted?.attributes).not.toHaveProperty(
      "invokta.invocation.outcome",
    );
    expect(evicted?.status).toEqual({ code: SpanStatusCode.UNSET });

    handler(completed("request-1"));
    handler(completed("request-2"));
    handler(completed("request-3"));
    expect(
      telemetry.spans().map((span) => span.attributes["invokta.request.id"]),
    ).toEqual(["request-1", "request-2", "request-3"]);
  });

  it("never holds more pending spans than the configured cap", () => {
    const handler = createHandler({ maxPendingSpans: 10 });

    for (let index = 0; index < 1_000; index += 1) {
      handler(started(`request-${String(index)}`));
    }

    expect(telemetry.spans()).toHaveLength(990);
    for (let index = 0; index < 1_000; index += 1) {
      handler(completed(`request-${String(index)}`));
    }
    const completedSpans = telemetry
      .spans()
      .filter((span) => span.attributes["invokta.invocation.outcome"]);
    expect(
      completedSpans.map((span) => span.attributes["invokta.request.id"]),
    ).toEqual(
      Array.from(
        { length: 10 },
        (_, index) => `request-${String(990 + index)}`,
      ),
    );
  });

  it("keeps the source of an evicted invocation for its terminal metrics", async () => {
    const handler = createHandler({ maxPendingSpans: 1 });

    handler(started("request-1"));
    handler(started("request-2"));
    handler(failed("request-1", "CANCELLED"));
    handler(failed("request-2", "CANCELLED"));

    const metrics = await telemetry.metrics();
    const failures = metrics.get("invokta.invocation.failures");
    expect(failures?.points).toHaveLength(1);
    expect(failures?.points[0]?.attributes).toMatchObject({
      "invokta.execution.source": "mcp-http",
    });
    expect(failures?.points[0]?.value).toBe(2);
  });
});

describe("reused request IDs", () => {
  const overlapping: [string, readonly EngineEvent[]][] = [
    [
      "the first invocation finishes first",
      [
        failed("reused", "FORBIDDEN", 1_500, "a.fast"),
        completed("reused", 5_000, "b.slow"),
      ],
    ],
    [
      "the second invocation finishes first",
      [
        completed("reused", 5_000, "b.slow"),
        failed("reused", "FORBIDDEN", 1_500, "a.fast"),
      ],
    ],
  ];

  it.each(overlapping)(
    "never assigns one invocation's outcome to another when %s",
    async (_, terminals) => {
      const handler = createHandler();

      handler(started("reused", { capabilityId: "a.fast" }));
      handler(started("reused", { capabilityId: "b.slow" }));
      for (const event of terminals) handler(event);

      const spans = telemetry.spans();
      expect(spans.map((span) => span.name)).toEqual([
        "invoke a.fast",
        "invoke b.slow",
      ]);
      for (const span of spans) {
        expect(span.attributes["invokta.span.evicted"]).toBe(true);
        expect(span.attributes).not.toHaveProperty(
          "invokta.invocation.outcome",
        );
        expect(span.attributes).not.toHaveProperty("invokta.error.code");
        expect(span.status).toEqual({ code: SpanStatusCode.UNSET });
      }

      const metrics = await telemetry.metrics();
      const invocations = metrics.get("invokta.invocations");
      expect(
        pointWith<number>(invocations, {
          "invokta.capability.id": "b.slow",
          "invokta.execution.source": "mcp-http",
          "invokta.invocation.outcome": "completed",
        })?.value,
      ).toBe(1);
      expect(
        pointWith<number>(metrics.get("invokta.invocation.failures"), {
          "invokta.capability.id": "a.fast",
          "invokta.execution.source": "mcp-http",
          "invokta.error.code": "FORBIDDEN",
          "error.type": "FORBIDDEN",
        })?.value,
      ).toBe(1);
    },
  );

  it("ends every span of a three-way overlap without an outcome", async () => {
    const handler = createHandler();

    handler(started("reused", { capabilityId: "a" }));
    handler(started("reused", { capabilityId: "b" }));
    handler(started("reused", { capabilityId: "c" }));
    handler(completed("reused", 1, "b"));
    expect(trace.getSpan(handler.contextFor("reused"))).toBeUndefined();
    handler(failed("reused", "CANCELLED", 1, "c"));
    expect(trace.getSpan(handler.contextFor("reused"))).toBeUndefined();
    handler(completed("reused", 1, "a"));
    handler(started("reused", { capabilityId: "d" }));
    handler(completed("reused", 1, "d"));

    const spans = telemetry.spans();
    expect(spans.map((span) => span.name)).toEqual([
      "invoke a",
      "invoke b",
      "invoke c",
      "invoke d",
    ]);
    for (const span of spans.slice(0, 3)) {
      expect(span.attributes["invokta.span.evicted"]).toBe(true);
      expect(span.attributes).not.toHaveProperty("invokta.invocation.outcome");
    }
    expect(spans[3]?.attributes).not.toHaveProperty("invokta.span.evicted");
    expect(spans[3]?.attributes["invokta.invocation.outcome"]).toBe(
      "completed",
    );

    const metrics = await telemetry.metrics();
    const total = (metrics.get("invokta.invocations")?.points ?? []).reduce(
      (sum, point) => sum + (point.value as number),
      0,
    );
    expect(total).toBe(4);
  });

  it("omits the source from metrics of overlapping calls with different sources", async () => {
    const handler = createHandler();

    handler(started("reused", { capabilityId: "a", source: "cli" }));
    handler(started("reused", { capabilityId: "b", source: "mcp-http" }));
    handler(completed("reused", 1, "a"));
    handler(completed("reused", 1, "b"));

    const metrics = await telemetry.metrics();
    const points = metrics.get("invokta.invocations")?.points ?? [];
    expect(points).toHaveLength(2);
    for (const point of points) {
      expect(point.attributes).not.toHaveProperty("invokta.execution.source");
    }
    const spans = telemetry.spans();
    expect(
      spans.map((span) => span.attributes["invokta.execution.source"]),
    ).toEqual(["cli", "mcp-http"]);
  });

  it("resolves no invocation span for a reused request ID while the calls overlap", () => {
    const handler = createHandler();

    handler(started("reused", { capabilityId: "a" }));
    expect(trace.getSpan(handler.contextFor("reused"))).toBeDefined();
    handler(started("reused", { capabilityId: "b" }));
    expect(trace.getSpan(handler.contextFor("reused"))).toBeUndefined();
    handler(completed("reused", 1, "a"));
    expect(trace.getSpan(handler.contextFor("reused"))).toBeUndefined();
    handler(completed("reused", 1, "b"));
    expect(trace.getSpan(handler.contextFor("reused"))).toBeUndefined();
  });

  it("traces a request ID normally again once every earlier call finished", () => {
    const handler = createHandler();

    handler(started("reused", { capabilityId: "a" }));
    handler(started("reused", { capabilityId: "b" }));
    handler(completed("reused", 1, "a"));
    handler(completed("reused", 1, "b"));
    handler(started("reused", { capabilityId: "c" }));
    expect(trace.getSpan(handler.contextFor("reused"))).toBeDefined();
    handler(failed("reused", "INPUT_INVALID", 1, "c"));

    const last = telemetry.spans().at(-1);
    expect(last?.name).toBe("invoke c");
    expect(last?.attributes).not.toHaveProperty("invokta.span.evicted");
    expect(last?.attributes["invokta.error.code"]).toBe("INPUT_INVALID");
  });

  it("treats a request ID as reused when the earlier call's span failed to start", () => {
    let failNext = true;
    const tracer: Tracer = {
      startSpan(name, options, context) {
        if (failNext) {
          failNext = false;
          throw new Error("tracer failure");
        }
        return telemetry.tracer.startSpan(name, options, context);
      },
      startActiveSpan: telemetry.tracer.startActiveSpan.bind(telemetry.tracer),
    };
    const handler = createOpenTelemetryEventHandler({
      tracer,
      meter: telemetry.meter,
    });

    handler(started("reused", { capabilityId: "a" }));
    handler(started("reused", { capabilityId: "b" }));
    handler(failed("reused", "FORBIDDEN", 1, "a"));

    const [span, ...others] = telemetry.spans();
    expect(others).toEqual([]);
    expect(span?.name).toBe("invoke b");
    expect(span?.attributes["invokta.span.evicted"]).toBe(true);
    expect(span?.status).toEqual({ code: SpanStatusCode.UNSET });
  });

  it("treats a request ID as reused while an evicted call is still running", () => {
    const handler = createHandler({ maxPendingSpans: 1 });

    handler(started("reused", { capabilityId: "a" }));
    handler(started("other", { capabilityId: "b" }));
    handler(started("reused", { capabilityId: "c" }));
    handler(failed("reused", "FORBIDDEN", 1, "a"));

    const spans = telemetry.spans();
    expect(spans.map((span) => span.name)).toEqual([
      "invoke a",
      "invoke b",
      "invoke c",
    ]);
    expect(spans.every((span) => span.attributes["invokta.span.evicted"])).toBe(
      true,
    );
  });
});

describe("invocation metrics", () => {
  it("records invocation count, duration, and failures by error code", async () => {
    const handler = createHandler();

    handler(started("request-1"));
    handler(completed("request-1", 250));
    handler(started("request-2"));
    handler(completed("request-2", 750));
    handler(started("request-3", { source: "cli" }));
    handler(failed("request-3", "INPUT_INVALID", 2));
    handler(started("request-4", { source: "cli" }));
    handler(failed("request-4", "INPUT_INVALID", 4));

    const metrics = await telemetry.metrics();
    const success = {
      "invokta.capability.id": "support.classify-ticket",
      "invokta.execution.source": "mcp-http",
      "invokta.invocation.outcome": "completed",
    };
    const failure = {
      "invokta.capability.id": "support.classify-ticket",
      "invokta.execution.source": "cli",
      "invokta.error.code": "INPUT_INVALID",
      "error.type": "INPUT_INVALID",
    };

    const invocations = metrics.get("invokta.invocations");
    expect(invocations?.unit).toBe("{invocation}");
    expect(pointWith<number>(invocations, success)?.value).toBe(2);
    expect(
      pointWith<number>(invocations, {
        ...failure,
        "invokta.invocation.outcome": "failed",
      })?.value,
    ).toBe(2);

    const duration = metrics.get("invokta.invocation.duration");
    expect(duration?.unit).toBe("s");
    const successDuration = pointWith<Histogram>(duration, success)?.value;
    expect(successDuration?.count).toBe(2);
    expect(successDuration?.sum).toBeCloseTo(1, 9);
    expect(successDuration?.buckets.boundaries).toEqual([
      0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
      30, 60, 120, 300,
    ]);
    expect(
      pointWith<Histogram>(duration, {
        ...failure,
        "invokta.invocation.outcome": "failed",
      })?.value.sum,
    ).toBeCloseTo(0.006, 9);

    const failures = metrics.get("invokta.invocation.failures");
    expect(failures?.unit).toBe("{failure}");
    expect(failures?.points).toHaveLength(1);
    expect(pointWith<number>(failures, failure)?.value).toBe(2);
  });

  it("records domain codes on the failures counter only, with bounded values", async () => {
    const handler = createHandler({ maxMetricAttributeValues: 2 });
    const domainCodes = [
      "TICKET_NOT_FOUND",
      "TICKET_CLOSED",
      "TICKET_LOCKED",
      "TICKET_NOT_FOUND",
    ];

    domainCodes.forEach((domainCode, index) => {
      const requestId = `request-${String(index)}`;
      handler(started(requestId));
      handler(failed(requestId, "DOMAIN_ERROR", 1, undefined, domainCode));
    });
    handler(started("request-execution"));
    handler(failed("request-execution", "EXECUTION_FAILED"));

    const metrics = await telemetry.metrics();
    const failures = metrics.get("invokta.invocation.failures");
    const recorded = failures?.points.map((point) => [
      point.attributes["invokta.error.code"],
      point.attributes["invokta.error.domain_code"],
      point.value,
    ]);
    expect(recorded).toEqual(
      expect.arrayContaining([
        ["DOMAIN_ERROR", "TICKET_NOT_FOUND", 2],
        ["DOMAIN_ERROR", "TICKET_CLOSED", 1],
        ["DOMAIN_ERROR", "_OTHER", 1],
        ["EXECUTION_FAILED", undefined, 1],
      ]),
    );
    expect(recorded).toHaveLength(4);
    for (const name of ["invokta.invocations", "invokta.invocation.duration"]) {
      for (const point of metrics.get(name)?.points ?? []) {
        expect(point.attributes, name).not.toHaveProperty(
          "invokta.error.domain_code",
        );
      }
    }
  });

  it("records terminal metrics even when the start was not observed", async () => {
    const handler = createHandler();

    handler(failed("orphan", "EXECUTION_FAILED", 1));

    const metrics = await telemetry.metrics();
    expect(
      pointWith<number>(metrics.get("invokta.invocation.failures"), {
        "invokta.capability.id": "support.classify-ticket",
        "invokta.error.code": "EXECUTION_FAILED",
        "error.type": "EXECUTION_FAILED",
      })?.value,
    ).toBe(1);
  });

  it("collapses caller-chosen capability IDs of failed lookups", async () => {
    const handler = createHandler();

    for (let index = 0; index < 50; index += 1) {
      const requestId = `request-${String(index)}`;
      const capabilityId = `unknown.capability-${String(index)}`;
      handler(started(requestId, { capabilityId }));
      handler(failed(requestId, "CAPABILITY_NOT_FOUND", 1, capabilityId));
    }

    const metrics = await telemetry.metrics();
    const failures = metrics.get("invokta.invocation.failures");
    expect(failures?.points).toHaveLength(1);
    expect(failures?.points[0]?.attributes).toMatchObject({
      "invokta.capability.id": "_OTHER",
      "invokta.error.code": "CAPABILITY_NOT_FOUND",
    });
  });

  it("bounds the distinct values recorded for every metric attribute", async () => {
    const handler = createHandler({ maxMetricAttributeValues: 2 });

    const cases = [
      ["a", "direct", "CODE_A"],
      ["b", "cli", "CODE_B"],
      ["c", "mcp-stdio", "CODE_C"],
      ["a", "direct", "CODE_A"],
      ["x".repeat(257), "direct", "CODE_A"],
    ] as const;
    cases.forEach(([capabilityId, source, code], index) => {
      const requestId = `request-${String(index)}`;
      handler(started(requestId, { capabilityId, source }));
      handler(failed(requestId, code, 1, capabilityId));
    });

    const metrics = await telemetry.metrics();
    const failures = metrics.get("invokta.invocation.failures");
    const recorded = failures?.points.map((point) => [
      point.attributes["invokta.capability.id"],
      point.attributes["invokta.execution.source"],
      point.attributes["invokta.error.code"],
      point.value,
    ]);
    expect(recorded).toEqual(
      expect.arrayContaining([
        ["a", "direct", "CODE_A", 2],
        ["b", "cli", "CODE_B", 1],
        ["_OTHER", "_OTHER", "_OTHER", 1],
        ["_OTHER", "direct", "CODE_A", 1],
      ]),
    );
    expect(recorded).toHaveLength(4);
  });
});

describe("robustness", () => {
  it("never throws for malformed, unknown, or future events", () => {
    const handler = createHandler();
    const malformed = [
      null,
      undefined,
      42,
      "invocation.started",
      {},
      { type: "invocation.progress", requestId: "request-1" },
      { type: "invocation.started" },
      { type: "invocation.started", requestId: 7, startedAt: "not a date" },
      {
        type: "invocation.started",
        requestId: "request-1",
        capabilityId: 5,
        source: {},
        startedAt: "not a date",
      },
      { type: "invocation.completed", requestId: "request-1", durationMs: -1 },
      { type: "invocation.failed", requestId: "request-1", code: 404 },
      {
        get type(): string {
          throw new Error("hostile event");
        },
      },
    ];

    for (const event of malformed) {
      expect(() => handler(event as EngineEvent)).not.toThrow();
    }
  });

  it("contains failures from the tracer, spans, and meter", () => {
    const hostileTracer = {
      startSpan() {
        throw new Error("tracer failure");
      },
      startActiveSpan() {
        throw new Error("tracer failure");
      },
    } as unknown as Tracer;
    const hostileMeter = {
      createCounter: () => ({
        add() {
          throw new Error("meter failure");
        },
      }),
      createHistogram: () => ({
        record() {
          throw new Error("meter failure");
        },
      }),
    } as unknown as Meter;

    const handler = createOpenTelemetryEventHandler({
      tracer: hostileTracer,
      meter: hostileMeter,
    });
    expect(() => handler(started("request-1"))).not.toThrow();
    expect(() => handler(failed("request-1", "FORBIDDEN"))).not.toThrow();
    expect(() => handler.contextFor("request-1")).not.toThrow();
  });

  it("still ends the span when recording metrics fails", () => {
    const hostileMeter = {
      createCounter: () => ({
        add() {
          throw new Error("meter failure");
        },
      }),
      createHistogram: () => ({
        record() {
          throw new Error("meter failure");
        },
      }),
    } as unknown as Meter;
    const handler = createOpenTelemetryEventHandler({
      tracer: telemetry.tracer,
      meter: hostileMeter,
    });

    handler(started("request-1"));
    handler(completed("request-1"));

    expect(telemetry.spans()).toHaveLength(1);
  });

  it("returns void so composition with another handler stays trivial", () => {
    const handler = createHandler();

    expect(handler(started("request-1"))).toBeUndefined();
    expect(handler(completed("request-1"))).toBeUndefined();
  });

  it("reports each contained failure as one fixed, payload-free diag warning", () => {
    const warnings: unknown[][] = [];
    const ignore = () => undefined;
    const logger: DiagLogger = {
      error: ignore,
      warn: (...args: unknown[]) => {
        warnings.push(args);
      },
      info: ignore,
      debug: ignore,
      verbose: ignore,
    };
    diag.setLogger(logger, DiagLogLevel.WARN);
    try {
      const hostileMeter = {
        createCounter: () => ({
          add() {
            throw new Error("meter failure sk-canary");
          },
        }),
        createHistogram: () => ({ record: () => undefined }),
      } as unknown as Meter;
      const handler = createOpenTelemetryEventHandler({
        tracer: telemetry.tracer,
        meter: hostileMeter,
      });

      for (let index = 0; index < 3; index += 1) {
        handler(started(`request-${String(index)}`));
        handler(completed(`request-${String(index)}`));
      }
    } finally {
      diag.disable();
    }

    expect(warnings).toEqual(
      Array.from({ length: 3 }, () => [
        "@invokta/otel could not record an engine event.",
      ]),
    );
    expect(telemetry.spans()).toHaveLength(3);
  });

  it("is frozen", () => {
    const handler = createHandler();

    expect(Object.isFrozen(handler)).toBe(true);
  });
});

describe("options", () => {
  it.each([
    [
      { maxPendingSpans: 0 },
      "maxPendingSpans must be a positive safe integer.",
    ],
    [
      { maxPendingSpans: -1 },
      "maxPendingSpans must be a positive safe integer.",
    ],
    [
      { maxPendingSpans: 1.5 },
      "maxPendingSpans must be a positive safe integer.",
    ],
    [
      { maxPendingSpans: Number.POSITIVE_INFINITY },
      "maxPendingSpans must be a positive safe integer.",
    ],
    [
      { maxPendingSpans: "10" },
      "maxPendingSpans must be a positive safe integer.",
    ],
    [
      { maxMetricAttributeValues: 0 },
      "maxMetricAttributeValues must be a positive safe integer.",
    ],
    [
      { maxMetricAttributeValues: Number.NaN },
      "maxMetricAttributeValues must be a positive safe integer.",
    ],
    [{ recordPrincipalId: "yes" }, "recordPrincipalId must be a boolean."],
    [{ tracer: {} }, "tracer must be an OpenTelemetry Tracer."],
    [{ tracer: null }, "tracer must be an OpenTelemetry Tracer."],
    [
      { meter: { createCounter: () => undefined } },
      "meter must be an OpenTelemetry Meter.",
    ],
  ])("rejects %j", (options, message) => {
    expect(() =>
      createOpenTelemetryEventHandler(
        options as Parameters<typeof createOpenTelemetryEventHandler>[0],
      ),
    ).toThrow(new TypeError(message));
  });

  it("rejects options that are not an object", () => {
    expect(() =>
      createOpenTelemetryEventHandler(
        "options" as unknown as Parameters<
          typeof createOpenTelemetryEventHandler
        >[0],
      ),
    ).toThrow(
      new TypeError("OpenTelemetry event handler options must be an object."),
    );
  });

  it("reads every option exactly once", () => {
    const reads: string[] = [];
    const options = new Proxy(
      {
        tracer: telemetry.tracer,
        meter: telemetry.meter,
        recordPrincipalId: true,
        maxPendingSpans: 5,
        maxMetricAttributeValues: 5,
      },
      {
        get(target, property, receiver) {
          reads.push(String(property));
          return Reflect.get(target, property, receiver);
        },
      },
    );

    createOpenTelemetryEventHandler(options);

    expect(reads.sort()).toEqual([
      "maxMetricAttributeValues",
      "maxPendingSpans",
      "meter",
      "recordPrincipalId",
      "tracer",
    ]);
  });
});
