import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export interface ObservabilityStubRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly authorization: string | null;
  readonly datadogApiKey: string | null;
  readonly datadogApplicationKey: string | null;
  readonly newRelicUserKey: string | null;
  readonly body: unknown;
}

export interface ObservabilityStubOptions {
  readonly sentryStatus?: number;
  readonly datadogStatus?: number;
  readonly newRelicStatus?: number;
  readonly newRelicGraphqlError?: boolean;
}

export interface ObservabilityStub {
  readonly baseUrl: string;
  readonly requests: ReadonlyArray<ObservabilityStubRequest>;
  close(): Promise<void>;
}

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

function queryRecord(url: URL): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...url.searchParams.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

export async function startObservabilityStub(
  options: ObservabilityStubOptions = {},
): Promise<ObservabilityStub> {
  const requests: ObservabilityStubRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const body = await readBody(request);
      requests.push({
        method: request.method ?? "GET",
        path: url.pathname,
        query: queryRecord(url),
        authorization: request.headers.authorization ?? null,
        datadogApiKey:
          typeof request.headers["dd-api-key"] === "string"
            ? request.headers["dd-api-key"]
            : null,
        datadogApplicationKey:
          typeof request.headers["dd-application-key"] === "string"
            ? request.headers["dd-application-key"]
            : null,
        newRelicUserKey:
          typeof request.headers["api-key"] === "string"
            ? request.headers["api-key"]
            : null,
        body,
      });

      if (url.pathname.startsWith("/api/0/organizations/")) {
        const status = options.sentryStatus ?? 200;
        if (status !== 200) {
          send(response, status, { detail: "Sentry stub rejected a secret." });
          return;
        }
        send(response, 200, [
          {
            id: "SENTRY-1",
            title: "Payment confirmation failed",
            status: "unresolved",
            project: { slug: "checkout-api" },
            lastSeen: "2026-07-28T12:45:00.000Z",
            count: "42",
            permalink: "https://sentry.example/issues/SENTRY-1",
          },
        ]);
        return;
      }

      if (url.pathname === "/api/v2/logs/events/search") {
        const status = options.datadogStatus ?? 200;
        if (status !== 200) {
          send(response, status, {
            errors: ["Datadog stub rejected a secret."],
          });
          return;
        }
        send(response, 200, {
          data: [
            {
              id: "DD-1",
              attributes: {
                timestamp: "2026-07-28T12:40:00.000Z",
                service: "checkout-api",
                status: "error",
                message: "Payment confirmation failed",
              },
            },
          ],
        });
        return;
      }

      if (url.pathname === "/graphql") {
        const status = options.newRelicStatus ?? 200;
        if (status !== 200) {
          send(response, status, {
            errors: [{ message: "Rejected a secret." }],
          });
          return;
        }
        if (options.newRelicGraphqlError === true) {
          send(response, 200, { errors: [{ message: "Access denied." }] });
          return;
        }
        send(response, 200, {
          data: {
            actor: {
              account: {
                nrql: {
                  results: [
                    {
                      transactionCount: 125,
                      errorRate: 2.5,
                      averageDurationMs: 420,
                    },
                  ],
                },
              },
            },
          },
        });
        return;
      }

      send(response, 404, { error: "Not found" });
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
