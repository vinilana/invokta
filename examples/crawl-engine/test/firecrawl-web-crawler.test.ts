import type { EngineError } from "@invokta/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseCrawlTarget } from "../src/domain/crawl-target.js";
import { createFirecrawlWebCrawler } from "../src/infrastructure/firecrawl-web-crawler.js";
import {
  type FirecrawlStub,
  type FirecrawlStubOptions,
  startFirecrawlStub,
} from "./firecrawl-stub.js";

const apiKey = "test-firecrawl-key";
const target = parseCrawlTarget("https://example.com/");
if (target === null) throw new Error("The example target must be crawlable.");

let stub: FirecrawlStub | undefined;

async function startStub(
  options: FirecrawlStubOptions = {},
): Promise<FirecrawlStub> {
  stub = await startFirecrawlStub(options);
  return stub;
}

function createCrawler(
  server: FirecrawlStub,
  overrides: {
    readonly pollIntervalMs?: number;
    readonly maxStatusRequests?: number;
  } = {},
) {
  return createFirecrawlWebCrawler({
    apiKey,
    baseUrl: server.baseUrl,
    pollIntervalMs: overrides.pollIntervalMs ?? 5,
    ...(overrides.maxStatusRequests === undefined
      ? {}
      : { maxStatusRequests: overrides.maxStatusRequests }),
  });
}

afterEach(async () => {
  vi.useRealTimers();
  await stub?.close();
  stub = undefined;
});

describe("the Firecrawl outbound connector", () => {
  it.each([
    "not-a-url",
    "file:///tmp/firecrawl",
    "https://user:password@api.firecrawl.dev",
  ])("rejects the invalid provider base URL %s", (baseUrl) => {
    expect(() => createFirecrawlWebCrawler({ apiKey, baseUrl })).toThrow(
      "baseUrl must be a credential-free HTTP(S) URL.",
    );
  });

  it("performs no provider I/O during construction", () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>();

    createFirecrawlWebCrawler({ apiKey, fetch: fetchImplementation });

    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("preserves cancellation while reading a provider response", async () => {
    const controller = new AbortController();
    const cancellation = new Error("The invocation was cancelled.");
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(
      async (_input, init) =>
        new Response(
          new ReadableStream({
            start(streamController) {
              init?.signal?.addEventListener(
                "abort",
                () => streamController.error(init.signal?.reason),
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const crawler = createFirecrawlWebCrawler({
      apiKey,
      fetch: fetchImplementation,
    });

    const scrape = crawler.scrapePage(
      { target },
      { signal: controller.signal },
    );
    controller.abort(cancellation);

    await expect(scrape).rejects.toBe(cancellation);
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
    const crawler = createFirecrawlWebCrawler({ apiKey, fetch });

    const failure = await crawler
      .scrapePage({ target }, { signal: new AbortController().signal })
      .then(
        () => undefined,
        (error: unknown) => error as EngineError,
      );

    expect(failure).toMatchObject({
      code: "EXECUTION_FAILED",
      publicDetails: { provider: "firecrawl" },
    });
    expect(String(failure?.cause)).not.toContain(canary);
  });

  it("scrapes a page with a bearer credential and maps the provider payload", async () => {
    const server = await startStub();
    const controller = new AbortController();

    const page = await createCrawler(server).scrapePage(
      { target },
      { signal: controller.signal },
    );

    expect(page).toEqual({
      url: "https://example.com/",
      title: "Example Domain",
      statusCode: 200,
      markdown: "# Example Domain\n\nThis domain is for use in examples.",
    });
    expect(server.requests).toEqual([
      {
        method: "POST",
        path: "/v2/scrape",
        authorization: `Bearer ${apiKey}`,
        body: {
          url: "https://example.com/",
          formats: ["markdown"],
          onlyMainContent: true,
        },
      },
    ]);
  });

  it("normalizes site map links and drops malformed entries", async () => {
    const server = await startStub();
    const controller = new AbortController();

    const links = await createCrawler(server).mapSite(
      { target, limit: 5 },
      { signal: controller.signal },
    );

    expect(links).toEqual([
      {
        url: "https://example.com/docs",
        title: "Docs",
        description: "Documentation",
      },
      {
        url: "https://example.com/pricing",
        title: null,
        description: null,
      },
    ]);
    expect(server.requests[0]?.body).toEqual({
      url: "https://example.com/",
      limit: 5,
    });
  });

  it("rejects a provider response above the configured byte limit", async () => {
    const payload = JSON.stringify({
      success: true,
      data: {
        markdown: "# Example",
        metadata: { sourceURL: "https://example.com/" },
      },
    });
    const payloadBytes = new TextEncoder().encode(payload).byteLength;
    const fetchImplementation: typeof globalThis.fetch = async () =>
      new Response(payload, {
        headers: { "content-length": String(payloadBytes) },
      });
    const controller = new AbortController();

    await expect(
      createFirecrawlWebCrawler({
        apiKey,
        fetch: fetchImplementation,
        maxResponseBytes: payloadBytes - 1,
      }).scrapePage({ target }, { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      message: "Firecrawl returned an unreadable payload.",
      publicDetails: { provider: "firecrawl" },
    });

    await expect(
      createFirecrawlWebCrawler({
        apiKey,
        fetch: fetchImplementation,
        maxResponseBytes: payloadBytes,
      }).scrapePage({ target }, { signal: controller.signal }),
    ).resolves.toMatchObject({ markdown: "# Example" });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects the invalid provider response byte limit %s",
    (maxResponseBytes) => {
      expect(() =>
        createFirecrawlWebCrawler({ apiKey, maxResponseBytes }),
      ).toThrow("maxResponseBytes must be a positive safe integer.");
    },
  );

  it("polls an asynchronous crawl job until it completes", async () => {
    const server = await startStub({ pendingStatusResponses: 2 });
    const controller = new AbortController();

    const crawl = await createCrawler(server).crawlSite(
      { target, limit: 10, maxDepth: 1 },
      { signal: controller.signal },
    );

    expect(crawl.pages.map(({ url }) => url)).toEqual([
      "https://example.com/",
      "https://example.com/docs",
    ]);
    expect(
      server.requests.map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      "POST /v2/crawl",
      "GET /v2/crawl/stub-crawl-job",
      "GET /v2/crawl/stub-crawl-job",
      "GET /v2/crawl/stub-crawl-job",
    ]);
    expect(server.requests[0]?.body).toEqual({
      url: "https://example.com/",
      limit: 10,
      maxDiscoveryDepth: 1,
      scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
    });
  });

  it("never returns more crawl pages than requested", async () => {
    let requestCount = 0;
    const fetchImplementation: typeof globalThis.fetch = async () => {
      requestCount += 1;
      return Response.json(
        requestCount === 1
          ? { success: true, id: "crawl-job" }
          : {
              success: true,
              status: "completed",
              data: [
                {
                  markdown: "# First",
                  metadata: { sourceURL: "https://example.com/first" },
                },
                {
                  markdown: "# Second",
                  metadata: { sourceURL: "https://example.com/second" },
                },
              ],
            },
      );
    };
    const controller = new AbortController();

    const crawl = await createFirecrawlWebCrawler({
      apiKey,
      fetch: fetchImplementation,
    }).crawlSite(
      { target, limit: 1, maxDepth: 1 },
      { signal: controller.signal },
    );

    expect(crawl.pages).toEqual([
      {
        url: "https://example.com/first",
        title: null,
        statusCode: 200,
        markdown: "# First",
      },
    ]);
  });

  it("gives up after the configured number of pagination requests", async () => {
    let statusRequestCount = 0;
    const fetchImplementation: typeof globalThis.fetch = async (
      _input,
      init,
    ) => {
      if (init?.method === "POST") {
        return Response.json({ success: true, id: "crawl-job" });
      }
      statusRequestCount += 1;
      return Response.json({
        success: true,
        status: "completed",
        data: [],
        ...(statusRequestCount < 4
          ? {
              next: `https://api.firecrawl.dev/v2/crawl/crawl-job?cursor=${String(statusRequestCount)}`,
            }
          : {}),
      });
    };
    const controller = new AbortController();

    const crawl = createFirecrawlWebCrawler({
      apiKey,
      fetch: fetchImplementation,
      maxPaginationRequests: 2,
    }).crawlSite(
      { target, limit: 1, maxDepth: 1 },
      { signal: controller.signal },
    );

    await expect(crawl).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      message: "The Firecrawl crawl result exceeded its pagination limit.",
    });
    expect(statusRequestCount).toBe(3);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects the invalid pagination request limit %s",
    (maxPaginationRequests) => {
      expect(() =>
        createFirecrawlWebCrawler({ apiKey, maxPaginationRequests }),
      ).toThrow("maxPaginationRequests must be a non-negative safe integer.");
    },
  );

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects the invalid polling interval %s",
    (pollIntervalMs) => {
      expect(() =>
        createFirecrawlWebCrawler({ apiKey, pollIntervalMs }),
      ).toThrow("pollIntervalMs must be a non-negative safe integer.");
    },
  );

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects the invalid status request limit %s",
    (maxStatusRequests) => {
      expect(() =>
        createFirecrawlWebCrawler({ apiKey, maxStatusRequests }),
      ).toThrow("maxStatusRequests must be a positive safe integer.");
    },
  );

  it("refuses a pagination target outside the configured Firecrawl origin", async () => {
    const server = await startStub({
      pendingStatusResponses: 0,
      crawlNextUrl: "http://127.0.0.1:1/v2/crawl/stub-crawl-job?skip=10",
    });
    const controller = new AbortController();

    await expect(
      createCrawler(server).crawlSite(
        { target, limit: 10, maxDepth: 1 },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      message: "Firecrawl returned an unexpected pagination target.",
    });
  });

  it("sanitizes a malformed pagination target cause", async () => {
    const paginationSecret = "pagination-secret-canary";
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(
      async (_input, init) =>
        init?.method === "POST"
          ? Response.json({ success: true, id: "crawl-job" })
          : Response.json({
              success: true,
              status: "completed",
              data: [],
              next: paginationSecret,
            }),
    );
    const crawler = createFirecrawlWebCrawler({
      apiKey,
      fetch: fetchImplementation,
      pollIntervalMs: 0,
    });

    const failure = await crawler
      .crawlSite(
        { target, limit: 1, maxDepth: 1 },
        { signal: new AbortController().signal },
      )
      .then(
        () => undefined,
        (error: unknown) => error as EngineError,
      );

    expect(failure).toMatchObject({
      code: "EXECUTION_FAILED",
      message: "Firecrawl returned an unexpected pagination target.",
      publicDetails: { provider: "firecrawl" },
    });
    expect(JSON.stringify(failure?.cause)).not.toContain(paginationSecret);
  });

  it("reports a provider rejection without leaking the credential", async () => {
    const server = await startStub({ scrapeStatus: 402 });
    const controller = new AbortController();

    const failure = await createCrawler(server)
      .scrapePage({ target }, { signal: controller.signal })
      .then(
        () => undefined,
        (error: unknown) => error as EngineError,
      );

    expect(failure).toMatchObject({
      code: "EXECUTION_FAILED",
      message: "Firecrawl rejected the request.",
      publicDetails: { provider: "firecrawl", status: 402 },
    });
    expect(JSON.stringify(failure?.publicDetails)).not.toContain(apiKey);
    expect(failure?.message).not.toContain(apiKey);
    expect(String(failure?.cause)).not.toContain(apiKey);
  });

  it("rejects an unauthenticated connector configuration", async () => {
    const server = await startStub({ apiKey: "another-key" });
    const controller = new AbortController();

    await expect(
      createCrawler(server).scrapePage(
        { target },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      publicDetails: { provider: "firecrawl", status: 401 },
    });
  });

  it("stops polling when the invocation is cancelled", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchImplementation = vi.fn<typeof globalThis.fetch>(
      async (_input, init) =>
        init?.method === "POST"
          ? Response.json({ success: true, id: "crawl-job" })
          : Response.json({
              success: true,
              status: "scraping",
              data: [],
            }),
    );

    const crawl = createFirecrawlWebCrawler({
      apiKey,
      fetch: fetchImplementation,
      pollIntervalMs: 50,
    }).crawlSite(
      { target, limit: 10, maxDepth: 1 },
      { signal: controller.signal },
    );
    for (
      let attempt = 0;
      attempt < 20 && vi.getTimerCount() === 0;
      attempt += 1
    ) {
      await Promise.resolve();
    }
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    const cancellation = new Error("The research session ended.");
    controller.abort(cancellation);

    await expect(crawl).rejects.toBe(cancellation);
  });

  it("gives up after the configured number of status requests", async () => {
    const server = await startStub({ pendingStatusResponses: 50 });
    const controller = new AbortController();

    await expect(
      createCrawler(server, { maxStatusRequests: 3 }).crawlSite(
        { target, limit: 10, maxDepth: 1 },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
      publicDetails: { provider: "firecrawl", jobStatus: "pending" },
    });
  });
});
