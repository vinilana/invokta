import {
  type CapabilityMap,
  type Engine,
  EngineError,
  type EngineErrorCode,
  type Principal,
} from "@invokta/core";

import { createHttpOpenApiDocument, normalizeBasePath } from "./openapi.js";

const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_CORS_MAX_AGE_SECONDS = 86_400;
const LOOPBACK_HOSTS = Object.freeze(["127.0.0.1", "localhost", "[::1]"]);
const DEFAULT_CORS_HEADERS = Object.freeze(["authorization", "content-type"]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const PREFLIGHT_VARY =
  "Origin, Access-Control-Request-Method, Access-Control-Request-Headers";

/**
 * A read-only view of the request headers. It has the same structure as the
 * MCP HTTP adapter's header view, so one authenticator serves both adapters.
 */
export interface HttpHeaderView {
  readonly get: (name: string) => string | null;
  readonly has: (name: string) => boolean;
}

/**
 * What an authenticator receives. It has the same structure as
 * `McpHttpAuthenticationRequest` from `@invokta/mcp`.
 */
export interface HttpAuthenticationRequest {
  readonly path: string;
  readonly method: string;
  readonly headers: HttpHeaderView;
  readonly signal: AbortSignal;
}

interface RequiredHttpAuth {
  readonly mode: "required";
  readonly authenticate: (
    request: HttpAuthenticationRequest,
  ) => Principal | null | Promise<Principal | null>;
}

interface DangerouslyDisabledHttpAuth {
  readonly mode: "dangerously-disabled-for-development";
}

export type HttpAuthOptions = RequiredHttpAuth | DangerouslyDisabledHttpAuth;

export interface HttpCorsOptions {
  /** Exact HTTP(S) origins allowed to call the routes from a browser. */
  readonly allowedOrigins: ReadonlyArray<string>;
  /**
   * Request headers allowed in addition to `authorization` and
   * `content-type`, such as an API-key header.
   */
  readonly allowedHeaders?: ReadonlyArray<string>;
  /** Preflight cache lifetime from 0 through 86,400 seconds; omitted by default. */
  readonly maxAgeSeconds?: number;
}

export interface HttpHandlerOptions {
  /** Mount path of every route. Defaults to `/`. */
  readonly basePath?: string;
  /** Exact request host names. Defaults to the loopback names. */
  readonly allowedHosts?: ReadonlyArray<string>;
  /** Browser cross-origin access. Disabled by default. */
  readonly cors?: HttpCorsOptions;
  /** Request body limit in bytes. Defaults to 1,048,576. */
  readonly maxRequestBodyBytes?: number;
  readonly auth: HttpAuthOptions;
  /**
   * Lists, describes, documents, and invokes only the capabilities this
   * predicate shows to the authenticated principal. A hidden capability
   * answers like an ID outside the catalog. Defaults to every capability.
   */
  readonly visibility?: HttpCapabilityVisibility;
}

/**
 * Decides whether one capability is visible to the authenticated principal.
 * It is synchronous and reads only its arguments. Visibility never grants
 * access: the capability's access rule still runs on every invocation.
 */
export type HttpCapabilityVisibility = (args: {
  readonly principal: Principal | null;
  readonly capabilityId: string;
}) => boolean;

const MAX_CACHED_OPENAPI_DOCUMENTS = 64;

function snapshotVisibility(
  value: unknown,
): HttpCapabilityVisibility | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "function") {
    throw new TypeError("visibility must be a function.");
  }
  return value as HttpCapabilityVisibility;
}

/**
 * Binds the visibility option to one request's principal. The predicate sees
 * a deep-frozen copy and anything but a returned `true`, including a throw,
 * hides the capability.
 */
function bindVisibility(
  visibility: HttpCapabilityVisibility,
  principal: Principal | null,
): (capabilityId: string) => boolean {
  const frozen =
    principal === null ? null : deepFreeze(structuredClone(principal));
  return (capabilityId) => {
    try {
      return visibility({ principal: frozen, capabilityId }) === true;
    } catch {
      return false;
    }
  };
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export type HttpHandler = (request: Request) => Promise<Response>;

/** Codes for failures detected by the HTTP boundary before `engine.invoke`. */
export type HttpAdapterErrorCode =
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "HOST_NOT_ALLOWED"
  | "ORIGIN_NOT_ALLOWED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_JSON"
  | "INVALID_REQUEST"
  | "INTERNAL_ERROR";

export type HttpErrorCode = EngineErrorCode | HttpAdapterErrorCode;

/** The only error body shape the adapter writes. */
export interface HttpErrorBody {
  readonly error: {
    readonly code: HttpErrorCode;
    readonly message: string;
    readonly publicDetails?: unknown;
  };
}

// `satisfies` makes a new engine error code a compile error until it has a
// status; the Map keeps lookups of caller-influenced strings prototype-free.
const engineErrorStatuses = {
  INPUT_INVALID: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CAPABILITY_NOT_FOUND: 404,
  DOMAIN_ERROR: 422,
  OUTPUT_INVALID: 500,
  EXECUTION_FAILED: 500,
  CANCELLED: 503,
} as const satisfies Record<EngineErrorCode, number>;
const engineErrorStatus: ReadonlyMap<string, number> = new Map(
  Object.entries(engineErrorStatuses),
);

const adapterErrorMessages: Readonly<Record<HttpAdapterErrorCode, string>> =
  Object.freeze({
    NOT_FOUND: "The requested route does not exist.",
    METHOD_NOT_ALLOWED: "The request method is not allowed for this route.",
    HOST_NOT_ALLOWED: "The request host is not allowed.",
    ORIGIN_NOT_ALLOWED: "The request origin is not allowed.",
    UNSUPPORTED_MEDIA_TYPE: "The request body must use application/json.",
    PAYLOAD_TOO_LARGE: "The request body exceeds the configured limit.",
    INVALID_JSON: "The request body must be valid UTF-8 JSON.",
    INVALID_REQUEST: "The request is malformed.",
    INTERNAL_ERROR: "The request could not be processed.",
  });

const UNAUTHENTICATED_BODY = JSON.stringify({
  error: { code: "UNAUTHENTICATED", message: "Authentication is required." },
});
const EXECUTION_FAILED_BODY = JSON.stringify({
  error: { code: "EXECUTION_FAILED", message: "Capability execution failed." },
});

type HeaderRecord = Readonly<Record<string, string>>;

function jsonResponse(
  status: number,
  body: string,
  headers: HeaderRecord = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

/** Builds an adapter error response. Shared with the Node entry point. */
export function httpErrorResponse(
  status: number,
  code: HttpAdapterErrorCode,
  headers: HeaderRecord = {},
): Response {
  return jsonResponse(
    status,
    JSON.stringify({ error: { code, message: adapterErrorMessages[code] } }),
    headers,
  );
}

function engineErrorResponse(error: unknown, headers: HeaderRecord): Response {
  try {
    if (!(error instanceof EngineError)) {
      return jsonResponse(500, EXECUTION_FAILED_BODY, headers);
    }
    const code: unknown = error.code;
    const message: unknown = error.message;
    const publicDetails: unknown = error.publicDetails;
    const status =
      typeof code === "string" ? engineErrorStatus.get(code) : undefined;
    if (status === undefined || typeof message !== "string") {
      return jsonResponse(500, EXECUTION_FAILED_BODY, headers);
    }
    const body = JSON.stringify({
      error: {
        code,
        message,
        ...(publicDetails === undefined ? {} : { publicDetails }),
      },
    });
    return jsonResponse(
      status,
      body,
      code === "UNAUTHENTICATED"
        ? { ...headers, "www-authenticate": "Bearer" }
        : headers,
    );
  } catch {
    return jsonResponse(500, EXECUTION_FAILED_BODY, headers);
  }
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

/** Whether a bind host is a loopback name. Shared with the Node entry point. */
export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHostname(host);
  return normalized !== null && LOOPBACK_HOSTS.includes(normalized);
}

/** The default host allowlist for a loopback bind. */
export function loopbackHosts(): ReadonlyArray<string> {
  return LOOPBACK_HOSTS;
}

function normalizeAllowedHosts(
  configured: ReadonlyArray<string> | undefined,
): ReadonlySet<string> {
  const candidates = configured ?? LOOPBACK_HOSTS;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new TypeError("allowedHosts must contain at least one host.");
  }
  const hosts = new Set<string>();
  for (const candidate of candidates) {
    const normalized =
      typeof candidate === "string" && candidate !== ""
        ? normalizeHostname(candidate)
        : null;
    if (normalized === null || normalized === "") {
      throw new TypeError(`Invalid allowed host: ${String(candidate)}`);
    }
    hosts.add(normalized);
  }
  return hosts;
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

interface CorsSnapshot {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly allowedHeaders: string;
  readonly maxAgeSeconds?: string;
}

function snapshotCors(
  value: HttpCorsOptions | undefined,
): CorsSnapshot | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") {
    throw new TypeError("cors must be an object.");
  }
  const { allowedOrigins, allowedHeaders, maxAgeSeconds } = value;
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    throw new TypeError(
      "cors.allowedOrigins must contain at least one origin.",
    );
  }
  const origins = new Set<string>();
  for (const candidate of allowedOrigins) {
    const origin =
      typeof candidate === "string" ? normalizeOrigin(candidate) : null;
    if (origin === null) {
      throw new TypeError(`Invalid allowed origin: ${String(candidate)}`);
    }
    origins.add(origin);
  }
  const headers = new Set<string>(DEFAULT_CORS_HEADERS);
  if (allowedHeaders !== undefined) {
    if (!Array.isArray(allowedHeaders)) {
      throw new TypeError("cors.allowedHeaders must be an array.");
    }
    for (const header of allowedHeaders) {
      if (typeof header !== "string" || !HEADER_NAME.test(header)) {
        throw new TypeError(`Invalid allowed header: ${String(header)}`);
      }
      headers.add(header.toLowerCase());
    }
  }
  if (
    maxAgeSeconds !== undefined &&
    (!Number.isInteger(maxAgeSeconds) ||
      maxAgeSeconds < 0 ||
      maxAgeSeconds > MAX_CORS_MAX_AGE_SECONDS)
  ) {
    throw new TypeError(
      `cors.maxAgeSeconds must be an integer from 0 through ${String(MAX_CORS_MAX_AGE_SECONDS)}.`,
    );
  }
  return Object.freeze({
    allowedOrigins: origins,
    allowedHeaders: [...headers].join(", "),
    ...(maxAgeSeconds === undefined
      ? {}
      : { maxAgeSeconds: String(maxAgeSeconds) }),
  });
}

type AuthSnapshot =
  | {
      readonly mode: "required";
      readonly authenticate: RequiredHttpAuth["authenticate"];
    }
  | { readonly mode: "dangerously-disabled-for-development" };

function snapshotAuth(value: HttpAuthOptions | undefined): AuthSnapshot {
  if (value !== null && typeof value === "object") {
    if (value.mode === "required") {
      if (typeof value.authenticate !== "function") {
        throw new TypeError(
          "auth.authenticate must be a function when auth.mode is required.",
        );
      }
      return Object.freeze({
        mode: "required",
        authenticate: value.authenticate,
      });
    }
    if (value.mode === "dangerously-disabled-for-development") {
      return Object.freeze({ mode: value.mode });
    }
  }
  throw new TypeError(
    'auth.mode must be either "required" or "dangerously-disabled-for-development".',
  );
}

function snapshotPrincipal(value: unknown): Principal | null {
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

function headerView(headers: Headers): HttpHeaderView {
  const values = new Headers(headers);
  return Object.freeze({
    get: (name: string) => values.get(name),
    has: (name: string) => values.has(name),
  });
}

type Route =
  | { readonly kind: "list" | "openapi"; readonly methods: string }
  | {
      readonly kind: "capability";
      readonly methods: string;
      readonly capabilityId: string;
    }
  | { readonly kind: "malformed" };

function matchRoute(pathname: string, prefix: string): Route | undefined {
  if (!pathname.startsWith(`${prefix}/`)) return undefined;
  const rest = pathname.slice(prefix.length);
  if (rest === "/capabilities") return { kind: "list", methods: "GET" };
  if (rest === "/openapi.json") return { kind: "openapi", methods: "GET" };
  if (!rest.startsWith("/capabilities/")) return undefined;
  const segment = rest.slice("/capabilities/".length);
  if (segment.includes("/")) return undefined;
  try {
    return {
      kind: "capability",
      methods: "GET, POST",
      capabilityId: decodeURIComponent(segment),
    };
  } catch {
    return { kind: "malformed" };
  }
}

function declaredBodyExceedsLimit(
  value: string | null,
  limit: number,
): boolean {
  if (value === null || !/^\d+$/u.test(value)) return false;
  return BigInt(value) > BigInt(limit);
}

function isJsonContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

type BodyResult =
  | { readonly status: "ok"; readonly text: string }
  | { readonly status: "too-large" | "invalid-utf8" | "unreadable" };

/**
 * Reads the body incrementally as strict UTF-8 and stops at the first chunk
 * that crosses the limit. An overflow releases the reader without consuming
 * the rest, so the host decides how to discard it.
 */
async function readBody(request: Request, limit: number): Promise<BodyResult> {
  const stream = request.body;
  if (stream === null) return { status: "ok", text: "" };
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = stream.getReader();
  } catch {
    return { status: "unreadable" };
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let total = 0;
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch {
      return { status: "unreadable" };
    }
    if (chunk.done) break;
    if (!(chunk.value instanceof Uint8Array)) return { status: "unreadable" };
    total += chunk.value.byteLength;
    if (total > limit) {
      reader.releaseLock();
      return { status: "too-large" };
    }
    try {
      parts.push(decoder.decode(chunk.value, { stream: true }));
    } catch {
      reader.releaseLock();
      return { status: "invalid-utf8" };
    }
  }
  try {
    parts.push(decoder.decode());
  } catch {
    return { status: "invalid-utf8" };
  }
  return { status: "ok", text: parts.join("") };
}

/**
 * Creates a Web-standard `fetch` handler that publishes an engine as plain
 * HTTP JSON routes below `basePath`:
 *
 * - `GET {basePath}/capabilities` lists capabilities;
 * - `GET {basePath}/capabilities/{id}` describes one capability;
 * - `POST {basePath}/capabilities/{id}` invokes it with a JSON object body; and
 * - `GET {basePath}/openapi.json` returns the generated OpenAPI 3.1 document.
 *
 * Every invocation runs through `engine.invoke` with source `http`. The handler
 * module imports no Node-only API and never rejects.
 */
export function createHttpHandler<Capabilities extends CapabilityMap>(
  engine: Engine<Capabilities>,
  options: HttpHandlerOptions,
): HttpHandler {
  if (options === null || typeof options !== "object") {
    throw new TypeError("options with an explicit auth mode are required.");
  }
  const basePath = normalizeBasePath(options.basePath);
  const prefix = basePath === "/" ? "" : basePath;
  const auth = snapshotAuth(options.auth);
  const allowedHosts = normalizeAllowedHosts(options.allowedHosts);
  const cors = snapshotCors(options.cors);
  const maxRequestBodyBytes =
    options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes <= 0) {
    throw new TypeError("maxRequestBodyBytes must be a positive safe integer.");
  }
  const visibility = snapshotVisibility(options.visibility);
  const openApiOptions = {
    basePath,
    security: auth.mode === "required" ? "bearer" : "none",
  } as const;
  const openApiBody = JSON.stringify(
    createHttpOpenApiDocument(engine, openApiOptions),
  );
  // One document per distinct visible set, bounded so varied principals
  // cannot grow the cache without limit.
  const visibleOpenApiBodies = new Map<string, string>();
  const openApiBodyFor = (visible: (id: string) => boolean): string => {
    const summaries = engine.list().filter((summary) => visible(summary.id));
    const key = summaries.map((summary) => summary.id).join("\n");
    const cached = visibleOpenApiBodies.get(key);
    if (cached !== undefined) return cached;
    const view = {
      name: engine.name,
      version: engine.version,
      invoke: engine.invoke,
      list: () => summaries,
      describe: engine.describe,
    } as Engine<Capabilities>;
    const body = JSON.stringify(
      createHttpOpenApiDocument(view, openApiOptions),
    );
    if (visibleOpenApiBodies.size >= MAX_CACHED_OPENAPI_DOCUMENTS) {
      const oldest = visibleOpenApiBodies.keys().next().value as string;
      visibleOpenApiBodies.delete(oldest);
    }
    visibleOpenApiBodies.set(key, body);
    return body;
  };
  // The catalog is fixed by createEngine, so a caller-chosen ID that is not in
  // it never reaches engine.invoke or its events.
  const capabilityIds: ReadonlySet<string> = new Set(
    engine.list().map((summary) => summary.id),
  );
  type CapabilityId = Extract<keyof Capabilities, string>;

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!allowedHosts.has(url.hostname.toLowerCase())) {
      return httpErrorResponse(403, "HOST_NOT_ALLOWED");
    }

    const vary: HeaderRecord = cors === undefined ? {} : { vary: "Origin" };
    const originHeader = request.headers.get("origin");
    let headers = vary;
    if (originHeader !== null) {
      const requestOrigin = normalizeOrigin(originHeader);
      if (
        cors === undefined ||
        requestOrigin === null ||
        !cors.allowedOrigins.has(requestOrigin)
      ) {
        return httpErrorResponse(403, "ORIGIN_NOT_ALLOWED", vary);
      }
      headers = { ...vary, "access-control-allow-origin": requestOrigin };
    }

    const route = matchRoute(url.pathname, prefix);
    if (route === undefined) {
      return httpErrorResponse(404, "NOT_FOUND", headers);
    }
    if (route.kind === "malformed") {
      return httpErrorResponse(400, "INVALID_REQUEST", headers);
    }
    if (
      request.method === "OPTIONS" &&
      cors !== undefined &&
      originHeader !== null &&
      request.headers.has("access-control-request-method")
    ) {
      return new Response(null, {
        status: 204,
        headers: {
          ...headers,
          vary: PREFLIGHT_VARY,
          "access-control-allow-methods": route.methods,
          "access-control-allow-headers": cors.allowedHeaders,
          ...(cors.maxAgeSeconds === undefined
            ? {}
            : { "access-control-max-age": cors.maxAgeSeconds }),
        },
      });
    }
    const invoking = route.kind === "capability" && request.method === "POST";
    if (request.method !== "GET" && !invoking) {
      return httpErrorResponse(405, "METHOD_NOT_ALLOWED", {
        ...headers,
        allow: route.methods,
      });
    }
    if (
      invoking &&
      declaredBodyExceedsLimit(
        request.headers.get("content-length"),
        maxRequestBodyBytes,
      )
    ) {
      return httpErrorResponse(413, "PAYLOAD_TOO_LARGE", headers);
    }

    let principal: Principal | null = null;
    if (auth.mode === "required") {
      let authenticated: unknown;
      try {
        authenticated = await auth.authenticate(
          Object.freeze({
            path: url.pathname,
            method: request.method,
            headers: headerView(request.headers),
            signal: request.signal,
          }),
        );
      } catch {
        return httpErrorResponse(500, "INTERNAL_ERROR", headers);
      }
      principal = snapshotPrincipal(authenticated);
      if (principal === null) {
        return jsonResponse(401, UNAUTHENTICATED_BODY, {
          ...headers,
          "www-authenticate": "Bearer",
        });
      }
    }

    const visible =
      visibility === undefined
        ? undefined
        : bindVisibility(visibility, principal);
    if (route.kind !== "capability") {
      if (route.kind === "list") {
        const capabilities =
          visible === undefined
            ? engine.list()
            : engine.list().filter((summary) => visible(summary.id));
        return jsonResponse(200, JSON.stringify({ capabilities }), headers);
      }
      return jsonResponse(
        200,
        visible === undefined ? openApiBody : openApiBodyFor(visible),
        headers,
      );
    }
    // A hidden capability is indistinguishable from an ID outside the catalog.
    if (
      !capabilityIds.has(route.capabilityId) ||
      (visible !== undefined && !visible(route.capabilityId))
    ) {
      return engineErrorResponse(
        new EngineError({
          code: "CAPABILITY_NOT_FOUND",
          message: "Capability not found.",
          publicDetails: { capabilityId: route.capabilityId },
        }),
        headers,
      );
    }
    const capabilityId = route.capabilityId as CapabilityId;
    if (!invoking) {
      try {
        return jsonResponse(
          200,
          JSON.stringify(engine.describe(capabilityId)),
          headers,
        );
      } catch (error) {
        return engineErrorResponse(error, headers);
      }
    }

    if (!isJsonContentType(request.headers.get("content-type"))) {
      return httpErrorResponse(415, "UNSUPPORTED_MEDIA_TYPE", headers);
    }
    const body = await readBody(request, maxRequestBodyBytes);
    if (body.status !== "ok") {
      return body.status === "too-large"
        ? httpErrorResponse(413, "PAYLOAD_TOO_LARGE", headers)
        : httpErrorResponse(
            400,
            body.status === "invalid-utf8" ? "INVALID_JSON" : "INVALID_REQUEST",
            headers,
          );
    }
    let input: unknown;
    try {
      input = JSON.parse(body.text);
    } catch {
      return httpErrorResponse(400, "INVALID_JSON", headers);
    }

    let output: unknown;
    try {
      output = await engine.invoke(capabilityId, input as never, {
        source: "http",
        principal,
        signal: request.signal,
      });
    } catch (error) {
      return engineErrorResponse(error, headers);
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(output);
    } catch {
      return jsonResponse(500, EXECUTION_FAILED_BODY, headers);
    }
    return jsonResponse(200, serialized, headers);
  }

  return async function handleHttpRequest(request: Request): Promise<Response> {
    try {
      return await handle(request);
    } catch {
      return httpErrorResponse(500, "INTERNAL_ERROR");
    }
  };
}
