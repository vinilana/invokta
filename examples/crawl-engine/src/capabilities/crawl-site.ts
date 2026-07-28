import { defineCapability } from "@ai-engine/core";
import { z } from "zod";

import type { CrawlDependencies } from "../application/ports.js";
import { parseCrawlTarget } from "../domain/crawl-target.js";
import {
  crawlTargetUrl,
  requireCrawlTarget,
  scrapedPageOutput,
} from "./crawl-target-input.js";

const defaultPageLimit = 5;
const defaultMaxDepth = 2;

export function createCrawlSite({ crawler, permissions }: CrawlDependencies) {
  return defineCapability({
    title: "Crawl site",
    description:
      "Crawl a bounded number of pages from a public site with Firecrawl and return their Markdown content.",
    input: z.object({
      url: crawlTargetUrl,
      limit: z.number().int().min(1).max(50).optional(),
      maxDepth: z.number().int().min(0).max(5).optional(),
    }),
    output: z.object({
      url: z.string().min(1),
      pagesCrawled: z.number().int().min(0),
      pages: z.array(scrapedPageOutput),
    }),
    access: async ({ principal, input }) => {
      if (principal === null) return false;
      const target = parseCrawlTarget(input.url);
      if (target === null) return false;
      return permissions.can(principal, "crawl:crawl", target);
    },
    timeoutMs: 180_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: false,
      openWorld: true,
    },
    async run({ input, context }) {
      const target = requireCrawlTarget(input.url);
      const limit = input.limit ?? defaultPageLimit;
      const crawl = await crawler.crawlSite(
        { target, limit, maxDepth: input.maxDepth ?? defaultMaxDepth },
        { signal: context.signal },
      );
      const pages = crawl.pages.slice(0, limit).map((page) => ({ ...page }));
      return {
        url: target.url,
        pagesCrawled: pages.length,
        pages,
      };
    },
  });
}
