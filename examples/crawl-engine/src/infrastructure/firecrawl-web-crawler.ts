import { EngineError } from "@invokta/core";

import type { WebCrawler } from "../application/ports.js";
import type { DiscoveredLink, ScrapedPage } from "../domain/page.js";

export interface FirecrawlWebCrawlerOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly pollIntervalMs?: number;
  readonly maxStatusRequests?: number;
  readonly maxPaginationRequests?: number;
  readonly maxResponseBytes?: number;
}

const defaultBaseUrl = "https://api.firecrawl.dev";
const defaultPollIntervalMs = 1_000;
const defaultMaxStatusRequests = 300;
const defaultMaxPaginationRequests = 50;
const defaultMaxResponseBytes = 64 * 1024 * 1024;

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

function responseLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null || !/^\d+$/u.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declaredLength = responseLength(response);
  if (declaredLength !== null && declaredLength > maximumBytes) {
    throw new RangeError(
      "Firecrawl response exceeds the configured byte limit.",
    );
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RangeError(
          "Firecrawl response exceeds the configured byte limit.",
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
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
 * Firecrawl outbound connector for the {@link WebCrawler} port. It is the only
 * module that knows the provider's HTTP contract; the capability contracts stay
 * unchanged when this connector is replaced.
 */
export function createFirecrawlWebCrawler(
  options: FirecrawlWebCrawlerOptions,
): WebCrawler {
  const apiKey = options.apiKey;
  if (apiKey === "") throw new TypeError("A Firecrawl API key is required.");
  let base: URL;
  try {
    base = new URL(options.baseUrl ?? defaultBaseUrl);
  } catch {
    throw new TypeError("baseUrl must be a credential-free HTTP(S) URL.");
  }
  if (
    (base.protocol !== "http:" && base.protocol !== "https:") ||
    base.username !== "" ||
    base.password !== ""
  ) {
    throw new TypeError("baseUrl must be a credential-free HTTP(S) URL.");
  }
  const basePrefix = `${base.origin}${base.pathname.replace(/\/+$/u, "")}`;
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0) {
    throw new TypeError("pollIntervalMs must be a non-negative safe integer.");
  }
  const maxStatusRequests =
    options.maxStatusRequests ?? defaultMaxStatusRequests;
  if (!Number.isSafeInteger(maxStatusRequests) || maxStatusRequests < 1) {
    throw new TypeError("maxStatusRequests must be a positive safe integer.");
  }
  const maxPaginationRequests =
    options.maxPaginationRequests ?? defaultMaxPaginationRequests;
  if (
    !Number.isSafeInteger(maxPaginationRequests) ||
    maxPaginationRequests < 0
  ) {
    throw new TypeError(
      "maxPaginationRequests must be a non-negative safe integer.",
    );
  }
  const maxResponseBytes = options.maxResponseBytes ?? defaultMaxResponseBytes;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new TypeError("maxResponseBytes must be a positive safe integer.");
  }

  const endpoint = (path: string): URL => new URL(`${basePrefix}${path}`);

  const sameOriginEndpoint = (rawUrl: string): URL => {
    let next: URL;
    try {
      next = new URL(rawUrl);
    } catch {
      throw crawlerFailure(
        "Firecrawl returned an unexpected pagination target.",
        { provider: "firecrawl" },
        new Error("The Firecrawl pagination target was not a valid URL."),
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
    } catch {
      if (signal.aborted) throw signal.reason;
      throw crawlerFailure(
        "The Firecrawl request could not be completed.",
        { provider: "firecrawl" },
        new Error("The Firecrawl transport request failed."),
      );
    }

    if (signal.aborted) throw signal.reason;

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw crawlerFailure(
        "Firecrawl rejected the request.",
        { provider: "firecrawl", status: response.status },
        new Error(
          `Firecrawl responded with status ${String(response.status)}.`,
        ),
      );
    }

    let text: string;
    try {
      text = await readBoundedText(response, maxResponseBytes);
    } catch {
      if (signal.aborted) throw signal.reason;
      throw crawlerFailure(
        "Firecrawl returned an unreadable payload.",
        { provider: "firecrawl" },
        new Error("The Firecrawl response could not be read safely."),
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw crawlerFailure(
        "Firecrawl returned an unreadable payload.",
        { provider: "firecrawl" },
        new Error("The Firecrawl response was not valid JSON."),
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
      let paginationRequests = 0;
      while (batch !== null && pages.length < limit) {
        const data = batch.data;
        if (Array.isArray(data)) {
          for (const item of data) {
            const page = toScrapedPage(item, target.url);
            if (page !== null) pages.push(page);
            if (pages.length >= limit) break;
          }
        }
        const next = readString(batch, "next");
        if (next === null || pages.length >= limit) {
          batch = null;
        } else {
          if (paginationRequests >= maxPaginationRequests) {
            throw crawlerFailure(
              "The Firecrawl crawl result exceeded its pagination limit.",
              { provider: "firecrawl" },
            );
          }
          batch = await readCrawlStatus(sameOriginEndpoint(next), signal);
          paginationRequests += 1;
        }
      }

      return { pages };
    },
  };
}
