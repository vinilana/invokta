import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  createAttachedCliAssetServer,
  type AttachedCliAssetServer,
} from "./cli-attached-assets.js";
import {
  attachedCliConnectionBodyLimitBytes,
  attachedCliCsrfHeaderName,
  attachedCliRunBodyLimitBytes,
  attachedCliSessionCookieName,
  equalAttachedCliOpaqueToken,
  isAttachedCliRecord,
  oneAttachedCliRawHeader,
  parseAttachedCliSessionCookie,
  readAttachedCliJsonMutation,
  sendAttachedCliControllerError,
  sendAttachedCliError,
  sendAttachedCliErrorBeforeBodyConsumption,
  sendAttachedCliJson,
} from "./cli-attached-http.js";
import type { AttachedCliSessionController } from "./cli-attached-session.js";

interface BrowserSession {
  csrf: string;
}

interface ResolvedBrowserSession {
  readonly id: string;
  readonly session: BrowserSession;
}

export interface AttachedCliRouterOptions {
  readonly controller: AttachedCliSessionController;
  readonly uiRoot: string;
  /** Where the JSON API is mounted. Defaults to `/api`. */
  readonly apiPrefix?: string;
  /** Every authority the bound port answers on. */
  allowedAuthorities(): ReadonlySet<string>;
  /** The canonical origin the request target is resolved against. */
  origin(): string;
}

export interface AttachedCliRouter {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  /** The workbench shell, served by the router at `/` and by the launcher. */
  shell(response: ServerResponse, apiBase: string, launched: boolean): void;
  clearBrowserSessions(): void;
}

const maximumBrowserSessions = 128;

export function createAttachedCliRouter(
  options: AttachedCliRouterOptions,
): AttachedCliRouter {
  const { controller } = options;
  const api = options.apiPrefix ?? "/api";
  const assets: AttachedCliAssetServer = createAttachedCliAssetServer(
    options.uiRoot,
  );
  const sessions = new Map<string, BrowserSession>();

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

  /**
   * The origin a same-origin request carries. A browser sends whichever
   * loopback authority the developer typed, so the expected origin follows
   * the request host instead of one canonical spelling.
   */
  const requestOrigin = (request: IncomingMessage): string | undefined => {
    const host = oneAttachedCliRawHeader(request, "host");
    if (host === undefined || !options.allowedAuthorities().has(host)) {
      return undefined;
    }
    return `http://${host}`;
  };

  const sessionFor = (
    request: IncomingMessage,
  ): ResolvedBrowserSession | undefined => {
    const header = oneAttachedCliRawHeader(request, "cookie");
    if (header === undefined) return undefined;
    const id = parseAttachedCliSessionCookie(header);
    if (id === undefined) return undefined;
    const session = sessions.get(id);
    return session === undefined ? undefined : { id, session };
  };

  const requireMutation = (
    request: IncomingMessage,
    response: ServerResponse,
  ): ResolvedBrowserSession | undefined => {
    const expectedOrigin = requestOrigin(request);
    if (
      expectedOrigin === undefined ||
      oneAttachedCliRawHeader(request, "origin") !== expectedOrigin
    ) {
      sendAttachedCliErrorBeforeBodyConsumption(
        request,
        response,
        403,
        "FORBIDDEN",
        "The request origin is not allowed.",
      );
      return undefined;
    }
    const resolved = sessionFor(request);
    const csrf = oneAttachedCliRawHeader(request, attachedCliCsrfHeaderName);
    if (
      resolved === undefined ||
      !equalAttachedCliOpaqueToken(csrf, resolved.session.csrf)
    ) {
      sendAttachedCliErrorBeforeBodyConsumption(
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

  const handleSession = (
    request: IncomingMessage,
    response: ServerResponse,
  ): void => {
    let resolved = sessionFor(request);
    let cookie: string | undefined;
    if (resolved === undefined) {
      const created = createSession();
      if (created === undefined) {
        sendAttachedCliError(
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
      cookie = `${attachedCliSessionCookieName}=${created.id}; Path=/; HttpOnly; SameSite=Strict`;
    }
    const state = controller.state(resolved.id);
    sendAttachedCliJson(
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
        sendAttachedCliJson(
          response,
          200,
          { state: "idle" },
          { "x-invokta-csrf": csrf },
        );
      } catch (error) {
        sendAttachedCliControllerError(response, error);
      }
      return;
    }
    if (request.method !== "POST") {
      sendAttachedCliJson(
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
    const body = await readAttachedCliJsonMutation(
      request,
      response,
      attachedCliConnectionBodyLimitBytes,
      "The connection descriptor is too large.",
    );
    if (response.headersSent) return;
    if (!isAttachedCliRecord(body)) {
      sendAttachedCliError(
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
      sendAttachedCliJson(
        response,
        200,
        { state: "connected", connection: summary },
        { "x-invokta-csrf": csrf },
      );
    } catch (error) {
      sendAttachedCliControllerError(response, error);
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
      sendAttachedCliJson(
        response,
        200,
        { state: "connected", connection: summary },
        { "x-invokta-csrf": csrf },
      );
    } catch (error) {
      sendAttachedCliControllerError(response, error);
    }
  };

  const handleDescribe = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const owner = requireMutation(request, response);
    if (owner === undefined) return;
    const body = await readAttachedCliJsonMutation(
      request,
      response,
      attachedCliConnectionBodyLimitBytes,
      "The describe request is too large.",
    );
    if (response.headersSent) return;
    if (
      !isAttachedCliRecord(body) ||
      typeof body.id !== "string" ||
      body.id === ""
    ) {
      sendAttachedCliError(
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
      sendAttachedCliJson(response, 200, described, {
        "x-invokta-csrf": csrf,
      });
    } catch (error) {
      sendAttachedCliControllerError(response, error);
    }
  };

  const handleRun = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const owner = requireMutation(request, response);
    if (owner === undefined) return;
    const body = await readAttachedCliJsonMutation(
      request,
      response,
      attachedCliRunBodyLimitBytes,
      "The run request is too large.",
    );
    if (response.headersSent) return;
    if (
      !isAttachedCliRecord(body) ||
      typeof body.id !== "string" ||
      body.id === ""
    ) {
      sendAttachedCliError(
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
      sendAttachedCliJson(
        response,
        200,
        { result },
        { "x-invokta-csrf": csrf },
      );
    } catch (error) {
      sendAttachedCliControllerError(response, error);
    }
  };

  const requireOwner = (
    request: IncomingMessage,
    response: ServerResponse,
  ): string | undefined => {
    const session = sessionFor(request);
    if (session === undefined) {
      sendAttachedCliError(
        response,
        403,
        "FORBIDDEN",
        "The browser session is not authorized.",
      );
      return undefined;
    }
    return session.id;
  };

  const handleApiRead = (
    request: IncomingMessage,
    response: ServerResponse,
    resource: "catalog" | "activity",
  ): void => {
    const owner = requireOwner(request, response);
    if (owner === undefined) return;
    try {
      sendAttachedCliJson(
        response,
        200,
        resource === "catalog"
          ? { capabilities: controller.catalog(owner) }
          : { records: controller.activity(owner) },
      );
    } catch (error) {
      sendAttachedCliControllerError(response, error);
    }
  };

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const origin = options.origin();
    const expectedOrigin = requestOrigin(request);
    if (expectedOrigin === undefined) {
      sendAttachedCliErrorBeforeBodyConsumption(
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
      oneAttachedCliRawHeader(request, "origin") !== expectedOrigin
    ) {
      sendAttachedCliErrorBeforeBodyConsumption(
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
      url = new URL(rawTarget, origin);
    } catch {
      sendAttachedCliError(
        response,
        400,
        "INVALID_REQUEST",
        "The request URL is invalid.",
      );
      return;
    }
    const path = url.pathname;
    if (
      url.origin !== origin ||
      url.search !== "" ||
      url.hash !== "" ||
      rawTarget !== path
    ) {
      sendAttachedCliError(
        response,
        400,
        "INVALID_REQUEST",
        "The request URL is not canonical.",
      );
      return;
    }

    if (path === `${api}/session` && method === "GET") {
      handleSession(request, response);
      return;
    }
    if (path === `${api}/connection`) {
      await handleConnection(request, response);
      return;
    }
    if (path === `${api}/refresh` && method === "POST") {
      await handleRefresh(request, response);
      return;
    }
    if (path === `${api}/describe` && method === "POST") {
      await handleDescribe(request, response);
      return;
    }
    if (path === `${api}/run` && method === "POST") {
      await handleRun(request, response);
      return;
    }
    if (path === `${api}/catalog` && method === "GET") {
      handleApiRead(request, response, "catalog");
      return;
    }
    if (path === `${api}/activity` && method === "GET") {
      handleApiRead(request, response, "activity");
      return;
    }
    if (path.startsWith(`${api}/`)) {
      sendAttachedCliError(
        response,
        404,
        "NOT_FOUND",
        "The requested route was not found.",
      );
      return;
    }
    if (method !== "GET") {
      sendAttachedCliJson(
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
      assets.shell(response, api, false);
      return;
    }
    if (path === "/assets/favicon.svg") {
      assets.favicon(response);
      return;
    }
    if (path.startsWith("/assets/")) {
      await assets.serve(response, path.slice("/assets/".length).split("/"));
      return;
    }
    sendAttachedCliError(
      response,
      404,
      "NOT_FOUND",
      "The requested route was not found.",
    );
  };

  return {
    handle,
    shell: (response, apiBase, launched) => {
      assets.shell(response, apiBase, launched);
    },
    clearBrowserSessions() {
      sessions.clear();
    },
  };
}
