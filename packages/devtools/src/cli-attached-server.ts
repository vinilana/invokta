import type { Server as NodeHttpServer } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { defaultAttachedCliUiRoot } from "./cli-attached-assets.js";
import { sendAttachedCliError } from "./cli-attached-http.js";
import { createAttachedCliRouter } from "./cli-attached-router.js";
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
  readonly port?: number;
  readonly uiRoot?: string;
}

export interface AttachedCliDevtoolsServer {
  address(): DevtoolsServerAddress;
  close(): Promise<void>;
}

const host = "127.0.0.1";
const defaultPort = 4100;

export async function startAttachedCliDevtoolsServer(
  options: StartAttachedCliDevtoolsServerOptions = {},
): Promise<AttachedCliDevtoolsServer> {
  const controller = options.controller ?? createAttachedCliSessionController();
  const port = options.port ?? defaultPort;
  let boundAuthority = "";
  let ownOrigin = "";
  let closed = false;
  const router = createAttachedCliRouter({
    controller,
    uiRoot: options.uiRoot ?? defaultAttachedCliUiRoot(),
    authority: () => boundAuthority,
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
