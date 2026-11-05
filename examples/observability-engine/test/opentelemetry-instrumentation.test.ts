import type { Principal } from "@invokta/core";
import { createOpenTelemetryEventHandler } from "@invokta/otel";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ObservabilityDependencies } from "../src/application/ports.js";
import {
  createObservabilityEngine,
  createProviderBackedObservabilityEngine,
} from "../src/engine.js";
import {
  type ObservabilityStub,
  startObservabilityStub,
} from "./observability-stub.js";

const capabilityId = "observability.collect-incident-context";
const principal: Principal = { id: "operator:local" };
const input = {
  service: "checkout-api",
  from: "2026-07-28T12:00:00.000Z",
  to: "2026-07-28T13:00:00.000Z",
  limit: 2,
} as const;

function createDependencies(failingLogs = false): ObservabilityDependencies {
  return {
    issues: { searchServiceIssues: async () => [] },
    logs: {
      async searchServiceLogs() {
        if (failingLogs) throw new Error("Datadog credentials sk-canary");
        return [];
      },
    },
    telemetry: {
      summarizeService: async () => ({
        transactionCount: 0,
        errorRate: 0,
        averageDurationMs: null,
      }),
    },
  };
}

let exporter: InMemorySpanExporter;
let provider: TracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
});

afterEach(async () => {
  trace.disable();
  await provider.shutdown();
});

describe("OpenTelemetry instrumentation of the observability engine", () => {
  it("traces each invocation without its input, output, or principal", async () => {
    const engine = createObservabilityEngine(createDependencies(), {
      onEvent: createOpenTelemetryEventHandler({
        tracer: provider.getTracer("observability-engine-test"),
      }),
    });

    await engine.invoke(capabilityId, input, {
      principal,
      requestId: "incident-1",
      source: "cli",
    });

    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe(`invoke ${capabilityId}`);
    expect(span?.attributes).toEqual({
      "invokta.capability.id": capabilityId,
      "invokta.execution.source": "cli",
      "invokta.request.id": "incident-1",
      "invokta.invocation.outcome": "completed",
    });
  });

  it("records a provider failure as the sanitized engine error code", async () => {
    const engine = createObservabilityEngine(createDependencies(true), {
      onEvent: createOpenTelemetryEventHandler({
        tracer: provider.getTracer("observability-engine-test"),
      }),
    });

    await expect(
      engine.invoke(capabilityId, input, { principal }),
    ).rejects.toMatchObject({ code: "EXECUTION_FAILED" });

    const [span] = exporter.getFinishedSpans();
    expect(span?.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: "EXECUTION_FAILED",
    });
    expect(span?.attributes["invokta.error.code"]).toBe("EXECUTION_FAILED");
    expect(JSON.stringify(span?.attributes)).not.toContain("sk-canary");
    expect(span?.events).toEqual([]);
  });

  describe("the provider-backed composition root", () => {
    let stub: ObservabilityStub;

    beforeEach(async () => {
      stub = await startObservabilityStub();
    });

    afterEach(async () => {
      await stub.close();
    });

    it("reports to the OpenTelemetry SDK registered by the host", async () => {
      trace.setGlobalTracerProvider(provider);
      const engine = createProviderBackedObservabilityEngine({
        SENTRY_AUTH_TOKEN: "test-sentry-token",
        SENTRY_ORG: "acme",
        SENTRY_BASE_URL: stub.baseUrl,
        DD_API_KEY: "test-datadog-api-key",
        DD_APP_KEY: "test-datadog-application-key",
        DD_BASE_URL: stub.baseUrl,
        NEW_RELIC_USER_KEY: "test-new-relic-user-key",
        NEW_RELIC_ACCOUNT_ID: "123456",
        NEW_RELIC_GRAPHQL_URL: `${stub.baseUrl}/graphql`,
      });

      await engine.invoke(capabilityId, input, { principal });

      const [span] = exporter.getFinishedSpans();
      expect(span?.name).toBe(`invoke ${capabilityId}`);
      expect(span?.instrumentationScope.name).toBe("@invokta/otel");
      expect(JSON.stringify(span?.attributes)).not.toContain("test-");
    });
  });
});
