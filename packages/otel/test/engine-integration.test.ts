import {
  createEngine,
  defineCapability,
  type EngineEvent,
  EngineError,
} from "@invokta/core";
import {
  context,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import {
  createOpenTelemetryEventHandler,
  type OpenTelemetryEventHandler,
} from "../src/index.js";
import {
  createInMemoryTelemetry,
  type InMemoryTelemetry,
  pointWith,
} from "./support/in-memory-telemetry.js";

/** The port a capability receives when it wants its own spans to nest. */
interface InvocationTracing {
  readonly tracer: Tracer;
  readonly contextFor: OpenTelemetryEventHandler["contextFor"];
}

function createTicketEngine(
  onEvent: (event: EngineEvent) => void | Promise<void>,
  tracing: InvocationTracing,
) {
  return createEngine({
    name: "ticket-engine",
    version: "1.0.0",
    onEvent,
    capabilities: {
      "support.classify-ticket": defineCapability({
        description: "Classify a support ticket.",
        input: z.object({ ticketId: z.string().min(1) }),
        output: z.object({ category: z.string() }),
        access: "authenticated",
        async run({ input, context: execution }) {
          // Without the workaround this span follows the ambient context.
          tracing.tracer.startSpan("ambient.lookup").end();
          // With the workaround it nests under the invocation span.
          await context.with(tracing.contextFor(execution.requestId), () =>
            tracing.tracer.startActiveSpan(
              "classifier.classify",
              async (span) => {
                await Promise.resolve();
                span.end();
              },
            ),
          );
          if (input.ticketId === "T-404") {
            throw new EngineError({
              code: "EXECUTION_FAILED",
              message: "Ticket not found.",
            });
          }
          return { category: "billing" };
        },
      }),
    },
  });
}

let telemetry: InMemoryTelemetry;
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
});

afterAll(() => {
  context.disable();
});

beforeEach(() => {
  telemetry = createInMemoryTelemetry();
});

afterEach(async () => {
  await telemetry.shutdown();
});

function instrumentedEngine(
  options: Parameters<typeof createOpenTelemetryEventHandler>[0] = {},
) {
  const handler = createOpenTelemetryEventHandler({
    tracer: telemetry.tracer,
    meter: telemetry.meter,
    ...options,
  });
  return {
    handler,
    engine: createTicketEngine(handler, {
      tracer: telemetry.tracer,
      contextFor: handler.contextFor,
    }),
  };
}

const principal = { id: "user:ada" };

describe("engine instrumentation through onEvent", () => {
  it("traces a successful invocation from its engine events", async () => {
    const { engine } = instrumentedEngine();

    await expect(
      engine.invoke(
        "support.classify-ticket",
        { ticketId: "T-1" },
        { principal, requestId: "request-1", source: "cli" },
      ),
    ).resolves.toEqual({ category: "billing" });

    const invocation = telemetry
      .spans()
      .find((span) => span.name === "invoke support.classify-ticket");
    expect(invocation?.attributes).toEqual({
      "invokta.capability.id": "support.classify-ticket",
      "invokta.execution.source": "cli",
      "invokta.request.id": "request-1",
      "invokta.invocation.outcome": "completed",
    });
    expect(invocation?.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("records authorization and execution failures with their codes", async () => {
    const { engine } = instrumentedEngine();

    await expect(
      engine.invoke("support.classify-ticket", { ticketId: "T-1" }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(
      engine.invoke(
        "support.classify-ticket",
        { ticketId: "T-404" },
        { principal },
      ),
    ).rejects.toMatchObject({ code: "EXECUTION_FAILED" });
    await expect(
      engine.invoke("support.missing" as "support.classify-ticket", {
        ticketId: "T-1",
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_NOT_FOUND",
    });

    const invocations = telemetry
      .spans()
      .filter((span) => span.attributes["invokta.request.id"] !== undefined);
    expect(
      invocations.map((span) => [
        span.name,
        span.status.code,
        span.attributes["invokta.error.code"],
      ]),
    ).toEqual([
      [
        "invoke support.classify-ticket",
        SpanStatusCode.ERROR,
        "UNAUTHENTICATED",
      ],
      [
        "invoke support.classify-ticket",
        SpanStatusCode.ERROR,
        "EXECUTION_FAILED",
      ],
      ["invoke", SpanStatusCode.ERROR, "CAPABILITY_NOT_FOUND"],
    ]);

    const metrics = await telemetry.metrics();
    const failures = metrics.get("invokta.invocation.failures");
    expect(
      pointWith<number>(failures, {
        "invokta.capability.id": "_OTHER",
        "invokta.execution.source": "direct",
        "invokta.error.code": "CAPABILITY_NOT_FOUND",
        "error.type": "CAPABILITY_NOT_FOUND",
      })?.value,
    ).toBe(1);
  });

  it("joins the caller's active trace", async () => {
    const { engine } = instrumentedEngine();

    await telemetry.tracer.startActiveSpan("http.request", async (caller) => {
      await engine.invoke(
        "support.classify-ticket",
        { ticketId: "T-1" },
        { principal },
      );
      caller.end();
    });

    const spans = new Map(telemetry.spans().map((span) => [span.name, span]));
    const caller = spans.get("http.request");
    const invocation = spans.get("invoke support.classify-ticket");
    expect(invocation?.spanContext().traceId).toBe(
      caller?.spanContext().traceId,
    );
    expect(invocation?.parentSpanContext?.spanId).toBe(
      caller?.spanContext().spanId,
    );
  });

  it("nests capability spans only through contextFor", async () => {
    const { engine, handler } = instrumentedEngine();

    await telemetry.tracer.startActiveSpan("http.request", async (caller) => {
      await engine.invoke(
        "support.classify-ticket",
        { ticketId: "T-1" },
        { principal, requestId: "request-1" },
      );
      caller.end();
    });

    const spans = new Map(telemetry.spans().map((span) => [span.name, span]));
    const caller = spans.get("http.request");
    const invocation = spans.get("invoke support.classify-ticket");
    // The invocation span is not the active context inside run.
    expect(spans.get("ambient.lookup")?.parentSpanContext?.spanId).toBe(
      caller?.spanContext().spanId,
    );
    // contextFor makes it the parent of the capability's own span.
    expect(spans.get("classifier.classify")?.parentSpanContext?.spanId).toBe(
      invocation?.spanContext().spanId,
    );
    // After the terminal event the request ID no longer resolves to a span.
    expect(trace.getSpan(handler.contextFor("request-1"))).toBeUndefined();
  });

  it("keeps the active context when the request ID has no pending span", () => {
    const { handler } = instrumentedEngine();
    const caller = telemetry.tracer.startSpan("caller");
    const callerContext = trace.setSpan(context.active(), caller);

    const resolved = context.with(callerContext, () =>
      handler.contextFor("unknown-request"),
    );

    expect(trace.getSpan(resolved)).toBe(caller);
    caller.end();
  });

  it("composes with an existing onEvent handler by calling it first", async () => {
    const handler = createOpenTelemetryEventHandler({
      tracer: telemetry.tracer,
      meter: telemetry.meter,
    });
    const observed: string[] = [];
    const engine = createTicketEngine(
      (event) => {
        handler(event);
        observed.push(event.type);
        return Promise.reject(new Error("existing handler failure"));
      },
      { tracer: telemetry.tracer, contextFor: handler.contextFor },
    );

    await engine.invoke(
      "support.classify-ticket",
      { ticketId: "T-1" },
      { principal },
    );

    expect(observed).toEqual(["invocation.started", "invocation.completed"]);
    expect(
      telemetry
        .spans()
        .some((span) => span.name === "invoke support.classify-ticket"),
    ).toBe(true);
  });
});
