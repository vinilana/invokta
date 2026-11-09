/**
 * The single stateless MCP Streamable HTTP protocol boundary (ADR 0007, ADR
 * 0039, ADR 0042). It depends only on ECMAScript, the Fetch API, Web Streams,
 * and Web-standard SDK modules, so every host adapter shares one
 * implementation: `createMcpHttpHandler` passes a Fetch `Request`, and
 * `serveMcpHttp` passes a Node.js request it has described as
 * `McpHttpRequestFacts`.
 */
import type { CapabilityMap, Engine, Principal } from "@invokta/core";
import type { WebStandardStreamableHTTPServerTransportOptions } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { OAuthProtectedResourceMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";

import { requestsProgressNotifications } from "./progress.js";
import {
  bindVisibility,
  createMcpServer,
  createMcpToolCatalog,
  type McpCapabilityVisibility,
  optionalVisible,
  snapshotVisibility,
} from "./protocol-server.js";
import { preserveFalsyRequestIds } from "./request-id-transport.js";

const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_CHALLENGE_SCOPE_BYTES = 4096;
const DEFAULT_MCP_PATH = "/mcp";
const MAX_MCP_PATH_BYTES = 256;
const MCP_PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/u;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"] as const;

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
  readonly challengeScopes?: ReadonlyArray<string>;
  readonly resourceMetadata?: McpHttpProtectedResourceMetadata;
}

interface DangerouslyDisabledMcpHttpAuth {
  readonly mode: "dangerously-disabled-for-development";
}

export type McpHttpAuthOptions =
  | RequiredMcpHttpAuth
  | DangerouslyDisabledMcpHttpAuth;

/** Options shared by every MCP HTTP host adapter. */
export interface McpHttpHandlerOptions {
  /**
   * The canonical request path that reaches protocol dispatch. Defaults to
   * `/mcp`. A configured value must be an absolute path of unreserved ASCII
   * segments ending in `/mcp`, so several engines can share one origin while
   * every mount keeps the canonical MCP route visible.
   */
  readonly path?: string;
  readonly allowedHosts?: ReadonlyArray<string>;
  readonly allowedOrigins?: ReadonlyArray<string>;
  readonly maxRequestBodyBytes?: number;
  readonly auth: McpHttpAuthOptions;
  /**
   * Lists and serves only the capabilities this predicate shows to the
   * authenticated principal. A hidden capability answers like a nonexistent
   * tool. Defaults to every capability.
   */
  readonly visibility?: McpCapabilityVisibility;
}

/**
 * One HTTP request as the protocol boundary needs to see it. A host adapter
 * describes the facts it can observe; the boundary decides everything else.
 */
export interface McpHttpRequestFacts {
  readonly method: string;
  /** The request target: a raw origin-form target, or a URL's path, query, and fragment. */
  readonly target: string;
  /** Every authority the request names, or `null` when it names none or more than one. */
  readonly authorities: ReadonlyArray<string> | null;
  readonly headers: Headers;
  /** Whether the host observed more than one field with this name. */
  readonly repeated: (name: "authorization" | "content-type") => boolean;
  readonly body: ReadableStream<Uint8Array> | null;
  readonly signal: AbortSignal;
}

export interface McpHttpProtocolResult {
  readonly response: Response;
  /**
   * Whether the body is a progress event stream that a host must relay chunk
   * by chunk, reading the next chunk only when its connection can take it.
   */
  readonly streaming?: boolean;
  /**
   * Whether the response was produced before the request body was consumed.
   * A host that owns the connection closes it after the response instead of
   * keeping a slow, unread body alive.
   */
  readonly bodyUnconsumed: boolean;
}

export type McpHttpProtocol = (
  facts: McpHttpRequestFacts,
) => Promise<McpHttpProtocolResult>;

interface RequiredMcpHttpAuthSnapshot {
  readonly mode: "required";
  readonly authenticate: RequiredMcpHttpAuth["authenticate"];
  readonly challengeScopes?: ReadonlyArray<string>;
  readonly resourceMetadata?: McpHttpProtectedResourceMetadata;
}

interface DangerouslyDisabledMcpHttpAuthSnapshot {
  readonly mode: "dangerously-disabled-for-development";
}

type McpHttpAuthSnapshot =
  | RequiredMcpHttpAuthSnapshot
  | DangerouslyDisabledMcpHttpAuthSnapshot;

function snapshotChallengeScopes(
  value: ReadonlyArray<string> | undefined,
  hasResourceMetadata: boolean,
): ReadonlyArray<string> | undefined {
  if (value === undefined) return undefined;
  if (!hasResourceMetadata) {
    throw new TypeError("auth.challengeScopes requires auth.resourceMetadata.");
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(
      "auth.challengeScopes must contain at least one scope token.",
    );
  }
  const scopes: string[] = [];
  const seen = new Set<string>();
  let serializedBytes = 0;
  for (const scope of value) {
    if (
      typeof scope !== "string" ||
      !/^[\x21\x23-\x5b\x5d-\x7e]+$/u.test(scope)
    ) {
      throw new TypeError(
        "auth.challengeScopes must contain only RFC 6749 scope tokens.",
      );
    }
    if (seen.has(scope)) {
      throw new TypeError("auth.challengeScopes must not contain duplicates.");
    }
    seen.add(scope);
    // Scope tokens are printable ASCII, so each character is one byte.
    serializedBytes += scope.length + (scopes.length === 0 ? 0 : 1);
    if (serializedBytes > MAX_CHALLENGE_SCOPE_BYTES) {
      throw new TypeError(
        `auth.challengeScopes must serialize to at most ${MAX_CHALLENGE_SCOPE_BYTES} bytes.`,
      );
    }
    scopes.push(scope);
  }
  return Object.freeze(scopes);
}

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
    const challengeScopes = snapshotChallengeScopes(
      value.challengeScopes,
      value.resourceMetadata !== undefined,
    );
    return Object.freeze({
      mode: "required",
      authenticate: value.authenticate,
      ...(challengeScopes === undefined ? {} : { challengeScopes }),
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

function bearerChallenge(
  metadataUrl: string | undefined,
  challengeScopes: ReadonlyArray<string> | undefined,
): string {
  if (metadataUrl === undefined) return "Bearer";
  const resourceMetadata = `resource_metadata="${metadataUrl}"`;
  return challengeScopes === undefined
    ? `Bearer ${resourceMetadata}`
    : `Bearer ${resourceMetadata}, scope="${challengeScopes.join(" ")}"`;
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

/**
 * The loopback form OAuth metadata may use. The MCP client trusts only the
 * literal loopback hosts (RFC 8252 prefers them over `localhost`), so the
 * published document must not be broader than what the client will accept.
 */
function isLiteralLoopback(host: string): boolean {
  const normalized = normalizeHostname(host);
  return normalized === "127.0.0.1" || normalized === "[::1]";
}

/**
 * Without `allowedHosts`, the loopback names are trusted, plus the bind host of
 * a Node.js listener; a non-loopback bind must name its hosts explicitly.
 */
function normalizedAllowedHosts(
  bindHost: string | undefined,
  configured: ReadonlyArray<string> | undefined,
): ReadonlySet<string> {
  if (
    configured === undefined &&
    bindHost !== undefined &&
    !isLoopback(bindHost)
  ) {
    throw new TypeError(
      "allowedHosts is required when the MCP HTTP server binds to a non-loopback host.",
    );
  }
  const candidates =
    configured ??
    (bindHost === undefined ? LOOPBACK_HOSTS : [...LOOPBACK_HOSTS, bindHost]);
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

/**
 * Validates a mount path once, at construction. The rule is deliberately
 * narrower than URL syntax: unreserved ASCII segments only, no dot segments,
 * no percent encoding, no empty segment, no trailing slash, a bounded size,
 * and a final `mcp` segment. `parseRequestPath` rejects every alias of such
 * a path at request time, so the two checks agree on the single accepted
 * spelling.
 */
function normalizeMountPath(value: string | undefined): string {
  if (value === undefined) return DEFAULT_MCP_PATH;
  const invalid = (): TypeError =>
    new TypeError(
      `path must be an absolute path of unreserved ASCII segments ending in ${DEFAULT_MCP_PATH}, without dot segments, percent encoding, query, fragment, or trailing slash, and at most ${String(MAX_MCP_PATH_BYTES)} bytes.`,
    );
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_MCP_PATH_BYTES ||
    !value.startsWith("/")
  ) {
    throw invalid();
  }
  const segments = value.slice(1).split("/");
  for (const segment of segments) {
    if (
      !MCP_PATH_SEGMENT.test(segment) ||
      segment === "." ||
      segment === ".."
    ) {
      throw invalid();
    }
  }
  if (segments[segments.length - 1] !== "mcp") throw invalid();
  return value;
}

function toMetadata(
  metadata: McpHttpProtectedResourceMetadata,
  mountPath: string,
) {
  if (metadata.authorizationServers.length === 0) {
    throw new TypeError(
      "Protected resource metadata requires at least one authorization server.",
    );
  }
  const urls = [metadata.resource, ...metadata.authorizationServers];
  if (urls.some(hasUnsafeUrlCharacter)) {
    throw new TypeError("Protected resource metadata contains an unsafe URL.");
  }
  validateResourceUrl(metadata.resource, mountPath);
  for (const authorizationServer of metadata.authorizationServers) {
    validateAuthorizationServerUrl(authorizationServer, metadata.resource);
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

/**
 * The RFC 9728 path-suffix location of a resource's metadata document. The
 * SDK's equivalent helper lives in its Express-bound authorization router, so
 * the portable boundary derives the same URL itself.
 */
function protectedResourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  const resourcePath = url.pathname === "/" ? "" : url.pathname;
  return new URL(`/.well-known/oauth-protected-resource${resourcePath}`, url)
    .href;
}

function validateResourceUrl(value: string, mountPath: string): void {
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
    url.protocol === "http:" && isLiteralLoopback(url.hostname);
  if (
    (!secure && !loopbackDevelopment) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== mountPath ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      `Protected resource metadata requires an HTTPS resource URL whose path is exactly the configured MCP path (${mountPath}), except for literal-loopback (127.0.0.1 or [::1]) HTTP development.`,
    );
  }
}

function validateAuthorizationServerUrl(value: string, resource: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(
      "Protected resource metadata has an invalid authorization server URL.",
    );
  }
  // A loopback resource may advertise any loopback authorization server, not
  // only one sharing its origin: a local identity provider normally runs as a
  // separate process on its own port. Both ends stay on the developer's
  // machine, so the trust boundary does not move, and a deployed HTTPS
  // resource still cannot advertise plain HTTP at all.
  const resourceUrl = new URL(resource);
  const loopbackDevelopment =
    url.protocol === "http:" &&
    isLiteralLoopback(url.hostname) &&
    resourceUrl.protocol === "http:" &&
    isLiteralLoopback(resourceUrl.hostname);
  if (
    (url.protocol !== "https:" && !loopbackDevelopment) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      "Authorization server URLs require HTTPS, except on literal loopback behind a literal-loopback HTTP resource, and cannot contain credentials, a query, or a fragment.",
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

function acceptableMediaType(value: string | null, expected: string): boolean {
  if (value === null) return false;
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

function exactContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function toHeaderView(headers: Headers): McpHttpHeaderView {
  return Object.freeze({
    get: (name: string) => headers.get(name),
    has: (name: string) => headers.has(name),
  });
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

/**
 * Reads at most `maxBytes` from a byte stream, decoding strict UTF-8
 * incrementally. Reading stops, and the stream is cancelled, as soon as the
 * limit is crossed, a byte sequence is malformed, or the request signal
 * aborts, so no more than one chunk beyond the limit is ever held and a
 * stalled body cannot outlive its request. Cancellation rejects.
 */
async function readBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal: AbortSignal,
): Promise<BodyReadResult> {
  if (body === null) return { status: "ok", body: "" };
  if (signal.aborted) throw new Error("The request was cancelled.");
  const reader = body.getReader();
  const cancel = (reason?: unknown): void => {
    void reader.cancel(reason).catch(() => undefined);
  };
  const onAbort = (): void => cancel(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const chunks: string[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      // A cancelled reader reports completion; an aborted request never does.
      if (signal.aborted) throw new Error("The request was cancelled.");
      if (done) break;
      if (!ArrayBuffer.isView(value)) {
        cancel();
        throw new TypeError("The request body must be a byte stream.");
      }
      total += value.byteLength;
      if (total > maxBytes) {
        cancel();
        return { status: "payload-too-large" };
      }
      try {
        const decoded = decoder.decode(value, { stream: true });
        if (decoded.length > 0) chunks.push(decoded);
      } catch {
        cancel();
        return { status: "invalid-utf8" };
      }
    }
    try {
      const decoded = decoder.decode();
      if (decoded.length > 0) chunks.push(decoded);
    } catch {
      return { status: "invalid-utf8" };
    }
    return { status: "ok", body: chunks.join("") };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function declaredBodyExceedsLimit(
  value: string | null,
  maxBytes: number,
): boolean {
  if (value === null || !/^\d+$/u.test(value)) return false;
  return BigInt(value) > BigInt(maxBytes);
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function protocolErrorBody(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null } as const;
}

/** Connection-scoped fields that belong to the host, not to the response. */
const HOP_BY_HOP_HEADERS = ["connection", "keep-alive", "transfer-encoding"];

function withoutHopByHopHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  return headers;
}

function isEventStream(response: Response): boolean {
  return (
    response.body !== null &&
    response.headers.get("content-type")?.split(";", 1)[0]?.trim() ===
      "text/event-stream"
  );
}

/**
 * Relays the SDK's progress event stream through a queue of at most one chunk.
 * The returned gate is open only while that queue has room, so the protocol
 * server offers a notification only when the consumer has taken the previous
 * one; while the consumer stalls, the forwarder holds a single report instead
 * of letting the SDK queue grow. `onSettled` runs once, with `cancelled` set
 * when the consumer cancelled the stream or reading it failed.
 */
function relayProgressStream(
  source: ReadableStream<Uint8Array>,
  onSettled: (cancelled: boolean) => void,
): { readonly stream: ReadableStream<Uint8Array>; hasCapacity(): boolean } {
  const reader = source.getReader();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let settled = false;
  const settle = (cancelled: boolean): void => {
    if (settled) return;
    settled = true;
    onSettled(cancelled);
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(streamController) {
        controller = streamController;
      },
      async pull(streamController) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (error) {
          settle(true);
          streamController.error(error);
          return;
        }
        if (chunk.done) {
          streamController.close();
          settle(false);
          return;
        }
        streamController.enqueue(chunk.value);
      },
      async cancel(reason) {
        settle(true);
        await reader.cancel(reason).catch(() => undefined);
      },
    },
    new CountQueuingStrategy({ highWaterMark: 1 }),
  );
  return {
    stream,
    hasCapacity: () => !settled && (controller.desiredSize ?? 0) > 0,
  };
}

/** A response produced before the request body was read to its end. */
function early(
  status: number,
  body: unknown,
  headers?: Readonly<Record<string, string>>,
): McpHttpProtocolResult {
  return {
    response: jsonResponse(status, body, headers),
    bodyUnconsumed: true,
  };
}

/** A response produced after the request body was read to its end. */
function consumed(status: number, body: unknown): McpHttpProtocolResult {
  return { response: jsonResponse(status, body), bodyUnconsumed: false };
}

function forbidden(): McpHttpProtocolResult {
  return early(403, { error: "forbidden" });
}

/** The sanitized response for a failure outside every specific boundary. */
export function internalFailure(): McpHttpProtocolResult {
  return early(500, { error: "internal_error" });
}

/**
 * Validates and snapshots the shared configuration, then returns the request
 * boundary. A Node.js listener passes its `bindHost`; a Fetch handler has none.
 */
export function createMcpHttpProtocol<Capabilities extends CapabilityMap>(
  engine: Engine<Capabilities>,
  options: McpHttpHandlerOptions,
  bindHost?: string,
): McpHttpProtocol {
  const maxRequestBodyBytes =
    options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes <= 0) {
    throw new TypeError("maxRequestBodyBytes must be a positive safe integer.");
  }
  const mountPath = normalizeMountPath(options.path);
  const auth = snapshotAuthOptions(options.auth);
  const allowedHosts = normalizedAllowedHosts(bindHost, options.allowedHosts);
  const allowedOrigins = normalizedAllowedOrigins(options.allowedOrigins);
  const metadata =
    auth.mode === "required" && auth.resourceMetadata !== undefined
      ? toMetadata(auth.resourceMetadata, mountPath)
      : undefined;
  const metadataUrl =
    metadata === undefined
      ? undefined
      : protectedResourceMetadataUrl(metadata.resource);
  const metadataPath =
    metadataUrl === undefined ? undefined : new URL(metadataUrl).pathname;
  const toolCatalog = createMcpToolCatalog(engine);
  const visibility = snapshotVisibility(options.visibility);

  return async function handleMcpHttpRequest(facts) {
    try {
      const authorities = facts.authorities;
      if (authorities === null || authorities.length === 0) return forbidden();
      for (const authority of authorities) {
        const requestHost = normalizeRequestHostname(authority);
        if (requestHost === null || !allowedHosts.has(requestHost)) {
          return forbidden();
        }
      }
      if (facts.repeated("authorization")) {
        return early(400, { error: "invalid_authorization_header" });
      }

      const originHeader = facts.headers.get("origin");
      if (originHeader !== null) {
        const origin = normalizeOrigin(originHeader);
        if (
          origin === null ||
          allowedOrigins === undefined ||
          !allowedOrigins.has(origin)
        ) {
          return forbidden();
        }
      }

      const path = parseRequestPath(facts.target);
      if (path === null) return early(400, { error: "invalid_request_target" });
      const method = facts.method;
      if (metadata !== undefined && path === metadataPath) {
        if (method !== "GET") {
          return early(405, { error: "method_not_allowed" }, { allow: "GET" });
        }
        return early(200, metadata);
      }
      if (path !== mountPath) return early(404, { error: "not_found" });
      if (method !== "POST") {
        return early(405, { error: "method_not_allowed" }, { allow: "POST" });
      }
      if (
        declaredBodyExceedsLimit(
          facts.headers.get("content-length"),
          maxRequestBodyBytes,
        )
      ) {
        return early(413, { error: "payload_too_large" });
      }

      let principal: Principal | null = null;
      if (auth.mode === "required") {
        let authenticated: Principal | null;
        try {
          authenticated = await auth.authenticate({
            path,
            method,
            headers: toHeaderView(facts.headers),
            signal: facts.signal,
          });
        } catch {
          return early(500, { error: "authentication_failed" });
        }
        const authenticatedSnapshot = snapshotPrincipal(authenticated);
        if (authenticatedSnapshot === null) {
          return early(
            401,
            { error: "unauthorized" },
            {
              "www-authenticate": bearerChallenge(
                metadataUrl,
                auth.challengeScopes,
              ),
            },
          );
        }
        principal = authenticatedSnapshot;
      }

      const accept = facts.headers.get("accept");
      if (
        !acceptableMediaType(accept, "application/json") ||
        !acceptableMediaType(accept, "text/event-stream")
      ) {
        return early(
          406,
          protocolErrorBody(
            -32000,
            "Not Acceptable: Client must accept both application/json and text/event-stream",
          ),
        );
      }
      if (
        facts.repeated("content-type") ||
        !exactContentType(facts.headers.get("content-type"))
      ) {
        return early(
          415,
          protocolErrorBody(
            -32000,
            "Unsupported Media Type: Content-Type must be application/json",
          ),
        );
      }

      return await dispatch(facts, path, principal, authorities[0] as string);
    } catch {
      return internalFailure();
    }
  };

  async function dispatch(
    facts: McpHttpRequestFacts,
    path: string,
    principal: Principal | null,
    authority: string,
  ): Promise<McpHttpProtocolResult> {
    // A cancelled progress stream aborts the invocation in every host.
    const streamAbort = new AbortController();
    let progressCapacity = (): boolean => true;
    const protocolServer = createMcpServer(
      engine,
      {
        principal,
        source: "mcp-http",
        ...optionalVisible(bindVisibility(visibility, principal)),
        requestSignal: AbortSignal.any([facts.signal, streamAbort.signal]),
        canSendProgress: () => progressCapacity(),
      },
      toolCatalog,
    );
    const closeProtocolServer = (): Promise<void> =>
      protocolServer.close().catch(() => undefined);
    let consumedBody = false;
    let streaming = false;
    try {
      const bodyResult = await readBody(
        facts.body,
        maxRequestBodyBytes,
        facts.signal,
      );
      if (bodyResult.status === "payload-too-large") {
        return early(413, { error: "payload_too_large" });
      }
      if (bodyResult.status === "invalid-utf8") {
        return early(
          400,
          protocolErrorBody(-32700, "Parse error: Invalid UTF-8"),
        );
      }
      consumedBody = true;
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(bodyResult.body);
      } catch {
        return consumed(
          400,
          protocolErrorBody(-32700, "Parse error: Invalid JSON"),
        );
      }
      if (Array.isArray(parsedBody)) {
        return consumed(
          400,
          protocolErrorBody(
            -32600,
            "Invalid Request: Exactly one JSON-RPC message is required",
          ),
        );
      }
      // Only a tools/call carrying a usable progress token is answered with a
      // request-scoped SSE stream; every other message keeps the JSON body.
      const progressStream = requestsProgressNotifications(parsedBody);
      const statelessTransportOptions: WebStandardStreamableHTTPServerTransportOptions =
        { enableJsonResponse: !progressStream };
      const transport = new WebStandardStreamableHTTPServerTransport(
        statelessTransportOptions,
      );
      const sdkHeaders = new Headers(facts.headers);
      sdkHeaders.set("accept", "application/json, text/event-stream");
      sdkHeaders.set("content-type", "application/json");
      const sdkRequest = new Request(
        new URL(path, `http://${authority}`).href,
        { method: "POST", headers: sdkHeaders, signal: facts.signal },
      );
      await protocolServer.connect(preserveFalsyRequestIds(transport));
      const sdkResponse = await transport.handleRequest(sdkRequest, {
        parsedBody,
      });
      if (progressStream && isEventStream(sdkResponse)) {
        const relay = relayProgressStream(
          sdkResponse.body as ReadableStream<Uint8Array>,
          (cancelled) => {
            if (cancelled) streamAbort.abort();
            void closeProtocolServer();
          },
        );
        progressCapacity = relay.hasCapacity;
        streaming = true;
        return {
          response: new Response(relay.stream, {
            status: sdkResponse.status,
            headers: withoutHopByHopHeaders(sdkResponse.headers),
          }),
          bodyUnconsumed: false,
          streaming: true,
        };
      }
      // The stateless JSON profile answers with a complete body; reading it
      // here lets the protocol server close only after the response exists.
      const responseBody =
        sdkResponse.body === null ? null : await sdkResponse.arrayBuffer();
      return {
        response: new Response(responseBody, {
          status: sdkResponse.status,
          headers: sdkResponse.headers,
        }),
        bodyUnconsumed: false,
      };
    } catch {
      const failure = protocolErrorBody(-32603, "Internal server error");
      return consumedBody ? consumed(500, failure) : early(500, failure);
    } finally {
      // A progress stream closes its protocol server when the stream settles.
      if (!streaming) await closeProtocolServer();
    }
  }
}
