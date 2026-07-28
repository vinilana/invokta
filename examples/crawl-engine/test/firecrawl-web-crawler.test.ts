import type { EngineError } from "@ai-engine/core";
import { afterEach, describe, expect, it } from "vitest";

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
  await stub?.close();
  stub = undefined;
});

describe("the Firecrawl adapter", () => {
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
  });

  it("rejects an unauthenticated adapter configuration", async () => {
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
    const server = await startStub({ pendingStatusResponses: 50 });
    const controller = new AbortController();

    const crawl = createCrawler(server, { pollIntervalMs: 50 }).crawlSite(
      { target, limit: 10, maxDepth: 1 },
      { signal: controller.signal },
    );
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
