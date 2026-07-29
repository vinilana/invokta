import type { EngineError } from "@ai-engine/core";
import { afterEach, describe, expect, it } from "vitest";

import { createDatadogLogStore } from "../src/infrastructure/datadog-log-store.js";
import { createNewRelicTelemetryReader } from "../src/infrastructure/new-relic-telemetry-reader.js";
import { createSentryIssueTracker } from "../src/infrastructure/sentry-issue-tracker.js";
import {
  type ObservabilityStub,
  type ObservabilityStubOptions,
  startObservabilityStub,
} from "./observability-stub.js";

const request = {
  service: "checkout-api",
  from: "2026-07-28T12:00:00.000Z",
  to: "2026-07-28T13:00:00.000Z",
  limit: 2,
} as const;
const sentryToken = "test-sentry-token";
const datadogApiKey = "test-datadog-api-key";
const datadogApplicationKey = "test-datadog-application-key";
const newRelicUserKey = "test-new-relic-user-key";

let stub: ObservabilityStub | undefined;

async function startStub(
  options: ObservabilityStubOptions = {},
): Promise<ObservabilityStub> {
  stub = await startObservabilityStub(options);
  return stub;
}

afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

describe("the Sentry issue tracker adapter", () => {
  it("queries organization issues with a bearer credential and maps the response", async () => {
    const server = await startStub();

    const issues = await createSentryIssueTracker({
      authToken: sentryToken,
      organization: "acme",
      baseUrl: server.baseUrl,
    }).searchServiceIssues(request, {
      signal: new AbortController().signal,
    });

    expect(issues).toEqual([
      {
        id: "SENTRY-1",
        title: "Payment confirmation failed",
        status: "unresolved",
        project: "checkout-api",
        lastSeen: "2026-07-28T12:45:00.000Z",
        eventCount: 42,
        url: "https://sentry.example/issues/SENTRY-1",
      },
    ]);
    expect(server.requests[0]).toMatchObject({
      method: "GET",
      path: "/api/0/organizations/acme/issues/",
      authorization: `Bearer ${sentryToken}`,
    });
    expect(server.requests[0]?.query).toEqual({
      end: request.to,
      limit: "2",
      project: request.service,
      query: "is:unresolved",
      sort: "date",
      start: request.from,
    });
  });
});

describe("the Datadog log store adapter", () => {
  it("searches bounded service logs with both Datadog credentials", async () => {
    const server = await startStub();

    const logs = await createDatadogLogStore({
      apiKey: datadogApiKey,
      applicationKey: datadogApplicationKey,
      baseUrl: server.baseUrl,
    }).searchServiceLogs(request, {
      signal: new AbortController().signal,
    });

    expect(logs).toEqual([
      {
        id: "DD-1",
        timestamp: "2026-07-28T12:40:00.000Z",
        service: "checkout-api",
        severity: "error",
        message: "Payment confirmation failed",
      },
    ]);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      path: "/api/v2/logs/events/search",
      datadogApiKey,
      datadogApplicationKey,
      body: {
        filter: {
          query: "service:checkout-api",
          from: request.from,
          to: request.to,
        },
        page: { limit: 2 },
        sort: "-timestamp",
      },
    });
  });
});

describe("the New Relic telemetry reader adapter", () => {
  it("runs a bounded NRQL aggregate through NerdGraph and maps its row", async () => {
    const server = await startStub();

    const summary = await createNewRelicTelemetryReader({
      userKey: newRelicUserKey,
      accountId: 123_456,
      graphqlUrl: `${server.baseUrl}/graphql`,
    }).summarizeService(request, {
      signal: new AbortController().signal,
    });

    expect(summary).toEqual({
      transactionCount: 125,
      errorRate: 2.5,
      averageDurationMs: 420,
    });
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      path: "/graphql",
      newRelicUserKey,
    });
    const body = server.requests[0]?.body as { readonly query?: unknown };
    expect(body.query).toBeTypeOf("string");
    expect(body.query).toContain("account(id: 123456)");
    expect(body.query).toContain("WHERE appName = 'checkout-api'");
    expect(body.query).toContain(
      `SINCE ${String(Date.parse(request.from))} UNTIL ${String(Date.parse(request.to))}`,
    );
  });
});

describe("provider failure boundaries", () => {
  it.each([
    ["sentry", { sentryStatus: 401 }],
    ["datadog", { datadogStatus: 429 }],
    ["new-relic", { newRelicStatus: 503 }],
  ] as const)(
    "sanitizes a %s HTTP rejection without exposing credentials",
    async (provider, options) => {
      const server = await startStub(options);
      const controller = new AbortController();
      const operation =
        provider === "sentry"
          ? createSentryIssueTracker({
              authToken: sentryToken,
              organization: "acme",
              baseUrl: server.baseUrl,
            }).searchServiceIssues(request, { signal: controller.signal })
          : provider === "datadog"
            ? createDatadogLogStore({
                apiKey: datadogApiKey,
                applicationKey: datadogApplicationKey,
                baseUrl: server.baseUrl,
              }).searchServiceLogs(request, { signal: controller.signal })
            : createNewRelicTelemetryReader({
                userKey: newRelicUserKey,
                accountId: 123_456,
                graphqlUrl: `${server.baseUrl}/graphql`,
              }).summarizeService(request, { signal: controller.signal });

      const failure = await operation.then(
        () => undefined,
        (error: unknown) => error as EngineError,
      );

      expect(failure).toMatchObject({
        code: "EXECUTION_FAILED",
        publicDetails: {
          provider,
          status:
            provider === "sentry" ? 401 : provider === "datadog" ? 429 : 503,
        },
      });
      const publicFailure = JSON.stringify({
        message: failure?.message,
        publicDetails: failure?.publicDetails,
      });
      expect(publicFailure).not.toContain(sentryToken);
      expect(publicFailure).not.toContain(datadogApiKey);
      expect(publicFailure).not.toContain(datadogApplicationKey);
      expect(publicFailure).not.toContain(newRelicUserKey);
    },
  );

  it("treats NerdGraph errors in a successful HTTP response as a provider failure", async () => {
    const server = await startStub({ newRelicGraphqlError: true });

    await expect(
      createNewRelicTelemetryReader({
        userKey: newRelicUserKey,
        accountId: 123_456,
        graphqlUrl: `${server.baseUrl}/graphql`,
      }).summarizeService(request, {
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      message: "New Relic returned an unsuccessful result.",
      publicDetails: { provider: "new-relic" },
    });
  });

  it("fails fast on missing provider configuration", () => {
    expect(() =>
      createSentryIssueTracker({ authToken: "", organization: "acme" }),
    ).toThrow("A Sentry auth token is required.");
    expect(() =>
      createDatadogLogStore({ apiKey: "", applicationKey: "app-key" }),
    ).toThrow("A Datadog API key is required.");
    expect(() =>
      createNewRelicTelemetryReader({ userKey: "key", accountId: 0 }),
    ).toThrow("A positive New Relic account ID is required.");
  });
});
