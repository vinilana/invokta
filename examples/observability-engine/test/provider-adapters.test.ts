import type { EngineError } from "@invokta/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDatadogLogStore,
  datadogConnector,
} from "../src/infrastructure/datadog-log-store.js";
import {
  createNewRelicTelemetryReader,
  newRelicConnector,
} from "../src/infrastructure/new-relic-telemetry-reader.js";
import { requestProviderJson } from "../src/infrastructure/provider-http.js";
import {
  createSentryIssueTracker,
  sentryConnector,
} from "../src/infrastructure/sentry-issue-tracker.js";
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
  vi.unstubAllGlobals();
  await stub?.close();
  stub = undefined;
});

describe("typed observability connectors", () => {
  it("constructs one port per provider without network I/O", () => {
    let requests = 0;
    const fetchImplementation: typeof fetch = async () => {
      requests += 1;
      return new Response();
    };
    const sentry = sentryConnector.create(
      { authToken: "sentry-token", organization: "acme" },
      { fetch: fetchImplementation },
    );
    const datadog = datadogConnector.create(
      { apiKey: "dd-key", applicationKey: "dd-app-key" },
      { fetch: fetchImplementation },
    );
    const newRelic = newRelicConnector.create(
      { userKey: "nr-key", accountId: 123 },
      { fetch: fetchImplementation },
    );

    expect(sentryConnector.name).toBe("sentry");
    expect(datadogConnector.name).toBe("datadog");
    expect(newRelicConnector.name).toBe("new-relic");
    expect(Object.keys(sentry.ports)).toEqual(["issues"]);
    expect(Object.keys(datadog.ports)).toEqual(["logs"]);
    expect(Object.keys(newRelic.ports)).toEqual(["telemetry"]);
    expect(requests).toBe(0);
  });

  it("sanitizes invalid private connector configuration", () => {
    const dependencies = { fetch: globalThis.fetch };

    expect(() =>
      sentryConnector.create(
        { authToken: "", organization: "acme" },
        dependencies,
      ),
    ).toThrow("Connector configuration is invalid.");
    expect(() =>
      sentryConnector.create(
        {
          authToken: "token",
          organization: "acme",
          baseUrl: "https://secret@example.com",
        },
        dependencies,
      ),
    ).toThrow("Connector configuration is invalid.");
    expect(() =>
      datadogConnector.create(
        { apiKey: "", applicationKey: "app-key" },
        dependencies,
      ),
    ).toThrow("Connector configuration is invalid.");
    expect(() =>
      newRelicConnector.create({ userKey: "key", accountId: 0 }, dependencies),
    ).toThrow("Connector configuration is invalid.");
  });
});

describe("the Sentry issue tracker outbound connector", () => {
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

describe("the Datadog log store outbound connector", () => {
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

describe("the New Relic telemetry reader outbound connector", () => {
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
  it("performs no provider I/O during connector construction", () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetchImplementation);

    createSentryIssueTracker({
      authToken: sentryToken,
      organization: "acme",
    });
    createDatadogLogStore({
      apiKey: datadogApiKey,
      applicationKey: datadogApplicationKey,
    });
    createNewRelicTelemetryReader({
      userKey: newRelicUserKey,
      accountId: 123_456,
    });

    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "Sentry baseUrl",
      create: () =>
        createSentryIssueTracker({
          authToken: sentryToken,
          organization: "acme",
          baseUrl: "file:///tmp/sentry",
        }),
    },
    {
      name: "Datadog baseUrl",
      create: () =>
        createDatadogLogStore({
          apiKey: datadogApiKey,
          applicationKey: datadogApplicationKey,
          baseUrl: "https://user:password@datadog.example",
        }),
    },
    {
      name: "New Relic graphqlUrl",
      create: () =>
        createNewRelicTelemetryReader({
          userKey: newRelicUserKey,
          accountId: 123_456,
          graphqlUrl: "not-a-url",
        }),
    },
  ])("rejects an invalid $name during construction", ({ create, name }) => {
    expect(create).toThrow(`${name} must be a credential-free HTTP(S) URL.`);
  });

  it.each([
    {
      boundary: "transport error",
      fetch: vi.fn<typeof globalThis.fetch>(async () => {
        throw new Error("transport-secret-canary");
      }),
      canary: "transport-secret-canary",
    },
    {
      boundary: "malformed provider payload",
      fetch: vi.fn<typeof globalThis.fetch>(
        async () => new Response("secret-canary"),
      ),
      canary: "secret-canary",
    },
  ])("sanitizes the $boundary cause", async ({ fetch, canary }) => {
    vi.stubGlobal("fetch", fetch);

    const failure = await requestProviderJson(
      "sentry",
      new URL("https://sentry.example/issues"),
      { method: "GET" },
      new AbortController().signal,
    ).then(
      () => undefined,
      (error: unknown) => error as EngineError,
    );

    expect(failure).toMatchObject({
      code: "EXECUTION_FAILED",
      publicDetails: { provider: "sentry" },
    });
    expect(String(failure?.cause)).not.toContain(canary);
  });

  it("does not retain a provider response secret in the internal cause", async () => {
    const providerResponseSecret = "provider-response-secret-canary";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: providerResponseSecret }), {
            status: 502,
          }),
      ),
    );

    const failure = await requestProviderJson(
      "sentry",
      new URL("https://sentry.example/issues"),
      { method: "GET" },
      new AbortController().signal,
    ).then(
      () => undefined,
      (error: unknown) => error as EngineError,
    );

    expect(String(failure?.cause)).not.toContain(providerResponseSecret);
    expect(String(failure?.cause)).toBe(
      "Error: sentry responded with status 502.",
    );
  });

  it("accepts a response at the inclusive 64 MiB provider limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", {
            headers: { "content-length": String(64 * 1024 * 1024) },
          }),
      ),
    );

    await expect(
      requestProviderJson(
        "sentry",
        new URL("https://sentry.example/issues"),
        { method: "GET" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({});
  });

  it("rejects a response above the 64 MiB provider limit", async () => {
    let responseCancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              cancel() {
                responseCancelled = true;
              },
            }),
            {
              headers: { "content-length": String(64 * 1024 * 1024 + 1) },
            },
          ),
      ),
    );

    await expect(
      requestProviderJson(
        "sentry",
        new URL("https://sentry.example/issues"),
        { method: "GET" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      message: "sentry returned an unreadable payload.",
      publicDetails: { provider: "sentry" },
    });
    expect(responseCancelled).toBe(true);
  });

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
