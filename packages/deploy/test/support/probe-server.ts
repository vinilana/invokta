import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Everything the stub observed about one received request. Tests assert on
 * these values to prove the exact wire shape the probe emits.
 */
export interface RecordedProbeRequest {
  readonly method: string;
  readonly target: string;
  readonly httpVersion: string;
  readonly host: string | undefined;
  readonly hostHeaderCount: number;
  readonly authorization: string | undefined;
  readonly accept: string | undefined;
  readonly contentType: string | undefined;
  readonly contentLength: string | undefined;
  readonly connection: string | undefined;
  readonly body: string;
}

export type ProbeStubResponder = (
  request: RecordedProbeRequest,
  response: ServerResponse,
) => void;

export interface ProbeStub {
  /** The canonical probe target for this stub. */
  readonly url: string;
  readonly port: number;
  /** One entry per received request, in arrival order. */
  readonly requests: readonly RecordedProbeRequest[];
  close(): Promise<void>;
}

function countRawHeader(rawHeaders: readonly string[], name: string): number {
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}

function single(value: string | readonly string[] | undefined) {
  return Array.isArray(value)
    ? value.join(", ")
    : (value as string | undefined);
}

/**
 * Starts a loopback HTTP stub on an ephemeral port. The responder decides the
 * reply for each request; the stub never answers on its own, so a responder
 * that ignores its response argument models an endpoint that never replies.
 */
export async function startProbeStub(
  respond: ProbeStubResponder,
): Promise<ProbeStub> {
  const requests: RecordedProbeRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => {
      const recorded: RecordedProbeRequest = {
        method: request.method ?? "",
        target: request.url ?? "",
        httpVersion: request.httpVersion,
        host: request.headers.host,
        hostHeaderCount: countRawHeader(request.rawHeaders, "host"),
        authorization: single(request.headers.authorization),
        accept: single(request.headers.accept),
        contentType: single(request.headers["content-type"]),
        contentLength: single(request.headers["content-length"]),
        connection: single(request.headers.connection),
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      respond(recorded, response);
    });
    request.once("error", () => undefined);
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    port,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/** A port that accepted a connection once and is now closed. */
export async function reserveClosedPort(): Promise<number> {
  const stub = await startProbeStub((_request, response) => response.end());
  const { port } = stub;
  await stub.close();
  return port;
}

export const initializeResult = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    protocolVersion: "2025-11-25",
    capabilities: { tools: {} },
    serverInfo: { name: "stub-engine", version: "0.1.0" },
  },
} as const;

/** Answers exactly as the real adapter does: HTTP 200 with a JSON body. */
export function respondWithJsonInitializeResult(
  _request: RecordedProbeRequest,
  response: ServerResponse,
): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(initializeResult));
}

/** Answers with the same result framed as a Server-Sent Events stream. */
export function respondWithSseInitializeResult(
  _request: RecordedProbeRequest,
  response: ServerResponse,
): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`event: message\ndata: ${JSON.stringify(initializeResult)}\n\n`);
}

/** Answers with the adapter's unauthenticated reply. */
export function respondWithBearerChallenge(
  _request: RecordedProbeRequest,
  response: ServerResponse,
): void {
  response.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": "Bearer",
  });
  response.end(JSON.stringify({ error: "unauthorized" }));
}

/** Builds a responder that answers with a fixed status and JSON body. */
export function respondWithStatus(
  status: number,
  headers: Readonly<Record<string, string>> = {},
): ProbeStubResponder {
  return (_request, response) => {
    response.writeHead(status, {
      "content-type": "application/json",
      ...headers,
    });
    response.end(JSON.stringify({ error: "stub" }));
  };
}

/** Builds a responder that answers HTTP 200 with an arbitrary body. */
export function respondWithBody(
  body: string,
  contentType = "application/json",
): ProbeStubResponder {
  return (_request, response) => {
    response.writeHead(200, { "content-type": contentType });
    response.end(body);
  };
}

/** Accepts the request and never answers, so only the deadline can end it. */
export function respondNever(): void {
  // Intentionally empty: the connection stays open until the probe gives up.
}
