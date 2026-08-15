import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { McpJsonValue, McpOAuthClientTarget } from "@invokta/mcp";

import type { AttachedSessionController } from "./attached-session.js";
import { faviconLink, faviconSvg } from "./favicon.js";

export interface AttachedRouterOptions {
  readonly controller: AttachedSessionController;
  readonly uiRoot: string;
  /** Where the JSON API is mounted. Defaults to `/api`. */
  readonly apiPrefix?: string;
  /** Every authority the bound port answers on. */
  allowedAuthorities(): ReadonlySet<string>;
  /** The canonical origin the request target is resolved against. */
  origin(): string;
  /** The literal-loopback redirect URL an OAuth provider calls back on. */
  oauthRedirectUrl(): string;
}

export interface AttachedRouter {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  /** The workbench shell, served by the router at `/` and by the launcher. */
  shell(response: ServerResponse, apiBase: string, launched: boolean): void;
  clearBrowserSessions(): void;
}

export function defaultAttachedUiRoot(): string {
  return join(fileURLToPath(new URL(".", import.meta.url)), "ui");
}

interface BrowserSession {
  csrf: string;
}

const connectionBodyLimitBytes = 1024 * 1024;
const callBodyLimitBytes = 10 * 1024 * 1024;
const oauthCallbackTargetLimitBytes = 8_192;
const oauthAuthorizationCodeLimitCodePoints = 4_096;
const maximumBrowserSessions = 128;
// One origin serves both workbenches, and a browser keeps one cookie per
// name: each workbench needs its own, or switching between them silently
// replaces the other's session.
const sessionCookieName = "invokta_devtools_mcp_session";
const csrfHeaderName = "x-invokta-csrf";
const contentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

/**
 * The workbench shell. `apiBase` tells the interface where its JSON API is
 * mounted, and `launched` tells it the peer workbench is reachable from the
 * same origin, so the chrome can offer the switch.
 */
export function attachedShellPage(apiBase: string, launched: boolean): string {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invokta DevTools · MCP workbench</title>
${faviconLink}
<link rel="stylesheet" href="/assets/attached.css">
</head>
<body data-invokta-api="${apiBase}"${launched ? ' data-invokta-workbench="mcp"' : ""}>
<noscript>The Invokta DevTools interface requires JavaScript.</noscript>
<script type="module" src="/assets/attached-app.js"></script>
</body>
</html>
`;
}

const oauthCallbackPages = Object.freeze({
  success: `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorization complete</title>${faviconLink}<link rel="stylesheet" href="/assets/attached.css"></head>
<body class="attached-mode"><main class="att-frame att-main"><section class="att-card att-view att-oauth"><p class="att-kicker">OAuth</p><h1>Authorization complete</h1><p class="att-hint">Return to Invokta DevTools. You can close this tab.</p></section></main></body></html>`,
  rejected: `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorization not completed</title>${faviconLink}<link rel="stylesheet" href="/assets/attached.css"></head>
<body class="attached-mode"><main class="att-frame att-main"><section class="att-card att-view att-oauth"><p class="att-kicker">OAuth</p><h1>Authorization was not completed</h1><p class="att-hint">Return to Invokta DevTools to try again.</p></section></main></body></html>`,
  failed: `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorization failed</title>${faviconLink}<link rel="stylesheet" href="/assets/attached.css"></head>
<body class="attached-mode"><main class="att-frame att-main"><section class="att-card att-view att-oauth"><p class="att-kicker">OAuth</p><h1>Authorization failed</h1><p class="att-hint">Return to Invokta DevTools to review the connection.</p></section></main></body></html>`,
});

const staticContentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};
const assetSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function securityHeaders(): Readonly<Record<string, string>> {
  return {
    "content-security-policy": contentSecurityPolicy,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, {
    ...securityHeaders(),
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

export function sendAttachedError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(response, status, { code, message });
}

function sendOAuthCallbackPage(
  response: ServerResponse,
  status: number,
  page: keyof typeof oauthCallbackPages,
): void {
  response.writeHead(status, {
    ...securityHeaders(),
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(oauthCallbackPages[page]);
}

type OAuthCallbackOutcome = "success" | "rejected" | "invalid" | "error";

function sendOAuthCallbackRedirect(
  response: ServerResponse,
  outcome: OAuthCallbackOutcome,
): void {
  response.writeHead(303, {
    ...securityHeaders(),
    location: `/oauth/result/${outcome}`,
    "cache-control": "no-store",
  });
  response.end();
}

function sendErrorBeforeBodyConsumption(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  response.shouldKeepAlive = false;
  request.once("error", () => undefined);
  request.resume();
  response.once("finish", () => {
    if (!request.complete && !request.destroyed) request.destroy();
  });
  sendJson(response, status, { code, message }, { connection: "close" });
}

function rawHeaderValues(
  request: IncomingMessage,
  expectedName: string,
): readonly string[] {
  const values: string[] = [];
  const lower = expectedName.toLowerCase();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name?.toLowerCase() === lower && value !== undefined)
      values.push(value);
  }
  return values;
}

function oneRawHeader(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const values = rawHeaderValues(request, name);
  return values.length === 1 ? values[0] : undefined;
}

function equalOpaqueToken(
  actual: string | undefined,
  expected: string,
): boolean {
  if (actual === undefined) return false;
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function parseSessionCookie(value: string): string | undefined {
  let selected: string | undefined;
  for (const pair of value.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    const name = pair.slice(0, separator).trim();
    if (name !== sessionCookieName) continue;
    if (selected !== undefined) return undefined;
    const candidate = pair.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_-]{32,}$/.test(candidate)) return undefined;
    selected = candidate;
  }
  return selected;
}

async function readBody(
  request: IncomingMessage,
  limitBytes: number,
): Promise<{ readonly ok: boolean; readonly body: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const onData = (value: Buffer | string): void => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.length;
      if (total > limitBytes) {
        settled = true;
        cleanup();
        request.once("error", () => undefined);
        request.resume();
        resolve({ ok: false, body: Buffer.alloc(0) });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: true, body: Buffer.concat(chunks) });
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
    if (request.aborted || request.destroyed) onAborted();
    else if (request.readableEnded) onEnd();
  });
}

function declaredBodyExceedsLimit(
  request: IncomingMessage,
  limitBytes: number,
): boolean {
  const value = request.headers["content-length"];
  return (
    typeof value === "string" &&
    /^\d+$/u.test(value) &&
    BigInt(value) > BigInt(limitBytes)
  );
}

function parseStrictJson(body: Buffer): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeControllerError(response: ServerResponse, error: unknown): void {
  const code =
    isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  switch (code) {
    case "INVALID_TARGET":
      sendAttachedError(
        response,
        400,
        code,
        "The MCP target descriptor is invalid.",
      );
      return;
    case "TARGET_BUSY":
    case "NOT_CONNECTED":
      sendAttachedError(
        response,
        409,
        code,
        code === "TARGET_BUSY"
          ? "Another target operation is already active."
          : "No MCP target is connected for this browser session.",
      );
      return;
    case "LIMIT_EXCEEDED":
      sendAttachedError(
        response,
        413,
        code,
        "The configured MCP limit was exceeded.",
      );
      return;
    case "TIMEOUT":
      sendAttachedError(response, 504, code, "The MCP operation timed out.");
      return;
    case "AUTHENTICATION_FAILED":
      sendAttachedError(
        response,
        502,
        code,
        "The MCP target rejected the configured authentication.",
      );
      return;
    case "SPAWN_FAILED":
    case "CONNECTION_FAILED":
    case "PROTOCOL_ERROR":
    case "CANCELLED":
      sendAttachedError(
        response,
        502,
        code,
        "The MCP target operation failed.",
      );
      return;
    default:
      sendAttachedError(
        response,
        409,
        "NOT_CONNECTED",
        "No MCP target is connected for this browser session.",
      );
  }
}

export function createAttachedRouter(
  options: AttachedRouterOptions,
): AttachedRouter {
  const { controller } = options;
  const uiRoot = options.uiRoot;
  const api = options.apiPrefix ?? "/api";
  const sessions = new Map<string, BrowserSession>();
  let attachedCss: Promise<string | undefined> | undefined;

  /**
   * The origin a same-origin request carries. A browser sends whichever
   * loopback authority the developer typed — and an OAuth provider always
   * redirects to the literal one — so the expected origin follows the request
   * host instead of one canonical spelling.
   */
  const requestOrigin = (request: IncomingMessage): string | undefined => {
    const requestHost = oneRawHeader(request, "host");
    if (
      requestHost === undefined ||
      !options.allowedAuthorities().has(requestHost)
    ) {
      return undefined;
    }
    return `http://${requestHost}`;
  };

  const createSession = ():
    | { readonly id: string; readonly csrf: string }
    | undefined => {
    if (sessions.size >= maximumBrowserSessions) {
      for (const candidate of sessions.keys()) {
        const state = controller.state(candidate).state;
        if (state === "idle" || state === "busy") {
          sessions.delete(candidate);
          break;
        }
      }
    }
    if (sessions.size >= maximumBrowserSessions) return undefined;
    const id = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    sessions.set(id, { csrf });
    return { id, csrf };
  };

  const sessionFor = (
    request: IncomingMessage,
  ): { readonly id: string; readonly session: BrowserSession } | undefined => {
    const header = oneRawHeader(request, "cookie");
    if (header === undefined) return undefined;
    const id = parseSessionCookie(header);
    if (id === undefined) return undefined;
    const session = sessions.get(id);
    return session === undefined ? undefined : { id, session };
  };

  const requireMutation = (
    request: IncomingMessage,
    response: ServerResponse,
  ): { readonly id: string; readonly session: BrowserSession } | undefined => {
    const expectedOrigin = requestOrigin(request);
    if (
      expectedOrigin === undefined ||
      oneRawHeader(request, "origin") !== expectedOrigin
    ) {
      sendErrorBeforeBodyConsumption(
        request,
        response,
        403,
        "FORBIDDEN",
        "The request origin is not allowed.",
      );
      return undefined;
    }
    const resolved = sessionFor(request);
    const csrf = oneRawHeader(request, csrfHeaderName);
    if (
      resolved === undefined ||
      !equalOpaqueToken(csrf, resolved.session.csrf)
    ) {
      sendErrorBeforeBodyConsumption(
        request,
        response,
        403,
        "FORBIDDEN",
        "The browser session is not authorized.",
      );
      return undefined;
    }
    return resolved;
  };

  const rotateCsrf = (session: BrowserSession): string => {
    const csrf = randomBytes(32).toString("base64url");
    session.csrf = csrf;
    return csrf;
  };

  const serveStatic = (
    response: ServerResponse,
    segments: readonly string[],
  ): void => {
    if (
      segments.length === 0 ||
      segments.some((segment) => !assetSegmentPattern.test(segment))
    ) {
      sendAttachedError(
        response,
        404,
        "NOT_FOUND",
        "The requested asset was not found.",
      );
      return;
    }
    const filePath = normalize(join(uiRoot, ...segments));
    if (
      !filePath.startsWith(`${normalize(uiRoot)}${sep}`) ||
      !existsSync(filePath)
    ) {
      sendAttachedError(
        response,
        404,
        "NOT_FOUND",
        "The requested asset was not found.",
      );
      return;
    }
    const extension = filePath.slice(filePath.lastIndexOf("."));
    const contentType = staticContentTypes[extension];
    if (contentType === undefined) {
      sendAttachedError(
        response,
        404,
        "NOT_FOUND",
        "The requested asset was not found.",
      );
      return;
    }
    response.writeHead(200, {
      ...securityHeaders(),
      "content-type": contentType,
      "cache-control": "no-store",
    });
    response.end(readFileSync(filePath));
  };

  const serveAttachedCss = async (response: ServerResponse): Promise<void> => {
    attachedCss ??= import(
      pathToFileURL(join(uiRoot, "attached-styles.js")).href
    )
      .then((module: unknown) => {
        if (!isRecord(module)) return undefined;
        return typeof module.attachedStyles === "string"
          ? module.attachedStyles
          : undefined;
      })
      .catch(() => undefined);
    const css = await attachedCss;
    if (css === undefined) {
      sendAttachedError(
        response,
        404,
        "NOT_FOUND",
        "The requested asset was not found.",
      );
      return;
    }
    response.writeHead(200, {
      ...securityHeaders(),
      "content-type": "text/css; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(css);
  };

  const shell = (
    response: ServerResponse,
    apiBase: string,
    launched: boolean,
  ): void => {
    response.writeHead(200, {
      ...securityHeaders(),
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(attachedShellPage(apiBase, launched));
  };

  const handleSession = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    let resolved = sessionFor(request);
    let cookie: string | undefined;
    if (resolved === undefined) {
      const created = createSession();
      if (created === undefined) {
        sendAttachedError(
          response,
          503,
          "SESSION_LIMIT_EXCEEDED",
          "The local browser session limit was reached.",
        );
        return;
      }
      resolved = {
        id: created.id,
        session: sessions.get(created.id) as BrowserSession,
      };
      cookie = `${sessionCookieName}=${created.id}; Path=/; HttpOnly; SameSite=Strict`;
    }
    const state = controller.state(resolved.id);
    sendJson(
      response,
      200,
      { csrfToken: resolved.session.csrf, ...state },
      cookie === undefined ? {} : { "set-cookie": cookie },
    );
  };

  const handleConnection = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const owner = requireMutation(request, response);
    if (owner === undefined) return;
    if (request.method === "DELETE") {
      try {
        await controller.disconnect(owner.id);
        const csrf = rotateCsrf(owner.session);
        sendJson(response, 200, { state: "idle" }, { "x-invokta-csrf": csrf });
      } catch (error) {
        safeControllerError(response, error);
      }
      return;
    }
    if (request.method !== "POST") {
      sendJson(
        response,
        405,
        {
          code: "METHOD_NOT_ALLOWED",
          message: "The request method is not allowed.",
        },
        { allow: "POST, DELETE" },
      );
      return;
    }
    if (oneRawHeader(request, "content-type") !== "application/json") {
      sendErrorBeforeBodyConsumption(
        request,
        response,
        400,
        "INVALID_REQUEST",
        "The request must contain exact JSON content.",
      );
      return;
    }
    if (declaredBodyExceedsLimit(request, connectionBodyLimitBytes)) {
      sendErrorBeforeBodyConsumption(
        request,
        response,
        413,
        "LIMIT_EXCEEDED",
        "The connection descriptor is too large.",
      );
      return;
    }
    const read = await readBody(request, connectionBodyLimitBytes);
    if (!read.ok) {
      sendErrorBeforeBodyConsumption(
        request,
        response,
        413,
        "LIMIT_EXCEEDED",
        "The connection descriptor is too large.",
      );
      return;
    }
    const body = parseStrictJson(read.body);
    if (!isRecord(body)) {
      sendAttachedError(
        response,
        400,
        "INVALID_REQUEST",
        "The connection descriptor is invalid.",
      );
      return;
    }
    try {
      const authentication = isRecord(body.authentication)
        ? body.authentication
        : undefined;
      if (authentication?.type === "oauth") {
        const state = randomBytes(32).toString("base64url");
        const authorization = await controller.beginOAuth(
          owner.id,
          body as unknown as McpOAuthClientTarget,
          {
            // RFC 8252 prefers the literal loopback address over `localhost`,
            // and the MCP client accepts nothing else, so the redirect never
            // follows the advertised host.
            redirectUrl: options.oauthRedirectUrl(),
            state,
          },
        );
        const csrf = rotateCsrf(owner.session);
        sendJson(
          response,
          202,
          { state: "authorizing", ...authorization },
          { "x-invokta-csrf": csrf },
        );
        return;
      }
      const summary = await controller.connect(owner.id, body);
      const csrf = rotateCsrf(owner.session);
      sendJson(
        response,
        200,
        { state: "connected", connection: summary },
        { "x-invokta-csrf": csrf },
      );
    } catch (error) {
      safeControllerError(response, error);
    }
  };

  const handleOAuthCallback = async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> => {
    if (request.method !== "GET") {
      sendOAuthCallbackRedirect(response, "invalid");
      return;
    }
    const states = url.searchParams.getAll("state");
    const codes = url.searchParams.getAll("code");
    const errors = url.searchParams.getAll("error");
    const state = states[0];
    const hasOneResult =
      (codes.length === 1 && errors.length === 0) ||
      (codes.length === 0 && errors.length === 1);
    if (
      states.length !== 1 ||
      state === undefined ||
      !/^[A-Za-z0-9_-]{43}$/u.test(state)
    ) {
      sendOAuthCallbackRedirect(response, "invalid");
      return;
    }

    const rejectCallback = async (
      outcome: "invalid" | "rejected" = "invalid",
    ): Promise<void> => {
      try {
        await controller.rejectOAuth(state);
      } catch {
        sendOAuthCallbackRedirect(response, "error");
        return;
      }
      sendOAuthCallbackRedirect(response, outcome);
    };
    if (!hasOneResult) {
      await rejectCallback();
      return;
    }

    const error = errors[0];
    if (error !== undefined) {
      if (error.length === 0 || Array.from(error).length > 256) {
        await rejectCallback();
        return;
      }
      await rejectCallback("rejected");
      return;
    }

    const code = codes[0];
    if (
      code === undefined ||
      code.length === 0 ||
      Array.from(code).length > oauthAuthorizationCodeLimitCodePoints
    ) {
      await rejectCallback();
      return;
    }
    try {
      await controller.completeOAuth(state, code);
      sendOAuthCallbackRedirect(response, "success");
    } catch {
      sendOAuthCallbackRedirect(response, "error");
    }
  };

  const requireOwner = (
    request: IncomingMessage,
    response: ServerResponse,
  ): string | undefined => {
    const session = sessionFor(request);
    if (session === undefined) {
      sendAttachedError(
        response,
        403,
        "FORBIDDEN",
        "The browser session is not authorized.",
      );
      return undefined;
    }
    return session.id;
  };

  const handleCall = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const owner = requireMutation(request, response);
    if (owner === undefined) return;
    if (oneRawHeader(request, "content-type") !== "application/json") {
      sendErrorBeforeBodyConsumption(
        request,
        response,
        400,
        "INVALID_REQUEST",
        "The request must contain exact JSON content.",
      );
      return;
    }
    if (declaredBodyExceedsLimit(request, callBodyLimitBytes)) {
      sendErrorBeforeBodyConsumption(
        request,
        response,
        413,
        "LIMIT_EXCEEDED",
        "The tool request is too large.",
      );
      return;
    }
    const read = await readBody(request, callBodyLimitBytes);
    if (!read.ok) {
      sendErrorBeforeBodyConsumption(
        request,
        response,
        413,
        "LIMIT_EXCEEDED",
        "The tool request is too large.",
      );
      return;
    }
    const body = parseStrictJson(read.body);
    if (
      !isRecord(body) ||
      typeof body.name !== "string" ||
      body.name === "" ||
      !isRecord(body.arguments)
    ) {
      sendAttachedError(
        response,
        400,
        "INVALID_REQUEST",
        "The tool request is invalid.",
      );
      return;
    }
    try {
      const result = await controller.call(
        owner.id,
        body.name,
        body.arguments as Readonly<Record<string, McpJsonValue>>,
      );
      sendJson(response, 200, result);
    } catch (error) {
      safeControllerError(response, error);
    }
  };

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const expectedOrigin = requestOrigin(request);
    if (expectedOrigin === undefined) {
      sendErrorBeforeBodyConsumption(
        request,
        response,
        403,
        "FORBIDDEN",
        "The request host is not allowed.",
      );
      return;
    }
    const method = request.method ?? "GET";
    const rawTarget = request.url ?? "/";
    if (
      (method === "POST" || method === "DELETE") &&
      oneRawHeader(request, "origin") !== expectedOrigin
    ) {
      sendErrorBeforeBodyConsumption(
        request,
        response,
        403,
        "FORBIDDEN",
        "The request origin is not allowed.",
      );
      return;
    }
    const isCanonicalOAuthCallback =
      rawTarget === "/oauth/callback" ||
      rawTarget.startsWith("/oauth/callback?");
    if (
      isCanonicalOAuthCallback &&
      Buffer.byteLength(rawTarget) > oauthCallbackTargetLimitBytes
    ) {
      sendOAuthCallbackRedirect(response, "invalid");
      return;
    }
    let url: URL;
    try {
      url = new URL(rawTarget, options.origin());
    } catch {
      sendAttachedError(
        response,
        400,
        "INVALID_REQUEST",
        "The request URL is invalid.",
      );
      return;
    }
    const path = url.pathname;

    if (path === "/oauth/callback") {
      if (
        !isCanonicalOAuthCallback ||
        url.origin !== options.origin() ||
        url.hash !== ""
      ) {
        sendOAuthCallbackRedirect(response, "invalid");
        return;
      }
      await handleOAuthCallback(request, response, url);
      return;
    }
    if (
      url.origin !== options.origin() ||
      url.search !== "" ||
      url.hash !== "" ||
      rawTarget !== path
    ) {
      sendAttachedError(
        response,
        400,
        "INVALID_REQUEST",
        "The request URL is not canonical.",
      );
      return;
    }
    const oauthResult = (
      [
        ["success", 200, "success"],
        ["rejected", 400, "rejected"],
        ["invalid", 400, "failed"],
        ["error", 502, "failed"],
      ] as const
    ).find(([outcome]) => rawTarget === `/oauth/result/${outcome}`);
    if (oauthResult !== undefined && method === "GET") {
      sendOAuthCallbackPage(response, oauthResult[1], oauthResult[2]);
      return;
    }

    if (path === `${api}/session` && method === "GET") {
      await handleSession(request, response);
      return;
    }
    if (path === `${api}/connection`) {
      await handleConnection(request, response);
      return;
    }
    if (path === `${api}/tools/call` && method === "POST") {
      await handleCall(request, response);
      return;
    }
    if (method !== "GET") {
      sendJson(
        response,
        405,
        {
          code: "METHOD_NOT_ALLOWED",
          message: "The request method is not allowed.",
        },
        { allow: "GET" },
      );
      return;
    }
    if (path === "/") {
      shell(response, api, false);
      return;
    }
    if (path === "/assets/favicon.svg") {
      response.writeHead(200, {
        ...securityHeaders(),
        "content-type": "image/svg+xml",
        "cache-control": "no-store",
      });
      response.end(faviconSvg);
      return;
    }
    if (path.startsWith("/assets/")) {
      if (path === "/assets/attached.css") {
        await serveAttachedCss(response);
        return;
      }
      serveStatic(response, path.slice("/assets/".length).split("/"));
      return;
    }
    const owner = requireOwner(request, response);
    if (owner === undefined) return;
    try {
      if (path === `${api}/tools`) {
        sendJson(response, 200, {
          tools: controller.tools(owner),
        });
        return;
      }
      if (path === `${api}/activity`) {
        sendJson(response, 200, {
          records: controller.activity(owner),
        });
        return;
      }
    } catch (error) {
      safeControllerError(response, error);
      return;
    }
    sendAttachedError(
      response,
      404,
      "NOT_FOUND",
      "The requested route was not found.",
    );
  };

  return { handle, shell, clearBrowserSessions: () => sessions.clear() };
}
