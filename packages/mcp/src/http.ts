import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { CapabilityMap, Engine, Principal } from "@ai-engine/core";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { WebStandardStreamableHTTPServerTransportOptions } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { OAuthProtectedResourceMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";

import { createMcpServer } from "./protocol-server.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MCP_PATH = "/mcp";

export interface McpHttpHeaderView {
  readonly get: (name: string) => string | null;
  readonly has: (name: string) => boolean;
}

export interface McpHttpAuthenticationRequest {
  readonly path: string;
  readonly method: string;
  readonly headers: McpHttpHeaderView;
  readonly signal: AbortSignal;
}

export interface McpHttpProtectedResourceMetadata {
  readonly resource: string;
  readonly authorizationServers: readonly [string, ...string[]];
  readonly scopesSupported?: ReadonlyArray<string>;
}

interface RequiredMcpHttpAuth {
  readonly mode: "required";
  readonly authenticate: (
    request: McpHttpAuthenticationRequest,
  ) => Principal | null | Promise<Principal | null>;
  readonly resourceMetadata?: McpHttpProtectedResourceMetadata;
}

interface DangerouslyDisabledMcpHttpAuth {
  readonly mode: "dangerously-disabled-for-development";
}

export type McpHttpAuthOptions =
  | RequiredMcpHttpAuth
  | DangerouslyDisabledMcpHttpAuth;

export interface ServeMcpHttpOptions {
  readonly host?: string;
  readonly port?: number;
  readonly allowedHosts?: ReadonlyArray<string>;
  readonly allowedOrigins?: ReadonlyArray<string>;
  readonly maxRequestBodyBytes?: number;
  readonly auth: McpHttpAuthOptions;
}

export interface McpHttpServerAddress {
  readonly host: string;
  readonly port: number;
}

export interface McpHttpServerHandle {
  address(): McpHttpServerAddress;
  close(): Promise<void>;
}

interface HttpResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

interface RequiredMcpHttpAuthSnapshot {
  readonly mode: "required";
  readonly authenticate: RequiredMcpHttpAuth["authenticate"];
  readonly resourceMetadata?: McpHttpProtectedResourceMetadata;
}

interface DangerouslyDisabledMcpHttpAuthSnapshot {
  readonly mode: "dangerously-disabled-for-development";
}

type McpHttpAuthSnapshot =
  | RequiredMcpHttpAuthSnapshot
  | DangerouslyDisabledMcpHttpAuthSnapshot;

function snapshotAuthOptions(value: McpHttpAuthOptions): McpHttpAuthSnapshot {
  if (value === null || typeof value !== "object") {
    throw new TypeError(
      'auth.mode must be either "required" or "dangerously-disabled-for-development".',
    );
  }
  if (value.mode === "required") {
    if (typeof value.authenticate !== "function") {
      throw new TypeError(
        "auth.authenticate must be a function when auth.mode is required.",
      );
    }
    return Object.freeze({
      mode: "required",
      authenticate: value.authenticate,
      ...(value.resourceMetadata === undefined
        ? {}
        : { resourceMetadata: value.resourceMetadata }),
    });
  }
  if (value.mode === "dangerously-disabled-for-development") {
    return Object.freeze({ mode: value.mode });
  }
  throw new TypeError(
    'auth.mode must be either "required" or "dangerously-disabled-for-development".',
  );
}

function normalizeHostname(authority: string): string | null {
  if (authority.toLowerCase() === "::1") return "[::1]";
  try {
    const parsed = new URL(`http://${authority}`);
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return null;
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeRequestHostname(authority: string): string | null {
  if (!authority.startsWith("[") && authority.split(":").length > 2) {
    return null;
  }
  return normalizeHostname(authority);
}

function isLoopback(host: string): boolean {
  const normalized = normalizeHostname(host);
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "[::1]"
  );
}

function normalizedAllowedHosts(
  bindHost: string,
  configured: ReadonlyArray<string> | undefined,
): ReadonlySet<string> {
  if (configured === undefined && !isLoopback(bindHost)) {
    throw new TypeError(
      "allowedHosts is required when the MCP HTTP server binds to a non-loopback host.",
    );
  }
  const candidates = configured ?? [
    "127.0.0.1",
    "localhost",
    "[::1]",
    bindHost,
  ];
  const hosts = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeHostname(candidate);
    if (normalized === null) {
      throw new TypeError(`Invalid allowed host: ${candidate}`);
    }
    hosts.add(normalized);
  }
  if (hosts.size === 0) {
    throw new TypeError("allowedHosts must contain at least one host.");
  }
  return hosts;
}

function normalizedAllowedOrigins(
  configured: ReadonlyArray<string> | undefined,
): ReadonlySet<string> | undefined {
  if (configured === undefined) return undefined;
  const origins = new Set<string>();
  for (const candidate of configured) {
    const origin = normalizeOrigin(candidate);
    if (origin === null) {
      throw new TypeError(`Invalid allowed origin: ${candidate}`);
    }
    origins.add(origin);
  }
  if (origins.size === 0) {
    throw new TypeError("allowedOrigins must contain at least one origin.");
  }
  return origins;
}

function toMetadata(metadata: McpHttpProtectedResourceMetadata) {
  if (metadata.authorizationServers.length === 0) {
    throw new TypeError(
      "Protected resource metadata requires at least one authorization server.",
    );
  }
  const urls = [metadata.resource, ...metadata.authorizationServers];
  if (urls.some(hasUnsafeUrlCharacter)) {
    throw new TypeError("Protected resource metadata contains an unsafe URL.");
  }
  validateResourceUrl(metadata.resource);
  for (const authorizationServer of metadata.authorizationServers) {
    validateAuthorizationServerUrl(authorizationServer);
  }
  const value = {
    resource: metadata.resource,
    authorization_servers: [...metadata.authorizationServers],
    ...(metadata.scopesSupported === undefined
      ? {}
      : { scopes_supported: [...metadata.scopesSupported] }),
  };
  return OAuthProtectedResourceMetadataSchema.parse(value);
}

function validateResourceUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(
      "Protected resource metadata has an invalid resource URL.",
    );
  }
  const secure = url.protocol === "https:";
  const loopbackDevelopment =
    url.protocol === "http:" && isLoopback(url.hostname);
  if (
    (!secure && !loopbackDevelopment) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== MCP_PATH ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      "Protected resource metadata requires an HTTPS /mcp resource URL, except for loopback HTTP development.",
    );
  }
}

function validateAuthorizationServerUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(
      "Protected resource metadata has an invalid authorization server URL.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      "Authorization server URLs require HTTPS and cannot contain credentials, a query, or a fragment.",
    );
  }
}

function hasUnsafeUrlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      character === '"' ||
      character === "\\" ||
      code <= 0x1f ||
      code === 0x7f
    ) {
      return true;
    }
  }
  return false;
}

function send(
  response: import("node:http").ServerResponse,
  value: HttpResponse,
) {
  const body =
    value.body === undefined ? undefined : JSON.stringify(value.body);
  response.writeHead(value.status, {
    ...(body === undefined ? {} : { "content-type": "application/json" }),
    ...value.headers,
  });
  response.end(body);
}

function sendBeforeBodyConsumption(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  value: HttpResponse,
): void {
  response.shouldKeepAlive = false;
  request.once("error", () => undefined);
  request.resume();
  response.once("finish", () => {
    if (!request.complete && !request.destroyed) request.destroy();
  });
  send(response, {
    ...value,
    headers: { ...value.headers, connection: "close" },
  });
}

function requestUrl(hostHeader: string, path: string): string {
  return new URL(path, `http://${hostHeader}`).href;
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.origin === "null" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function parseRequestPath(target: string): string | null {
  if (
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("%")
  ) {
    return null;
  }
  try {
    const parsed = new URL(target, "http://request.invalid");
    if (
      parsed.search !== "" ||
      parsed.hash !== "" ||
      target !== parsed.pathname
    ) {
      return null;
    }
    return parsed.pathname;
  } catch {
    return null;
  }
}

function acceptableMediaType(
  value: string | undefined,
  expected: string,
): boolean {
  if (value === undefined) return false;
  return value.split(",").some((range) => {
    const [mediaType, ...parameters] = range.split(";");
    if (mediaType?.trim().toLowerCase() !== expected) return false;
    let quality = 1;
    let sawQuality = false;
    for (const parameter of parameters) {
      const separator = parameter.indexOf("=");
      if (separator === -1) continue;
      const name = parameter.slice(0, separator).trim().toLowerCase();
      if (name !== "q") continue;
      if (sawQuality) return false;
      sawQuality = true;
      const rawQuality = parameter.slice(separator + 1).trim();
      if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u.test(rawQuality)) {
        return false;
      }
      quality = Number(rawQuality);
    }
    return quality > 0;
  });
}

function exactContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function toWebHeaders(
  headers: import("node:http").IncomingHttpHeaders,
): Headers {
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

function toHeaderView(
  headers: import("node:http").IncomingHttpHeaders,
): McpHttpHeaderView {
  const values = toWebHeaders(headers);
  return Object.freeze({
    get: (name: string) => values.get(name),
    has: (name: string) => values.has(name),
  });
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

function snapshotPrincipal(value: Principal | null): Principal | null {
  if (value === null || typeof value !== "object") return null;
  let snapshot: unknown;
  try {
    snapshot = structuredClone(value);
  } catch {
    return null;
  }
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    typeof (snapshot as { readonly id?: unknown }).id !== "string" ||
    (snapshot as { readonly id: string }).id.length === 0
  ) {
    return null;
  }
  const attributes = (snapshot as { readonly attributes?: unknown }).attributes;
  if (
    attributes !== undefined &&
    (attributes === null ||
      typeof attributes !== "object" ||
      Array.isArray(attributes) ||
      (Object.getPrototypeOf(attributes) !== Object.prototype &&
        Object.getPrototypeOf(attributes) !== null))
  ) {
    return null;
  }
  return snapshot as Principal;
}

type BodyReadResult =
  | { readonly status: "ok"; readonly body: string }
  | { readonly status: "payload-too-large" }
  | { readonly status: "invalid-utf8" };

async function readBody(
  request: import("node:http").IncomingMessage,
  maxBytes: number,
): Promise<BodyReadResult> {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const chunks: string[] = [];
    let total = 0;
    let settled = false;
    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        settled = true;
        cleanup();
        request.once("error", () => undefined);
        request.resume();
        resolve({ status: "payload-too-large" });
        return;
      }
      try {
        const decoded = decoder.decode(buffer, { stream: true });
        if (decoded.length > 0) chunks.push(decoded);
      } catch {
        settled = true;
        cleanup();
        request.once("error", () => undefined);
        request.resume();
        resolve({ status: "invalid-utf8" });
      }
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const decoded = decoder.decode();
        if (decoded.length > 0) chunks.push(decoded);
        resolve({ status: "ok", body: chunks.join("") });
      } catch {
        resolve({ status: "invalid-utf8" });
      }
    };
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAborted = (): void => onError(new Error("Request aborted."));
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
    } else if (request.readableEnded) {
      onEnd();
    }
  });
}

function declaredBodyExceedsLimit(
  request: import("node:http").IncomingMessage,
  maxBytes: number,
): boolean {
  const value = request.headers["content-length"];
  if (value === undefined || Array.isArray(value) || !/^\d+$/u.test(value)) {
    return false;
  }
  return BigInt(value) > BigInt(maxBytes);
}

function sendPayloadTooLarge(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
): void {
  sendBeforeBodyConsumption(request, response, {
    status: 413,
    body: { error: "payload_too_large" },
  });
}

function sendProtocolError(
  response: import("node:http").ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  send(response, {
    status,
    body: {
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    },
  });
}

async function writeWebResponse(
  target: import("node:http").ServerResponse,
  source: Response,
): Promise<void> {
  const headers: Record<string, string> = {};
  source.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = Buffer.from(await source.arrayBuffer());
  target.writeHead(source.status, headers);
  target.end(body);
}

export async function serveMcpHttp<Capabilities extends CapabilityMap>(
  engine: Engine<Capabilities>,
  options: ServeMcpHttpOptions,
): Promise<McpHttpServerHandle> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const maxRequestBodyBytes =
    options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes <= 0) {
    throw new TypeError("maxRequestBodyBytes must be a positive safe integer.");
  }
  const auth = snapshotAuthOptions(options.auth);
  const allowedHosts = normalizedAllowedHosts(host, options.allowedHosts);
  const allowedOrigins = normalizedAllowedOrigins(options.allowedOrigins);
  const metadata =
    auth.mode === "required" && auth.resourceMetadata !== undefined
      ? toMetadata(auth.resourceMetadata)
      : undefined;
  const metadataUrl =
    metadata === undefined
      ? undefined
      : getOAuthProtectedResourceMetadataUrl(new URL(metadata.resource));
  const metadataPath =
    metadataUrl === undefined ? undefined : new URL(metadataUrl).pathname;
  const activeRequests = new Set<AbortController>();

  const httpServer = createServer((request, response) => {
    void (async () => {
      if (rawHeaderCount(request.rawHeaders, "host") !== 1) {
        sendBeforeBodyConsumption(request, response, {
          status: 403,
          body: { error: "forbidden" },
        });
        return;
      }
      const hostHeader = request.headers.host;
      if (hostHeader === undefined) {
        sendBeforeBodyConsumption(request, response, {
          status: 403,
          body: { error: "forbidden" },
        });
        return;
      }
      const requestHost = normalizeRequestHostname(hostHeader);
      if (requestHost === null || !allowedHosts.has(requestHost)) {
        sendBeforeBodyConsumption(request, response, {
          status: 403,
          body: { error: "forbidden" },
        });
        return;
      }
      if (rawHeaderCount(request.rawHeaders, "authorization") > 1) {
        sendBeforeBodyConsumption(request, response, {
          status: 400,
          body: { error: "invalid_authorization_header" },
        });
        return;
      }

      const originHeader = request.headers.origin;
      if (originHeader !== undefined) {
        const origin = normalizeOrigin(originHeader);
        if (origin === null) {
          sendBeforeBodyConsumption(request, response, {
            status: 403,
            body: { error: "forbidden" },
          });
          return;
        }
        if (allowedOrigins === undefined || !allowedOrigins.has(origin)) {
          sendBeforeBodyConsumption(request, response, {
            status: 403,
            body: { error: "forbidden" },
          });
          return;
        }
      }

      const requestTarget = request.url ?? "/";
      const path = parseRequestPath(requestTarget);
      if (path === null) {
        sendBeforeBodyConsumption(request, response, {
          status: 400,
          body: { error: "invalid_request_target" },
        });
        return;
      }
      const method = request.method ?? "GET";
      if (metadata !== undefined && path === metadataPath) {
        if (request.method !== "GET") {
          sendBeforeBodyConsumption(request, response, {
            status: 405,
            headers: { allow: "GET" },
            body: { error: "method_not_allowed" },
          });
          return;
        }
        sendBeforeBodyConsumption(request, response, {
          status: 200,
          body: metadata,
        });
        return;
      }
      if (path !== MCP_PATH) {
        sendBeforeBodyConsumption(request, response, {
          status: 404,
          body: { error: "not_found" },
        });
        return;
      }
      if (method !== "POST") {
        sendBeforeBodyConsumption(request, response, {
          status: 405,
          headers: { allow: "POST" },
          body: { error: "method_not_allowed" },
        });
        return;
      }
      if (declaredBodyExceedsLimit(request, maxRequestBodyBytes)) {
        sendPayloadTooLarge(request, response);
        return;
      }

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

      let principal: Principal | null = null;
      if (auth.mode === "required") {
        let authenticated: Principal | null;
        try {
          authenticated = await auth.authenticate({
            path,
            method,
            headers: toHeaderView(request.headers),
            signal: abortController.signal,
          });
        } catch {
          sendBeforeBodyConsumption(request, response, {
            status: 500,
            body: { error: "authentication_failed" },
          });
          return;
        }
        const authenticatedSnapshot = snapshotPrincipal(authenticated);
        if (authenticatedSnapshot === null) {
          sendBeforeBodyConsumption(request, response, {
            status: 401,
            headers:
              metadataUrl === undefined
                ? { "www-authenticate": "Bearer" }
                : {
                    "www-authenticate": `Bearer resource_metadata="${metadataUrl}"`,
                  },
            body: { error: "unauthorized" },
          });
          return;
        }
        principal = authenticatedSnapshot;
      }

      const accept = request.headers.accept;
      if (
        Array.isArray(accept) ||
        !acceptableMediaType(accept, "application/json") ||
        !acceptableMediaType(accept, "text/event-stream")
      ) {
        sendBeforeBodyConsumption(request, response, {
          status: 406,
          body: {
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message:
                "Not Acceptable: Client must accept both application/json and text/event-stream",
            },
            id: null,
          },
        });
        return;
      }
      const contentType = request.headers["content-type"];
      if (Array.isArray(contentType) || !exactContentType(contentType)) {
        sendBeforeBodyConsumption(request, response, {
          status: 415,
          body: {
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message:
                "Unsupported Media Type: Content-Type must be application/json",
            },
            id: null,
          },
        });
        return;
      }

      const protocolServer = createMcpServer(engine, {
        principal,
        source: "mcp-http",
        requestSignal: abortController.signal,
      });
      const statelessTransportOptions: WebStandardStreamableHTTPServerTransportOptions =
        {
          enableJsonResponse: true,
        };
      const transport = new WebStandardStreamableHTTPServerTransport(
        statelessTransportOptions,
      );
      let consumedBody = false;
      try {
        const bodyResult = await readBody(request, maxRequestBodyBytes);
        if (bodyResult.status === "payload-too-large") {
          sendPayloadTooLarge(request, response);
          return;
        }
        if (bodyResult.status === "invalid-utf8") {
          sendBeforeBodyConsumption(request, response, {
            status: 400,
            body: {
              jsonrpc: "2.0",
              error: { code: -32700, message: "Parse error: Invalid UTF-8" },
              id: null,
            },
          });
          return;
        }
        consumedBody = true;
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(bodyResult.body);
        } catch {
          sendProtocolError(response, 400, -32700, "Parse error: Invalid JSON");
          return;
        }
        if (Array.isArray(parsedBody)) {
          sendProtocolError(
            response,
            400,
            -32600,
            "Invalid Request: Exactly one JSON-RPC message is required",
          );
          return;
        }
        const webHeaders = toWebHeaders(request.headers);
        webHeaders.set("accept", "application/json, text/event-stream");
        webHeaders.set("content-type", "application/json");
        const webRequest = new Request(requestUrl(hostHeader, path), {
          method: "POST",
          headers: webHeaders,
          signal: abortController.signal,
        });
        await protocolServer.connect(transport);
        const webResponse = await transport.handleRequest(webRequest, {
          parsedBody,
        });
        await writeWebResponse(response, webResponse);
      } catch {
        if (!response.headersSent && !response.destroyed) {
          const failure = {
            status: 500,
            body: {
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal server error" },
              id: null,
            },
          } as const;
          if (consumedBody) send(response, failure);
          else sendBeforeBodyConsumption(request, response, failure);
        }
      } finally {
        await protocolServer.close().catch(() => undefined);
      }
    })().catch(() => {
      if (!response.headersSent && !response.destroyed) {
        sendBeforeBodyConsumption(request, response, {
          status: 500,
          body: { error: "internal_error" },
        });
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
