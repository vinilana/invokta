import type {
  IncomingMessage,
  Server as NodeHttpServer,
  ServerResponse,
} from "node:http";
import { createServer } from "node:http";

import { createAttachedRouter } from "./attached-router.js";
import type { AttachedServerController } from "./attached-server.js";
import { createAttachedSessionController } from "./attached-session.js";
// The asset surface is shared by both workbenches: one bundle directory, one
// stylesheet, one favicon.
import {
  createAttachedCliAssetServer as createSharedAssetServer,
  defaultAttachedCliUiRoot,
} from "./cli-attached-assets.js";
import {
  attachedCliSecurityHeaders,
  oneAttachedCliRawHeader,
  sendAttachedCliError,
  sendAttachedCliErrorBeforeBodyConsumption,
} from "./cli-attached-http.js";
import { createAttachedCliRouter } from "./cli-attached-router.js";
import type { AttachedCliServerController } from "./cli-attached-server.js";
import { createAttachedCliSessionController } from "./cli-attached-session.js";
import { faviconLink } from "./favicon.js";
import {
  devtoolsHost,
  devtoolsOrigin,
  listenOnLoopback,
  literalLoopbackOrigin,
  loopbackAuthorities,
} from "./loopback.js";
import type { DevtoolsServerAddress } from "./server.js";

/** The workbenches the launcher mounts, and the path each answers on. */
export const workbenchPaths = Object.freeze({
  mcp: "/mcp",
  cli: "/cli",
});

export type WorkbenchName = keyof typeof workbenchPaths;

export function isWorkbenchName(value: unknown): value is WorkbenchName {
  return value === "mcp" || value === "cli";
}

export interface StartWorkbenchDevtoolsServerOptions {
  readonly mcpController?: AttachedServerController;
  readonly cliController?: AttachedCliServerController;
  /** Defaults to 4100; a taken port walks to the next free one. */
  readonly port?: number;
  /** Directory holding the built interface bundle. Defaults to `dist/ui`. */
  readonly uiRoot?: string;
  /** Called with each taken port before the next one is tried. */
  readonly onPortInUse?: (port: number) => void;
}

export interface WorkbenchDevtoolsServer {
  address(): DevtoolsServerAddress;
  /** The path a workbench answers on; the chooser answers on `/`. */
  path(workbench?: WorkbenchName): string;
  close(): Promise<void>;
}

const apiPrefixes: Readonly<Record<WorkbenchName, string>> = {
  mcp: "/api/mcp",
  cli: "/api/cli",
};

const chooserPage = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invokta DevTools</title>
${faviconLink}
<link rel="stylesheet" href="/assets/attached.css">
</head>
<body>
<noscript>The Invokta DevTools interface requires JavaScript.</noscript>
<script type="module" src="/assets/chooser-app.js"></script>
</body>
</html>
`;

/**
 * The launcher: one loopback origin that opens on the workbench chooser and
 * mounts both idle workbenches next to each other. Neither workbench loads a
 * workspace, spawns a target, or opens an outbound connection until the
 * developer selects Connect inside it.
 */
export async function startWorkbenchDevtoolsServer(
  options: StartWorkbenchDevtoolsServerOptions = {},
): Promise<WorkbenchDevtoolsServer> {
  const mcpController =
    options.mcpController ?? createAttachedSessionController();
  const cliController =
    options.cliController ?? createAttachedCliSessionController();
  const uiRoot = options.uiRoot ?? defaultAttachedCliUiRoot();
  let authorities: ReadonlySet<string> = new Set();
  let ownOrigin = "";
  let oauthRedirectUrl = "";
  let closed = false;

  const assets = createSharedAssetServer(uiRoot);
  const mcpRouter = createAttachedRouter({
    controller: mcpController,
    uiRoot,
    apiPrefix: apiPrefixes.mcp,
    allowedAuthorities: () => authorities,
    origin: () => ownOrigin,
    oauthRedirectUrl: () => oauthRedirectUrl,
  });
  const cliRouter = createAttachedCliRouter({
    controller: cliController,
    uiRoot,
    apiPrefix: apiPrefixes.cli,
    allowedAuthorities: () => authorities,
    origin: () => ownOrigin,
  });

  const sendPage = (response: ServerResponse, page: string): void => {
    response.writeHead(200, {
      ...attachedCliSecurityHeaders(),
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(page);
  };

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const requestHost = oneAttachedCliRawHeader(request, "host");
    if (requestHost === undefined || !authorities.has(requestHost)) {
      sendAttachedCliErrorBeforeBodyConsumption(
        request,
        response,
        403,
        "FORBIDDEN",
        "The request host is not allowed.",
      );
      return;
    }
    const rawTarget = request.url ?? "/";
    // Only the CLI mount is claimed here; every other target belongs to the
    // MCP router, which owns the OAuth callback and the not-found answer.
    if (
      rawTarget === apiPrefixes.cli ||
      rawTarget.startsWith(`${apiPrefixes.cli}/`)
    ) {
      await cliRouter.handle(request, response);
      return;
    }
    const method = request.method ?? "GET";
    if (method === "GET") {
      if (rawTarget === "/") {
        sendPage(response, chooserPage);
        return;
      }
      if (rawTarget === workbenchPaths.mcp) {
        mcpRouter.shell(response, apiPrefixes.mcp, true);
        return;
      }
      if (rawTarget === workbenchPaths.cli) {
        cliRouter.shell(response, apiPrefixes.cli, true);
        return;
      }
      if (rawTarget === "/assets/favicon.svg") {
        assets.favicon(response);
        return;
      }
      if (rawTarget.startsWith("/assets/")) {
        await assets.serve(
          response,
          rawTarget.slice("/assets/".length).split("/"),
        );
        return;
      }
    }
    await mcpRouter.handle(request, response);
  };

  const server: NodeHttpServer = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) {
        sendAttachedCliError(
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

  const boundPort = await listenOnLoopback(server, {
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.onPortInUse === undefined
      ? {}
      : { onPortInUse: options.onPortInUse }),
  });
  authorities = loopbackAuthorities(boundPort);
  ownOrigin = devtoolsOrigin(boundPort);
  oauthRedirectUrl = `${literalLoopbackOrigin(boundPort)}/oauth/callback`;

  let closing: Promise<void> | undefined;
  return {
    address: () => ({ host: devtoolsHost, port: boundPort }),
    path: (workbench) =>
      workbench === undefined ? "/" : workbenchPaths[workbench],
    close: async () => {
      closing ??= (async () => {
        if (closed) return;
        closed = true;
        mcpRouter.clearBrowserSessions();
        cliRouter.clearBrowserSessions();
        const stopServer = new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
          server.closeAllConnections();
        });
        const results = await Promise.allSettled([
          stopServer,
          mcpController.close(),
          cliController.close(),
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
