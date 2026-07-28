import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export interface FirecrawlStubRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

export interface FirecrawlStubOptions {
  /** Bearer token the stub accepts. */
  readonly apiKey?: string;
  /** Status code returned by every scrape request, for failure tests. */
  readonly scrapeStatus?: number;
  /** Number of `scraping` status responses before the job completes. */
  readonly pendingStatusResponses?: number;
  /** Absolute URL returned as the crawl status `next` page, for guard tests. */
  readonly crawlNextUrl?: string;
}

export interface FirecrawlStub {
  readonly baseUrl: string;
  readonly requests: ReadonlyArray<FirecrawlStubRequest>;
  close(): Promise<void>;
}

const scrapedMarkdown =
  "# Example Domain\n\nThis domain is for use in examples.";

function send(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
  });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function scrapedPage(url: string, title: string) {
  return {
    markdown: scrapedMarkdown,
    metadata: { title, sourceURL: url, statusCode: 200 },
  };
}

function requestedUrl(body: unknown): string {
  return typeof body === "object" &&
    body !== null &&
    "url" in body &&
    typeof body.url === "string"
    ? body.url
    : "https://example.com/";
}

/**
 * Minimal Firecrawl-compatible server used to exercise the outbound adapter
 * and the built entrypoints without reaching the public API.
 */
export async function startFirecrawlStub(
  options: FirecrawlStubOptions = {},
): Promise<FirecrawlStub> {
  const apiKey = options.apiKey ?? "test-firecrawl-key";
  const scrapeStatus = options.scrapeStatus ?? 200;
  const requests: FirecrawlStubRequest[] = [];
  let pendingStatusResponses = options.pendingStatusResponses ?? 1;

  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const authorization = request.headers.authorization ?? null;
      const body = await readBody(request);
      requests.push({
        method: request.method ?? "GET",
        path,
        authorization,
        body,
      });

      if (authorization !== `Bearer ${apiKey}`) {
        send(response, 401, { success: false, error: "Unauthorized" });
        return;
      }

      if (request.method === "POST" && path === "/v2/scrape") {
        if (scrapeStatus !== 200) {
          send(response, scrapeStatus, {
            success: false,
            error: `Firecrawl stub failure for key ${apiKey}`,
          });
          return;
        }
        send(response, 200, {
          success: true,
          data: scrapedPage(requestedUrl(body), "Example Domain"),
        });
        return;
      }

      if (request.method === "POST" && path === "/v2/map") {
        const base = requestedUrl(body);
        send(response, 200, {
          success: true,
          links: [
            { url: `${base}docs`, title: "Docs", description: "Documentation" },
            `${base}pricing`,
            { title: "Malformed link without a url" },
          ],
        });
        return;
      }

      if (request.method === "POST" && path === "/v2/crawl") {
        send(response, 200, {
          success: true,
          id: "stub-crawl-job",
          url: `${new URL(request.url ?? "/", "http://127.0.0.1").origin}/v2/crawl/stub-crawl-job`,
        });
        return;
      }

      if (request.method === "GET" && path === "/v2/crawl/stub-crawl-job") {
        if (pendingStatusResponses > 0) {
          pendingStatusResponses -= 1;
          send(response, 200, {
            success: true,
            status: "scraping",
            total: 2,
            completed: 0,
            data: [],
          });
          return;
        }
        send(response, 200, {
          success: true,
          status: "completed",
          total: 2,
          completed: 2,
          ...(options.crawlNextUrl === undefined
            ? {}
            : { next: options.crawlNextUrl }),
          data: [
            scrapedPage("https://example.com/", "Example Domain"),
            scrapedPage("https://example.com/docs", "Example Docs"),
          ],
        });
        return;
      }

      send(response, 404, { success: false, error: "Not found" });
    })();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}
