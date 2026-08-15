import type { Server as NodeHttpServer } from "node:http";
import { createServer } from "node:http";

import { defaultAttachedCliUiRoot } from "./cli-attached-assets.js";
import { sendAttachedCliError } from "./cli-attached-http.js";
import { createAttachedCliRouter } from "./cli-attached-router.js";
import {
  devtoolsHost,
  devtoolsOrigin,
  listenOnLoopback,
  loopbackAuthorities,
} from "./loopback.js";
import {
  type AttachedCliSessionController,
  type AttachedCliSessionState,
  createAttachedCliSessionController,
} from "./cli-attached-session.js";
import type { DevtoolsServerAddress } from "./server.js";

export type AttachedCliServerState = AttachedCliSessionState;
export type AttachedCliServerController = AttachedCliSessionController;

export interface StartAttachedCliDevtoolsServerOptions {
  readonly controller?: AttachedCliServerController;
  /** Defaults to 4100; a taken port walks to the next free one. */
  readonly port?: number;
  readonly uiRoot?: string;
  /** Called with each taken port before the next one is tried. */
  readonly onPortInUse?: (port: number) => void;
}

export interface AttachedCliDevtoolsServer {
  address(): DevtoolsServerAddress;
  close(): Promise<void>;
}

export async function startAttachedCliDevtoolsServer(
  options: StartAttachedCliDevtoolsServerOptions = {},
): Promise<AttachedCliDevtoolsServer> {
  const controller = options.controller ?? createAttachedCliSessionController();
  let authorities: ReadonlySet<string> = new Set();
  let ownOrigin = "";
  let closed = false;
  const router = createAttachedCliRouter({
    controller,
    uiRoot: options.uiRoot ?? defaultAttachedCliUiRoot(),
    allowedAuthorities: () => authorities,
    origin: () => ownOrigin,
  });

  const server: NodeHttpServer = createServer((request, response) => {
    void router.handle(request, response).catch(() => {
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
