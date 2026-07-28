import type { Principal } from "@ai-engine/core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type {
  CrawlPermissionChecker,
  WebCrawler,
} from "../src/application/ports.js";
import { parseCrawlTarget } from "../src/domain/crawl-target.js";
import { createCrawlEngine } from "../src/engine.js";
import { createAttributeCrawlPermissionChecker } from "../src/infrastructure/attribute-crawl-permission-checker.js";

const principal: Principal = {
  id: "agent:research",
  attributes: {
    permissions: ["crawl:scrape", "crawl:map", "crawl:crawl"],
    allowedHosts: ["example.com"],
  },
};

function createDependencies() {
  const crawler: WebCrawler = {
    scrapePage: vi.fn(async ({ target }) => ({
      url: target.url,
      title: "Example Domain",
      statusCode: 200,
      markdown: "# Example Domain",
    })),
    mapSite: vi.fn(async ({ target, limit }) =>
      Array.from({ length: limit + 5 }, (_value, index) => ({
        url: `${target.url}page-${String(index)}`,
        title: null,
        description: null,
      })),
    ),
    crawlSite: vi.fn(async ({ target, limit }) => ({
      pages: Array.from({ length: limit + 3 }, (_value, index) => ({
        url: `${target.url}page-${String(index)}`,
        title: null,
        statusCode: 200,
        markdown: `# Page ${String(index)}`,
      })),
    })),
  };
  const permissions: CrawlPermissionChecker = { can: vi.fn(async () => true) };
  return { crawler, permissions };
}

describe("the crawl engine example", () => {
  it("scrapes a public page through the injected Firecrawl port", async () => {
    const dependencies = createDependencies();
    const engine = createCrawlEngine(dependencies);

    const result = await engine.invoke(
      "crawl.scrape-page",
      { url: "  https://example.com/docs  " },
      { source: "direct", principal },
    );

    expectTypeOf(result).toEqualTypeOf<{
      url: string;
      title: string | null;
      statusCode: number;
      markdown: string;
    }>();
    expect(result).toEqual({
      url: "https://example.com/docs",
      title: "Example Domain",
      statusCode: 200,
      markdown: "# Example Domain",
    });
    expect(dependencies.permissions.can).toHaveBeenCalledExactlyOnceWith(
      principal,
      "crawl:scrape",
      { url: "https://example.com/docs", host: "example.com" },
    );
    expect(dependencies.crawler.scrapePage).toHaveBeenCalledWith(
      { target: { url: "https://example.com/docs", host: "example.com" } },
      { signal: expect.any(AbortSignal) },
    );
  });

  it.each([
    ["a loopback host", "http://127.0.0.1:8080/admin"],
    ["the localhost name", "http://localhost/admin"],
    ["a private range", "https://10.0.0.5/internal"],
    ["a link-local address", "http://169.254.169.254/latest/meta-data"],
    ["an IPv6 loopback", "http://[::1]:9000/"],
    ["an internal suffix", "https://vault.internal/secret"],
    ["a non-HTTP scheme", "file:///etc/passwd"],
    ["embedded credentials", "https://user:secret@example.com/"],
  ])(
    "rejects %s before authorization and before any outbound request",
    async (_description, url) => {
      const dependencies = createDependencies();
      const engine = createCrawlEngine(dependencies);

      await expect(
        engine.invoke(
          "crawl.scrape-page",
          { url },
          { source: "direct", principal },
        ),
      ).rejects.toMatchObject({ code: "INPUT_INVALID" });
      expect(dependencies.permissions.can).not.toHaveBeenCalled();
      expect(dependencies.crawler.scrapePage).not.toHaveBeenCalled();
    },
  );

  it("denies a host the principal is not allowed to crawl", async () => {
    const dependencies = createDependencies();
    dependencies.permissions = createAttributeCrawlPermissionChecker();
    const engine = createCrawlEngine(dependencies);

    await expect(
      engine.invoke(
        "crawl.scrape-page",
        { url: "https://competitor.test/pricing" },
        { source: "direct", principal },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(dependencies.crawler.scrapePage).not.toHaveBeenCalled();
  });

  it("allows a subdomain of an allowed host and fails closed on a malformed allowlist", async () => {
    const permissions = createAttributeCrawlPermissionChecker();
    const target = parseCrawlTarget("https://docs.example.com/guide");
    expect(target).not.toBeNull();
    if (target === null) return;

    expect(await permissions.can(principal, "crawl:scrape", target)).toBe(true);
    expect(
      await permissions.can(
        {
          id: "agent:malformed",
          attributes: {
            permissions: ["crawl:scrape"],
            allowedHosts: "example.com",
          },
        },
        "crawl:scrape",
        target,
      ),
    ).toBe(false);
    expect(
      await permissions.can(
        { id: "agent:read-only", attributes: { permissions: ["crawl:map"] } },
        "crawl:scrape",
        target,
      ),
    ).toBe(false);
  });

  it("requires the per-capability permission for a site crawl", async () => {
    const dependencies = createDependencies();
    dependencies.permissions = createAttributeCrawlPermissionChecker();
    const engine = createCrawlEngine(dependencies);
    const scrapeOnly: Principal = {
      id: "agent:scrape-only",
      attributes: { permissions: ["crawl:scrape"] },
    };

    await expect(
      engine.invoke(
        "crawl.crawl-site",
        { url: "https://example.com/" },
        { source: "direct", principal: scrapeOnly },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      engine.invoke(
        "crawl.scrape-page",
        { url: "https://example.com/" },
        { source: "direct", principal: scrapeOnly },
      ),
    ).resolves.toMatchObject({ url: "https://example.com/" });
  });

  it("applies the documented default limit and never returns more links than requested", async () => {
    const dependencies = createDependencies();
    const engine = createCrawlEngine(dependencies);

    const withDefault = await engine.invoke(
      "crawl.map-site",
      { url: "https://example.com/" },
      { source: "direct", principal },
    );
    const withLimit = await engine.invoke(
      "crawl.map-site",
      { url: "https://example.com/", limit: 3 },
      { source: "direct", principal },
    );

    expect(dependencies.crawler.mapSite).toHaveBeenNthCalledWith(
      1,
      {
        target: { url: "https://example.com/", host: "example.com" },
        limit: 20,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(withDefault.links).toHaveLength(20);
    expect(withLimit.links).toEqual([
      { url: "https://example.com/page-0", title: null, description: null },
      { url: "https://example.com/page-1", title: null, description: null },
      { url: "https://example.com/page-2", title: null, description: null },
    ]);
  });

  it("bounds a site crawl to the requested page limit", async () => {
    const dependencies = createDependencies();
    const engine = createCrawlEngine(dependencies);

    const result = await engine.invoke(
      "crawl.crawl-site",
      { url: "https://example.com/", limit: 2, maxDepth: 1 },
      { source: "direct", principal },
    );

    expect(dependencies.crawler.crawlSite).toHaveBeenCalledWith(
      {
        target: { url: "https://example.com/", host: "example.com" },
        limit: 2,
        maxDepth: 1,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(result.pagesCrawled).toBe(2);
    expect(result.pages).toHaveLength(2);
  });

  it("rejects a crawler result that breaks the output contract", async () => {
    const dependencies = createDependencies();
    dependencies.crawler.scrapePage = vi.fn(async ({ target }) => ({
      url: target.url,
      title: null,
      statusCode: 200.5,
      markdown: "# Example Domain",
    }));
    const engine = createCrawlEngine(dependencies);

    await expect(
      engine.invoke(
        "crawl.scrape-page",
        { url: "https://example.com/" },
        { source: "direct", principal },
      ),
    ).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
  });

  it("propagates caller cancellation to the crawler port", async () => {
    const dependencies = createDependencies();
    let crawlerSignal: AbortSignal | undefined;
    dependencies.crawler.crawlSite = vi.fn(async (_request, { signal }) => {
      crawlerSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      return { pages: [] };
    });
    const engine = createCrawlEngine(dependencies);
    const controller = new AbortController();

    const invocation = engine.invoke(
      "crawl.crawl-site",
      { url: "https://example.com/" },
      { source: "direct", principal, signal: controller.signal },
    );
    await vi.waitFor(() => expect(crawlerSignal).toBeDefined());
    controller.abort(new Error("The research session ended."));

    await expect(invocation).rejects.toMatchObject({ code: "CANCELLED" });
    expect(crawlerSignal?.aborted).toBe(true);
  });

  it("publishes three open-world capabilities with stable contracts", () => {
    const engine = createCrawlEngine(createDependencies());

    expect(engine.list().map(({ id }) => id)).toEqual([
      "crawl.scrape-page",
      "crawl.map-site",
      "crawl.crawl-site",
    ]);
    expect(engine.describe("crawl.scrape-page")).toMatchObject({
      id: "crawl.scrape-page",
      title: "Scrape page",
      timeoutMs: 60_000,
      annotations: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: true,
      },
      inputSchema: { type: "object", required: ["url"] },
      outputSchema: { type: "object" },
    });
    expect(engine.describe("crawl.crawl-site")).toMatchObject({
      timeoutMs: 180_000,
      annotations: { idempotent: false, openWorld: true },
    });
  });
});
