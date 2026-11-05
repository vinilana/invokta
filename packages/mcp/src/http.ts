/**
 * The Node.js listener for stateless MCP Streamable HTTP. It owns only the
 * `node:http` server, the connection, and the raw facts Node.js exposes; every
 * protocol decision belongs to the shared boundary in `http-protocol.ts`.
 */
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import type { CapabilityMap, Engine } from "@invokta/core";

import {
  createMcpHttpProtocol,
  internalFailure,
  type McpHttpHandlerOptions,
  type McpHttpProtocol,
  type McpHttpProtocolResult,
} from "./http-protocol.js";

export type {
  McpHttpAuthenticationRequest,
  McpHttpAuthOptions,
  McpHttpHandlerOptions,
  McpHttpHeaderView,
  McpHttpProtectedResourceMetadata,
} from "./http-protocol.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;

export interface ServeMcpHttpOptions extends McpHttpHandlerOptions {
  readonly host?: string;
  readonly port?: number;
}

export interface McpHttpServerAddress {
  readonly host: string;
  readonly port: number;
}

export interface McpHttpServerHandle {
  address(): McpHttpServerAddress;
  close(): Promise<void>;
}

function toWebHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else if (value !== undefined) {
      result.set(name, value);
    }
  }
  return result;
}

function rawHeaderCount(
  rawHeaders: ReadonlyArray<string>,
  expectedName: string,
): number {
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === expectedName) count += 1;
  }
  return count;
}

/**
 * Exposes the request body as a pull-based byte stream. Nothing is read until
 * the boundary asks for a chunk, the request is paused after every chunk, and
 * cancellation detaches the listeners, so at most one chunk is ever buffered
 * here. A disconnect, including one that happened before the first read,
 * errors the stream so body handling always settles.
 */
function requestBody(request: IncomingMessage): ReadableStream<Uint8Array> {
  let listening = false;
  let settled = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const detach = (): void => {
    request.off("data", onData);
    request.off("end", onEnd);
    request.off("error", onError);
    request.off("aborted", onAborted);
  };
  function onData(chunk: Buffer | string): void {
    if (settled) return;
    request.pause();
    controller.enqueue(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  function onEnd(): void {
    if (settled) return;
    settled = true;
    detach();
    controller.close();
  }
  function onError(error: Error): void {
    if (settled) return;
    settled = true;
    detach();
    controller.error(error);
  }
  function onAborted(): void {
    onError(new Error("Request aborted."));
  }
  return new ReadableStream<Uint8Array>(
    {
      start(streamController) {
        controller = streamController;
      },
      pull() {
        if (!listening) {
          listening = true;
          if (request.aborted || request.destroyed) {
            onAborted();
            return;
          }
          request.on("data", onData);
          request.once("end", onEnd);
          request.once("error", onError);
          request.once("aborted", onAborted);
          if (request.aborted || request.destroyed) {
            onAborted();
            return;
          }
          if (request.readableEnded) {
            onEnd();
            return;
          }
        }
        request.resume();
      },
      cancel() {
        settled = true;
        detach();
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * Writes the boundary's response. A response produced before the body was
 * consumed advertises connection closure, drains what is available, and
 * closes an incomplete request once the response is flushed.
 */
async function writeResponse(
  request: IncomingMessage,
  response: ServerResponse,
  result: McpHttpProtocolResult,
): Promise<void> {
  const headers: Record<string, string> = {};
  result.response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = Buffer.from(await result.response.arrayBuffer());
  if (response.headersSent || response.destroyed) return;
  if (result.bodyUnconsumed) {
    response.shouldKeepAlive = false;
    request.once("error", () => undefined);
    request.resume();
    response.once("finish", () => {
      if (!request.complete && !request.destroyed) request.destroy();
    });
    headers.connection = "close";
  }
  response.writeHead(result.response.status, headers);
  response.end(body);
}

async function serveRequest(
  handle: McpHttpProtocol,
  request: IncomingMessage,
  response: ServerResponse,
  abortController: AbortController,
): Promise<void> {
  const hostHeader = request.headers.host;
  const result = await handle({
    method: request.method ?? "GET",
    target: request.url ?? "/",
    authorities:
      rawHeaderCount(request.rawHeaders, "host") === 1 &&
      hostHeader !== undefined
        ? [hostHeader]
        : null,
    headers: toWebHeaders(request.headers),
    repeated: (name) => rawHeaderCount(request.rawHeaders, name) > 1,
    body: requestBody(request),
    signal: abortController.signal,
  });
  await writeResponse(request, response, result);
}

export async function serveMcpHttp<Capabilities extends CapabilityMap>(
  engine: Engine<Capabilities>,
  options: ServeMcpHttpOptions,
): Promise<McpHttpServerHandle> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const handle = createMcpHttpProtocol(engine, options, host);
  const activeRequests = new Set<AbortController>();

  const httpServer = createServer((request, response) => {
    const abortController = new AbortController();
    activeRequests.add(abortController);
    const forgetRequest = (): void => {
      activeRequests.delete(abortController);
    };
    request.once("aborted", () => abortController.abort());
    response.once("finish", forgetRequest);
    response.once("close", () => {
      forgetRequest();
      if (!response.writableEnded) abortController.abort();
    });
    void serveRequest(handle, request, response, abortController).catch(() => {
      if (!response.headersSent && !response.destroyed) {
        void writeResponse(request, response, internalFailure()).catch(() =>
          response.destroy(),
        );
      } else if (!response.destroyed) {
        response.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      httpServer.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      httpServer.off("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(port, host);
  });

  const address = httpServer.address() as AddressInfo;
  const publicAddress = Object.freeze({
    host,
    port: address.port,
  });
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    address: () => publicAddress,
    close() {
      if (closePromise !== undefined) return closePromise;
      closePromise = new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
        for (const controller of activeRequests) {
          controller.abort(new Error("MCP HTTP server is closing."));
        }
        httpServer.closeAllConnections();
      });
      return closePromise;
    },
  });
}
