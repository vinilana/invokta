import type { Server as NodeHttpServer } from "node:http";
import { createServer } from "node:http";

import {
  createAttachedRouter,
  defaultAttachedUiRoot,
} from "./attached-router.js";
import { sendAttachedError } from "./attached-router.js";
import type {
  AttachedSessionController,
  AttachedSessionState,
} from "./attached-session.js";
import { createAttachedSessionController } from "./attached-session.js";
import {
  devtoolsHost,
  devtoolsOrigin,
  listenOnLoopback,
  literalLoopbackOrigin,
  loopbackAuthorities,
} from "./loopback.js";
import type { DevtoolsServerAddress } from "./server.js";

export type { AttachedConnectionSummary } from "./attached-session.js";
export type AttachedServerState = AttachedSessionState;
export type AttachedServerController = AttachedSessionController;

export interface StartAttachedDevtoolsServerOptions {
  readonly controller?: AttachedServerController;
  /** Defaults to 4100; a taken port walks to the next free one. */
  readonly port?: number;
  /** Directory holding the built interface bundle. Defaults to `dist/ui`. */
  readonly uiRoot?: string;
  /** Called with each taken port before the next one is tried. */
  readonly onPortInUse?: (port: number) => void;
}

export interface AttachedDevtoolsServer {
  address(): DevtoolsServerAddress;
  close(): Promise<void>;
}

/**
 * The single-workbench MCP server: one loopback origin serving the workbench
 * shell, its JSON API under `/api`, and the OAuth callback. The launcher
 * mounts the same router next to the CLI one instead.
 */
export async function startAttachedDevtoolsServer(
  options: StartAttachedDevtoolsServerOptions,
): Promise<AttachedDevtoolsServer> {
  const controller = options.controller ?? createAttachedSessionController();
  let authorities: ReadonlySet<string> = new Set();
  let ownOrigin = "";
  let oauthRedirectUrl = "";
  let closed = false;
  const router = createAttachedRouter({
    controller,
    uiRoot: options.uiRoot ?? defaultAttachedUiRoot(),
    allowedAuthorities: () => authorities,
    origin: () => ownOrigin,
    oauthRedirectUrl: () => oauthRedirectUrl,
  });

  const server: NodeHttpServer = createServer((request, response) => {
    void router.handle(request, response).catch(() => {
      if (!response.headersSent) {
        sendAttachedError(
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
    close: async () => {
      closing ??= (async () => {
        if (closed) return;
        closed = true;
        router.clearBrowserSessions();
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
