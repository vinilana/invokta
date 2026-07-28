import { defineCapability } from "@ai-engine/core";
import { z } from "zod";

import type { CrawlDependencies } from "../application/ports.js";
import { parseCrawlTarget } from "../domain/crawl-target.js";
import { crawlTargetUrl, requireCrawlTarget } from "./crawl-target-input.js";

const defaultLinkLimit = 20;

export function createMapSite({ crawler, permissions }: CrawlDependencies) {
  return defineCapability({
    title: "Map site",
    description:
      "Discover the URLs Firecrawl can reach from a public site, without fetching page content.",
    input: z.object({
      url: crawlTargetUrl,
      limit: z.number().int().min(1).max(100).optional(),
    }),
    output: z.object({
      url: z.string().min(1),
      links: z.array(
        z.object({
          url: z.string().min(1),
          title: z.string().nullable(),
          description: z.string().nullable(),
        }),
      ),
    }),
    access: async ({ principal, input }) => {
      if (principal === null) return false;
      const target = parseCrawlTarget(input.url);
      if (target === null) return false;
      return permissions.can(principal, "crawl:map", target);
    },
    timeoutMs: 60_000,
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: true,
    },
    async run({ input, context }) {
      const target = requireCrawlTarget(input.url);
      const limit = input.limit ?? defaultLinkLimit;
      const links = await crawler.mapSite(
        { target, limit },
        { signal: context.signal },
      );
      return {
        url: target.url,
        links: links.slice(0, limit).map((link) => ({ ...link })),
      };
    },
  });
}
