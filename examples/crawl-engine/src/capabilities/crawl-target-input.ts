import { EngineError } from "@ai-engine/core";
import { z } from "zod";

import { type CrawlTarget, parseCrawlTarget } from "../domain/crawl-target.js";

/**
 * A rejected target fails as `INPUT_INVALID` at the contract boundary, before
 * the access rule and before any outbound request.
 */
export const crawlTargetUrl = z
  .string()
  .trim()
  .min(1)
  .refine((value) => parseCrawlTarget(value) !== null, {
    message: "The URL must be a public http or https address.",
  });

export const scrapedPageOutput = z.object({
  url: z.string().min(1),
  title: z.string().nullable(),
  statusCode: z.number().int(),
  markdown: z.string(),
});

export function requireCrawlTarget(rawUrl: string): CrawlTarget {
  const target = parseCrawlTarget(rawUrl);
  if (target === null) {
    throw new EngineError({
      code: "EXECUTION_FAILED",
      message: "The crawl target could not be resolved.",
    });
  }
  return target;
}
