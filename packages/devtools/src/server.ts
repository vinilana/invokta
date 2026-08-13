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

import type {
  AdapterInvocationResult,
  AdapterRunner,
} from "./adapter-runner.js";
import {
  adapterDescriptors,
  AdapterBusyError,
  isAdapterId,
} from "./adapter-runner.js";
import { faviconLink, faviconSvg } from "./favicon.js";
import type { PrincipalStore } from "./principal-store.js";
import type { AdapterCallCapture, TraceStore } from "./trace-store.js";

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
  /** The engine host's current MCP endpoint port on loopback. */
  readonly enginePort: () => number;
  /** Defaults to 4100. */
  readonly port?: number;
  /** Directory holding the built interface bundle. Defaults to `dist/ui`. */
  readonly uiRoot?: string;
}

export interface DevtoolsServer {
  address(): DevtoolsServerAddress;
  close(): Promise<void>;
}

const defaultPort = 4100;
const host = "127.0.0.1";
const apiBodyLimitBytes = 64 * 1024;
const mcpBodyLimitBytes = 1024 * 1024;

const appShellPage = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invokta devtools</title>
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
<noscript>The Invokta devtools interface requires JavaScript.</noscript>
<script type="module" src="/assets/app.js"></script>
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
 * feed rather than four.
 */
function toAdapterCapture(result: AdapterInvocationResult): AdapterCallCapture {
  const shared = {
    adapter: result.adapter,
    capabilityId: result.capabilityId,
    outcome: result.outcome,
    durationMs: result.durationMs,
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
  if (result.exchange.kind === "stdio") {
    return {
      ...shared,
      request: result.exchange.request,
      response: result.exchange.response,
      command: result.exchange.command,
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
  const port = options.port ?? defaultPort;
  const uiRoot = options.uiRoot ?? defaultUiRoot();
  const engineEndpoint = (): string =>
    `http://127.0.0.1:${String(options.enginePort())}/mcp`;

  let boundAuthority = "";
  let ownOrigin = "";
  const sseClients = new Set<ServerResponse>();

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
      { allow: "GET, POST, DELETE" },
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
    options.trace.appendAdapterCall(toAdapterCapture(result));
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
    const hostHeader = request.headers.host;
    if (hostHeader !== boundAuthority) {
      sendJson(response, 403, { error: "forbidden" });
      return;
    }
    const method = request.method ?? "GET";
    const originHeader = request.headers.origin;
    if (
      method !== "GET" &&
      originHeader !== undefined &&
      originHeader !== ownOrigin
    ) {
      sendJson(response, 403, { error: "forbidden" });
      return;
    }

    const url = new URL(request.url ?? "/", `http://${boundAuthority}`);
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
      sendJson(response, 200, {
        name: view.name,
        version: view.version,
        capabilityCount: view.capabilities.length,
        engineHost: { host: "127.0.0.1", port: options.enginePort() },
        adapters: adapterDescriptors,
        maxConcurrentInvocations: options.adapters.maxConcurrent,
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

  const server: NodeHttpServer = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: "internal_error" });
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

  return {
    address: () => ({ host, port: boundPort }),
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
