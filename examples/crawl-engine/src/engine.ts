import { createEngine } from "@invokta/core";

import type { CrawlDependencies } from "./application/ports.js";
import { createCrawlSite } from "./capabilities/crawl-site.js";
import { createMapSite } from "./capabilities/map-site.js";
import { createScrapePage } from "./capabilities/scrape-page.js";
import { createAttributeCrawlPermissionChecker } from "./infrastructure/attribute-crawl-permission-checker.js";
import { firecrawlConnector } from "./infrastructure/firecrawl-web-crawler.js";

export function createCrawlEngine(dependencies: CrawlDependencies) {
  return createEngine({
    name: "crawl-engine",
    version: "0.1.0",
    capabilities: {
      "crawl.scrape-page": createScrapePage(dependencies),
      "crawl.map-site": createMapSite(dependencies),
      "crawl.crawl-site": createCrawlSite(dependencies),
    },
  });
}

export interface FirecrawlEnvironment {
  readonly FIRECRAWL_API_KEY?: string | undefined;
  readonly FIRECRAWL_BASE_URL?: string | undefined;
}

/**
 * Composition root for the Firecrawl-backed engine. Credentials stay in the
 * environment; no capability receives them through its business input.
 */
export function createFirecrawlCrawlEngine(
  environment: FirecrawlEnvironment = process.env,
) {
  const apiKey = environment.FIRECRAWL_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("FIRECRAWL_API_KEY is required.");
  }
  const baseUrl = environment.FIRECRAWL_BASE_URL;
  const connector = firecrawlConnector.create(
    {
      apiKey,
      ...(baseUrl === undefined || baseUrl === "" ? {} : { baseUrl }),
    },
    { fetch: globalThis.fetch },
  );
  return createCrawlEngine({
    crawler: connector.ports.crawler,
    permissions: createAttributeCrawlPermissionChecker(),
  });
}
