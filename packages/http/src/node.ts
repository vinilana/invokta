import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

import type { CapabilityMap, Engine } from "@invokta/core";

import {
  createHttpHandler,
  type HttpHandlerOptions,
  httpErrorResponse,
  isLoopbackHost,
  loopbackHosts,
} from "./handler.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;

export interface ServeHttpOptions extends HttpHandlerOptions {
  readonly host?: string;
  readonly port?: number;
}

export interface HttpServerAddress {
  readonly host: string;
  readonly port: number;
}

export interface HttpServerHandle {
  address(): HttpServerAddress;
  close(): Promise<void>;
}

function rawHeaderCount(rawHeaders: ReadonlyArray<string>, name: string) {
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}

/**
 * Translates one Node request into a Web `Request`. Only an origin-form target
 * whose path URL parsing leaves unchanged, exactly one `Host` header, and at
 * most one `Authorization` header are accepted, so the URL and credential the
 * handler validates are exactly the ones the client sent. Dot segments,
 * including percent-encoded ones, and other aliases that a path-routing proxy
 * would see differently are rejected. Returns `undefined` for anything else.
 */
function toWebRequest(
  request: IncomingMessage,
  signal: AbortSignal,
): Request | undefined {
  const host = request.headers.host;
  const target = request.url;
  if (
    rawHeaderCount(request.rawHeaders, "host") !== 1 ||
    rawHeaderCount(request.rawHeaders, "authorization") > 1 ||
    host === undefined ||
    target === undefined ||
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("#")
  ) {
    return undefined;
  }
  try {
    const authority = new URL(`http://${host}`);
    if (
      authority.username !== "" ||
      authority.password !== "" ||
      authority.pathname !== "/" ||
      authority.search !== "" ||
      authority.hash !== ""
    ) {
      return undefined;
    }
    const url = new URL(target, authority.origin);
    const queryStart = target.indexOf("?");
    const rawPath = queryStart === -1 ? target : target.slice(0, queryStart);
    if (url.origin !== authority.origin || url.pathname !== rawPath) {
      return undefined;
    }
    const headers = new Headers();
    for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
      headers.append(
        request.rawHeaders[index] as string,
        request.rawHeaders[index + 1] as string,
      );
    }
    const method = request.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    return new Request(url, {
      method,
      headers,
      signal,
      ...(hasBody
        ? {
            body: Readable.toWeb(request) as ReadableStream<Uint8Array>,
            duplex: "half" as const,
          }
        : {}),
    });
  } catch {
    return undefined;
  }
}

async function writeWebResponse(
  request: IncomingMessage,
  response: ServerResponse,
  source: Response,
): Promise<void> {
  const body = new Uint8Array(await source.arrayBuffer());
  if (response.destroyed || response.headersSent) return;
  const headers: Record<string, string> = {};
  source.headers.forEach((value, name) => {
    headers[name] = value;
  });
  if (!request.complete) {
    // The handler answered without consuming the body: close the connection
    // after this response instead of reading an unbounded remainder.
    response.shouldKeepAlive = false;
    headers.connection = "close";
    response.once("finish", () => {
      if (!request.complete && !request.destroyed) request.destroy();
    });
  }
  response.writeHead(source.status, headers);
  response.end(body);
}

/**
 * Serves `createHttpHandler` on a `node:http` server. It adds only the Node
 * translation: the request target and `Host` checks above, client-disconnect
 * cancellation, and server lifetime. Every route, limit, and status is the
 * Web-standard handler's.
 */
export async function serveHttp<Capabilities extends CapabilityMap>(
  engine: Engine<Capabilities>,
  options: ServeHttpOptions,
): Promise<HttpServerHandle> {
  if (options === null || typeof options !== "object") {
    throw new TypeError("options with an explicit auth mode are required.");
  }
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  if (options.allowedHosts === undefined && !isLoopbackHost(host)) {
    throw new TypeError(
      "allowedHosts is required when the HTTP server binds to a non-loopback host.",
    );
  }
  const handler = createHttpHandler(engine, {
    auth: options.auth,
    allowedHosts: options.allowedHosts ?? [...loopbackHosts(), host],
    ...(options.basePath === undefined ? {} : { basePath: options.basePath }),
    ...(options.cors === undefined ? {} : { cors: options.cors }),
    ...(options.maxRequestBodyBytes === undefined
      ? {}
      : { maxRequestBodyBytes: options.maxRequestBodyBytes }),
    ...(options.visibility === undefined
      ? {}
      : { visibility: options.visibility }),
  });
  const activeRequests = new Set<AbortController>();

  const server = createServer((request, response) => {
    const controller = new AbortController();
    activeRequests.add(controller);
    response.once("close", () => {
      activeRequests.delete(controller);
      if (!response.writableEnded) controller.abort();
    });
    void (async () => {
      const webRequest = toWebRequest(request, controller.signal);
      const webResponse =
        webRequest === undefined
          ? httpErrorResponse(400, "INVALID_REQUEST")
          : await handler(webRequest);
      await writeWebResponse(request, response, webResponse);
    })().catch(() => {
      if (!response.destroyed) response.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = Object.freeze({
    host,
    port: (server.address() as AddressInfo).port,
  });
  let closing: Promise<void> | undefined;
  return Object.freeze({
    address: () => address,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
        for (const controller of activeRequests) {
          controller.abort(new Error("HTTP server is closing."));
        }
        server.closeAllConnections();
      });
      return closing;
    },
  });
}
