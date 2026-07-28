import type { Principal } from "@ai-engine/core";

import type { CrawlTarget } from "../domain/crawl-target.js";
import type { DiscoveredLink, ScrapedPage, SiteCrawl } from "../domain/page.js";

export interface CrawlerCallOptions {
  readonly signal: AbortSignal;
}

export interface WebCrawler {
  scrapePage(
    request: { readonly target: CrawlTarget },
    options: CrawlerCallOptions,
  ): Promise<ScrapedPage>;
  mapSite(
    request: { readonly target: CrawlTarget; readonly limit: number },
    options: CrawlerCallOptions,
  ): Promise<ReadonlyArray<DiscoveredLink>>;
  crawlSite(
    request: {
      readonly target: CrawlTarget;
      readonly limit: number;
      readonly maxDepth: number;
    },
    options: CrawlerCallOptions,
  ): Promise<SiteCrawl>;
}

export type CrawlPermission = "crawl:scrape" | "crawl:map" | "crawl:crawl";

export interface CrawlPermissionChecker {
  can(
    principal: Principal,
    permission: CrawlPermission,
    target: CrawlTarget,
  ): boolean | Promise<boolean>;
}

export interface CrawlDependencies {
  readonly crawler: WebCrawler;
  readonly permissions: CrawlPermissionChecker;
}
