import { EngineError, type Principal } from "@invokta/core";
import { toMcpToolName, validateMcpToolCatalog } from "@invokta/mcp";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type {
  IssueTracker,
  LogStore,
  ObservabilityDependencies,
  TelemetryReader,
} from "../src/application/ports.js";
import { createObservabilityEngine } from "../src/engine.js";

const principal: Principal = { id: "operator:local" };
const input = {
  service: "checkout-api",
  from: "2026-07-28T12:00:00.000Z",
  to: "2026-07-28T13:00:00.000Z",
  limit: 2,
} as const;

function createDependencies(): ObservabilityDependencies {
  const issues: IssueTracker = {
    searchServiceIssues: vi.fn(async () => [
      {
        id: "SENTRY-1",
        title: "Payment confirmation failed",
        status: "unresolved",
        project: "checkout-api",
        lastSeen: "2026-07-28T12:45:00.000Z",
        eventCount: 42,
        url: "https://sentry.example/issues/SENTRY-1",
      },
    ]),
  };
  const logs: LogStore = {
    searchServiceLogs: vi.fn(async () => [
      {
        id: "DD-1",
        timestamp: "2026-07-28T12:40:00.000Z",
        service: "checkout-api",
        severity: "error",
        message: "Payment confirmation failed",
      },
    ]),
  };
  const telemetry: TelemetryReader = {
    summarizeService: vi.fn(async () => ({
      transactionCount: 125,
      errorRate: 2.5,
      averageDurationMs: 420,
    })),
  };
  return { issues, logs, telemetry };
}

describe("the observability engine example", () => {
  it("collects one normalized incident context through injected provider ports", async () => {
    const dependencies = createDependencies();
    const engine = createObservabilityEngine(dependencies);

    const result = await engine.invoke(
      "observability.collect-incident-context",
      input,
      { source: "direct", principal },
    );

    expectTypeOf(result).toEqualTypeOf<{
      service: string;
      from: string;
      to: string;
      issues: Array<{
        id: string;
        title: string;
        status: string;
        project: string;
        lastSeen: string;
        eventCount: number;
        url: string | null;
      }>;
      logs: Array<{
        id: string;
        timestamp: string;
        service: string;
        severity: string | null;
        message: string;
      }>;
      telemetry: {
        transactionCount: number;
        errorRate: number;
        averageDurationMs: number | null;
      };
    }>();
    expect(result).toEqual({
      service: input.service,
      from: input.from,
      to: input.to,
      issues: [
        {
          id: "SENTRY-1",
          title: "Payment confirmation failed",
          status: "unresolved",
          project: "checkout-api",
          lastSeen: "2026-07-28T12:45:00.000Z",
          eventCount: 42,
          url: "https://sentry.example/issues/SENTRY-1",
        },
      ],
      logs: [
        {
          id: "DD-1",
          timestamp: "2026-07-28T12:40:00.000Z",
          service: "checkout-api",
          severity: "error",
          message: "Payment confirmation failed",
        },
      ],
      telemetry: {
        transactionCount: 125,
        errorRate: 2.5,
        averageDurationMs: 420,
      },
    });
    const expectedRequest = input;
    expect(dependencies.issues.searchServiceIssues).toHaveBeenCalledWith(
      expectedRequest,
      { signal: expect.any(AbortSignal) },
    );
    expect(dependencies.logs.searchServiceLogs).toHaveBeenCalledWith(
      expectedRequest,
      { signal: expect.any(AbortSignal) },
    );
    expect(dependencies.telemetry.summarizeService).toHaveBeenCalledWith(
      expectedRequest,
      { signal: expect.any(AbortSignal) },
    );
  });

  it("applies the default provider result limit", async () => {
    const dependencies = createDependencies();
    const engine = createObservabilityEngine(dependencies);

    await engine.invoke(
      "observability.collect-incident-context",
      {
        service: input.service,
        from: input.from,
        to: input.to,
      },
      { source: "direct", principal },
    );

    expect(dependencies.issues.searchServiceIssues).toHaveBeenCalledWith(
      { ...input, limit: 20 },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("enforces the requested result limit when a provider returns too many items", async () => {
    const dependencies = createDependencies();
    const issue = await dependencies.issues.searchServiceIssues(input, {
      signal: new AbortController().signal,
    });
    const log = await dependencies.logs.searchServiceLogs(input, {
      signal: new AbortController().signal,
    });
    dependencies.issues.searchServiceIssues = vi.fn(async () => [
      ...issue,
      ...issue,
    ]);
    dependencies.logs.searchServiceLogs = vi.fn(async () => [...log, ...log]);
    const engine = createObservabilityEngine(dependencies);

    const result = await engine.invoke(
      "observability.collect-incident-context",
      { ...input, limit: 1 },
      { source: "direct", principal },
    );

    expect(result.issues).toHaveLength(1);
    expect(result.logs).toHaveLength(1);
  });

  it.each([
    ["an empty service", { ...input, service: "" }],
    ["an unsafe service identifier", { ...input, service: "checkout api" }],
    ["an inverted time range", { ...input, from: input.to, to: input.from }],
    [
      "a time range longer than seven days",
      { ...input, from: "2026-07-20T12:00:00.000Z" },
    ],
    ["a provider limit above 100", { ...input, limit: 101 }],
  ])("rejects %s before any provider request", async (_description, value) => {
    const dependencies = createDependencies();
    const engine = createObservabilityEngine(dependencies);

    await expect(
      engine.invoke("observability.collect-incident-context", value, {
        source: "direct",
        principal,
      }),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(dependencies.issues.searchServiceIssues).not.toHaveBeenCalled();
    expect(dependencies.logs.searchServiceLogs).not.toHaveBeenCalled();
    expect(dependencies.telemetry.summarizeService).not.toHaveBeenCalled();
  });

  it("requires an authenticated principal before provider access", async () => {
    const dependencies = createDependencies();
    const engine = createObservabilityEngine(dependencies);

    await expect(
      engine.invoke("observability.collect-incident-context", input, {
        source: "direct",
        principal: null,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(dependencies.issues.searchServiceIssues).not.toHaveBeenCalled();
    expect(dependencies.logs.searchServiceLogs).not.toHaveBeenCalled();
    expect(dependencies.telemetry.summarizeService).not.toHaveBeenCalled();
  });

  it("propagates caller cancellation to every provider port", async () => {
    const dependencies = createDependencies();
    const providerSignals: AbortSignal[] = [];
    const waitForCancellation = async (
      _request: unknown,
      { signal }: { readonly signal: AbortSignal },
    ): Promise<never> => {
      providerSignals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    };
    dependencies.issues.searchServiceIssues = vi.fn(waitForCancellation);
    dependencies.logs.searchServiceLogs = vi.fn(waitForCancellation);
    dependencies.telemetry.summarizeService = vi.fn(waitForCancellation);
    const engine = createObservabilityEngine(dependencies);
    const controller = new AbortController();

    const invocation = engine.invoke(
      "observability.collect-incident-context",
      input,
      { source: "direct", principal, signal: controller.signal },
    );
    await vi.waitFor(() => expect(providerSignals).toHaveLength(3));
    controller.abort(new Error("Incident investigation stopped."));

    await expect(invocation).rejects.toMatchObject({ code: "CANCELLED" });
    expect(providerSignals.every(({ aborted }) => aborted)).toBe(true);
  });

  it("aborts sibling provider work when one provider fails", async () => {
    const dependencies = createDependencies();
    const siblingSignals: AbortSignal[] = [];
    dependencies.issues.searchServiceIssues = vi.fn(async () => {
      throw new EngineError({
        code: "EXECUTION_FAILED",
        message: "Sentry rejected the request.",
        publicDetails: { provider: "sentry", status: 503 },
      });
    });
    const waitForSiblingAbort = async (
      _request: unknown,
      { signal }: { readonly signal: AbortSignal },
    ): Promise<never> => {
      siblingSignals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    };
    dependencies.logs.searchServiceLogs = vi.fn(waitForSiblingAbort);
    dependencies.telemetry.summarizeService = vi.fn(waitForSiblingAbort);
    const engine = createObservabilityEngine(dependencies);

    await expect(
      engine.invoke("observability.collect-incident-context", input, {
        source: "direct",
        principal,
      }),
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      publicDetails: { provider: "sentry", status: 503 },
    });
    expect(siblingSignals).toHaveLength(2);
    expect(siblingSignals.every(({ aborted }) => aborted)).toBe(true);
  });

  it("rejects provider data that breaks the normalized output contract", async () => {
    const dependencies = createDependencies();
    dependencies.telemetry.summarizeService = vi.fn(async () => ({
      transactionCount: 1,
      errorRate: 101,
      averageDurationMs: 10,
    }));
    const engine = createObservabilityEngine(dependencies);

    await expect(
      engine.invoke("observability.collect-incident-context", input, {
        source: "direct",
        principal,
      }),
    ).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
  });

  it("publishes one bounded read-only open-world capability", () => {
    const engine = createObservabilityEngine(createDependencies());

    expect(engine.list().map(({ id }) => id)).toEqual([
      "observability.collect-incident-context",
    ]);
    expect(
      engine.describe("observability.collect-incident-context"),
    ).toMatchObject({
      id: "observability.collect-incident-context",
      title: "Collect incident context",
      timeoutMs: 30_000,
      annotations: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: true,
      },
      inputSchema: {
        type: "object",
        required: ["service", "from", "to"],
      },
      outputSchema: { type: "object" },
    });
  });

  it("publishes one unique portable MCP tool name for every capability", () => {
    const engine = createObservabilityEngine(createDependencies());

    // The same catalog construction `invokta check-mcp` runs as a build-time
    // gate: a capability ID whose derived alias collides with another one's
    // fails here instead of when an MCP adapter starts.
    expect(() => {
      validateMcpToolCatalog(engine);
    }).not.toThrow();
    expect(
      engine.list().map((capability) => toMcpToolName(capability.id)),
    ).toEqual(["observability_collect-incident-context"]);
  });
});
