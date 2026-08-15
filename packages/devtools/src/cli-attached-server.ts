import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type {
  IncomingMessage,
  Server as NodeHttpServer,
  ServerResponse,
} from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  type AttachedCliSessionController,
  type AttachedCliSessionState,
  createAttachedCliSessionController,
} from "./cli-attached-session.js";
import { faviconLink, faviconSvg } from "./favicon.js";
import type { DevtoolsServerAddress } from "./server.js";

export type AttachedCliServerState = AttachedCliSessionState;
export type AttachedCliServerController = AttachedCliSessionController;

export interface StartAttachedCliDevtoolsServerOptions {
  readonly controller?: AttachedCliServerController;
  readonly port?: number;
  readonly uiRoot?: string;
}

export interface AttachedCliDevtoolsServer {
  address(): DevtoolsServerAddress;
  close(): Promise<void>;
}

interface BrowserSession {
  csrf: string;
}

const host = "127.0.0.1";
const defaultPort = 4100;
const connectionBodyLimitBytes = 1024 * 1024;
const runBodyLimitBytes = 10 * 1024 * 1024;
const maximumBrowserSessions = 128;
const sessionCookieName = "invokta_devtools_session";
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

const cliShellPage = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invokta DevTools · CLI workbench</title>
${faviconLink}
<link rel="stylesheet" href="/assets/attached.css">
</head>
<body>
<noscript>The Invokta DevTools interface requires JavaScript.</noscript>
<script type="module" src="/assets/cli-app.js"></script>
</body>
</html>
`;

const staticContentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};
const assetSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function defaultUiRoot(): string {
  return join(fileURLToPath(new URL(".", import.meta.url)), "ui");
}

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

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(response, status, { code, message });
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
    case "ENVIRONMENT_VALUE_MISSING":
      sendError(
        response,
        400,
        code,
        code === "INVALID_TARGET"
          ? "The CLI target descriptor is invalid."
          : "A required environment value is missing.",
      );
      return;
    case "TARGET_BUSY":
    case "NOT_CONNECTED":
      sendError(
        response,
        409,
        code,
        code === "TARGET_BUSY"
          ? "Another target or CLI verb is already active."
          : "No CLI target is connected for this browser session.",
      );
      return;
    case "LIMIT_EXCEEDED":
      sendError(response, 413, code, "The configured CLI limit was exceeded.");
      return;
    case "TIMEOUT":
      sendError(response, 504, code, "The CLI operation timed out.");
      return;
    case "SPAWN_FAILED":
    case "CONNECTION_FAILED":
    case "PROTOCOL_ERROR":
      sendError(response, 502, code, "The CLI target operation failed.");
      return;
    default:
      sendError(
        response,
        409,
        "NOT_CONNECTED",
        "No CLI target is connected for this browser session.",
      );
  }
}

export async function startAttachedCliDevtoolsServer(
  options: StartAttachedCliDevtoolsServerOptions = {},
): Promise<AttachedCliDevtoolsServer> {
  const controller = options.controller ?? createAttachedCliSessionController();
  const port = options.port ?? defaultPort;
  const uiRoot = options.uiRoot ?? defaultUiRoot();
  const sessions = new Map<string, BrowserSession>();
  let attachedCss: Promise<string | undefined> | undefined;
  let boundAuthority = "";
  let ownOrigin = "";
  let closed = false;

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
    if (oneRawHeader(request, "origin") !== ownOrigin) {
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
      sendError(
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
      sendError(
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
      sendError(
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
      sendError(
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

  const handleSession = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    let resolved = sessionFor(request);
    let cookie: string | undefined;
    if (resolved === undefined) {
      const created = createSession();
      if (created === undefined) {
        sendError(
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

  const readJsonMutation = async (
    request: IncomingMessage,
    response: ServerResponse,
    limitBytes: number,
    tooLargeMessage: string,
  ): Promise<unknown | undefined> => {
    if (oneRawHeader(request, "content-type") !== "application/json") {
      sendErrorBeforeBodyConsumption(
        request,
        response,
        400,
        "INVALID_REQUEST",
        "The request must contain exact JSON content.",
      );
      return undefined;
    }
    if (declaredBodyExceedsLimit(request, limitBytes)) {
      sendErrorBeforeBodyConsumption(
        request,
        response,
        413,
        "LIMIT_EXCEEDED",
        tooLargeMessage,
      );
      return undefined;
    }
    const read = await readBody(request, limitBytes);
    if (!read.ok) {
      sendErrorBeforeBodyConsumption(
        request,
        response,
        413,
        "LIMIT_EXCEEDED",
        tooLargeMessage,
      );
      return undefined;
    }
    return parseStrictJson(read.body);
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
    const body = await readJsonMutation(
      request,
      response,
      connectionBodyLimitBytes,
      "The connection descriptor is too large.",
    );
    if (response.headersSent) return;
    if (!isRecord(body)) {
      sendError(
        response,
        400,
        "INVALID_REQUEST",
        "The connection descriptor is invalid.",
      );
      return;
    }
    try {
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

  const handleRefresh = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const owner = requireMutation(request, response);
    if (owner === undefined) return;
    try {
      const summary = await controller.refresh(owner.id);
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

  const handleDescribe = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const owner = requireMutation(request, response);
    if (owner === undefined) return;
    const body = await readJsonMutation(
      request,
      response,
      connectionBodyLimitBytes,
      "The describe request is too large.",
    );
    if (response.headersSent) return;
    if (!isRecord(body) || typeof body.id !== "string" || body.id === "") {
      sendError(
        response,
        400,
        "INVALID_REQUEST",
        "The describe request is invalid.",
      );
      return;
    }
    try {
      const described = await controller.describe(owner.id, body.id);
      const csrf = rotateCsrf(owner.session);
      sendJson(response, 200, described, { "x-invokta-csrf": csrf });
    } catch (error) {
      safeControllerError(response, error);
    }
  };

  const handleRun = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const owner = requireMutation(request, response);
    if (owner === undefined) return;
    const body = await readJsonMutation(
      request,
      response,
      runBodyLimitBytes,
      "The run request is too large.",
    );
    if (response.headersSent) return;
    if (!isRecord(body) || typeof body.id !== "string" || body.id === "") {
      sendError(
        response,
        400,
        "INVALID_REQUEST",
        "The run request is invalid.",
      );
      return;
    }
    try {
      const result = await controller.run(owner.id, body.id, body.input);
      const csrf = rotateCsrf(owner.session);
      sendJson(response, 200, { result }, { "x-invokta-csrf": csrf });
    } catch (error) {
      safeControllerError(response, error);
    }
  };

  const requireOwner = (
    request: IncomingMessage,
    response: ServerResponse,
  ): string | undefined => {
    const session = sessionFor(request);
    if (session === undefined) {
      sendError(
        response,
        403,
        "FORBIDDEN",
        "The browser session is not authorized.",
      );
      return undefined;
    }
    return session.id;
  };

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (oneRawHeader(request, "host") !== boundAuthority) {
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
      oneRawHeader(request, "origin") !== ownOrigin
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
    let url: URL;
    try {
      url = new URL(rawTarget, ownOrigin);
    } catch {
      sendError(
        response,
        400,
        "INVALID_REQUEST",
        "The request URL is invalid.",
      );
      return;
    }
    const path = url.pathname;
    if (
      url.origin !== ownOrigin ||
      url.search !== "" ||
      url.hash !== "" ||
      rawTarget !== path
    ) {
      sendError(
        response,
        400,
        "INVALID_REQUEST",
        "The request URL is not canonical.",
      );
      return;
    }

    if (path === "/api/session" && method === "GET") {
      await handleSession(request, response);
      return;
    }
    if (path === "/api/connection") {
      await handleConnection(request, response);
      return;
    }
    if (path === "/api/refresh" && method === "POST") {
      await handleRefresh(request, response);
      return;
    }
    if (path === "/api/describe" && method === "POST") {
      await handleDescribe(request, response);
      return;
    }
    if (path === "/api/run" && method === "POST") {
      await handleRun(request, response);
      return;
    }
    if (path === "/api/catalog" && method === "GET") {
      const owner = requireOwner(request, response);
      if (owner === undefined) return;
      try {
        sendJson(response, 200, {
          capabilities: controller.catalog(owner),
        });
      } catch (error) {
        safeControllerError(response, error);
      }
      return;
    }
    if (path === "/api/activity" && method === "GET") {
      const owner = requireOwner(request, response);
      if (owner === undefined) return;
      try {
        sendJson(response, 200, {
          records: controller.activity(owner),
        });
      } catch (error) {
        safeControllerError(response, error);
      }
      return;
    }
    if (path.startsWith("/api/")) {
      sendError(
        response,
        404,
        "NOT_FOUND",
        "The requested route was not found.",
      );
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
      response.writeHead(200, {
        ...securityHeaders(),
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(cliShellPage);
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
    sendError(response, 404, "NOT_FOUND", "The requested route was not found.");
  };

  const server: NodeHttpServer = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) {
        sendError(
          response,
          500,
          "INTERNAL_ERROR",
          "The local devtools request failed.",
        );
      } else {
        response.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const boundPort = (server.address() as AddressInfo).port;
  boundAuthority = `${host}:${String(boundPort)}`;
  ownOrigin = `http://${boundAuthority}`;

  let closing: Promise<void> | undefined;
  return {
    address: () => ({ host, port: boundPort }),
    close: async () => {
      closing ??= (async () => {
        if (closed) return;
        closed = true;
        sessions.clear();
        const stopServer = new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
          server.closeAllConnections();
        });
        const results = await Promise.allSettled([
          stopServer,
          controller.close(),
        ]);
        const failure = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (failure !== undefined) throw failure.reason;
      })();
      return closing;
    },
  };
}
