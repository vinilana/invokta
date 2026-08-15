import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type {
  IncomingMessage,
  Server as NodeHttpServer,
  ServerResponse,
} from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { Principal } from "@invokta/core";
import { inspectMcpOAuth } from "@invokta/mcp";

import type {
  AdapterInvocationResult,
  AdapterRunner,
} from "./adapter-runner.js";
import { AdapterBusyError, isAdapterId } from "./adapter-runner.js";
import type { EntryTargetStore } from "./entry-target.js";
import {
  EntryTargetError,
  isEntryAdapter,
  parseEntryPoint,
} from "./entry-target.js";
import { faviconLink, faviconSvg } from "./favicon.js";
import type { HttpTargetStore } from "./http-target.js";
import { HttpTargetError, parseHttpTarget } from "./http-target.js";
import {
  devtoolsHost,
  devtoolsOrigin,
  listenOnLoopback,
  literalLoopbackOrigin,
  loopbackAuthorities,
} from "./loopback.js";
import type { PrincipalStore } from "./principal-store.js";
import type { AdapterCallCapture, TraceStore } from "./trace-store.js";

/**
 * The interactive OAuth authorization of an external MCP endpoint, chartered
 * by ADR 0023 and reused here by ADR 0029. The devtools server only starts the
 * flow and completes it from the loopback callback; every token, PKCE value,
 * and registration artifact stays inside the session.
 */
export interface OAuthSession {
  begin(
    url: string,
    options: { readonly redirectUrl: string; readonly state: string },
  ): Promise<{ readonly authorizationUrl: string }>;
  complete(state: string, authorizationCode: string): Promise<void>;
  reject(state: string): Promise<void>;
  disconnect(): Promise<void>;
}

export interface DevtoolsServerAddress {
  readonly host: string;
  readonly port: number;
}

/**
 * The interface server's window onto the running engine. In-process serving
 * reads the live engine; watch mode reads the snapshot the engine-host child
 * reported, so the parent never imports the watched module itself.
 */
export interface EngineView {
  readonly name: string;
  readonly version: string;
  /** The `describe` output of every capability, JSON-serializable. */
  readonly capabilities: ReadonlyArray<unknown>;
  /** The JSON-safe doctor report body. */
  readonly doctor: unknown;
}

export interface DevtoolsServerOptions {
  readonly engineView: () => EngineView;
  readonly principals: PrincipalStore;
  readonly trace: TraceStore;
  /** Runs one capability call through the adapter the caller selected. */
  readonly adapters: AdapterRunner;
  /** Where MCP HTTP sends a call, and how it authenticates. */
  readonly httpTarget: HttpTargetStore;
  /** Which composition root runs the CLI and MCP stdio emulations. */
  readonly entryTarget: EntryTargetStore;
  /** The directory a project entry point is resolved against. */
  readonly cwd: string;
  /** The served module, published so the interface can propose a sibling. */
  readonly module: { readonly specifier: string; readonly exportName: string };
  /** Drives the interactive OAuth authorization of an external endpoint. */
  readonly oauth?: OAuthSession;
  /** The engine host's current MCP endpoint port on loopback. */
  readonly enginePort: () => number;
  /**
   * Defaults to 4100. Ignored when `server` is already bound: the caller
   * selects the port, because the engine host has to allow the interface
   * origin before this server accepts a request.
   */
  readonly port?: number;
  /**
   * An already-bound loopback server to serve on. `serve` binds the port
   * before it starts the engine host, so nothing can take the port between
   * publishing the allowed origin and answering on it.
   */
  readonly server?: NodeHttpServer;
  /** Directory holding the built interface bundle. Defaults to `dist/ui`. */
  readonly uiRoot?: string;
}

export interface DevtoolsServer {
  address(): DevtoolsServerAddress;
  close(): Promise<void>;
}

const apiBodyLimitBytes = 64 * 1024;
const mcpBodyLimitBytes = 1024 * 1024;
/** Bounds the whole discovery chain of one OAuth endpoint check. */
const httpTargetCheckTimeoutMs = 20_000;
/** ADR 0023: an oversized callback target must not select an attempt. */
const oauthCallbackTargetLimitBytes = 8_192;

const appShellPage = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invokta DevTools · Project workspace</title>
${faviconLink}
<style>
html { background: #09090b; color-scheme: dark; }
html[data-theme="light"] { background: #fff; color-scheme: light; }
</style>
<script>
try {
  const choice = localStorage.getItem("starlight-theme");
  const light = choice === "light" ||
    (choice === "auto" && matchMedia("(prefers-color-scheme: light)").matches);
  if (light) document.documentElement.dataset.theme = "light";
} catch {}
</script>
</head>
<body>
<noscript>The Invokta DevTools interface requires JavaScript.</noscript>
<script type="module" src="/assets/app.js"></script>
</body>
</html>
`;

const oauthCallbackCopy: Readonly<
  Record<
    "success" | "rejected" | "invalid" | "error",
    readonly [string, string]
  >
> = {
  success: [
    "Authorization complete",
    "Return to Invokta DevTools. You can close this tab.",
  ],
  rejected: [
    "Authorization was not completed",
    "Return to Invokta DevTools to try again.",
  ],
  invalid: [
    "Authorization callback was invalid",
    "Return to Invokta DevTools and start the authorization again.",
  ],
  error: [
    "Authorization failed",
    "Return to Invokta DevTools to review the endpoint.",
  ],
};

type OAuthCallbackOutcome = "success" | "rejected" | "invalid" | "error";

function oauthCallbackPage(outcome: OAuthCallbackOutcome): string {
  const [title, hint] = oauthCallbackCopy[outcome];
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head><meta charset="utf-8"><title>${title}</title>${faviconLink}
<style>html{background:#09090b;color-scheme:dark;color:#e4e4e7;font:15px/1.5 system-ui,sans-serif}
main{max-width:32rem;margin:6rem auto;padding:0 1.5rem}h1{font-size:1.25rem;margin:0 0 .5rem}
p{color:#a1a1aa;margin:0}</style></head>
<body><main><h1>${title}</h1><p>${hint}</p></main></body></html>
`;
}

const staticContentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** One path segment of a shipped asset; anything else is not served. */
const assetSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(text);
}

function readBody(
  request: IncomingMessage,
  limitBytes: number,
): Promise<{ readonly ok: boolean; readonly body: Buffer }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        request.removeAllListeners("data");
        request.removeAllListeners("end");
        resolve({ ok: false, body: Buffer.alloc(0) });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve({ ok: true, body: Buffer.concat(chunks) });
    });
    request.on("error", reject);
  });
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
}

function principalBody(value: {
  readonly key: string;
  readonly principal: Principal;
}): unknown {
  return { key: value.key, principal: value.principal };
}

function isPrincipalInput(value: unknown): value is Principal {
  if (typeof value !== "object" || value === null) return false;
  const record = value as {
    readonly id?: unknown;
    readonly attributes?: unknown;
  };
  if (typeof record.id !== "string" || record.id === "") return false;
  if (
    record.attributes !== undefined &&
    (typeof record.attributes !== "object" ||
      record.attributes === null ||
      Array.isArray(record.attributes))
  ) {
    return false;
  }
  return true;
}

interface CapabilityView {
  readonly id: string;
  readonly mcpToolName: string;
  readonly timeoutMs?: number;
}

function readCapabilityView(value: unknown): CapabilityView | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as {
    readonly id?: unknown;
    readonly mcpToolName?: unknown;
    readonly timeoutMs?: unknown;
  };
  if (typeof record.id !== "string" || typeof record.mcpToolName !== "string") {
    return undefined;
  }
  return {
    id: record.id,
    mcpToolName: record.mcpToolName,
    ...(typeof record.timeoutMs === "number" &&
    Number.isFinite(record.timeoutMs)
      ? { timeoutMs: record.timeoutMs }
      : {}),
  };
}

/**
 * Renders what the adapter exchanged into the two strings the trace shows.
 * Each adapter carries a different shape, and the trace stays one readable
 * feed rather than four. The identity the call acted as travels with it — but
 * only when the adapter actually presented it, so a call whose principal came
 * from a project entry point or an external endpoint is never attributed to
 * the selected test identity. The invocation arguments travel too, so "Open
 * in Playground" can reproduce a call whose exchange is a rendered command.
 */
function toAdapterCapture(
  result: AdapterInvocationResult,
  principalId: string | null,
  input: string,
): AdapterCallCapture {
  const shared = {
    adapter: result.adapter,
    capabilityId: result.capabilityId,
    outcome: result.outcome,
    durationMs: result.durationMs,
    principalId: result.identityApplied ? principalId : null,
    input,
    ...(result.error === undefined ? {} : { errorCode: result.error.code }),
  };
  if (result.exchange.kind === "http") {
    return {
      ...shared,
      request: result.exchange.requestBody,
      response: result.exchange.responseBody,
      status: result.exchange.status,
    };
  }
  if (result.exchange.kind === "mcp") {
    return {
      ...shared,
      request: result.exchange.request,
      response: result.exchange.response,
      command: result.exchange.target,
    };
  }
  return {
    ...shared,
    request: result.exchange.command,
    response:
      result.exchange.stderr === ""
        ? result.exchange.stdout
        : `${result.exchange.stdout}${result.exchange.stderr}`,
    exitCode: result.exchange.exitCode,
    command: result.exchange.command,
  };
}

/** Extra time an emulated call may take on top of the capability deadline. */
const adapterStartupSlackMs = 10_000;

function defaultUiRoot(): string {
  return join(fileURLToPath(new URL(".", import.meta.url)), "ui");
}

/**
 * The single-origin development interface server: static bundle, JSON API,
 * trace event stream, and the same-origin MCP proxy toward the engine host.
 * Binds loopback only and never emits an `Access-Control-*` header.
 */
export async function startDevtoolsServer(
  options: DevtoolsServerOptions,
): Promise<DevtoolsServer> {
  const uiRoot = options.uiRoot ?? defaultUiRoot();
  const engineEndpoint = (): string =>
    `${literalLoopbackOrigin(options.enginePort())}/mcp`;

  let authorities: ReadonlySet<string> = new Set();
  let ownOrigin = "";
  let oauthRedirectUrl = "";
  const sseClients = new Set<ServerResponse>();

  /**
   * The origin a same-origin request carries. A browser sends whichever
   * loopback authority the developer typed — and an OAuth provider always
   * redirects to the literal one — so the expected origin follows the request
   * host instead of one canonical spelling.
   */
  const requestOrigin = (request: IncomingMessage): string | undefined => {
    const requestHost = request.headers.host;
    if (requestHost === undefined || !authorities.has(requestHost)) {
      return undefined;
    }
    return `http://${requestHost}`;
  };

  const sendTraceFrame = (response: ServerResponse, entry: unknown): void => {
    response.write(`event: trace\ndata: ${JSON.stringify(entry)}\n\n`);
  };

  const unsubscribe = options.trace.subscribe((entry) => {
    for (const client of sseClients) {
      try {
        sendTraceFrame(client, entry);
      } catch {
        // A slow or gone stream consumer must not affect tracing.
      }
    }
  });

  const serveStatic = (
    response: ServerResponse,
    relativeSegments: readonly string[],
  ): void => {
    if (
      relativeSegments.length === 0 ||
      relativeSegments.some((segment) => !assetSegmentPattern.test(segment))
    ) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    const filePath = normalize(join(uiRoot, ...relativeSegments));
    if (!filePath.startsWith(`${normalize(uiRoot)}${sep}`)) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (!existsSync(filePath)) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    const extension = filePath.slice(filePath.lastIndexOf("."));
    const contentType = staticContentTypes[extension];
    if (contentType === undefined) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    response.writeHead(200, {
      "content-type": contentType,
      "cache-control": "no-store",
    });
    response.end(readFileSync(filePath));
  };

  const serveIndex = (response: ServerResponse): void => {
    const indexPath = join(uiRoot, "index.html");
    if (existsSync(indexPath)) {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(readFileSync(indexPath));
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(appShellPage);
  };

  const handlePrincipals = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (request.method === "GET") {
      sendJson(response, 200, options.principals.list().map(principalBody));
      return;
    }
    const read = await readBody(request, apiBodyLimitBytes);
    if (!read.ok) {
      sendJson(response, 413, { error: "payload_too_large" });
      return;
    }
    const body = parseJson(read.body) as
      | { readonly key?: unknown; readonly principal?: unknown }
      | undefined;
    if (request.method === "POST") {
      if (body !== undefined && typeof body.key === "string") {
        const rotated = options.principals.rotate(body.key);
        if (rotated === null) {
          sendJson(response, 404, { error: "unknown_principal" });
          return;
        }
        sendJson(response, 200, rotated);
        return;
      }
      if (body !== undefined && isPrincipalInput(body.principal)) {
        sendJson(response, 201, options.principals.issue(body.principal));
        return;
      }
      sendJson(response, 400, { error: "invalid_principal" });
      return;
    }
    if (request.method === "PUT") {
      if (
        body === undefined ||
        typeof body.key !== "string" ||
        !isPrincipalInput(body.principal)
      ) {
        sendJson(response, 400, { error: "invalid_principal" });
        return;
      }
      const updated = options.principals.update(body.key, body.principal);
      if (updated === null) {
        sendJson(response, 404, { error: "unknown_principal" });
        return;
      }
      // An update keeps the existing token, so none is minted or echoed.
      sendJson(response, 200, principalBody(updated));
      return;
    }
    if (request.method === "DELETE") {
      if (body === undefined || typeof body.key !== "string") {
        sendJson(response, 400, { error: "invalid_principal" });
        return;
      }
      if (!options.principals.remove(body.key)) {
        sendJson(response, 404, { error: "unknown_principal" });
        return;
      }
      sendJson(response, 200, { removed: true });
      return;
    }
    sendJson(
      response,
      405,
      { error: "method_not_allowed" },
      { allow: "GET, POST, PUT, DELETE" },
    );
  };

  const handleEvents = (
    request: IncomingMessage,
    response: ServerResponse,
  ): void => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    response.write("retry: 2000\n\n");
    for (const entry of options.trace.entries()) {
      sendTraceFrame(response, entry);
    }
    sseClients.add(response);
    request.once("close", () => {
      sseClients.delete(response);
    });
  };

  /**
   * Runs the read-only OAuth discovery check against the exact endpoint the
   * caller drafted (falling back to the selected external endpoint). It
   * authorizes nothing and sends no credential: the point is to attribute a
   * failure to the leg that produced it, instead of to authentication as a
   * whole. The inspection is bounded by a deadline and cancelled when the
   * browser goes away, so a target that never answers cannot pin this handler.
   */
  const handleHttpTargetCheck = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const read = await readBody(request, apiBodyLimitBytes);
    if (!read.ok) {
      sendJson(response, 413, { error: "payload_too_large" });
      return;
    }
    const body = parseJson(read.body) as { readonly url?: unknown } | undefined;
    let url: string;
    if (typeof body?.url === "string" && body.url !== "") {
      url = body.url;
    } else {
      const target = options.httpTarget.current();
      if (target.kind !== "external") {
        sendJson(response, 400, {
          error: "not_an_external_endpoint",
          message:
            "The devtools host authenticates with its own session tokens; there is no OAuth chain to check.",
        });
        return;
      }
      url = target.url;
    }
    const deadline = AbortSignal.timeout(httpTargetCheckTimeoutMs);
    const disconnected = new AbortController();
    request.once("close", () => {
      if (!response.writableEnded) disconnected.abort();
    });
    try {
      const inspection = await inspectMcpOAuth(
        {
          transport: "http",
          url,
          authentication: { type: "oauth" },
        },
        { signal: AbortSignal.any([deadline, disconnected.signal]) },
      );
      sendJson(response, 200, inspection);
    } catch (error) {
      if (disconnected.signal.aborted) return;
      if (deadline.aborted) {
        sendJson(response, 504, {
          error: "check_timed_out",
          message: "The endpoint did not answer the discovery check in time.",
        });
        return;
      }
      sendJson(response, 400, {
        error: "invalid_target",
        message:
          error instanceof Error
            ? error.message
            : "The endpoint could not be checked.",
      });
    }
  };

  /**
   * Reads or replaces where MCP HTTP sends a call. The response never carries
   * a credential: only the kind, the URL, the authentication type, and header
   * or environment-variable names leave this process.
   */
  const handleHttpTarget = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (request.method === "GET") {
      sendJson(response, 200, options.httpTarget.view());
      return;
    }
    if (request.method === "DELETE") {
      await options.oauth?.disconnect().catch(() => undefined);
      options.httpTarget.reset();
      sendJson(response, 200, options.httpTarget.view());
      return;
    }
    if (request.method !== "PUT" && request.method !== "POST") {
      sendJson(
        response,
        405,
        { error: "method_not_allowed" },
        { allow: "GET, PUT, POST, DELETE" },
      );
      return;
    }
    const read = await readBody(request, apiBodyLimitBytes);
    if (!read.ok) {
      sendJson(response, 413, { error: "payload_too_large" });
      return;
    }
    let target: ReturnType<typeof parseHttpTarget>;
    try {
      target = parseHttpTarget(parseJson(read.body));
    } catch (error) {
      if (error instanceof HttpTargetError) {
        sendJson(response, 400, {
          error: error.code.toLowerCase(),
          message: error.message,
        });
        return;
      }
      throw error;
    }

    if (target.kind === "external" && target.authentication.type === "oauth") {
      const oauth = options.oauth;
      if (oauth === undefined) {
        // Nothing was committed: the stored target and the invoke path stay
        // exactly as the interface last saw them.
        sendJson(response, 400, {
          error: "oauth_unavailable",
          message: "This dev server cannot run an interactive authorization.",
        });
        return;
      }
      // The session controller runs one session at a time, so the previous
      // authorization must be released before its replacement can begin — but
      // the stored target is replaced only once `begin` succeeded. A failed
      // begin therefore leaves the target (and what /api/invoke reads)
      // unchanged, with only its authorization flag telling the truth.
      await oauth.disconnect().catch(() => undefined);
      options.httpTarget.markAuthorized(false);
      const state = randomBytes(32).toString("base64url");
      try {
        const authorization = await oauth.begin(target.url, {
          // RFC 8252 prefers the literal loopback address over `localhost`,
          // and the MCP client accepts nothing else, so the redirect never
          // follows the advertised host.
          redirectUrl: oauthRedirectUrl,
          state,
        });
        options.httpTarget.set(target);
        sendJson(response, 202, {
          ...options.httpTarget.view(),
          authorizationUrl: authorization.authorizationUrl,
        });
      } catch (error) {
        sendJson(response, 400, {
          error: "authorization_failed",
          message:
            error instanceof Error
              ? error.message
              : "The authorization could not be started.",
        });
      }
      return;
    }
    // A previous authorization belongs to the previous target.
    await options.oauth?.disconnect().catch(() => undefined);
    options.httpTarget.set(target);
    sendJson(response, 200, options.httpTarget.view());
  };

  /**
   * Reads or replaces which composition root runs an emulated CLI or MCP
   * stdio call: the devtools child, which supplies the selected identity, or
   * the engine's own entry point, which supplies whatever its root decides.
   */
  const handleEntryTarget = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (request.method === "GET") {
      sendJson(response, 200, options.entryTarget.view());
      return;
    }
    if (request.method === "DELETE") {
      options.entryTarget.reset();
      sendJson(response, 200, options.entryTarget.view());
      return;
    }
    if (request.method !== "PUT") {
      sendJson(
        response,
        405,
        { error: "method_not_allowed" },
        { allow: "GET, PUT, DELETE" },
      );
      return;
    }
    const read = await readBody(request, apiBodyLimitBytes);
    if (!read.ok) {
      sendJson(response, 413, { error: "payload_too_large" });
      return;
    }
    const body = parseJson(read.body) as
      | { readonly adapter?: unknown; readonly entryPoint?: unknown }
      | undefined;
    if (body === undefined || !isEntryAdapter(body.adapter)) {
      sendJson(response, 400, {
        error: "invalid_adapter",
        message: "Only the CLI and MCP stdio adapters have an entry point.",
      });
      return;
    }
    try {
      options.entryTarget.set(
        body.adapter,
        parseEntryPoint(body.entryPoint, options.cwd),
      );
    } catch (error) {
      if (error instanceof EntryTargetError) {
        sendJson(response, 400, {
          error: error.code.toLowerCase(),
          message: error.message,
        });
        return;
      }
      throw error;
    }
    sendJson(response, 200, options.entryTarget.view());
  };

  /**
   * Completes the loopback leg of an interactive authorization, following the
   * ADR 0023 callback contract. The provider redirects the developer's
   * browser here with the authorization code and state in the query, so
   * nothing is rendered at this URL: the browser is redirected to a clean
   * result path first, keeping the code out of history and out of any Referer
   * the result page's assets would send. An oversized or state-ambiguous
   * callback must not select — let alone consume — an in-flight attempt.
   */
  const handleOAuthCallback = async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> => {
    const finish = (outcome: OAuthCallbackOutcome): void => {
      response.writeHead(303, {
        location: `/oauth/result?outcome=${outcome}`,
        "cache-control": "no-store",
      });
      response.end();
    };
    if (Buffer.byteLength(request.url ?? "") > oauthCallbackTargetLimitBytes) {
      finish("invalid");
      return;
    }
    const oauth = options.oauth;
    const states = url.searchParams.getAll("state");
    const codes = url.searchParams.getAll("code");
    const errors = url.searchParams.getAll("error");
    const state = states[0];
    if (
      oauth === undefined ||
      states.length !== 1 ||
      state === undefined ||
      !/^[A-Za-z0-9_-]{43}$/u.test(state)
    ) {
      finish("invalid");
      return;
    }
    // From here one attempt is selected; a malformed result consumes it.
    const rejectCallback = async (
      outcome: "invalid" | "rejected",
    ): Promise<void> => {
      try {
        await oauth.reject(state);
      } catch {
        finish("error");
        return;
      }
      finish(outcome);
    };
    if (
      !(
        (codes.length === 1 && errors.length === 0) ||
        (codes.length === 0 && errors.length === 1)
      )
    ) {
      await rejectCallback("invalid");
      return;
    }
    const error = errors[0];
    if (error !== undefined) {
      await rejectCallback(
        error.length === 0 || error.length > 256 ? "invalid" : "rejected",
      );
      return;
    }
    const code = codes[0];
    if (code === undefined || code.length === 0 || code.length > 4_096) {
      await rejectCallback("invalid");
      return;
    }
    try {
      await oauth.complete(state, code);
      options.httpTarget.markAuthorized(true);
      finish("success");
    } catch {
      finish("error");
    }
  };

  /**
   * Runs one capability call through the selected adapter. Every adapter the
   * engine publishes is reachable here, and the answer is normalized so the
   * interface reads one outcome regardless of which path carried the call.
   */
  const handleInvoke = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const read = await readBody(request, mcpBodyLimitBytes);
    if (!read.ok) {
      sendJson(response, 413, { error: "payload_too_large" });
      return;
    }
    const body = parseJson(read.body) as
      | {
          readonly adapter?: unknown;
          readonly capabilityId?: unknown;
          readonly arguments?: unknown;
          readonly principalKey?: unknown;
        }
      | undefined;
    if (body === undefined || !isAdapterId(body.adapter)) {
      sendJson(response, 400, {
        error: "unknown_adapter",
        message: "Select one of the adapters the engine publishes.",
      });
      return;
    }
    const capability = options
      .engineView()
      .capabilities.map(readCapabilityView)
      .find((entry) => entry?.id === body.capabilityId);
    if (capability === undefined) {
      sendJson(response, 400, {
        error: "unknown_capability",
        message: "The engine publishes no capability with that ID.",
      });
      return;
    }
    let identity: {
      readonly principal: Principal;
      readonly token: string;
    } | null = null;
    if (typeof body.principalKey === "string" && body.principalKey !== "") {
      const record = options.principals
        .list()
        .find((entry) => entry.key === body.principalKey);
      if (record === undefined) {
        sendJson(response, 400, {
          error: "unknown_principal",
          message: "The selected test identity no longer exists.",
        });
        return;
      }
      identity = { principal: record.principal, token: record.token };
    }

    // A closed browser connection ends the emulation, so an adapter child is
    // never left running for a caller that stopped listening.
    const controller = new AbortController();
    request.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });

    let result: AdapterInvocationResult;
    try {
      result = await options.adapters.run({
        adapter: body.adapter,
        capabilityId: capability.id,
        mcpToolName: capability.mcpToolName,
        input: body.arguments ?? {},
        identity,
        signal: controller.signal,
        ...(capability.timeoutMs === undefined
          ? {}
          : { timeoutMs: capability.timeoutMs + adapterStartupSlackMs }),
      });
    } catch (error) {
      if (error instanceof AdapterBusyError) {
        sendJson(response, 429, {
          error: "adapter_busy",
          message: `Wait for one of the ${String(error.limit)} running emulations to finish.`,
        });
        return;
      }
      throw error;
    }
    options.trace.appendAdapterCall(
      toAdapterCapture(
        result,
        identity?.principal.id ?? null,
        JSON.stringify(body.arguments ?? {}),
      ),
    );
    sendJson(response, 200, result);
  };

  const handleMcpProxy = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const read = await readBody(request, mcpBodyLimitBytes);
    if (!read.ok) {
      sendJson(response, 413, { error: "payload_too_large" });
      return;
    }
    const forwarded: Record<string, string> = {};
    for (const name of [
      "accept",
      "authorization",
      "content-type",
      "origin",
    ] as const) {
      const value = request.headers[name];
      if (typeof value === "string") forwarded[name] = value;
    }

    const startedAtMs = performance.now();
    let upstream: Response;
    try {
      upstream = await fetch(engineEndpoint(), {
        method: "POST",
        headers: forwarded,
        body: new Uint8Array(read.body),
      });
    } catch {
      sendJson(response, 502, { error: "engine_host_unreachable" });
      return;
    }
    const responseBody = Buffer.from(await upstream.arrayBuffer());
    const durationMs = Math.max(0, performance.now() - startedAtMs);

    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (
        name === "connection" ||
        name === "content-length" ||
        name === "keep-alive" ||
        name === "transfer-encoding"
      ) {
        return;
      }
      responseHeaders[name] = value;
    });
    responseHeaders["content-length"] = String(responseBody.length);
    response.writeHead(upstream.status, responseHeaders);
    response.end(responseBody);

    const requestJson = parseJson(read.body) as
      | {
          readonly method?: unknown;
          readonly params?: { readonly name?: unknown };
        }
      | undefined;
    const mcpMethod =
      typeof requestJson?.method === "string" ? requestJson.method : undefined;
    const capabilityId =
      mcpMethod === "tools/call" &&
      typeof requestJson?.params?.name === "string"
        ? requestJson.params.name
        : undefined;
    options.trace.appendExchange({
      status: upstream.status,
      durationMs,
      ...(mcpMethod === undefined ? {} : { mcpMethod }),
      ...(capabilityId === undefined ? {} : { capabilityId }),
      requestBody: read.body.toString("utf8"),
      responseBody: responseBody.toString("utf8"),
    });
  };

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const expectedOrigin = requestOrigin(request);
    if (expectedOrigin === undefined) {
      sendJson(response, 403, { error: "forbidden" });
      return;
    }
    const method = request.method ?? "GET";
    const originHeader = request.headers.origin;
    if (
      method !== "GET" &&
      originHeader !== undefined &&
      originHeader !== expectedOrigin
    ) {
      sendJson(response, 403, { error: "forbidden" });
      return;
    }

    const url = new URL(request.url ?? "/", ownOrigin);
    const path = url.pathname;

    if (path === "/mcp") {
      if (method !== "POST") {
        sendJson(
          response,
          405,
          { error: "method_not_allowed" },
          { allow: "POST" },
        );
        return;
      }
      await handleMcpProxy(request, response);
      return;
    }
    if (path === "/api/http-target") {
      await handleHttpTarget(request, response);
      return;
    }
    if (path === "/api/http-target/check") {
      if (method !== "POST") {
        sendJson(
          response,
          405,
          { error: "method_not_allowed" },
          { allow: "POST" },
        );
        return;
      }
      await handleHttpTargetCheck(request, response);
      return;
    }
    if (path === "/api/entry-target") {
      await handleEntryTarget(request, response);
      return;
    }
    if (path === "/oauth/callback") {
      if (method !== "GET") {
        sendJson(
          response,
          405,
          { error: "method_not_allowed" },
          { allow: "GET" },
        );
        return;
      }
      await handleOAuthCallback(request, response, url);
      return;
    }
    if (path === "/oauth/result") {
      if (method !== "GET") {
        sendJson(
          response,
          405,
          { error: "method_not_allowed" },
          { allow: "GET" },
        );
        return;
      }
      const outcome = url.searchParams.get("outcome");
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(
        oauthCallbackPage(
          outcome === "success" ||
            outcome === "rejected" ||
            outcome === "invalid"
            ? outcome
            : "error",
        ),
      );
      return;
    }
    if (path === "/api/invoke") {
      if (method !== "POST") {
        sendJson(
          response,
          405,
          { error: "method_not_allowed" },
          { allow: "POST" },
        );
        return;
      }
      await handleInvoke(request, response);
      return;
    }
    if (path === "/api/principals") {
      await handlePrincipals(request, response);
      return;
    }
    if (path === "/api/trace/clear") {
      if (method !== "POST") {
        sendJson(
          response,
          405,
          { error: "method_not_allowed" },
          { allow: "POST" },
        );
        return;
      }
      options.trace.clear();
      sendJson(response, 200, { cleared: true });
      return;
    }
    if (method !== "GET") {
      sendJson(
        response,
        405,
        { error: "method_not_allowed" },
        { allow: "GET" },
      );
      return;
    }
    if (path === "/") {
      serveIndex(response);
      return;
    }
    if (path === "/assets/favicon.svg") {
      response.writeHead(200, {
        "content-type": "image/svg+xml",
        "cache-control": "no-store",
      });
      response.end(faviconSvg);
      return;
    }
    if (path.startsWith("/assets/")) {
      serveStatic(response, path.slice("/assets/".length).split("/"));
      return;
    }
    if (path === "/api/engine") {
      const view = options.engineView();
      // Deliberately no adapter catalog here: the interface owns the adapter
      // presentations, and a second copy published from the server would be
      // one more thing to keep in step by hand.
      sendJson(response, 200, {
        name: view.name,
        version: view.version,
        capabilityCount: view.capabilities.length,
        engineHost: { host: "127.0.0.1", port: options.enginePort() },
        module: options.module,
      });
      return;
    }
    if (path === "/api/capabilities") {
      sendJson(response, 200, options.engineView().capabilities);
      return;
    }
    if (path === "/api/doctor") {
      sendJson(response, 200, options.engineView().doctor);
      return;
    }
    // There is deliberately no trace export route: ADR 0021 requires the
    // trace to stay an in-memory session buffer that leaves the process only
    // through the local event stream.
    if (path === "/api/events") {
      handleEvents(request, response);
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  };

  const server: NodeHttpServer = options.server ?? createServer();
  server.on("request", (request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: "internal_error" });
      } else {
        response.end();
      }
    });
  });

  const boundPort = server.listening
    ? (server.address() as AddressInfo).port
    : await listenOnLoopback(server, {
        ...(options.port === undefined ? {} : { port: options.port }),
        maxPortAttempts: 1,
      });
  authorities = loopbackAuthorities(boundPort);
  ownOrigin = devtoolsOrigin(boundPort);
  oauthRedirectUrl = `${literalLoopbackOrigin(boundPort)}/oauth/callback`;

  return {
    address: () => ({ host: devtoolsHost, port: boundPort }),
    close: async () => {
      unsubscribe();
      for (const client of sseClients) {
        try {
          client.end();
        } catch {
          // Closing an event stream is best-effort.
        }
      }
      sseClients.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}
