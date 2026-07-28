import { defineCapability } from "@ai-engine/core";
import { z } from "zod";

import type { CrawlDependencies } from "../application/ports.js";
import { parseCrawlTarget } from "../domain/crawl-target.js";
import {
  crawlTargetUrl,
  requireCrawlTarget,
  scrapedPageOutput,
} from "./crawl-target-input.js";

export function createScrapePage({ crawler, permissions }: CrawlDependencies) {
  return defineCapability({
    title: "Scrape page",
    description:
      "Fetch one public web page with Firecrawl and return its main content as Markdown.",
    input: z.object({ url: crawlTargetUrl }),
    output: scrapedPageOutput,
    access: async ({ principal, input }) => {
      if (principal === null) return false;
      const target = parseCrawlTarget(input.url);
      if (target === null) return false;
      return permissions.can(principal, "crawl:scrape", target);
    },
    timeoutMs: 60_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: true,
    },
    async run({ input, context }) {
      return crawler.scrapePage(
        { target: requireCrawlTarget(input.url) },
        { signal: context.signal },
      );
    },
  });
}
