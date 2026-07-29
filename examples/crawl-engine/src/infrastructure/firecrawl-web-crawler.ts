import { EngineError } from "@invokta/core";

import type { WebCrawler } from "../application/ports.js";
import type { DiscoveredLink, ScrapedPage } from "../domain/page.js";

export interface FirecrawlWebCrawlerOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly pollIntervalMs?: number;
  readonly maxStatusRequests?: number;
}

const defaultBaseUrl = "https://api.firecrawl.dev";
const defaultPollIntervalMs = 1_000;
const defaultMaxStatusRequests = 300;
const maximumCauseLength = 512;

function crawlerFailure(
  message: string,
  publicDetails?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): EngineError {
  return new EngineError({
    code: "EXECUTION_FAILED",
    message,
    ...(publicDetails === undefined ? {} : { publicDetails }),
    ...(cause === undefined ? {} : { cause }),
  });
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function readString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function readNumber(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function toScrapedPage(
  value: unknown,
  fallbackUrl: string,
): ScrapedPage | null {
  const page = asRecord(value);
  if (page === null) return null;
  const markdown = page.markdown;
  if (typeof markdown !== "string") return null;
  const metadata = asRecord(page.metadata) ?? {};
  return {
    url:
      readString(metadata, "sourceURL") ??
      readString(metadata, "url") ??
      fallbackUrl,
    title: readString(metadata, "title"),
    statusCode: readNumber(metadata, "statusCode") ?? 200,
    markdown,
  };
}

function toDiscoveredLink(value: unknown): DiscoveredLink | null {
  if (typeof value === "string") {
    return value === "" ? null : { url: value, title: null, description: null };
  }
  const link = asRecord(value);
  const url = link === null ? null : readString(link, "url");
  if (link === null || url === null) return null;
  return {
    url,
    title: readString(link, "title"),
    description: readString(link, "description"),
  };
}

/**
 * Firecrawl adapter for the {@link WebCrawler} port. It is the only module that
 * knows the provider's HTTP contract; the capability contracts stay unchanged
 * when this adapter is replaced.
 */
export function createFirecrawlWebCrawler(
  options: FirecrawlWebCrawlerOptions,
): WebCrawler {
  const apiKey = options.apiKey;
  if (apiKey === "") throw new TypeError("A Firecrawl API key is required.");
  const base = new URL(options.baseUrl ?? defaultBaseUrl);
  const basePrefix = `${base.origin}${base.pathname.replace(/\/+$/u, "")}`;
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
  const maxStatusRequests =
    options.maxStatusRequests ?? defaultMaxStatusRequests;

  const endpoint = (path: string): URL => new URL(`${basePrefix}${path}`);

  const sameOriginEndpoint = (rawUrl: string): URL => {
    let next: URL;
    try {
      next = new URL(rawUrl);
    } catch (cause) {
      throw crawlerFailure(
        "Firecrawl returned an unexpected pagination target.",
        { provider: "firecrawl" },
        cause,
      );
    }
    if (next.origin !== base.origin) {
      throw crawlerFailure(
        "Firecrawl returned an unexpected pagination target.",
        { provider: "firecrawl" },
      );
    }
    return next;
  };

  const request = async (
    url: URL,
    init: { readonly method: "GET" | "POST"; readonly body?: unknown },
    signal: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>> => {
    let response: Response;
    try {
      response = await fetchImplementation(url, {
        method: init.method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal,
      });
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw crawlerFailure(
        "The Firecrawl request could not be completed.",
        { provider: "firecrawl" },
        cause,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw crawlerFailure(
        "Firecrawl rejected the request.",
        { provider: "firecrawl", status: response.status },
        new Error(
          `Firecrawl responded with status ${String(response.status)}: ${detail.slice(0, maximumCauseLength)}`,
        ),
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw crawlerFailure(
        "Firecrawl returned an unreadable payload.",
        { provider: "firecrawl" },
        cause,
      );
    }
    const record = asRecord(payload);
    if (record === null || record.success === false) {
      throw crawlerFailure("Firecrawl returned an unsuccessful result.", {
        provider: "firecrawl",
      });
    }
    return record;
  };

  const readCrawlStatus = async (
    url: URL,
    signal: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>> =>
    request(url, { method: "GET" }, signal);

  return {
    async scrapePage({ target }, { signal }) {
      const payload = await request(
        endpoint("/v2/scrape"),
        {
          method: "POST",
          body: {
            url: target.url,
            formats: ["markdown"],
            onlyMainContent: true,
          },
        },
        signal,
      );
      const page = toScrapedPage(payload.data, target.url);
      if (page === null) {
        throw crawlerFailure("Firecrawl returned no page content.", {
          provider: "firecrawl",
        });
      }
      return page;
    },

    async mapSite({ target, limit }, { signal }) {
      const payload = await request(
        endpoint("/v2/map"),
        { method: "POST", body: { url: target.url, limit } },
        signal,
      );
      const links = payload.links;
      if (!Array.isArray(links)) {
        throw crawlerFailure("Firecrawl returned no site map.", {
          provider: "firecrawl",
        });
      }
      return links
        .map((link) => toDiscoveredLink(link))
        .filter((link): link is DiscoveredLink => link !== null)
        .slice(0, limit);
    },

    async crawlSite({ target, limit, maxDepth }, { signal }) {
      const started = await request(
        endpoint("/v2/crawl"),
        {
          method: "POST",
          body: {
            url: target.url,
            limit,
            maxDiscoveryDepth: maxDepth,
            scrapeOptions: {
              formats: ["markdown"],
              onlyMainContent: true,
            },
          },
        },
        signal,
      );
      const jobId = readString(started, "id");
      if (jobId === null) {
        throw crawlerFailure("Firecrawl did not start a crawl job.", {
          provider: "firecrawl",
        });
      }

      const statusEndpoint = endpoint(`/v2/crawl/${encodeURIComponent(jobId)}`);
      let status = await readCrawlStatus(statusEndpoint, signal);
      let statusRequests = 1;
      while (readString(status, "status") !== "completed") {
        if (readString(status, "status") === "failed") {
          throw crawlerFailure("The Firecrawl crawl job failed.", {
            provider: "firecrawl",
            jobStatus: "failed",
          });
        }
        if (statusRequests >= maxStatusRequests) {
          throw crawlerFailure("The Firecrawl crawl job did not complete.", {
            provider: "firecrawl",
            jobStatus: "pending",
          });
        }
        await delay(pollIntervalMs, signal);
        status = await readCrawlStatus(statusEndpoint, signal);
        statusRequests += 1;
      }

      const pages: ScrapedPage[] = [];
      let batch: Readonly<Record<string, unknown>> | null = status;
      while (batch !== null && pages.length < limit) {
        const data = batch.data;
        if (Array.isArray(data)) {
          for (const item of data) {
            const page = toScrapedPage(item, target.url);
            if (page !== null) pages.push(page);
          }
        }
        const next = readString(batch, "next");
        batch =
          next === null || pages.length >= limit
            ? null
            : await readCrawlStatus(sameOriginEndpoint(next), signal);
      }

      return { pages };
    },
  };
}
